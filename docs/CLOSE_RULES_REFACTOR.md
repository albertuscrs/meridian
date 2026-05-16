# Close Rules Refactor — Implementation Status
## Overview
Meridian has 5 close rules. The original spec called for three behavioral variants
(Main / Pecut / Experimental) applied per-rule. Before R1, only "Main" behavior existed
for all positions regardless of profile setting.
This document tracks the implementation status of the variant system and the architectural
decisions behind it.
---
## Rule / Profile Matrix
| Rule | Main (default) | Pecut | Experimental |
|------|----------------|-------|--------------|
| **R1: Stop Loss** | Hard floor: PnL ≤ stopLossPct → close | LLM-eval path (R3, not impl) | Same as pecut |
| **R2: Take Profit** | PnL ≥ takeProfitPct → close | 3s confirm window (R4 ✅, R4.1 ✅) | Same as pecut + indicator validation |
| **R3: Pump Above** | active_bin > upper_bin + binsToClose + binsAbove → close | minProfitPctToCloseOOR gate ✅ (R5) | PVP rivalry check (R6, not impl) |
| **R4: OOR Stale** | state.js: OOR above 35m / below 8m → close | Safety-Lock: hold if pnl≤0 at timeout ✅ (R7) | Indicator-Aware: RSI/ST check before close ✅ (R8, impl, Phase H pending) |
| **R5: Low Yield** | fee/TVL < minFeePerTvl24h after minAge → close | Same (matured yield 60min min) | Same |
---
## Production Status (as of 2026-05-13)
| Rule | Profile | Status | Production verified |
|------|---------|--------|---------------------|
| R1 (Stop Loss) | All | ✅ Hard floor active | Yes (pre-refactor baseline) |
| R2 (Trailing TP) | Main | ✅ 15s confirm window | Yes |
| R2 (Trailing TP) | Pecut | ✅ 3s confirm window | Yes (2026-05-07: 3 fires + 2 fakeout rejects) |
| R3 (Pump Above) | Main | ✅ Instant close | Yes |
| R3 (Pump Above) | Pecut | ✅ minProfitPct gate | Yes (2026-05-06: 17 hold events observed) |
| R4 (OOR Stale) | Main | ✅ Time-based (35m/8m) | Yes |
| R4 (OOR Stale) | Pecut | ✅ Safety-Lock | Yes (2026-05-05: lock-in success) |
| R4 (OOR Stale) | Experimental | ✅ R8 Indicator-Aware (fail-open) | Yes (2026-05-12: commit b022962) |
| R5 (Low Yield) | All | ✅ Configurable age (R9 fix) | Yes (R9 fix verified) |
| R10 cleanup | All | ✅ Single OOR engine | Yes (2026-05-05: trailing-armed OOR) |
| R4.1 patch | All | ✅ Single trailing TP path | Yes (2026-05-07: 3 confirms + 2 rejects) |

Active profile in production: **experimental** (since 2026-05-12 00:16 UTC)
Default profile for new deployments: **main**
R8 production verification: **✅ Phase H complete — GREEN verdict 2026-05-17** (see HANDOVER.md)

---
## Implementation Status
### ✅ R1+R2: closeProfile Foundation (DONE)
- `config.management.closeProfile` ("main"|"pecut"|"experimental"), default "main"
- Wired: config.js:194 → executor.js CONFIG_MAP:210 → Telegram risk page (index.js:1222-1224)
- Both close engines read `profile` and include it in return objects
- Profile now branches behavior for R2 (confirm window), R3 (profit gate), R4 (Safety-Lock)
- Bug fix R9: `minAgeBeforeYieldCheck` (was hardcoded 60) now configurable in both engines
### ✅ R10: OOR Engine Consolidation (DONE)
- state.js is single source of truth for Rule 4 (OOR Stale)
- Rule 4 REMOVED from getDeterministicCloseRule (index.js:954-956 pointer comment)
- Trailing-armed immediate-close ported to state.js:470-494 (above AND below directions)
- Trailing armed: `oorLimit = 0` (immediate close); non-armed: `oorLimit = outOfRangeWaitMinutes` (35m above) or `outOfRangeBelowWaitMinutes` (8m below)
- `exitMap` short-circuits getDeterministicCloseRule when exit found — dead code stays dead
### ✅ R7: Safety-Lock (pecut OOR hold if unprofitable)
- Location: state.js Rule 4 block (line 465)
- Condition: profile === "pecut" && pnl_pct ≤ 0 && OOR timeout reached → STAY instead of OUT_OF_RANGE
- Config field: none needed (hardcoded behavior)
### ✅ R5: minProfitPctToCloseOOR (pecut Rule 3 profit gate)
- Location: index.js getDeterministicCloseRule Rule 3 block (line 946)
- Condition: profile === "pecut" && pnl_pct < minProfitPctToCloseOOR → don't close on pump
- Config: `minProfitPctToCloseOOR` (management section, default 0)
### ✅ R4: 3s Trailing TP Confirm (pecut)
- Location: index.js:87 (TRAILING_DROP_CONFIRM_DELAY_MS_PECUT=3000), scheduleTrailingDropConfirmation reads profile
- profile === "pecut" → 3000ms confirm window; else → 15000ms
- **R4.1 patch (2026-05-07):** Fixed second trailing TP path in state.js Rule 2 that was firing instantly,
  bypassing the confirmation window when position was OOR (`needs_confirmation = in_range !== false` bug).
  Approach A: state.js Rule 2 now calls queueTrailingDropConfirmation internally and returns
  `{ action: "TRAILING_TP_QUEUED" }` — callers (management cycle + PnL poll) call scheduleTrailingDropConfirmation
  unconditionally. No shouldUsePnlRecheck() guard on trailing TP path. All trailing TP exits now routed through
  timer-based confirmation (3s pecut / 15s main+experimental), including OOR+trailing-armed scenario.
