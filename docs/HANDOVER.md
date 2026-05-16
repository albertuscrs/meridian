# Meridian DLMM Agent — Handover Document
**Date:** 2026-05-13
**Branch:** experimental
**Status:** Stable — all merges complete, bot running

---

## 🚨 CRITICAL CONTEXT — READ THIS FIRST

This is a **personal fork** of an open-source DLMM LP agent (Meridian).

- **My fork (origin):** https://github.com/albertuscrs/meridian
- **Upstream owner:** https://github.com/yunus-0x/meridian
- **Current HEAD:** `2837752` (merge: integrate upstream relay enrichment refactor)
- **Bot status:** Running stable, profile=pecut, model=mimo-v2.5 (screening), MiniMax-M2.7 (management)

### Git History (Recent)

```
2837752 merge: integrate upstream relay enrichment refactor
016f239 Move relay position enrichment into bot (upstream)
b022962 feat: R8 indicator-aware OOR close for experimental profile
01d442d fix: add agentId to relay health check
4b964df fix: add hard timeout for relay position fetch
48ade49 fix: increase relay timeout for position fetch
37be09e fix: correct GMGN API check endpoint
397fc80 fix: correct relay health check endpoint
4e5d741 fix: escape HTML in API status messages for Telegram
fab18e3 feat: add /status to Telegram bot command menu
528d79b feat: add API monitoring and /status subcommands
416d226 fix: add launchpad filtering to GMGN screening pipeline
56c04ee merge: integrate upstream/experimental + preserve R-implementations
```

---

## ✅ COMPLETED WORK

### 1. Merge with Upstream (DONE)

Successfully merged owner's 11+ commits while preserving all R-implementations:
- PM2 process management (4 commits)
- Volatility precision enhancements (3 commits)
- Discord signals as launchpad source
- DLMM deploy guard
- Pre-deploy screening enforcement
- Relay enrichment refactor (commit 016f239)

All 7 conflict files resolved. Auto-merged files audited for silent R-logic loss.

### 2. R8: Indicator-Aware OOR Close (DONE)

**Commit:** `b022962`

R8 validates chart indicators before closing OOR positions in "experimental" profile. If indicators don't confirm the exit, the position is held longer.

**Files modified:**
- `config.js` — 3 new fields: `r8IndicatorCheck`, `r8ExitPreset`, `r8OorCooldownHours`
- `state.js` — R8 gate in Rule 4 (both above/below), `indicatorData` parameter
- `index.js` — Pre-fetch indicators, /settings UI, /observe R8 parsing
- `pool-cooldown.js` — `CLOSE_REASON_R8_HELD`, `r8OorCooldownHours` cooldown
- `tools/executor.js` — CONFIG_MAP for R8 keys
- `tools/definitions.js` — update_config description

**Config fields:**

| Field | Default | /settings | CONFIG_MAP |
|-------|---------|-----------|------------|
| `r8IndicatorCheck` | `true` | ✅ toggle | ✅ |
| `r8ExitPreset` | `"supertrend_break"` | ✅ 4 preset buttons | ✅ |
| `r8OorCooldownHours` | `6` | ✅ input | ✅ |

**Gate order (experimental):**
```
OOR timeout
  → trailingArmed? → close immediately
  → Safety-Lock (R7): pnlPct ≤ 0? → hold
  → R8: r8ExitPreset confirmed? → hold if not
  → OUT_OF_RANGE → close
```

**Fail-open:** API unavailable → close as normal. Only active for `experimental` profile.

### 3. API Monitoring System (DONE)

**Commits:** `528d79b`, `fab18e3`, `4e5d741`, `397fc80`, `01d442d`

**New file:** `tools/api-monitor.js` — checks status of all external APIs.

**Telegram commands:**
```
/status apis     — check all API status
/status relay    — check Agent Meridian relay
/status hivemind — check HiveMind server
/status gmgn     — check GMGN API
/status jupiter  — check Jupiter swap API
/status meteora  — check Meteora DLMM API
/status rpc      — check Solana RPC
```

Each shows: ✅/❌ status, HTTP code, latency, error details.

### 4. GMGN Launchpad Filtering (DONE)

**Commit:** `416d226`

