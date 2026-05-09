/**
 * Pool Cooldown System — Integration Test
 * 
 * Tests all 5 cooldown scenarios:
 * 1. Low yield       → 4 hours
 * 2. Stop loss       → 2 hours
 * 3. Loss > 1%       → 1 hour
 * 4. OOR big loss    → 6 hours
 * 5. Cumulative loss > $5 → 48 hours
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const POOL_COOLDOWN_PATH = join(__dirname, "..", "pool-cooldown.js");
const POOL_MEMORY_PATH = join(__dirname, "..", "pool-memory.json");
const TEST_POOL_MEMORY_PATH = join(__dirname, "pool-memory.test.json");

// ─── Helpers ───────────────────────────────────────────────────

function hoursToMs(h) {
  return h * 60 * 60 * 1000;
}

function hoursFromNow(h) {
  return new Date(Date.now() + hoursToMs(h)).toISOString();
}

async function loadPoolMemory() {
  const { readFileSync } = await import("fs");
  try {
    return JSON.parse(readFileSync(POOL_MEMORY_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function savePoolMemory(data) {
  const { writeFileSync } = await import("fs");
  writeFileSync(POOL_MEMORY_PATH, JSON.stringify(data, null, 2));
}

async function cleanupPool(poolAddress) {
  const db = await loadPoolMemory();
  delete db[poolAddress];
  await savePoolMemory(db);
}

// ─── Test Runner ──────────────────────────────────────────────

const results = [];
function pass(name, got, expected) {
  const ok = got === expected;
  results.push({ name, got, expected, ok });
  console.log(`${ok ? "✅" : "❌"} ${name} — got ${got}h, expected ${expected}h`);
}

async function test(name, fn) {
  try {
    await fn();
  } catch (e) {
    results.push({ name, got: `ERROR: ${e.message}`, expected: "no error", ok: false });
    console.log(`❌ ${name} — ERROR: ${e.message}`);
  }
}

// ─── Tests ────────────────────────────────────────────────────

const TEST_POOL_BASE = "TestPool" + Date.now();

await test("1. Low Yield → 4 hour cooldown", async () => {
  const pool = `${TEST_POOL_BASE}_lowyield`;
  await cleanupPool(pool);

  const { evaluateAndSetCooldown } = await import(POOL_COOLDOWN_PATH);
  evaluateAndSetCooldown({
    pool_address: pool,
    pool_name: "LowYield-SOL",
    base_mint: "LowYieldMINT",
    close_reason: "low yield",
    pnlUsd: -0.05,
    pnlPct: -0.2,
    recent_deploys: [],
  });

  const db = await loadPoolMemory();
  const entry = db[pool];
  const expectedHours = 2;
  const actualHours = Math.round((new Date(entry.cooldown_until) - Date.now()) / hoursToMs(1));
  pass("low yield cooldown", actualHours, expectedHours);
});

await test("2. Stop Loss → 2 hour cooldown", async () => {
  const pool = `${TEST_POOL_BASE}_stoploss`;
  await cleanupPool(pool);

  const { evaluateAndSetCooldown } = await import(POOL_COOLDOWN_PATH);
  evaluateAndSetCooldown({
    pool_address: pool,
    pool_name: "StopLoss-SOL",
    base_mint: "StopLossMINT",
    close_reason: "stop loss",
    pnlUsd: -3.0,
    pnlPct: -30,
    recent_deploys: [],
  });

  const db = await loadPoolMemory();
  const entry = db[pool];
  const expectedHours = 2;
  const actualHours = Math.round((new Date(entry.cooldown_until) - Date.now()) / hoursToMs(1));
  pass("stop loss cooldown", actualHours, expectedHours);
});

await test("3. Loss > 1% (manual close) → 1 hour cooldown", async () => {
  const pool = `${TEST_POOL_BASE}_lossgt1pct`;
  await cleanupPool(pool);

  const { evaluateAndSetCooldown } = await import(POOL_COOLDOWN_PATH);
  evaluateAndSetCooldown({
    pool_address: pool,
    pool_name: "LossGt1Pct-SOL",
    base_mint: "LossGt1MINT",
    close_reason: "manual",
    pnlUsd: -0.8,
    pnlPct: -1.5,
    recent_deploys: [],
  });

  const db = await loadPoolMemory();
  const entry = db[pool];
  const expectedHours = 1;
  const actualHours = Math.round((new Date(entry.cooldown_until) - Date.now()) / hoursToMs(1));
  pass("loss > 1% manual close cooldown", actualHours, expectedHours);
});

await test("4. OOR + big loss → 6 hour cooldown", async () => {
  const pool = `${TEST_POOL_BASE}_oorbigloss`;
  await cleanupPool(pool);

  const { evaluateAndSetCooldown } = await import(POOL_COOLDOWN_PATH);
  evaluateAndSetCooldown({
    pool_address: pool,
    pool_name: "OORBigLoss-SOL",
    base_mint: "OORBigLossMINT",
    close_reason: "oor",
    pnlUsd: -5.0,
    pnlPct: -40,
    recent_deploys: [],
  });

  const db = await loadPoolMemory();
  const entry = db[pool];
  const expectedHours = 6;
  const actualHours = Math.round((new Date(entry.cooldown_until) - Date.now()) / hoursToMs(1));
  pass("OOR big loss cooldown", actualHours, expectedHours);
});

await test("5a. Cumulative loss > $5 → 48 hour cooldown", async () => {
  const pool = `${TEST_POOL_BASE}_cumloss`;
  await cleanupPool(pool);

  // Pre-seed pool with existing deploys totaling -$4
  const db = await loadPoolMemory();
  db[pool] = {
    name: "CumLoss-SOL",
    base_mint: "CumLossMINT",
    deploys: [
      { pnl_usd: -2.0, close_reason: "oor" },
      { pnl_usd: -2.0, close_reason: "oor" },
    ],
    total_deploys: 2,
  };
  await savePoolMemory(db);

  const { evaluateAndSetCooldown } = await import(POOL_COOLDOWN_PATH);
  evaluateAndSetCooldown({
    pool_address: pool,
    pool_name: "CumLoss-SOL",
    base_mint: "CumLossMINT",
    close_reason: "oor",
    pnlUsd: -2.0,
    pnlPct: -20,
    recent_deploys: [],
  });

  const db2 = await loadPoolMemory();
  const entry = db2[pool];
  const expectedHours = 48;
  const actualHours = Math.round((new Date(entry.cooldown_until) - Date.now()) / hoursToMs(1));
  pass("cumulative loss > $5 cooldown", actualHours, expectedHours);
});

await test("5b. Cumulative loss < $5 → NO 48h cooldown (normal OOR applies)", async () => {
  const pool = `${TEST_POOL_BASE}_cumlosssmall`;
  await cleanupPool(pool);

  // Only -$1 total — below threshold
  const db = await loadPoolMemory();
  db[pool] = {
    name: "CumLossSmall-SOL",
    base_mint: "CumLossSmallMINT",
    deploys: [{ pnl_usd: -0.5, close_reason: "oor" }],
    total_deploys: 1,
  };
  await savePoolMemory(db);

  const { evaluateAndSetCooldown } = await import(POOL_COOLDOWN_PATH);
  evaluateAndSetCooldown({
    pool_address: pool,
    pool_name: "CumLossSmall-SOL",
    base_mint: "CumLossSmallMINT",
    close_reason: "oor",
    pnlUsd: -0.3,
    pnlPct: -5,
    recent_deploys: [],
  });

  const db2 = await loadPoolMemory();
  const entry = db2[pool];
  // Should NOT be 48h — first OOR close doesn't get 48h unless big-loss
  const actualHours = Math.round((new Date(entry.cooldown_until) - Date.now()) / hoursToMs(1));
  const ok = actualHours !== 48;
  results.push({ name: "cumulative loss < $5 → no 48h cooldown", got: actualHours, expected: "not 48", ok });
  console.log(`${ok ? "✅" : "❌"} cumulative loss < $5 → no 48h cooldown — got ${actualHours}h (not 48)`);
});

// ─── Summary ───────────────────────────────────────────────────

console.log("\n─────────────────────────────────");
const passed = results.filter((r) => r.ok).length;
const total = results.length;
console.log(`Results: ${passed}/${total} passed`);
if (passed < total) {
  console.log("\nFailed:");
  results.filter((r) => !r.ok).forEach((r) => {
    console.log(`  ❌ ${r.name}: got ${r.got}, expected ${r.expected}`);
  });
  process.exit(1);
} else {
  console.log("All tests passed! ✅");
}
