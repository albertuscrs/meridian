import "./envcrypt.js";
import cron from "node-cron";
import readline from "readline";
import { createReadStream } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { agentLoop } from "./agent.js";
import { log, rotateOldLogs } from "./logger.js";
import { getMyPositions, closePosition, getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates, degenScore } from "./tools/screening.js";
import { formatGmgnCandidateForPrompt } from "./tools/gmgn.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary, getPerformanceHistory, listLessons } from "./lessons.js";
import { executeTool, registerCronRestarter, findUnknownUserConfigKeys } from "./tools/executor.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  sendMessageWithButtons,
  sendHTML,
  editMessage,
  editMessageWithButtons,
  answerCallbackQuery,
  notifyOutOfRange,
  isEnabled as telegramEnabled,
  createLiveMessage,
  fmtRangeBar,
  saveAllowedUserId,
} from "./telegram.js";
import {
  checkRelay,
  checkHiveMind,
  checkGmgnIndicators,
  checkJupiter,
  checkMeteora,
  checkSolanaRpc,
  checkAllApis,
  formatApiStatus,
} from "./tools/api-monitor.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, getTrackedPositions, setPositionInstruction, updatePnlAndCheckExits, confirmPeak, registerExitSignal, archiveClosedPositions } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recallForPool, addPoolNote, getRecentDeploys, getPoolMemory } from "./pool-memory.js";
import { blockDev, unblockDev, listBlockedDevs } from "./dev-blocklist.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { stageSignals } from "./signal-tracker.js";
import { getWeightsSummary } from "./signal-weights.js";
import { bootstrapHiveMind, ensureAgentId, getHiveMindPullMode, isHiveMindEnabled, pullHiveMindLessons, pullHiveMindPresets, registerHiveMindAgent, startHiveMindBackgroundSync } from "./hivemind.js";
import { appendDecision } from "./decision-log.js";

import { REPO_ROOT, repoPath } from "./repo-root.js";

const entrypointPath = process.env.pm_exec_path || process.argv[1];
const indexPath = fileURLToPath(import.meta.url);
const isMain = process.env.pm_id != null
  || (entrypointPath ? path.resolve(entrypointPath) === indexPath : false);

if (isMain) {
  log("startup", "DLMM LP Agent starting...");
  rotateOldLogs();
  try { archiveClosedPositions(); } catch (e) { log("startup_warn", `Position archive failed: ${e.message}`); }
  try {
    const unknownKeys = findUnknownUserConfigKeys();
    if (unknownKeys.length > 0) log("startup_warn", `user-config.json has unknown keys (not read by anything): ${unknownKeys.join(", ")}`);
  } catch (e) { log("startup_warn", `Config key validation failed: ${e.message}`); }
  log("startup", `Repo: ${REPO_ROOT} | cwd: ${process.cwd()}${process.env.pm_id ? ` | PM2 id: ${process.env.pm_id}` : ""}`);
  if (path.resolve(process.cwd()) !== path.resolve(REPO_ROOT)) {
    log("startup_warn", `process.cwd() differs from repo root — use "npm run pm2:start" (not "pm2 start index.js" from another directory)`);
  }
  log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
  log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);
  ensureAgentId();
  bootstrapHiveMind().catch((error) => log("hivemind_warn", `Bootstrap failed: ${error.message}`));
  startHiveMindBackgroundSync();
}

const TP_PCT = config.management.takeProfitPct;
const DEPLOY = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
let _pollTriggeredAt = 0; // epoch ms — cooldown for poller-triggered management
const _peakConfirmTimers = new Map();
const _trailingDropConfirmTimers = new Map();
const TRAILING_PEAK_CONFIRM_DELAY_MS = 15_000;
const TRAILING_PEAK_CONFIRM_TOLERANCE = 0.85;
const TRAILING_DROP_CONFIRM_DELAY_MS = 15_000;
const TRAILING_DROP_CONFIRM_DELAY_MS_PECUT = 3_000;
const TRAILING_DROP_CONFIRM_TOLERANCE_PCT = 1.0;
// Exit/peak confirmation is now done by consecutive-tick counting in state.js
// (registerExitSignal / confirmPeak), driven by the 3s RPC poller — no setTimeout rechecks.

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function htmlEscape(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeUntrustedPromptText(text, maxLen = 500) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}

function shouldUsePnlRecheck() {
  return !config.api.lpAgentRelayEnabled;
}

