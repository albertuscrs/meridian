/**
 * test/test-regression.js — Regression tests for custom R-implementations
 *
 * Covers:
 *   R1  — Stop Loss hard floor
 *   R2  — Trailing TP queued (R4.1 fix)
 *   R5  — Low Yield age gate
 *   R7  — Safety-Lock (pecut + experimental, hold when OOR + pnl <= 0)
 *   R8  — Indicator-Aware OOR close (hold / close / fail-open)
 *   F1  — signal-tracker stageSignals / getAndClearStagedSignals
 *
 * Run: node test/test-regression.js
 */

// ─── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label, got, expected) {
  if (condition) {
    console.log(`✅ ${label}`);
    passed++;
  } else {
    console.log(`❌ ${label} — got: ${JSON.stringify(got)}, expected: ${JSON.stringify(expected)}`);
    failed++;
    failures.push(label);
  }
}

function assertEquals(got, expected, label) {
  assert(JSON.stringify(got) === JSON.stringify(expected), label, got, expected);
}

function assertNull(got, label) {
  assert(got === null, label, got, null);
}

function assertNotNull(got, label) {
  assert(got !== null, label, got, "not null");
}

// ─── Inline close-rule decision logic (mirrors state.js updatePnlAndCheckExits) ─────
// Tests the pure decision tree without file I/O.

function makePos(overrides = {}) {
  return {
    out_of_range_since: null,
    trailing_active: false,
    peak_pnl_pct: 0,
    closed: false,
    ...overrides,
  };
}

function makeConfig(overrides = {}) {
  return {
    closeProfile: "main",
    stopLossPct: -5,
    trailingTakeProfit: true,
    trailingTriggerPct: 3,
    trailingDropPct: 0.5,
    outOfRangeWaitMinutes: 35,
    outOfRangeBelowWaitMinutes: 8,
    minFeePerTvl24h: 6,
    minAgeBeforeYieldCheck: 60,
    r8IndicatorCheck: true,
    ...overrides,
  };
}

function makePositionData(overrides = {}) {
  return {
    pnl_pct: 1.0,
    pnl_pct_suspicious: false,
    in_range: true,
    fee_per_tvl_24h: 10,
    age_minutes: 120,
    active_bin: 1000,
    lower_bin: 900,
    upper_bin: 1100,
    ...overrides,
  };
}

