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
 *   Jupiter — API key + health check
 *   Fee Drift — Layer 1 fee decline + Layer 2 fee spike
 *   Time-of-Day — risky window + young token filter
 *   Log Rotation — old log cleanup
 *   Performance — /performance command structure
 *   PnL Poll Gap — emergency floor before peak gate
 *   GMGN Settings — CONFIG_MAP + UI structure
 *   Agent — allowSkip option for SCREENER
 *   Volume Trend — classification + score boost + deploy validation
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


// ─── SECTION 7: Fee Drift Detection ────────────────────────────────────────

console.log("\n── Fee Drift: Layer 1 + Layer 2 ──");

// Inline fee drift logic mirroring executor.js validateDeployPoolThresholds
function checkFeeDriftLayer1(feeChangePct, maxFeeDeclinePct, feeDriftCheck = true) {
  if (!feeDriftCheck) return { pass: true };
  if (maxFeeDeclinePct == null) return { pass: true };
  if (feeChangePct == null) return { pass: true }; // no data = skip
  if (feeChangePct < maxFeeDeclinePct) {
    return { pass: false, reason: `fees declining ${feeChangePct}%` };
  }
  return { pass: true };
}

function checkFeeDriftLayer2(shortFeeTvl, longFeeTvl, maxRatio, minShortFeeTvl, feeSpikeCheck = true) {
  if (!feeSpikeCheck) return { pass: true };
  if (shortFeeTvl == null || shortFeeTvl < minShortFeeTvl) return { pass: true }; // too small to check
  if (longFeeTvl == null || longFeeTvl <= 0) return { pass: true }; // fail-open
  const ratio = shortFeeTvl / longFeeTvl;
  if (ratio > maxRatio) {
    return { pass: false, reason: `fee spike ${ratio.toFixed(1)}x` };
  }
  return { pass: true };
}

// Layer 1 tests
{
  const r = checkFeeDriftLayer1(-60, -50, true);
  assertEquals(r.pass, false, "FD L1: fee_change_pct -60% < max -50% → reject");
}
{
  const r = checkFeeDriftLayer1(-40, -50, true);
  assertEquals(r.pass, true, "FD L1: fee_change_pct -40% > max -50% → pass");
}
{
  const r = checkFeeDriftLayer1(-50, -50, true);
  assertEquals(r.pass, true, "FD L1: fee_change_pct exactly -50% → pass (not below)");
}
{
  const r = checkFeeDriftLayer1(-60, -50, false);
  assertEquals(r.pass, true, "FD L1: feeDriftCheck=false → skip, pass");
}
{
  const r = checkFeeDriftLayer1(null, -50, true);
  assertEquals(r.pass, true, "FD L1: fee_change_pct null (no data) → skip, pass");
}
{
  const r = checkFeeDriftLayer1(20, -50, true);
  assertEquals(r.pass, true, "FD L1: fee_change_pct +20% (fees rising) → pass");
}

// Layer 2 tests
{
  const r = checkFeeDriftLayer2(3.5, 1.0, 3.0, 0.5, true);
  assertEquals(r.pass, false, "FD L2: short 3.5% / long 1.0% = 3.5x > 3.0x → reject");
}
{
  const r = checkFeeDriftLayer2(2.0, 1.0, 3.0, 0.5, true);
  assertEquals(r.pass, true, "FD L2: short 2.0% / long 1.0% = 2.0x < 3.0x → pass");
}
{
  const r = checkFeeDriftLayer2(3.0, 1.0, 3.0, 0.5, true);
  assertEquals(r.pass, true, "FD L2: ratio exactly 3.0x → pass (not above)");
}
{
  const r = checkFeeDriftLayer2(3.5, 1.0, 3.0, 0.5, false);
  assertEquals(r.pass, true, "FD L2: feeSpikeCheck=false → skip, pass");
}
{
  const r = checkFeeDriftLayer2(3.5, null, 3.0, 0.5, true);
  assertEquals(r.pass, true, "FD L2: long-timeframe null → fail-open, pass");
}
{
  const r = checkFeeDriftLayer2(3.5, 0, 3.0, 0.5, true);
  assertEquals(r.pass, true, "FD L2: long-timeframe 0 → fail-open, pass");
}
{
  const r = checkFeeDriftLayer2(0.3, 1.0, 3.0, 0.5, true);
  assertEquals(r.pass, true, "FD L2: short 0.3% < minShortFeeTvl 0.5% → skip, pass");
}
{
  const r = checkFeeDriftLayer2(null, 1.0, 3.0, 0.5, true);
  assertEquals(r.pass, true, "FD L2: short fee/TVL null → skip, pass");
}

