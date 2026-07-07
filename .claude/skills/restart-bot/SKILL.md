---
name: restart-bot
description: Safely restart the live Meridian bot (screen session `meridian`) — verify no cycle is in flight, kill the correct pid, relaunch, and run the post-restart health checklist against the logs. Use whenever a restart is needed (config change, code deploy) or when asked to check whether the bot is healthy.
---

# Safe Bot Restart + Health Verification

The bot holds real money and runs transactions on cron. A careless restart can
interrupt an in-flight close/deploy or kill the wrong process. Follow every step in
order. Total time when quiet: ~2 minutes plus wait windows.

Project dir: `/home/ubuntu/projects/meridian`. Logs: `logs/agent-YYYY-MM-DD.log`
(UTC date). Cron cadence comes from live config (typically management 3m,
screening 5m — check the `[CRON] Cycles started` line, don't assume).

## Step 0 — Is a restart actually needed?

- Config changes do NOT require a restart if applied via Telegram `/settings`
  (update_config mutates live state and persists). Restart is only needed for:
  code changes, `.env` changes, or manual `user-config.json` edits.
- If the goal is only "check health", skip to Step 4.

## Step 1 — Wait for a quiet window

Check today's log for an active cycle (beware: regression-test runs pollute the log
with fake POOL/TEST lines — look at timestamps and real markers only):

```bash
LOG=logs/agent-$(date -u +%F).log
tail -50 "$LOG" | grep -E "\[CRON\]|Starting (management|screening) cycle|cycle (complete|finished|done)"
```

A cycle is active if a `Starting … cycle` line has no completion after it.
Wait with a bounded loop (chained `sleep`s are blocked by the harness):

```bash
n=0; until ! (tail -20 "logs/agent-$(date -u +%F).log" | grep -q "Starting .* cycle" && \
  ! tail -20 "logs/agent-$(date -u +%F).log" | grep -qE "cycle (complete|finished)"); do
  sleep 5; n=$((n+5)); [ $n -ge 180 ] && break; done
```

If still busy after ~3 minutes, or the last lines show an in-flight
transaction (deploy/close/swap without its confirmation line): **stop and tell the
operator** — do not force it.

## Step 2 — Kill the node process (NOT the screen wrapper)

`pgrep -f "node index.js"` matches the SCREEN wrapper too. Always resolve the real pid
— and note the cmdline can be relative (`node index.js`) OR full-path
(`node /home/ubuntu/projects/meridian/index.js`), so match on `index.js`, not the
literal `node index.js`:

```bash
ps -eo pid,ppid,cmd | awk '/node .*meridian\/index\.js|node index\.js/ && !/SCREEN/ && !/awk/'
```

**If this prints MORE than one row, stop — duplicate instances.** A second instance
has come from PM2 resurrect before (systemd `pm2-ubuntu.service` + a stale
`~/.pm2/dump.pm2` revived a `meridian` app on reboot, 2026-07-06 → every Telegram
message answered twice, two management crons racing each other). Check `pm2 list`;
if a PM2-managed copy exists, remove it with `pm2 delete meridian && pm2 save --force`
(the `save` is what stops it resurrecting on the next reboot).

The row shown is `PID PPID cmd` — the PPID is the screen wrapper; SIGINT the PID:

```bash
kill -INT <PID>
n=0; until ! ps -p <PID> > /dev/null; do sleep 2; n=$((n+2)); [ $n -ge 30 ] && break; done
ps -eo pid,cmd | awk '/node index\.js/ && !/awk/'   # must print nothing
```

If it won't die after 30s, report it — do not escalate to SIGKILL without asking
(state writes are atomic via json-store, but an in-flight RPC call may not be).

## Step 3 — Relaunch

The old screen session may have died with the process. Recreate it detached:

```bash
screen -ls | grep -q meridian || screen -dmS meridian bash -c "cd /home/ubuntu/projects/meridian && node index.js"
screen -ls   # expect: <pid>.meridian (Detached)
```

If a `meridian` screen still exists but the node process is dead, launch inside it:
`screen -S meridian -X stuff 'node index.js\n'` — or simpler, quit it
(`screen -S meridian -X quit`) and recreate as above.

## Step 4 — Post-restart health checklist (ALL must pass)

Wait for startup to settle. The startup screening cycle can delay Telegram polling
registration by ~60s — read the log rather than polling blindly:

```bash
LOG=logs/agent-$(date -u +%F).log
grep "\[STARTUP\]" "$LOG" | tail -1                    # 1. startup line, recent timestamp
awk "/$(grep '\[STARTUP\]' "$LOG" | tail -1 | cut -d'T' -f2 | cut -d'.' -f1)/,0" "$LOG" \
  | grep -ciE "ERROR|CRON_ERROR"                       # 2. must be 0
grep "PNL_TICK" "$LOG" | tail -1                        # 3. poller alive, tick after startup
grep "Cycles started" "$LOG" | tail -1                  # 4. cron registered
grep -iE "polling|Registered .* bot commands" "$LOG" | tail -2   # 5. Telegram up
```

(For #2, simpler variant: `tail -100 "$LOG" | grep -cE "ERROR|CRON_ERROR"` and
eyeball that any hits predate the startup timestamp.)

6. **Positions still tracked**: if there were open positions before restart, confirm
   the first management cycle or `PNL_TICK` line reports the same count
   (`N position(s) tracked`). A drop to 0 with positions open on-chain is an
   incident — report immediately, do not "fix" state.json by hand.

7. **Exactly one instance**: the Step 2 `ps` command prints exactly one row, and
   `pm2 list` shows no `meridian` app. Duplicated `[CRON] Starting management cycle`
   lines (~1s apart each tick) in the log are the signature of a second instance.

8. Watch one full management cycle complete without errors before declaring success:

```bash
n=0; until tail -5 "logs/agent-$(date -u +%F).log" | grep -qE "cycle (complete|finished)"; do
  sleep 10; n=$((n+10)); [ $n -ge 300 ] && break; done
```

## Report format

State plainly: kill time, relaunch time, each checklist item ✅/❌ with the actual
log line for anything notable, and position count before/after. If ANY check failed,
lead with that — never bury a failed check under a "restart successful" headline.
