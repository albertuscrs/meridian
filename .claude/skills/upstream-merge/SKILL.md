---
name: upstream-merge
description: Merge upstream (yunus-0x/meridian) into the local experimental branch without losing local features — carries the keep-local list, the conflict-resolution procedure, and the post-merge verification gauntlet. Use whenever asked to pull/merge/sync upstream changes.
---

# Surgical Upstream Merge

`upstream` (https://github.com/yunus-0x/meridian) is the original repo; this fork has
diverged with local features upstream doesn't have — and upstream refactors have
**deleted local features before** (they removed the `evaluateAndSetCooldown` call in
lessons.js; cooldown logic is broken upstream, ours works). Never resolve a conflict
by wholesale taking either side. Past merges: 8 conflict files resolved in ~30 min
with this procedure.

## Keep-local list (verify each survives EVERY merge)

Check these after resolution even in files that didn't conflict — upstream refactors
can silently move/delete them:

| Feature | Where | Grep to verify |
|---|---|---|
| Cooldown on close | lessons.js | `grep -n evaluateAndSetCooldown lessons.js` (import + call) |
| Fee Drift keys | executor.js CONFIG_MAP | `grep -c "feeDrift\|feeSpike" tools/executor.js` |
| OPERATOR_ONLY_KEYS | tools/executor.js | `grep -n OPERATOR_ONLY_KEYS tools/executor.js` |
| displayPnlPct | index.js / display path | `grep -rn displayPnlPct` |
| maxVolatility evolution | lessons.js | `grep -n maxVolatility lessons.js` |
| R7/R8/Rule-0 close rules | state.js | `grep -n "Safety-Lock\|Emergency close\|r8" state.js index.js` |
| Emergency-before-peak-gate ordering | state.js / PnL poller | `grep -n "emergency" state.js \| head` — floor check must come BEFORE peak gate |
| json-store adoption | all modules | covered by regression test (adoption scan) |
| settings ✓ marks | settings-menu.js | `grep -n choiceButton settings-menu.js \| head -3` |
| Strategy through RPC PnL | tools/pnl.js | `grep -n "strategy:" tools/pnl.js` |
| Telegram rate limiter | telegram.js | `grep -n "_resetChatActionStateForTests" telegram.js` |
| Allowed-user read-back | telegram.js | `grep -n loadAllowedUserIds telegram.js` |
| Config-key startup validator | executor.js + index.js | `grep -n findUnknownUserConfigKeys tools/executor.js index.js` |

(If this table has drifted from reality, update it as part of the merge commit.)

## Procedure

1. **Snapshot first**:
   ```bash
   git -C /home/ubuntu/projects/meridian status -s        # must be clean (posters_for_x/ untracked is normal)
   git fetch upstream
   git log --oneline HEAD..upstream/experimental          # what's coming
   git log --oneline upstream/experimental..HEAD | head   # what we have that they don't
   ```
   Read the incoming commit list and note anything touching the keep-local files.

2. **Merge** (never rebase — local history is shared with origin):
   ```bash
   git merge upstream/experimental
   ```

3. **Resolve conflicts file by file.** For each conflicted file:
   - Understand BOTH sides before editing (read hunks, not just markers).
   - Default stance: take upstream's structure, re-graft local behavior into it —
     not the other way around (their refactors are usually the reason to merge).
   - After each file: `node --check <file>`.
   - **Grep for duplicate declarations upstream may have re-added**
     (`grep -n "^const \|^let \|^function " <file> | sort | uniq -d` on the names, or
     just run the file — a duplicate `const` is a startup SyntaxError; this exact bug
     shipped once via `BOT_COMMANDS`).

4. **Keep-local sweep**: run every grep in the table above. Any miss → re-graft
   before committing.

5. **Verification gauntlet** (all must pass before the merge commit is final):
   ```bash
   node --check index.js agent.js config.js state.js lessons.js telegram.js \
     settings-menu.js display.js tools/*.js
   node test/regression-test.js       # 404/404 (or current total)
   node test/pool-cooldown-test.js
   ```
   The regression suite is the real safety net here — it source-checks most
   keep-local features, so a clean run catches silent deletions the grep sweep missed.

6. **Commit** the merge with a message listing: upstream commits merged, conflicted
   files, and every keep-local decision made (this log saved the next merge last time).
   Co-Authored-By line as usual.

7. **Deploy**: restart via the `restart-bot` skill (full checklist, quiet window).
   A merge is the highest-risk change class this repo has — never leave the bot
   running old code with the repo merged but unverified, and never restart onto a
   merge that hasn't passed the gauntlet.

8. **Push only when the operator asks**, and to `origin`, never `upstream`.

## If the merge goes sideways

`git merge --abort` restores pre-merge state cleanly (step 1 guaranteed a clean tree).
Report what conflicted and why it's hard; don't grind through a resolution you're
not confident in — a wrong guess here executes against real funds within minutes
of the restart.
