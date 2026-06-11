# R7 Floor + Min-PnL Instrumentation — Implementation Handoff

**For:** MiMo / next AI session
**From:** Previous Claude session (analysis-based design)
**Date prepared:** 2026-05-23
**Status:** Spec complete, awaiting implementation

---

## 🎯 GOAL

Add hard floor to R7 Safety-Lock logic to prevent catastrophic R7 holds, and add
`min_pnl_pct` instrumentation to track worst PnL during position lifecycle for
future tuning decisions.

---

## 📊 EVIDENCE-BASED RATIONALE

User's actual data from `bengbeng-explainer-Ckn5_VCru-20260523.json` (522 closed
positions, 1 month, wallet Ckn5Q…VCru):

| Metric | Value |
|--------|-------|
| Total positions | 522 |
| Total capital deployed (USD) | $11,812.33 |
| Total fees earned (USD) | $154.55 |
| Net PnL (USD) | +$9.62 |
| ROI (1 month) | +0.08% |
| Win rate | 72.4% |
| Big losses (>10%) | 7 positions |
| Big loss total damage | -$35.26 |

**Key finding:** 7 big losses ate 78% of all profits. All 7 were single-down
shape positions held 30-91 minutes — R7 Safety-Lock held them past recovery point.

**Simulation result:** Capping loss at -10% would save $17.98/month, improving
net PnL from +$9.62 to +$27.60 (+186% improvement). Zero false positive risk at
-10% (no position recovered from below -10% in dataset).

---

## ✅ DECISIONS LOCKED

- **Floor threshold:** -10% (initial)
- **Action type:** `R7_FLOOR` (distinct from `STOP_LOSS`, for cooldown differentiation)
- **Cooldown:** 4 hours (configurable via `r7FloorCooldownHours`)
- **Instrumentation:** Approach 1 — track `min_pnl_pct` in state schema
- **Profile scope:** ALL profiles (main, pecut, experimental) — defensive
- **Bot restart strategy:** Wait for all existing positions to close before restart

---

## 🚨 PRE-FLIGHT VERIFICATION (DO THIS FIRST)

Before implementing, **VERIFY** these assumptions hold in the actual codebase.
Spec was designed without browsing repo. Adjust implementation if structure differs.

### Verification Commands

```bash
cd ~/projects/meridian

# 1. Verify state.js exports and structure
grep -n "export function\|function trackPosition\|function updatePnlAndCheckExits\|function load\|function save" state.js | head -20

# 2. Verify config.js management section structure
grep -n "management:" config.js
grep -n -A 30 "management: {" config.js | head -40

# 3. Verify CONFIG_MAP in executor.js
grep -n "CONFIG_MAP\|update_config" tools/executor.js | head -20

# 4. Verify recordPerformance signature in lessons.js
grep -n "recordPerformance\|export function recordPerformance" lessons.js

# 5. Verify pool-cooldown reason mapping
grep -n "CLOSE_REASON\|stop_loss\|low yield\|OUT_OF_RANGE\|cooldownHoursMap" pool-cooldown.js | head -20

# 6. Verify actions JSONL append pattern
grep -n "appendAction\|actions-.*jsonl" index.js | head -10

# 7. Check state.json schema (current positions structure)
python3 -c "
import json
with open('state.json') as f:
    s = json.load(f)
positions = s.get('positions', {})
if positions:
    first = list(positions.values())[0]
    print('Position fields:', list(first.keys()))
    print('Has min_pnl_pct?', 'min_pnl_pct' in first)
else:
    print('No active positions')
"

# 8. Verify log function and signature
grep -n "export function log\|function log\|import.*log" logger.js state.js | head -10
```

### Expected vs Actual: Note Discrepancies

If anything differs from spec assumptions below, **flag to user before
implementing**. Common discrepancies:
- `recordPerformance()` might take different field names
- `CONFIG_MAP` might use different validator structure
- Position state might use camelCase vs snake_case
- Log function might require different argument order

---

## 📝 IMPLEMENTATION SPEC

### File 1: `state.js`

#### Change 1.1: Add `min_pnl_pct` to position schema

Find `trackPosition()` function (or wherever new position objects are created).
Add to the new-position-object literal:

```javascript
const position = {
  // ... existing fields preserved
  min_pnl_pct: null,    // NEW: tracks worst PnL seen during lifecycle
  // ... rest preserved
};
```

#### Change 1.2: Migration for existing positions

In the `load()` function (or wherever state.json is parsed), add migration:

```javascript
// AFTER parsing state.json into `state` variable, BEFORE returning:

// Migration: ensure all positions have min_pnl_pct field
let migrated = false;
for (const addr in (state.positions || {})) {
  const pos = state.positions[addr];
  if (pos.min_pnl_pct === undefined) {
    pos.min_pnl_pct = pos.current_pnl_pct ?? null;
    migrated = true;
  }
}
if (migrated) {
  log("state", "Migrated existing positions to include min_pnl_pct field");
  // Note: save will happen at next normal save cycle
}
```

#### Change 1.3: Update `min_pnl_pct` in `updatePnlAndCheckExits()`

At the **VERY START** of `updatePnlAndCheckExits()`, after loading state and
getting position, BEFORE any rule check:

```javascript
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  const currentPnlPct = positionData.current_pnl_pct;

  // ── Update min_pnl_pct tracking ──
  if (currentPnlPct != null) {
    if (pos.min_pnl_pct == null || currentPnlPct < pos.min_pnl_pct) {
      pos.min_pnl_pct = currentPnlPct;
      save(state);
    }
  }

  // ── R7 Floor — Hard cap to prevent catastrophic R7 holds ──
  const r7Floor = mgmtConfig.r7FloorPnlPct ?? -10;
  if (currentPnlPct != null && currentPnlPct <= r7Floor) {
    log("state", `R7-Floor: ${position_address} PnL ${currentPnlPct.toFixed(2)}% breached ${r7Floor}% floor (min_seen: ${pos.min_pnl_pct?.toFixed(2) ?? "?"}%) — close immediately`);
    return {
      action: "R7_FLOOR",
      reason: `R7 floor breached at ${currentPnlPct.toFixed(2)}% (limit: ${r7Floor}%)`,
      profile: mgmtConfig.closeProfile,
    };
  }

  // ... existing Rule 1-5 logic preserved below
}
```

**IMPORTANT:** Existing function signature, return shape, and rest of logic stays
intact. R7 Floor block goes BEFORE Rule 1 (Stop Loss) — it's a higher priority
safety net.

---

### File 2: `config.js`

In the `management:` config section, add:

```javascript
management: {
  // ... existing fields preserved

  // R7 Floor (added 2026-05-XX based on bengbeng analysis)
  r7FloorPnlPct:        u.r7FloorPnlPct        ?? -10,
  r7FloorCooldownHours: u.r7FloorCooldownHours ?? 4,

  // ... rest preserved
}
```

---

### File 3: `tools/executor.js`

In the `CONFIG_MAP` object, add:

```javascript
const CONFIG_MAP = {
  // ... existing entries preserved

  r7FloorPnlPct: {
    section: "management",
    type: "number",
    validator: (v) => typeof v === "number" && v <= 0 && v >= -50,
    description: "PnL % threshold for R7 hard floor (close regardless of profile)",
  },
  r7FloorCooldownHours: {
    section: "management",
    type: "number",
    validator: (v) => typeof v === "number" && v >= 0 && v <= 24,
    description: "Cooldown hours after R7 floor triggered close",
  },
};
```

Also update `tools/definitions.js` `update_config` tool description if it lists
allowed keys. Add `r7FloorPnlPct` and `r7FloorCooldownHours` to the documented
allowed keys.

---

### File 4: `pool-cooldown.js`

Find the cooldown reason mapping (likely an object or switch statement). Add:

```javascript
// In cooldownHoursMap or equivalent:
const cooldownHoursMap = {
  // ... existing reasons preserved
  "R7_FLOOR": config.management.r7FloorCooldownHours ?? 4,
};

// If there are CLOSE_REASON constants exported:
export const CLOSE_REASON_R7_FLOOR = "R7_FLOOR";
```

In `evaluateAndSetCooldown()`, ensure the `R7_FLOOR` action triggers the cooldown
same as other close reasons. The function should already handle action strings
generically.