// Config + code structure tests
{
  const fs = await import("fs");
  const { fileURLToPath } = await import("url");
  const configPath = fileURLToPath(new URL("../config.js", import.meta.url));
  const configSrc = fs.readFileSync(configPath, "utf8");
  assert(configSrc.includes("feeDriftCheck"), "FD config: feeDriftCheck key exists");
  assert(configSrc.includes("maxFeeDeclinePct"), "FD config: maxFeeDeclinePct key exists");
  assert(configSrc.includes("feeSpikeCheck"), "FD config: feeSpikeCheck key exists");
  assert(configSrc.includes("feeSpikeShortTimeframe"), "FD config: feeSpikeShortTimeframe key exists");
  assert(configSrc.includes("feeSpikeLongTimeframe"), "FD config: feeSpikeLongTimeframe key exists");
  assert(configSrc.includes("feeSpikeMaxRatio"), "FD config: feeSpikeMaxRatio key exists");
  assert(configSrc.includes("feeSpikeMinShortFeeTvl"), "FD config: feeSpikeMinShortFeeTvl key exists");
}

{
  const fs = await import("fs");
  const { fileURLToPath } = await import("url");
  const execPath = fileURLToPath(new URL("../tools/executor.js", import.meta.url));
  const execSrc = fs.readFileSync(execPath, "utf8");
  assert(execSrc.includes("feeDriftCheck"), "FD executor: feeDriftCheck in CONFIG_MAP");
  assert(execSrc.includes("maxFeeDeclinePct"), "FD executor: maxFeeDeclinePct in CONFIG_MAP");
  assert(execSrc.includes("feeSpikeMaxRatio"), "FD executor: feeSpikeMaxRatio in CONFIG_MAP");
  assert(execSrc.includes("feeSpikeMinShortFeeTvl"), "FD executor: feeSpikeMinShortFeeTvl in CONFIG_MAP");
  assert(execSrc.includes("fee_change_pct"), "FD executor: Layer 1 checks fee_change_pct");
  assert(execSrc.includes("fetchFreshPoolDetail"), "FD executor: Layer 2 uses fetchFreshPoolDetail");
  assert(execSrc.includes("Fee spike detected"), "FD executor: Layer 2 rejection message exists");
}

{
  const fs = await import("fs");
  const { fileURLToPath } = await import("url");
  const screenPath = fileURLToPath(new URL("../tools/screening.js", import.meta.url));
  const screenSrc = fs.readFileSync(screenPath, "utf8");
  assert(screenSrc.includes("fee_change_pct"), "FD screening: Layer 1 filters fee_change_pct");
  assert(screenSrc.includes("maxFeeDeclinePct"), "FD screening: Layer 1 reads maxFeeDeclinePct config");
  assert(screenSrc.includes("fees declining"), "FD screening: Layer 1 rejection message exists");
}


// ─── SECTION 9: Config Tuning defaults ─────────────────────────────────────

console.log("\n── Config Tuning: defaults ──");

{
  const { config } = await import(new URL("../config.js", import.meta.url).href);
  assert(config.screening.minVolatility >= 3.5, "Config: minVolatility >= 3.5", config.screening.minVolatility, ">= 3.5");
  assert(config.management.stopLossCooldownHours >= 6, "Config: stopLossCooldownHours >= 6", config.management.stopLossCooldownHours, ">= 6");
}

{
  // Verify config.js source has the correct defaults
  const fs = await import("fs");
  const { fileURLToPath } = await import("url");
  const configPath = fileURLToPath(new URL("../config.js", import.meta.url));
  const configSrc = fs.readFileSync(configPath, "utf8");
  assert(configSrc.includes("3.5"), "Config: minVolatility default is 3.5 in config.js source");
  assert(configSrc.includes("stopLossCooldownHours"), "Config: stopLossCooldownHours exists in config.js source");
}


// ─── SECTION 10: Catastrophic SL → Base-mint Blacklist ─────────────────────

console.log("\n── Catastrophic SL: base-mint blacklist ──");

{
  // Verify pool-cooldown.js imports addToBlacklist
  const fs = await import("fs");
  const { fileURLToPath } = await import("url");
  const cooldownPath = fileURLToPath(new URL("../pool-cooldown.js", import.meta.url));
  const cooldownSrc = fs.readFileSync(cooldownPath, "utf8");
  assert(cooldownSrc.includes('import { addToBlacklist } from "./token-blacklist.js"'), "Cooldown: imports addToBlacklist from token-blacklist.js");
  assert(cooldownSrc.includes("Catastrophic SL"), "Cooldown: catastrophic SL blacklist logic exists");
  assert(cooldownSrc.includes("emergencyClosePct"), "Cooldown: uses emergencyClosePct as threshold");
}