function schedulePeakConfirmation(positionAddress) {
  if (!positionAddress || _peakConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _peakConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      resolvePendingPeak(positionAddress, position?.pnl_pct ?? null, TRAILING_PEAK_CONFIRM_TOLERANCE);
    } catch (error) {
      log("state_warn", `Peak confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_PEAK_CONFIRM_DELAY_MS);

  _peakConfirmTimers.set(positionAddress, timer);
}

function scheduleTrailingDropConfirmation(positionAddress) {
  if (!positionAddress || _trailingDropConfirmTimers.has(positionAddress)) return;

  const profile = config.management.closeProfile ?? "main";
  const confirmDelayMs = profile === "pecut" ? TRAILING_DROP_CONFIRM_DELAY_MS_PECUT : TRAILING_DROP_CONFIRM_DELAY_MS;

  const timer = setTimeout(async () => {
    _trailingDropConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      const resolved = resolvePendingTrailingDrop(
        positionAddress,
        position?.pnl_pct ?? null,
        config.management.trailingDropPct,
        TRAILING_DROP_CONFIRM_TOLERANCE_PCT,
        `${confirmDelayMs / 1000}s`,
      );
      if (resolved?.confirmed) {
        log("state", `[Trailing recheck] Confirmed trailing exit for ${positionAddress} — triggering management (window: ${confirmDelayMs}ms)`);
        runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Trailing recheck management failed: ${e.message}`));
      }
    } catch (error) {
      log("state_warn", `Trailing drop confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, confirmDelayMs);

  _trailingDropConfirmTimers.set(positionAddress, timer);
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  if (_cronTasks._opportunityPollInterval) clearInterval(_cronTasks._opportunityPollInterval);
  _cronTasks = [];
}

/**
 * Execute the actions decided by the deterministic rules. CLOSE/CLAIM run directly
 * via executeTool (no LLM) — preserving all post-effects (notify, auto-swap,
 * recordPerformance, decision-log, HiveMind). Only INSTRUCTION positions, whose
 * free-text condition JS can't parse, are handed to the MANAGER LLM. Returns a
 * one-line-per-position result string.
 */
async function executeManagementActions(actionPositions, actionMap, { liveMessage = null, cur = "$" } = {}) {
  const lines = [];
  const instructionPositions = [];

  const mechanical = actionPositions.filter(p => actionMap.get(p.position).action !== "INSTRUCTION");
  if (mechanical.length) {
    log("cron", `Management: executing ${mechanical.length} mechanical action(s) — no LLM`);
  }

  for (const p of actionPositions) {
    const act = actionMap.get(p.position);
    if (act.action === "INSTRUCTION") { instructionPositions.push(p); continue; }

    if (act.action === "CLOSE") {
      const reason = act.reason || (act.rule ? `Rule ${act.rule}` : "rule close");
      await liveMessage?.toolStart("close_position");
      const res = await executeTool("close_position", { position_address: p.position, reason }).catch(e => ({ error: e.message }));
      const ok = res?.success !== false && !res?.error && !res?.blocked;
      await liveMessage?.toolFinish("close_position", res, ok);
      lines.push(`${p.pair}: ${ok ? `closed (${reason})` : `close FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    } else if (act.action === "CLAIM") {
      await liveMessage?.toolStart("claim_fees");
      const res = await executeTool("claim_fees", { position_address: p.position }).catch(e => ({ error: e.message }));
      const ok = res?.success !== false && !res?.error && !res?.blocked;
      await liveMessage?.toolFinish("claim_fees", res, ok);
      lines.push(`${p.pair}: ${ok ? "fees claimed" : `claim FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    }
  }

  // INSTRUCTION positions need the LLM to evaluate the free-text condition.
  if (instructionPositions.length > 0) {
    log("cron", `Management: ${instructionPositions.length} instruction position(s) — invoking LLM [model: ${config.llm.managementModel}]`);
    const actionBlocks = instructionPositions.map((p) => [
      `POSITION: ${p.pair} (${p.position})`,
      `  pool: ${p.pool}`,
      `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
      `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
      `  instruction: "${p.instruction}"`,
    ].join("\n")).join("\n\n");

    const { content } = await agentLoop(`
INSTRUCTION EVALUATION — ${instructionPositions.length} position(s)

${actionBlocks}

For each position, evaluate the instruction condition against the live data:
- If the condition is MET → call close_position (it claims fees internally; do NOT call claim_fees first).
- If NOT met → HOLD, do nothing.

After evaluating, write a brief one-line result per position.
    `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    if (content) lines.push(content);
  }

  return lines.join("\n");
}

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;

  // Skip RPC round-trip if state shows no open positions
  if (getTrackedPositions(true).length === 0) {
    const screenCooldownMs = config.schedule.screeningIntervalMin * 60 * 1000;
    const sinceLastScreen = timers.screeningLastRun ? Date.now() - timers.screeningLastRun : Infinity;
    if (sinceLastScreen >= screenCooldownMs) {
      log("cron", "No open positions (state) — skipping management, triggering screening");
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    } else {
      const remainingMin = Math.ceil((screenCooldownMs - sinceLastScreen) / 60000);
      log("cron", `No open positions (state) — skipping management, screening cooldown (${remainingMin}m left)`);
    }
    return "No open positions. Triggering screening cycle.";
  }

  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];
  let liveMessage = null;
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...");
    }
    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      const screenCooldownMs = config.schedule.screeningIntervalMin * 60 * 1000;
      const sinceLastScreen = timers.screeningLastRun ? Date.now() - timers.screeningLastRun : Infinity;
      if (sinceLastScreen >= screenCooldownMs) {
        log("cron", "No open positions — triggering screening cycle");
        mgmtReport = "No open positions. Triggering screening cycle.";
        runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      } else {
        const remainingMin = Math.ceil((screenCooldownMs - sinceLastScreen) / 60000);
        log("cron", `No open positions — screening cooldown (${remainingMin}m left)`);
        mgmtReport = `No open positions. Screening cooldown (${remainingMin}m left).`;
      }
      return mgmtReport;
    }

    // Snapshot + load pool memory
    const positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      return { ...p, recall: recallForPool(p.pool) };
    });

    // ── R8: Pre-fetch indicator data for OOR positions (intentional local edit) ──
    const indicatorData = new Map();
    if (config.management.r8IndicatorCheck && config.indicators.enabled) {
      const { confirmIndicatorPreset } = await import("./tools/chart-indicators.js");
      for (const p of positionData) {
        if (p.in_range === false && p.base_mint) {
          try {
            const result = await confirmIndicatorPreset({
              mint: p.base_mint,
              side: "exit",
              preset: config.management.r8ExitPreset,
            });
            indicatorData.set(p.position, result);
          } catch (e) {
            log("indicators_warn", `R8 pre-fetch failed for ${p.pair}: ${e.message}`);
          }
        }
      }
      if (indicatorData.size > 0) {
        log("cron", `R8: pre-fetched indicators for ${indicatorData.size} OOR position(s)`);
      }
    }

    // JS exit checks. Management is the slow cron backstop: raise peak immediately
    // (confirmTicks=1) and act on detected exits directly. Real-time 2-tick
    // confirmation lives in the fast 3s poller below.
    const exitMap = new Map();
    for (const p of positionData) {
      confirmPeak(p.position, p.pnl_pct, 1);
      const exit = updatePnlAndCheckExits(p.position, p, config.management, indicatorData.get(p.position));
      if (exit) {
        if (exit.action === "TRAILING_TP_QUEUED") {
          scheduleTrailingDropConfirmation(p.position);
          continue;
        }

        exitMap.set(p.position, exit.reason);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM)
    const actionMap = new Map();
    for (const p of positionData) {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) });
        continue;
      }
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      const closeRule = getDeterministicCloseRule(p, config.management);
      if (closeRule) {
        actionMap.set(p.position, closeRule);
        continue;
      }
      // Claim rule
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

      const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const cur = config.management.solMode ? "◎" : "$";
      const pnlSign = (p.pnl_pct ?? 0) >= 0 ? "+" : "";
      const pnlPctStr = `${pnlSign}${(p.pnl_pct ?? 0).toFixed(1)}%`;
      const pnlUsdStr = (p.pnl_usd ?? 0) >= 0 ? `+${cur}${(p.pnl_usd ?? 0).toFixed(3)}` : `-${cur}${(Math.abs(p.pnl_usd) ?? 0).toFixed(3)}`;
      const range = fmtRangeBar(p.active_bin, p.lower_bin, p.upper_bin);
      const rangeEmoji = range.oor ? "🔴" : "🟢";
      const rangeLabel = range.oor
        ? `${range.bar} bin ${p.active_bin} (${range.oor} ${p.lower_bin}–${p.upper_bin})`
        : `${range.bar} ${range.pct}% (bin ${p.active_bin}/${p.lower_bin}–${p.upper_bin})`;
      const val = `${cur}${(p.total_value_usd ?? 0).toFixed(3)}`;
      const unclaimed = `${cur}${(p.unclaimed_fees_usd ?? 0).toFixed(3)}`;
      const feeStr24h = p.fee_per_tvl_24h != null ? `${p.fee_per_tvl_24h.toFixed(2)}%/24h` : "—";
      const feeBar = feeTvlBar(p.fee_per_tvl_24h);
      const ageStr = fmtAge(p.age_minutes);
      const rangeLine = p.in_range ? "🟢 IN" : `🔴 OOR ${fmtAge(p.minutes_out_of_range ?? 0)}`;
      const statusEmoji = positionStatusEmoji(p);
      const actionTag = act.action === "INSTRUCTION" ? "📋 HOLD" :
                        act.action === "CLOSE" ? "⚡ CLOSE" :
                        act.action === "CLAIM" ? "📥 CLAIM" : "";

      const block = [`${statusEmoji} <b>${htmlEscape(p.pair)}</b> | ${p.strategy ?? "spot"}`,
        `   💰 ${val} | PnL: ${pnlPctStr} (${pnlUsdStr})`,
        `   📍 ${rangeEmoji} ${rangeLabel} | ⏱ ${ageStr}`,
        `   📈 ${feeBar} ${feeStr24h} | 📥 ${unclaimed} unclaimed`,
        `   ${rangeLine}${actionTag ? ` | ${actionTag}` : ""}`,
      ];

      if (p.instruction) block.push(`   📝 "${htmlEscape(p.instruction)}"`);
      if (act.action === "CLOSE") block.push(`   ⚡ ${htmlEscape(act.reason)}`);
      if (act.action === "CLAIM") block.push(`   📥 Claiming fees`);

      return block.join("\n");
    });

    const stayCount = [...actionMap.values()].filter(a => a.action === "STAY").length;
    const oorCount = positionData.filter(p => !p.in_range).length;
    const profitableCount = positionData.filter(p => (p.pnl_pct ?? 0) > 0).length;
    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL" : a.action).join(", ")
      : "none";
    const avgPnl = positionData.reduce((s, p) => s + (p.pnl_pct ?? 0), 0) / (positionData.length || 1);
    const avgFee24h = positionData.reduce((s, p) => s + (p.fee_per_tvl_24h ?? 0), 0) / (positionData.length || 1);
    const avgSign = avgPnl >= 0 ? "+" : "";
    const cur = config.management.solMode ? "◎" : "$";

    mgmtReport =
      reportLines.join("\n\n") +
      `\n\n─────────────` +
      `\n📦 ${positions.length} positions | ${profitableCount}🟢 ${oorCount}🔴 | 💵 ${cur}${totalValue.toFixed(3)}` +
      `\n📊 Avg PnL: ${avgSign}${avgPnl.toFixed(2)}% | 📈 Avg fee/TVL: ${avgFee24h.toFixed(2)}%/24h | 📥 ${cur}${totalUnclaimed.toFixed(3)} unclaimed` +
      `\n🔔 Action: ${actionSummary} | ✅ Stay: ${stayCount}`;

    // ── Direct-close hard exits (skip LLM for speed) ─────────────────
    // Stop-loss, trailing TP, and other updatePnlAndCheckExits triggers are
    // already fully decided — no LLM judgment needed. Execute immediately to
    // minimise the gap between SL detection and actual close/swap execution.
    const hardExitPositions = positionData.filter(p => actionMap.get(p.position)?.rule === "exit");
    if (hardExitPositions.length > 0) {
      log("cron", `Management: ${hardExitPositions.length} hard exit(s) — bypassing LLM`);
      const hardCloseResults = await Promise.allSettled(
        hardExitPositions.map(async (p) => {
          const reason = exitMap.get(p.position);
          await liveMessage?.toolStart("close_position");
          const result = await executeTool("close_position", { position_address: p.position, reason });
          await liveMessage?.toolFinish("close_position", result, result?.success !== false);
          return { pair: p.pair, reason, result };
        })
      );
      const hardSummary = hardCloseResults.map((r) => {
        if (r.status === "fulfilled") {
          const { pair, reason, result } = r.value;
          return result?.success === false
            ? `⚡ ${htmlEscape(pair)} close FAILED: ${htmlEscape(result.error || "unknown error")}`
            : `⚡ ${htmlEscape(pair)} closed — ${htmlEscape(reason)}`;
        }
        return `⚡ close error: ${htmlEscape(r.reason?.message || String(r.reason))}`;
      });
      mgmtReport += `\n\n${hardSummary.join("\n")}`;
    }

    // ── Call LLM only if non-hard actions needed ──────────────────────
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY" && a?.rule !== "exit"; // hard exits already handled above
    });

    if (actionPositions.length > 0) {
      const execReport = await executeManagementActions(actionPositions, actionMap, { liveMessage, cur });
      if (execReport) mgmtReport += `\n\n${execReport}`;
    } else {
      log("cron", "Management: all positions STAY — skipping");
      await liveMessage?.note("No tool actions needed.");
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    if (!silent && telegramEnabled()) {
      if (mgmtReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport)).catch(() => {});
        else sendHTML(`🔄 <b>Management Cycle</b>\n\n${stripThink(mgmtReport)}`).catch(() => { });
      }
      for (const p of positions) {
        if (!p.in_range) {
          const oorAbove = p.active_bin != null && p.upper_bin != null && p.active_bin > p.upper_bin;
          const threshold = oorAbove
            ? config.management.outOfRangeWaitMinutes
            : config.management.outOfRangeBelowWaitMinutes;
          if (p.minutes_out_of_range >= threshold) {
            notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => { });
          }
        }
      }
    }
  }
  return mgmtReport;
}

export async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`,
      });
      _screeningBusy = false;
      return screenReport;
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    const isDryRun = process.env.DRY_RUN === "true";
    if (!isDryRun && preBalance.sol < minRequired) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired})`,
      });
      _screeningBusy = false;
      return screenReport;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    screenReport = `Screening pre-check failed: ${e.message}`;
    _screeningBusy = false;
    return screenReport;
  }
  if (!silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    const deployAmount = computeDeployAmount(currentBalance.sol);
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    // Load active strategy
    const activeStrategy = getActiveStrategy();
    const deployStrategy = config.strategy.strategy;
    const strategyBlock = `DEPLOY STRATEGY: ${deployStrategy} (from config) | bins_above: 0 (FIXED — never change) | deposit: SOL only (amount_y, amount_x=0)`
      + (activeStrategy ? `\nSTRATEGY CONTEXT: ${activeStrategy.name} — entry: ${activeStrategy.entry?.condition || "n/a"} | exit: ${activeStrategy.exit?.notes || "n/a"} | best for: ${activeStrategy.best_for}` : "");

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const topCandidates = await getTopCandidates({ limit: 10 }).catch((e) => ({ _error: e.message }));
    if (topCandidates?._error) {
      screenReport = `Screening failed: ${topCandidates._error}`;
      return screenReport;
    }
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);
    const earlyFilteredExamples = topCandidates?.filtered_examples || [];
    const gmgnStageCounts = topCandidates?.stage_counts ?? null;
    const gmgnAllFiltered = topCandidates?.all_filtered ?? [];

    const allCandidates = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
      ]);
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        mem: recallForPool(pool.pool),
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    // Hard filters after token recon — block launchpads and excessive Jupiter bot holders
    // GMGN candidates: launchpad filtering done upstream in Stage 2 (gmgn.js)
    // Meteora candidates: launchpad filtering done here
    const filteredOut = [];
    const passing = allCandidates.filter(({ pool, ti }) => {
      if (pool.gmgn) return true;
      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.allowedLaunchpads?.length > 0 && !config.screening.allowedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — launchpad ${launchpad} not in allow-list`);
        filteredOut.push({ name: pool.name, reason: `launchpad ${launchpad} not in allow-list` });
        return false;
      }
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
        filteredOut.push({ name: pool.name, reason: `blocked launchpad (${launchpad})` });
        return false;
      }
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
        filteredOut.push({ name: pool.name, reason: `bot holders ${botPct}% > ${maxBotHoldersPct}%` });
        return false;
      }
      return true;
    });

    if (passing.length === 0) {
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 5)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      const funnelBlock = buildGmgnFunnelReport(gmgnStageCounts, gmgnAllFiltered, { fromStage: 2 });
      const thresholds = `Thresholds: tvl>$${config.screening.minTvl} | vol>$${config.screening.minVolume} | organic>${config.screening.minOrganic}% | holders>${config.screening.minHolders} | fee/tvl>${config.screening.minFeeActiveTvlRatio}%`;
      screenReport = funnelBlock
        ? `No candidates available.\n\n${funnelBlock}`
        : combinedExamples
          ? `No candidates available.\nFiltered examples:\n${combinedExamples}`
          : `No candidates available (all filtered).\n${thresholds}`;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "No candidates available",
        reason: funnelBlock || combinedExamples || "All candidates filtered before deploy",
        rejected: combined.slice(0, 5).map((entry) => `${entry.name}: ${entry.reason}`),
      });
      return screenReport;
    }

    if (passing.length <= 1 && gmgnStageCounts) {
      const funnelBlock = buildGmgnFunnelReport(gmgnStageCounts, gmgnAllFiltered, { fromStage: 2 });
      if (funnelBlock) log("screening", `GMGN funnel (sparse):\n${funnelBlock}`);
    }

    if (passing.length === 1) {
      const skipReason = getLoneCandidateSkipReason(passing[0]);
      if (skipReason) {
        const candidateName = passing[0].pool?.name || "unknown";
        const funnelBlock = buildGmgnFunnelReport(gmgnStageCounts, gmgnAllFiltered, { fromStage: 2 });
        screenReport = [
          "⛔ NO DEPLOY",
          "",
          "Cycle finished with no valid entry.",
          "",
          "BEST LOOKING CANDIDATE",
          candidateName,
          "",
          "WHY SKIPPED",
          `Only one candidate survived filtering, but it was not worth deploying: ${skipReason}.`,
          "",
          "REJECTED",
          `- ${candidateName}: ${skipReason}`,
          funnelBlock ? `\n─────────────\n${funnelBlock}` : null,
        ].filter(Boolean).join("\n");
        appendDecision({
          type: "no_deploy",
          actor: "SCREENER",
          summary: "Single candidate skipped",
          reason: skipReason,
          pool: passing[0].pool?.pool,
          pool_name: candidateName,
        });
        return screenReport;
      }
    }

    // Pre-fetch active_bin for all passing candidates in parallel
    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    // Build compact candidate blocks
    const candidateBlocks = passing.map(({ pool, sw, n, ti, mem }, i) => {
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

      const pvpLine = pool.is_pvp
        ? `  pvp: HIGH — rival ${pool.pvp_rival_name || pool.pvp_symbol} (${pool.pvp_rival_mint?.slice(0, 8)}...) has pool ${pool.pvp_rival_pool?.slice(0, 8)}..., tvl=$${pool.pvp_rival_tvl}, holders=${pool.pvp_rival_holders}, fees=${pool.pvp_rival_fees}SOL`
        : null;
      let block;
      if (pool.gmgn) {
        block = [
          `POOL: ${pool.name} (${pool.pool})`,
          formatGmgnCandidateForPrompt(pool),
          pvpLine,
          `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
          activeBin != null ? `  active_bin: ${activeBin}` : null,
          n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
          mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
        ].filter(Boolean).join("\n");
      } else {
        const gmgnPriceLine = pool.gmgn_price_action
          ? `  gmgn_price: rsi2=${pool.gmgn_price_action.rsi2 ?? "?"}, supertrend=${pool.gmgn_price_action.supertrend?.direction || "?"}, price_vs_ath=${pool.gmgn_price_action.priceVsAthPct ?? "?"}%, 1h_change=${pool.gmgn_price_action.priceChangePct ?? "?"}%, max_vol_candle=${pool.gmgn_price_action.maxVolumeShare ?? "?"}%`
          : null;
        block = [
          `POOL: ${pool.name} (${pool.pool})`,
          `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.tvl ?? pool.active_tvl}, volatility_${pool.volatility_timeframe || "30m"}=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
          `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
          gmgnPriceLine,
          pvpLine,
          `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
          activeBin != null ? `  active_bin: ${activeBin}` : null,
          priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
          n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
          mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
        ].filter(Boolean).join("\n");
      }

      // Stage signals for Darwinian weighting — captured before LLM decides
      if (config.darwin?.enabled) {
        const baseMint = pool.base?.mint || pool.base_mint || ti?.mint || null;
        stageSignals(pool.pool, {
          base_mint:             baseMint,
          organic_score:         pool.organic_score         ?? null,
          fee_tvl_ratio:         pool.fee_active_tvl_ratio  ?? null,
          volume:                pool.volume_window         ?? null,
          mcap:                  pool.mcap                  ?? null,
          holder_count:          ti?.holders                ?? null,
          smart_wallets_present: (sw?.in_pool?.length ?? 0) > 0,
          narrative_quality:     n?.narrative ? "present" : "absent",
          volatility:            pool.volatility            ?? null,
        });
      }

      return block;
    });

    const weightsSummary = config.darwin?.enabled ? getWeightsSummary() : null;

    let deployAttempted = false;
    let deploySucceeded = false;
    const { content } = await agentLoop(`
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateBlocks.join("\n\n")}

STEPS:
1. Decide whether any candidate is worth deploying. A single remaining candidate is not automatically good enough.
2. Pick the best candidate only if it has real conviction from narrative quality, smart wallets, and pool metrics. If the list has only one pool and it lacks narrative or smart-wallet confirmation, skip the cycle.
3. If a pool qualifies, call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   strategy = ${config.strategy.strategy} (always use this, never change it).
   bins_below = round(${config.strategy.minBinsBelow} + (candidate volatility/5)*${config.strategy.maxBinsBelow - config.strategy.minBinsBelow}) clamped to [${config.strategy.minBinsBelow},${config.strategy.maxBinsBelow}].
   pass deploy_position.volatility = the candidate volatility value.
   bins_above = ${config.strategy.binsAbove}. Single-side SOL only: set amount_y, keep amount_x = 0.
4. Report in this exact format (no tables, no extra sections):
   🚀 DEPLOYED

   <pool name>
   <pool address>

   ◎ <deploy amount> SOL | <strategy> | bin <active_bin>
   Range: <minPrice> → <maxPrice>
   Range cover: <downside %> downside | <upside %> upside | <total width %> total

   IMPORTANT:
   - Do NOT calculate the range percentages yourself.
   - Use the actual deploy_position tool result:
     range_coverage.downside_pct
     range_coverage.upside_pct
     range_coverage.width_pct

   MARKET
   Fee/TVL: <x>%
   Volume: $<x>
   TVL: $<x>
   Volatility: <x>
   Organic: <x>
   Mcap: $<x>
   Age: <x>h

   AUDIT
   Top10: <x>%
   Bots: <x>%
   Fees paid: <x> SOL
   Smart wallets: <names or none>

   WHY THIS WON
   <2-4 concise sentences on why this pool won, key risks, and why it still beat the alternatives>
5. If no pool qualifies, report in this exact format instead:
   ⛔ NO DEPLOY

   Cycle finished with no valid entry.

   BEST LOOKING CANDIDATE
   <name or none>

   WHY SKIPPED
   <2-4 concise sentences explaining why nothing was good enough>

   REJECTED
   <short flat list of top candidate names and why they were skipped>
IMPORTANT:
- Keep the whole report compact and highly scannable for Telegram.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 4096, {
        allowSkip: true,
        onToolStart: async ({ name }) => {
          if (name === "deploy_position") deployAttempted = true;
          await liveMessage?.toolStart(name);
        },
        onToolFinish: async ({ name, result, success }) => {
          if (name === "deploy_position") {
            deployAttempted = true;
            deploySucceeded = Boolean(success && result?.success !== false && !result?.error && !result?.blocked);
          }
          await liveMessage?.toolFinish(name, result, success);
        },
      });
    const funnelAppend = buildGmgnFunnelReport(gmgnStageCounts, gmgnAllFiltered, { fromStage: 2 });
    screenReport = funnelAppend ? `${content}\n\n─────────────\n${funnelAppend}` : content;
    if (/⛔\s*NO DEPLOY/i.test(content)) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "LLM chose no deploy",
        reason: stripThink(content).slice(0, 500),
      });
    } else if (!deploySucceeded) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: deployAttempted ? "Deploy attempt did not succeed" : "No successful deploy in screening cycle",
        reason: stripThink(content).slice(0, 500),
      });
    }
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _screeningBusy = false;
    if (!silent && telegramEnabled()) {
      if (screenReport) {
        if (liveMessage) await liveMessage.finalize(htmlEscape(stripThink(screenReport))).catch(() => {});
        else sendHTML(`🔍 <b>Screening Cycle</b>\n\n${htmlEscape(stripThink(screenReport))}`).catch(() => { });
      }
    }
  }
  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    try { archiveClosedPositions(); } catch (e) { log("cron_error", `Position archive failed: ${e.message}`); }
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Fast PnL poller — the real-time exit path between management cycles, no LLM.
  // Runs on public infra (RPC + Jupiter + Meteora deposits) so it can poll aggressively.
  // Exits require `confirmTicks` consecutive confirming polls (registerExitSignal) so a
  // single noisy tick can't close a position; confirmed exits close DIRECTLY here (no
  // management-interval cooldown gate that used to swallow rule hits).
  const pnlPollMs = Math.max(1, Number(config.pnl.pollIntervalSec ?? 3)) * 1000;
  const confirmTicks = Math.max(1, Number(config.pnl.confirmTicks ?? 2));
  let _pnlPollBusy = false;
  const pnlPollInterval = setInterval(async () => {
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    if (getTrackedPositions(true).length === 0) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions?.length) return;
      for (const p of result.positions) {
        // Peak confirmation with PnL Poll Gap emergency floor check (local edit).
        // Must run BEFORE any 2-tick confirmation gate so a descending PnL that
        // breaches `emergencyClosePct` fires immediately, bypassing cooldown.
        const peakResult = confirmPeak(p.position, p.pnl_pct, confirmTicks, {
          emergencyClosePct: config.management.emergencyClosePct,
          closeProfile: config.management.closeProfile,
        });
        if (peakResult?.emergency) {
          _pollTriggeredAt = 0; // bypass cooldown — close immediately
          log("state", `[PnL poll] Emergency close: ${p.pair} — ${peakResult.reason}`);
          _managementBusy = true;
          try {
            const actMap = new Map([[p.position, { action: "CLOSE", rule: "EMERGENCY", reason: peakResult.reason }]]);
            await executeManagementActions([p], actMap, {});
          } catch (e) {
            log("cron_error", `Emergency close failed: ${e.message}`);
          } finally {
            _managementBusy = false;
          }
          break; // one action per tick
        }

        // Detect an exit signal this tick (rule-based exits, then deterministic close rules).
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        const closeRule = exit ? null : getDeterministicCloseRule(p, config.management);
        let signal = null, reason = null, rule = "exit";
        if (exit) { signal = exit.action; reason = exit.reason; }
        else if (closeRule) { signal = `RULE_${closeRule.rule}`; reason = closeRule.reason; rule = closeRule.rule; }

        // Require N consecutive confirming ticks before acting.
        const { fire } = registerExitSignal(p.position, signal, confirmTicks);
        if (!signal || !fire) continue;

        log("state", `[PnL poll] ${signal} confirmed (${confirmTicks} ticks): ${p.pair} — ${reason} — closing directly`);
        // Hold the management lock so the cron cycle can't double-act on this position.
        _managementBusy = true;
        try {
          const actMap = new Map([[p.position, { action: "CLOSE", rule, reason }]]);
          const rpt = await executeManagementActions([p], actMap, {});
          log("state", `[PnL poll] ${p.pair}: ${rpt || "closed"}`);
        } catch (e) {
          log("cron_error", `Poll-triggered close failed: ${e.message}`);
        } finally {
          _managementBusy = false;
        }
        break; // one action per tick
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, pnlPollMs);

  // Opportunity poller — catches strong pools between the (slow) screening cycles.
  // Reuses the getTopCandidates pipeline (discovery + holder audit + filters + score);
  // when the best candidate clears the score pre-gate it triggers the existing screening
  // deploy decision (runScreeningCycle), which re-checks guards and forces the deploy LLM.
  let opportunityPollInterval = null;
  if (config.opportunity.enabled) {
    const oppMs = Math.max(15, Number(config.opportunity.pollIntervalSec ?? 45)) * 1000;
    const oppCooldownMs = 5 * 60 * 1000; // don't re-trigger the deploy LLM more than every 5m
    let _opportunityPollBusy = false;
    opportunityPollInterval = setInterval(async () => {
      if (_screeningBusy || _managementBusy || _opportunityPollBusy) return;
      if (Date.now() - _screeningLastTriggered < oppCooldownMs) return;
      _opportunityPollBusy = true;
      try {
        const [positions, balance] = await Promise.all([
          getMyPositions({ force: true, silent: true }).catch(() => null),
          getWalletBalances().catch(() => null),
        ]);
        if (!positions || (positions.total_positions ?? 0) >= config.risk.maxPositions) return;
        const minRequired = config.management.deployAmountSol + config.management.gasReserve;
        if (process.env.DRY_RUN !== "true" && (!balance || balance.sol < minRequired)) return;

        const top = await getTopCandidates({ limit: config.opportunity.limit }).catch(() => null);
        const candidates = (top?.candidates || []).slice().sort((a, b) => degenScore(b, config.opportunity) - degenScore(a, config.opportunity));
        if (!candidates.length) return;

        const minScore = config.opportunity.minScore;
        const bonus = Number(config.opportunity.smartWalletScoreBonus ?? 0);
        const floor = minScore - bonus; // lowest degen that could qualify, only WITH a smart wallet

        // A pool qualifies if degen >= minScore, OR it's borderline (floor..minScore) AND a
        // tracked smart wallet sits on it (checkSmartWalletsOnPool, on-chain positions of our
        // tracked KOL list). The smart-wallet lookup runs only for borderline pools to keep
        // the 45s poll cheap.
        let trigger = null;
        for (const c of candidates) {
          const s = degenScore(c, config.opportunity);
          if (s < floor) break; // sorted desc — nothing below can qualify either
          if (s >= minScore) { trigger = { c, s, smart: [] }; break; }
          if (bonus <= 0) continue; // borderline but smart-wallet rescue disabled
          const smart = (await checkSmartWalletsOnPool({ pool_address: c.pool }).catch(() => null))?.in_pool || [];
          if (smart.length > 0) { trigger = { c, s, smart }; break; }
        }
        if (!trigger) return;

        const smartTag = trigger.smart.length
          ? ` + smart wallet [${trigger.smart.map((w) => w.name || w.address?.slice(0, 4)).join(", ")}] (bar lowered ${minScore}→${floor})`
          : "";
        log("cron", `[Opportunity] ${trigger.c.name} degen ${trigger.s.toFixed(1)} >= ${trigger.smart.length ? floor : minScore}${smartTag} — triggering screening deploy decision`);
        runScreeningCycle({ silent: true }).catch((e) => log("cron_error", `Opportunity-triggered screening failed: ${e.message}`));
      } catch (e) {
        log("cron_error", `Opportunity poll failed: ${e.message}`);
      } finally {
        _opportunityPollBusy = false;
      }
    }, oppMs);
  }

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  // Store interval refs so stopCronJobs can clear them
  _cronTasks._pnlPollInterval = pnlPollInterval;
  _cronTasks._opportunityPollInterval = opportunityPollInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m${config.opportunity.enabled ? `, opportunity poll every ${config.opportunity.pollIntervalSec}s` : ""}`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
let _shuttingDown = false;

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function shutdown(signal) {
  if (_shuttingDown) {
    log("shutdown", `Received ${signal} while shutdown is already in progress.`);
    return;
  }
  _shuttingDown = true;

  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  stopCronJobs();

  const positions = await withTimeout(
    getMyPositions({ force: true, silent: true }).catch((error) => {
      log("shutdown", `Position snapshot failed during shutdown: ${error.message}`);
      return null;
    }),
    5000
  );
  if (positions) {
    log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  } else {
    log("shutdown", "Open position snapshot skipped during shutdown timeout");
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

function getDeterministicCloseRule(position, managementConfig) {
  // "main" | "pecut" | "experimental" — governs which variant of each rule applies
  const profile = managementConfig.closeProfile ?? "main";
  const tracked = getTrackedPosition(position.position);
  const pnlSuspect = (() => {
    // Couldn't-price-this-tick flag (e.g. Jupiter outage) — never act on PnL rules.
    if (position.pnl_pct_suspicious) return true;
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    if (tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  // Rule 1: Stop Loss
  // pecut/experimental: LLM-eval path not yet implemented (R3) — falls through to main behaviour
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss", profile };
  }

  // Rule 2: Take Profit
  // pecut: 3s trailing confirm window (R4, not yet implemented — currently 15s for all profiles)
  // experimental: same as pecut
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= managementConfig.takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit", profile };
  }

  // Rule 3: Pump above range
  // pecut/experimental: gated by minProfitPctToCloseOOR (R5 implemented)
  // experimental: additionally PVP rivalry check (R6, not yet implemented)
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose + (tracked?.bin_range?.bins_above ?? 0)
  ) {
    if (profile === "pecut" || profile === "experimental") {
      const minProfitGate = managementConfig.minProfitPctToCloseOOR ?? 0;
      if (position.pnl_pct == null || position.pnl_pct < minProfitGate) {
        log("cron_warn", `Pump-Hold: ${position.position} pumped above range but PnL ${position.pnl_pct != null ? position.pnl_pct.toFixed(2) : "?"}% < ${minProfitGate}% gate — holding (profile: ${profile})`);
        return null;
      }
    }
    return { action: "CLOSE", rule: 3, reason: "pumped far above range", profile };
  }

  // Rule 4 (OOR Stale): owned by updatePnlAndCheckExits in state.js.
  // Removed in R10 to eliminate duplicate engine. Trailing-armed immediate-close
  // behavior was ported there. See state.js Rule 4 block.

  // Rule 5: Low yield
  // All profiles: respect minAgeBeforeYieldCheck (was hardcoded 60 — now configurable, R9 fix)
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= (managementConfig.minAgeBeforeYieldCheck ?? 60)
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield", profile };
  }
  return null;
}

function buildGmgnFunnelReport(stageCounts, allFiltered = [], { fromStage = 1 } = {}) {
  if (!stageCounts) return null;
  const sc = stageCounts;
  const funnel = `GMGN funnel: ranked=${sc.ranked ?? "?"} → S1=${sc.s1 ?? "?"} → S2=${sc.s2 ?? "?"} → S3=${sc.s3 ?? "?"} → S4=${sc.s4 ?? "?"} → final=${sc.s5 ?? "?"}`;
  const byStage = {};
  for (const f of allFiltered) {
    if (f.stage != null && f.stage < fromStage) continue;
    const key = f.stage != null ? `s${f.stage}` : "sfinal";
    if (!byStage[key]) byStage[key] = [];
    byStage[key].push(`${f.name}: ${f.reason}`);
  }
  const stageLabels = { s2: "S2 info", s3: "S3 pool", s4: "S4 indicators", s5: "S5 pick", sfinal: "S-FINAL" };
  const details = Object.entries(byStage)
    .map(([key, items]) => `${stageLabels[key] || key}:\n${items.map(r => `  • ${r}`).join("\n")}`)
    .join("\n");
  return details ? `${funnel}\n\n${details}` : funnel;
}

function getLoneCandidateSkipReason({ pool, sw, n, ti } = {}) {
  if (!pool) return "missing candidate data";
  const tokenInfo = ti || {};
  const hasNarrative = !!n?.narrative;
  // Degen Score is the conviction signal for a solo deploy. Smart wallet is NO LONGER a
  // gate here — it's a confidence boost surfaced to the LLM, not a requirement.
  const degen = degenScore(pool, config.opportunity);
  const degenStrong = degen >= (config.screening.loneCandidateMinDegen ?? 50);
  const globalFeesSol = Number(tokenInfo.global_fees_sol ?? pool.gmgn_total_fee_sol);
  const top10Pct = Number(tokenInfo.audit?.top_holders_pct ?? pool.gmgn_token_info_top10_pct ?? pool.gmgn_top10_holder_pct);
  const botPct = Number(tokenInfo.audit?.bot_holders_pct ?? pool.gmgn_bot_degen_pct);

  // Hard flags — no override.
  if (pool.is_wash) return "wash trading was flagged";
  if (Number.isFinite(globalFeesSol) && globalFeesSol < config.screening.minTokenFeesSol) {
    return `token fees ${globalFeesSol} SOL below minimum ${config.screening.minTokenFeesSol} SOL`;
  }
  if (Number.isFinite(top10Pct) && top10Pct > config.screening.maxTop10Pct) {
    return `top10 concentration ${top10Pct}% above maximum ${config.screening.maxTop10Pct}%`;
  }
  if (Number.isFinite(botPct) && botPct > config.screening.maxBotHoldersPct) {
    return `bot holders ${botPct}% above maximum ${config.screening.maxBotHoldersPct}%`;
  }

  // Risk flags need strong conviction (degen) to deploy solo.
  if (pool.is_rugpull && !degenStrong) {
    return `rugpull risk flagged without strong degen conviction (degen ${degen.toFixed(1)} < ${config.screening.loneCandidateMinDegen ?? 50})`;
  }
  if (pool.is_pvp && !degenStrong) {
    return `PVP symbol conflict without strong degen conviction (degen ${degen.toFixed(1)} < ${config.screening.loneCandidateMinDegen ?? 50})`;
  }
  // Conviction: a solo deploy needs a narrative OR a strong degen score.
  if (!hasNarrative && !degenStrong) {
    return `only candidate has no narrative and weak degen score (${degen.toFixed(1)} < ${config.screening.loneCandidateMinDegen ?? 50})`;
  }
  return null;
}

function computeBinsBelow(volatility) {
  const parsedVolatility = Number(volatility);
  if (!Number.isFinite(parsedVolatility) || parsedVolatility <= 0) {
    throw new Error(`Invalid volatility ${volatility ?? "unknown"} — refusing volatility-scaled deploy.`);
  }
  const lo = config.strategy.minBinsBelow;
  const hi = config.strategy.maxBinsBelow;
  return Math.max(lo, Math.min(hi, Math.round(lo + (parsedVolatility / 5) * (hi - lo))));
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)
let _ttyInterface = null;
let _latestCandidates = [];
let _latestCandidatesAt = null;
let _pendingInput = null; // { key, page, menuMsgId }

function setLatestCandidates(candidates = []) {
  _latestCandidates = Array.isArray(candidates) ? candidates : [];
  _latestCandidatesAt = new Date().toISOString();
}

function getLatestCandidatesMeta() {
  return {
    candidates: _latestCandidates,
    count: _latestCandidates.length,
    updatedAt: _latestCandidatesAt,
  };
}

function describeLatestCandidates(limit = 5) {
  if (!_latestCandidates.length) return "No cached candidates yet. Run /screen first.";
  const lines = _latestCandidates.slice(0, limit).map((pool, i) => {
    const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
    const vol = pool.volume_window ?? pool.volume_24h ?? "?";
    const active = pool.active_pct ?? "?";
    const organic = pool.organic_score ?? "?";
    return `${i + 1}. ${pool.name} | fee/aTVL ${feeTvl}% | vol $${vol} | in-range ${active}% | organic ${organic}`;
  });
  const age = _latestCandidatesAt ? new Date(_latestCandidatesAt).toLocaleString("en-US", { hour12: false }) : "unknown";
  return `Latest candidates (${_latestCandidates.length}) — updated ${age}\n\n${lines.join("\n")}`;
}

function formatWalletStatus(wallet, positions) {
  const deployAmount = computeDeployAmount(wallet.sol);
  const hive = isHiveMindEnabled() ? "on" : "off";
  return [
    `Wallet: ${wallet.sol} SOL ($${wallet.sol_usd})`,
    `SOL price: $${wallet.sol_price}`,
    `Open positions: ${positions.total_positions}/${config.risk.maxPositions}`,
    `Next deploy amount: ${deployAmount} SOL`,
    `Dry run: ${process.env.DRY_RUN === "true" ? "yes" : "no"}`,
    `HiveMind: ${hive}`,
  ].join("\n");
}

function formatConfigSnapshot() {
  return [
    "Config snapshot",
    "",
    `Screening source: ${config.screening.source}`,
    `Strategy: ${config.strategy.strategy} | bins: [${config.strategy.minBinsBelow}–${config.strategy.maxBinsBelow}] (volatility-scaled)`,
    `Deploy: ${config.management.deployAmountSol} SOL | gasReserve: ${config.management.gasReserve} | maxPositions: ${config.risk.maxPositions}`,
    `Stop loss: ${config.management.stopLossPct}% | take profit: ${config.management.takeProfitPct}%`,
    `Trailing: ${config.management.trailingTakeProfit ? "on" : "off"} | trigger ${config.management.trailingTriggerPct}% | drop ${config.management.trailingDropPct}%`,
    `OOR: above=${config.management.outOfRangeWaitMinutes}m / below=${config.management.outOfRangeBelowWaitMinutes}m | fast-close >${config.management.outOfRangeBinsToClose} bins | cooldown ${config.management.oorCooldownTriggerCount}x / ${config.management.oorCooldownHours}h | pump gate ${config.management.minProfitPctToCloseOOR}%`,
    `Repeat deploy cooldown: ${config.management.repeatDeployCooldownEnabled ? "on" : "off"} | ${config.management.repeatDeployCooldownTriggerCount}x / ${config.management.repeatDeployCooldownHours}h | min fee earned ${config.management.repeatDeployCooldownMinFeeEarnedPct}% | ${config.management.repeatDeployCooldownScope}`,
    `Yield floor: ${config.management.minFeePerTvl24h}% | min age ${config.management.minAgeBeforeYieldCheck}m | close profile: ${config.management.closeProfile}`,
    `R8: ${config.management.r8IndicatorCheck ? "on" : "off"} | preset ${config.management.r8ExitPreset} | cooldown ${config.management.r8OorCooldownHours}h`,
    `Screening: ${config.screening.category} / ${config.screening.timeframe} | TVL ${config.screening.minTvl}-${config.screening.maxTvl} | vol ${config.screening.minVolatility ?? 0}-${config.screening.maxVolatility ?? "∞"} | fee/tvl ${config.screening.minFeeActiveTvlRatio}-${config.screening.maxFeeActiveTvlRatio ?? "∞"}%`,
    `GMGN interval: ${config.gmgn.interval} | OrderBy: ${config.gmgn.orderBy} | Dir: ${config.gmgn.direction}`,
    `Intervals: manage ${config.schedule.managementIntervalMin}m | screen ${config.schedule.screeningIntervalMin}m`,
    `HiveMind: ${isHiveMindEnabled() ? "enabled" : "disabled"}${config.hiveMind.agentId ? ` | ${config.hiveMind.agentId}` : ""}`,
  ].join("\n");
}

function parseConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value.length) return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value;
}