---

### File 5: `index.js`

#### Change 5.1: Pass `min_pnl_pct` to `recordPerformance()` on close

Find where close action is processed (likely in management cycle after
`updatePnlAndCheckExits` returns a close action, OR in executor.js
`close_position` tool execution). Where `recordPerformance()` is called:

```javascript
await recordPerformance({
  // ... existing fields preserved
  min_pnl_pct: position.min_pnl_pct ?? null,  // NEW
  close_reason: closeReason,
});
```

#### Change 5.2: Add `min_pnl_pct` to actions JSONL

Find `appendAction()` calls related to close events:

```javascript
appendAction({
  type: "close",
  position: position_address,
  pnl_pct: finalPnlPct,
  min_pnl_pct: position.min_pnl_pct ?? null,  // NEW
  // ... rest preserved
});
```

#### Change 5.3: R7-Floor counter in `/observe`

In `parseLogDates()` function:

```javascript
// Add counter initialization:
let errorCount = 0, safetyLockCount = 0, pumpHoldCount = 0, r8HoldCount = 0;
let r7FloorCount = 0;  // NEW

// In the line-by-line loop, add:
if (/R7-Floor:/.test(line)) r7FloorCount++;

// In return:
return {
  closedPositions, exitAlerts, errorCount,
  safetyLockCount, pumpHoldCount, r8HoldCount,
  r7FloorCount,  // NEW
};
```

In `buildObserveReport()`:

```javascript
// In the destructuring:
const { ..., r7FloorCount } = await parseLogDates(dates);

// In the display lines (near other holds/closes):
`  R7-Floor closes:   ${r7FloorCount}`,
```

In `buildObserveCompare()` (if r8HoldCount is shown, add r7FloorCount):

```javascript
row("R7-Floor closes", null, cur.r7FloorCount),
```

In `buildObserveReasons()` if it has a "closes by reason" section:

```javascript
if (r7FloorCount > 0) {
  lines.push(`<code>${"R7-Floor".padEnd(18)} ${bar(r7FloorCount).padEnd(BAR_MAX + 1)}${r7FloorCount}</code>`);
}
```

---

### File 6: `lessons.js`

Update `recordPerformance()` schema documentation to include `min_pnl_pct`:

```javascript
/**
 * @param {Object} perf
 * @param {number} perf.pnl_pct - Exit PnL %
 * @param {number} perf.min_pnl_pct - Lowest PnL % seen during lifecycle (NEW)
 * @param {string} perf.close_reason - Reason for close
 * ... rest preserved
 */
export async function recordPerformance(perf) {
  // In the entry object:
  const entry = {
    // ... existing fields preserved
    min_pnl_pct: perf.min_pnl_pct ?? null,  // NEW
    // ... rest preserved
  };
  // ... rest of function preserved
}
```

---

### File 7: NEW FILE `scripts/analyze-min-pnl.js`

Create this analysis tool. Standalone script, no integration with main bot.