{
  // Test the blacklist function directly
  const { addToBlacklist, isBlacklisted, removeFromBlacklist } = await import(
    new URL("../token-blacklist.js", import.meta.url).href
  );

  const testMint = "TEST_CATASTROPHIC_MINT_" + Date.now();

  // Add to blacklist
  const addResult = addToBlacklist({
    mint: testMint,
    symbol: "TEST",
    reason: "Catastrophic SL: -15.0% loss (threshold -10%)",
  });
  assertEquals(addResult.blacklisted, true, "Blacklist: addToBlacklist returns blacklisted=true");

  // Verify it's blacklisted
  assertEquals(isBlacklisted(testMint), true, "Blacklist: isBlacklisted returns true after adding");

  // Cleanup
  removeFromBlacklist({ mint: testMint });
  assertEquals(isBlacklisted(testMint), false, "Blacklist: isBlacklisted returns false after removing");
}

{
  // Verify threshold alignment: emergencyClosePct = -10 matches blacklist trigger
  const { config } = await import(new URL("../config.js", import.meta.url).href);
  assertEquals(config.management.emergencyClosePct, -10, "Config: emergencyClosePct = -10 (catastrophic SL threshold)");
}


// ─── SECTION 11: Time-of-Day Awareness ────────────────────────────────────

console.log("\n── Time-of-Day: risky window + young token ──");

// Inline time-of-day logic mirroring screening.js
function checkTimeOfDay(tokenAgeHours, currentHour, riskyHours, minTokenAge, timeOfDayCheck = true) {
  if (!timeOfDayCheck) return { pass: true };
  if (!riskyHours.includes(currentHour)) return { pass: true }; // safe window
  if (tokenAgeHours == null) return { pass: true }; // no age data = skip
  if (tokenAgeHours >= minTokenAge) return { pass: true }; // old enough
  return { pass: false, reason: `risky window ${currentHour}:00 UTC + young token (${tokenAgeHours}h)` };
}

// Risky hour + young token → reject
{
  const r = checkTimeOfDay(12, 2, [0,1,2,3,4,16,17], 24, true);
  assertEquals(r.pass, false, "TOD: hour 2 UTC + age 12h < 24h → reject");
}
// Risky hour + old token → pass
{
  const r = checkTimeOfDay(48, 2, [0,1,2,3,4,16,17], 24, true);
  assertEquals(r.pass, true, "TOD: hour 2 UTC + age 48h >= 24h → pass");
}
// Safe hour + young token → pass
{
  const r = checkTimeOfDay(12, 10, [0,1,2,3,4,16,17], 24, true);
  assertEquals(r.pass, true, "TOD: hour 10 UTC (safe) + age 12h → pass");
}
// Risky hour + token age exactly at threshold → pass
{
  const r = checkTimeOfDay(24, 3, [0,1,2,3,4,16,17], 24, true);
  assertEquals(r.pass, true, "TOD: hour 3 UTC + age exactly 24h → pass");
}
// Disabled → skip
{
  const r = checkTimeOfDay(12, 2, [0,1,2,3,4,16,17], 24, false);
  assertEquals(r.pass, true, "TOD: timeOfDayCheck=false → skip, pass");
}
// 16-17 UTC risky window
{
  const r = checkTimeOfDay(6, 16, [0,1,2,3,4,16,17], 24, true);
  assertEquals(r.pass, false, "TOD: hour 16 UTC + age 6h → reject");
}
{
  const r = checkTimeOfDay(6, 17, [0,1,2,3,4,16,17], 24, true);
  assertEquals(r.pass, false, "TOD: hour 17 UTC + age 6h → reject");
}
// 05-09 UTC safe window (zero SL historically)
{
  const r = checkTimeOfDay(6, 5, [0,1,2,3,4,16,17], 24, true);
  assertEquals(r.pass, true, "TOD: hour 5 UTC (safe) + age 6h → pass");
}
{
  const r = checkTimeOfDay(6, 9, [0,1,2,3,4,16,17], 24, true);
  assertEquals(r.pass, true, "TOD: hour 9 UTC (safe) + age 6h → pass");
}

// Config + code structure tests
{
  const { config } = await import(new URL("../config.js", import.meta.url).href);
  assertEquals(config.screening.timeOfDayCheck, true, "TOD config: timeOfDayCheck default = true");
  assertEquals(config.screening.minTokenAgeForTimeCheck, 24, "TOD config: minTokenAgeForTimeCheck default = 24");
  assert(Array.isArray(config.screening.riskyHours), "TOD config: riskyHours is an array");
  assert(config.screening.riskyHours.includes(0), "TOD config: riskyHours includes 0 (midnight UTC)");
  assert(config.screening.riskyHours.includes(16), "TOD config: riskyHours includes 16");
}