function settingValue(key) {
  const values = {
    solMode: config.management.solMode,
    closeProfile: config.management.closeProfile,
    lpAgentRelayEnabled: config.api.lpAgentRelayEnabled,
    chartIndicatorsEnabled: config.indicators.enabled,
    trailingTakeProfit: config.management.trailingTakeProfit,
    useDiscordSignals: config.screening.useDiscordSignals,
    blockPvpSymbols: config.screening.blockPvpSymbols,
    lockMaxVolatility: config.screening.lockMaxVolatility,
    screeningSource: config.screening.source,
    gmgnRequireKol: config.gmgn.requireKol,
    gmgnInterval: config.gmgn.interval,
    gmgnIndicatorFilter: config.gmgn.indicatorFilter,
    gmgnMinVolume: config.gmgn.minVolume,
    gmgnMinTokenAgeHours: config.gmgn.minTokenAgeHours,
    gmgnMaxTokenAgeHours: config.gmgn.maxTokenAgeHours,
    gmgnMaxBundlerRate: config.gmgn.maxBundlerRate,
    gmgnPreferredKolNames: config.gmgn.preferredKolNames,
    gmgnPreferredKolMinHoldPct: config.gmgn.preferredKolMinHoldPct,
    gmgnDumpKolNames: config.gmgn.dumpKolNames,
    gmgnDumpKolMinHoldPct: config.gmgn.dumpKolMinHoldPct,
    gmgnIndicatorInterval: config.gmgn.indicatorInterval,
    gmgnRequireBullishSt: config.gmgn.indicatorRules?.requireBullishSupertrend,
    gmgnRejectAtBottom: config.gmgn.indicatorRules?.rejectAlreadyAtBottom,
    gmgnRequireAboveSt: config.gmgn.indicatorRules?.requireAboveSupertrend,
    gmgnMinRsi: config.gmgn.indicatorRules?.minRsi,
    gmgnMaxRsi: config.gmgn.indicatorRules?.maxRsi,
    gmgnMinKolCount: config.gmgn.minKolCount,
    gmgnMinTotalFeeSol: config.gmgn.minTotalFeeSol,
    gmgnMinHolders: config.gmgn.minHolders,
    gmgnMinMcap: config.gmgn.minMcap,
    gmgnMaxMcap: config.gmgn.maxMcap,
    gmgnAthFilterPct: config.gmgn.athFilterPct,
    gmgnHoldersLimit: config.gmgn.holdersLimit,
    gmgnMaxTop10HolderRate: config.gmgn.maxTop10HolderRate,
    gmgnMaxRatTraderRate: config.gmgn.maxRatTraderRate,
    gmgnMaxFreshWalletRate: config.gmgn.maxFreshWalletRate,
    gmgnMaxDevTeamHoldRate: config.gmgn.maxDevTeamHoldRate,
    gmgnMaxBotDegenRate: config.gmgn.maxBotDegenRate,
    gmgnMaxRugRatio: config.gmgn.maxRugRatio,
    gmgnMaxSniperCount: config.gmgn.maxSniperCount,
    gmgnMaxSniperHoldRate: config.gmgn.maxSniperHoldRate,
    gmgnMinSmartDegenCount: config.gmgn.minSmartDegenCount,
    gmgnRequireBbPosition: config.gmgn.indicatorRules?.requireBbPosition,
    volumeTrendFilter: config.screening.volumeTrendFilter,
    volumeTrendAccelThreshold: config.screening.volumeTrendAccelThreshold,
    volumeTrendDecelThreshold: config.screening.volumeTrendDecelThreshold,
    volumeTrendBlockDecel: config.screening.volumeTrendBlockDecel,
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    maxPositions: config.risk.maxPositions,
    maxDeployAmount: config.risk.maxDeployAmount,
    minVolatility: config.screening.minVolatility,
    maxVolatility: config.screening.maxVolatility,
    minFeeActiveTvlRatio: config.screening.minFeeActiveTvlRatio,
    maxFeeActiveTvlRatio: config.screening.maxFeeActiveTvlRatio,
    takeProfitPct: config.management.takeProfitPct,
    stopLossPct: config.management.stopLossPct,
    emergencyClosePct: config.management.emergencyClosePct,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
    repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
    repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
    repeatDeployCooldownMinFeeEarnedPct: config.management.repeatDeployCooldownMinFeeEarnedPct,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    indicatorEntryPreset: config.indicators.entryPreset,
    indicatorExitPreset: config.indicators.exitPreset,
    rsiLength: config.indicators.rsiLength,
    indicatorIntervals: config.indicators.intervals,
    requireAllIntervals: config.indicators.requireAllIntervals,
    r8IndicatorCheck: config.management.r8IndicatorCheck,
    r8ExitPreset: config.management.r8ExitPreset,
    r8OorCooldownHours: config.management.r8OorCooldownHours,
  };
  return values[key];
}

