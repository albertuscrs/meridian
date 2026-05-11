# Meridian DLMM Agent — Handover Document
**Date:** 2026-05-10
**Branch:** experimental
**Status:** Merge in-progress, bot still running stable from in-memory code

---

## 🚨 CRITICAL CONTEXT — READ THIS FIRST

This is a **personal fork** of an open-source DLMM LP agent (Meridian).

- **My fork (origin):** https://github.com/albertuscrs/meridian
- **Upstream owner:** https://github.com/yunus-0x/meridian
- **My local commit:** `3cd16a3` (checkpoint: sync working state with upstream/experimental)
- **Current state:** MERGE IN-PROGRESS, 7 files have unresolved conflict markers
- **Bot status:** Still running from memory (started May 7, 21:30 UTC, 3+ days uptime). DO NOT RESTART until conflicts resolved and syntax verified.

### Why merge was attempted
1 week of personal R-implementations were verified working in production. Upstream owner pushed 11 new commits to their experimental branch (PM2 fixes, volatility precision, Discord signals, etc). Attempted merge to integrate owner's improvements while preserving my work. **Hit conflicts in 7 files but did not abort.**

---

## ✅ WHAT HAS BEEN DONE (Complete History)

### Phase 1: Closing Rules Refactor (R1-R10) — ALL VERIFIED IN PRODUCTION

The agent has a closing-rules engine with 5 rules and 3 profile variants:
- **Main** (Deterministic) — current default
- **Pecut** (3s confirm, profit gates, Safety-Lock) — currently active in production
- **Experimental** (HiveMind sync, indicator validation, PVP rivalry) — dormant

| Rule | Profile | Implementation | Status |
|------|---------|----------------|--------|
| R1 Stop Loss | All | Hard floor PnL ≤ stopLossPct | ✅ Production |
| R2 Trailing TP | Main | 15s confirm window | ✅ Production |
| R2 Trailing TP | Pecut | 3s confirm window (R4) | ✅ Production |
| R3 Pump Above | Main | Instant close on bin gap | ✅ Production |
| R3 Pump Above | Pecut/Exp | minProfitPctToCloseOOR gate (R5) | ✅ Production |
| R4 OOR Stale | Main | Time-based (35m above / 8m below) | ✅ Production |
| R4 OOR Stale | Pecut/Exp | Safety-Lock — hold if PnL ≤ 0 (R7) | ✅ Production |
| R5 Low Yield | All | minAgeBeforeYieldCheck (R9 fix) | ✅ Production |
| R10 OOR consolidation | All | state.js single source for OOR | ✅ Production |
| R4.1 Trailing path consolidation | All | Single timer-based path (no instant bypass) | ✅ Production |

**Key innovations:**
1. **closeProfile config field** — toggle "main"/"pecut"/"experimental" via Telegram
2. **Pre-fetch architecture** — keeps state.js sync, async work in index.js
3. **Pump-Hold gate** — prevents premature exits on price pumps without realized profit
4. **Safety-Lock** — holds positions through OOR timeout when unprofitable
5. **Hard-bypass for risk-critical exits** — OOR + trailing armed skips LLM round-trip
6. **Profile-aware confirmation windows** — 3s pecut, 15s main/experimental

### Phase 2: Production Verification Evidence

**R7 Safety-Lock (verified 2026-05-05):**
- Position GqWLvoXcMJ4FaMjZgZZgfju3HG3LXV6AW1bsnheX5zLr at 0% PnL successfully held through 35m OOR window
- Recovered to +0.72% PnL before close
- Without R7, would have closed at break-even or slight loss

**R5 Pump-Hold (verified 2026-05-06):**
- 17 hold occurrences across 2 unique positions (avg 8.5 polls per position before close)
- Pattern: pump detected → PnL < gate → hold → PnL recovers → close at higher PnL
- 4 Pump R3 closes that day, all profitable

**R4.1 Trailing TP consolidation (verified 2026-05-07):**
- 3 confirmed trailing TP closes via 3000ms confirmation window
- 2 fakeout rejections — saved positions from premature close
- Example: position dropped to PnL 2.66%, 3s window detected reversal to 2.89%, REJECTED close
- 53 seconds later, real drop occurred and CONFIRMED close

**/observe sub-commands:**
- `/observe` — daily snapshot (closes, holds, errors)
- `/observe held` — current Safety-Lock and Pump-Hold positions
- `/observe reasons` — distribution histogram with bar chart
- `/observe compare` — baseline vs current period (auto-detect profile change boundary)

### Phase 3: Cooldown Investigation & Tuning