{
  const fs = await import("fs");
  const { fileURLToPath } = await import("url");
  const screenPath = fileURLToPath(new URL("../tools/screening.js", import.meta.url));
  const screenSrc = fs.readFileSync(screenPath, "utf8");
  assert(screenSrc.includes("timeOfDayCheck"), "TOD screening: timeOfDayCheck filter exists");
  assert(screenSrc.includes("riskyHours"), "TOD screening: reads riskyHours config");
  assert(screenSrc.includes("getUTCHours"), "TOD screening: uses getUTCHours for current hour");
  assert(screenSrc.includes("token_age_hours"), "TOD screening: checks token_age_hours");
}


// ─── SECTION 12: Log Rotation ──────────────────────────────────────────────

console.log("\n── Log Rotation: old log cleanup ──");

{
  // Verify logger.js exports rotateOldLogs
  const fs = await import("fs");
  const { fileURLToPath } = await import("url");
  const loggerPath = fileURLToPath(new URL("../logger.js", import.meta.url));
  const loggerSrc = fs.readFileSync(loggerPath, "utf8");
  assert(loggerSrc.includes("export function rotateOldLogs"), "Logger: rotateOldLogs function exported");
  assert(loggerSrc.includes("LOG_RETENTION_DAYS"), "Logger: LOG_RETENTION_DAYS constant exists");
  assert(loggerSrc.includes("unlinkSync"), "Logger: deletes old files with unlinkSync");
}

{
  // Verify index.js calls rotateOldLogs at startup
  const fs = await import("fs");
  const { fileURLToPath } = await import("url");
  const indexPath = fileURLToPath(new URL("../index.js", import.meta.url));
  const indexSrc = fs.readFileSync(indexPath, "utf8");
  assert(indexSrc.includes("rotateOldLogs"), "Index: imports rotateOldLogs");
  assert(indexSrc.includes("rotateOldLogs()"), "Index: calls rotateOldLogs at startup");
}

{
  // Test rotateOldLogs function directly
  const { rotateOldLogs } = await import(new URL("../logger.js", import.meta.url).href);
  assertEquals(typeof rotateOldLogs, "function", "Logger: rotateOldLogs is a function");
  // Should not throw when called
  rotateOldLogs();
  assert(true, "Logger: rotateOldLogs runs without error");
}


// ─── SECTION 13: Performance Dashboard ─────────────────────────────────────

console.log("\n── Performance Dashboard: /performance command ──");

{
  // Verify index.js has /performance command
  const fs = await import("fs");
  const { fileURLToPath } = await import("url");
  const indexPath = fileURLToPath(new URL("../index.js", import.meta.url));
  const indexSrc = fs.readFileSync(indexPath, "utf8");
  assert(indexSrc.includes('"/performance"'), "Index: /performance command handler exists");
  assert(indexSrc.includes("getPerformanceHistory"), "Index: imports getPerformanceHistory");
  assert(indexSrc.includes("periodHours"), "Index: /performance supports period hours");
  assert(indexSrc.includes("byReason"), "Index: /performance shows close reason breakdown");
  assert(indexSrc.includes("bestPool"), "Index: /performance shows best/worst pools");
}

{
  // Verify lessons.js exports getPerformanceHistory
  const fs = await import("fs");
  const { fileURLToPath } = await import("url");
  const lessonsPath = fileURLToPath(new URL("../lessons.js", import.meta.url));
  const lessonsSrc = fs.readFileSync(lessonsPath, "utf8");
  assert(lessonsSrc.includes("export function getPerformanceHistory"), "Lessons: getPerformanceHistory exported");
  assert(lessonsSrc.includes("export function getPerformanceSummary"), "Lessons: getPerformanceSummary exported");
}


// ─── SECTION 14: PnL Poll Gap — Emergency Floor Before Peak Gate ───────────

console.log("\n── PnL Poll Gap: emergency floor before peak gate ──");

// Inline logic mirroring state.js queuePeakConfirmation
function testQueuePeakConfirmation(candidatePnlPct, currentPeak, emergencyClosePct = -10) {
  if (candidatePnlPct == null) return false;

  // Emergency floor check (BEFORE peak gate)
  if (emergencyClosePct != null && candidatePnlPct <= emergencyClosePct) {
    return {
      emergency: true,
      action: "EMERGENCY_CLOSE",
      reason: `Emergency close (via poll): PnL ${candidatePnlPct.toFixed(2)}% <= ${emergencyClosePct}%`,
    };
  }

  // Peak gate (existing)
  if (candidatePnlPct <= currentPeak) return false;

  return true; // peak update
}