function fmtSettingValue(value) {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function settingButton(label, data) {
  return { text: label, callback_data: data };
}

function toggleButton(key, label) {
  return settingButton(`${label}: ${fmtSettingValue(settingValue(key))}`, `cfg:toggle:${key}`);
}

function stepButtons(key, label, step, { digits = 2 } = {}) {
  const value = Number(settingValue(key));
  const shown = Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, "") : "?";
  return [
    settingButton(`- ${label}`, `cfg:step:${key}:${-step}`),
    settingButton(`${label}: ${shown}`, `cfg:noop`),
    settingButton(`+ ${label}`, `cfg:step:${key}:${step}`),
  ];
}

function inputButton(key, label, { digits = 0 } = {}) {
  const value = settingValue(key);
  const shown = value == null ? "off" : Number.isFinite(Number(value)) ? String(parseFloat(Number(value).toFixed(digits))) : String(value);
  return [settingButton(`${label}: ${shown} ✏`, `cfg:input:${key}`)];
}

function renderSettingsMenu(page = "main") {
  const title = page === "main" ? "Settings menu" : `Settings: ${page}`;
  const summary = [
    title,
    "",
    `Mode: ${config.management.solMode ? "SOL" : "USD"} | Relay: ${config.api.lpAgentRelayEnabled ? "on" : "off"}`,
    `Screening: ${config.screening.source} | GMGN KOL ${config.gmgn.requireKol ? "required" : "preferred"}`,
    `Strategy: ${config.strategy.strategy} | deploy ${config.management.deployAmountSol} SOL | max pos ${config.risk.maxPositions}`,
    `TP/SL: ${config.management.takeProfitPct}% / ${config.management.stopLossPct}% | trailing ${config.management.trailingTakeProfit ? "on" : "off"} | profile: ${config.management.closeProfile} | pump gate ${config.management.minProfitPctToCloseOOR}%`,
    `Indicators: ${config.indicators.enabled ? "on" : "off"} | entry ${config.indicators.entryPreset} | ${fmtSettingValue(config.indicators.intervals)}`,
  ].join("\n");

  const nav = [
    [
      settingButton("Main", "cfg:page:main"),
      settingButton("Risk", "cfg:page:risk"),
      settingButton("Strategy", "cfg:page:strategy"),
    ],
    [
      settingButton("Screen", "cfg:page:screen"),
      settingButton("GMGN", "cfg:page:gmgn"),
      settingButton("Safety", "cfg:page:safety"),
      settingButton("Indicators", "cfg:page:indicators"),
      settingButton("KOL", "cfg:page:kol"),
    ],
  ];

  const footer = [
    [
      settingButton("Refresh", `cfg:page:${page}`),
      settingButton("Close", "cfg:close"),
    ],
  ];

  let rows;
  if (page === "risk") {
    rows = [
      inputButton("deployAmountSol", "Deploy SOL", { digits: 2 }),
      inputButton("gasReserve", "Gas reserve", { digits: 2 }),
      inputButton("maxPositions", "Max positions"),
      inputButton("maxDeployAmount", "Max SOL"),
      inputButton("takeProfitPct", "TP %"),
      inputButton("stopLossPct", "SL %"),
      inputButton("emergencyClosePct", "Emergency close %", { digits: 0 }),
      inputButton("minProfitPctToCloseOOR", "Min profit % to close on pump", { digits: 2 }),
      [toggleButton("trailingTakeProfit", "Trailing TP")],
      inputButton("trailingTriggerPct", "Trail trigger", { digits: 1 }),
      inputButton("trailingDropPct", "Trail drop", { digits: 1 }),
      [toggleButton("repeatDeployCooldownEnabled", "Repeat cooldown")],
      inputButton("repeatDeployCooldownTriggerCount", "Repeat count"),
      inputButton("repeatDeployCooldownHours", "Repeat hrs"),
      inputButton("repeatDeployCooldownMinFeeEarnedPct", "Min fee earned %", { digits: 1 }),
      inputButton("minVolatility", "Min vol", { digits: 1 }),
      inputButton("maxVolatility", "Max vol", { digits: 1 }),
      inputButton("minFeeActiveTvlRatio", "Min fee/TVL %", { digits: 2 }),
      inputButton("maxFeeActiveTvlRatio", "Max fee/TVL %", { digits: 2 }),
      [
        settingButton(`Close: main${config.management.closeProfile === "main" ? " ✓" : ""}`, "cfg:set:closeProfile:main"),
        settingButton(`pecut${config.management.closeProfile === "pecut" ? " ✓" : ""}`, "cfg:set:closeProfile:pecut"),
        settingButton(`experimental${config.management.closeProfile === "experimental" ? " ✓" : ""}`, "cfg:set:closeProfile:experimental"),
      ],
      [toggleButton("r8IndicatorCheck", "R8 indicator check")],
      [
        settingButton(`R8: ST${config.management.r8ExitPreset === "supertrend_break" ? " ✓" : ""}`, "cfg:set:r8ExitPreset:supertrend_break"),
        settingButton(`RSI${config.management.r8ExitPreset === "rsi_reversal" ? " ✓" : ""}`, "cfg:set:r8ExitPreset:rsi_reversal"),
        settingButton(`BB+RSI${config.management.r8ExitPreset === "bb_plus_rsi" ? " ✓" : ""}`, "cfg:set:r8ExitPreset:bb_plus_rsi"),
        settingButton(`ST/RSI${config.management.r8ExitPreset === "supertrend_or_rsi" ? " ✓" : ""}`, "cfg:set:r8ExitPreset:supertrend_or_rsi"),
      ],
      inputButton("r8OorCooldownHours", "R8 cooldown hrs"),
    ];
  } else if (page === "screen") {
    rows = [
      [
        settingButton(`Source: Meteora${config.screening.source === "meteora" ? " ✓" : ""}`, "cfg:set:screeningSource:meteora"),
        settingButton(`Source: GMGN${config.screening.source === "gmgn" ? " ✓" : ""}`, "cfg:set:screeningSource:gmgn"),
      ],
      [toggleButton("gmgnRequireKol", "GMGN require KOL")],
      [toggleButton("useDiscordSignals", "Discord signals"), toggleButton("blockPvpSymbols", "PVP hard block")],
      [
        settingButton("5m", "cfg:set:gmgnInterval:5m"),
        settingButton("1h", "cfg:set:gmgnInterval:1h"),
        settingButton("6h", "cfg:set:gmgnInterval:6h"),
        settingButton("24h", "cfg:set:gmgnInterval:24h"),
      ],
      [
        inputButton("gmgnMinVolume", "Min volume")[0],
        inputButton("gmgnMinTokenAgeHours", "Min token age (h)")[0],
      ],
      [
        inputButton("gmgnMaxTokenAgeHours", "Max token age (h)")[0],
        inputButton("gmgnMaxBundlerRate", "Max bundler %")[0],
      ],
      [toggleButton("volumeTrendFilter", "Volume trend filter")],
      [toggleButton("volumeTrendBlockDecel", "Block decelerating")],
      [toggleButton("lockMaxVolatility", "Lock maxVolatility (no auto-evolve)")],
      [
        inputButton("volumeTrendAccelThreshold", "Accel threshold")[0],
        inputButton("volumeTrendDecelThreshold", "Decel threshold")[0],
      ],
      [settingButton("KOL settings", "cfg:page:kol")],
      inputButton("managementIntervalMin", "Manage interval (min)"),
      inputButton("screeningIntervalMin", "Screen interval (min)"),
    ];
  } else if (page === "strategy") {
    rows = [
      [
        settingButton("spot", "cfg:set:strategy:spot"),
        settingButton("bid_ask", "cfg:set:strategy:bid_ask"),
      ],
      inputButton("minBinsBelow", "Min bins"),
      inputButton("maxBinsBelow", "Max bins"),
    ];
  } else if (page === "gmgn") {
    rows = [
      [
        inputButton("gmgnMinMcap", "Min mcap")[0],
        inputButton("gmgnMaxMcap", "Max mcap")[0],
      ],
      [
        inputButton("gmgnMinVolume", "Min volume")[0],
        inputButton("gmgnMinHolders", "Min holders")[0],
      ],
      [
        inputButton("gmgnAthFilterPct", "ATH filter %", { digits: 0 })[0],
        inputButton("gmgnHoldersLimit", "Holders limit")[0],
      ],
      [
        inputButton("gmgnMinTokenAgeHours", "Min token age (h)")[0],
        inputButton("gmgnMaxTokenAgeHours", "Max token age (h)")[0],
      ],
      [settingButton("Safety filters", "cfg:page:safety")],
      [settingButton("KOL settings", "cfg:page:kol")],
    ];
  } else if (page === "kol") {
    rows = [
      inputButton("gmgnPreferredKolNames", "Preferred KOL (comma-sep)"),
      inputButton("gmgnPreferredKolMinHoldPct", "Preferred KOL min hold %"),
      inputButton("gmgnDumpKolNames", "Dump KOL (comma-sep)"),
      inputButton("gmgnDumpKolMinHoldPct", "Dump KOL min hold %"),
    ];
  } else if (page === "safety") {
    rows = [
      [
        inputButton("gmgnMaxTop10HolderRate", "Max top10 %", { digits: 2 })[0],
        inputButton("gmgnMaxBundlerRate", "Max bundler %", { digits: 2 })[0],
      ],
      [
        inputButton("gmgnMaxRatTraderRate", "Max rat trader %", { digits: 2 })[0],
        inputButton("gmgnMaxFreshWalletRate", "Max fresh wallet %", { digits: 2 })[0],
      ],
      [
        inputButton("gmgnMaxDevTeamHoldRate", "Max dev hold %", { digits: 2 })[0],
        inputButton("gmgnMaxBotDegenRate", "Max bot degen %", { digits: 2 })[0],
      ],
      [
        inputButton("gmgnMaxRugRatio", "Max rug ratio", { digits: 2 })[0],
        inputButton("gmgnMaxSniperHoldRate", "Max sniper hold %", { digits: 2 })[0],
      ],
      [
        inputButton("gmgnMaxSniperCount", "Max sniper count")[0],
        inputButton("gmgnMinSmartDegenCount", "Min smart degen")[0],
      ],
      [toggleButton("gmgnRequireKol", "Require KOL")],
      [inputButton("gmgnMinKolCount", "Min KOL")[0], inputButton("gmgnMinTotalFeeSol", "Min fee SOL")[0]],
      [settingButton("Indicators", "cfg:page:indicators")],
    ];
  } else if (page === "indicators") {
    rows = [
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("requireAllIntervals", "Require all TF")],
      [toggleButton("gmgnIndicatorFilter", "GMGN indicator filter"), toggleButton("gmgnRequireBbPosition", "Require BB position")],
      [
        settingButton("TF: 5m", "cfg:set:indicatorIntervals:5_MINUTE"),
        settingButton("TF: 15m", "cfg:set:indicatorIntervals:15_MINUTE"),
        settingButton("TF: both", "cfg:set:indicatorIntervals:both"),
      ],
      [
        settingButton("Entry: ST", "cfg:set:indicatorEntryPreset:supertrend_break"),
        settingButton("Entry: RSI", "cfg:set:indicatorEntryPreset:rsi_reversal"),
        settingButton("Entry: ST/RSI", "cfg:set:indicatorEntryPreset:supertrend_or_rsi"),
      ],
      [
        settingButton("Exit: ST", "cfg:set:indicatorExitPreset:supertrend_break"),
        settingButton("Exit: RSI", "cfg:set:indicatorExitPreset:rsi_reversal"),
        settingButton("Exit: BB+RSI", "cfg:set:indicatorExitPreset:bb_plus_rsi"),
      ],
      [
        settingButton("GMGN ST", "cfg:set:gmgnIndicatorInterval:5_MINUTE"),
        settingButton("GMGN 15m", "cfg:set:gmgnIndicatorInterval:15_MINUTE"),
        settingButton("GMGN 1h", "cfg:set:gmgnIndicatorInterval:1h"),
      ],
      [toggleButton("gmgnRequireBullishSt", "Bullish ST"), toggleButton("gmgnRejectAtBottom", "Reject at bottom"), toggleButton("gmgnRequireAboveSt", "Above ST")],
      inputButton("gmgnMinRsi", "Min RSI"),
      inputButton("gmgnMaxRsi", "Max RSI"),
      inputButton("rsiLength", "RSI length"),
    ];
  } else {
    rows = [
      [
        settingButton(`Source: Meteora${config.screening.source === "meteora" ? " ✓" : ""}`, "cfg:set:screeningSource:meteora"),
        settingButton(`Source: GMGN${config.screening.source === "gmgn" ? " ✓" : ""}`, "cfg:set:screeningSource:gmgn"),
      ],
      [toggleButton("solMode", "SOL mode"), toggleButton("lpAgentRelayEnabled", "LPAgent relay")],
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("trailingTakeProfit", "Trailing TP")],
      [
        settingButton("Risk / deploy", "cfg:page:risk"),
        settingButton("Screening", "cfg:page:screen"),
      ],
      [
        settingButton("Indicators", "cfg:page:indicators"),
        settingButton("Show config", "cfg:show"),
      ],
    ];
  }

  return { text: summary, keyboard: [...nav, ...rows, ...footer] };
}