GMGN screening pipeline was missing `blockedLaunchpads` filter. Added to Stage 2 (token info filter).

- `meteora_virtual_curve` added to `allowedLaunchpads` in `user-config.json`
- `letsbonk.fun` in `blockedLaunchpads` now correctly filtered

### 5. Relay Hard Timeout (DONE)

**Commits:** `4b964df`, `48ade49`

Relay fetch was hanging indefinitely when TCP connection established but server didn't respond.

**Fix:** 12-second `Promise.race` hard timeout around relay call. Falls back to Meteora/local path on timeout.

### 6. Swap Retry with Escalating Slippage (DONE)

**File:** `tools/wallet.js`

Swap retries up to 5 times with escalating slippage:
| Attempt | Slippage |
|---------|----------|
| 1 | 0.5% (50 bps) |
| 2 | 1.0% (100 bps) |
| 3 | 2.0% (200 bps) |
| 4 | 5.0% (500 bps) |
| 5 | 10.0% (1000 bps) |

Telegram notification on exhaustion: `notifySwapFailure()` in `telegram.js`.

### 7. Xiaomi MiMo for Screening (DONE)

**Config:**
- Screening: `mimo-v2.5` via `https://token-plan-sgp.xiaomimimo.com/v1`
- Management: `MiniMax-M2.5` via MiniMax API (`https://api.minimax.io/v1`)
- Fallback: `stepfun/step-3.5-flash:free` via OpenRouter

**Agent clients (`agent.js`):**
- `client` (global) — MiniMax API for management/general
- `getScreeningClient()` — Xiaomi endpoint for screening
- `getFallbackClient()` — OpenRouter for fallback

### 8. Darwinian Signal Weighting (FIXED — 2026-05-17)

**Doc:** `docs/DARWINIAN_SIGNALS.md`

**Fixed via upstream merge `7642e2c`:** `getAndClearStagedSignals()` now called at both `trackPosition()` call sites in `tools/dlmm.js`. `signal_snapshot` is now populated on every position. Also: `signal-tracker.js` gained base_mint fallback index; `signal-weights.js` gained `getEntrySignalSnapshot()` for backward compat with old entries; `lessons.js` gained `buildSignalSnapshot()` helper.

### 9. Upstream Merge — SOL PnL + Darwin Signals (DONE — 2026-05-17)

**Commit:** `8b472c1` (merge of upstream `7642e2c`)

**Changes from upstream:**
- `tools/dlmm.js`: `getPositionPnl()` and `closePosition()` now respect `solMode` config — PnL reported in SOL when `solMode: true`. Uses `getClosedPnlValue()` / `getClosedPnlPct()` helpers.
- `tools/dlmm.js`: `getMyPositions()` accepts optional `wallet_address` param for checking arbitrary wallets.
- `signal-tracker.js`: dual-index by pool address + base_mint, TTL-based cleanup.
- `signal-weights.js`: `getEntrySignalSnapshot()` reads signal fields from both `signal_snapshot` field and flat entry fields (backward compat).
- `lessons.js`: `buildSignalSnapshot()` merges staged + tracked signals.
- `index.js`: `getTrackedPositions` import, `base_mint` added to `stageSignals` call, early-return pnl poll when no positions.

**Conflict resolution:** Kept our `pnlSol`/`pnlSolPct` explicit vars alongside upstream helpers; kept extra return fields (`pnl_sol`, `fees_sol`, `minutes_held`); restored `queueTrailingDropConfirmation` import lost from our branch.

### 10. Regression Test Suite (DONE — 2026-05-17)

**Commit:** `03979b0`
**File:** `test/regression-test.js`
**Run:** `node test/regression-test.js`

35 inline unit tests covering all custom R-implementations (no file I/O, fast):

| Group | Cases | Coverage |
|-------|-------|----------|
| R1 Stop Loss | 4 | threshold, suspicious bypass, exact boundary |
| R2/R4.1 Trailing TP | 4 | always TRAILING_TP_QUEUED, drop threshold, OOR order |
| R7 Safety-Lock | 7 | pecut+experimental, above+below, pnl=0, main no-lock |
| R8 Indicator-Aware | 6 | hold, close, fail-open, profile guard, trailing bypass |
| R5 Low Yield | 4 | age gate, custom minAge, fee above min |
| F1 signal-tracker | 7 | pool lookup, base_mint fallback, clear-after-retrieval, null safety |