**Investigation findings (2026-05-08):**
- 8 cooldown reason branches in `pool-cooldown.js`
- Rule 3 (pump close) gets 1h cooldown — appropriate
- **Real issue:** `repeatDeployCooldownHours = 12h` token-wide cooldown after 3 successful fee-generating deploys — penalizes momentum pools

**Tuning applied:**
- `repeatDeployCooldownHours`: 12 → 2
- `repeatDeployCooldownMinFeeEarnedPct`: 0 → 1
- Rationale: ANDV-SOL case study showed 3 sequential profitable deploys with declining-but-strong fee/TVL (6.85% → 5.29% → 2.45%, all above 0.15% threshold). 12h token-wide cooldown was missing continuation pumps.

### Phase 4: R8 Investigation Complete (NOT Implemented Yet)

R8 = Indicator-Aware OOR Close for "experimental" profile.

**Investigation found (2026-05-09):**
- `confirmIndicatorPreset({ side: "exit" })` already exported in `tools/chart-indicators.js`
- Exit logic for all 7 presets already implemented
- Fail-open semantics baked in (skipped: true → confirmed: true → close as normal)
- Latency ~1.2s per pool (acceptable for Rule 4 trigger frequency)
- 🟢 **Easy tier** implementation, ~67 lines across 4 files

**Implementation decisions LOCKED (ready to apply):**
- Scope: BOTH OOR above AND below
- Trailing armed: SKIP R8 (locking profit, indicators irrelevant)
- Architecture: Pre-fetch in index.js (async), sync gate in state.js Rule 4
- Default exit preset: `supertrend_break` (configurable via `config.indicators.exitPreset`)
- Failure mode: Fail-open (Rule 4 time-based close is the safety fallback)
- Gate order in Rule 4: Safety-Lock (R7) first → R8 indicator check → OUT_OF_RANGE close

### Phase 5: Security Hardening

- Wallet keys backed up to `~/secure-backup/` (outside repo)
  - `private_key.pem.backup` (chmod 600)
  - `public_key.pem.backup` (chmod 600)
- `.gitignore` strict — excludes `*.pem`, `private_key*`, `public_key*`, state backups, `*.bak`, `*.save`, `.claude/`, `10000`
- Verified `private_key.pem` and `public_key.pem` never committed to history
- `.claude/settings.local.json` ignored via global git config

### Phase 6: Fork Setup

- Forked `yunus-0x/meridian` to `albertuscrs/meridian` (full branches: main + experimental)
- Renamed local remote: `origin` (was upstream owner) → `upstream`
- Added `origin` pointing to my fork
- Local commit `3cd16a3` made (checkpoint of working state)
- Push attempted but **rejected** — fork has owner's later commits that local doesn't

### Phase 7: Documentation

`docs/CLOSE_RULES_REFACTOR.md` exists with:
- Full R1-R10 spec and implementation status
- Production verification evidence
- Architecture notes
- Decision log
- Glossary (Pecut, Hard Floor, Safety-Lock, HiveMind, etc.)

---

## ⚠️ CURRENT BLOCKER — MERGE CONFLICTS UNRESOLVED

### Git State