async function showSettingsMenu({ messageId = null, page = "main" } = {}) {
  const menu = renderSettingsMenu(page);
  if (messageId) {
    await editMessageWithButtons(menu.text, messageId, menu.keyboard);
  } else {
    await sendMessageWithButtons(menu.text, menu.keyboard);
  }
}

function normalizeMenuValue(key, raw) {
  if (key === "indicatorIntervals") {
    if (raw === "both") return ["5_MINUTE", "15_MINUTE"];
    return [raw];
  }
  if (key === "gmgnPreferredKolNames" || key === "gmgnDumpKolNames") {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return parseConfigValue(raw);
}

async function applySettingsMenuCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];
  let page = "main";

  if (action === "noop") {
    await answerCallbackQuery(msg.callbackQueryId);
    return;
  }
  if (action === "input") {
    const inputKey = parts[2];
    const currentVal = settingValue(inputKey);
    const inputPage = ["gmgnPreferredKolNames", "gmgnPreferredKolMinHoldPct", "gmgnDumpKolNames", "gmgnDumpKolMinHoldPct"].includes(inputKey) ? "kol"
      : ["gmgnMaxTop10HolderRate", "gmgnMaxBundlerRate", "gmgnMaxRatTraderRate", "gmgnMaxFreshWalletRate", "gmgnMaxDevTeamHoldRate", "gmgnMaxBotDegenRate", "gmgnMaxRugRatio", "gmgnMaxSniperCount", "gmgnMaxSniperHoldRate", "gmgnMinSmartDegenCount", "gmgnRequireKol", "gmgnMinKolCount", "gmgnMinTotalFeeSol"].includes(inputKey) ? "safety"
      : ["gmgnMinMcap", "gmgnMaxMcap", "gmgnMinVolume", "gmgnAthFilterPct", "gmgnMinHolders", "gmgnHoldersLimit", "gmgnMinTokenAgeHours", "gmgnMaxTokenAgeHours"].includes(inputKey) ? "gmgn"
      : inputKey.startsWith("indicator") || inputKey === "chartIndicatorsEnabled" || inputKey === "rsiLength" || inputKey === "requireAllIntervals" || inputKey === "gmgnIndicatorFilter" || inputKey === "gmgnRequireBbPosition" || inputKey === "gmgnIndicatorInterval" || inputKey === "gmgnRequireBullishSt" || inputKey === "gmgnRejectAtBottom" || inputKey === "gmgnRequireAboveSt" || inputKey === "gmgnMinRsi" || inputKey === "gmgnMaxRsi" ? "indicators"
      : ["minBinsBelow", "maxBinsBelow"].includes(inputKey) ? "strategy"
      : ["useDiscordSignals", "blockPvpSymbols", "managementIntervalMin", "screeningIntervalMin", "screeningSource"].includes(inputKey) ? "screen"
      : "risk";
    _pendingInput = { key: inputKey, page: inputPage, menuMsgId: msg.messageId };
    await answerCallbackQuery(msg.callbackQueryId);
    await sendMessage(`Enter new value for ${inputKey} (current: ${currentVal ?? "off"}):\nSend a number, or "off" to clear.`);
    return;
  }
  if (action === "close") {
    await answerCallbackQuery(msg.callbackQueryId, "Closed");
    await editMessage("Settings menu closed.", msg.messageId);
    return;
  }
  if (action === "show") {
    await answerCallbackQuery(msg.callbackQueryId);
    await editMessageWithButtons(formatConfigSnapshot(), msg.messageId, [[settingButton("Back", "cfg:page:main")]]);
    return;
  }
  if (action === "page") {
    page = parts[2] || "main";
    await answerCallbackQuery(msg.callbackQueryId);
    await showSettingsMenu({ messageId: msg.messageId, page });
    return;
  }

  const key = parts[2];
  let value;
  if (action === "toggle") {
    value = !Boolean(settingValue(key));
  } else if (action === "step") {
    const current = Number(settingValue(key));
    const delta = Number(parts[3]);
    if (!Number.isFinite(current) || !Number.isFinite(delta)) {
      await answerCallbackQuery(msg.callbackQueryId, "Invalid setting");
      return;
    }
    value = Number((current + delta).toFixed(4));
    if (key === "maxPositions") value = Math.max(1, Math.round(value));
    if (key === "rsiLength") value = Math.max(2, Math.round(value));
    if (key === "repeatDeployCooldownTriggerCount") value = Math.max(1, Math.round(value));
    if (key === "repeatDeployCooldownHours") value = Math.max(0, Math.round(value));
    if (key === "repeatDeployCooldownMinFeeEarnedPct") value = Math.max(0, value);
    if (["deployAmountSol", "gasReserve", "maxDeployAmount"].includes(key)) value = Math.max(0, value);
    if (key === "minVolatility") value = Math.max(0, Math.min(10, Number((current + delta).toFixed(1))));
    if (key === "maxVolatility") value = Math.max(1, Math.min(20, Number((current + delta).toFixed(1))));
  } else if (action === "set") {
    value = normalizeMenuValue(key, parts.slice(3).join(":"));
  } else {
    await answerCallbackQuery(msg.callbackQueryId, "Unknown action");
    return;
  }

  const result = await executeTool("update_config", {
    changes: { [key]: value },
    reason: "Telegram settings menu",
  });
  if (!result?.success) {
    await answerCallbackQuery(msg.callbackQueryId, "Config update failed");
    return;
  }
  page = ["gmgnPreferredKolNames", "gmgnPreferredKolMinHoldPct", "gmgnDumpKolNames", "gmgnDumpKolMinHoldPct"].includes(key) ? "kol"
    : ["gmgnMaxTop10HolderRate", "gmgnMaxBundlerRate", "gmgnMaxRatTraderRate", "gmgnMaxFreshWalletRate", "gmgnMaxDevTeamHoldRate", "gmgnMaxBotDegenRate", "gmgnMaxRugRatio", "gmgnMaxSniperCount", "gmgnMaxSniperHoldRate", "gmgnMinSmartDegenCount", "gmgnRequireKol", "gmgnMinKolCount", "gmgnMinTotalFeeSol"].includes(key) ? "safety"
    : ["gmgnMinMcap", "gmgnMaxMcap", "gmgnMinVolume", "gmgnAthFilterPct", "gmgnMinHolders", "gmgnHoldersLimit", "gmgnMinTokenAgeHours", "gmgnMaxTokenAgeHours"].includes(key) ? "gmgn"
    : key.startsWith("indicator") || key === "chartIndicatorsEnabled" || key === "rsiLength" || key === "requireAllIntervals" || key === "gmgnIndicatorFilter" || key === "gmgnRequireBbPosition" || key === "gmgnIndicatorInterval" || key === "gmgnRequireBullishSt" || key === "gmgnRejectAtBottom" || key === "gmgnRequireAboveSt" || key === "gmgnMinRsi" || key === "gmgnMaxRsi" ? "indicators"
    : ["minBinsBelow", "maxBinsBelow"].includes(key) ? "strategy"
    : ["useDiscordSignals", "blockPvpSymbols", "managementIntervalMin", "screeningIntervalMin", "screeningSource", "volumeTrendFilter", "volumeTrendAccelThreshold", "volumeTrendDecelThreshold", "volumeTrendBlockDecel", "lockMaxVolatility"].includes(key) ? "screen"
    : "risk";
  await answerCallbackQuery(msg.callbackQueryId, `Updated ${key}`);
  await showSettingsMenu({ messageId: msg.messageId, page });
}

function categorizeCloseReason(reason) {
  if (!reason) return "Other";
  const r = reason.toLowerCase();
  if (r.includes("trailing tp") && (r.includes("oor") || r.includes("trailing armed"))) return "Trailing TP (OOR)";
  if (r.includes("trailing tp")) return "Trailing TP";
  if (r.includes("low yield")) return "Low yield";
  if (r.includes("stop loss")) return "Stop loss";
  if (r.includes("rule 3") || r.includes("pumped")) return "Pump (R3)";
  if (r.includes("take profit")) return "Take profit";
  if (r.includes("r8 held")) return "R8-held";
  if (r.includes("oor") || r.includes("out of range")) return "OOR";
  if (r.includes("manual")) return "Manual";
  return "Other";
}

async function parseLogDates(dates) {
  const logsDir = new URL("./logs", import.meta.url).pathname;
  const closedPositions = [], exitAlerts = [];
  let errorCount = 0, safetyLockCount = 0, pumpHoldCount = 0, r8HoldCount = 0;
  for (const dateStr of dates) {
    try {
      const rl = readline.createInterface({ input: createReadStream(`${logsDir}/agent-${dateStr}.log`), crlfDelay: Infinity });
      for await (const line of rl) {
        const m = line.match(/\[PnL poll\] Exit alert: (\S+) — (.+?) — triggering/);
        if (m) { const tsM = line.match(/\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/); exitAlerts.push({ ts: tsM?.[1] ?? dateStr, pair: m[1], reason: m[2] }); }
        if (/\[ERROR\]/.test(line)) errorCount++;
        if (/Safety-Lock:/.test(line)) safetyLockCount++;
        if (/Pump-Hold:/.test(line)) pumpHoldCount++;
        if (/R8 hold:/.test(line)) r8HoldCount++;
      }
    } catch {}
    try {
      const rl = readline.createInterface({ input: createReadStream(`${logsDir}/actions-${dateStr}.jsonl`), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.tool === "close_position" && entry.success !== false) {
            const result = typeof entry.result === "string"
              ? (() => { try { return JSON.parse(entry.result); } catch { return {}; } })()
              : (entry.result ?? {});
            closedPositions.push({ ts: entry.timestamp, pair: result.pool_name ?? "?", reason: entry.args?.reason ?? "?", pnl_pct: result.pnl_pct ?? null, pnl_usd: result.pnl_usd ?? null });
          }
        } catch {}
      }
    } catch {}
  }
  return { closedPositions, exitAlerts, errorCount, safetyLockCount, pumpHoldCount, r8HoldCount };
}

async function buildObserveReport({ days = 1, details = false } = {}) {
  const now = new Date();
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const { closedPositions, exitAlerts, errorCount, safetyLockCount, pumpHoldCount, r8HoldCount } = await parseLogDates(dates);

  const oorAlerts = exitAlerts.filter(a => /oor|out.of.range/i.test(a.reason));
  const oorAbove  = exitAlerts.filter(a => /OOR above/i.test(a.reason));
  const oorBelow  = exitAlerts.filter(a => /OOR below/i.test(a.reason));
  const trailingArmedClosed = closedPositions.filter(p => /trailing armed|Trailing TP: OOR/i.test(p.reason));

  const cats = {};
  for (const p of closedPositions) { const cat = categorizeCloseReason(p.reason); cats[cat] = (cats[cat] ?? 0) + 1; }

  const profile = config.management.closeProfile ?? "main";
  const label = days === 1 ? "today" : `last ${days}d`;

  const lines = [`<b>📡 Observe — ${label} | profile: ${profile}</b>`, "", `<b>Closes: ${closedPositions.length}</b>`];
  if (Object.keys(cats).length > 0) {
    for (const [cat, n] of Object.entries(cats).sort((a, b) => b[1] - a[1])) lines.push(`  ${cat}: ${n}`);
  } else {
    lines.push("  No closes recorded.");
  }

  lines.push(
    "", `<b>OOR exit alerts: ${oorAlerts.length}</b>`,
    `  Above: ${oorAbove.length}`, `  Below: ${oorBelow.length}`,
    `  Trailing-armed closes: ${trailingArmedClosed.length}`,
    `  Safety-Lock holds: ${safetyLockCount}`, `  Pump-Hold holds: ${pumpHoldCount}`, `  R8 holds: ${r8HoldCount}`,
  );

  if (errorCount > 0) lines.push("", `⚠️ Errors in log: ${errorCount}`);

  if (details) {
    lines.push("");
    if (trailingArmedClosed.length > 0) {
      lines.push("<b>Trailing-armed OOR closes</b>");
      trailingArmedClosed.slice(-10).forEach((p) => {
        const pnl = p.pnl_pct != null ? ` | ${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct.toFixed(2)}%` : "";
        const usd = p.pnl_usd != null ? ` (${p.pnl_usd >= 0 ? "+" : ""}$${Math.abs(p.pnl_usd).toFixed(3)})` : "";
        lines.push(`  ${htmlEscape(p.pair)}${pnl}${usd}`);
        lines.push(`  <i>${htmlEscape(p.reason.slice(0, 90))}</i>`);
      });
    } else {
      lines.push("No trailing-armed OOR closes found.");
    }
  }

  return lines.join("\n");
}