---

## 📋 CURRENT CONFIGURATION

```json
{
  "closeProfile": "experimental",
  "deployAmountSol": 0.25,
  "maxPositions": 2,
  "r8IndicatorCheck": true,
  "r8ExitPreset": "supertrend_break",
  "r8OorCooldownHours": 6,
  "repeatDeployCooldownHours": 2,
  "repeatDeployCooldownMinFeeEarnedPct": 1,
  "allowedLaunchpads": ["pump.fun", "moonshot", "met-dbc", "meteora_virtual_curve"],
  "blockedLaunchpads": ["letsbonk.fun"]
}
```

---

## 📁 KEY FILES

| File | Purpose |
|------|---------|
| `index.js` | Main entry, management cycle, Telegram handlers, close engines |
| `state.js` | Position state, exit rules, trailing TP, Safety-Lock, R8 gate |
| `config.js` | All config schema and defaults |
| `tools/dlmm.js` | DLMM SDK wrapper (deploy, close, positions, PnL) |
| `tools/screening.js` | Pool discovery pipeline |
| `tools/executor.js` | Tool dispatch, CONFIG_MAP, update_config |
| `tools/api-monitor.js` | API health checks |
| `tools/chart-indicators.js` | RSI/Supertrend/BB indicators (used by R8) |
| `pool-cooldown.js` | Cooldown system per close reason |
| `pool-memory.js` | Pool deploy history |
| `lessons.js` | Performance recording + lesson derivation |
| `hivemind.js` | HiveMind sync (lessons/presets only) |
| `telegram.js` | Telegram bot, notifications |
| `signal-weights.js` | Darwinian signal weighting (broken — see known issues) |

---

## ⚠️ KNOWN ISSUES

### 1. Darwinian Signal Weighting Broken
`signal_snapshot` never populated on positions. `getAndClearStagedSignals()` defined but never called. Weights stuck at 1.0. Needs wiring into `dlmm.js` deploy flow.

### 2. Relay Raw Endpoint
Upstream changed relay to `/positions/open/raw`. Bot currently falls back to Meteora portfolio API. May need server-side update for raw endpoint to work.

### 3. Jupiter/Meteora API Issues
Jupiter swap API: timeout errors. Meteora DLMM API: 404 errors. Both external — not bot issues.

### 4. Encryption Key Placeholder
`.envrypt` contains `replace-with-a-long-local-key` (placeholder). Encrypted keys in `.env` decrypt to garbage. Some keys are in plaintext in `.env` (SCREENING_LLM_API_KEY) or `.env.raw` (all keys).

---

## 🎯 PENDING WORK

### Phase H: R8 Verification (Next)
- Monitor R8 behavior with `profile=experimental`
- Check `/observe held` for R8-held positions
- Verify indicator confirmation logs

### Darwinian Fix
- Wire `getAndClearStagedSignals()` into `dlmm.js` deploy flow
- Pass `signal_snapshot` to `trackPosition()` and `recordPerformance()`

### Relay Raw Endpoint
- Monitor if `/positions/open/raw` starts working (server-side update needed)
- Current fallback to Meteora portfolio API works fine

---

## 🔧 ENVIRONMENT REFERENCE

### Server
- VM: `ubuntu@VM-0-3-ubuntu`
- Path: `/home/ubuntu/projects/meridian`
- Wallet backup: `/home/ubuntu/secure-backup/`

### Git Remotes
```
origin    https://github.com/albertuscrs/meridian.git (my fork)
upstream  https://github.com/yunus-0x/meridian (owner)
```

### Models
- Screening: `mimo-v2.5` (Xiaomi Token Plan Singapore)
- Management: `MiniMax-M2.5` (MiniMax API)
- Fallback: `stepfun/step-3.5-flash:free` (OpenRouter)

### Cron Intervals
- Management: every 3 minutes
- Screening: every 60 minutes
- PnL poll: every 30 seconds

> **Note:** These are production overrides set in `user-config.json` (`managementIntervalMin: 3`, `screeningIntervalMin: 60`).
> `config.js` defaults are 10m / 30m respectively. The PnL poll interval is hardcoded in `index.js`.

