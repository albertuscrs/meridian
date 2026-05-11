/**
 * Pool cooldown system for Meridian.
 *
 * Manages cooldown periods for pools and base tokens after closes.
 * Cooldowns prevent the screener from re-deploying to pools that have
 * demonstrated poor performance (low yield, repeated OOR closes, etc.).
 *
 * Cooldown reasons:
 * - "low yield": Pool closed due to insufficient fee generation
 * - "oor": Out-of-range close (price moved outside position bins)
 * - "repeated oor": Multiple OOR closes in succession
 * - "stop loss": Closed via stop-loss trigger
 * - "loss > 1%": Manual close at loss > 1% (not stop loss)
 * - "oor big loss": OOR close with significant loss (pnlUsd < oorBigLossPnlThreshold)
 * - "cumulative loss > $5": Total loss across all deploys in the pool exceeds threshold
 * - "manual": User-initiated close
 */

import fs from "fs";
import { log } from "./logger.js";
import { config } from "./config.js";

const POOL_MEMORY_FILE = "./pool-memory.json";

// ─── Close Reason Constants ─────────────────────────────────────

export const CLOSE_REASON_LOW_YIELD = "low yield";
export const CLOSE_REASON_OOR = "oor";
export const CLOSE_REASON_REPEATED_OOR = "repeated oor";
export const CLOSE_REASON_STOP_LOSS = "stop loss";
export const CLOSE_REASON_MANUAL = "manual";
export const CLOSE_REASON_TRAILING_TP = "trailing tp";
export const CLOSE_REASON_TAKE_PROFIT = "take profit";
export const CLOSE_REASON_PUMPED_ABOVE = "pumped far above range";
export const CLOSE_REASON_UNKNOWN = "unknown";
export const CLOSE_REASON_LOSS_GT_1_PCT = "loss > 1%";
export const CLOSE_REASON_OOR_BIG_LOSS = "oor big loss";
export const CLOSE_REASON_CUMULATIVE_LOSS = "cumulative loss > $5";
export const CLOSE_REASON_R8_HELD = "r8 held";

// ─── Load / Save ───────────────────────────────────────────────

function load() {
  if (!fs.existsSync(POOL_MEMORY_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(db) {
  fs.writeFileSync(POOL_MEMORY_FILE, JSON.stringify(db, null, 2));
}

// ─── Helpers ───────────────────────────────────────────────────

function isOorCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return (
    text === "oor" ||
    text.includes("out of range") ||
    text.includes("oor")
  );
}

function isStopLossCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("stop loss");
}

function isTrailingTpCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("trailing tp") || text.includes("trailing take profit");
}

function isTakeProfitCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("take profit") || text.includes("pumped far above range");
}

function isLowYieldCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("low yield");
}

function isR8HeldCloseReason(reason) {
  return String(reason || "").toLowerCase().includes("r8 held");
}

function isManualCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text === "manual" || text === "user requested";
}

function isLossGt1PctCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("loss > 1%") || text.includes("> 1%") || text.includes("loss_gt_1pct");
}

function isCumulativeLossCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("cumulative loss");
}

// ─── Cooldown Getters ──────────────────────────────────────────

/**
 * Get cooldown duration in hours for a given close reason.
 * Reads from config.management, falls back to defaults.
 */
export function getCooldownHoursForReason(reason) {
  const mgmt = config.management;

  if (isLowYieldCloseReason(reason)) {
    return mgmt.lowYieldCooldownHours ?? 4;
  }
  if (isStopLossCloseReason(reason)) {
    return mgmt.stopLossCooldownHours ?? 2;
  }
  if (isTrailingTpCloseReason(reason)) {
    return mgmt.trailingTpCooldownHours ?? 2;
  }
  if (isManualCloseReason(reason)) {
    return mgmt.manualCloseCooldownHours ?? 1;
  }
  if (isTakeProfitCloseReason(reason)) {
    return mgmt.takeProfitCooldownHours ?? 1;
  }
  if (isLossGt1PctCloseReason(reason)) {
    return mgmt.lossGt1PctCooldownHours ?? 1;
  }
  if (isCumulativeLossCloseReason(reason)) {
    return mgmt.cumulativeLossCooldownHours ?? 48;
  }
  if (isR8HeldCloseReason(reason)) {
    return mgmt.r8OorCooldownHours ?? 6;
  }
  return mgmt.defaultCooldownHours ?? 4;
}

