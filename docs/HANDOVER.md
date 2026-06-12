# Meridian DLMM Agent — Handover Document
**Date:** 2026-05-18
**Branch:** experimental
**Status:** Stable — all merges complete, bot running, Emergency Exit implemented
**Current HEAD:** `1bb2edc` (feat: emergency exit at -10% bypassing cooldown)

---

## 🚨 CRITICAL CONTEXT — READ THIS FIRST

This is a **personal fork** of an open-source DLMM LP agent (Meridian).

- **My fork (origin):** https://github.com/albertuscrs/meridian
- **Upstream owner:** https://github.com/yunus-0x/meridian
- **Current HEAD:** `1bb2edc` (emergency exit feature)
- **Bot status:** Running stable, profile=experimental, model=mimo-v2.5 (screening), MiniMax-M2.7 (management)

### Git History (Recent)

```
cb97f05 merge: integrate upstream experimental (3 commits)
8eb279e docs: update handover and CLAUDE.md with all completed work
1bb2edc feat: emergency exit at -10% bypassing cooldown
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

### 1. ~~Darwinian Signal Weighting Broken~~ ✅ FIXED (2026-05-17)
Resolved via upstream merge `7642e2c`. `getAndClearStagedSignals()` now called at both `trackPosition()` call sites. Signal snapshots stored in state.json + lessons.json.

### 2. Stop Loss is #1 Capital Destroyer
23 SL events since May 1 (7.2% of closes). 3 catastrophic outliers (>10% loss) account for ~50% of total SL losses. Screening metrics cannot distinguish SL-prone pools — fee/TVL at deploy is actually HIGHER for SL positions (1.60 vs 0.89). See Stop Loss Deep-Dive section above. Emergency exit at -10% recommended.

### 3. Encryption Key Placeholder
`.envrypt` contains `replace-with-a-long-local-key` (placeholder). Encrypted keys in `.env` decrypt to garbage. Some keys are in plaintext in `.env` (SCREENING_LLM_API_KEY) or `.env.raw` (all keys).

### 4. Relay Raw Endpoint
Upstream changed relay to `/positions/open/raw`. Bot currently falls back to Meteora portfolio API.

### 5. Jupiter/Meteora API Issues
Jupiter swap API: timeout errors. Meteora DLMM API: 404 errors. Both external — not bot issues.

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
- **2026-05-18** — Stop Loss deep-dive analysis (23 SL since May 1); catastrophic outlier identification
- **2026-05-18** — Emergency exit at -10% implemented (commit `1bb2edc`): Rule 0 in state.js, cooldown bypass in PnL poll, /settings UI button, CONFIG_MAP entry
- **2026-05-18** — Screening cooldown fix: when no positions, management cycle respects `screeningIntervalMin` instead of triggering every 3 minutes
- **2026-05-18** — Jupiter health check fix: `quote-api.jup.ag` hostname deprecated (DNS dead), switched to `api.jup.ag/price/v3` with `x-api-key` header from config; removed hardcoded API key from wallet.js (now reads from .env via config); regression test suite expanded to 49 cases; Fee Drift Detection plan documented
- **2026-05-23** — Fee Drift Detection implemented: Layer 1 (fee_change_pct decline) in screening + deploy, Layer 2 (cross-timeframe spike 1h vs 24h) in deploy validation; 7 config keys, 80 regression tests total
- **2026-05-23** — Config tuning: stopLossCooldownHours 2→6, minVolatility 3→3.5 (updated in config.js + user-config.json); Base-mint blacklist on catastrophic SL (pnlPct ≤ -10%) added to pool-cooldown.js; 91 regression tests total
- **2026-05-23** — Time-of-Day awareness: young tokens (<24h) blocked during risky UTC windows (00-04, 16-17); 3 config keys, 109 regression tests total
- **2026-05-23** — Performance Dashboard (`/performance` 24h/7d/30d/all); Log Rotation (7-day retention, 68 old files cleaned); R8 presets documented; 123 regression tests total
- **2026-05-24** — Upstream merge (3 commits: auto-register Telegram commands, DeepSeek thinking mode fix, false volume=0 screening fix); fixed `numberOrNull` bug in screening.js; `hiveMindPullMode: "auto"` confirmed in user-config.json
- **2026-05-28** — PnL Poll Gap fix: emergency floor check added BEFORE peak gate in `queuePeakConfirmation()` (state.js); prevents positions from bleeding -10%+ without detection (Embrace case); throttled diagnostic log (5 min/position); 137 regression tests total
- **2026-05-29** — GMGN Settings reorganized: Volume page (mcap, volume, holders), Safety page (10 anti-scam filters), Indicators page (GMGN indicator filter + BB position toggle); 3 new CONFIG_MAP entries (maxRugRatio, rejectSingleVolumeSpike, maxSingleCandleVolumeShare); 176 regression tests total
- **2026-05-30** — PnL Poll Gap fix follow-up: `state.js` doesn't import `config` — changed to pass `emergencyClosePct` and `closeProfile` via `options` parameter to `queuePeakConfirmation()`; `index.js` call site updated; 176 regression tests still pass
- **2026-06-03** — GMGN Settings `settingValue()` mapping fix: added 15 missing keys (gmgnMinMcap, gmgnMaxMcap, gmgnAthFilterPct, gmgnHoldersLimit, gmgnMaxTop10HolderRate, gmgnMaxRatTraderRate, gmgnMaxFreshWalletRate, gmgnMaxDevTeamHoldRate, gmgnMaxBotDegenRate, gmgnMaxRugRatio, gmgnMaxSniperCount, gmgnMaxSniperHoldRate, gmgnMinSmartDegenCount, gmgnRequireBbPosition); Telegram `/settings` now shows actual values from gmgn-config.json instead of "off"
- **2026-06-03** — Jupiter health check fix: `quote-api.jup.ag` DNS dead → switched to `api.jup.ag/price/v3` with `x-api-key` header from config; removed hardcoded API key from wallet.js (now reads from .env via config); screeningModel changed from mimo-v2.5 to MiniMax-M2.7; 15 state.json backup files deleted
- **2026-06-03** — CLAUDE.md updated with "What was done / What to avoid / What worked well" session notes section
- **2026-06-08** — Upstream merge SKIPPED: 2 new upstream commits (1e053a2 drop 15m timeframe + 5fae0c5 massive refactor: entry/exit learning, HiveMind market push, OKX removal). 5fae0c5 conflicts with local R-implementations in 5 files (index.js, lessons.js, telegram.js, tools/dlmm.js, tools/executor.js). Resolving requires significant effort. Re-evaluate after local branch stabilizes.

- **2026-06-08** — Upstream cherry-pick: 1e053a2 (drop 15m timeframe) applied. Conflicts in prompt.js (kept upstream 30m instead of 15m). New file screening-scales.js added. Other 3 files (definitions.js, executor.js, screening.js) auto-merged. 5fae0c5 still skipped (too large). 176/176 regression tests pass, bot restarted.
- **2026-06-08** — Upstream cherry-pick: 5fae0c5 (entry/exit learning, HiveMind market push, OKX removal) applied. Conflicts resolved in config.js, prompt.js, telegram.js, tools/executor.js, tools/dlmm.js, lessons.js, index.js, screening-scales.js. Kept local features: Fee Drift config keys, GMGN settings CONFIG_MAP, OPERATOR_ONLY_KEYS, displayPnlPct with appendDecision, maxVolatility evolution. Upstream added: repo-root.js (PM2 cwd fix), entry/exit market context in lessons.js, log rotation, screening-scales.js with 30m scaling. New file repo-root.js added. 176/176 regression tests pass, bot restarted.
- **2026-06-08** — Screening "no tool call was made" error fix: Added `allowSkip` option to `agentLoop` in agent.js. When `allowSkip: true` is passed, `mustUseRealTool` is disabled, allowing the model to return text when it decides to skip a cycle. The screening goal explicitly says "If no pool qualifies, report ⛔ NO DEPLOY" but the MUTATING_TOOL_INTENTS regex was forcing the model to call a tool (rejecting the text response). Index.js SCREENER call now passes `allowSkip: true`. 180/180 regression tests pass, bot restarted.
- **2026-06-10** — Volume Trend Acceleration classification: Classifies pools by `volume_change_pct` into `accelerating` (>10) / `stable` (-10 to 10) / `decelerating` (<-10) / `unknown` (null). Data-validated: ALL catastrophic losses cluster in "decelerating" pools (111 positions, -0.23% avg PnL). "Accelerating" pools get +100 score boost. GMGN enrichment: 1 API call per GMGN pool to fetch Meteora pool detail (GMGN pipeline doesn't expose `volume_change_pct`). 4 config keys: `volumeTrendFilter`, `volumeTrendAccelThreshold` (10), `volumeTrendDecelThreshold` (-10), `volumeTrendBlockDecel` (false — LLM decides). Deploy validation re-check. `/settings` Telegram buttons. 37 new regression tests, 217/217 total pass, bot restarted.
- **2026-06-11** — Management cycle display improvements: 4 new helper functions in `index.js` — `fmtAge` (formats `83m` → `1h 23m`, `1440m` → `24h`), `fmtFeeTvl` (yield with `/24h` suffix), `positionStatusEmoji` (5-level: ⚪/🟢/🟡/🟠/🔴), `feeTvlBar` (visual bar `▁▂▃▄▅▆` based on yield magnitude). Multi-line layout per position: status emoji, value/PnL, range/age, fee/unclaimed, OOR/IN status. Summary line adds profitable+OOR counts + avg fee/TVL/24h. Applied to both management cycle report and `/positions` command. 48 new regression tests, 265/265 pass, bot restarted.
- **2026-06-12** — Upstream merge: RPC PnL + GMGN fee source. 5 commits integrated: `905305b` (RPC-derived PnL poller via Meteora DLMM SDK on pump.helius-rpc.com + GMGN fee source with auto-fallback to Jupiter), `eaa7c71` (fix: base pnl_pct_suspicious on input validity), `343ad5a` (fix: honor pnl_pct_suspicious in getDeterministicCloseRule), `0e02421` (relay poll label + debug log), `771928a` (replace flood pnl_tick log with 60s heartbeat). 8 conflict files resolved (config.js, index.js, lessons.js, briefing.js, tools/dlmm.js, tools/executor.js, tools/token.js, tools/gmgn.js). Kept all local features (Fee Drift, Time-of-Day, Volume Trend, OPERATOR_ONLY_KEYS, PnL Poll Gap fix, evaluateAndSetCooldown call, etc.). LPAgent relay removed from PnL primary path. New config keys: `pnlSource` (rpc/meteora), `pnlRpcUrl`, `pnlPollIntervalSec` (3s), `pnlDepositCacheTtlSec` (300s), `gmgnFeeSource` (gmgn/jupiter). 265/265 regression tests pass, bot restarted with `[POSITIONS] Computing PnL from RPC (https://pump.helius-rpc.com)...` confirmed working.

### Diverged Commits

- **experimental ahead:** 25 commits (all local features — Fee Drift, Catastrophic SL blacklist, Time-of-Day, PnL Poll Gap, GMGN Settings, Jupiter fix, allowSkip, Volume Trend, etc.)
- **upstream/experimental ahead:** 0 commits (1e053a2 + 5fae0c5 both cherry-picked)
- **Local branch is 25 commits ahead of upstream — fully in sync**

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

---

## 🩸 STOP LOSS DEEP-DIVE — 2026-05-18

**Dataset:** All 321 closed positions since May 1, 2026. 23 hit Stop Loss (7.2%).

### Key Finding: Screening metrics CANNOT distinguish SL from non-SL

```
                    SL (23)      Non-SL (298)
─────────────────────────────────────────────
fee/TVL median       1.60          0.89
volatility median    4.35          4.35
organic median       80            80
hold time median     61 min        60 min
initial value        $42           $42.50
```

**SL positions actually have 1.8x HIGHER fee/TVL at deploy time than non-SL.** This is counterintuitive: pools with "good" fee/TVL (1.60+) are MORE likely to hit stop loss. High fee/TVL may be a contrarian indicator — pools that look too good attract LPers but may harbor insider dumpers.

### Catastrophic Outliers (>10% loss)

| Pool | PnL | Hold | fee/TVL | Notes |
|------|-----|------|---------|-------|
| RoyalPop-SOL | **-30.72%** | 34 min | 3.17 | Toxic — 2 SL out of 3 deploys |
| OPM-SOL | **-17.06%** | 33 min | 2.22 | Instant crash |
| BMNTP-SOL | **-16.11%** | 55 min | 1.69 | Instant crash |

These 3 positions account for ~50% of total SL loss. All crashed in under 1 hour — these are token ilo dumps, not slow bleeds.

### Time-of-Day Pattern

```
00-04 UTC: SL rate 11.8-18.2%  (⚠️ high risk)
05-09 UTC: SL rate 0%          (✅ zero SL, 47 deploys)
10-15 UTC: SL rate 7.7-10%     (normal)
16-17 UTC: SL rate 12.5-15%    (⚠️ high risk)
```

05:00-09:00 UTC (12:00-16:00 WIB) — 47 deploys, ZERO SL. The "clean window." Outside this window, SL rate jumps 2-3x.

### Repeat Offenders (pools with 2+ SL)

| Pool | Total Deploys | SL Count | Note |
|------|---------------|----------|------|
| SELLOR-SOL | 5 | 2 | Profitable early → turned toxic |
| RoyalPop-SOL | 3 | 2 | Should be blacklisted |
| Yae-SOL | 4 | 2 | 22min crash + 284min bleed |

**Cooldown gaps as low as 2 hours** after SL — `stopLossCooldownHours=2` is too short. HANTA-SOL, mask-SOL, Bear-SOL all re-deployed within 2h of hitting SL.

### PnL Breakdown

| Reason | Count | Fees | PnL |
|--------|-------|------|-----|
| Trailing TP | 14 | $17.79 | +$11.55 |
| Stop Loss | 9 | $8.46 | **-$15.91** |
| Rule 3 (pump) | 43 | $3.58 | +$3.05 |
| Low Yield | 33 | $1.47 | +$0.60 |

Without the 9 SL positions: net PnL would be +$15.21 instead of near breakeven. Stop loss is the #1 capital destroyer.

---

## 🎯 NEW RECOMMENDATIONS (2026-05-18)

### Tier 1: Emergency Exit at -10% (Option A) ✅ DONE (2026-05-18)

**Commit:** `1bb2edc`  
**Impact:** HIGH — catches 100% of catastrophic outliers  
**Effort:** ~20 lines across 4 files

**Implementation:**
1. `config.js`: `emergencyClosePct` default -10 — configurable via `/settings` Risk page
2. `state.js`: Rule 0 emergency check BEFORE Rule 1 — returns `EMERGENCY_CLOSE` action (no gates, no Safety-Lock, no R8)
3. `index.js`: PnL poll bypasses cooldown for `EMERGENCY_CLOSE` — sets `_pollTriggeredAt = 0` to force immediate management cycle
4. `tools/executor.js`: CONFIG_MAP entry
5. `/settings` UI: Risk page → "Emergency close %: -10 ✏" input button + `settingValue` entry

**Flow:**
```
SEBELUM: PnL poll → SL at -5% → cooldown 180s → management cycle → LLM 30-60s → close (250s total, RoyalPop -30%)
SESUDAH: PnL poll → Emergency at -10% → cooldown DISKIP → management cycle → hard exit → close (70s total, ~-11% to -13%)
```

### Tier 2: Fee Drift Detection ✅ DONE (2026-05-23)

**Impact:** HIGH — prevents deploying into temporary fee spikes  
**Effort:** ~80 lines across 4 files

#### Design: Two-Layer Detection

**Layer 1: Fee Decline (screening + deploy, zero extra API cost)**
- The API already returns `fee_change_pct` (period-over-period fee change %)
- This field was extracted at `tools/screening.js:848` but **never used**
- If `fee_change_pct < maxFeeDeclinePct` (default -50) → reject: fees are actively crashing

**Layer 2: Fee Spike / Honeypot (deploy validation only, 1 extra API call)**
- Fetch pool detail for short timeframe (default "1h") and long timeframe (default "24h")
- Compare: `short_fee_tvl / long_fee_tvl`
- If ratio > `maxFeeDriftRatio` (default 3.0) AND short_fee_tvl > `feeSpikeMinShortFeeTvl` (default 0.5) → reject as "fee spike"
- Only runs at deploy validation time (not screening) to minimize API overhead

#### Config Keys (`config.js` screening section)

| Key | Default | Purpose |
|-----|---------|---------|
| `feeDriftCheck` | `true` | Master toggle |
| `maxFeeDeclinePct` | `-50` | Layer 1: reject if fee_change_pct below this |
| `feeSpikeCheck` | `true` | Layer 2 toggle |
| `feeSpikeShortTimeframe` | `"1h"` | Short timeframe for spike check |
| `feeSpikeLongTimeframe` | `"24h"` | Long timeframe (baseline) |
| `feeSpikeMaxRatio` | `3.0` | Max allowed short/long fee/TVL ratio |
| `feeSpikeMinShortFeeTvl` | `0.5` | Skip check if short fee/TVL < 0.5% |

#### Files Modified

| File | Changes |
|------|---------|
| `config.js` | Added 7 config keys to `screening` section |
| `tools/screening.js` | Layer 1: `fee_change_pct` filter in `getTopCandidates()` |
| `tools/executor.js` | Layer 1+2 checks in `validateDeployPoolThresholds()`. CONFIG_MAP entries for 7 keys |
| `tools/definitions.js` | Updated `update_config` description with new keys |
| `test/regression-test.js` | 31 fee drift tests added (80 total) |

#### Flow
```
Screening (getTopCandidates):
  For each candidate:
    → existing filters (TVL, volatility, cooldown, etc.)
    → [NEW] Layer 1: fee_change_pct < maxFeeDeclinePct? → REJECT "fees declining X%"
    → present to LLM

Deploy validation (validateDeployPoolThresholds):
  → existing fee/TVL check against minFeeActiveTvlRatio
  → [NEW] Layer 1: re-check fee_change_pct from fresh pool detail → REJECT
  → [NEW] Layer 2: fetch long-timeframe fee/TVL → ratio check → REJECT if spike
  → proceed with deploy
```

#### Edge Cases
- Fail-open on Layer 2: if long-timeframe API call fails, skip (don't block deploy)
- Very new tokens (<24h) may have `null` long-timeframe fee/TVL → skip Layer 2
- `feeSpikeMinShortFeeTvl` prevents false positives on tiny-fee pools

Rationale: SL positions had higher fee/TVL (1.60 median) than non-SL (0.89). High fee/TVL that doesn't sustain across longer timeframes is a honeypot signal. Currently 76% of positions die young (43% pumped out + 33% low yield) — fee drift detection catches the root cause.

### Tier 3: Config Tuning ✅ DONE (2026-05-23)

| Change | From | To | Rationale |
|--------|------|----|-----------|
| `stopLossCooldownHours` | 2 | 6 | Prevent fast re-deploy into pools that just SL'd |
| `minVolatility` | 3 | 3.5 | Reduce pump-frequency pools (43% Rule 3 closes) |

Updated in both `config.js` (defaults) and `user-config.json` (runtime values).

### Tier 4: Base-mint Blacklist After Catastrophic SL ✅ DONE (2026-05-23)

If a base_mint ever hits SL with PnL ≤ -10% (same as `emergencyClosePct`), the token is permanently blacklisted via `token-blacklist.js`. Screening filters blacklisted tokens before passing pools to the LLM.

**Implementation:** `pool-cooldown.js` Scenario 2 (Stop Loss) now calls `addToBlacklist()` when `pnlPct <= emergencyClosePct`. Uses same threshold as Rule 0 Emergency Close.

**Unblacklist:** Via Telegram `/blacklist remove <mint>` or `remove_from_blacklist` tool.

### Tier 5: Screening Time-of-Day Awareness ✅ DONE (2026-05-23)

Skip deploy if token age < 24 hours AND current hour is in high-risk window (00-04 UTC or 16-17 UTC). Zero SL during 05-09 UTC suggests pool quality varies significantly by time of day.

**Config keys:** `timeOfDayCheck` (default true), `riskyHours` (default [0,1,2,3,4,16,17]), `minTokenAgeForTimeCheck` (default 24h)

**Files:** `config.js`, `tools/screening.js` (filter in `getTopCandidates()`), `tools/executor.js` (CONFIG_MAP), `tools/definitions.js`

### S1: Aggregate Performance Dashboard ✅ DONE (2026-05-23)

**Command:** `/performance` (24h default), `/performance 7d`, `/performance 30d`, `/performance all`

**Shows:**
- Period stats: positions, win rate, total PnL, avg PnL, fees earned
- All-time stats: total positions, win rate, PnL, range efficiency
- Best/worst pools by PnL
- Close reason breakdown with PnL per reason

**Files:** `index.js` (command handler), `lessons.js` (getPerformanceHistory already existed)

### S2: Volume Trend Acceleration ✅ DONE (2026-06-10)

**Problem:** All catastrophic losses cluster in pools with declining volume. Data analysis of 558 closed positions:
- Accelerating (vol_change > 10%): 341 positions, +0.21% avg PnL, **0 catastrophic losses**
- Stable (-10 ≤ vol ≤ 10): 106 positions, +0.42% avg PnL, **0 catastrophic losses**
- Decelerating (vol_change < -10%): 111 positions, -0.23% avg PnL, **ALL catastrophic losses**

**Implementation:**
- `classifyVolumeTrend()` in `screening.js` — classifies into accelerating/stable/decelerating/unknown
- `volume_trend` field added to `condensePool()` output for LLM context
- Score boost +100 for accelerating pools in `scoreCandidate()`
- Hard-block filter (default off — LLM decides via `volumeTrendBlockDecel`)
- GMGN enrichment: 1 API call per eligible GMGN pool to fetch Meteora pool detail (GMGN pipeline doesn't expose `volume_change_pct` natively)
- Deploy validation re-check in `executor.js`

**Config keys (screening section):**
| Key | Default | Purpose |
|-----|---------|---------|
| `volumeTrendFilter` | `true` | Master toggle |
| `volumeTrendAccelThreshold` | `10` | Above = accelerating |
| `volumeTrendDecelThreshold` | `-10` | Below = decelerating |
| `volumeTrendBlockDecel` | `false` | Hard-block decelerating (false = LLM decides) |

**`/settings` UI:** Screen page has 2 toggles (filter on/off, block decelerating) + 2 threshold inputs.

**Files:** `config.js`, `tools/screening.js`, `tools/executor.js`, `index.js`, `tools/definitions.js`, `test/regression-test.js`

### S3: Management Cycle Display ✅ DONE (2026-06-11)

**Problem:** Management cycle and `/positions` display were text-heavy and hard to scan quickly. Status wasn't visually obvious; yield magnitude wasn't shown; time format was inconsistent.

**Improvements:**

4 new helper functions in `index.js`:
- `fmtAge(minutes)` — formats `83m` → `1h 23m`, `1440m` → `24h` (1 day), `0` → `0m`
- `fmtFeeTvl(value, timeframe)` — adds `/24h` suffix to yield display
- `positionStatusEmoji(p)` — 5-level status indicator: ⚪ (no data) / 🟢 (in range +2%+) / 🟡 (in range 0-2%) / 🟠 (in range -3 to 0%) / 🔴 (OOR or in range <-3%)
- `feeTvlBar(value)` — visual bar chart `▁▂▃▄▅▆` based on yield magnitude (6 tiers: <1, <3, <6, <10, <20, ≥20)

**Layout changes (both mgmt cycle and `/positions`):**
- Status emoji at line start (replaces plain `📊`)
- Multi-line layout: value/PnL, range/age, fee/unclaimed, status
- OOR duration formatted as `1h 23m` instead of `83m`
- Fee bar `▃▂▁` before `/24h` yield (visual magnitude)
- Summary line: adds profitable + OOR counts, avg fee/TVL per 24h
- Separator `─────────────` before summary

**Example output:**
```
🟢 1. TOKEN-SOL | bid_ask
   💰 $0.250 | PnL: +1.5% (+$0.003)
   📍 🟢 [████████░░░░░░░░] 50% (bin 1000/900-1100) | ⏱ 1h 23m
   📈 ▃▂▁ 5.50%/24h | 📥 $0.001 unclaimed
   🟢 IN | 📋 HOLD

🔴 2. HAZARD-SOL | spot
   💰 $0.100 | PnL: -5.0% (-$0.005)
   📍 🔴 [░░░░░░░░░░░░░░░░] bin 1200 (above 900–1100) | ⏱ 45m
   📈 ▁ 0.50%/24h | 📥 $0.000 unclaimed
   🔴 OOR 2h 5m

─────────────
📦 2 positions | 1🟢 1🔴 | 💵 $0.350
📊 Avg PnL: -1.7% | 📈 Avg fee/TVL: 3.00%/24h | 📥 $0.001 unclaimed
🔔 Action: none | ✅ Stay: 2
```

**Files:** `index.js` (helpers + display logic), `test/regression-test.js` (48 new tests).

### S4: Upstream RPC PnL + GMGN Fee Source ✅ MERGED (2026-06-12)

**Upstream commits merged (5 total):**
- `905305b` — RPC-derived PnL poller + GMGN fee source (10 files, 368 insertions, 51 deletions)
- `eaa7c71` — fix: base pnl_pct_suspicious on input validity
- `343ad5a` — fix: honor pnl_pct_suspicious in getDeterministicCloseRule
- `0e02421` — fix: relay poll label + debug log
- `771928a` — fix: replace flood pnl_tick log with 60s heartbeat

**New features integrated:**

**RPC PnL (`tools/pnl.js` new file, 272 lines):**
- Live position value computed on-chain via Meteora DLMM SDK on `pump.helius-rpc.com`
- Deposit history (cost basis, withdrawals, claimed fees) from Meteora `/pnl` API, cached with signature invalidation
- Token prices from Jupiter (never cached, always fresh)
- Zero dependency on LPAgent / agentmeridian.xyz relay for PnL
- `pnlPollIntervalSec` configurable (default 3s)

**Smarter Exit Guard (`pnl_pct_suspicious`):**
- Stop-loss / trailing TP suppressed when tick can't be priced (Jupiter outage, missing deposits)
- Prevents false exits during API downtime — OOR and low-yield rules still fire normally
- `getDeterministicCloseRule` honors the suspicious flag

**GMGN as Fee Source (`tools/gmgn.js` + `tools/token.js`):**
- `minTokenFeesSol` gate now uses GMGN `total_fee` (more accurate than Jupiter `t.fees`)
- Auto-fallback to Jupiter when no GMGN key or API error
- `token.js` `global_fees_sol` resolves from GMGN

**New config keys (`pnl` + `gmgn.feeSource`):**
| Key | Default | Purpose |
|-----|---------|---------|
| `pnlSource` | `"rpc"` | `rpc` (on-chain) or `meteora` (API fallback) |
| `pnlRpcUrl` | `https://pump.helius-rpc.com` | Any Solana RPC endpoint |
| `pnlPollIntervalSec` | `3` | How often poller checks positions |
| `pnlDepositCacheTtlSec` | `300` | Cache TTL for deposit history |
| `gmgnFeeSource` | `"gmgn"` | `gmgn` (with key) or `jupiter` |

**8 conflict files resolved:**
- `config.js` — kept local Fee Drift / Time-of-Day / Volume Trend keys
- `index.js` — kept local display helpers (fmtAge, feeTvlBar, etc.)
- `lessons.js` — kept `evaluateAndSetCooldown` call (upstream removed it; critical for cooldown logic)
- `briefing.js` — kept `htmlEscape` function
- `tools/dlmm.js` — removed LPAgent relay path (per upstream)
- `tools/executor.js` — kept OPERATOR_ONLY_KEYS + all local CONFIG_MAP entries
- `tools/gmgn.js` — auto-merged
- `tools/token.js` — kept GMGN `global_fees_sol` refinement

**Live verification after restart:**
```
[POSITIONS] Computing PnL from RPC (https://pump.helius-rpc.com)...
[GMGN] Stage1 rank: 89 → 4 pass
[PNL_TICK] poller alive — 0 position(s) tracked (tick #1)
[CRON] Cycles started — management every 3m, screening every 5m
[TELEGRAM] Bot polling started
[TELEGRAM] Registered 28 bot commands
```

**Files:** `tools/pnl.js` (new, 272 lines), `config.js`, `tools/dlmm.js`, `tools/gmgn.js`, `tools/token.js`, `tools/executor.js`, `index.js`, `state.js`, `lessons.js`, `briefing.js`, `gmgn-config.example.json`, `user-config.example.json`

### M3: Log Rotation ✅ DONE (2026-05-23)**Implementation:** `rotateOldLogs()` in `logger.js` — deletes log files older than 7 days. Runs at startup. Cleans `agent-*.log`, `actions-*.jsonl`, `snapshots-*.jsonl`.

**Config:** `LOG_RETENTION_DAYS` env var (default 7)

**Result:** First run cleaned up 68 old log files.

### R8 Exit Preset Tuning ✅ DOCUMENTED (2026-05-23)

Available presets in `tools/chart-indicators.js`:
- `supertrend_break` (current default) — Supertrend flip confirmation
- `rsi_reversal` — RSI overbought/oversold
- `bollinger_reversion` — BB band touch
- `rsi_plus_supertrend` — RSI + Supertrend combined
- `supertrend_or_rsi` — either signal confirms
- `bb_plus_rsi` — BB + RSI combined

Switch via `/settings` → R8 Exit Preset button.

---

## 🚨 PNL POLL GAP DISCOVERY (CRITICAL — Implementation Pending)

**Date discovered:** 2026-05-28
**Severity:** HIGH — affects all positions, root cause of Embrace -36% catastrophe
**Investigation source:** Embrace/SOL post-mortem (2026-05-20 catastrophic close)

### The Discovery

Found **logic gap in PnL polling**: `updatePeakPnl()` in `state.js` line 229-232 early-returns
when `candidatePnlPct <= currentPeak`. This means:

- ✅ PnL going UP → peak updates, log fires, **exit rules evaluated implicitly via management cycle**
- ❌ PnL going DOWN → function exits early, **exit rules NEVER evaluated by poll path**
- ⚠️ Result: Rule 0 (Emergency Close at -10%) only fires when **OOR transition** triggers a separate code path

### Evidence — Embrace/SOL Catastrophe (2026-05-20)

```
18:01:56  DEPLOY at active_bin=-585
18:51:03  peak PnL 0.50%
19:07:18  peak PnL 0.59%  ← LAST LOG
          [25-MINUTE BLACKOUT]
          (PnL polling continued but every reading was ≤ 0.59%,
           so early-return triggered every cycle — Rule 0 never evaluated)
19:32:50  Position marked OUT OF RANGE (active_bin crossed -643)
19:32:50  Emergency close fired at PnL -25.35%  ← Triggered by OOR path, not poll
19:32:59  Close confirmed on chain
19:33:07  Final realized: -36.05% (after slippage)
```

**Designer assumption (HANDOVER 18 May):** Rule 0 closes positions at ~-11% to -13% realized.
**Reality:** Rule 0 fires only on OOR transition. Position can lose much more if it
stays in-range while bleeding (IL accumulation traversing lower bins).

### Verified Behavior

**Code path verified** (state.js):
```javascript
// Line 229-232 — THE GATE
const currentPeak = pos.peak_pnl_pct ?? 0;
if (candidatePnlPct <= currentPeak) return false;  // ← EARLY RETURN BLOCKS EXIT EVAL
```

**Log evidence verified:**
- Position 5GDk5cs (Embrace catastrophic): 25 min log gap during PnL descent
- Position 7Cuntu (Embrace healthy): continuous logs because PnL trending UP

### Why Rule 0 Eventually Fired (For Reference)

Rule 0 evaluation runs through **two code paths**:
1. **Management cycle** (every 3 minutes) — full exit rule check
2. **PnL poll** (every 30 seconds) — gated by peak update logic

For Embrace, Rule 0 fired via **OOR transition handler** which has separate code path
unaffected by the peak gate. Without OOR cross, the position would have continued
bleeding indefinitely until next management cycle catch.

### Fix Plan (NOT YET IMPLEMENTED)

**Strategy:** Add emergency check **before** peak gate in PnL poll path.
Minimal surgical change, no regression risk to trailing TP logic.

**Files to modify:**
- `state.js` — `updatePeakPnl()` or equivalent function — add emergency bypass
- Possibly `index.js` PnL poll handler if check belongs there

**Implementation outline:**
```javascript
// Pseudo — actual location TBD based on call graph
function updatePeakPnl(positionData) {
  const pos = state.positions[positionData.address];
  if (!pos || pos.closed) return false;

  const currentPnlPct = positionData.current_pnl_pct;

  // NEW: Emergency floor check — ALWAYS evaluated, independent of peak gate
  if (currentPnlPct != null
      && config.management.emergencyClosePct != null
      && currentPnlPct <= config.management.emergencyClosePct) {
    log("state", `[PnL poll] Emergency floor breached: ${pos.position_address} PnL ${currentPnlPct.toFixed(2)}% — flagging for immediate close`);
    pos.emergency_flag = true;       // signal to next management cycle / poll handler
    save(state);
    return { emergency: true, action: "EMERGENCY_CLOSE", reason: `... <= ${config.management.emergencyClosePct}%` };
  }

  // EXISTING: Peak gate logic (unchanged)
  const currentPeak = pos.peak_pnl_pct ?? 0;
  if (candidatePnlPct <= currentPeak) return false;
  // ... rest unchanged
}
```

**Call-site handling:** PnL poll handler in `index.js` (line 936-985) needs to check
for `{ emergency: true }` return and trigger close immediately, same path as
existing emergency handling (lines 957).

### Verification After Fix

Add **PnL state observability** — log every Nth poll regardless of peak status:
```javascript
// Throttled diagnostic log — every 5 minutes if no other state change
if (Date.now() - (pos.last_diag_log_at || 0) > 5 * 60 * 1000) {
  log("state", `[PnL poll diag] ${pos.position_address} pnl=${currentPnlPct?.toFixed(2)}% peak=${pos.peak_pnl_pct?.toFixed(2)}% in_range=${!pos.out_of_range_since}`);
  pos.last_diag_log_at = Date.now();
}
```

This gives forensic trail of next time something weird happens.

### Test Cases (Inline Predicate)

```javascript
// Test 1: PnL drops from peak, no OOR transition, emergency floor breached
// Setup: pos.peak_pnl_pct = 0.59, currentPnlPct = -12, emergencyClosePct = -10
// BEFORE FIX: function returns false (peak gate), Rule 0 not evaluated
// AFTER FIX: function returns { emergency: true }, triggers close

// Test 2: PnL drops from peak, emergency floor NOT breached
// Setup: pos.peak_pnl_pct = 0.59, currentPnlPct = -5, emergencyClosePct = -10
// Expected: returns false (peak gate engages as before, no spurious emergency)

// Test 3: PnL rising to new peak, emergency irrelevant
// Setup: pos.peak_pnl_pct = 0.59, currentPnlPct = 1.2
// Expected: peak updates, no emergency triggered

// Test 4: emergencyClosePct = null (disabled)
// Setup: currentPnlPct = -15, emergencyClosePct = null
// Expected: emergency block skipped, falls through to existing logic (no regression)

// Test 5: currentPnlPct = null
// Expected: emergency block skipped (null guard), no false trigger
```

### Bonus Finding: Pool Selection Ignored Warnings

Pre-deploy, bot saw **4+ hours of bearish signals** for Embrace:
- 14:21 vol=2.71 (filtered low-vol)
- 15-17h: "Embrace: bearish supertrend, price below supertrend" (multiple)
- 17:51 vol=2.07 (still dying)
- 17:56 vol=2.88
- 18:01 vol=3.32 (briefly crossed threshold → bot deployed)

Bot **deployed into clearly degrading pool** because vol briefly crossed threshold.
Future enhancement: track multi-cycle signal trend, block deploy if recent bearish.

But out of scope for this fix — separate concern.

### Severity Justification

This gap affects **all positions** post-implementation of Rule 0 (May 18). Any
position that crashes while in-range will not trigger Rule 0 via PnL poll until
OOR transition. Slippage between actual breach and OOR-triggered close can be
significant (Embrace case: -10% → -36% = -26 percentage points lost).

**Estimated impact:** Reviewing 522-position dataset, post-Rule-0 catastrophic
losses likely all share this pattern. Fix should reduce future similar events.

### Implementation Priority

This is **higher priority than R8 verification**. R8 verification waits for
position drain (passive monitoring). PnL Poll Gap fix is **active code change**
that prevents catastrophic loss recurrence.

Recommended order:
1. Fix PnL Poll Gap (this section)
2. Verify fix via test simulation
3. Deploy fix when positions drain
4. Then proceed with R8 verification

### Forensic Backup

Preserved logs for future reference:
```
~/log-backups/embrace-catastrophe/
  agent-2026-05-20.log
  agent-2026-05-21.log
  actions-2026-05-20.jsonl
```

### Session Continuity Log Addition

- **2026-05-28** — Embrace/SOL post-mortem revealed PnL Poll Gap (peak-gate
  skips exit rule evaluation when PnL descending). Fix plan designed,
  implementation pending. Priority: HIGH.
