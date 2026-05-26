---

## 🛡️ R7 FLOOR + MIN-PNL INSTRUMENTATION (PENDING IMPLEMENTATION)

**Date prepared:** 2026-05-23
**Status:** Spec complete, awaiting MiMo implementation
**Handoff doc:** `R7_FLOOR_HANDOFF.md` (saved separately, contains full spec)

### Why This Was Added

Analysis of `bengbeng-explainer-Ckn5_VCru-20260523.json` (522 positions, 1 month):

| Metric | Value |
|--------|-------|
| Net PnL (1 month) | +$9.62 |
| ROI | +0.08% |
| Big losses (>10%) | 7 positions |
| Big loss damage | -$35.26 |
| % of profit eaten by big losses | 78% |

All 7 big losses were R7 Safety-Lock holds that never recovered. R7 design did
not have a floor — would hold any unprofitable position indefinitely.

**Simulation:** Capping loss at -10% would save $17.98/month, no false positive
risk (no position recovered from below -10% in dataset).

### What Will Change

1. **R7 hard floor at -10%** — closes position regardless of profile when PnL ≤ -10%
2. **min_pnl_pct tracking** — every position's worst PnL recorded for tuning
3. **R7_FLOOR action type** — distinct from STOP_LOSS, configurable cooldown
4. **New analysis script** `scripts/analyze-min-pnl.js` for Phase 2 decisions
5. **/observe r7FloorCount** — daily counter for monitoring

### Implementation Strategy

- **Code:** MiMo handoff (spec in R7_FLOOR_HANDOFF.md)
- **Restart:** Wait for existing positions to close, then restart bot
- **Verification:** 14 days post-deploy → run analysis script → tune floor

### Phase 2 Decision Tree (After 14 Days)

Run `node scripts/analyze-min-pnl.js` for recovery rate analysis:

| Recovery rate from -5% | Recommendation |
|------------------------|----------------|
| < 10% | Tighten floor to -5% |
| 10-25% | Keep -10%, observe longer |
| 25-50% | Consider relaxing to -12% or -15% |
| > 50% | R7 thesis strong, floor rarely active |

### Pending Items in Order

- [ ] MiMo: implement R7 Floor + min_pnl_pct (spec ready)
- [ ] Verify all inline tests pass
- [ ] Git commit + push to fork
- [ ] Wait for existing positions to drain
- [ ] Backup state.json
- [ ] Restart bot
- [ ] Day 1-3: Monitor r7FloorCount baseline
- [ ] Day 14: Run `analyze-min-pnl.js`, Phase 2 decision

### Notes for Future Sessions

- This work supersedes earlier "WebSocket monitoring for SL >10%" idea
- WebSocket was rejected — data showed problem is decision logic (R7 hold trap),
  not detection latency
- R8 verification (Phase H) still pending — independent track
- After R7 Floor stable + Phase 2 tuning done, can revisit R8 activation

### Session Continuity Log Addition

- **2026-05-23** — Bengbeng analysis revealed R7 hold trap, R7 Floor spec
  designed with MiMo handoff document prepared