```javascript
#!/usr/bin/env node
// Usage: node scripts/analyze-min-pnl.js [actions-YYYY-MM-DD.jsonl ...]
// Default: scans all logs/actions-*.jsonl files
// Output: Distribution of min_pnl_pct vs final pnl_pct, recovery patterns

import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const logsDir = path.join(projectRoot, "logs");

async function loadCloses(files) {
  const closes = [];
  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.warn(`File not found: ${file}`);
      continue;
    }
    const stream = fs.createReadStream(file);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "close" && entry.min_pnl_pct != null && entry.pnl_pct != null) {
          closes.push(entry);
        }
      } catch {}
    }
  }
  return closes;
}

function analyze(closes) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`MIN-PNL ANALYSIS — ${closes.length} closes with min_pnl_pct data`);
  console.log('='.repeat(70));

  if (closes.length === 0) {
    console.log("\nNo data yet. Run after some closes have been recorded.");
    return;
  }

  // Bucket analysis: positions that dipped to threshold then recovered
  const thresholds = [-3, -5, -7, -10, -15, -20];
  console.log(`\n${'Threshold':<12} ${'Touched':<10} ${'Recovered':<12} ${'Recovery %':<12} ${'Stayed Down':<12}`);
  console.log('-'.repeat(60));
  for (const threshold of thresholds) {
    const touched = closes.filter(c => c.min_pnl_pct <= threshold);
    const recovered = touched.filter(c => c.pnl_pct > 0);
    const stayedDown = touched.filter(c => c.pnl_pct <= 0);
    const recoveryRate = touched.length > 0 ? (recovered.length / touched.length * 100).toFixed(1) : "0.0";
    console.log(`${threshold}%${' '.repeat(8)}${touched.length.toString().padEnd(10)}${recovered.length.toString().padEnd(12)}${recoveryRate}%${' '.repeat(8)}${stayedDown.length}`);
  }

  // Position-level detail for those that dipped below -5%
  const dipped = closes.filter(c => c.min_pnl_pct <= -5).sort((a,b) => a.min_pnl_pct - b.min_pnl_pct);
  console.log(`\n${'='.repeat(70)}`);
  console.log(`POSITIONS THAT DIPPED ≤ -5% (${dipped.length} positions)`);
  console.log('='.repeat(70));
  console.log(`${'Position':<14} ${'Min PnL':<10} ${'Final PnL':<12} ${'Outcome':<15}`);
  console.log('-'.repeat(55));
  for (const c of dipped.slice(0, 30)) {
    const addr = (c.position || "?").slice(0, 8) + "…";
    const outcome = c.pnl_pct > 0 ? "✅ Recovered" : c.pnl_pct >= -3 ? "⚪ Near BE" : "❌ Stayed loss";
    console.log(`${addr.padEnd(14)}${c.min_pnl_pct.toFixed(2).padEnd(10)}${c.pnl_pct.toFixed(2).padEnd(12)}${outcome}`);
  }
  if (dipped.length > 30) {
    console.log(`  … and ${dipped.length - 30} more`);
  }

  // Decision recommendation
  console.log(`\n${'='.repeat(70)}`);
  console.log(`DECISION RECOMMENDATION`);
  console.log('='.repeat(70));

  const dippedMinus5 = closes.filter(c => c.min_pnl_pct <= -5);
  const recoveredFromMinus5 = dippedMinus5.filter(c => c.pnl_pct > 0);
  const recoveryRateMinus5 = dippedMinus5.length > 0 ? (recoveredFromMinus5.length / dippedMinus5.length * 100) : 0;

  console.log(`\nPositions dipped to -5%: ${dippedMinus5.length}`);
  console.log(`  Of these, recovered to profit: ${recoveredFromMinus5.length} (${recoveryRateMinus5.toFixed(1)}%)`);

  if (recoveryRateMinus5 < 10) {
    console.log(`\n💡 Recommendation: Tighten R7 floor to -5% (recovery rate < 10%)`);
  } else if (recoveryRateMinus5 < 25) {
    console.log(`\n💡 Recommendation: Keep R7 floor at -10%, observe longer (recovery rate 10-25%)`);
  } else if (recoveryRateMinus5 < 50) {
    console.log(`\n💡 Recommendation: Consider relaxing to -12% or -15% (recovery rate 25-50%)`);
  } else {
    console.log(`\n💡 Recommendation: R7 hold thesis strong (recovery rate >50%), maybe -15% floor sufficient`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  let files;
  if (args.length > 0) {
    files = args;
  } else {
    files = fs.readdirSync(logsDir)
      .filter(f => f.startsWith("actions-") && f.endsWith(".jsonl"))
      .sort()
      .map(f => path.join(logsDir, f));
  }
  console.log(`Scanning ${files.length} log files...`);
  const closes = await loadCloses(files);
  analyze(closes);
}

main().catch(console.error);
```

Make executable:
```bash
chmod +x scripts/analyze-min-pnl.js
```

Run via:
```bash
node scripts/analyze-min-pnl.js
```

---

## 🧪 TESTING REQUIREMENTS

After implementation, run these inline-predicate tests by simulating the
function calls. MiMo: please write a small test harness file and run it.