/**
 * Get the number of OOR closes required to trigger a pool/base-mint cooldown.
 */
export function getOorCooldownTriggerCount() {
  return config.management.oorCooldownTriggerCount ?? 3;
}

/**
 * Get the cooldown hours when OOR closes exceed the trigger count.
 */
export function getOorCooldownHours() {
  return config.management.oorCooldownHours ?? 12;
}

/**
 * Get cooldown hours for low yield.
 */
export function getLowYieldCooldownHours() {
  return config.management.lowYieldCooldownHours ?? 4;
}

/**
 * Get cooldown hours for stop loss.
 */
export function getStopLossCooldownHours() {
  return config.management.stopLossCooldownHours ?? 2;
}

/**
 * Get cooldown hours for loss > 1% (manual close at loss, not stop loss).
 */
export function getLossGt1PctCooldownHours() {
  return config.management.lossGt1PctCooldownHours ?? 1;
}

/**
 * Get cooldown hours for OOR big loss.
 */
export function getOorBigLossCooldownHours() {
  return config.management.oorBigLossCooldownHours ?? 6;
}

/**
 * Get the PnL threshold (USD, negative) below which an OOR close is considered a "big loss".
 */
export function getOorBigLossPnlThreshold() {
  return config.management.oorBigLossPnlThreshold ?? -2;
}

/**
 * Get cooldown hours for cumulative pool loss.
 */
export function getCumulativeLossCooldownHours() {
  return config.management.cumulativeLossCooldownHours ?? 48;
}

/**
 * Get the cumulative loss threshold in USD (negative).
 */
export function getCumulativeLossThreshold() {
  return config.management.cumulativeLossThreshold ?? -5;
}

// ─── Cooldown Setters ──────────────────────────────────────────

function setPoolCooldown(entry, hours, reason) {
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  entry.cooldown_until = cooldownUntil;
  entry.cooldown_reason = reason;
  log(
    "pool-cooldown",
    `Pool cooldown set for ${entry.name} until ${cooldownUntil} (reason: ${reason}, ${hours}h)`
  );
  return cooldownUntil;
}

function setBaseMintCooldown(db, baseMint, hours, reason) {
  if (!baseMint) return null;
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  for (const entry of Object.values(db)) {
    if (entry?.base_mint === baseMint) {
      entry.base_mint_cooldown_until = cooldownUntil;
      entry.base_mint_cooldown_reason = reason;
    }
  }
  log(
    "pool-cooldown",
    `Base mint cooldown set for ${baseMint.slice(0, 8)}... until ${cooldownUntil} (reason: ${reason}, ${hours}h)`
  );
  return cooldownUntil;
}

// ─── Check Status ─────────────────────────────────────────────

/**
 * Check if a pool is currently on cooldown.
 * @param {string} poolAddress
 * @returns {boolean} true if cooldown is active
 */
export function isPoolOnCooldown(poolAddress) {
  if (!poolAddress) return false;
  const db = load();
  const entry = db[poolAddress];
  if (!entry?.cooldown_until) return false;
  const isActive = new Date(entry.cooldown_until) > new Date();
  if (isActive) {
    log("pool-cooldown", `Pool ${poolAddress.slice(0, 8)} is on cooldown until ${entry.cooldown_until}`);
  }
  return isActive;
}

/**
 * Check if a base token mint is currently on cooldown.
 * A base mint cooldown applies to ALL pools using that token.
 * @param {string} baseMint
 * @returns {boolean} true if cooldown is active
 */
