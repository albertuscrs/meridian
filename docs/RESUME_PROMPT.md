# Resume Prompt — Copy this into a new OpenCode session

```
You are taking over a DLMM LP agent project (Meridian) on Solana.

## Project context
This is a personal fork of https://github.com/yunus-0x/meridian at https://github.com/albertuscrs/meridian.
Branch: experimental. Bot is running live on VM ubuntu@VM-0-3-ubuntu at /home/ubuntu/projects/meridian.

## What's been done (complete)
- R1-R10 closing rules refactor: 3 profiles (main/pecut/experimental), 5 rules each
- R7 Safety-Lock: holds OOR positions when pnl_pct ≤ 0
- R8 Indicator-Aware OOR Close: validates chart indicators before OOR close in experimental profile
- Rule 0 Emergency Close: hard exit at -10% bypassing all gates and cooldown
- API monitoring: Telegram `/status` subcommands for all external APIs
- GMGN launchpad filtering: `blockedLaunchpads` enforced at Stage 2
- Xiaomi MiMo (mimo-v2.5) for screening LLM, MiniMax M2.7 for management
- Swap retry with escalating slippage (5x, 0.5%→10%)
- Screening cooldown: respects screeningIntervalMin when no positions
- Darwinian signal weighting fixed via upstream merge
- 35 regression tests in test/regression-test.js
- Merge with upstream complete (relay enrichment refactor integrated)

## Current config
- closeProfile: experimental
- deployAmountSol: 0.25
- emergencyClosePct: -10
- r8IndicatorCheck: true, r8ExitPreset: supertrend_break, r8OorCooldownHours: 6
- screeningModel: mimo-v2.5 (Xiaomi), managementModel: MiniMax-M2.5 (MiniMax API)
- managementIntervalMin: 3, screeningIntervalMin: 60
- allowedLaunchpads: [pump.fun, moonshot, met-dbc, meteora_virtual_curve]
- blockedLaunchpads: [letsbonk.fun]

## Key files
- index.js — main entry, management cycle, Telegram handlers, close engines
- state.js — position state, exit rules, Rule 0 emergency, Safety-Lock, R8 gate
- config.js — all config schema and defaults
- tools/dlmm.js — DLMM SDK wrapper (hard timeout 12s, swap retry)
- tools/screening.js — pool discovery pipeline
- tools/executor.js — tool dispatch, CONFIG_MAP, OPERATOR_ONLY_KEYS
- tools/api-monitor.js — API health checks
- tools/chart-indicators.js — RSI/Supertrend/BB indicators (used by R8)
- pool-cooldown.js — cooldown system, CLOSE_REASON_R8_HELD
- telegram.js — Telegram bot, notifySwapFailure
- signal-weights.js — Darwinian signaling (F1 fixed)
- signal-tracker.js — signal staging (F1 fixed)
- agent.js — 3-tier LLM clients: global (MiniMax), screening (Xiaomi), fallback (OpenRouter)

## Pending work
- Tier 2: Fee Drift Detection (compare fee/TVL across timeframes to catch honeypots)
- Tier 3: Config tuning (stopLossCooldownHours 2→6, minVolatility 3→3.5-4)
- Tier 4: Base-mint blacklist after catastrophic SL (>10% loss)
- Tier 5: Screening time-of-day awareness (skip high-risk windows)
- R8 exit preset tuning (try rsi_reversal, bollinger_reversion, bb_plus_rsi)

## Known issues
- .envrypt contains placeholder key — encrypted keys in .env decrypt to garbage
- Relay uses /positions/open/raw, falls back to Meteora portfolio API
- Jupiter swap: timeout errors, Meteora DLMM: 404 (external issues)
- state.json, lessons.json, pool-memory.json grow indefinitely (no rotation)

## Documentation
Read these first:
- docs/HANDOVER.md — complete project history and status
- docs/CLOSE_RULES_REFACTOR.md — R1-R10 spec and implementation
- docs/DARWINIAN_SIGNALS.md — signal weighting system
- CLAUDE.md — architecture overview and code conventions

## What to do
1. Read docs/HANDOVER.md first for full context
2. Check git status and recent commits
3. If bot needs restart: backup state.json first, then screen -X -S meridian quit, sleep 5, screen -S meridian -dm npm start
4. Ask me what I want to work on next

DO NOT restart the bot without asking me first.
DO NOT push to upstream (you don't have rights).
OK to: read files, grep, audit, plan, make code changes with my approval.
```
