# Meridian — CLAUDE.md

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

---

## Architecture Overview

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop (OpenRouter/OpenAI-compatible): LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env; exposes config object
prompt.js           Builds system prompt per agent role (SCREENER / MANAGER / GENERAL)
state.js            Position registry (state.json): tracks bin ranges, OOR timestamps, notes
lessons.js          Learning engine: records closed-position perf, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots (pool-memory.json)
strategy-library.js Saved LP strategies (strategy-library.json)
briefing.js         Daily Telegram briefing (HTML)
telegram.js         Telegram bot: polling, notifications (deploy/close/swap/OOR)
hive-mind.js        Optional collective intelligence server sync
smart-wallets.js    KOL/alpha wallet tracker (smart-wallets.json)
token-blacklist.js  Permanent token blacklist (token-blacklist.json)
logger.js           Daily-rotating log files + action audit trail

tools/
  definitions.js    Tool schemas in OpenAI format (what LLM sees)
  executor.js       Tool dispatch: name → fn, safety checks, pre/post hooks
  dlmm.js           Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.js      Pool discovery from Meteora API
  wallet.js         SOL/token balances (Helius) + Jupiter swap
  token.js          Token info/holders/narrative (Jupiter API)
  study.js          Top LPer study via LPAgent API
```

---

## Agent Roles & Tool Access

Three agent roles filter which tools the LLM can call:

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | deploy_position, get_top_candidates, get_token_holders, check_smart_wallets_on_pool |
| `MANAGER` | Manage open positions | close_position, claim_fees, swap_token, get_position_pnl, set_position_note |
| `GENERAL` | Chat / manual commands | All tools |

Sets defined in `agent.js:6-7`. If you add a tool, also add it to the relevant set(s).

---

## Adding a New Tool

1. **`tools/definitions.js`** — Add OpenAI-format schema object to the `tools` array
2. **`tools/executor.js`** — Add `tool_name: functionImpl` to `toolMap`
3. **`agent.js`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS` if role-restricted
4. If the tool writes on-chain state, add it to `WRITE_TOOLS` in executor.js for safety checks

---

## Config System

`config.js` loads `user-config.json` at startup. Runtime mutations go through `update_config` tool (executor.js) which:
- Updates the live `config` object immediately
- Persists to `user-config.json`
- Restarts cron jobs if intervals changed

**Valid config keys and their sections:**

| Key | Section | Default |
|-----|---------|---------|
| minFeeActiveTvlRatio | screening | 0.05 |
| minTvl / maxTvl | screening | 10k / 150k |
| minVolume | screening | 500 |
| minOrganic | screening | 60 |
| minHolders | screening | 500 |
| minMcap / maxMcap | screening | 150k / 10M |
| minBinStep / maxBinStep | screening | 80 / 125 |
| timeframe | screening | "5m" |
| category | screening | "trending" |
| minTokenFeesSol | screening | 30 |
| maxBundlersPct | screening | 30 |
| maxTop10Pct | screening | 60 |
| blockedLaunchpads | screening | [] |
| deployAmountSol | management | 0.5 |
| maxDeployAmount | risk | 50 |
| maxPositions | risk | 3 |
| gasReserve | management | 0.2 |
| positionSizePct | management | 0.35 |
| minSolToOpen | management | 0.55 |
| outOfRangeWaitMinutes | management | 30 |
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | 30 |
| managementModel / screeningModel / generalModel | llm | openrouter/healer-alpha |

**`computeDeployAmount(walletSol)`** — scales position size with wallet balance (compounding). Formula: `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)`.

---

## Position Lifecycle

1. **Deploy**: `deploy_position` → executor safety checks → `trackPosition()` in state.js → Telegram notify
2. **Monitor**: management cron → `getMyPositions()` → `getPositionPnl()` → OOR detection → pool-memory snapshots
3. **Close**: `close_position` → `recordPerformance()` in lessons.js → auto-swap base token to SOL → Telegram notify
4. **Learn**: `evolveThresholds()` runs on performance data → updates config.screening → persists to user-config.json

---

## Screener Safety Checks (executor.js)

Before `deploy_position` executes:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- Position count must be below `maxPositions` (force-fresh scan, no cache)
- No duplicate pool allowed (same pool_address)
- No duplicate base token allowed (same base_mint in another pool)
- Deploy amount must include positive SOL (`amount_y` or `amount_sol`)
- Range width must be at least the configured safe bins floor (`minBinsBelow`, never below 35)
- Single-side SOL deploys must keep `bins_above=0`
- SOL balance must cover `amount_y + gasReserve`
- `blockedLaunchpads` enforced in `getTopCandidates()` before LLM sees candidates

---

## bins_below / bins_above (SCREENER)

`bins_below` — linear formula based on pool volatility (set in screener prompt, `index.js`). The lower/upper bounds are configurable, with a hard safety floor of 35 bins:

```
bins_below = round(minBinsBelow + (volatility / 5) * (maxBinsBelow - minBinsBelow))
clamped to [minBinsBelow, maxBinsBelow]
```