async function buildObserveCompare(baselineDays = null, currentDays = null) {
  const logsDir = new URL("./logs", import.meta.url).pathname;
  const now = new Date();

  // Scan up to 14d back for most recent closeProfile change in agent logs
  let boundaryTs = null, fromProfile = null, toProfile = null;
  for (let i = 0; i < 14; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    try {
      const rl = readline.createInterface({ input: createReadStream(`${logsDir}/agent-${dateStr}.log`), crlfDelay: Infinity });
      for await (const line of rl) {
        const m = line.match(/update_config: config\.management\.closeProfile (\S+) \S+ (\S+) \(/);
        if (m) {
          const tsM = line.match(/\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/);
          const ts = tsM?.[1];
          if (ts && (!boundaryTs || ts > boundaryTs)) { boundaryTs = ts; fromProfile = m[1]; toProfile = m[2]; }
        }
      }
    } catch {}
  }

  // Compute period sizes
  let curDays, baseDays;
  if (boundaryTs) {
    const msSince = now.getTime() - new Date(boundaryTs).getTime();
    const defaultCur = Math.max(1, Math.min(Math.ceil(msSince / 86400000), 7));
    curDays  = currentDays  ?? defaultCur;
    baseDays = baselineDays ?? Math.max(2, curDays * 2);
  } else {
    curDays  = currentDays  ?? 2;
    baseDays = baselineDays ?? 4;
  }

  function buildDates(skip, count) {
    const d = [];
    for (let i = skip; i < skip + count; i++) { const x = new Date(now); x.setDate(x.getDate() - i); d.push(x.toISOString().slice(0, 10)); }
    return d;
  }

  const [cur, base] = await Promise.all([
    parseLogDates(buildDates(0, curDays)),
    parseLogDates(buildDates(curDays, baseDays)),
  ]);

  function cats(positions) {
    const c = {};
    for (const p of positions) { const cat = categorizeCloseReason(p.reason); c[cat] = (c[cat] ?? 0) + 1; }
    return c;
  }
  const bc = cats(base.closedPositions), cc = cats(cur.closedPositions);
  const allCats = [...new Set([...Object.keys(bc), ...Object.keys(cc)])].sort();

  const COL1 = 18, COL2 = 10, COL3 = 10;
  function row(label, b, c) {
    return label.padEnd(COL1) + (b == null ? "n/a" : String(b)).padStart(COL2) + (c == null ? "n/a" : String(c)).padStart(COL3);
  }
  const SEP = "─".repeat(COL1 + COL2 + COL3);

  const avgBase = (base.closedPositions.length / baseDays).toFixed(1);
  const avgCur  = (cur.closedPositions.length  / curDays).toFixed(1);

  const header = boundaryTs
    ? `<b>📊 Compare</b>\nBoundary: ${boundaryTs.slice(0, 16).replace("T", " ")} UTC (${fromProfile} → ${toProfile})`
    : `<b>📊 Compare</b>\nNo profile change found — ${curDays}d vs prior ${baseDays}d`;

  const tableLines = [
    row("", `Base (${baseDays}d)`, `Cur (${curDays}d)`), SEP,
    row("Closes total", base.closedPositions.length, cur.closedPositions.length),
    ...allCats.map(cat => row("  " + cat, bc[cat] ?? 0, cc[cat] ?? 0)),
    SEP,
    row("Safety-Lock holds", null, cur.safetyLockCount),
    row("Pump-Hold holds", null, cur.pumpHoldCount),
    row("Errors", base.errorCount, cur.errorCount),
    row("Profile", fromProfile ?? "main", toProfile ?? (config.management.closeProfile ?? "main")),
    row("Avg closes/day", avgBase, avgCur),
  ];

  return `${header}\n\n<code>${tableLines.join("\n")}</code>`;
}

async function buildObserveHeld() {
  const logsDir = new URL("./logs", import.meta.url).pathname;
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const holdsByAddr = new Map();

  const today     = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);

  for (const dateStr of [yesterday, today]) {
    try {
      const rl = readline.createInterface({ input: createReadStream(`${logsDir}/agent-${dateStr}.log`), crlfDelay: Infinity });
      for await (const line of rl) {
        const tsM = line.match(/\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/);
        const ts = tsM?.[1];
        if (!ts || ts < cutoff) continue;

        const sl = line.match(/Safety-Lock: (\S+) OOR (above|below) for (\d+)m but PnL (-?[\d.]+|\?)% .+ holding \(profile: (\S+)\)/);
        if (sl) {
          const [, addr, dir, mins, pnl, prof] = sl;
          const existing = holdsByAddr.get(addr);
          if (!existing || ts > existing.ts)
            holdsByAddr.set(addr, { type: "Safety-Lock", direction: dir, minutesOOR: parseInt(mins), pnl: pnl === "?" ? null : parseFloat(pnl), ts, prof });
        }

        const ph = line.match(/Pump-Hold: (\S+) pumped above range but PnL (-?[\d.]+|\?)% < ([\d.]+)% gate .+ holding \(profile: (\S+)\)/);
        if (ph) {
          const [, addr, pnlRaw, gate, prof] = ph;
          const existing = holdsByAddr.get(addr);
          if (!existing || ts > existing.ts)
            holdsByAddr.set(addr, { type: "Pump-Hold", gate: parseFloat(gate), pnl: pnlRaw === "?" ? null : parseFloat(pnlRaw), ts, prof });
        }

        const r8 = line.match(/R8 hold: (\S+) OOR (above|below) for (\d+)m — indicators not confirmed: (.+)/);
        if (r8) {
          const [, addr, dir, mins, reason] = r8;
          const existing = holdsByAddr.get(addr);
          if (!existing || ts > existing.ts)
            holdsByAddr.set(addr, { type: "R8-held", direction: dir, minutesOOR: parseInt(mins), reason: reason.trim(), ts });
        }
      }
    } catch {}
  }

  if (holdsByAddr.size === 0) return `<b>🔒 Held positions — last 24h</b>\n\nNo held positions in last 24h.`;

  function fmtAddr(a) { return a.length > 8 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a; }
  function fmtTime(ts) { return ts.slice(11, 16); }

  const lines = [`<b>🔒 Held positions — last 24h</b>`, ""];
  const slEntries = [...holdsByAddr.entries()].filter(([, v]) => v.type === "Safety-Lock");
  const phEntries = [...holdsByAddr.entries()].filter(([, v]) => v.type === "Pump-Hold");

  if (slEntries.length > 0) {
    lines.push(`<b>Safety-Lock (${slEntries.length}):</b>`);
    for (const [addr, h] of slEntries.slice(0, 20)) {
      const pnlStr = h.pnl != null ? `PnL ${h.pnl.toFixed(2)}%` : "PnL ?%";
      lines.push(`• <code>${fmtAddr(addr)}</code> — OOR ${h.direction} ${h.minutesOOR}m, ${pnlStr}, last hold ${fmtTime(h.ts)}`);
    }
    if (slEntries.length > 20) lines.push(`  … and ${slEntries.length - 20} more`);
  }

  if (phEntries.length > 0) {
    if (slEntries.length > 0) lines.push("");
    lines.push(`<b>Pump-Hold (${phEntries.length}):</b>`);
    for (const [addr, h] of phEntries.slice(0, 20)) {
      const pnlStr = h.pnl != null ? `PnL ${h.pnl.toFixed(2)}%` : "PnL ?%";
      lines.push(`• <code>${fmtAddr(addr)}</code> — pumped above range, ${pnlStr} < ${h.gate}% gate, last hold ${fmtTime(h.ts)}`);
    }
    if (phEntries.length > 20) lines.push(`  … and ${phEntries.length - 20} more`);
  }

  const r8Entries = [...holdsByAddr.entries()].filter(([, v]) => v.type === "R8-held");
  if (r8Entries.length > 0) {
    if (slEntries.length > 0 || phEntries.length > 0) lines.push("");
    lines.push(`<b>R8-held (${r8Entries.length}):</b>`);
    for (const [addr, h] of r8Entries.slice(0, 20)) {
      lines.push(`• <code>${fmtAddr(addr)}</code> — OOR ${h.direction} ${h.minutesOOR}m, ${h.reason}, last hold ${fmtTime(h.ts)}`);
    }
    if (r8Entries.length > 20) lines.push(`  … and ${r8Entries.length - 20} more`);
  }

  lines.push("", `Total: ${holdsByAddr.size} unique position${holdsByAddr.size !== 1 ? "s" : ""} held`);
  return lines.join("\n");
}

async function buildObserveReasons() {
  const today = new Date().toISOString().slice(0, 10);
  const { closedPositions, safetyLockCount, pumpHoldCount, r8HoldCount } = await parseLogDates([today]);
  const profile = config.management.closeProfile ?? "main";

  if (closedPositions.length === 0)
    return `<b>🚪 Close reasons — today (${today})</b>\nProfile: ${profile}\n\nNo closes today.`;

  const cats = {};
  for (const p of closedPositions) { const cat = categorizeCloseReason(p.reason); cats[cat] = (cats[cat] ?? 0) + 1; }
  const total = closedPositions.length;
  const sorted = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const maxCount = sorted[0][1];
  const BAR_MAX = 14;

  function bar(n) {
    const frac = n / maxCount;
    const full = Math.floor(frac * BAR_MAX);
    const half = (frac * BAR_MAX - full) >= 0.4 && full < BAR_MAX ? 1 : 0;
    return "█".repeat(full) + (half ? "▌" : "");
  }

  const lines = [`<b>🚪 Close reasons — today (${today})</b>`, `Profile: ${profile} | Total closes: ${total}`, ""];
  for (const [cat, n] of sorted) {
    const pct = ((n / total) * 100).toFixed(1);
    lines.push(`<code>${cat.padEnd(18)} ${bar(n).padEnd(BAR_MAX + 1)}${n}  (${pct}%)</code>`);
  }

  if (safetyLockCount > 0 || pumpHoldCount > 0 || r8HoldCount > 0) {
    lines.push("", "<b>Holds (no close):</b>");
    if (safetyLockCount > 0)
      lines.push(`<code>${"Safety-Lock".padEnd(18)} ${bar(safetyLockCount).padEnd(BAR_MAX + 1)}${safetyLockCount}</code>`);
    if (pumpHoldCount > 0)
      lines.push(`<code>${"Pump-Hold".padEnd(18)} ${bar(pumpHoldCount).padEnd(BAR_MAX + 1)}${pumpHoldCount}</code>`);
    if (r8HoldCount > 0)
      lines.push(`<code>${"R8-held".padEnd(18)} ${bar(r8HoldCount).padEnd(BAR_MAX + 1)}${r8HoldCount}</code>`);
  }

  return lines.join("\n");
}

function formatHelpText() {
  return [
    "Telegram commands",
    "",
    "/help — show commands",
    "/status — wallet + positions snapshot",
    "/status apis — check all API status (relay, hivemind, gmgn, jupiter, meteora, rpc)",
    "/status relay — check Agent Meridian relay status",
    "/status hivemind — check HiveMind server status",
    "/status gmgn — check GMGN chart indicators status",
    "/status jupiter — check Jupiter swap API status",
    "/status meteora — check Meteora DLMM API status",
    "/status rpc — check Solana RPC status",
    "/wallet — wallet, deploy amount, HiveMind status",
    "/positions — list open positions",
    "/history — last 10 closed positions",
    "/learn — performance summary + recent lessons",
    "/performance — detailed performance: 24h/7d/30d breakdown",
    "/performance 7d — last 7 days performance",
    "/performance 30d — last 30 days performance",
    "/performance all — all-time performance",
    "/observe — exit rule snapshot: reasons, OOR counts, active profile",
    "/observe <N> — same aggregated over last N days (max 7)",
    "/observe details — trailing-armed OOR closes with pair + PnL",
    "/observe compare — close distribution: baseline vs current period",
    "/observe compare <B> <C> — baseline B days vs current C days",
    "/observe held — positions held by Safety-Lock, Pump-Hold, or R8 (last 24h)",
    "/observe reasons — bar chart of close reasons today",
    "/pool <n> — detailed info for one open position",
    "/close <n> — close one position by index",
    "/closeall — close all open positions",
    "/set <n> <note> — set note/instruction on position",
    "/cooldown <symbol> <hours> — manually block a token (e.g. /cooldown BELKA 4)",
    "/uncooldown <symbol> — clear manual cooldown for a token",
    "/blockdeploy <pool|mint|wallet> [reason] — block a deployer wallet (no arg = list)",
    "/unblockdeploy <wallet> — remove deployer from blocklist",
    "/config — show important runtime config",
    "/settings — button menu for common config",
    "/setcfg <key> <value> — update persisted config",
    "/screen — run full screening cycle (enrich + LLM pick + deploy)",
    "/candidates — show latest cached candidates",
    "/deploy <n> — deploy candidate by cached index",
    "/briefing — morning briefing",
    "/hive — HiveMind sync status",
    "/hive pull — manual HiveMind pull now",
    "/pause — stop cron cycles",
    "/resume — start cron cycles again",
    "/stop — shut down agent",
    "",
    "/myid — show your Telegram user ID",
    "/lockuser — lock bot to your account only",
  ].join("\n");
}

async function runDeterministicScreen(limit = 5) {
  const top = await getTopCandidates({ limit });
  const candidates = (top?.candidates || top?.pools || []).slice(0, limit);
  setLatestCandidates(candidates);
  if (candidates.length > 0) {
    const lines = candidates.map((pool, i) => {
      const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
      const vol = pool.volume_window ?? pool.volume_24h ?? "?";
      const source = pool.gmgn ? ` | GMGN smart ${pool.gmgn_smart_wallets ?? "?"}, KOL ${pool.gmgn_kol_wallets ?? "?"}, total fee ${pool.gmgn_total_fee_sol ?? "?"} SOL` : ` | organic ${pool.organic_score ?? "?"}`;
      return `${i + 1}. ${pool.name} | ${pool.pool}\n   fee/aTVL ${feeTvl}% | vol $${vol}${source}`;
    });
    return `Top candidates (${candidates.length})\n\n${lines.join("\n")}`;
  }
  const examples = (top?.filtered_examples || []).slice(0, 3)
    .map((entry) => `- ${entry.name}: ${entry.reason}`)
    .join("\n");
  return examples
    ? `No candidates available.\nFiltered examples:\n${examples}`
    : "No candidates available right now.";
}

async function deployLatestCandidate(index) {
  const candidate = _latestCandidates[index];
  if (!candidate) {
    throw new Error("Invalid candidate index. Run /screen first.");
  }
  if (_latestCandidates.length === 1) {
    const mint = candidate.base?.mint || candidate.base_mint || null;
    const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
      checkSmartWalletsOnPool({ pool_address: candidate.pool }),
      mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
    ]);
    const context = {
      pool: candidate,
      sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
      n: narrative.status === "fulfilled" ? narrative.value : null,
      ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
    };
    const skipReason = getLoneCandidateSkipReason(context);
    if (skipReason) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "Single cached candidate skipped",
        reason: skipReason,
        pool: candidate.pool,
        pool_name: candidate.name,
      });
      throw new Error(`NO DEPLOY: only cached candidate ${candidate.name} is not worth deploying — ${skipReason}`);
    }
  }
  const deployAmount = computeDeployAmount((await getWalletBalances()).sol);
  const binsBelow = computeBinsBelow(candidate.volatility);
  const result = await executeTool("deploy_position", {
    pool_address: candidate.pool,
    amount_y: deployAmount,
    strategy: config.strategy.strategy,
    bins_below: binsBelow,
    bins_above: config.strategy.binsAbove,
    pool_name: candidate.name,
    base_mint: candidate.base?.mint || candidate.base_mint || null,
    bin_step: candidate.bin_step,
    base_fee: candidate.base_fee,
    volatility: candidate.volatility,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio,
    organic_score: candidate.organic_score,
    initial_value_usd: candidate.tvl ?? candidate.active_tvl ?? null,
  });
  if (result?.success === false || result?.error) {
    throw new Error(result.error || "Deploy failed");
  }
  return { result, candidate, deployAmount, binsBelow };
}

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function refreshPrompt() {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
}