```javascript
// Pseudo-test cases (adapt to actual test framework if exists):

// Test 1: R7 Floor not breached, normal flow
// Setup: pnl_pct = -5%, floor = -10%
// Expected: function returns null (no close action)

// Test 2: R7 Floor breached
// Setup: pnl_pct = -12%, floor = -10%
// Expected: returns { action: "R7_FLOOR", reason: contains "-12.00%" and "-10%" }

// Test 3: Edge case at exact floor
// Setup: pnl_pct = -10%, floor = -10%
// Expected: returns R7_FLOOR (uses <=)

// Test 4: PnL null, skip floor evaluation
// Setup: pnl_pct = null
// Expected: floor block skipped, falls through to existing Rule 1+

// Test 5: min_pnl_pct tracking — initial
// Setup: position created, min_pnl_pct = null
// First update: pnl_pct = 2%
// Expected: min_pnl_pct updated to 2 (even positive values tracked)

// Test 6: min_pnl_pct tracking — preserves minimum
// Setup: pos.min_pnl_pct = -5
// Update: pnl_pct = -3
// Expected: pos.min_pnl_pct stays at -5 (not overwritten by higher value)

// Test 7: min_pnl_pct tracking — updates lower
// Setup: pos.min_pnl_pct = -3
// Update: pnl_pct = -7
// Expected: pos.min_pnl_pct updated to -7

// Test 8: Migration of existing positions
// Setup: state.json with positions missing min_pnl_pct field
// Action: load()
// Expected: positions get min_pnl_pct field (null or current_pnl_pct fallback)

// Test 9: Floor applies regardless of profile
// Setup: profile = "main", pnl_pct = -15%, floor = -10%
// Expected: still returns R7_FLOOR (floor is profile-agnostic)
```

---

## 📦 DEPLOYMENT SEQUENCE

User's preference: **Wait for existing positions to close before bot restart.**

### Step 1: Implement Code (no restart yet)

1. Apply all file changes above
2. Run pre-flight verification commands
3. Run inline tests (Test 1-9)
4. Syntax check: `node --check state.js && node --check index.js && node --check config.js && node --check tools/executor.js && node --check pool-cooldown.js && node --check lessons.js`
5. Commit to git with detailed message (see below)

### Step 2: Wait for Position Drain

Monitor via Telegram `/observe` or `/positions`. When all positions closed
(0 open), proceed to Step 3.

**Typical wait:** 1-6 hours depending on market and position lifecycle.

### Step 3: Backup State Before Restart

```bash
cd ~/projects/meridian
cp state.json state.json.backup-pre-r7floor-$(date +%Y%m%d-%H%M%S)
ls -la state.json.backup-pre-r7floor-*
```

### Step 4: Restart Bot

```bash
# Identify current screen session
screen -list

# Kill and restart
screen -X -S meridian quit
sleep 5
cd ~/projects/meridian
screen -S meridian -dm npm start

# Verify started
sleep 5
tail -30 logs/agent-$(date +%Y-%m-%d).log
```

### Step 5: Verify Startup