- Volatility must be finite and > 0; zero/missing volatility is treated as an unusable feed
- Low valid volatility → minBinsBelow
- High volatility (5+) → maxBinsBelow
- Any value in between is valid (continuous, not tiered)

`bins_above` — fixed config value (`config.strategy.binsAbove`, default 20). For single-sided SOL deploys
the Meteora protocol requires `upper_bin = active_bin`, so `bins_above` does NOT widen the on-chain LP range.
Instead it is stored in state (`bin_range.bins_above`) and used by Rule 3 in `getDeterministicCloseRule` to
add tolerance before triggering an immediate pump-close:

```
Rule 3 fires when: active_bin > upper_bin + outOfRangeBinsToClose + bin_range.bins_above
```

Default (outOfRangeBinsToClose=8, binsAbove=20): Rule 3 fires after a ~28-bin pump vs the old 8-bin trigger.
Positions survive moderate pumps and can resume earning fees when price returns into range.

---

## Telegram Commands

Handled directly in `index.js` (bypass LLM):

| Command | Action |
|---------|--------|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set note on position by list index |

Progress bar format: `[████████░░░░░░░░░░░░] 40%` (no bin numbers, no arrows)

---

## Race Condition: Double Deploy

`_screeningLastTriggered` in index.js prevents concurrent screener invocations. Management cycle sets this before triggering screener. Also, `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh count.

---

## Bundler Detection (token.js)

Two signals used in `getTokenHolders()`:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds in config**: `maxBundlersPct` (default 30%), `maxTop10Pct` (default 60%)
Jupiter audit API: `botHoldersPercentage` (5–25% is normal for legitimate tokens)

---

## Base Fee Calculation (dlmm.js)

Read from pool object at deploy time:
```js
const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

---

## Model Configuration

- Default model: `process.env.LLM_MODEL` or `openrouter/healer-alpha`
- Fallback on 502/503/529: `stepfun/step-3.5-flash:free` (2nd attempt), then retry
- Per-role models: `managementModel`, `screeningModel`, `generalModel` in user-config.json
- LM Studio: set `LLM_BASE_URL=http://localhost:1234/v1` and `LLM_API_KEY=lm-studio`
- `maxOutputTokens` minimum: 2048 (free models may have lower limits causing empty responses)

---

## Lessons System

`lessons.js` records closed position performance and auto-derives lessons. Key points:
- `getLessonsForPrompt({ agentType })` — injects relevant lessons into system prompt
- `evolveThresholds()` — adjusts screening thresholds based on winners vs losers
- Performance recorded via `recordPerformance()` called from executor.js after `close_position`
- `evolveThresholds()` adjusts both `maxVolatility` (`config.screening.maxVolatility`) and `minFeeActiveTvlRatio` (`config.screening.minFeeActiveTvlRatio`) — both keys are correct and evolution is functional

---

## Pool Cooldown System (pool-cooldown.js)

After each position close, `evaluateAndSetCooldown()` determines appropriate cooldown periods based on the close reason and PnL severity. Cooldowns prevent re-deployment to poorly performing pools/tokens.

**Close reasons and their default cooldowns:**

| Reason | Cooldown | Description |
|--------|----------|-------------|
| `low yield` | 4h | Insufficient fee generation |
| `stop loss` | 2h | Hit stop-loss trigger |
| `loss > 1%` | 1h | Manual close at loss >1% (not stop loss) |
| `oor big loss` | 6h | OOR close + pnlUsd < oorBigLossPnlThreshold (-$2) |
| `cumulative loss > $5` | 48h | Total pool loss across all deploys exceeds threshold |
| `oor` (repeated) | 12h | 3+ OOR closes in succession |
| `manual` | 1h | User-initiated close |
| `trailing tp` / `take profit` | 1-2h | Successful exits |

**Key rules:**
- When multiple cooldowns apply, the **longest duration wins**
- Stop loss, OOR big loss, and cumulative loss > $5 trigger **base-mint cooldowns** (applies to all pools using that token)
- OOR big loss threshold: `oorBigLossPnlThreshold` (default -$2)
- Cumulative loss = sum of all `pnlUsd` in pool's deploy history + new close's `pnlUsd`; threshold is `cumulativeLossThreshold` (default -$5)
- Loss > 1% cooldown triggers only for manual/user-requested closes with pnlPct < -1% (and NOT stop loss)

**New config keys (management section):**

| Key | Default |
|-----|---------|
| lowYieldCooldownHours | 4 |
| stopLossCooldownHours | 2 |
| lossGt1PctCooldownHours | 1 |
| oorBigLossCooldownHours | 6 |
| oorBigLossPnlThreshold | -2 |
| cumulativeLossCooldownHours | 48 |
| cumulativeLossThreshold | -5 |

---

## Hive Mind (hive-mind.js)

Optional feature. Enabled by setting `HIVE_MIND_URL` and `HIVE_MIND_API_KEY` in `.env`.
Syncs lessons/deploys to a shared server, queries consensus patterns.
Not required for normal operation.

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON array private key |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes | LLM API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `LLM_BASE_URL` | No | Override for local LLM (e.g. LM Studio) |
| `LLM_MODEL` | No | Override default model |
| `DRY_RUN` | No | Skip all on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |

---

## Close Profile System

Three behavioral profiles for close rules, set via `config.management.closeProfile`:

| Profile | R4 OOR | R7 Safety-Lock | R8 Indicator | Rule 0 Emergency |
|---------|--------|----------------|--------------|------------------|
| `main` | Time-based (35m above / 8m below) | No | No | Yes (all profiles) |
| `pecut` | Time-based + Safety-Lock | Yes | No | Yes |
| `experimental` | Time-based + Safety-Lock + R8 | Yes | Yes | Yes |

**Active in production:** `experimental` (since 2026-05-12)

**Rule 0 Emergency Close** (`config.management.emergencyClosePct`, default -10): Hard override at catastrophic PnL threshold. Fires BEFORE all other rules — bypasses Safety-Lock, R8, trailing, and cooldown entirely. Log marker: `[STATE] Emergency close:`. Configurable via `/settings` Risk page.

**R7 Safety-Lock** (`pecut` + `experimental`): if OOR timeout reached but `pnl_pct ≤ 0`, hold instead of close. Log marker: `[STATE] Safety-Lock:`

**R8 Indicator-Aware OOR** (`experimental` only): pre-fetches chart indicators before closing OOR positions. If `confirmIndicatorPreset()` returns `confirmed: false`, hold. Fail-open: API unavailable → close normally (never blocks on error).
- Config: `r8IndicatorCheck` (toggle), `r8ExitPreset` (preset name), `r8OorCooldownHours`
- Gate order: OOR timeout → trailingArmed? → R7 Safety-Lock → R8 → OUT_OF_RANGE
- Rule 0 Emergency fires BEFORE everything (even before R1 Stop Loss)

**R4.1 Trailing TP** (all profiles): state.js Rule 2 always returns `{ action: "TRAILING_TP_QUEUED" }` — callers schedule timer-based confirmation (3s pecut / 15s main+experimental). Never instant-close.

---

## Darwinian Signal Wiring (F1 — FIXED 2026-05-17)

`getAndClearStagedSignals()` (signal-tracker.js) is now called from `tools/dlmm.js` at both `trackPosition()` call sites. Signal snapshots are stored in state.json + lessons.json and feed the Darwinian weight evolution loop.

`signal-tracker.js` supports dual-index lookup: by `poolAddress` (primary) or `baseMint` (fallback, for cases where deploy pool address differs from screened pool).

---

## Regression Tests

`test/regression-test.js` — 35 inline unit tests covering all custom R-implementations.
Run: `node test/regression-test.js`

| Test group | Cases | What it covers |
|------------|-------|----------------|
| R1 Stop Loss | 4 | threshold boundary, suspicious pnl bypass |
| R2/R4.1 Trailing TP | 4 | always queued, not instant-close |
| R7 Safety-Lock | 7 | pecut+experimental, above+below, pnl=0 edge, main no-lock |
| R8 Indicator-Aware | 6 | hold/close/fail-open/profile guard/trailing bypass |
| R5 Low Yield | 4 | age gate, custom minAgeBeforeYieldCheck |
| F1 signal-tracker | 7 | pool lookup, base_mint fallback, clear-after-retrieval |

Also: `test/pool-cooldown-test.js` (6 cooldown scenarios), `test/test-solmode-pnl.js` (SOL mode PnL).

---

## Known Issues / Tech Debt

- `get_wallet_positions` tool (dlmm.js) is in definitions.js but not in MANAGER_TOOLS or SCREENER_TOOLS — only available in GENERAL role.

## Recent Additions (May 2026)

### API Monitoring (`tools/api-monitor.js`)
Telegram `/status` subcommands check health of all external APIs:
- `/status apis` — all APIs (relay, hivemind, gmgn, jupiter, meteora, rpc)
- `/status relay|hivemind|gmgn|jupiter|meteora|rpc` — individual checks
Each shows ✅/❌ status, HTTP code, latency, error details.

### Consumer LLM Clients (`agent.js`)
Three-tier client architecture for LLM routing:
- `client` (global): MiniMax API for management/general
- `getScreeningClient()`: Xiaomi endpoint for screening (mimo-v2.5)
- `getFallbackClient()`: OpenRouter for fallback (stepfun/step-3.5-flash:free)
Config: `screeningBaseUrl`, `screeningApiKey`, `fallbackBaseUrl`, `fallbackApiKey`, `fallbackModel`.

### Swap Retry (`tools/wallet.js`)
Swap retries up to 5x with escalating slippage (0.5%→10%).
Telegram notification on exhaustion via `notifySwapFailure()`.

### Launchpad Filtering for GMGN (`tools/gmgn.js`)
GMGN screening pipeline now filters `blockedLaunchpads` at Stage 2.
Previously only Meteora pipeline had this filter.

### Screening Cooldown (`index.js`)
Management cycle respects `screeningIntervalMin` when triggering screening on no-position.
No longer spams screening every 3 minutes when no positions open.