async function resolveDeployerForBlock(input) {
  // Try pool-memory: input might be a pool address with a known base_mint
  let mint = null;
  let label = null;
  let source = "input";
  try {
    const pm = getPoolMemory({ pool_address: input });
    if (pm && !pm.error && pm.base_mint) {
      mint = pm.base_mint;
      label = pm.name || null;
      source = "pool";
    }
  } catch {}

  // If no pool match, treat input as a possible mint and ask Jupiter
  const queryMint = mint || input;
  let dev = null;
  try {
    const res = await fetch(`https://datapi.jup.ag/v1/assets/search?query=${encodeURIComponent(queryMint)}`);
    if (res.ok) {
      const data = await res.json();
      const t = Array.isArray(data) ? data[0] : data?.[0] || data;
      if (t?.dev) {
        dev = t.dev;
        if (!label && t.symbol) label = t.symbol;
        if (source === "input" && mint) source = "pool";
        else if (source === "input") source = "mint";
      }
    }
  } catch {}

  if (dev) return { wallet: dev, label, source };

  // Last resort: assume input is already a wallet (operator typed wallet directly)
  // We can't auto-derive a label here, so leave label null.
  if (!mint) return { wallet: input, label: null, source: "input" };

  return { wallet: null, error: `Pool ${input} resolved to mint ${mint} but Jupiter has no dev field for it.` };
}

async function drainTelegramQueue() {
  while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
    const queued = _telegramQueue.shift();
    await telegramHandler(queued);
  }
}

