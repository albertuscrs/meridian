# PnL Poll Gap Fix — Implementation Handoff

**For:** MiMo / Claude Code / next implementation session
**Date prepared:** 2026-05-28
**Priority:** HIGH (data-validated catastrophic loss prevention)
**Status:** Spec complete, awaiting implementation

---

## 🎯 ONE-PARAGRAPH SUMMARY

PnL poll function in `state.js` (line 229-232) early-returns when current PnL ≤ peak.
This skips exit rule evaluation, causing Rule 0 (Emergency Close at -10%) to fire
ONLY when OOR transition happens via separate code path. Result: positions can
crash from peak +0.59% → realized -36% (Embrace 2026-05-20) without poll-side
intervention. Fix: add emergency floor check BEFORE peak gate, surgical addition.

---

## 📊 EVIDENCE

### Embrace/SOL Case (2026-05-20)

```
Timeline:
18:01:56  Deploy at peak +0.01%
19:07:18  Peak +0.59% (LAST LOG)
[25-MINUTE BLACKOUT — PnL trending down, peak gate blocks log + evaluation]
19:32:50  OOR transition → Rule 0 fires at -25.35%
19:33:07  Realized: -36.05% (after slippage)

Without fix: Position bled from 0.59% → -25.35% completely undetected.
With fix: Would trigger emergency close around -10%, expected realized ~-12% to -15%.
```

### Code Evidence (state.js line 229-241)

```javascript
const currentPeak = pos.peak_pnl_pct ?? 0;
if (candidatePnlPct <= currentPeak) return false;  // ← THE BUG: blocks exit eval

if (options.immediate) {
  pos.peak_pnl_pct = candidatePnlPct;
  pos.pending_peak_pnl_pct = null;
  pos.pending_peak_started_at = null;
  save(state);
  log("state", `Position ${position_address} peak PnL accepted at ${candidatePnlPct.toFixed(2)}% from relay poll`);
  return true;
}
```

### Comparison: Healthy Position (7Cuntu) vs Catastrophic (5GDk5cs)

**7Cuntu (PnL trending up — peak updates continuously):**
```
00:23:18  peak 0.23%
00:23:47  peak 0.27%   (29s gap, normal poll)
00:35:47  peak 0.28%
00:36:02  peak 0.37%
... continuous logs because PnL kept rising
```

**5GDk5cs (PnL crashed — peak gate blocks logs):**
```
19:07:18  peak 0.59% — LAST LOG
[25 min silence — PnL went 0.59% → -25% but peak gate blocked everything]
19:32:50  OOR transition fires Rule 0 separately
```

---

## ✅ DECISIONS LOCKED

- **Approach:** Path B — Add emergency check BEFORE peak gate (surgical addition)
- **NOT Path A:** Don't rewrite peak update logic (regression risk to trailing TP)
- **Threshold:** Reuse existing `config.management.emergencyClosePct` (-10% default)
- **Scope:** Both PnL poll path AND ensure consistency with existing OOR-triggered path
- **Logging:** Add diagnostic log throttled to once per 5 minutes per position

---

## 🚨 PRE-FLIGHT VERIFICATION (DO THIS FIRST)

Before implementing, verify these assumptions match codebase reality.
Last investigation already confirmed file paths and line numbers, but verify
function signatures haven't changed:

```bash
cd ~/projects/meridian

# 1. Verify the peak update function signature
grep -nB 2 -A 5 "candidatePnlPct.*currentPeak\|currentPeak.*candidatePnlPct" state.js

# 2. Verify PnL poll handler in index.js
grep -nB 3 -A 15 "Lightweight 30s PnL poller\|PnL poll.*Emergency" index.js | head -50

# 3. Verify management cycle separate path
grep -nB 2 -A 10 "Rule 0.*Emergency\|EMERGENCY_CLOSE" state.js | head -30

# 4. Verify emergencyClosePct usage in updatePnlAndCheckExits
grep -nB 2 -A 5 "emergencyClosePct" state.js

# 5. Confirm state.json schema (position fields)
python3 -c "
import json
with open('state.json') as f:
    s = json.load(f)
positions = s.get('positions', {})
if positions:
    first = list(positions.values())[0]
    print('Position fields:', sorted(first.keys()))
"

# 6. Check existing test infrastructure for state.js
ls -la test/ 2>/dev/null
grep -rn "updatePeakPnl\|updatePnlAndCheckExits" test/ 2>/dev/null | head -10
```

