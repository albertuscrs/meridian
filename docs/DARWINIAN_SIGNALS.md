# Darwinian Signal Weighting System

## Overview

The Darwinian signal weighting system learns which screening signals actually predict
profitable positions and adjusts their weights over time. Signals that consistently
appear in winners get boosted; those associated with losers get decayed.

Weights are persisted in `signal-weights.json` and injected into the LLM prompt so
the screener agent can prioritize the right screening criteria.

---

## Signals Tracked

| Signal | Type | Higher = Better | Source |
|--------|------|-----------------|--------|
| `organic_score` | numeric | ✅ | Meteora pool data |
| `fee_tvl_ratio` | numeric | ✅ | Meteora pool data |
| `volume` | numeric | ✅ | Meteora pool data |
| `mcap` | numeric | ❌ | Token info |
| `holder_count` | numeric | ✅ | Token info |
| `smart_wallets_present` | boolean | win rate comparison | Smart wallets check |
| `narrative_quality` | categorical | win rate comparison | LLM-generated |
| `study_win_rate` | numeric | ✅ | LPAgent study data |
| `hive_consensus` | numeric | ✅ | HiveMind server |
| `volatility` | numeric | ❌ | Meteora pool data |

---

## How It Works

### Signal Staging (at screening time)

During `runScreeningCycle` (index.js:665), signals are captured for each candidate pool
and staged in an in-memory Map via `stageSignals()` (signal-tracker.js:24). The staged
signals include the pool's organic_score, fee_tvl_ratio, volume, mcap, holder_count,
smart_wallets_present, narrative_quality, and volatility at the time the LLM decides.

### Signal Storage (at deploy time)

When `deploy_position` fires, `trackPosition()` (state.js:56) stores the position in
state.json. The `signal_snapshot` field should capture the staged signals for later
analysis. This enables post-hoc analysis: which signals were present when the decision
was made, and did they predict a win or loss?

### Weight Recalculation (at close time)

After every 5th position close (triggered from lessons.js:184), `recalculateWeights()`
(signal-weights.js:94) runs:

1. Filter performance records to rolling window (default: 60 days)
2. Classify wins (pnl_usd > 0) and losses (pnl_usd <= 0)
3. Compute "lift" for each signal — how predictive is it of wins vs losses?
4. Split signals into quartiles by lift
5. Top quartile: multiply weight by `boostFactor` (default 1.05)
6. Bottom quartile: multiply weight by `decayFactor` (default 0.95)
7. Clamp weights to [weightFloor, weightCeiling] (default [0.3, 2.5])
8. Persist to `signal-weights.json`

### Lift Computation

Three lift algorithms depending on signal type:

- **Numeric** (`computeNumericLift`): Normalize win/loss values to [0,1], compare mean
  of wins vs mean of losses. Positive lift = signal is predictive of wins.
- **Boolean** (`computeBooleanLift`): Compare win rate when signal is present vs absent.
  E.g., if pools with smart_wallets_present win 70% of the time vs 40% without, lift = 0.3.
- **Categorical** (`computeCategoricalLift`): Compare win rate across categories.
  E.g., if "present" narrative wins 65% vs "absent" wins 35%, lift = 0.3.

### Prompt Injection

`getWeightsSummary()` (signal-weights.js:284) generates a formatted block injected
into the LLM prompt by `buildSystemPrompt()` (prompt.js:33). The prompt instructs the
screener agent to "Prioritize candidates whose strongest attributes align with
high-weight signals" (prompt.js:138).

---

## Configuration

All tuning parameters are under `config.darwin` (config.js:222-232):

| Field | Default | Purpose |
|-------|---------|---------|
| `darwinEnabled` | `true` | Master switch |
| `darwinWindowDays` | `60` | Rolling window for win/loss classification |
| `darwinRecalcEvery` | `5` | Recalculate every N closes |
| `darwinBoost` | `1.05` | Multiplier for top-quartile signals |
| `darwinDecay` | `0.95` | Multiplier for bottom-quartile signals |
| `darwinFloor` | `0.3` | Minimum weight (prevents signals from being zeroed out) |
| `darwinCeiling` | `2.5` | Maximum weight (prevents over-reliance on one signal) |
| `darwinMinSamples` | `10` | Minimum records before recalculating |

Configurable via `setup.js` (Darwin section) or `user-config.json` `darwin` key.

---

## Files

| File | Role |
|------|------|
| `signal-weights.js` | Core algorithm — lift computation, quartile splitting, weight adjustment, prompt formatting |
| `signal-tracker.js` | Signal staging — stage during screening, retrieve on deploy |
| `signal-weights.json` | Persistence — weights, recalc history |
| `lessons.js:192-199` | Trigger — calls `recalculateWeights()` every `darwinRecalcEvery` closes |
| `index.js:665-676` | Stage — calls `stageSignals()` during screening |
| `index.js:682` | Inject — calls `getWeightsSummary()` for LLM prompt |
| `config.js:222-232` | Config — all darwin tuning parameters |

---

## ⚠️ Known Issue: Broken Feedback Loop (as of 2026-05-05)

**Status:** BROKEN — signal_snapshot is never populated on positions or performance records.

**Root cause:** `stageSignals()` is called during screening (index.js:672) and stores
signals in an in-memory Map. But `trackPosition()` (called from dlmm.js:776 and dlmm.js:910)
never calls `getAndClearStagedSignals()` to retrieve them. The staged signals expire
after 10 minutes (`STAGE_TTL_MS` in signal-tracker.js:16) and are garbage-collected.

**Evidence:**
- `signal_snapshot` appears 0 times in `lessons.json`
- `signal_snapshot` appears 427 times in `state.json` — ALL are `null`
- `signal-weights.json`: all weights are 1.0, `last_recalc: null`, `recalc_count: 0`
- `getAndClearStagedSignals()` is defined (signal-tracker.js:43) but never imported or called from any other file

**Impact:** The entire Darwinian weighting system is inert. Weights never change from
defaults. The LLM prompt always shows "Weights have not been recalculated yet."

**Fix:** In `dlmm.js`, both `trackPosition()` call sites need to:
1. Import `getAndClearStagedSignals` from `signal-tracker.js`
2. Call `getAndClearStagedSignals(pool_address)` before `trackPosition()`
3. Pass the result as `signal_snapshot` to `trackPosition()`
4. Also pass `signal_snapshot` to `recordPerformance()` so it persists to `lessons.json`

---

## Decision Log

### Why quartile splitting instead of continuous adjustment?
Quartile splitting is more robust to outliers. A signal with extreme lift in one
direction won't get an extreme boost — it gets the same boost as the 2nd-best signal
in the top quartile. This prevents runaway weights.

### Why a rolling window instead of all-time?
Market conditions change. A signal that predicted wins in a bull market may not work
in a bear market. The 60-day window ensures the system adapts to recent conditions.

### Why separate floor and ceiling?
Floor prevents signals from being zeroed out entirely (they might become predictive
again). Ceiling prevents over-reliance on one signal (diversification heuristic).
