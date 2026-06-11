# Meridian DLMM Agent — Start Refresh Prompt

You are taking over a DLMM LP agent project (Meridian) on Solana.

## Project context

This is a personal fork of https://github.com/yunus-0x/meridian at https://github.com/albertuscrs/meridian.
Branch: experimental. Bot is running live on VM ubuntu@VM-0-3-ubuntu at /home/ubuntu/projects/meridian.

## What's been done (complete)

**R1-R10 closing rules + core safety:**
- R1-R10 closing rules refactor: 3 profiles (main/pecut/experimental), 5 rules each
- R7 Safety-Lock: holds OOR positions when pnl_pct ≤ 0
- R8 Indicator-Aware OOR Close: validates chart indicators before OOR close in experimental profile
- Rule 0 Emergency Close: hard exit at -10% bypassing all gates and cooldown
- PnL Poll Gap fix: emergency floor check BEFORE peak gate in state.js
- Catastrophic SL → permanent base-mint blacklist (pnlPct ≤ -10%)

**Screening filters (data-validated):**
- Fee Drift Detection: Layer 1 (fee_change_pct) + Layer 2 (cross-timeframe spike 1h vs 24h)
- Volume Trend Acceleration: classifies into accelerating/stable/decelerating, score +100 for accelerating, GMGN enrichment
- Time-of-Day awareness: young tokens (<24h) blocked during risky UTC windows (00-04, 16-17)
- Base-mint blacklist on catastrophic SL

**Config tuning:**
- stopLossCooldownHours 2→6
- minVolatility null→3.5
- Screening model: mimo-v2.5 → MiniMax-M2.7

**Operations + monitoring:**
- API monitoring: Telegram `/status` subcommands for all external APIs
- Performance Dashboard: /performance command (24h/7d/30d/all)
- Log Rotation: 7-day retention at startup
- Swap retry with escalating slippage (5x, 0.5%→10%)
- Screening cooldown: respects screeningIntervalMin when no positions

**GMGN + Jupiter:**
- GMGN launchpad filtering: `blockedLaunchpads` enforced at Stage 2
- GMGN Settings reorganized: Volume / Safety / Indicators / KOL pages in `/settings`
- Jupiter health check fix: `quote-api.jup.ag` → `api.jup.ag/price/v3`
- GMGN enrichment: fetches Meteora pool detail to get `volume_change_pct` (1 API call per pool)

**Telegram / agent improvements:**
- `allowSkip` option in agentLoop — SCREENER can return text when skipping cycle
- Mgmt display helpers: `fmtAge` (1h 23m format), `positionStatusEmoji` (5-level), `feeTvlBar` (visual yield bar)
- Multi-line intuitive position display in mgmt cycle + `/positions`

**Upstream sync:**
- 1e053a2 (drop 15m timeframe) cherry-picked
- 5fae0c5 (entry/exit learning, HiveMind market push, OKX removal, setup overhaul) cherry-picked
- 8 conflict files resolved manually keeping all local R-implementations

**Tests:** 265 regression tests in test/regression-test.js (all passing)

## Current config

- closeProfile: experimental
- deployAmountSol: 0.25
- emergencyClosePct: -10
- r8IndicatorCheck: true, r8ExitPreset: supertrend_break, r8OorCooldownHours: 6
- screeningModel: MiniMax-M2.7, managementModel: MiniMax-M2.7
- managementIntervalMin: 3, screeningIntervalMin: 60
- volumeTrendFilter: true, volumeTrendBlockDecel: false (LLM decides)
- timeOfDayCheck: true, riskyHours: [0,1,2,3,4,16,17]
- allowedLaunchpads: [pump.fun, moonshot, met-dbc, meteora_virtual_curve]
- blockedLaunchpads: [letsbonk.fun]
- hiveMindPullMode: auto
- 25+ commits ahead of upstream/experimental (fully synced)

## Key files