If anything looks different from spec assumptions, **ask user before
proceeding**. Spec was designed based on verified investigation but call graph
may have evolved.

---

## 📝 IMPLEMENTATION SPEC

### Strategy: 2 Files, ~30 Lines Total

We need to:
1. Add emergency floor check in PnL poll path (BEFORE peak gate)
2. Add throttled diagnostic logging for observability
3. Ensure call-site handles new emergency return value

### File 1: `state.js`

Find the function containing line 229-232 (`updatePeakPnl` or similar — the
function that has the `currentPeak` early-return pattern).

**ADD BEFORE the peak gate:**

```javascript
// ── Emergency Floor Check (added 2026-05-XX) ──
// Critical: this MUST come BEFORE the peak gate (currentPnl <= currentPeak)
// because PnL descending will skip the function early-return and miss
// Rule 0 evaluation entirely.
// Discovered via Embrace/SOL post-mortem 2026-05-20 (PnL Poll Gap).
const emergencyThreshold = config.management.emergencyClosePct;
if (candidatePnlPct != null
    && emergencyThreshold != null
    && candidatePnlPct <= emergencyThreshold) {
  log("state", `[PnL poll] Emergency floor breached: ${position_address} PnL ${candidatePnlPct.toFixed(2)}% <= ${emergencyThreshold}% — flagging for immediate close`);
  pos.emergency_close_flagged_at = new Date().toISOString();
  pos.emergency_close_pnl_pct = candidatePnlPct;
  save(state);
  // Return structured signal so call-site can trigger close
  return {
    emergency: true,
    action: "EMERGENCY_CLOSE",
    reason: `Emergency close (via poll): PnL ${candidatePnlPct.toFixed(2)}% <= ${emergencyThreshold}%`,
    profile: config.management.closeProfile,
  };
}

// ── Diagnostic Log (throttled 5 min per position) ──
// Provides forensic trail when PnL is descending below peak (no other logs)
const DIAG_LOG_INTERVAL_MS = 5 * 60 * 1000;
const lastDiag = pos.last_pnl_diag_log_at ? new Date(pos.last_pnl_diag_log_at).getTime() : 0;
if (candidatePnlPct != null && Date.now() - lastDiag > DIAG_LOG_INTERVAL_MS) {
  log("state", `[PnL poll diag] ${position_address} pnl=${candidatePnlPct.toFixed(2)}% peak=${(pos.peak_pnl_pct ?? 0).toFixed(2)}% in_range=${!pos.out_of_range_since} held=${Math.round((Date.now() - new Date(pos.deployed_at).getTime()) / 60000)}m`);
  pos.last_pnl_diag_log_at = new Date().toISOString();
  // Don't save yet — let next save batch this
}

// ── EXISTING: Peak gate (unchanged) ──
const currentPeak = pos.peak_pnl_pct ?? 0;
if (candidatePnlPct <= currentPeak) return false;
// ... rest of function preserved
```

**IMPORTANT:**
- The emergency check uses `candidatePnlPct` — same variable peak gate uses
- Returns object `{ emergency: true, ... }` instead of boolean false/true
- Call-site MUST handle this new return shape (see File 2)

### File 2: `index.js` PnL Poll Handler

Find the PnL poll handler around line 936-985 where it currently logs
`[PnL poll] Emergency close`. The existing handler already handles emergency
case — verify and ensure it also triggers when peak update function returns
`{ emergency: true }`.

Likely existing pattern (verify via grep before modifying):

```javascript
// Current pattern (approximate, verify exact code):
const exit = updatePnlAndCheckExits(p.position, p, mgmtConfig);
if (exit?.action === "EMERGENCY_CLOSE") {
  log("state", `[PnL poll] Emergency close: ${p.pair} — ${exit.reason}`);
  // trigger immediate close...
}
```