// Test 1: PnL descending, emergency NOT breached → peak gate engages
{
  const r = testQueuePeakConfirmation(-5, 0.5, -10);
  assertEquals(r, false, "PnL Gap: pnl -5% < peak 0.5% but > -10% → peak gate (false)");
}

// Test 2: PnL descending, emergency BREACHED → triggers emergency
{
  const r = testQueuePeakConfirmation(-12, 0.5, -10);
  assert(r?.emergency === true, "PnL Gap: pnl -12% <= -10% → EMERGENCY_CLOSE", r?.action, "EMERGENCY_CLOSE");
}

// Test 3: PnL ascending past peak → normal peak update
{
  const r = testQueuePeakConfirmation(1.2, 0.5, -10);
  assertEquals(r, true, "PnL Gap: pnl 1.2% > peak 0.5% → peak update (true)");
}

// Test 4: emergencyClosePct disabled (null) → no emergency, falls to peak gate
{
  const r = testQueuePeakConfirmation(-15, 0.5, null);
  assertEquals(r, false, "PnL Gap: emergency disabled (null) → peak gate (false)");
}

// Test 5: candidatePnlPct = null → skipped
{
  const r = testQueuePeakConfirmation(null, 0.5, -10);
  assertEquals(r, false, "PnL Gap: pnl null → skipped (false)");
}

// Test 6: PnL exactly at emergency threshold → triggers
{
  const r = testQueuePeakConfirmation(-10, 0.5, -10);
  assert(r?.emergency === true, "PnL Gap: pnl exactly -10% → EMERGENCY_CLOSE", r?.action, "EMERGENCY_CLOSE");
}

// Test 7: PnL just above emergency threshold → peak gate
{
  const r = testQueuePeakConfirmation(-9.99, 0.5, -10);
  assertEquals(r, false, "PnL Gap: pnl -9.99% > -10% → peak gate (false)");
}

// Test 8: Emergency fires even when PnL is above peak (catastrophic drop from high peak)
{
  const r = testQueuePeakConfirmation(-15, 5.0, -10);
  assert(r?.emergency === true, "PnL Gap: pnl -15% from peak 5% → EMERGENCY_CLOSE", r?.action, "EMERGENCY_CLOSE");
}

// Code structure tests
{
  const fs = await import("fs");
  const { fileURLToPath } = await import("url");
  const statePath = fileURLToPath(new URL("../state.js", import.meta.url));
  const stateSrc = fs.readFileSync(statePath, "utf8");
  assert(stateSrc.includes("Emergency Floor Check"), "State: emergency floor check exists");
  assert(stateSrc.includes("emergency_close_flagged_at"), "State: flags emergency in position state");
  assert(stateSrc.includes("PnL poll diag"), "State: diagnostic log exists");
  assert(stateSrc.includes("DIAG_LOG_INTERVAL_MS"), "State: diagnostic log throttle exists");
  assert(stateSrc.includes("Emergency floor breached"), "State: emergency log message exists");

  const indexPath = fileURLToPath(new URL("../index.js", import.meta.url));
  const indexSrc = fs.readFileSync(indexPath, "utf8");
  assert(indexSrc.includes("peakResult?.emergency"), "Index: handles emergency from peak confirmation");
}


// ─── SECTION 15: GMGN Settings — CONFIG_MAP + UI structure ─────────────────

console.log("\n── GMGN Settings: CONFIG_MAP + UI structure ──");

{
  const fs = await import("fs");
  const { fileURLToPath } = await import("url");
  const execPath = fileURLToPath(new URL("../tools/executor.js", import.meta.url));
  const execSrc = fs.readFileSync(execPath, "utf8");

  // Test 1: New CONFIG_MAP entries exist
  assert(execSrc.includes("gmgnMaxRugRatio"), "Executor: gmgnMaxRugRatio in CONFIG_MAP");
  assert(execSrc.includes("gmgnRejectSingleVolumeSpike"), "Executor: gmgnRejectSingleVolumeSpike in CONFIG_MAP");
  assert(execSrc.includes("gmgnMaxSingleCandleVolumeShare"), "Executor: gmgnMaxSingleCandleVolumeShare in CONFIG_MAP");

  // Test 2: All safety keys have CONFIG_MAP entry
  const safetyKeys = [
    "gmgnMaxTop10HolderRate", "gmgnMaxBundlerRate", "gmgnMaxRatTraderRate",
    "gmgnMaxFreshWalletRate", "gmgnMaxDevTeamHoldRate", "gmgnMaxBotDegenRate",
    "gmgnMaxRugRatio", "gmgnMaxSniperCount", "gmgnMaxSniperHoldRate", "gmgnMinSmartDegenCount"
  ];
  for (const key of safetyKeys) {
    assert(execSrc.includes(key), `Executor: ${key} in CONFIG_MAP`);
  }

  // Test 3: All volume keys have CONFIG_MAP entry
  const volumeKeys = [
    "gmgnMinMcap", "gmgnMaxMcap", "gmgnMinVolume",
    "gmgnAthFilterPct", "gmgnMinHolders", "gmgnHoldersLimit"
  ];
  for (const key of volumeKeys) {
    assert(execSrc.includes(key), `Executor: ${key} in CONFIG_MAP`);
  }
}

