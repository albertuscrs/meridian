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

---

## Session Notes (2026-05-23 to 2026-06-11)

### What Was Done

**Fee Drift Detection (Tier 2)**
- Layer 1: `fee_change_pct` filter in screening + deploy (zero API cost)
- Layer 2: Cross-timeframe fee/TVL spike check (1h vs 24h) at deploy time
- 7 config keys: `feeDriftCheck`, `maxFeeDeclinePct`, `feeSpikeCheck`, `feeSpikeShortTimeframe`, `feeSpikeLongTimeframe`, `feeSpikeMaxRatio`, `feeSpikeMinShortFeeTvl`

**Config Tuning (Tier 3)**
- `stopLossCooldownHours`: 2 → 6 (prevent fast re-deploy into SL'd pools)
- `minVolatility`: null → 3.5 (reduce pump-frequency pools)

**Base-mint Blacklist on Catastrophic SL (Tier 4)**
- `pool-cooldown.js`: if SL + `pnlPct ≤ -10%` → `addToBlacklist()` permanent
- Uses same threshold as `emergencyClosePct`

**Time-of-Day Awareness (Tier 5)**
- Young tokens (<24h) blocked during risky UTC windows (00-04, 16-17)
- Config: `timeOfDayCheck`, `riskyHours`, `minTokenAgeForTimeCheck`

**PnL Poll Gap Fix (Critical)**
- Bug: `queuePeakConfirmation()` peak gate blocked Rule 0 evaluation when PnL descending
- Embrace case: +0.59% → -36% undetected for 25 minutes
- Fix: Emergency floor check BEFORE peak gate in `state.js`
- Throttled diagnostic log (5 min/position) for forensic trail

**Performance Dashboard**
- `/performance` command: 24h/7d/30d/all-time stats
- Shows: win rate, PnL, fees, best/worst pools, close reason breakdown

**Log Rotation**
- `rotateOldLogs()` at startup, 7-day retention (`LOG_RETENTION_DAYS`)
- Cleans `agent-*.log`, `actions-*.jsonl`, `snapshots-*.jsonl`

**GMGN Settings Reorganization**
- GMGN page: volume/size filters (mcap, volume, holders)
- Safety page: 10 anti-scam filters (bundler, rat trader, fresh wallet, dev hold, rug ratio, sniper, etc.)
- Indicators page: GMGN indicator filter, BB position toggle, RSI/Supertrend settings
- 3 new CONFIG_MAP entries: `gmgnMaxRugRatio`, `gmgnRejectSingleVolumeSpike`, `gmgnMaxSingleCandleVolumeShare`

**Jupiter API Fix**
- `quote-api.jup.ag` DNS dead → switched to `api.jup.ag/price/v3`
- Removed hardcoded API key from `wallet.js` → reads from `.env` via config
- Health check now sends `x-api-key` header

**Upstream Merge**
- 3 commits: auto-register Telegram commands, DeepSeek thinking mode fix, false volume=0 screening fix

### What to Avoid

1. **Never use `numberOrNull` in `screening.js`** — that function only exists in `executor.js`. Use `numeric()` which is already defined in `screening.js`.

2. **Never hardcode API keys in source code** — always read from `.env` via `config.js`. The `.env` file uses `envcrypt.js` for encryption. Keys go in `.env` with `# encrypted` marker.

3. **Never import `config` in `state.js`** — `state.js` doesn't import config. Pass config values via `options` parameter to functions.

4. **Never add duplicate `const` declarations** — upstream merge added duplicate `BOT_COMMANDS` in `telegram.js` which caused `SyntaxError: Identifier has already been declared`. Always check for existing declarations before merging.

5. **Never forget `htmlEscape()` for Telegram HTML** — pool names and close reasons can contain `<`, `>`, `=` which break Telegram's HTML parser. Always escape dynamic content.

6. **Never use `settingValue()` without adding mapping** — when adding new config keys to `/settings` UI, you MUST also add the key→config mapping in `settingValue()` function, otherwise it shows "off".

7. **Don't restart bot during active cycles** — check logs for `Starting management cycle` or `Starting screening cycle` before restarting. Wait for cycle to finish.

### What Worked Well

1. **Regression tests caught bugs early** — 176 tests covering R-implementations, fee drift, time-of-day, PnL poll gap, GMGN settings, Jupiter API. Run `node test/regression-test.js` after every change.

2. **Two-layer fee drift detection** — Layer 1 (fee_change_pct) is free, Layer 2 (cross-timeframe) adds 1 API call only at deploy time. Fail-open design prevents false rejections.

3. **Surgical PnL poll gap fix** — Adding emergency check BEFORE peak gate (not rewriting peak logic) preserved trailing TP behavior while fixing catastrophic loss detection.

4. **`settingValue()` pattern for Telegram UI** — Centralized config→UI mapping makes it easy to add new settings. Just add key to `settingValue()` and create button.

5. **CONFIG_MAP pattern for executor** — All config keys mapped in one place. Easy to verify coverage by grepping gmgn-config.json keys against CONFIG_MAP.

6. **`numeric()` vs `numberOrNull()`** — Different files use different helpers. `screening.js` uses `numeric()`, `executor.js` uses `numberOrNull()`. Don't mix them.

7. **Data-validated screening filters** — Volume Trend Acceleration. User provided closed-position data: 558 positions, ALL catastrophic losses cluster in pools with `volume_change_pct < -10%`. Adding `volume_trend` field + score boost +100 for accelerating pools + GMGN enrichment (1 API call) + hard-block option (default off) was a 173-line change that closed a real data gap.

8. **Surgical upstream merge for massive refactor** — `5fae0c5` (612 deletions, 333 additions) conflicted in 5 files with our local R-implementations. Resolved manually keeping all local features (Fee Drift CONFIG_MAP, OPERATOR_ONLY_KEYS, displayPnlPct, maxVolatility evolution). 8 conflict files resolved in ~30 min.

9. **Visual management display helpers** — `fmtAge` (formats `83m` → `1h 23m`), `positionStatusEmoji` (5-level status: ⚪/🟢/🟡/🟠/🔴), `feeTvlBar` (visual bar `▁▂▃▄▅▆` based on yield magnitude). Multi-line layout per position makes mgmt cycle reports scannable in Telegram. User asked for "more intuitive" — 4 helpers + 48 regression tests (265/265 pass) in 173-line change.

---

## Regression Tests (Updated)

`test/regression-test.js` — 265 inline unit tests.
Run: `node test/regression-test.js`

| Test group | Cases | What it covers |
|------------|-------|----------------|
| R1 Stop Loss | 4 | threshold boundary, suspicious pnl bypass |
| R2/R4.1 Trailing TP | 4 | always queued, not instant-close |
| R7 Safety-Lock | 7 | pecut+experimental, above+below, pnl=0 edge |
| R8 Indicator-Aware | 6 | hold/close/fail-open/profile guard/trailing bypass |
| R5 Low Yield | 4 | age gate, custom minAgeBeforeYieldCheck |
| F1 signal-tracker | 7 | pool lookup, base_mint fallback, clear-after-retrieval |
| Fee Drift | 31 | Layer 1 decline, Layer 2 spike, config, executor, screening |
| Config Tuning | 4 | minVolatility, stopLossCooldownHours defaults |
| Catastrophic SL | 7 | blacklist logic, threshold alignment |
| Time-of-Day | 18 | risky windows, safe windows, age threshold, config |
| Log Rotation | 6 | rotateOldLogs function, startup call |
| Performance | 7 | /performance command, getPerformanceHistory |
| PnL Poll Gap | 14 | emergency before peak gate, diagnostic log |
| GMGN Settings | 39 | CONFIG_MAP, Safety page, Volume page, Indicators |
| Jupiter API | 14 | health check, API key, URL constants |
| Agent allowSkip | 4 | option, signature, mustUseRealTool bypass |
| Volume Trend | 37 | classification, custom thresholds, score boost, deploy validation, code structure |
| Mgmt Display | 48 | fmtAge (1h 23m format), positionStatusEmoji (5-level), feeTvlBar (6 tiers), yield with /24h |