- **Production verification (2026-05-07):**
  - 3 trailing TP closes successfully routed through 3000ms confirmation window
    (positions 2LrsS5mY..., 7FBkMeD9..., GgofUrUgq...)
  - 2 fakeout rejections caught by confirmation window — saved positions from premature close
    (CUcr5H3w... at 12:00:14, GgofUrUgq... at 15:28:51)
  - 2 trailing-armed OOR closes processed via confirmation window (no instant-close bypass)
  - 0 errors in trailing TP path
  - **Confirms: pecut profile feature-complete per spec**
### ✅ R8: Indicator-Aware OOR Close (experimental) — DONE
- **Commit:** `b022962` (2026-05-12)
- Location: state.js Rule 4 block (lines 469-501) — both above and below OOR directions
- Condition: profile === "experimental" && !trailingArmed → pre-fetch indicator via `confirmIndicatorPreset()` (chart-indicators.js) → hold if not confirmed, close if confirmed
- Pre-fetch in management cycle: index.js fetches indicator data before LLM loop; stored in `indicatorData` Map keyed by position address
- Config fields: `r8IndicatorCheck` (toggle), `r8ExitPreset` (preset name), `r8OorCooldownHours` (cooldown on eventual close)
- Fail-open: API unavailable → close normally (R8 gate only holds on explicit `confirmed: false`)
- Gate order: OOR timeout → trailingArmed? → Safety-Lock (R7) → R8 → OUT_OF_RANGE
- Status: implemented, committed. Phase H production verification pending.
### 🔲 R3: LLM-Eval Stop-Loss (pecut/experimental)
- Location: index.js getDeterministicCloseRule Rule 1 block (line 930)
- Condition: profile !== "main" && PnL at stop-loss threshold → call LLM to evaluate before closing
- Requires: fallback behavior if LLM fails/times out (recommend: fall through to main = close immediately)
### 🔲 R6: HiveMind Sync at Close (experimental)
- Location: Both engines before returning CLOSE action
- Condition: profile === "experimental" → query HiveMind for consensus action before close
- Requires: server-side contract definition for what HiveMind returns
---
## Architecture Notes
### Two-Engine Design
runManagementCycle / PnL poll
  │
  ├── updatePnlAndCheckExits (state.js) ← OOR state, trailing TP state, Rule 1, Rule 2, Rule 4, Rule 5
  │     └── exitMap (Map<positionAddress, reason>)
  │
  └── getDeterministicCloseRule (index.js) ← Rule 1, Rule 2, Rule 3, Rule 5 (Rule 4 delegated to state.js)
        └── actionMap (prioritized: exitMap → INSTRUCTION → deterministic → CLAIM → STAY)
- `exitMap` from state.js is checked FIRST in actionMap building — deterministic rules only fire if no exit was found
- Both engines include `profile` in return objects for observability
- Profile branches behavior: pecut gets 3s trailing window, minProfitPct gate, Safety-Lock
### Key Files
| File | Role |
|------|------|
| `index.js:916-968` | `getDeterministicCloseRule` — Main deterministic close rules (no LLM) |
| `state.js:391-515` | `updatePnlAndCheckExits` — OOR state management, trailing TP, rules 1/2/4/5 |
| `config.js:153-195` | Management config defaults |
| `executor.js:148-387` | `update_config` CONFIG_MAP + OPERATOR_ONLY_KEYS |
| `telegram.js:138-166` | Bot command registration |
| `lessons.js` | Performance recording → lessons → Darwinian signal weights |
| `pool-cooldown.js` | Cooldown per close reason, imported dynamically by lessons.js |
### State Persistence
- `state.json`: Position registry — OOR timestamps, peak PnL, trailing state. No rotation.
- `pool-memory.json`: Per-pool deploy history — cumulative PnL, cooldown tracking. No rotation.
- `lessons.json`: Lessons + performance history. No rotation.
- All writes are synchronous — no atomic locking.
---
## Behavior Changes from R10
### Before R10
- state.js Rule 4 and index.js Rule 4 both existed
- Trailing-armed OOR close: index.js detected bin condition → LLM batch → close (opaque timing)
- OOR timeout: state.js wrote `out_of_range_since`, checked every management cycle
- First engine to fire won — threshold values were spread across two files
### After R10
- state.js is single source of truth for Rule 4
- Trailing-armed OOR close: state.js sets `oorLimit = 0` → returns OUT_OF_RANGE immediately → hard-bypass to close (no LLM)
- Rationale: speed > LLM second opinion when locking in trailing profit
- OOR timeout: above=35m (configurable), below=8m (configurable, new)
---
## Lessons Library
### Storage
- File: `./lessons.json`
- Schema: `{ lessons: [...], performance: [...] }`
- Written by: `lessons.js:recordPerformance()` (called from dlmm.js after close_position)
### Read path
prompt.js:buildSystemPrompt()
  └── lessons.js:getLessonsForPrompt()
        ├── local lessons (from lessons.json)
        └── hivemind.js:getSharedLessonsForPrompt() (server consensus)