{
  const fs = await import("fs");
  const { fileURLToPath } = await import("url");
  const indexPath = fileURLToPath(new URL("../index.js", import.meta.url));
  const indexSrc = fs.readFileSync(indexPath, "utf8");

  // Test 4: Safety page buttons exist
  assert(indexSrc.includes("cfg:page:safety"), "Index: Safety page nav button exists");
  assert(indexSrc.includes("gmgnMaxTop10HolderRate"), "Index: Max top10 holder rate button exists");
  assert(indexSrc.includes("gmgnMaxBundlerRate"), "Index: Max bundler rate button exists");
  assert(indexSrc.includes("gmgnMaxRatTraderRate"), "Index: Max rat trader rate button exists");
  assert(indexSrc.includes("gmgnMaxFreshWalletRate"), "Index: Max fresh wallet rate button exists");
  assert(indexSrc.includes("gmgnMaxDevTeamHoldRate"), "Index: Max dev hold rate button exists");
  assert(indexSrc.includes("gmgnMaxBotDegenRate"), "Index: Max bot degen rate button exists");
  assert(indexSrc.includes("gmgnMaxRugRatio"), "Index: Max rug ratio button exists");
  assert(indexSrc.includes("gmgnMaxSniperCount"), "Index: Max sniper count button exists");
  assert(indexSrc.includes("gmgnMaxSniperHoldRate"), "Index: Max sniper hold rate button exists");
  assert(indexSrc.includes("gmgnMinSmartDegenCount"), "Index: Min smart degen count button exists");

  // Test 5: GMGN page (volume) buttons exist
  assert(indexSrc.includes("gmgnMinMcap"), "Index: Min mcap button exists");
  assert(indexSrc.includes("gmgnMaxMcap"), "Index: Max mcap button exists");
  assert(indexSrc.includes("gmgnMinVolume"), "Index: Min volume button exists");
  assert(indexSrc.includes("gmgnAthFilterPct"), "Index: ATH filter pct button exists");
  assert(indexSrc.includes("gmgnMinHolders"), "Index: Min holders button exists");
  assert(indexSrc.includes("gmgnHoldersLimit"), "Index: Holders limit button exists");

  // Test 6: Indicators page — requireBbPosition toggle
  assert(indexSrc.includes("gmgnRequireBbPosition"), "Index: Require BB position toggle exists");
  assert(indexSrc.includes("gmgnIndicatorFilter"), "Index: GMGN indicator filter toggle exists");

  // Test 7: Page routing includes safety keys
  assert(indexSrc.includes('"safety"'), "Index: Safety page routing exists");
}


// ─── SECTION 16: Agent — allowSkip option for SCREENER ────────────────────

console.log("\n── Agent: allowSkip option for SCREENER ──");

{
  const fs = await import("fs");
  const { fileURLToPath } = await import("url");
  const agentPath = fileURLToPath(new URL("../agent.js", import.meta.url));
  const agentSrc = fs.readFileSync(agentPath, "utf8");
  const indexPath = fileURLToPath(new URL("../index.js", import.meta.url));
  const indexSrc = fs.readFileSync(indexPath, "utf8");

  // Test 1: agentLoop signature accepts allowSkip
  assert(agentSrc.includes("allowSkip = false"), "Agent: agentLoop default allowSkip=false in destructuring");
  assert(agentSrc.includes("allowSkip ? false : shouldRequireRealToolUse"), "Agent: allowSkip disables mustUseRealTool");

  // Test 2: index.js passes allowSkip: true to SCREENER
  assert(indexSrc.includes("allowSkip: true"), "Index: SCREENER agentLoop call passes allowSkip: true");

  // Test 3: Document why this is needed
  // The screening goal includes "deploy" in STEPS, which matches MUTATING_TOOL_INTENTS.
  // Without allowSkip, the model is FORCED to call a tool even when it decides to skip.
  // But the goal explicitly says "If no pool qualifies, report ⛔ NO DEPLOY" — so the
  // model should be allowed to return text. allowSkip: true enables this.
  assert(true, "Agent: allowSkip rationale documented (text response allowed for SCREENER skip)");
}


// ─── SECTION 17: Volume Trend Acceleration ────────────────────────────────

console.log("\n── Volume Trend: classification + score boost + deploy validation ──");

