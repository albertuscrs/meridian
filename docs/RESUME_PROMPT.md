# Meridian DLMM Agent — Start Refresh Prompt

You are taking over a DLMM LP agent project (Meridian) on Solana.

## Project context

This is a personal fork of https://github.com/yunus-0x/meridian at https://github.com/albertuscrs/meridian.
Branch: experimental. Bot is running live on VM ubuntu@VM-0-3-ubuntu at /home/ubuntu/projects/meridian.

## What's been done (complete)

- R1-R10 closing rules refactor: 3 profiles (main/pecut/experimental), 5 rules each
- R7 Safety-Lock: holds OOR positions when pnl_pct ≤ 0
- R8 Indicator-Aware OOR Close: validates chart indicators before OOR close in experimental profile
- Rule 0 Emergency Close: hard exit at -10% bypassing all gates and cooldown
- PnL Poll Gap fix: emergency floor check BEFORE peak gate in state.js
- API monitoring: Telegram `/status` subcommands for all external APIs
- GMGN launchpad filtering: `blockedLaunchpads` enforced at Stage 2
- Xiaomi MiMo (mimo-v2.5) for screening LLM, MiniMax M2.7 for management
- Swap retry with escalating slippage (5x, 0.5%→10%)
- Screening cooldown: respects screeningIntervalMin when no positions
- Darwinian signal weighting fixed via upstream merge
- 176 regression tests in test/regression-test.js
- Merge with upstream complete (relay enrichment refactor integrated)
- Fee Drift Detection: Layer 1 (fee_change_pct) + Layer 2 (cross-timeframe spike)
- Config tuning: stopLossCooldownHours 2→6, minVolatility 3→3.5
- Base-mint blacklist on catastrophic SL (pnlPct ≤ -10%)
- Time-of-Day awareness: young tokens blocked during risky UTC windows
- Performance Dashboard: /performance command (24h/7d/30d/all)
- Log Rotation: 7-day retention at startup
- GMGN Settings reorganized: Volume / Safety / Indicators / KOL pages
- Jupiter health check fix: quote-api.jup.ag → api.jup.ag/price/v3
- Screening model changed to MiniMax-M2.7

## Current config

- closeProfile: experimental
- deployAmountSol: 0.25
- emergencyClosePct: -10
- r8IndicatorCheck: true, r8ExitPreset: supertrend_break, r8OorCooldownHours: 6
- screeningModel: MiniMax-M2.7, managementModel: MiniMax-M2.7
- managementIntervalMin: 3, screeningIntervalMin: 60
- allowedLaunchpads: [pump.fun, moonshot, met-dbc, meteora_virtual_curve]
- blockedLaunchpads: [letsbonk.fun]
- hiveMindPullMode: auto

## Key files

- index.js — main entry, management cycle, Telegram handlers, close engines
- state.js — position state, exit rules, Rule 0 emergency, Safety-Lock, R8 gate, PnL Poll Gap fix
- config.js — all config schema and defaults
- tools/dlmm.js — DLMM SDK wrapper (hard timeout 12s, swap retry)
- tools/screening.js — pool discovery pipeline + Fee Drift Layer 1
- tools/executor.js — tool dispatch, CONFIG_MAP, fee drift Layer 1+2
- tools/api-monitor.js — API health checks (Jupiter, GMGN, relay, etc.)
- tools/chart-indicators.js — RSI/Supertrend/BB indicators (used by R8)
- pool-cooldown.js — cooldown system + catastrophic SL blacklist
- telegram.js — Telegram bot, notifySwapFailure
- signal-weights.js — Darwinian signaling (F1 fixed)
- signal-tracker.js — signal staging (F1 fixed)
- agent.js — 3-tier LLM clients: global (MiniMax), screening (Xiaomi), fallback (OpenRouter)
- token-blacklist.js — permanent token blacklist
- logger.js — daily-rotating logs + rotateOldLogs() for cleanup

## Documentation

Read these first:
- docs/HANDOVER.md — complete project history and status
- docs/CLOSE_RULES_REFACTOR.md — R1-R10 spec and implementation
- docs/DARWINIAN_SIGNALS.md — signal weighting system
- CLAUDE.md — architecture overview, code conventions, "What to avoid" notes

## What to do

1. Read docs/HANDOVER.md first for full context
2. Check git status and recent commits
3. If bot needs restart: backup state.json first, then `screen -X -S meridian quit`, sleep 5, `screen -S meridian -dm npm start`
4. Ask me what I want to work on next

## Important rules

- DO NOT restart the bot without asking me first
- DO NOT push to upstream (you don't have rights)
- OK to: read files, grep, audit, plan, make code changes with my approval
- Bot is running via screen: `screen -ls` to check, `screen -X -S meridian quit` to stop
- If management cycle is running, wait for it to finish before restart
- Check logs: `tail -20 logs/agent-$(date +%Y-%m-%d).log`
