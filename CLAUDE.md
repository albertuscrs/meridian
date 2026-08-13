# Meridian — Operating Manual

Autonomous DLMM liquidity-provider agent for Meteora pools on Solana.

**This bot is LIVE with real money.** It runs 24/7 in screen session `meridian` (wallet
`Ckn5Q43mNiEmUvfxiszfLiJ67F4q6hkW4zLbVTXPVCru`), deploying and closing LP positions
autonomously every few minutes. A bug you ship gets executed against real funds within
one cron cycle. Work accordingly: verify before restart, test before commit, and when
in doubt about anything that moves money — stop and ask.

---

## Non-Negotiables

1. **Never commit runtime JSON or secrets.** `user-config.json`, `gmgn-config.json`,
   `state.json`, `.env`, `lessons.json`, `pool-memory.json`, and all other runtime
   `*.json` are gitignored because they contain keys or live state. Only
   `*.example.json`, `dev-blocklist.json`, and `package*.json` are tracked. If
   `git status` shows a runtime JSON as staged, something is wrong — stop.
2. **Never hardcode API keys in source.** Keys live in `.env` (encrypted via
   `envcrypt.js`, marked `# encrypted`) and are read through `config.js`.
3. **Run `node test/regression-test.js` after every code change.** 404/404 must pass.
   No exceptions for "trivial" changes — the suite is fast and has caught real bugs
   in one-line diffs.
4. **Never restart the bot during an active cycle.** See the restart checklist below.
5. **Never run `evolveThresholds()` (lessons.js) ad-hoc** — it persists mutations to
   the live `user-config.json`.
6. **Commit per topic. Push only when explicitly asked, and push to `origin`**
   (the fork), never `upstream`. End commit messages with the Co-Authored-By line.
7. **Draft ≠ implement.** When the operator asks for a plan, feasibility check, or
   draft, do not touch code. Implementation requires explicit approval.

---

## How the Operator Works

- Communicates in casual Indonesian ("bro"). Reply in Indonesian. Code, commits, and
  docs headers can be English or mixed — match what exists.
- Wants **root causes, not symptoms**. When something looks wrong in Telegram output
  or logs, trace it through the pipeline to the source before patching the display.
- Runs experiments with review dates (tracked in Claude's memory directory — e.g.
  config threshold changes with a "review by" date). Don't silently change config
  values that are part of a running experiment.
- Expects a final summary that leads with what happened, includes commit hashes,
  and states verification results plainly (including failures).
- Verification means **exercising the behavior**, not reading the diff: render the
  Telegram page offline, run the function against live config, read the post-restart
  log. "Tests pass" alone is not verification for user-facing behavior.

---

## Architecture Map

```
index.js            Entry: cron orchestration + Telegram command routing (2.5k lines)
agent.js            ReAct loop (LLM → tool call → repeat); role tool-sets at :6-7
config.js           Loads user-config.json + .env at STARTUP ONLY → `config` object
prompt.js           System prompt per role (SCREENER / MANAGER / GENERAL)
state.js            Position registry (state.json) + deterministic close rules
lessons.js          Records closed-position perf, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots
pool-cooldown.js    Post-close cooldowns per pool/mint
signal-weights.js   Darwinian signal weight evolution (signal-weights.json)
signal-tracker.js   Stages screening-time signal snapshots for deploy tracking
strategy-library.js Saved LP strategies
display.js          Pure formatting helpers (htmlEscape, fmtAge, progress bars)
settings-menu.js    Entire /settings Telegram UI (settingValue, choiceButton)
observe-report.js   /observe report builders (log-derived analytics)
briefing.js         Daily Telegram briefing (HTML)
telegram.js         Bot polling, notifications, rate limiting, user allowlist
json-store.js       atomicWriteJson / readJsonSafe — ALL JSON persistence goes here
logger.js           Daily logs: logs/agent-YYYY-MM-DD.log + actions-*.jsonl

tools/
  definitions.js    Tool schemas the LLM sees (OpenAI format)
  executor.js       Tool dispatch + safety checks + CONFIG_MAP + update_config
  dlmm.js           Meteora DLMM SDK wrapper (deploy/close/claim/positions)
  pnl.js            RPC-based PnL path (ACTIVE — config.pnl.source = "rpc")
  screening.js      Pool discovery + scoring (Meteora path)
  gmgn.js           GMGN screening pipeline + anti-scam filters (ACTIVE source)
  chart-indicators.js  Supertrend/RSI presets (confirmIndicatorPreset)
  wallet.js         Balances + Jupiter swap (retry w/ escalating slippage)
  token.js          Token info/holders (Jupiter API)
  api-monitor.js    /status health checks for external APIs
```