**Modification needed:** Ensure peak update function call also checks for emergency:

```javascript
// Around line 936-985 PnL poll handler
for (const p of positions) {
  // EXISTING: call updatePnlAndCheckExits (this handles full rule evaluation)
  const exit = updatePnlAndCheckExits(p.position, p, mgmtConfig);

  // NEW: also handle emergency from peak update path
  const peakResult = updatePeakPnl(p.position, p.current_pnl_pct, { immediate: true });
  if (peakResult?.emergency) {
    log("state", `[PnL poll] Emergency close: ${p.pair} — ${peakResult.reason}`);
    // Trigger same close path as existing emergency handler
    // (copy pattern from existing EMERGENCY_CLOSE branch around line 957)
  }

  // ... existing logic continues
}
```

**OR (cleaner):** If `updatePnlAndCheckExits` already handles emergency, just
ensure the **peak update function** is called BEFORE it checks Rule 0, so peak
gate doesn't short-circuit.

**Implementer decides** based on actual call graph after verification commands.

### File 3 (Optional): `config.js`

If `emergencyClosePct` reference in state.js doesn't already work via `config.management.X`,
might need adjusting import. Verify:

```bash
grep -n "import.*config\|config.management" state.js | head -5
```

Probably no change needed.

---

## 🧪 TEST CASES

Run inline-predicate tests after implementation:

```javascript
// Test 1: PnL descending, emergency NOT breached → original peak gate behavior
// Setup:
//   pos = { peak_pnl_pct: 0.5, emergency_close_flagged_at: null }
//   candidatePnlPct = -5
//   emergencyClosePct = -10
// Expected: returns false (peak gate engages, no emergency)
// CRITICAL: must not false-positive

// Test 2: PnL descending, emergency BREACHED → triggers emergency
// Setup:
//   pos = { peak_pnl_pct: 0.5 }
//   candidatePnlPct = -12
//   emergencyClosePct = -10
// Expected: returns { emergency: true, action: "EMERGENCY_CLOSE", reason: "..." }
// Verify: pos.emergency_close_flagged_at set, pos.emergency_close_pnl_pct = -12
// CRITICAL: this is the Embrace fix case

// Test 3: PnL ascending past peak, emergency irrelevant → normal peak update
// Setup:
//   pos = { peak_pnl_pct: 0.5 }
//   candidatePnlPct = 1.2
//   emergencyClosePct = -10
// Expected: returns true, peak_pnl_pct = 1.2, log "peak PnL accepted"
// Verify: emergency block skipped

// Test 4: emergencyClosePct disabled (null)
// Setup:
//   pos = { peak_pnl_pct: 0.5 }
//   candidatePnlPct = -15
//   emergencyClosePct = null
// Expected: emergency block SKIPPED, falls through to peak gate (returns false)
// CRITICAL: no regression for users with emergency disabled

// Test 5: candidatePnlPct = null (stale data)
// Setup:
//   pos = { peak_pnl_pct: 0.5 }
//   candidatePnlPct = null
//   emergencyClosePct = -10
// Expected: emergency block skipped (null guard), peak gate logic determines return

// Test 6: Diagnostic log throttling
// Setup:
//   pos.last_pnl_diag_log_at = ISO string 4 minutes ago
//   candidatePnlPct = -3
// Expected: NO diagnostic log (within 5 min throttle window)
//
// Setup 2:
//   pos.last_pnl_diag_log_at = ISO string 6 minutes ago
// Expected: Diagnostic log fires, pos.last_pnl_diag_log_at updated
```

Adapt to actual test framework if exists at `test/state.test.js`.

---

## 📦 DEPLOYMENT SEQUENCE

User preference: **Wait for existing positions to close before bot restart.**

### Step 1: Implement code (no restart yet)

1. Apply spec to state.js (~25 lines)
2. Verify/modify index.js PnL poll handler (~5 lines or no change)
3. Run inline tests (Test 1-6)
4. Syntax check: `node --check state.js && node --check index.js`

### Step 2: Commit