### Close decision does NOT read lessons
- `state.js` and `index.js` close engines have zero imports from lessons.js
- Lessons are screening-time heuristics only
- Future: HiveMind could be consulted at close time (R6), but not via lessons library
---
## Decision Log
### Why hard-bypass for trailing-armed OOR?
When trailing TP is armed and price moves out of range, waiting for the LLM to confirm introduces
unnecessary latency and risk of missing the exit. The trailing TP threshold (trailingDropPct) already
acts as a confirmation — if the price dropped enough to trigger trailing TP and ALSO went OOR, the
position should close immediately via state.js → exitMap → actionMap → close.
### Why 35m above / 8m below?
Above (price pump = temporary): 35 minutes gives the price time to return to range.
Below (price dump = more concerning): 8 minutes is tighter because the position is losing value faster.
Configurable via `outOfRangeWaitMinutes` and `outOfRangeBelowWaitMinutes`.
---
## Pending Work
| Item | Risk | Prerequisite |
|------|------|-------------|
| P1: outOfRangeBelowWaitMinutes in Telegram UI | LOW | None |
| R8: Phase H production verification | LOW | R8 code is done; need 48h experimental profile run |
| R3: LLM-eval stop-loss | HIGH | Define fallback on LLM failure (likely deprioritised — see HANDOVER.md) |
| R6: HiveMind sync at close | HIGH | R8 stable 1+ week; server contract definition |
---
## Glossary
- **Main**: Default close profile — pure deterministic rules with no LLM in the path
- **Pecut**: Profile variant — tighter confirm windows, profit gates, safety-lock
- **Experimental**: Wildest variant — HiveMind sync, PVP rivalry, indicator validation
- **Safety-Lock**: (R7) Pecut-specific — hold position if OOR timeout reached but pnl_pct ≤ 0; log marker: `[STATE] Safety-Lock:`
- **Hard Floor**: (R3) Stop-loss that doesn't wait for LLM confirmation — immediate close
- **PVP Rivalry**: (R6) Check if a rival token exists with active pools; avoid closing into pumps for rival tokens
- **HiveMind**: Shared lesson/preset system across multiple Meridian agents; consensus-based
- **Darwinian Weighting**: signal-weights.js — adjusts screening signal weights based on historical win rates
- **exitMap**: In-memory Map populated by state.js updatePnlAndCheckExits, checked before deterministic rules fire
- **bins_above**: Config value stored in position state — used in Rule 3 threshold but NOT in state.js Rule 4 (known inconsistency)
- **TRAILING_TP_QUEUED**: Internal action signal returned by state.js Rule 2 when drop crosses threshold; instructs caller to schedule timer-based confirmation via scheduleTrailingDropConfirmation (introduced in R4.1)
- **Pump-Hold**: Log marker (`[CRON_WARN] Pump-Hold:`) for R5 gate activation — pump detected but position PnL < minProfitPctToCloseOOR, held instead of closed
- **Window marker**: Log fragment `(window: 3000ms)` or `(window: 15000ms)` in "Trailing recheck Confirmed" lines; identifies which profile-specific delay was applied
---

## Resolved Issues

### R4.1 — Trailing TP confirmation bypass via PnL poll path ✅ RESOLVED 2026-05-07
**Original severity:** Medium  
**Discovered:** 2026-05-05  
**Resolved:** 2026-05-07 (Approach A)

**Root cause:** `needs_confirmation = in_range !== false` in state.js Rule 2 set `needs_confirmation = false`
when position was OOR, bypassing the timer-based confirmation path entirely.

**Original evidence:**
- Position BNMoQiMTnQxvaC7w9JNjKKhgYMaGzpxau2M2TdDS6RL8 closed via Trailing TP at 2026-05-05 03:16
- No "Trailing TP confirmed" or "(window: ...ms)" log marker found
- Time from exit alert to close: 15 seconds (no confirmation delay applied)

**Fix:** state.js Rule 2 now calls `queueTrailingDropConfirmation` internally and returns
`{ action: "TRAILING_TP_QUEUED" }`. Both callers (management cycle + PnL poll) call
`scheduleTrailingDropConfirmation` unconditionally. `shouldUsePnlRecheck()` guard removed from
trailing TP path. See R4 section for full patch notes and production verification evidence.