export function isBaseMintOnCooldown(baseMint) {
  if (!baseMint) return false;
  const db = load();
  const now = new Date();
  const isOnCooldown = Object.values(db).some(
    (entry) =>
      entry?.base_mint === baseMint &&
      entry?.base_mint_cooldown_until &&
      new Date(entry.base_mint_cooldown_until) > now
  );
  if (isOnCooldown) {
    log("pool-cooldown", `Base mint ${baseMint.slice(0, 8)} is on cooldown`);
  }
  return isOnCooldown;
}

/**
 * Get cooldown info for a pool (for debugging/display).
 * @param {string} poolAddress
 * @returns {{ cooldown_until: string|null, cooldown_reason: string|null }}
 */
export function getPoolCooldownInfo(poolAddress) {
  if (!poolAddress) return { cooldown_until: null, cooldown_reason: null };
  const db = load();
  const entry = db[poolAddress];
  if (!entry) return { cooldown_until: null, cooldown_reason: null };
  return {
    cooldown_until: entry.cooldown_until || null,
    cooldown_reason: entry.cooldown_reason || null,
  };
}

/**
 * Get cooldown info for a base mint (for debugging/display).
 * @param {string} baseMint
 * @returns {{ base_mint_cooldown_until: string|null, base_mint_cooldown_reason: string|null }}
 */
export function getBaseMintCooldownInfo(baseMint) {
  if (!baseMint) return { base_mint_cooldown_until: null, base_mint_cooldown_reason: null };
  const db = load();
  for (const entry of Object.values(db)) {
    if (entry?.base_mint === baseMint) {
      return {
        base_mint_cooldown_until: entry.base_mint_cooldown_until || null,
        base_mint_cooldown_reason: entry.base_mint_cooldown_reason || null,
      };
    }
  }
  return { base_mint_cooldown_until: null, base_mint_cooldown_reason: null };
}

// ─── Cooldown Triggers ─────────────────────────────────────────

/**
 * Evaluate a closed position and apply cooldowns as needed.
 * Call this from lessons.js recordPerformance after a close.
 *
 * @param {Object} closeData
 * @param {string} closeData.pool_address
 * @param {string} closeData.pool_name
 * @param {string} closeData.base_mint
 * @param {string} closeData.close_reason
 * @param {number} closeData.pnlUsd - PnL in USD (negative for loss)
 * @param {number} closeData.pnlPct - PnL in percent (negative for loss)
 * @param {Object[]} closeData.recent_deploys - recent deploy history for the pool (for OOR count)
 */