**Live production values drift — never trust a doc snapshot.** Check what's actually
active before reasoning about behavior:
`node --input-type=module -e 'const {settingValue} = await import("./settings-menu.js"); console.log(settingValue("closeProfile"), settingValue("screeningSource"), settingValue("strategy")); process.exit(0)'`
(As of 2026-07-07: closeProfile `pecut`, screening GMGN, strategy `bid_ask`, PnL
source `rpc`, per-role consumer LLM clients — but verify, don't assume.)

---

## Named Mistakes (and the rule that prevents each)

These have all actually happened here. Each cost hours. Read before coding.

**1. The wrong-pid kill.** `pgrep -f "node index.js"` matches the SCREEN wrapper too
(its cmdline contains the string), so `kill $(pgrep -f ... | head -1)` kills the
wrapper and orphans the bot. Beware also: the cmdline can be full-path
(`node /home/ubuntu/projects/meridian/index.js`), which `/node index\.js/` does NOT
match — that blind spot hid a duplicate instance for 33 hours (see #15).
→ Rule: find the pid with
`ps -eo pid,ppid,cmd | awk '/node .*meridian\/index\.js|node index\.js/ && !/SCREEN/ && !/awk/'`
and SIGINT that pid only. More than one row → stop, see #15.

**2. The mid-cycle restart.** Restarting while a management/screening cycle is running
can interrupt an in-flight close/deploy transaction.
→ Rule: before any restart, check today's log for a `Starting management cycle` /
`Starting screening cycle` line without a matching completion; wait until quiet.
Use the `restart-bot` skill.

**3. The half-wired config key.** A new config key has SIX touchpoints. Missing any
one produces silent breakage: missing `settingValue()` mapping → UI shows "off";
missing `CONFIG_MAP` entry → `update_config` rejects it; missing from
`definitions.js` update_config key list → LLM can't set it; missing from config.js →
startup validator flags it as unknown.
→ Rule: use the `add-config-key` skill; never wire a key by memory.

**4. The helper mixup.** `numberOrNull()` exists only in `executor.js`;
`screening.js` has its own `numeric()`. Importing/using the wrong one throws
`ReferenceError` at runtime — and only on the code path that reaches it.
→ Rule: before using any helper, grep the current file for its definition or import.
Never assume a helper exists because another file uses it.

**5. The missing import after refactor.** A refactor that rewrites function bodies
(e.g. json-store adoption) but skips the import compiles fine (`node --check` passes)
and only explodes when that path runs — in one real case, only screening cycles that
had deployable candidates crashed, silently, for a day.
→ Rule: after any mechanical rewrite, grep every touched file for each new function
name it calls AND its import line. Then run the module functionally
(`node -e "await import('./file.js')"` + call the changed function) — not just
`node --check`.

**6. The unescaped Telegram HTML.** Pool names and close reasons contain `<`, `>`,
`&` — unescaped, they break Telegram's HTML parser and the message silently fails.
→ Rule: every dynamic value interpolated into Telegram HTML goes through
`htmlEscape()` (display.js). No exceptions for "it's just a number" fields that
could ever be a string.

**7. The config import in state.js.** `state.js` deliberately does not import
`config` — its functions take config values via an `options` parameter (keeps close
rules testable and dependency-free).
→ Rule: never add `import { config }` to state.js; thread values through options.

**8. The duplicate-const merge.** Upstream merges have introduced duplicate
`const` declarations (e.g. `BOT_COMMANDS` twice in telegram.js) →
`SyntaxError: Identifier has already been declared` at startup, i.e. the bot won't
boot.
→ Rule: after every merge, `node --check` every conflicted file, then grep each for
declarations the merge added.

**9. The upstream clobber.** Upstream refactors have removed local features (real
case: upstream deleted the `evaluateAndSetCooldown` call in lessons.js — cooldown
logic is broken upstream; ours works).
→ Rule: use the `upstream-merge` skill; it carries the keep-local list. Never resolve
a conflict by wholesale taking either side.

**10. The stale-doc trust.** This file and code comments go stale (a past version
documented `maxBundlersPct`, which never existed — the real key is
`maxBotHoldersPct`).
→ Rule: before acting on any key/function/threshold named in docs or memory, grep
the code to confirm it exists with that exact name.

**11. The config-edit-isn't-live assumption.** `config.js` loads at startup only.
Editing `user-config.json` does nothing to the running bot.
→ Rule: apply config changes via Telegram `/settings` (calls `update_config`
in-process: live + persisted), or edit the file AND restart during a quiet window.

**12. The test-log pollution confusion.** Regression tests write into the live daily
log (fake POOL_XXX / TEST lines). Reading the log right after a test run and treating
those lines as production events sends you chasing ghosts.
→ Rule: when reading logs for production behavior, filter for real markers
(`[CRON]`, `[SCREENING]`, `[STATE]`, `[PNL_TICK]`) and check timestamps against when
you ran the tests.

**13. The phantom verification.** Reporting "fixed" because the diff looks right and
tests pass, without exercising the actual behavior (the strategy-label bug shipped
long ago precisely because the field was dropped in a path nobody exercised).
→ Rule: every user-facing claim in your summary must name the observation that
backs it: the rendered output, the log line, the function's return value against
live config.

**14. The single-file tunnel.** Fixing a bug where it surfaced (e.g. hardcoding a
fallback in the display) instead of where the data was dropped (the PnL path omitting
`strategy`).
→ Rule: for any wrong-value bug, trace: display → position object → source function
(`getMyPositions` vs `tools/pnl.js buildPosition` — check `config.pnl.source` to know
which path is live) — fix at the source, make fallbacks honest (`"?"`, not a
plausible default).

**15. The PM2 resurrect double-instance.** Real incident 2026-07-06→08: a server
reboot made systemd's `pm2-ubuntu.service` resurrect a stale `meridian` app from
`~/.pm2/dump.pm2` (saved months earlier), while the screen instance was relaunched
manually — TWO live bots for 33h. Symptoms: every Telegram message answered twice,
`Starting management cycle` in pairs ~1s apart, RPC 429 storms, and the two
instances racing on the same position (one closed while the other decided to hold).
→ Rule: after any reboot or restart, verify exactly ONE instance: the #1 `ps`
command prints one row AND `pm2 list` has no `meridian` app. If PM2 has one:
`pm2 delete meridian && pm2 save --force` (the save stops the next-reboot
resurrect). Duplicate `Incoming:` lines in the log = two pollers, go look for the
second process.

---

## Quality Bar Per Deliverable

### Any code change
- [ ] `node --check` passes on every touched file
- [ ] `node test/regression-test.js` → 404/404 (or new higher count; document it)
- [ ] New behavior has regression tests: source-checks (`fs.readFileSync` +
      `.includes`/regex) for heavy modules (anything importing the DLMM SDK chain),
      functional imports for light modules (display.js, state.js, signal-weights.js)
- [ ] Behavior exercised end-to-end at least once (function called with live config,
      or output rendered) — named in the final summary
- [ ] One commit per topic; message follows `type(scope): summary` +
      `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- [ ] `git status` clean of runtime JSON; nothing pushed unless asked

### New tool (LLM-callable)
- [ ] Schema in `tools/definitions.js` tools array
- [ ] `tool_name: fn` in executor.js `toolMap`
- [ ] Added to `MANAGER_TOOLS` / `SCREENER_TOOLS` (agent.js:6-7) if role-scoped —
      otherwise it's GENERAL-only (this has been missed before: `get_wallet_positions`)
- [ ] If it writes on-chain: added to `WRITE_TOOLS` in executor.js

### New config key (use the add-config-key skill)
- [ ] Read + default in `config.js` (correct section)
- [ ] `CONFIG_MAP` entry in executor.js (or `OPERATOR_ONLY_KEYS` if Telegram-only)
- [ ] Listed in `update_config` schema keys in definitions.js (if LLM-settable)
- [ ] `settingValue()` mapping in settings-menu.js if it appears in /settings
- [ ] Multi-choice rows use `choiceButton()` (renders ✓ on the active choice)
- [ ] Regression tests for default + wiring; startup validator
      (`findUnknownUserConfigKeys`) does not flag it
- [ ] Documented in this file's config table if screening/risk/management-relevant

### Bot restart (use the restart-bot skill)
- [ ] Pre: no active cycle in today's log; no in-flight transaction
- [ ] Kill: SIGINT to the node pid (not the SCREEN wrapper); confirm exit
- [ ] Relaunch: `screen -dmS meridian bash -c "cd /home/ubuntu/projects/meridian && node index.js"`
- [ ] Post (within ~2 min): `[STARTUP]` line present; zero `ERROR`/`CRON_ERROR` since
      startup; `[PNL_TICK] poller alive` appears; `[CRON] Cycles started` appears;
      Telegram polling registered; open positions still tracked (`/positions`)

### Telegram-facing output
- [ ] All dynamic strings through `htmlEscape()`
- [ ] Progress bars/emoji follow existing format (`[████░░] 40%`, status emoji
      ⚪🟢🟡🟠🔴) — don't invent new visual language
- [ ] Rendered offline against live config before shipping (import the builder,
      print the result)

### Docs / plans
- [ ] Lives in `docs/`, SCREAMING_SNAKE name
- [ ] Status header (`PLAN / DRAFT — not implemented` vs implemented + date)
- [ ] Claims about the codebase carry `file.js:line` references verified this session
- [ ] Staged work marked with explicit go/no-go gates

### Upstream merge (use the upstream-merge skill)
- [ ] Keep-local list checked item by item after resolution
- [ ] `node --check` on every conflicted file; grep for duplicate declarations
- [ ] Full test suite passes; restart verified per checklist

---

## When to Stop and Ask

Ask **before** acting, even if you could proceed:

1. Anything that changes **risk or money parameters**: stop loss, emergency close,
   position sizing, maxPositions, deploy amounts — unless the exact value was given.
2. **Closing/opening a live position** or any manual on-chain action not explicitly
   requested this session.
3. **Pushing to any remote**, force-pushing, rebasing published history, or touching
   `upstream`.
4. **Deleting or truncating** any runtime data file (state.json, lessons.json,
   pool-memory.json, logs). Archival additions are fine; destruction is not.
5. Implementing anything from a **draft/plan doc** — each stage needs its own go.
6. Restart wanted but **cycles won't go quiet** or a transaction may be in flight.
7. A fix requires choosing between **two behaviorally different interpretations**
   of what the operator wants (e.g. hold vs close semantics) — one-sentence question
   beats a wrong guess executed by a live bot.
8. You found evidence of a **live incident** (error cascade in logs, position
   untracked, PnL wildly off): report findings first; do not hot-patch unprompted.

Do NOT ask (just do it): reading anything, running tests, offline rendering,
git commits on the current branch, updating docs to match code you changed,
scratchpad experiments.

---

## Reference

### Config system
`config.js` reads `user-config.json` + `.env` at startup into the `config` object.
Runtime changes go through the `update_config` tool (executor.js), which mutates the
live object, persists the file, and restarts crons if intervals changed. Key sections:
`screening`, `gmgn`, `management`, `risk`, `strategy`, `schedule`, `llm`, `indicators`,
`darwin`, `pnl`. Grep `config.js` for the authoritative key list — a startup validator
(`findUnknownUserConfigKeys`, executor.js) warns about unknown keys in the log.

`computeDeployAmount(walletSol)`: `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)`.

### Position lifecycle
1. **Deploy**: `deploy_position` → executor safety checks → `trackPosition()`
   (state.js) → signal snapshot attach (signal-tracker.js, called from tools/dlmm.js)
   → Telegram notify
2. **Monitor**: management cron → `getMyPositions()` (source: `tools/pnl.js` when
   `pnl.source=rpc`) → close-rule evaluation → pool-memory snapshots; 3s PnL poller
   drives trailing-TP/emergency checks
3. **Close**: `close_position` → `recordPerformance()` (lessons.js) →
   `evaluateAndSetCooldown()` (pool-cooldown.js) → auto-swap base→SOL → notify
4. **Learn**: `evolveThresholds()` on schedule (adjusts `maxVolatility`,
   `minFeeActiveTvlRatio`); Darwinian weights recalc from signal snapshots

### Deploy safety checks (executor.js, before deploy_position)
bin_step within [minBinStep, maxBinStep] · position count < maxPositions (fresh scan)
· no duplicate pool · no duplicate base mint · positive SOL amount · range ≥ safe-bins
floor (minBinsBelow, hard floor 35) · single-side SOL keeps `bins_above=0` (double-sided
is hard-blocked at dlmm.js:655) · balance covers amount + gasReserve · blockedLaunchpads
filtered pre-LLM.

### bins_below / bins_above
`bins_below = round(minBinsBelow + (volatility/5) × (maxBinsBelow − minBinsBelow))`,
clamped, volatility must be finite > 0 (zero/missing = unusable feed).
`bins_above` (default 20) does NOT widen the on-chain range on single-sided deploys —
it is stored in state and widens Rule 3's pump-close tolerance:
Rule 3 fires when `active_bin > upper_bin + outOfRangeBinsToClose + bins_above`.

### Close profiles (`config.management.closeProfile`)
| Profile | R4 OOR | R7 Safety-Lock | R8 Indicator | Rule 0 Emergency |
|---|---|---|---|---|
| `main` | time-based | no | no | yes |
| `pecut` | + Safety-Lock | yes | no | yes |
| `experimental` | + Safety-Lock + R8 | yes | yes | yes |

- **Rule 0 Emergency** (`emergencyClosePct`): fires before ALL rules incl. R1;
  bypasses locks/cooldowns. Log: `[STATE] Emergency close:`. The PnL poller checks
  the emergency floor BEFORE the peak gate (do not reorder — that ordering fixed a
  real -36% undetected loss).
- **R7 Safety-Lock**: OOR timeout but pnl ≤ 0 → hold. Log: `[STATE] Safety-Lock:`.
  Above-range holds (R7 + Rule 3 Pump-Hold) are capped by
  `outOfRangeAboveMaxHoldMinutes` (default 120m): above range the position is pure
  SOL with frozen PnL, so the gates can never clear on their own — force close at
  the cap (log `Max-Hold:`, reason `OOR above for Xm (max hold: Ym)`). Below-range
  holds are uncapped.
- **R8**: pre-fetch indicators before OOR close; `confirmed:false` → hold; fail-open
  on API error. Gate order: OOR timeout → trailingArmed? → R7 → R8 → close.
- **R4.1 Trailing TP**: Rule 2 always returns `TRAILING_TP_QUEUED` — timer-confirmed
  (3s pecut / 15s main+experimental), never instant-close.

### Pool cooldowns (pool-cooldown.js, on every close)
low yield 4h · stop loss 6h · loss>1% manual 1h · OOR big loss 6h (pnl <
`oorBigLossPnlThreshold`, −$2) · cumulative pool loss > $5 → 48h · 3+ repeated OOR
12h · manual 1h · trailing-TP exit `trailingTpCooldownHours` (2h) · take-profit /
pumped-above-range exit `takeProfitCooldownHours` (1h). Longest wins. Stop loss /
OOR-big-loss / cumulative
also cool the **base mint** across pools. Catastrophic SL (pnl ≤ −10%) →
permanent blacklist (same threshold as `emergencyClosePct`).

### Telegram commands (handled in index.js, bypass LLM)
`/positions` `/close <n>` `/set <n> <note>` `/settings` `/performance`
`/status apis|relay|hivemind|gmgn|jupiter|meteora|rpc` `/observe …`

### Environment variables
Required: `WALLET_PRIVATE_KEY`, `RPC_URL`, `OPENROUTER_API_KEY`.
Optional: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `LLM_BASE_URL`, `LLM_MODEL`,
`DRY_RUN` (skip on-chain), `HIVE_MIND_URL`/`HIVE_MIND_API_KEY`, `HELIUS_API_KEY`.
`.env` is encrypted (envcrypt.js) — scripts must `await import("./envcrypt.js")` first.

### Tests
`node test/regression-test.js` — 404 inline tests (R-rules, F1 signal tracker, fee
drift, time-of-day, PnL poll gap, GMGN settings, Jupiter API, volume trend, display
helpers, Telegram rate limiter, allowed-user read-back, config validator, index split,
settings ✓ marks, json-store adoption scan). Also `test/pool-cooldown-test.js`,
`test/test-solmode-pnl.js`. Heavy modules are source-checked; light modules imported
functionally. Scripts importing `@solana/web3.js` must run from the project dir
(node_modules resolution), not /tmp.

### Git
Branch `experimental`; PRs target `main`. `origin` = albertuscrs fork (push target),
`upstream` = yunus-0x (fetch only). Untracked `posters_for_x/` belongs to the
operator — never touch, never commit.