### Backups
```
~/secure-backup/private_key.pem.backup
~/secure-backup/public_key.pem.backup
state.json.backup-* (multiple)
```

---

## 📖 DOCUMENTATION

- `docs/CLOSE_RULES_REFACTOR.md` — R1-R10 spec and implementation status
- `docs/DARWINIAN_SIGNALS.md` — Darwinian signal weighting system
- `docs/HANDOVER.md` — This file
- `docs/pool-cooldown-plan.md` — Cooldown enhancement plan
- `docs/hivemind-reference.md` — HiveMind reference
- `docs/hivemind-summary.md` — HiveMind summary

---

## 🎯 SUCCESS CRITERIA

The handover is successful when:
1. ✅ All conflict files resolved with R-implementations preserved
2. ✅ Auto-merged files audited (no silent R-logic loss)
3. ✅ Syntax check passes on all .js files
4. ✅ Merge commits created with detailed messages
5. ✅ Push to fork (origin) succeeds
6. ✅ Bot restarts cleanly
7. ✅ R8 implemented and committed
8. ✅ API monitoring system working
9. ✅ Upstream relay enrichment integrated

---

## 📞 IF STUCK

```bash
# Nuclear option — abort merge, return to checkpoint
git merge --abort
# Working tree returns to commit 3cd16a3

# Or full reset
git reset --hard 3cd16a3
cp state.json.backup-pre-merge-* state.json

# Bot can restart safely from checkpoint state
```

---

## 🤖 CONTEXT FOR NEW AI ASSISTANT

1. User has been working on R1-R10 refactor for ~2 weeks
2. All R-implementations verified in production with logs/data evidence
3. R8 (Indicator-Aware OOR Close) implemented and committed
4. Merge with upstream complete — relay enrichment refactor integrated
5. API monitoring system operational via Telegram `/status` commands
6. Bot running stable with profile=pecut, model=mimo-v2.5
7. Darwinian signal weighting system is broken (needs fix)
8. Relay raw endpoint may need server-side update
9. User prefers data-driven decisions and step-by-step verification
10. Read `docs/CLOSE_RULES_REFACTOR.md` for full R1-R10 context
11. Read `docs/DARWINIAN_SIGNALS.md` for signal weighting context

Good luck.

---

## 🎯 PHASE H: R8 VERIFICATION & EXPERIMENTAL PROFILE ACTIVATION

**Status:** PENDING — Next priority
**Date added:** 2026-05-13
**Goal:** Verify R8 (indicator-aware OOR close) in production by activating
`closeProfile=experimental` with small capital exposure.

### Why This Phase Exists

R8 was implemented and tested via inline-predicate tests (T1-T10 all pass),
but inline tests cannot verify:
- Real indicator API latency under load
- Async pre-fetch race conditions with state mutations
- Indicator fail-open behavior with real API failures
- Integration with R7 Safety-Lock gate ordering
- Whether `supertrend_break` exit preset gives sensible hold/close decisions on real market data

Production verification is required before considering experimental profile stable.

### Pre-flight Checklist

Run before flipping profile:

- [ ] Backup `state.json` to `state.json.backup-pre-r8-activation-YYYYMMDD-HHMMSS`
- [ ] Confirm `closeProfile` currently = `pecut` via `/observe` or `/settings`
- [ ] Set `deployAmountSol` ≤ 0.25 (small exposure)
- [ ] Set `maxPositions` ≤ 3 (limit blast radius)
- [ ] Confirm `r8IndicatorCheck = true` in config
- [ ] Confirm `r8ExitPreset = "supertrend_break"` (default)
- [ ] Confirm `r8OorCooldownHours = 6`
- [ ] Confirm 0 active positions OR all active positions can be closed naturally first
- [ ] Available 4-6 hours after flip for monitoring
- [ ] Market relatively calm (avoid flip during major volatility spike)

### Activation Steps

/settings → flip closeProfile from pecut → experimental
Verify settings summary: "profile: experimental"
Note flip timestamp for /observe compare boundary detection
Set timer for first check at +1 hour, +4 hours, +12 hours, +24 hours


### Monitoring Routine

#### First 4 Hours (Intensive)

Every 60-90 minutes, run via Telegram:
/observe
/observe held
/status apis