- index.js — main entry, management cycle, Telegram handlers, close engines, display helpers
- state.js — position state, exit rules, Rule 0 emergency, Safety-Lock, R8 gate, PnL Poll Gap fix
- config.js — all config schema and defaults
- tools/dlmm.js — DLMM SDK wrapper (hard timeout 12s, swap retry)
- tools/screening.js — pool discovery pipeline + Fee Drift Layer 1 + Volume Trend + GMGN enrichment
- tools/executor.js — tool dispatch, CONFIG_MAP, fee drift Layer 1+2, deploy validation
- tools/api-monitor.js — API health checks (Jupiter, GMGN, relay, etc.)
- tools/chart-indicators.js — RSI/Supertrend/BB indicators (used by R8)
- tools/gmgn.js — GMGN pipeline (5 stages: rank, info, pool, indicators, final)
- pool-cooldown.js — cooldown system + catastrophic SL blacklist
- telegram.js — Telegram bot, notifySwapFailure, auto-register commands
- agent.js — 3-tier LLM clients: global (MiniMax), screening (Xiaomi), fallback (OpenRouter), `allowSkip` option
- token-blacklist.js — permanent token blacklist
- logger.js — daily-rotating logs + rotateOldLogs() for cleanup
- screening-scales.js — timeframe-aware fee/TVL + volume scaling
- repo-root.js — PM2 cwd fix from upstream

## Documentation

Read these first:
- `docs/HANDOVER.md` — complete project history and status
- `docs/CLOSE_RULES_REFACTOR.md` — R1-R10 spec and implementation
- `docs/DARWINIAN_SIGNALS.md` — signal weighting system
- `CLAUDE.md` — architecture overview, code conventions, "What to avoid" notes (kept at root per AI tool convention)
- `docs/PNL_POLL_GAP_HANDOFF.md` — PnL Poll Gap fix spec (implemented)
- `docs/handoffs/R7_FLOOR_HANDOFF.md` — R7 historical handoff (already implemented)
- `docs/RESUME_PROMPT.md` — this file (start prompt for new sessions)

## What to do

1. Read `docs/HANDOVER.md` first for full context
2. Check `git status` and `git log --oneline -10`
3. If bot needs restart: backup `state.json` first, then `screen -X -S meridian quit`, sleep 5, `screen -S meridian -dm npm start`
4. Ask me what I want to work on next

## Important rules

- **DO NOT restart the bot without asking me first**
- **DO NOT push to upstream** (you don't have rights)
- OK to: read files, grep, audit, plan, make code changes with my approval
- Bot runs via screen: `screen -ls` to check, `screen -X -S meridian quit` to stop
- If management/screening cycle is running, wait for it to finish before restart
- Check logs: `tail -20 logs/agent-$(date +%Y-%m-%d).log`
- Backups: state.json.backup-* (e.g. `state.json.backup-pre-volume-trend-20260610-153656`)

## Quick commands

```bash
# Check bot status
ps aux | grep "node index.js" | grep -v grep
screen -ls

# View recent log
tail -30 logs/agent-$(date +%Y-%m-%d).log

# Run tests
node test/regression-test.js

# Check git
git status
git log --oneline -10

# Open config files
cat user-config.json | head -30
cat gmgn-config.json | head -30
```

## Common patterns

- **Config keys:** Defined in `config.js` (defaults), overridden by `user-config.json` (saved via `/settings`). `settingValue()` in `index.js` maps keys for `/settings` display.
- **Screening filter pattern:** In `getTopCandidates()` in `tools/screening.js` — add filter inside the `.filter()` callback, log + `pushFilteredReason()` for debugging.
- **Deploy validation pattern:** In `validateDeployPoolThresholds()` in `tools/executor.js` — runs at deploy time as last-chance gate.
- **Regression test pattern:** Inline functions in `test/regression-test.js` that mirror logic from source code, then assertions. Each new feature gets a test section.