async function telegramHandler(msg) {
  const text = msg?.text?.trim();
  if (!text) return;

  if (_pendingInput && !msg.isCallback && !text.startsWith("/")) {
    const { key, page, menuMsgId } = _pendingInput;
    _pendingInput = null;
    let value;
    if (text.toLowerCase() === "off" || text.toLowerCase() === "null") {
      value = null;
    } else {
      value = Number(text);
      if (!Number.isFinite(value)) {
        await sendMessage(`Invalid value "${text}" — must be a number or "off".`);
        return;
      }
    }
    const result = await executeTool("update_config", { changes: { [key]: value }, reason: "Telegram settings menu" });
    if (!result?.success) {
      await sendMessage(`Failed to update ${key}.`);
      return;
    }
    await showSettingsMenu({ messageId: menuMsgId, page });
    return;
  }
  if (msg?.isCallback && text.startsWith("cfg:")) {
    try {
      await applySettingsMenuCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {});
    }
    return;
  }
  if (text === "/settings" || text === "/menu" || text === "/configmenu") {
    await showSettingsMenu().catch((e) => sendMessage(`Settings error: ${e.message}`).catch(() => {}));
    return;
  }

  if (text === "/myid") {
    const uid = msg.from?.id;
    await sendMessage(uid
      ? `Your Telegram user ID is: ${uid}\n\nSend /lockuser to lock the bot to your account only.`
      : "Could not determine your user ID."
    ).catch(() => {});
    return;
  }

  if (text === "/lockuser") {
    const uid = msg.from?.id;
    if (!uid) {
      await sendMessage("Could not determine your user ID.").catch(() => {});
      return;
    }
    saveAllowedUserId(uid);
    await sendMessage(`Bot locked to user ID ${uid}. Only you can send commands now.`).catch(() => {});
    return;
  }

  if (_managementBusy || _screeningBusy || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
      sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch(() => {});
    } else {
      sendMessage("Queue is full (5 messages). Wait for the agent to finish.").catch(() => {});
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTML(briefing);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/help") {
    await sendMessage(formatHelpText()).catch(() => {});
    return;
  }

  if (text === "/wallet" || text === "/status") {
    try {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
      const suffix = text === "/status" && positions.total_positions
        ? `\n\nUse /positions for the numbered list.`
        : "";
      await sendMessage(`${formatWalletStatus(wallet, positions)}${suffix}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  // /status subcommands: relay, hivemind, gmgn, jupiter, meteora, rpc, apis
  if (text.startsWith("/status ")) {
    const subcommand = text.slice(8).trim().toLowerCase();
    try {
      let result;
      let name;
      switch (subcommand) {
        case "relay":
          result = await checkRelay();
          name = result.name;
          break;
        case "hivemind":
          result = await checkHiveMind();
          name = result.name;
          break;
        case "gmgn":
          result = await checkGmgnIndicators();
          name = result.name;
          break;
        case "jupiter":
          result = await checkJupiter();
          name = result.name;
          break;
        case "meteora":
          result = await checkMeteora();
          name = result.name;
          break;
        case "rpc":
          result = await checkSolanaRpc();
          name = result.name;
          break;
        case "apis":
        case "all":
          const results = await checkAllApis();
          await sendHTML(`<b>🔍 API Status</b>\n\n${formatApiStatus(results)}`).catch(() => {});
          return;
        default:
          await sendMessage(`Unknown subcommand: /status ${subcommand}\n\nAvailable: relay, hivemind, gmgn, jupiter, meteora, rpc, apis`).catch(() => {});
          return;
      }
      const icon = result.ok ? "✅" : "❌";
      const latency = result.latency ? `${result.latency}ms` : "?";
      const status = result.status ? `${result.status}` : "timeout";
      const error = result.error ? `\n⚠️ ${result.error.replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 80)}` : "";
      await sendHTML(`${icon} <b>${name}</b>\nStatus: ${status} (${latency})${error}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/config") {
    await sendMessage(formatConfigSnapshot()).catch(() => {});
    return;
  }

  if (text === "/history") {
    try {
      const deploys = getRecentDeploys(10);
      if (!deploys.length) { await sendHTML("No closed positions yet."); return; }
      function timeAgo(iso) {
        if (!iso) return "—";
        const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        return `${Math.floor(hrs / 24)}d ago`;
      }
      function fmtSigned(val, decimals, prefix) {
        if (val == null) return null;
        const sign = val >= 0 ? "+" : "-";
        return `${sign}${prefix}${Math.abs(val).toFixed(decimals)}`;
      }
      const lines = deploys.map((d, i) => {
        const pnlPct = d.pnl_pct ?? 0;
        const pnlEmoji = pnlPct >= 0 ? "🟢" : "🔴";
        const pnlSign = pnlPct >= 0 ? "+" : "";
        // PnL: show SOL if available, always show USD
        const pnlSolStr = d.pnl_sol != null ? fmtSigned(d.pnl_sol, 4, "◎") : null;
        const pnlUsdStr = fmtSigned(d.pnl_usd ?? 0, 2, "$");
        const pnlAmounts = [pnlSolStr, pnlUsdStr].filter(Boolean).join(" / ");
        // Fees: show both SOL and USD when available
        const feeSolStr = d.fees_earned_sol != null ? `◎${d.fees_earned_sol.toFixed(4)}` : null;
        const feeUsdStr = d.fees_earned_usd != null ? `$${d.fees_earned_usd.toFixed(2)}` : null;
        const feeStr = [feeSolStr, feeUsdStr].filter(Boolean).join(" / ") || "—";
        const held = d.minutes_held != null ? `${d.minutes_held}m` : "—";
        const reason = htmlEscape(d.close_reason || "?");
        return `${i + 1}. <b>${htmlEscape(d.pool_name)}</b> ${pnlEmoji} ${pnlSign}${pnlPct.toFixed(2)}% (${pnlAmounts}) | 📥 ${feeStr} | ⏱ ${held} | ${timeAgo(d.closed_at)}`;
      });
      const wins = deploys.filter((d) => (d.pnl_pct ?? 0) >= 0).length;
      const avgPnl = deploys.reduce((s, d) => s + (d.pnl_pct ?? 0), 0) / deploys.length;
      const avgSign = avgPnl >= 0 ? "+" : "";
      const totalFeesSol = deploys.reduce((s, d) => s + (d.fees_earned_sol ?? 0), 0);
      const totalFeesUsd = deploys.reduce((s, d) => s + (d.fees_earned_usd ?? 0), 0);
      await sendHTML(
        `<b>📋 Last ${deploys.length} Closed Positions</b>\n\n` +
        lines.join("\n") +
        `\n\nWin rate: ${wins}/${deploys.length} (${Math.round(wins / deploys.length * 100)}%) | Avg PnL: ${avgSign}${avgPnl.toFixed(2)}%` +
        `\nTotal fees: ◎${totalFeesSol.toFixed(4)} / $${totalFeesUsd.toFixed(2)}`
      );
    } catch (e) { await sendHTML(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/learn") {
    try {
      const perf = getPerformanceSummary();
      const { lessons } = listLessons({ limit: 8 });
      const lines = [];
      if (perf) {
        const pnlSign = perf.total_pnl_usd >= 0 ? "+" : "";
        lines.push(
          `<b>📊 Performance Summary</b>`,
          `Closed: ${perf.total_positions_closed} | Win rate: ${perf.win_rate_pct}% | Avg PnL: ${perf.avg_pnl_pct >= 0 ? "+" : ""}${perf.avg_pnl_pct}%`,
          `Total PnL: ${pnlSign}$${perf.total_pnl_usd} | Range efficiency: ${perf.avg_range_efficiency_pct}%`,
          `Lessons stored: ${perf.total_lessons}`,
        );
      } else {
        lines.push("<b>📊 Performance Summary</b>", "No closed positions recorded yet.");
      }
      if (lessons.length > 0) {
        lines.push("", "<b>🧠 Recent Lessons</b>");
        lessons.slice(-8).reverse().forEach((l, i) => {
          const pin = l.pinned ? "📌 " : "";
          const tag = l.tags?.length ? ` [${l.tags.join(", ")}]` : "";
          lines.push(`${i + 1}. ${pin}${htmlEscape(l.rule)}${tag}`);
        });
      } else {
        lines.push("", "No lessons recorded yet.");
      }
      await sendHTML(lines.join("\n"));
    } catch (e) { await sendHTML(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/performance" || text.startsWith("/performance ")) {
    try {
      const arg = text.slice("/performance".length).trim();
      const periodHours = arg === "7d" ? 168 : arg === "30d" ? 720 : arg === "all" ? 87600 : 24;
      const periodLabel = arg === "7d" ? "7 days" : arg === "30d" ? "30 days" : arg === "all" ? "all time" : "24 hours";

      const hist = getPerformanceHistory({ hours: periodHours, limit: 1000 });
      const allTime = getPerformanceSummary();

      if (!allTime || hist.count === 0) {
        await sendHTML(`<b>📊 Performance</b>\n\nNo closed positions recorded yet.`);
        return;
      }

      // Period stats
      const p = hist.positions;
      const wins = p.filter(r => r.pnl_usd > 0).length;
      const losses = p.filter(r => r.pnl_usd <= 0).length;
      const totalPnl = p.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
      const totalFees = p.reduce((s, r) => s + (r.fees_earned_usd ?? 0), 0);
      const avgPnl = p.length > 0 ? p.reduce((s, r) => s + (r.pnl_pct ?? 0), 0) / p.length : 0;
      const winRate = p.length > 0 ? Math.round(wins / p.length * 100) : 0;

      // Best/worst pools
      const byPool = {};
      for (const r of p) {
        const key = r.pool_name || r.pool?.slice(0, 8) || "?";
        if (!byPool[key]) byPool[key] = { pnl: 0, fees: 0, count: 0 };
        byPool[key].pnl += r.pnl_usd ?? 0;
        byPool[key].fees += r.fees_earned_usd ?? 0;
        byPool[key].count++;
      }
      const poolEntries = Object.entries(byPool).sort((a, b) => b[1].pnl - a[1].pnl);
      const bestPool = poolEntries[0];
      const worstPool = poolEntries[poolEntries.length - 1];

      // Close reason breakdown
      const byReason = {};
      for (const r of p) {
        const reason = r.close_reason || "unknown";
        if (!byReason[reason]) byReason[reason] = { count: 0, pnl: 0 };
        byReason[reason].count++;
        byReason[reason].pnl += r.pnl_usd ?? 0;
      }
      const reasonLines = Object.entries(byReason)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([reason, data]) => {
          const sign = data.pnl >= 0 ? "+" : "";
          return `  ${htmlEscape(reason)}: ${data.count}x (${sign}$${data.pnl.toFixed(2)})`;
        });

      const pnlSign = totalPnl >= 0 ? "+" : "";
      const pnlEmoji = totalPnl >= 0 ? "🟢" : "🔴";
      const allPnlSign = allTime.total_pnl_usd >= 0 ? "+" : "";

      const lines = [
        `<b>📊 Performance — ${periodLabel}</b>`,
        ``,
        `<b>Period</b>`,
        `Positions: ${hist.count} (W:${wins} L:${losses})`,
        `Win rate: ${winRate}%`,
        `Total PnL: ${pnlEmoji} ${pnlSign}$${totalPnl.toFixed(2)}`,
        `Avg PnL: ${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}%`,
        `Fees earned: $${totalFees.toFixed(2)}`,
        ``,
        `<b>All Time</b>`,
        `Positions: ${allTime.total_positions_closed} | Win rate: ${allTime.win_rate_pct}%`,
        `Total PnL: ${allPnlSign}$${allTime.total_pnl_usd} | Range eff: ${allTime.avg_range_efficiency_pct}%`,
      ];

      if (bestPool && worstPool && poolEntries.length > 1) {
        lines.push("", `<b>Pool PnL</b>`);
        lines.push(`Best: ${htmlEscape(bestPool[0])} (${bestPool[1].count}x, +$${bestPool[1].pnl.toFixed(2)})`);
        if (bestPool[0] !== worstPool[0]) {
          lines.push(`Worst: ${htmlEscape(worstPool[0])} (${worstPool[1].count}x, $${worstPool[1].pnl.toFixed(2)})`);
        }
      }

      if (reasonLines.length > 0) {
        lines.push("", `<b>Close Reasons</b>`);
        lines.push(...reasonLines);
      }

      await sendHTML(lines.join("\n"));
    } catch (e) { await sendHTML(`Error: ${htmlEscape(e.message)}`).catch(() => {}); }
    return;
  }

  if (text === "/observeheld") {
    try { await sendHTML(await buildObserveHeld()); } catch (e) { await sendHTML(`Error: ${htmlEscape(e.message)}`).catch(() => {}); }
    return;
  }
  if (text === "/observereasons") {
    try { await sendHTML(await buildObserveReasons()); } catch (e) { await sendHTML(`Error: ${htmlEscape(e.message)}`).catch(() => {}); }
    return;
  }
  if (text === "/observecompare" || text.startsWith("/observecompare ")) {
    try {
      const parts = text.slice("/observecompare".length).trim().split(/\s+/).map(Number).filter(n => Number.isFinite(n) && n > 0);
      await sendHTML(await buildObserveCompare(parts[0] ?? null, parts[1] ?? null));
    } catch (e) { await sendHTML(`Error: ${htmlEscape(e.message)}`).catch(() => {}); }
    return;
  }
  if (text === "/observe" || text.startsWith("/observe ")) {
    try {
      const arg = text.slice("/observe".length).trim();
      let report;
      if (arg === "compare" || arg.startsWith("compare ")) {
        const parts = arg.slice("compare".length).trim().split(/\s+/).map(Number).filter(n => Number.isFinite(n) && n > 0);
        report = await buildObserveCompare(parts[0] ?? null, parts[1] ?? null);
      } else if (arg === "held") {
        report = await buildObserveHeld();
      } else if (arg === "reasons") {
        report = await buildObserveReasons();
      } else if (arg === "details") {
        report = await buildObserveReport({ days: 1, details: true });
      } else {
        const n = parseInt(arg, 10);
        report = await buildObserveReport({ days: Number.isFinite(n) && n >= 1 ? Math.min(n, 7) : 1 });
      }
      await sendHTML(report);
    } catch (e) {
      await sendHTML(`Error: ${htmlEscape(e.message)}`).catch(() => {});
    }
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) { await sendHTML("No open positions."); return; }
      const cur = config.management.solMode ? "◎" : "$";

      const blocks = positions.map((p, i) => {
        const pnlSign = (p.pnl_pct ?? 0) >= 0 ? "+" : "";
        const pnlPctStr = `${pnlSign}${(p.pnl_pct ?? 0).toFixed(1)}%`;
        const range = fmtRangeBar(p.active_bin, p.lower_bin, p.upper_bin);
        const rangeEmoji = range.oor ? "🔴" : "🟢";
        const rangeLabel = range.oor
          ? `${range.bar} bin ${p.active_bin} (${range.oor} ${p.lower_bin}–${p.upper_bin})`
          : `${range.bar} ${range.pct}% (bin ${p.active_bin}/${p.lower_bin}–${p.upper_bin})`;
        const pnlUsdStr = (p.pnl_usd ?? 0) >= 0 ? `+${cur}${(p.pnl_usd ?? 0).toFixed(3)}` : `-${cur}${(Math.abs(p.pnl_usd) ?? 0).toFixed(3)}`;
        const ageStr = fmtAge(p.age_minutes);
        const feeBar = feeTvlBar(p.fee_per_tvl_24h);
        const feeStr24h = p.fee_per_tvl_24h != null ? `${feeBar} ${p.fee_per_tvl_24h.toFixed(2)}%/24h` : "—";
        const rangeLine = p.in_range
          ? "🟢 IN"
          : `🔴 OOR ${fmtAge(p.minutes_out_of_range ?? 0)}`;
        const valueStr = `${cur}${(p.total_value_usd ?? 0).toFixed(3)}`;
        const unclaimedStr = `${cur}${(p.unclaimed_fees_usd ?? 0).toFixed(3)}`;
        const statusEmoji = positionStatusEmoji(p);
        const noteLine = p.instruction ? `\n   📝 "${htmlEscape(p.instruction)}"` : "";

        return [
          `${statusEmoji} <b>${i + 1}. ${htmlEscape(p.pair)}</b> | ${p.strategy ?? "spot"}`,
          `   💰 ${valueStr} | PnL: ${pnlPctStr} (${pnlUsdStr})`,
          `   📍 ${rangeEmoji} ${rangeLabel} | ⏱ ${ageStr}`,
          `   📈 ${feeStr24h} | 📥 ${unclaimedStr} unclaimed`,
          `   ${rangeLine}${noteLine}`,
        ].join("\n");
      });

      const totalValue = positions.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
      const avgPnl = positions.reduce((s, p) => s + (p.pnl_pct ?? 0), 0) / (positions.length || 1);
      const avgFee24h = positions.reduce((s, p) => s + (p.fee_per_tvl_24h ?? 0), 0) / (positions.length || 1);
      const profitableCount = positions.filter(p => (p.pnl_pct ?? 0) > 0).length;
      const oorCount = positions.filter(p => !p.in_range).length;
      const avgSign = avgPnl >= 0 ? "+" : "";
      const summary = `📦 ${total_positions} positions | ${profitableCount}🟢 ${oorCount}🔴 | 💵 Total: ${cur}${totalValue.toFixed(3)} | 📊 Avg PnL: ${avgSign}${avgPnl.toFixed(2)}% | 📈 Avg fee/TVL: ${avgFee24h.toFixed(2)}%/24h`;

      await sendHTML(
        `<b>📊 Open Positions (${total_positions})</b>\n\n` +
        blocks.join("\n\n") +
        `\n\n${summary}\n\n/close &lt;n&gt; to close | /set &lt;n&gt; &lt;note&gt; to set instruction`
      );
    } catch (e) { await sendHTML(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const poolMatch = text.match(/^\/pool\s+(\d+)$/i);
  if (poolMatch) {
    try {
      const idx = parseInt(poolMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage([
        `${idx + 1}. ${pos.pair}`,
        `Pool: ${pos.pool}`,
        `Position: ${pos.position}`,
        `Range: ${pos.lower_bin} → ${pos.upper_bin} | active ${pos.active_bin}`,
        `PnL: ${pos.pnl_pct ?? "?"}% | fees: ${config.management.solMode ? "◎" : "$"}${pos.unclaimed_fees_usd ?? "?"}`,
        `Value: ${config.management.solMode ? "◎" : "$"}${pos.total_value_usd ?? "?"}`,
        `Age: ${pos.age_minutes ?? "?"}m | ${pos.in_range ? "IN RANGE" : `OOR ${pos.minutes_out_of_range ?? 0}m`}`,
        pos.instruction ? `Note: ${pos.instruction}` : null,
      ].filter(Boolean).join("\n"));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage(`Closing ${pos.pair}...`);
      const result = await closePosition({ position_address: pos.position });
      if (result.success) {
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        const claimNote = result.claim_txs?.length ? `\nClaim txs: ${result.claim_txs.join(", ")}` : "";
        await sendMessage(`✅ Closed ${pos.pair}\nPnL: ${config.management.solMode ? "◎" : "$"}${result.pnl_usd ?? "?"} | close txs: ${closeTxs?.join(", ") || "n/a"}${claimNote}`);
      } else {
        await sendMessage(`❌ Close failed: ${JSON.stringify(result)}`);
      }
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/closeall") {
    try {
      const { positions } = await getMyPositions({ force: true });
      if (!positions.length) { await sendMessage("No open positions."); return; }
      await sendMessage(`Closing ${positions.length} position(s)...`);
      const results = [];
      for (const pos of positions) {
        try {
          const result = await closePosition({ position_address: pos.position });
          results.push(`${pos.pair}: ${result.success ? "closed" : `failed (${result.error || "unknown"})`}`);
        } catch (error) {
          results.push(`${pos.pair}: failed (${error.message})`);
        }
      }
      await sendMessage(`Close-all finished.\n\n${results.join("\n")}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const cooldownMatch = text.match(/^\/cooldown\s+(\S+)\s+(\d+(?:\.\d+)?)$/i);
  if (cooldownMatch) {
    try {
      const { setManualCooldown } = await import("./pool-cooldown.js");
      const symbol = cooldownMatch[1].trim();
      const hours = parseFloat(cooldownMatch[2]);
      const result = setManualCooldown(symbol, hours);
      if (!result.found) {
        await sendMessage(`❌ No pool history found for <b>${symbol}</b>.\nToken must have been deployed before to appear in pool memory.`).catch(() => {});
      } else {
        const until = new Date(Date.now() + hours * 60 * 60 * 1000).toLocaleString("en-US", { timeZone: "UTC", hour12: false });
        await sendMessage(`⏸ Cooldown set for <b>${symbol}</b> — ${hours}h\nUntil: ${until} UTC\nPools: ${result.pools.join(", ")}`).catch(() => {});
      }
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const uncooldownMatch = text.match(/^\/uncooldown\s+(\S+)$/i);
  if (uncooldownMatch) {
    try {
      const { clearManualCooldown } = await import("./pool-cooldown.js");
      const symbol = uncooldownMatch[1].trim();
      const result = clearManualCooldown(symbol);
      if (!result.found) {
        await sendMessage(`❌ No pool history found for <b>${symbol}</b>.`).catch(() => {});
      } else {
        await sendMessage(`✅ Cooldown cleared for <b>${symbol}</b>\nPools: ${result.pools.join(", ")}`).catch(() => {});
      }
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendMessage(`✅ Note set for ${pos.pair}:\n"${note}"`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const setCfgMatch = text.match(/^\/setcfg\s+([A-Za-z0-9_]+)\s+(.+)$/i);
  if (setCfgMatch) {
    try {
      const key = setCfgMatch[1];
      const value = parseConfigValue(setCfgMatch[2]);
      const result = await executeTool("update_config", {
        changes: { [key]: value },
        reason: "Telegram slash command /setcfg",
      });
      if (!result?.success) {
        await sendMessage(`Config update failed.\nUnknown: ${(result?.unknown || []).join(", ") || "none"}`).catch(() => {});
        return;
      }
      await sendMessage(`✅ Updated ${key} = ${JSON.stringify(value)}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const blockDeployMatch = text.match(/^\/blockdeploy(?:\s+(\S+)(?:\s+(.+))?)?$/i);
  if (blockDeployMatch) {
    try {
      const input = blockDeployMatch[1];
      if (!input) {
        const list = listBlockedDevs();
        if (!list.count) {
          await sendMessage("No deployers blocked.\n\nUsage: /blockdeploy <pool|mint|wallet> [reason]").catch(() => {});
          return;
        }
        const lines = list.blocked_devs.map((e, i) => `${i + 1}. ${e.label || "?"} | ${e.wallet}\n   ${e.reason || "no reason"}`);
        await sendMessage(`Blocked deployers (${list.count}):\n\n${lines.join("\n")}`).catch(() => {});
        return;
      }
      const reason = blockDeployMatch[2]?.trim() || "manual block via /blockdeploy";
      const resolved = await resolveDeployerForBlock(input);
      if (!resolved.wallet) {
        await sendMessage(`Couldn't resolve deployer from "${input}".\n${resolved.error || ""}`.trim()).catch(() => {});
        return;
      }
      const result = blockDev({ wallet: resolved.wallet, reason, label: resolved.label });
      if (result.already_blocked) {
        await sendMessage(`⚠️ Already blocked: ${resolved.label || resolved.wallet}\nReason: ${result.reason}`).catch(() => {});
        return;
      }
      const sourceNote = resolved.source === "input" ? "" : `\nResolved from ${resolved.source}: ${input}`;
      await sendMessage(`✅ Blocked deployer ${resolved.label || resolved.wallet}\nWallet: ${resolved.wallet}\nReason: ${reason}${sourceNote}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const unblockDeployMatch = text.match(/^\/unblockdeploy\s+(\S+)$/i);
  if (unblockDeployMatch) {
    try {
      const result = unblockDev({ wallet: unblockDeployMatch[1] });
      if (result.error) {
        await sendMessage(`❌ ${result.error}`).catch(() => {});
        return;
      }
      await sendMessage(`✅ Unblocked ${result.was?.label || result.wallet}\nWallet: ${result.wallet}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/screen") {
    try {
      await runScreeningCycle();
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/candidates") {
    await sendMessage(describeLatestCandidates(5)).catch(() => {});
    return;
  }

  const deployMatch = text.match(/^\/deploy\s+(\d+)$/i);
  if (deployMatch) {
    try {
      const idx = parseInt(deployMatch[1]) - 1;
      const { candidate, result, deployAmount, binsBelow } = await deployLatestCandidate(idx);
      const coverage = result.range_coverage
        ? `Range: ${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
        : `Strategy: ${config.strategy.strategy} | binsBelow: ${binsBelow}`;
      await sendMessage([
        `✅ Deployed ${candidate.name}`,
        `Pool: ${candidate.pool}`,
        `Amount: ${deployAmount} SOL`,
        coverage,
        `Position: ${result.position || "n/a"}`,
        result.txs?.length ? `Tx: ${result.txs[0]}` : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/pause") {
    stopCronJobs();
    cronStarted = false;
    await sendMessage("⏸ Paused autonomous cycles. Telegram control still works. Use /resume to start again.").catch(() => {});
    return;
  }

  if (text === "/resume") {
    if (!cronStarted) {
      cronStarted = true;
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      await sendMessage("▶️ Autonomous cycles resumed.").catch(() => {});
    } else {
      await sendMessage("Autonomous cycles are already running.").catch(() => {});
    }
    return;
  }

  if (text === "/hive" || text === "/hive pull") {
    try {
      const enabled = isHiveMindEnabled();
      const agentId = ensureAgentId();
      if (!enabled) {
        await sendMessage(`HiveMind: disabled\nAgent ID: ${agentId}\nSet hiveMindApiKey to connect.`).catch(() => {});
        return;
      }
      const isManualPull = text === "/hive pull";
      const pullMode = getHiveMindPullMode();
      const [registerResult, lessons, presets] = await Promise.all([
        registerHiveMindAgent({ reason: isManualPull ? "telegram_pull" : "telegram_status" }),
        (pullMode === "auto" || isManualPull) ? pullHiveMindLessons(12) : Promise.resolve(null),
        (pullMode === "auto" || isManualPull) ? pullHiveMindPresets() : Promise.resolve(null),
      ]);
      await sendMessage([
        "HiveMind: enabled",
        `Agent ID: ${agentId}`,
        `URL: ${config.hiveMind.url}`,
        `Pull mode: ${pullMode}`,
        `Register: ${registerResult ? "ok" : "warn"}`,
        `Shared lessons: ${Array.isArray(lessons) ? lessons.length : (pullMode === "manual" ? "manual" : 0)}`,
        `Presets: ${Array.isArray(presets) ? presets.length : (pullMode === "manual" ? "manual" : 0)}`,
        isManualPull ? "Manual pull: completed" : null,
      ].join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`HiveMind error: ${e.message}`).catch(() => {});
    }
    return;
  }

  busy = true;
  let liveMessage = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
    liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
    const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
      interactive: true,
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    appendHistory(text, content);
    if (liveMessage) await liveMessage.finalize(htmlEscape(stripThink(content)));
    else await sendMessage(stripThink(content));
  } catch (e) {
    if (liveMessage) await liveMessage.fail(e.message).catch(() => {});
    else await sendMessage(`Error: ${e.message}`).catch(() => {});
  } finally {
    busy = false;
    refreshPrompt();
    drainTelegramQueue().catch(() => {});
  }
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

function fmtAge(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function fmtFeeTvl(value, timeframe) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const n = Number(value).toFixed(2);
  return timeframe ? `${n}%/${timeframe}` : `${n}%`;
}

function positionStatusEmoji(p) {
  if (p.pnl_pct == null) return "⚪";
  if (!p.in_range) return "🔴"; // OOR
  if (p.pnl_pct >= 2) return "🟢"; // Good profit
  if (p.pnl_pct >= 0) return "🟡"; // In range, neutral
  if (p.pnl_pct >= -3) return "🟠"; // In range, small loss
  return "🔴"; // In range, big loss
}

function feeTvlBar(value) {
  if (value == null || !Number.isFinite(Number(value))) return "";
  const n = Number(value);
  if (n < 1) return "▁";
  if (n < 3) return "▂▁";
  if (n < 6) return "▃▂▁";
  if (n < 10) return "▄▃▂▁";
  if (n < 20) return "▅▄▃▂▁";
  return "▆▅▄▃▂▁";
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isMain && isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  _ttyInterface = rl;

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    setLatestCandidates(candidates);

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  startPolling(telegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /screen        Run full screening cycle (enrich + LLM pick + deploy)
  /candidates    Refresh top pool list (no LLM, no deploy)
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    const latest = getLatestCandidatesMeta().candidates;
    if (!isNaN(pick) && pick >= 1 && pick <= latest.length) {
      await runBusy(async () => {
        const pool = latest[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is screening for a deploy-worthy candidate...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates, decide whether any candidate is worth deploying, and only call deploy_position with ${DEPLOY} SOL if conviction is strong. If only one candidate is returned and it lacks narrative or smart-wallet confirmation, skip and report NO DEPLOY. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/screen") {
      await runBusy(async () => {
        console.log("\nRunning full screening cycle...\n");
        const report = await runScreeningCycle();
        if (report) console.log(`\n${stripThink(report)}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        setLatestCandidates(candidates);
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync(repoPath("lessons.json"), "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { interactive: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else if (isMain) {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  (async () => {
    try {
      await runScreeningCycle({ silent: false });
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