Expected log markers (within first 30 seconds):
- No SyntaxError, no module load errors
- Migration log: "Migrated existing positions to include min_pnl_pct field"
  (only if there were leftover positions in state.json that weren't fully cleared)
- Normal cron cycle messages

If errors: emergency rollback (see below).

---

## ⚠️ EMERGENCY ROLLBACK

```bash
# Option 1: Disable via config (preferred, no code revert needed)
# Edit user-config.json or via Telegram /setcfg:
{
  "r7FloorPnlPct": -100,
  "r7FloorCooldownHours": 0
}
# Effective floor at -100% means no realistic PnL will trigger it

# Option 2: Code revert (if migration broke something)
git revert HEAD
cp state.json.backup-pre-r7floor-* state.json
screen -X -S meridian quit
screen -S meridian -dm npm start
```

---

## 📝 SUGGESTED COMMIT MESSAGE

```
feat: R7 Floor + min_pnl_pct instrumentation

Adds hard floor to R7 Safety-Lock logic to prevent catastrophic
holds. Closes position immediately when PnL drops below threshold
(default -10%), regardless of profile.

Adds min_pnl_pct tracking to position state for future R7 tuning
decisions. Tracks worst PnL seen during lifecycle, persisted in
state.json and recorded in performance/actions JSONL.

Rationale (from bengbeng explainer 2026-04-23→2026-05-23, 522 pos):
- 7 big losses (-10% to -36%) cost $35.26, ate 78% of profits
- All were R7-held positions that never recovered
- Simulation: -10% floor would save ~$18/month, no false positives

Changes:
- state.js: R7 Floor in Rule 4 (priority before all checks)
- state.js: min_pnl_pct tracking + migration for existing positions
- config.js: r7FloorPnlPct, r7FloorCooldownHours
- tools/executor.js: CONFIG_MAP entries
- tools/definitions.js: update_config allowed keys
- pool-cooldown.js: R7_FLOOR action mapped to r7FloorCooldownHours
- lessons.js: min_pnl_pct in performance records
- index.js: min_pnl_pct in actions JSONL + /observe r7FloorCount
- scripts/analyze-min-pnl.js: NEW post-hoc analysis tool

Tests:
- 9 inline-predicate tests covering floor logic + min_pnl tracking
- All syntax checks pass

Deploy strategy:
- Code committed without restart
- Bot restart deferred until existing positions close
- Backup state.json before restart
- Monitor /observe for r7FloorCount baseline
```

---

## 🎯 POST-DEPLOY MONITORING

### Days 1-3 (Baseline Collection)

```bash
# Daily check
node scripts/analyze-min-pnl.js
```

Via Telegram:
```
/observe
```

Watch:
- `R7-Floor closes: N` (expected 0-1/day, max 3/day before flag as anomaly)
- New positions getting min_pnl_pct properly tracked
- No NaN, no null missing errors in logs

### Week 2 (Phase 2 Decision)

After 14 days of clean data:

```bash
node scripts/analyze-min-pnl.js
```

Decision matrix based on script output:
- Recovery rate from -5% < 10% → tighten floor to -5%
- Recovery rate 10-25% → keep -10%, observe longer
- Recovery rate 25-50% → consider relaxing to -12% or -15%
- Recovery rate >50% → R7 thesis strong, floor barely active

User can apply via `/setcfg r7FloorPnlPct VALUE` or edit user-config.json.

---

## 🔗 CONTEXT POINTERS FOR MIMO

If you need more context:

- `docs/HANDOVER.md` — full project state and roadmap
- `docs/CLOSE_RULES_REFACTOR.md` — R1-R10 specification and decisions
- `bengbeng-explainer-Ckn5_VCru-20260523.json` — source data for design
- Previous Claude session designed this — decisions are evidence-based
- User prefers data-driven decisions, step-by-step verification
- User uses Indonesian language sometimes but technical terms in English
- Bot currently runs on profile=pecut, mimo-v2.5 screening, MiniMax-M2.5 management

---

## ❓ QUESTIONS FOR USER (IF UNSURE)

If during implementation you encounter ambiguity, ask user before guessing:

1. If `state.json` schema differs significantly from assumptions, ask before
   applying migration logic
2. If `CONFIG_MAP` validator pattern differs, ask for example of existing entry
3. If `appendAction` JSONL format isn't found, ask where close actions are logged
4. If `recordPerformance` field naming differs, ask for current signature
5. If there's an existing R7-related action name (e.g., "STOP_LOSS_R7"), ask
   whether R7_FLOOR is acceptable as new distinct action

Better to ask than to guess and break something.

---

## ✅ SUCCESS CRITERIA

Implementation successful when:
1. [ ] All 7 file changes applied
2. [ ] New script `scripts/analyze-min-pnl.js` created and executable
3. [ ] Pre-flight verification commands match spec assumptions
4. [ ] All 9 inline tests pass
5. [ ] Syntax check passes on all modified .js files
6. [ ] Git commit created with detailed message
7. [ ] HANDOVER.md updated (use existing `update-handover.sh` script)
8. [ ] User notified — ready for restart when positions drain
9. [ ] (After restart) /observe shows `R7-Floor closes: 0` baseline
10. [ ] (After 2+ closes) `node scripts/analyze-min-pnl.js` runs without error

---

End of handoff brief. Good luck. 🎯
