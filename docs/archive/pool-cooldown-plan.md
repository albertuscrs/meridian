# Pool Cooldown Enhancement Plan

## Context

The current `pool-cooldown.js` handles 7 close reasons with fixed cooldowns. Adhi wants to extend it with more granular cooldown rules based on loss severity and cumulative damage.

---

## Template (from user)

| Trigger | Cooldown | Description |
|---|---|---|
| Low yield | 4 hours | Position closed due to insufficient fee generation |
| Stop loss | 2 hours | Position hit stop-loss trigger |
| Loss > 1% (not SL) | 1 hour | Position closed at loss >1% but not stop-loss |
| OOR + big loss | 6 hours | Out-of-range with significant loss |
| Cumulative loss > $5 | 2 days | Total loss across all deploys in the pool > $5 |

---

## Current State vs Required

| Reason | Current | Required | Status |
|---|---|---|---|
| `low yield` | 4h (configurable) | 4h | ✅ Already exists |
| `stop loss` | 12h (hardcoded fallback) | 2h | ⚠️ Exists but wrong default |
| `loss > 1%` | ❌ Not tracked | 1h | 🆕 New reason |
| `oor big loss` | ❌ No "big loss" distinction | 6h | 🆕 New reason |
| `cumulative loss > $5` | ❌ Not tracked | 48h | 🆕 New feature |

---

## Changes Required

### 1. `pool-cooldown.js`

**New close reason constants:**
```js
export const CLOSE_REASON_LOSS_GT_1_PCT = "loss > 1%";
export const CLOSE_REASON_OOR_BIG_LOSS = "oor big loss";
export const CLOSE_REASON_CUMULATIVE_LOSS = "cumulative loss > $5";
```

**New cooldown-hour getters:**
- `getLossGt1PctCooldownHours()` → default **1h**
- `getOorBigLossCooldownHours()` → default **6h**
- `getCumulativeLossCooldownHours()` → default **48h**
- Update `getCooldownHoursForReason()` to handle the two new reasons
- Update `getCooldownHoursForReason(STOP_LOSS)` fallback to **2h**

**New detection functions:**
- `isLossGt1PctCloseReason(reason)` — matches "loss > 1%" or "> 1%" or "loss_gt_1pct" patterns
- `isOorBigLossCloseReason(reason)` — OOR + loss threshold. Since the close_reason string from lessons may already contain loss info, match patterns like "oor" + "loss" or "big loss"
- Actually: **the close reason string won't have loss info by default**. We need to pass `pnlUsd` (or `pnlPct`) to `evaluateAndSetCooldown()` so we can decide the bucket.

**Revised `evaluateAndSetCooldown(closeData)` signature:**
```js
export function evaluateAndSetCooldown(closeData) {
  // closeData = { pool_address, pool_name, base_mint, close_reason, pnlUsd, pnlPct, recent_deploys }
  // ...
}
```

**New cooldown trigger logic:**
1. If `isLowYieldCloseReason` → 4h
2. If `isStopLossCloseReason` → 2h
3. If `isOorCloseReason` AND `pnlUsd < -X` (configurable threshold, default **$2**) → 6h (OOR big loss)
4. If `isOorCloseReason` AND `pnlUsd >= -X` → existing repeated-OOR logic (only if trigger count reached)
5. If `close_reason` indicates manual close at loss → 1h (loss > 1%)
6. Check cumulative pool loss: sum of all `pnlUsd` in `entry.deploys` + new `pnlUsd`. If total < **-$5** → 48h
7. Apply both cooldowns if multiple conditions match (longest wins)

**Cumulative loss tracking:**
- `pool-memory.json` (or `pool-memory.js` store) already tracks `total_pnl_usd` per pool
- In `evaluateAndSetCooldown`, after computing new total, check if threshold crossed
- Add a new field `cumulative_loss_cooldown_until` to the pool entry

**New config keys in `user-config.json` `management` section:**
```json
{
  "lowYieldCooldownHours": 4,
  "stopLossCooldownHours": 2,
  "lossGt1PctCooldownHours": 1,
  "oorBigLossCooldownHours": 6,
  "oorBigLossPnlThreshold": -2,
  "cumulativeLossCooldownHours": 48,
  "cumulativeLossThreshold": -5
}
```

### 2. `lessons.js` — `recordPerformance()`

Update the call to `evaluateAndSetCooldown()` to pass `pnlUsd` and `pnlPct` from the close data.

### 3. `user-config.example.json`

Add all new config keys with their defaults.

### 4. `CLAUDE.md`

Document the new cooldown reasons and config keys.

---

## Implementation Notes

- The `isOorBigLossCloseReason` is NOT a pure string match — it needs `pnlUsd` comparison, so logic belongs in `evaluateAndSetCooldown()` body, not a separate `is*` helper
- Cumulative loss check runs after all individual deploy checks; if triggered, override to longest cooldown
- Cooldown resolution: when multiple cooldowns apply, use the **longest** duration
- Base-mint cooldown for OOR big loss: yes, same pattern as stop-loss
- Base-mint cooldown for cumulative loss: yes, same token keeps losing across pools

---

## Deliverables

1. `pool-cooldown.js` — updated with new constants, getters, and `evaluateAndSetCooldown` logic
2. `lessons.js` — pass `pnlUsd`/`pnlPct` to `evaluateAndSetCooldown`
3. `user-config.example.json` — new config keys
4. `CLAUDE.md` — updated cooldown documentation
5. A test script (or inline test) verifying all 5 cooldown scenarios