HEAD: 3cd16a3 (my checkpoint commit)
upstream/experimental: d342b7c (older, before owner's recent work)
origin/experimental: 71be9bc (fork with owner's 11 new commits)
Merge attempt: git merge origin/experimental
Result: 7 conflicts, NOT aborted, NOT resolved

### Conflict Files (UNRESOLVED, MARKERS PRESENT)
| File | Risk |
|------|------|
| `CLAUDE.md` | 🟡 Docs only |
| `config.js` | 🔴 SyntaxError — has my closeProfile config |
| `index.js` | 🔴 SyntaxError — has R3, R5, R7 logic |
| `tools/definitions.js` | 🟡 Reports OK syntax (suspicious — verify) |
| `tools/executor.js` | 🔴 SyntaxError — has CONFIG_MAP additions for R5 |
| `tools/dlmm.js` | 🔴 SyntaxError |
| `user-config.example.json` | 🟡 Template only |

### Auto-Merged Files (NEED AUDIT — silent overwrite risk)
| File | Why audit |
|------|-----------|
| `tools/screening.js` | Owner has volatility precision changes; my R-logic might be silently overwritten |
| `tools/gmgn.js` | Stage4 indicator logic — verify untouched |
| `cli.js`, `setup.js`, `prompt.js` | Owner refactor, low risk |
| `package.json` | Dependency changes? |
| `ecosystem.config.cjs` | NEW — PM2 config from owner |
| `README.md`, `gmgn-config.example.json` | Low risk |

### Owner's 11 Commits Pending Integration

71be9bc Enrich Discord signal launchpads before filtering ← NEW FEATURE
00a9b7f Recognize PM2 entrypoint path
7f52a4d Harden graceful shutdown under PM2
171c917 Fix PM2 restart handling
8f9a4f1 Use screening timeframe for longer volatility windows
ab9bff1 Preserve 30m volatility precision
bc17c45 Use 30m volatility for Meteora screening
99fb060 Guard DLMM deploy range and screening
220255a docs: correct HiveMind README details
2e76b25 docs: add Meridian socials and agent harness
73d366c fix: enforce screening thresholds before deploy

---

## 📋 WHAT NEEDS TO BE DONE — RESUME PLAN

### Phase A: Investigation (do FIRST, ~15-30 minutes)

Map every R-implementation across local vs upstream. Run these commands and analyze:

```bash
echo "▶ R7 Safety-Lock"
git show HEAD:state.js | grep -n "Safety-Lock"
git show origin/experimental:state.js | grep -n "Safety-Lock"

echo "▶ R5 Pump-Hold"
git show HEAD:index.js | grep -n "Pump-Hold"
git show origin/experimental:index.js | grep -n "Pump-Hold"

echo "▶ R5 minProfitPctToCloseOOR"
git show HEAD:config.js | grep -n "minProfitPctToCloseOOR"
git show origin/experimental:config.js | grep -n "minProfitPctToCloseOOR"

echo "▶ R4.1 windowLabel + TRAILING_TP_QUEUED"
git show HEAD:state.js | grep -n "windowLabel\|TRAILING_TP_QUEUED"
git show origin/experimental:state.js | grep -n "windowLabel\|TRAILING_TP_QUEUED"
git show HEAD:index.js | grep -n "TRAILING_DROP_CONFIRM_DELAY_MS_PECUT"
git show origin/experimental:index.js | grep -n "TRAILING_DROP_CONFIRM_DELAY_MS_PECUT"

echo "▶ R3 bins_above + Rule 3 tolerance"
git show HEAD:index.js | grep -n "bins_above\|binsAbove"
git show origin/experimental:index.js | grep -n "bins_above\|binsAbove"

echo "▶ closeProfile (R1+R2 foundation)"
git show HEAD:config.js | grep -n "closeProfile"
git show origin/experimental:config.js | grep -n "closeProfile"
git show HEAD:state.js | grep -n "closeProfile"
git show origin/experimental:state.js | grep -n "closeProfile"

echo "▶ R10 trailing-armed OOR"
git show HEAD:state.js | grep -n "trailing armed\|trailingArmed"
git show origin/experimental:state.js | grep -n "trailing armed\|trailingArmed"
```

For each R-implementation, decide:
- ✅ Only in mine → Keep Yours during conflict resolution
- ⚠️ In both (parallel implementation) → Manual merge needed
- 🔴 Mine present, upstream has conflicting logic → Critical decision

### Phase B: Audit Auto-Merged Files (~15 minutes)

Critical to do this — auto-merge can silently overwrite logic:

```bash
# Check tools/screening.js — most critical
grep -n "minProfitPctToCloseOOR\|Safety-Lock\|Pump-Hold\|profile" tools/screening.js
git show HEAD:tools/screening.js | grep -n "minProfitPctToCloseOOR\|Safety-Lock"

# Check tools/gmgn.js
grep -n "indicator\|Stage4" tools/gmgn.js | head -20

# Diff the post-merge state vs my checkpoint for staged-but-merged files
for f in tools/screening.js tools/gmgn.js cli.js setup.js prompt.js package.json; do
  echo "=== $f ==="
  git diff HEAD -- "$f" | head -40
done
```

If auto-merge silently dropped any R-logic, must manually re-add or unstage and resolve as conflict.

### Phase C: Conflict Resolution Strategy Per File

Based on Phase A findings, decide per file:

| File | Likely Strategy | Reason |
|------|----------------|--------|
| `CLAUDE.md` | Manual merge | Both have docs additions |
| `user-config.example.json` | Manual merge | Both have new config example fields |
| `config.js` | Manual merge | Mine: closeProfile, R5 config. Theirs: PM2, volatility settings |
| `tools/definitions.js` | Manual merge or Keep Theirs | Verify if mine has tool changes |
| `tools/executor.js` | Manual merge | Mine: CONFIG_MAP for R5/closeProfile. Theirs: ? |
| `tools/dlmm.js` | Manual merge | Mine: bins_above logic? Theirs: deploy guard. CRITICAL |
| `index.js` | Manual merge | LARGEST FILE. Mine: massive R-logic. Theirs: PM2 + screening. CRITICAL |

### Phase D: Resolve Conflicts Sequentially

For each file:
1. Open conflict markers
2. Apply strategy from Phase C
3. Save file
4. `node --check <file>` to verify syntax
5. `grep "^<<<<<<<" <file>` to verify no markers left
6. `git add <file>` to mark resolved
7. Move to next file

DO NOT commit until all 7 files resolved + audit auto-merged files complete.

### Phase E: Commit Merge

```bash
# Final verification
git status  # All conflicts should be resolved
git diff --check  # No conflict markers anywhere
node --check state.js && node --check index.js && node --check config.js && \
  node --check tools/dlmm.js && node --check tools/executor.js && \
  node --check tools/definitions.js && node --check tools/screening.js && \
  echo "ALL SYNTAX OK"

# Commit merge
git commit -m "merge: integrate upstream/experimental + preserve R-implementations

Owner improvements integrated:
- PM2 process management (4 commits)
- Volatility precision enhancements (3 commits)
- Discord signals as launchpad source
- DLMM deploy guard
- Pre-deploy screening enforcement

Personal R-implementations preserved:
- R1+R2: closeProfile foundation (main/pecut/experimental)
- R3: bins_above tolerance for Rule 3 pump-close
- R4: 3s trailing confirm window for pecut
- R4.1: trailing TP path consolidation (single timer-based path)
- R5: minProfitPctToCloseOOR gate (Pump-Hold)
- R7: Safety-Lock for OOR + unprofitable
- R10: OOR engine consolidation (state.js single source)

Verified production stability before merge — bot was running
on these R-implementations with profile=pecut for 1 week."

# Push to fork
git push origin experimental
# Auth: username=albertuscrs, password=<GitHub PAT>
```

### Phase F: Restart Bot Carefully

```bash
# 1. Backup state.json one more time
cp state.json state.json.backup-pre-restart-$(date +%Y%m%d-%H%M%S)

# 2. Verify current bot state via Telegram /observe (note current positions, holds)

# 3. Restart bot screen
screen -X -S meridian quit
# Wait 5 seconds
sleep 5
# Start fresh
cd ~/projects/meridian
screen -S meridian -dm npm start

# 4. Tail logs immediately
tail -f logs/agent-2026-05-10.log
# Watch for:
# - Successful startup
# - No SyntaxError, no module load errors
# - Cron cycles starting
# - PM2-related changes (graceful shutdown handlers, etc.)
```

### Phase G: Post-Restart Verification

Within first 30 minutes after restart:
- [ ] Bot starts without errors
- [ ] All open positions still tracked correctly
- [ ] Telegram `/observe` returns expected data
- [ ] Profile still set to pecut (`/settings` or `/observe` shows profile)
- [ ] Trailing TP closes (if any) show `(window: 3000ms)` log marker
- [ ] Safety-Lock fires correctly when applicable
- [ ] Pump-Hold fires correctly when applicable
- [ ] No duplicate close attempts (R10 still working)

If anything breaks: emergency rollback
```bash
git reset --hard 3cd16a3
cp state.json.backup-pre-restart-* state.json
screen -X -S meridian quit
screen -S meridian -dm npm start
```

### Phase H: R8 Implementation (After Merge Stable)

Once merge stable for 24-48 hours:

1. Branch from current state:
```bash
   git checkout -b feat/r8-indicator-aware-close
```

2. Apply R8 implementation per locked decisions:
   - Both OOR directions (above + below)
   - Skip when trailingArmed = true
   - Pre-fetch indicators in index.js (async)
   - Sync gate in state.js Rule 4
   - Use `confirmIndicatorPreset({ side: "exit" })` from `tools/chart-indicators.js`
   - Fail-open default behavior

3. Run T1-T10 inline-predicate tests (defined in previous session)

4. Push branch to fork (NOT to upstream):
```bash
   git push -u origin feat/r8-indicator-aware-close
```

5. Bot stays on `experimental` branch with profile=pecut. R8 dormant.

6. Future: when ready, merge feat/r8 → experimental, flip profile to "experimental" with small deployAmountSol, monitor.

---

## 🔧 ENVIRONMENT REFERENCE

### Server Info
- Server: VM `ubuntu@VM-0-3-ubuntu`
- Project path: `/home/ubuntu/projects/meridian`
- Wallet keys backup: `/home/ubuntu/secure-backup/`

### Git Remotes

origin    https://github.com/albertuscrs/meridian.git (my fork)
upstream  https://github.com/yunus-0x/meridian (owner)

### Active Configuration
- closeProfile: `pecut`
- deployAmountSol: 0.25 SOL (small, careful mode)
- maxPositions: configured (check via Telegram `/settings`)
- minProfitPctToCloseOOR: 0 (default, no profit gate)
- repeatDeployCooldownHours: 2 (tuned down from 12)
- repeatDeployCooldownMinFeeEarnedPct: 1 (tuned up from 0)
- LLM model: `mimo-v2.5` (lowercase — case-sensitive!)

### Key Files
- `state.js` — position state, exit rules, trailing TP confirmation
- `index.js` — main bot loop, management cycle, PnL poll, Telegram handlers
- `config.js` — all config schema
- `tools/dlmm.js` — DLMM SDK integration
- `tools/screening.js` — pool screening pipeline
- `tools/executor.js` — LLM tool execution + CONFIG_MAP
- `tools/chart-indicators.js` — indicator API wrapper (will be used for R8)
- `pool-cooldown.js` — cooldown system
- `pool-memory.js` — pool deploy history
- `lessons.js` — performance recording + cooldown trigger
- `hivemind.js` — HiveMind sync (lessons/presets only, NOT close decisions)

### Critical Backups

~/secure-backup/private_key.pem.backup
~/secure-backup/public_key.pem.backup
~/projects/meridian/state.json.backup-pre-r4.1-20260507-001439
~/projects/meridian/state.json.backup-pre-merge-20260510-011117

### Production Logs Location
- `logs/agent-YYYY-MM-DD.log` — main runtime log
- `logs/actions-YYYY-MM-DD.jsonl` — structured action audit trail

---

## ⚠️ DO NOT DO THESE (Until Conflicts Resolved)

- ❌ `npm start` (will crash from SyntaxError in conflict files)
- ❌ Restart bot screen (same reason)
- ❌ `pm2 restart` if applicable
- ❌ `git merge --abort` (loses progress, but option if recovery needed)
- ❌ `git reset --hard` (unless emergency rollback)
- ❌ Edit conflict files via editor without strategy
- ❌ `git add -A` then commit (will commit unresolved conflicts)
- ❌ Force push to upstream (you don't have push rights anyway, but defensive)

---

## ✅ SAFE TO DO ANYTIME

- ✅ `git status`, `git log`, `git diff` (read-only)
- ✅ `git show <ref>:<file>` to inspect file at any commit
- ✅ `cat`, `less`, `head`, `tail` on files
- ✅ `node --check <file>` to verify syntax
- ✅ `grep` patterns
- ✅ Telegram commands (bot responds from memory)
- ✅ Read logs

---

## 🎯 SUCCESS CRITERIA

The handover is successful when:
1. All 7 conflict files resolved with R-implementations preserved
2. All 9 auto-merged files audited (no silent R-logic loss)
3. Syntax check passes on all .js files
4. Merge commit created with detailed message
5. Push to fork (origin) succeeds
6. Bot restarts cleanly
7. First 30 minutes post-restart show no errors
8. R-implementations still function (trailing 3s window, Safety-Lock, Pump-Hold)
9. Owner improvements integrated (PM2, Discord signals, etc.)
10. Branch `feat/r8-indicator-aware-close` ready for R8 implementation

---

## 📞 IF STUCK

If at any point recovery is needed:

```bash
# Nuclear option — abort merge, return to checkpoint
git merge --abort
# Working tree returns to commit 3cd16a3
# All R-implementations preserved
# 11 owner commits NOT integrated
# Can re-attempt merge later

# Or full reset
git reset --hard 3cd16a3
cp state.json.backup-pre-merge-20260510-011117 state.json

# Bot can restart safely from checkpoint state
```

The checkpoint commit `3cd16a3` is the safety net. Everything before that is preserved on disk and pushable to fork (after `--force-with-lease` if needed, since fork has owner commits ahead).

---

## 🤖 CONTEXT FOR NEW AI ASSISTANT

If you're a new AI session reading this:

1. The user has been working with Claude (Sonnet) for ~2 weeks on R1-R10 refactor
2. All R-implementations were verified in production with logs/data evidence
3. The user is doing a model migration (Claude → MiMo) mid-merge
4. Treat the user's R-implementations as production-critical assets — DO NOT lose them in merge
5. The user prefers data-driven decisions and step-by-step verification
6. Bot still running from memory means there is buffer time, but DON'T let the user accidentally restart bot before merge complete
7. Read `docs/CLOSE_RULES_REFACTOR.md` in repo for full historical context
8. Resume with Phase A (Investigation) above

Good luck.