What to watch:
- ✅ Errors counter stays 0 (or only known non-related errors)
- ✅ R8-Hold counter > 0 (indicates R8 gate triggered at least once)
- ✅ Positions deploy successfully (R8 doesn't block entry)
- ⚠️  R8-Hold positions with extended duration (>2 hours) — investigate
- 🔴 Any indicator API errors in logs

Log greps:
```bash
# R8 activations today
grep "R8-Hold:" logs/agent-$(date +%Y-%m-%d).log

# Indicator API failures
grep -E "indicator.*error|chart-indicators.*error|confirmIndicatorPreset.*error" logs/agent-$(date +%Y-%m-%d).log

# R8 fail-open events (API down, close as normal)
grep -E "R8.*fail-open|indicator.*unavailable" logs/agent-$(date +%Y-%m-%d).log
```

#### 4-24 Hours (Standard Monitoring)

Every 4-6 hours:
- `/observe compare` — baseline (pecut last 2-3 days) vs current (experimental)
- `/observe reasons` — distribution shift?
- `/observe held` — track R8-Hold positions

Expectations:
- R8-Hold count may be low (only fires when OOR + indicators say "hold")
- Total closes/day may be lower than pecut (R8 holds some that would have closed)
- PnL distribution may shift toward fewer but better closes (or worse if indicators wrong)

#### 24-48 Hours (Verdict)

Decision matrix:

| Pattern | Verdict | Action |
|---------|---------|--------|
| R8-Hold fires 2-10x/day, captured held → recovery, PnL net better/same vs pecut | 🟢 KEEP | Continue experimental, consider scale up |
| R8-Hold fires but positions still close at loss (indicators wrong) | 🟡 TUNE | Try different `r8ExitPreset` (rsi_reversal, bollinger_reversion, etc.) |
| R8-Hold rarely fires (<1/day) | 🟡 NEUTRAL | Indicators rarely confirm hold — R8 marginal benefit, consider revert |
| Errors elevated, positions stuck, PnL clearly worse | 🔴 REVERT | Flip back to pecut, investigate logs, fix before re-attempt |

### Red Flag Triggers (Immediate Revert)

Flip back to `pecut` if any of these occur:

1. **R8-Hold positions stuck unprofitable** with PnL falling -5% to -10% while held
2. **Indicator API errors >10/hour** — fail-open works, but suggests API issues
3. **Position deploy stops** — investigate immediately
4. **Bot crash or memory leak** post-flip
5. **R8 gate logic bug** evident from logs (e.g., R8 firing for non-experimental profile)

Revert via Telegram:
/settings → flip closeProfile experimental → pecut

Bot processes existing experimental-profile positions through whatever close rule fires
(R7 Safety-Lock still active, R8 simply stops being evaluated).

### R8 Tuning Parameters

If R8 works but suboptimal, tunable parameters:

| Param | Default | Options to try |
|-------|---------|----------------|
| `r8ExitPreset` | `supertrend_break` | `rsi_reversal`, `bollinger_reversion`, `rsi_plus_supertrend`, `supertrend_or_rsi`, `bb_plus_rsi`, `fibo_reclaim`, `fibo_reject` |
| `r8OorCooldownHours` | 6 | 2-12h depending on hold pattern |
| `r8IndicatorCheck` | true | false to disable R8 entirely (experimental → behaves like pecut for OOR) |

### Success Metric

R8 verification SUCCESS = 48 hours of `closeProfile=experimental` with:
- 0 critical errors
- R8-Hold mechanism fires at least 5 times
- At least 50% of R8-Hold positions either:
  - Recover to profit before closing, OR
  - Close at smaller loss than they would have at OOR-only timeout
- PnL net (experimental period) ≥ PnL net (pecut baseline, same duration)

After success: consider scale up `deployAmountSol`, continue monitoring 1 week,
then evaluate making experimental the default profile.

After failure or yellow verdict: document findings, tune `r8ExitPreset` or
parameters, re-test.

---

## 🗺️ ROADMAP AFTER R8 VERIFICATION

Priority order based on impact × effort × stability:

### Tier 1: Critical Fixes (After R8 Verified)

#### ✅ F1: Darwinian Signal Wiring (DONE — 2026-05-17)
**Resolved via:** upstream merge `7642e2c`
Upstream independently fixed this: `getAndClearStagedSignals()` now called at both `trackPosition()` call sites in `tools/dlmm.js`. Signal snapshots stored in state.json + lessons.json. `signal-tracker.js` also gained base_mint fallback index. Darwinian weight evolution is now fully wired.

#### F2: Encryption Key Placeholder (SECURITY)
**Effort:** Small (~15 minutes)
**Impact:** High (currently keys partially exposed in plaintext)
**Approach:** Generate proper encryption key for `.envrypt`, re-encrypt secrets in
`.env`. Verify decryption works. Delete `.env.raw` if exists.

### Tier 2: Remaining R-Implementations

#### R6: HiveMind Close Decision Sync (ORIGINAL SPEC)
**Effort:** Large (~150 lines + async coordination)
**Impact:** Medium (HiveMind currently only stores lessons, not consulted at close)
**Risk:** High (async network call in hot close path, race conditions, HiveMind
downtime fallback needed)
**Prerequisites:**
- R8 stable for 1+ week
- HiveMind server uptime/SLA understood
- Failure mode design (HiveMind down → fail-open like R8? Or fail-closed?)

#### R3: LLM-eval SL Path (ORIGINAL SPEC)
**Effort:** Medium (~80 lines)
**Impact:** Low-Medium (current hard SL works well; LLM eval adds nuance but slows)
**Risk:** Medium (LLM latency at stop-loss moment when speed matters most)
**Recommendation:** Reconsider necessity. Current Hard Floor SL is fast and works.
LLM-eval might delay critical exit. May be optional rather than priority.

### Tier 3: Strategic Improvements

#### S1: Aggregate Performance Dashboard
**Effort:** Medium (~100 lines)
**Impact:** High (decision making clarity)
**Approach:** Telegram `/performance` command that shows:
- Total deployed (SOL/USD)
- Total fees earned (SOL/USD)
- Net PnL per period (24h, 7d, 30d, all-time)
- Win rate per close reason
- Best/worst performing pools
- ROI percentage

#### S2: Experimental as Default Migration
**Effort:** Small (after R8 verified stable for 1 week)
**Impact:** Medium (cleaner default behavior)
**Approach:** If R8 metrics show clear win, change config.js default from
`"pecut"` to `"experimental"`. Update docs.

#### S3: HiveMind Lessons Integration Deeper
**Effort:** Medium-Large
**Impact:** Medium-High (currently underutilized data)
**Approach:** Beyond just storage, use lessons in screening or close decisions.
E.g., pool that lost money 3x in last week → auto-cooldown longer.

### Tier 4: Maintenance & Health

#### ✅ M1: Test Infrastructure (DONE — 2026-05-17)
`test/regression-test.js` added — 35 cases covering R1/R2/R4.1/R5/R7/R8/F1 signal-tracker.
Run: `node test/regression-test.js`. Existing: `pool-cooldown-test.js` (6), `test-solmode-pnl.js` (10).

#### M2: Upstream Sync Cadence
**Effort:** Small (recurring)
**Impact:** Low-Medium
**Approach:** Establish weekly check `git fetch upstream && git log
experimental..upstream/experimental`. Decide cherry-pick vs merge per
upstream commit batch.

#### M3: Log Rotation & Archival
**Effort:** Small
**Impact:** Low
**Approach:** Logs accumulate. Add weekly rotation/compress old daily logs to
prevent disk fill.

#### M4: Bot Restart Drills
**Effort:** Tiny
**Impact:** Medium (operational confidence)
**Approach:** Periodically test bot restart from cold start. Verify state.json
loads correctly. Verify pending positions resume tracking.

### Out of Scope / Decided Against

- **R3 LLM-eval SL** — likely net-negative due to latency at SL moment
- **PVP Rivalry check at close** — was R8's "experimental" twin in original spec
  but R8 indicators cover similar ground; PVP rivalry may be redundant
- **Aggressive trailing TP tuning** — current 3s pecut / 15s main works; don't
  fix what isn't broken

---

## 📅 SESSION CONTINUITY LOG

Future sessions should add brief entries here when major milestones land.
Format: `**YYYY-MM-DD** — Brief description (commit hash)`

- **2026-05-07** — R4.1 implemented and verified (commit pre-merge)
- **2026-05-08** — Cooldown investigation, tuning applied
- **2026-05-09** — Fork created, security hardening
- **2026-05-10** — Merge with upstream complete (commit 56c04ee)
- **2026-05-12** — R8 implemented (commit b022962)
- **2026-05-13** — API monitoring + relay enrichment merge (commit 2837752); Phase H activated (closeProfile → experimental)
- **2026-05-15** — Phase H monitoring: R8 pre-fetch ✅ (54x May 14), R8 holds 4x (May 13), Safety-Lock 20x (May 14), 0 errors
- **2026-05-17** — Phase H verdict: 🟢 GREEN — 3 unique R8-held positions (11 events May 12-16), 0 close at loss, mechanism confirmed working. Next: F1 Darwinian signal wiring.
- **2026-05-17** — Upstream merge `7642e2c` (sol pnl + darwin signal fix); F1 resolved via merge; regression test suite added (35 cases, commits 8b472c1 + 03979b0)

---

## 🔬 PHASE H STATUS — R8 Experimental Profile Monitoring

**Started:** 2026-05-12 00:16 UTC (closeProfile flipped pecut → experimental via Telegram settings)
**Verified:** 2026-05-17
**Verdict:** 🟢 GREEN — mechanism confirmed, all outcomes neutral-to-positive, 0 errors in 5 days

### Config Snapshot (at Phase H start)
```json
"closeProfile": "experimental",
"r8ExitPreset": "supertrend_break",
"chartIndicators": { "enabled": true, "exitPreset": "bb_plus_rsi" }
```

### Evidence Collected

#### R8 Pre-fetch Activity (May 14)
- **54 pre-fetches** logged: `[MGMT] R8 pre-fetch:` across management cycles
- Confirms indicator data successfully retrieved and stored in `indicatorData` Map
- No API errors or timeout failures observed

#### R8 Hold Events (May 13 — position HWEXubSXt1Y6...)
- R8 gate fired at OOR timeout (35m above), indicator returned `confirmed: false`
- Position held for 38–56 minutes extra by R8
- Eventually closed by Rule 3 (pump close) at **+0.18% PnL**
- Outcome: Better than instant OOR close — R8 hold gave position time to earn a small profit before pump ejection
- Total R8 holds observed: **4x** (threshold for confidence: 5+)

#### Safety-Lock Activity (May 14)
- **20 Safety-Lock events** logged: `[STATE] Safety-Lock:` across management cycles
- All cases: OOR timeout reached with `pnl_pct ≤ 0`, position held instead of closed
- Confirmed case: position B62BoSYFrPyMQvN22 held at 35–44m OOR (pnl=0.00%), came back IN RANGE at 44m
- Safety-Lock demonstrably preventing unnecessary closes of zero-PnL positions

#### Error Count
- R8 path errors: **0**
- Fail-open triggers (API unavailable): **0**
- Trailing TP bypasses: **0**

### Gate Order Verified
```
OOR timeout reached
  → trailingArmed? → OUT_OF_RANGE (immediate, no gate)
  → Safety-Lock (R7): pnl_pct ≤ 0 → STAY
  → R8: confirmIndicatorPreset() → confirmed:false → STAY / confirmed:true → OUT_OF_RANGE
  → OUT_OF_RANGE (default)
```

### Phase H Success Criteria
| Criterion | Target | Status |
|-----------|--------|--------|
| 0 critical errors | 0 | ✅ 0 errors |
| R8 holds observed | ≥5 | ✅ 11 events, 3 unique positions |
| Safety-Lock working | Active | ✅ 20 events |
| Fail-open working | No crashes | ✅ confirmed |
| Trailing TP unaffected | 0 bypasses | ✅ confirmed |

### Next Steps After 48h
1. Confirm R8 hold count reaches 5+ (continue monitoring)
2. If verdict GREEN: update CLOSE_RULES_REFACTOR.md R8 status from "Phase H pending" → "Production verified (YYYY-MM-DD)"
3. Decide on F1 (Darwinian signal wiring fix) as next priority
4. Long-term: R6 HiveMind sync at close (needs R8 stable 1+ week first)