// Pure decision function mirroring state.js logic — no state I/O
function checkExitsLogic(pos, positionData, mgmtConfig, indicatorData = null) {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, in_range, fee_per_tvl_24h, age_minutes, active_bin, lower_bin, upper_bin } = positionData;
  const profile = mgmtConfig.closeProfile ?? "main";

  // Rule 1: Stop Loss
  if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    return { action: "STOP_LOSS", reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}%`, profile };
  }

  // Rule 2: Trailing TP (R4.1 — always queued)
  if (!pnl_pct_suspicious && pos.trailing_active) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= mgmtConfig.trailingDropPct) {
      return { action: "TRAILING_TP_QUEUED" };
    }
  }

  // Rule 4: OOR
  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    const trailingArmed = pos.trailing_active ?? false;

    // OOR above
    if (active_bin != null && upper_bin != null && active_bin > upper_bin) {
      const oorLimit = trailingArmed ? 0 : (mgmtConfig.outOfRangeWaitMinutes ?? 35);
      if (minutesOOR >= oorLimit) {
        // R7: Safety-Lock
        if ((profile === "pecut" || profile === "experimental") && (currentPnlPct == null || currentPnlPct <= 0)) {
          return null; // hold
        }
        // R8: Indicator-Aware
        if (profile === "experimental" && mgmtConfig.r8IndicatorCheck && indicatorData && !trailingArmed) {
          if (!indicatorData.confirmed) {
            return null; // hold
          }
        }
        return { action: "OUT_OF_RANGE", reason: `OOR above for ${minutesOOR}m`, profile };
      }
    }

    // OOR below
    if (active_bin != null && lower_bin != null && active_bin < lower_bin) {
      const oorLimit = trailingArmed ? 0 : (mgmtConfig.outOfRangeBelowWaitMinutes ?? 8);
      if (minutesOOR >= oorLimit) {
        // R7: Safety-Lock
        if ((profile === "pecut" || profile === "experimental") && (currentPnlPct == null || currentPnlPct <= 0)) {
          return null; // hold
        }
        // R8: Indicator-Aware
        if (profile === "experimental" && mgmtConfig.r8IndicatorCheck && indicatorData && !trailingArmed) {
          if (!indicatorData.confirmed) {
            return null; // hold
          }
        }
        return { action: "OUT_OF_RANGE", reason: `OOR below for ${minutesOOR}m`, profile };
      }
    }
  }

  // Rule 5: Low Yield
  const minAge = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (fee_per_tvl_24h != null && mgmtConfig.minFeePerTvl24h != null &&
      fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h && age_minutes >= minAge) {
    return { action: "LOW_YIELD", reason: `Low yield: fee/TVL ${fee_per_tvl_24h}%`, profile };
  }

  return null; // STAY
}

// Helper: create OOR position with minutes elapsed
function posOOR(minutesAgo, trailingActive = false, peakPnl = 0) {
  const since = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  return makePos({ out_of_range_since: since, trailing_active: trailingActive, peak_pnl_pct: peakPnl });
}


// ─── SECTION 1: R1 — Stop Loss ────────────────────────────────────────────────

console.log("\n── R1: Stop Loss ──");

{
  const result = checkExitsLogic(
    makePos(), makePositionData({ pnl_pct: -5.1 }), makeConfig()
  );
  assertEquals(result?.action, "STOP_LOSS", "R1: pnl -5.1% <= stopLoss -5% → STOP_LOSS");
}

{
  const result = checkExitsLogic(
    makePos(), makePositionData({ pnl_pct: -4.9 }), makeConfig()
  );
  assertNull(result, "R1: pnl -4.9% > stopLoss -5% → no action");
}

{
  const result = checkExitsLogic(
    makePos(), makePositionData({ pnl_pct: -5.1, pnl_pct_suspicious: true }), makeConfig()
  );
  assertNull(result, "R1: suspicious pnl bypasses stop loss check");
}

{
  const result = checkExitsLogic(
    makePos(), makePositionData({ pnl_pct: -5.0 }), makeConfig()
  );
  assertEquals(result?.action, "STOP_LOSS", "R1: pnl exactly at threshold (-5.0%) → STOP_LOSS");
}


// ─── SECTION 2: R2 / R4.1 — Trailing TP always queued ────────────────────────

console.log("\n── R2/R4.1: Trailing TP confirmation queue ──");

{
  // peak=4%, current=3.4%, drop=0.6% >= trailingDropPct(0.5%) → queued
  const pos = makePos({ trailing_active: true, peak_pnl_pct: 4.0 });
  const result = checkExitsLogic(pos, makePositionData({ pnl_pct: 3.4 }), makeConfig());
  assertEquals(result?.action, "TRAILING_TP_QUEUED", "R4.1: trailing TP drop triggers TRAILING_TP_QUEUED (not instant close)");
}

{
  // drop = 0.4% < 0.5% threshold → no action
  const pos = makePos({ trailing_active: true, peak_pnl_pct: 4.0 });
  const result = checkExitsLogic(pos, makePositionData({ pnl_pct: 3.6 }), makeConfig());
  assertNull(result, "R4.1: drop 0.4% below trailingDropPct 0.5% → no action (stay)");
}

{
  // trailing not active yet → no TP check
  const pos = makePos({ trailing_active: false, peak_pnl_pct: 4.0 });
  const result = checkExitsLogic(pos, makePositionData({ pnl_pct: 3.4 }), makeConfig());
  assertNull(result, "R4.1: trailing not active → no TP queue");
}

{
  // OOR + trailing armed → immediate OOR (not blocked by R7/R8)
  const pos = posOOR(40, true, 4.0);
  const data = makePositionData({ pnl_pct: 3.4, in_range: false, active_bin: 1200, upper_bin: 1100 });
  // drop fires first (rule 2)
  const result = checkExitsLogic(pos, data, makeConfig({ closeProfile: "experimental" }));
  assertEquals(result?.action, "TRAILING_TP_QUEUED", "R4.1: OOR+trailing — trailing TP fires before OOR rule");
}


// ─── SECTION 3: R7 — Safety-Lock ─────────────────────────────────────────────

console.log("\n── R7: Safety-Lock ──");

{
  // pecut + OOR above 35m + pnl -0.2% → hold
  const pos = posOOR(36);
  const data = makePositionData({ pnl_pct: -0.2, in_range: false, active_bin: 1200, upper_bin: 1100 });
  const result = checkExitsLogic(pos, data, makeConfig({ closeProfile: "pecut" }));
  assertNull(result, "R7: pecut OOR above 36m pnl -0.2% → Safety-Lock holds");
}

{
  // experimental + OOR above 35m + pnl -0.1% → hold (Safety-Lock fires before R8)
  const pos = posOOR(36);
  const data = makePositionData({ pnl_pct: -0.1, in_range: false, active_bin: 1200, upper_bin: 1100 });
  const result = checkExitsLogic(pos, data, makeConfig({ closeProfile: "experimental" }));
  assertNull(result, "R7: experimental OOR above 36m pnl -0.1% → Safety-Lock holds (R8 not reached)");
}

{
  // pecut + OOR above 35m + pnl exactly 0.0% → hold (pnl <= 0)
  const pos = posOOR(36);
  const data = makePositionData({ pnl_pct: 0.0, in_range: false, active_bin: 1200, upper_bin: 1100 });
  const result = checkExitsLogic(pos, data, makeConfig({ closeProfile: "pecut" }));
  assertNull(result, "R7: pecut pnl exactly 0.0% → Safety-Lock holds");
}

{
  // pecut + OOR above 35m + pnl +0.1% → NOT locked, closes
  const pos = posOOR(36);
  const data = makePositionData({ pnl_pct: 0.1, in_range: false, active_bin: 1200, upper_bin: 1100 });
  const result = checkExitsLogic(pos, data, makeConfig({ closeProfile: "pecut" }));
  assertEquals(result?.action, "OUT_OF_RANGE", "R7: pecut pnl +0.1% → Safety-Lock NOT triggered, closes");
}

{
  // main profile + OOR above 35m + pnl -5% → main does NOT have Safety-Lock
  const pos = posOOR(36);
  const data = makePositionData({ pnl_pct: -2.0, in_range: false, active_bin: 1200, upper_bin: 1100 });
  const result = checkExitsLogic(pos, data, makeConfig({ closeProfile: "main" }));
  assertEquals(result?.action, "OUT_OF_RANGE", "R7: main profile → no Safety-Lock, closes at OOR timeout");
}

{
  // pecut + OOR below 8m + pnl -0.5% → Safety-Lock fires for below direction too
  const pos = posOOR(9);
  const data = makePositionData({ pnl_pct: -0.5, in_range: false, active_bin: 800, lower_bin: 900, upper_bin: 1100 });
  const result = checkExitsLogic(pos, data, makeConfig({ closeProfile: "pecut" }));
  assertNull(result, "R7: pecut OOR below 9m pnl -0.5% → Safety-Lock holds (below direction)");
}

{
  // pecut + OOR above + not yet timed out (25m < 35m) → no action yet
  const pos = posOOR(25);
  const data = makePositionData({ pnl_pct: -2.0, in_range: false, active_bin: 1200, upper_bin: 1100 });
  const result = checkExitsLogic(pos, data, makeConfig({ closeProfile: "pecut" }));
  assertNull(result, "R7: OOR timer not yet expired (25m < 35m) → no action");
}


// ─── SECTION 4: R8 — Indicator-Aware OOR ─────────────────────────────────────

console.log("\n── R8: Indicator-Aware OOR ──");

{
  // experimental + OOR + pnl > 0 (passes Safety-Lock) + indicator NOT confirmed → hold
  const pos = posOOR(36);
  const data = makePositionData({ pnl_pct: 0.5, in_range: false, active_bin: 1200, upper_bin: 1100 });
  const indicator = { confirmed: false, reason: "supertrend_break not confirmed on 5_MINUTE" };
  const result = checkExitsLogic(pos, data, makeConfig({ closeProfile: "experimental" }), indicator);
  assertNull(result, "R8: experimental pnl > 0 indicator not confirmed → R8 hold");
}

{
  // experimental + OOR + pnl > 0 + indicator confirmed → OUT_OF_RANGE
  const pos = posOOR(36);
  const data = makePositionData({ pnl_pct: 0.5, in_range: false, active_bin: 1200, upper_bin: 1100 });
  const indicator = { confirmed: true, reason: "supertrend_break confirmed on 5_MINUTE" };
  const result = checkExitsLogic(pos, data, makeConfig({ closeProfile: "experimental" }), indicator);
  assertEquals(result?.action, "OUT_OF_RANGE", "R8: experimental pnl > 0 indicator confirmed → OUT_OF_RANGE");
}

{
  // experimental + OOR + pnl > 0 + indicatorData null (API down) → fail-open, closes
  const pos = posOOR(36);
  const data = makePositionData({ pnl_pct: 0.5, in_range: false, active_bin: 1200, upper_bin: 1100 });
  const result = checkExitsLogic(pos, data, makeConfig({ closeProfile: "experimental" }), null);
  assertEquals(result?.action, "OUT_OF_RANGE", "R8: indicator API down (null) → fail-open, OUT_OF_RANGE");
}

{
  // pecut + OOR + pnl > 0 + indicator not confirmed → R8 NOT evaluated for pecut
  const pos = posOOR(36);
  const data = makePositionData({ pnl_pct: 0.5, in_range: false, active_bin: 1200, upper_bin: 1100 });
  const indicator = { confirmed: false, reason: "supertrend_break not confirmed" };
  const result = checkExitsLogic(pos, data, makeConfig({ closeProfile: "pecut" }), indicator);
  assertEquals(result?.action, "OUT_OF_RANGE", "R8: pecut profile → R8 gate skipped, closes normally");
}

{
  // experimental + trailing armed + indicator not confirmed → R8 skipped (trailing bypass)
  const pos = posOOR(5, true, 3.0);
  const data = makePositionData({ pnl_pct: 2.4, in_range: false, active_bin: 1200, upper_bin: 1100 });
  // trailing drop = 3.0 - 2.4 = 0.6 >= 0.5 → TRAILING_TP_QUEUED fires first
  const indicator = { confirmed: false, reason: "not confirmed" };
  const result = checkExitsLogic(pos, data, makeConfig({ closeProfile: "experimental" }), indicator);
  assertEquals(result?.action, "TRAILING_TP_QUEUED", "R8: trailing armed + drop ≥ threshold → trailing queued before R8 gate");
}

{
  // experimental + OOR below + pnl > 0 + indicator not confirmed → hold (below direction)
  const pos = posOOR(9);
  const data = makePositionData({ pnl_pct: 0.3, in_range: false, active_bin: 800, lower_bin: 900, upper_bin: 1100 });
  const indicator = { confirmed: false, reason: "supertrend_break not confirmed" };
  const result = checkExitsLogic(pos, data, makeConfig({ closeProfile: "experimental" }), indicator);
  assertNull(result, "R8: experimental OOR below, indicator not confirmed → hold");
}


// ─── SECTION 5: R5 — Low Yield age gate ──────────────────────────────────────

console.log("\n── R5: Low Yield age gate ──");

{
  // fee below min, age > minAge → LOW_YIELD
  const result = checkExitsLogic(
    makePos(), makePositionData({ fee_per_tvl_24h: 1.5, age_minutes: 65 }), makeConfig()
  );
  assertEquals(result?.action, "LOW_YIELD", "R5: fee 1.5% < min 6%, age 65m > 60m → LOW_YIELD");
}

{
  // fee below min but age < minAge → no action (position too young)
  const result = checkExitsLogic(
    makePos(), makePositionData({ fee_per_tvl_24h: 1.5, age_minutes: 45 }), makeConfig()
  );
  assertNull(result, "R5: fee low but age 45m < minAge 60m → no action (too young)");
}

{
  // fee above min → no yield close
  const result = checkExitsLogic(
    makePos(), makePositionData({ fee_per_tvl_24h: 8.0, age_minutes: 120 }), makeConfig()
  );
  assertNull(result, "R5: fee 8% > min 6% → no low yield action");
}

{
  // custom minAgeBeforeYieldCheck = 30 → fires at 35m
  const result = checkExitsLogic(
    makePos(), makePositionData({ fee_per_tvl_24h: 1.0, age_minutes: 35 }),
    makeConfig({ minAgeBeforeYieldCheck: 30 })
  );
  assertEquals(result?.action, "LOW_YIELD", "R5: custom minAge 30m, age 35m → LOW_YIELD");
}


// ─── SECTION 6: F1 — signal-tracker (stageSignals / getAndClearStagedSignals) ─

console.log("\n── F1: signal-tracker ──");

// Import signal-tracker (has logger dep, log calls are no-ops in test context)
const { stageSignals, getAndClearStagedSignals, getStagedPools } = await import(
  new URL("../signal-tracker.js", import.meta.url).href
);

{
  // Stage by pool address, retrieve by pool address
  stageSignals("POOL_AAA", { organic_score: 80, fee_tvl_ratio: 0.5, volume: 5000 });
  const result = getAndClearStagedSignals("POOL_AAA");
  assert(result !== null, "F1: stageSignals + getAndClearStagedSignals by pool address returns data", result, "not null");
  assertEquals(result?.organic_score, 80, "F1: staged organic_score preserved");
  assertEquals(result?.fee_tvl_ratio, 0.5, "F1: staged fee_tvl_ratio preserved");
}

{
  // Cleared after retrieval
  stageSignals("POOL_BBB", { organic_score: 75 });
  getAndClearStagedSignals("POOL_BBB");
  const second = getAndClearStagedSignals("POOL_BBB");
  assertNull(second, "F1: signals cleared after first retrieval");
}

{
  // Retrieve by base_mint when pool address differs (new upstream feature)
  stageSignals("POOL_CCCC", { organic_score: 90, base_mint: "MINT_XYZ", volume: 10000 });
  const result = getAndClearStagedSignals("POOL_CCCC_DIFFERENT_DEPLOY_ADDR", "MINT_XYZ");
  assertNotNull(result, "F1: getAndClearStagedSignals fallback by base_mint finds staged signals");
  assertEquals(result?.organic_score, 90, "F1: base_mint fallback — organic_score correct");
}

{
  // base_mint cleared after retrieval
  stageSignals("POOL_DDDD", { organic_score: 60, base_mint: "MINT_ABC" });
  getAndClearStagedSignals("POOL_DDDD_X", "MINT_ABC");
  const second = getAndClearStagedSignals("POOL_DDDD_Y", "MINT_ABC");
  assertNull(second, "F1: base_mint index cleared after retrieval");
}

{
  // Null pool address → no-op, no crash
  stageSignals(null, { organic_score: 50 });
  const pools = getStagedPools();
  assert(!pools.includes(null) && !pools.includes("null"), "F1: null pool address → not staged");
}

{
  // Missing pool → returns null
  const result = getAndClearStagedSignals("POOL_NONEXISTENT");
  assertNull(result, "F1: unstaged pool address → returns null");
}

{
  // base_mint stored in result when staging with base_mint
  stageSignals("POOL_EEEE", { base_mint: "MINT_999", organic_score: 55 });
  const result = getAndClearStagedSignals("POOL_EEEE");
  assertEquals(result?.base_mint, "MINT_999", "F1: base_mint field preserved in staged signals");
}


// ─── Results ──────────────────────────────────────────────────────────────────

console.log("\n─────────────────────────────────");
console.log(`Results: ${passed}/${passed + failed} passed`);
if (failed === 0) {
  console.log("All tests passed! ✅");
} else {
  console.log(`\nFailed (${failed}):`);
  failures.forEach(f => console.log(`  ❌ ${f}`));
  process.exit(1);
}