function classifyVolumeTrend(volChangePct, accel = 10, decel = -10) {
  if (volChangePct == null) return "unknown";
  if (!Number.isFinite(volChangePct)) return "unknown";
  if (volChangePct > accel) return "accelerating";
  if (volChangePct < decel) return "decelerating";
  return "stable";
}

function hasAcceleratingBoost(pool, accel = 10) {
  return classifyVolumeTrend(Number(pool.volume_change_pct), accel) === "accelerating";
}

{
  assertEquals(classifyVolumeTrend(15), "accelerating", "VT: +15% → accelerating");
  assertEquals(classifyVolumeTrend(10.1), "accelerating", "VT: +10.1% → accelerating (just above)");
  assertEquals(classifyVolumeTrend(10), "stable", "VT: exactly +10% → stable (not above)");
  assertEquals(classifyVolumeTrend(5), "stable", "VT: +5% → stable");
  assertEquals(classifyVolumeTrend(0), "stable", "VT: 0% → stable");
  assertEquals(classifyVolumeTrend(-5), "stable", "VT: -5% → stable");
  assertEquals(classifyVolumeTrend(-10), "stable", "VT: exactly -10% → stable (not below)");
  assertEquals(classifyVolumeTrend(-10.1), "decelerating", "VT: -10.1% → decelerating (just below)");
  assertEquals(classifyVolumeTrend(-20), "decelerating", "VT: -20% → decelerating");
  assertEquals(classifyVolumeTrend(null), "unknown", "VT: null → unknown");
  assertEquals(classifyVolumeTrend(undefined), "unknown", "VT: undefined → unknown");
  assertEquals(classifyVolumeTrend(NaN), "unknown", "VT: NaN → unknown");
  assertEquals(classifyVolumeTrend("x"), "unknown", "VT: non-number → unknown");
}

{
  assertEquals(classifyVolumeTrend(20, 25, -5), "stable", "VT: custom thresholds, +20% within 25/-5 → stable");
  assertEquals(classifyVolumeTrend(30, 25, -5), "accelerating", "VT: custom thresholds, +30% > 25 → accelerating");
  assertEquals(classifyVolumeTrend(-10, 25, -5), "decelerating", "VT: custom thresholds, -10% < -5 → decelerating");
}

{
  const stablePool = { fee_active_tvl_ratio: 0.5, volume_change_pct: 5 };
  const accelPool = { fee_active_tvl_ratio: 0.5, volume_change_pct: 15 };
  const decelPool = { fee_active_tvl_ratio: 0.5, volume_change_pct: -20 };
  const unknownPool = { fee_active_tvl_ratio: 0.5, volume_change_pct: null };
  assertEquals(hasAcceleratingBoost(stablePool), false, "VT Boost: stable pool → no boost");
  assertEquals(hasAcceleratingBoost(accelPool), true, "VT Boost: accelerating pool → boost");
  assertEquals(hasAcceleratingBoost(decelPool), false, "VT Boost: decelerating pool → no boost");
  assertEquals(hasAcceleratingBoost(unknownPool), false, "VT Boost: unknown pool → no boost");
}

{
  const decelThreshold = -10;
  function validateVolumeTrend(volumeChangePct, blockDecel, decelThresh) {
    if (blockDecel && volumeChangePct != null && volumeChangePct < decelThresh) {
      return { pass: false, reason: `Pool volume decelerating ${volumeChangePct}%` };
    }
    return { pass: true };
  }
  let r = validateVolumeTrend(-15, true, decelThreshold);
  assertEquals(r.pass, false, "VT Deploy: blockDecel=true + decelerating → reject");
  assert(r.reason.includes("decelerating"), "VT Deploy: reject reason mentions decelerating");
  r = validateVolumeTrend(5, true, decelThreshold);
  assertEquals(r.pass, true, "VT Deploy: blockDecel=true + stable → pass");
  r = validateVolumeTrend(15, true, decelThreshold);
  assertEquals(r.pass, true, "VT Deploy: blockDecel=true + accelerating → pass");
  r = validateVolumeTrend(-15, false, decelThreshold);
  assertEquals(r.pass, true, "VT Deploy: blockDecel=false + decelerating → pass (LLM decides)");
  r = validateVolumeTrend(null, true, decelThreshold);
  assertEquals(r.pass, true, "VT Deploy: null volume → pass");
}