export function evaluateAndSetCooldown(closeData) {
  const { pool_address, pool_name, base_mint, close_reason, pnlUsd, pnlPct } = closeData;
  if (!pool_address) return;

  const db = load();

  if (!db[pool_address]) {
    db[pool_address] = {
      name: pool_name || pool_address.slice(0, 8),
      base_mint: base_mint || null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  const entry = db[pool_address];

  let cooldownHours = 0;
  let cooldownReason = null;
  let baseMintCooldownHours = 0;
  let baseMintCooldownReason = null;

  // ── Scenario 1: Low Yield ─────────────────────────────────────
  if (isLowYieldCloseReason(close_reason)) {
    const hours = getLowYieldCooldownHours();
    if (hours > cooldownHours) {
      cooldownHours = hours;
      cooldownReason = CLOSE_REASON_LOW_YIELD;
    }
  }

  // ── Scenario 2: Stop Loss ────────────────────────────────────
  if (isStopLossCloseReason(close_reason)) {
    const hours = getStopLossCooldownHours();
    if (hours > cooldownHours) {
      cooldownHours = hours;
      cooldownReason = CLOSE_REASON_STOP_LOSS;
    }
    // Also cooldown the base mint on stop loss — token trending down
    if (base_mint && hours > baseMintCooldownHours) {
      baseMintCooldownHours = hours;
      baseMintCooldownReason = CLOSE_REASON_STOP_LOSS;
    }
  }

  // ── Scenario 3: Loss > 1% (manual close at loss, not stop loss) ──
  // Triggers when: manual close at loss AND pnlPct < -1 AND NOT stop loss
  if (isManualCloseReason(close_reason) && pnlPct !== undefined && pnlPct < -1) {
    if (!isStopLossCloseReason(close_reason)) {
      const hours = getLossGt1PctCooldownHours();
      if (hours > cooldownHours) {
        cooldownHours = hours;
        cooldownReason = CLOSE_REASON_LOSS_GT_1_PCT;
      }
    }
  }

  // ── Scenario 4: OOR Big Loss ────────────────────────────────
  // OOR close + pnlUsd < oorBigLossPnlThreshold (default -$2)
  if (isOorCloseReason(close_reason) && pnlUsd !== undefined) {
    const threshold = getOorBigLossPnlThreshold();
    if (pnlUsd < threshold) {
      const hours = getOorBigLossCooldownHours();
      if (hours > cooldownHours) {
        cooldownHours = hours;
        cooldownReason = CLOSE_REASON_OOR_BIG_LOSS;
      }
      // Also cooldown the base mint
      if (base_mint && hours > baseMintCooldownHours) {
        baseMintCooldownHours = hours;
        baseMintCooldownReason = CLOSE_REASON_OOR_BIG_LOSS;
      }
    }
  }

  // ── Scenario 5: Cumulative Loss > $5 ───────────────────────
  // Sum of all pnlUsd in entry.deploys + new pnlUsd
  const deploysPnl = entry.deploys.reduce((sum, d) => sum + (d.pnl_usd || 0), 0);
  const totalPnlUsd = deploysPnl + (pnlUsd || 0);
  const cumulativeThreshold = getCumulativeLossThreshold();
  if (totalPnlUsd < cumulativeThreshold) {
    const hours = getCumulativeLossCooldownHours();
    if (hours > cooldownHours) {
      cooldownHours = hours;
      cooldownReason = CLOSE_REASON_CUMULATIVE_LOSS;
    }
    // Also cooldown the base mint for cumulative loss
    if (base_mint && hours > baseMintCooldownHours) {
      baseMintCooldownHours = hours;
      baseMintCooldownReason = CLOSE_REASON_CUMULATIVE_LOSS;
    }
  }

  // ── Apply cooldowns (longest wins) ──────────────────────────
  if (cooldownHours > 0) {
    setPoolCooldown(entry, cooldownHours, cooldownReason);
  }

  if (baseMintCooldownHours > 0) {
    setBaseMintCooldown(db, base_mint, baseMintCooldownHours, baseMintCooldownReason);
  }

  // ── Trailing TP Cooldown ────────────────────────────────────
  if (isTrailingTpCloseReason(close_reason)) {
    const hours = getCooldownHoursForReason(CLOSE_REASON_TRAILING_TP);
    if (hours > cooldownHours) {
      setPoolCooldown(entry, hours, CLOSE_REASON_TRAILING_TP);
    }
  }

  // ── Take Profit / Pumped Above Range Cooldown ──────────────
  if (isTakeProfitCloseReason(close_reason)) {
    const hours = getCooldownHoursForReason(CLOSE_REASON_TAKE_PROFIT);
    if (hours > cooldownHours) {
      setPoolCooldown(entry, hours, CLOSE_REASON_TAKE_PROFIT);
    }
  }

  // ── Repeated OOR Cooldown ───────────────────────────────────
  // Only trigger if the current close_reason is OOR-related
  // (we don't want to cooldown on the first OOR close — wait for pattern)
  if (!isOorCloseReason(close_reason)) {
    save(db);
    return;
  }

  const triggerCount = getOorCooldownTriggerCount();
  const oorCooldownHours = getOorCooldownHours();

  const recentDeploys = entry.deploys
    .filter((d) => isOorCloseReason(d.close_reason))
    .slice(-(triggerCount - 1))
    .concat([{ close_reason }]);

  const repeatedOorCloses = recentDeploys.length >= triggerCount;

  if (repeatedOorCloses) {
    const reason = `${CLOSE_REASON_REPEATED_OOR} (${triggerCount}x)`;
    if (oorCooldownHours > cooldownHours) {
      setPoolCooldown(entry, oorCooldownHours, reason);
      if (base_mint) {
        setBaseMintCooldown(db, base_mint, oorCooldownHours, reason);
      }
    }
  }

  save(db);
}

/**
 * Manually set a cooldown by token symbol (matches pool names in pool-memory).
 * Applies base-mint cooldown to all pools sharing that token.
 * @param {string} symbol - e.g. "BELKA" or "BELKA-SOL"
 * @param {number} hours
 * @returns {{ found: boolean, pools: string[], baseMint: string|null }}
 */
export function setManualCooldown(symbol, hours) {
  const db = load();
  const search = symbol.toLowerCase().replace(/-sol$/, "").trim();
  const matched = Object.entries(db).filter(([, entry]) => {
    const name = String(entry?.name || "").toLowerCase().replace(/-sol$/, "").trim();
    return name === search || name.startsWith(search);
  });

  if (!matched.length) return { found: false, pools: [], baseMint: null };

  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  const reason = `manual (${hours}h)`;
  const baseMint = matched[0][1]?.base_mint || null;

  for (const [, entry] of matched) {
    entry.cooldown_until = cooldownUntil;
    entry.cooldown_reason = reason;
  }
  if (baseMint) {
    for (const entry of Object.values(db)) {
      if (entry?.base_mint === baseMint) {
        entry.base_mint_cooldown_until = cooldownUntil;
        entry.base_mint_cooldown_reason = reason;
      }
    }
  }

  save(db);
  log("pool-cooldown", `Manual cooldown set for ${symbol} (${hours}h) — ${matched.length} pool(s)`);
  return { found: true, pools: matched.map(([, e]) => e.name || "?"), baseMint };
}

/**
 * Clear cooldowns by token symbol (matches pool names in pool-memory).
 * @param {string} symbol
 * @returns {{ found: boolean, pools: string[] }}
 */
export function clearManualCooldown(symbol) {
  const db = load();
  const search = symbol.toLowerCase().replace(/-sol$/, "").trim();
  const matched = Object.entries(db).filter(([, entry]) => {
    const name = String(entry?.name || "").toLowerCase().replace(/-sol$/, "").trim();
    return name === search || name.startsWith(search);
  });

  if (!matched.length) return { found: false, pools: [] };

  const baseMint = matched[0][1]?.base_mint || null;
  for (const [, entry] of matched) {
    entry.cooldown_until = null;
    entry.cooldown_reason = null;
  }
  if (baseMint) {
    for (const entry of Object.values(db)) {
      if (entry?.base_mint === baseMint) {
        entry.base_mint_cooldown_until = null;
        entry.base_mint_cooldown_reason = null;
      }
    }
  }

  save(db);
  log("pool-cooldown", `Manual cooldown cleared for ${symbol} — ${matched.length} pool(s)`);
  return { found: true, pools: matched.map(([, e]) => e.name || "?") };
}

/**
 * Clear all cooldowns for a pool (e.g., when deploying fresh after manual review).
 * @param {string} poolAddress
 */
export function clearPoolCooldown(poolAddress) {
  if (!poolAddress) return;
  const db = load();
  const entry = db[poolAddress];
  if (!entry) return;
  entry.cooldown_until = null;
  entry.cooldown_reason = null;
  save(db);
  log("pool-cooldown", `Cooldowns cleared for pool ${poolAddress.slice(0, 8)}`);
}

/**
 * Clear all cooldowns for a base mint.
 * @param {string} baseMint
 */
export function clearBaseMintCooldown(baseMint) {
  if (!baseMint) return;
  const db = load();
  let found = false;
  for (const entry of Object.values(db)) {
    if (entry?.base_mint === baseMint) {
      entry.base_mint_cooldown_until = null;
      entry.base_mint_cooldown_reason = null;
      found = true;
    }
  }
  if (found) {
    save(db);
    log("pool-cooldown", `Cooldowns cleared for base mint ${baseMint.slice(0, 8)}`);
  }
}