```bash
git add state.js index.js docs/HANDOVER.md
git commit -m "fix: PnL poll gap — emergency floor evaluated before peak gate

Discovered via Embrace/SOL post-mortem (2026-05-20). The peak update
function in state.js (line 229-232) early-returns when current PnL ≤ peak,
which skipped Rule 0 (Emergency Close) evaluation when PnL was descending.

Result: positions could bleed from peak +0.59% to realized -36% without
poll-side intervention. Rule 0 only fired when OOR transition triggered
a separate code path.

Fix: Add emergency floor check BEFORE peak gate. Surgical addition that
preserves existing trailing TP behavior. Returns structured { emergency: true }
signal handled by PnL poll call-site.

Also adds throttled diagnostic log (5 min per position) for forensic trail.

Test cases: 6 inline-predicate tests pass.
Restart deferred until existing positions drain."

git push origin experimental
```

### Step 3: Wait for position drain

Monitor `/observe` until 0 open positions.

### Step 4: Backup state, restart

```bash
cd ~/projects/meridian
cp state.json state.json.backup-pre-pnl-gap-fix-$(date +%Y%m%d-%H%M%S)
screen -X -S meridian quit
sleep 5
screen -S meridian -dm npm start
sleep 5
tail -50 logs/agent-$(date +%Y-%m-%d).log
```

### Step 5: Verify (first 30 min)

- Bot starts without errors
- New "[PnL poll diag]" lines appear in logs (every 5 min per position)
- No spurious emergency triggers

### Step 6: Continued monitoring

After 24 hours of new closes, run:
```bash
# Check if any emergency triggers fired via the new path
grep "Emergency floor breached" logs/agent-*.log

# Verify no regression in trailing TP behavior
grep "Trailing TP" logs/agent-$(date +%Y-%m-%d).log | head -10

# Check diagnostic logs are useful (not noise)
grep "PnL poll diag" logs/agent-$(date +%Y-%m-%d).log | head -10
```

---

## ⚠️ EMERGENCY ROLLBACK

```bash
# Option 1: Disable emergency check via config
{ "emergencyClosePct": null }   # Effectively disables the new block too (null guard)

# Option 2: Code revert
git revert HEAD
# Then restart bot when positions drain
```

---

## 🔗 CONTEXT FOR IMPLEMENTER

- Previous session (Claude) did Embrace post-mortem investigation
- User confirmed pattern via log analysis
- All R-implementations (R3, R4.1, R5, R7, R8, R10) are personal work, working
- Existing Rule 0 Emergency Close (implemented 2026-05-18) handles management cycle path correctly
- This fix addresses PnL poll path which has separate code from management cycle
- User prefers data-driven decisions, asks before guessing

---

## ❓ CLARIFYING QUESTIONS (ASK BEFORE GUESSING)

1. Is `updatePeakPnl` the right function? Verify line 229-241 of state.js shows
   the peak gate pattern. If function name differs, ask before assuming.

2. Does `updatePnlAndCheckExits` (the function called from PnL poll handler in
   index.js line 936+) ALREADY handle Rule 0 internally? If yes, this might be
   the simpler place to add the fix instead of `updatePeakPnl`.

3. Is there a unified PnL poll function or split across multiple? Embrace logs
   show "peak PnL accepted" coming from line 239, but "Emergency close" coming
   from index.js line 957. Verify call graph.

4. If existing `updatePnlAndCheckExits` already evaluates Rule 0, why didn't it
   fire during the 25-min Embrace gap? Maybe it's only called from management
   cycle, not PnL poll? Verify by tracing calls.

---

## ✅ SUCCESS CRITERIA

1. All 6 test cases pass
2. Syntax check clean on modified files
3. Git commit + push to fork
4. Bot restarts cleanly post-fix
5. First 24h shows:
   - Diagnostic logs every 5 min per position (forensic trail working)
   - No spurious emergency triggers
   - Existing close patterns (Rule 3, Trailing TP, Low Yield) still work
6. Future positions that experience Embrace-pattern crash (PnL bleeding while
   in-range) trigger emergency at ~-10% instead of waiting for OOR transition

---

End of handoff. Address with surgical care — peak update path is core hot-path
for trailing TP behavior. Don't rewrite, only ADD before the gate.