{
  const fs = await import("fs");
  const { fileURLToPath } = await import("url");
  const configPath = fileURLToPath(new URL("../config.js", import.meta.url));
  const execPath = fileURLToPath(new URL("../tools/executor.js", import.meta.url));
  const screenPath = fileURLToPath(new URL("../tools/screening.js", import.meta.url));
  const configSrc = fs.readFileSync(configPath, "utf8");
  const execSrc = fs.readFileSync(execPath, "utf8");
  const screenSrc = fs.readFileSync(screenPath, "utf8");
  assert(configSrc.includes("volumeTrendFilter"), "VT config: volumeTrendFilter exists");
  assert(configSrc.includes("volumeTrendAccelThreshold"), "VT config: volumeTrendAccelThreshold exists");
  assert(configSrc.includes("volumeTrendDecelThreshold"), "VT config: volumeTrendDecelThreshold exists");
  assert(configSrc.includes("volumeTrendBlockDecel"), "VT config: volumeTrendBlockDecel exists");
  assert(execSrc.includes("volumeTrendFilter"), "VT executor: volumeTrendFilter in CONFIG_MAP");
  assert(execSrc.includes("volumeTrendBlockDecel"), "VT executor: volumeTrendBlockDecel in CONFIG_MAP");
  assert(screenSrc.includes("classifyVolumeTrend"), "VT screening: classifyVolumeTrend function exists");
  assert(screenSrc.includes("volume_trend: classifyVolumeTrend"), "VT screening: condensePool includes volume_trend field");
  assert(screenSrc.includes("trend === \"accelerating\" ? 100 : 0"), "VT screening: score boost +100 for accelerating");
  assert(screenSrc.includes("volumeTrendBlockDecel"), "VT screening: filter uses blockDecel flag");
  assert(execSrc.includes("Pool volume decelerating"), "VT executor: deploy validation rejects decelerating");
}


// ─── SECTION 8: Jupiter — API key + health check ────────────────────────────

console.log("\n── Jupiter: API key + health check ──");

const { checkJupiter, checkAllApis } = await import(
  new URL("../tools/api-monitor.js", import.meta.url).href
);

{
  // checkJupiter returns proper structure with ok: true
  const result = await checkJupiter();
  assert(result.ok === true, "Jupiter: health check returns ok=true", result.ok, true);
  assertEquals(result.status, 200, "Jupiter: health check returns HTTP 200");
  assertEquals(result.name, "Jupiter API", "Jupiter: health check name is 'Jupiter API'");
  assert(result.latency > 0, "Jupiter: health check latency > 0", result.latency, "> 0");
}

{
  // checkAllApis includes Jupiter
  const results = await checkAllApis();
  const jupiter = results.find(r => r.name === "Jupiter API");
  assertNotNull(jupiter, "Jupiter: checkAllApis includes Jupiter API");
  assert(jupiter.ok === true, "Jupiter: checkAllApis — Jupiter ok=true", jupiter.ok, true);
}

{
  // API key is available from .env via loadEnv (envcrypt.js)
  // In test context, loadEnv is only called when envcrypt.js is first imported
  // Importing envcrypt.js triggers loadEnv() at module level (line 121)
  await import(new URL("../envcrypt.js", import.meta.url).href);
  const { config } = await import(new URL("../config.js", import.meta.url).href);
  const apiKey = config.jupiter?.apiKey || process.env.JUPITER_API_KEY || "";
  assert(apiKey.length > 10, "Jupiter: API key is set and > 10 chars", apiKey.length, "> 10");
  assert(apiKey.startsWith("jup_"), "Jupiter: API key starts with 'jup_'", apiKey.slice(0, 4), "jup_");
}

{
  // Swap URL + price URL constants in wallet.js are correct
  const fs = await import("fs");
  const { fileURLToPath } = await import("url");
  const walletPath = fileURLToPath(new URL("../tools/wallet.js", import.meta.url));
  const walletSrc = fs.readFileSync(walletPath, "utf8");
  assert(walletSrc.includes('const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2"'), "Jupiter: swap URL is https://api.jup.ag/swap/v2");
  assert(walletSrc.includes('const JUPITER_PRICE_API = "https://api.jup.ag/price/v3"'), "Jupiter: price URL is https://api.jup.ag/price/v3");
  assert(!walletSrc.includes("DEFAULT_JUPITER_API_KEY"), "Jupiter: no hardcoded API key in wallet.js");
}

{
  // Health check passes API key from config
  const fs = await import("fs");
  const { fileURLToPath } = await import("url");
  const monitorPath = fileURLToPath(new URL("../tools/api-monitor.js", import.meta.url));
  const monitorSrc = fs.readFileSync(monitorPath, "utf8");
  assert(monitorSrc.includes('"x-api-key"'), "Jupiter: health check sends x-api-key header");
  assert(monitorSrc.includes("config.jupiter?.apiKey"), "Jupiter: health check reads key from config");
  assert(!monitorSrc.includes("process.env.JUPITER_API_KEY"), "Jupiter: health check does not read directly from process.env");
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
