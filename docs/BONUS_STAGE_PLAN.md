# Bonus Stage — Plan Implementasi

> Strategi "🦈 Fast Bid-Ask, Bonus Stage" by bengshark (@bengsharksol, 29 May 2026),
> dipetakan ke codebase Meridian. Status: **PLAN / DRAFT — belum diimplementasi.**
> Feasibility assessment: 2026-07-04.

## Tujuan

Kalau ada token yang **lagi ATH terus** (baru bikin ATH, harga bertahan dekat ATH) dan
**memenuhi semua kondisi screening** di bawah, agent masuk dengan mode "bonus stage":
bid-ask range lebar, TP pendek 5-7%, cut cepat saat breakdown. Ini strategi **momentum**,
bukan fee-farming — profilnya beda dari mode low-risk default.

---

## Strategi Asli (bengshark)

- **Type**: Bid-Ask (double-sided)
- **Bin Range**: -34 / +34 (69 bins, full range)
- **Entry**: Price retrace ke supertrend (15min)
- **Take Profit**: 5-7% PnL
- **Stop Loss**: Cut saat sharp breakdown + out of range

**Token Screening:**

| Filter | Threshold |
|---|---|
| Market Cap | ATH > 250K |
| Volume (1H) | > 100K |
| Supertrend 15m | Bullish |
| Distribution | Top 75 avg buy normal |
| Token Age | < 2 hari, baru bikin ATH |

**Performance (front test bengshark):** 12 entries, 83% WR (10W/2L); kedua loss = token tua
→ filter umur < 2 hari mengeliminasi semua loss. **Catatan skeptis:** sampel cuma 12 —
83% WR di sampel segitu bisa noise. Validasi sendiri sebelum percaya.

---

## Trigger Aktivasi: "Token ATH Terus"

Kondisi masuk bonus stage (SEMUA harus terpenuhi):

1. **Umur token < 48 jam** (`gmgnMaxTokenAgeHours` — sudah ada)
2. **Harga dekat/di ATH** — `priceVsAthPct >= minPctOfAth` (mis. ≥ 90-95% dari ATH; filter baru).
   GMGN tidak kasih *timestamp* ATH, jadi "baru bikin ATH" diproksi dengan: umur muda + harga
   masih nempel ATH. Token muda yang harganya ≥95% ATH secara definisi baru saja bikin ATH.
3. **ATH market cap > 250K** — ATH-mcap ≈ mcap sekarang ÷ (priceVsAthPct/100); filter baru
4. **Volume 1H > 100K** (`gmgnMinVolume` @ interval 1h — sudah ada)
5. **Supertrend 15m bullish** (`requireBullishSupertrend` — sudah ada, aktif)
6. **Distribution sehat** — proxy: suite anti-scam GMGN existing (bundler/sniper/rat/top10/insider).
   Data "top 75 avg buy" persis tidak tersedia dari API kita.
7. **Entry timing: retrace ke garis supertrend** — preset baru `supertrend_bounce`
   (ST bullish + harga dalam X% di atas garis ST)

---

## Feasibility Mapping (per 2026-07-04)

| Elemen bengshark | Status | Detail |
|---|---|---|
| Bid-Ask strategy type | ✅ Ada | `StrategyType.BidAsk` (dlmm.js:691); config live sudah `bid_ask` |
| **Double-sided -34/+34 (69 bins)** | ❌ **Gap terbesar** | dlmm.js:655 hard-block single-side SOL (`amount_x > 0` throw; `bins_above > 0` ditolak di :661). 69 bins sendiri muat (batas DLMM ~70 bin/posisi) |
| Entry: retrace ke supertrend 15m | 🟡 Sebagian | Gate ST-bullish 15m sudah jalan (screening.js:811 `confirmIndicatorPreset` side entry; gmgn.js `requireBullishSupertrend`/`requireAboveSupertrend`; interval 15m aktif). Belum ada: deteksi jarak harga ke garis ST (bounce) |
| TP 5-7% | ✅ Config saja | `takeProfitPct` default 5; trailing: `trailingTriggerPct=5` + `trailingDropPct=1.5` ≈ exit band 5-7% |
| SL: breakdown + OOR | ✅ Ada | R1 stop loss, Rule 0 emergency, R8 exit `supertrend_break` saat OOR |
| Mcap ATH > 250K | 🟡 Filter kecil | GMGN kasih `ath_price` → `priceVsAthPct` (gmgn.js:215). ~15 baris |
| Volume 1H > 100K | ✅ Config saja | `gmgnMinVolume` + `gmgnInterval` 1h |
| Top 75 avg buy normal | 🟡 Approx | Proxy = anti-scam suite existing |
| Token age < 2 hari | ✅ Config saja | `gmgnMaxTokenAgeHours` (config.js:159, default 168) → 48 |
| "Baru bikin ATH" | 🟡 Filter kecil | `athFilterPct` existing arahnya kebalikan (reject dekat ATH); butuh sisi min `minPctOfAth` |

**Verdict: possible, ±70% udah ada.** Sebagian besar config, sisanya filter kecil,
satu gap besar (double-sided deploy).

---

## Kenapa Double-Sided Itu Gap Besar

1. **Butuh beli token dulu**: swap SOL→token ±50% sebelum deploy (infra swap + retry 5x
   sudah ada), baru deploy dua sisi. Close flow sudah auto-swap balik → kompatibel.
2. **Safety checks executor** berasumsi single-side (aturan `bins_above=0`, floor
   `minBinsBelow` 35 — strategi ini pakai 34, beda 1 bin dari floor).
3. **PnL path RPC** (`tools/pnl.js`) deposit tracking berasumsi deposit SOL-only —
   akuntansi dua sisi harus dicek/diperbaiki.
4. **Risiko baru**: slippage 2x per posisi (data sizing test Jun 2026: slippage ~1.8x
   sudah terasa di size 0.65), dan exposure token langsung dari detik deploy — bukan
   hanya saat harga turun masuk range.

---

## Rencana Implementasi Bertahap

### Stage 0 — Nol kode (data dulu)

- Simpan strategi ke strategy library via tool `add_strategy` (referensi LLM screener).
- Preset config *single-sided proxy*: `gmgnMaxTokenAgeHours=48`, `gmgnMinVolume=100000`
  @ interval 1h, `trailingTriggerPct=5`, strategy `bid_ask`, ST 15m bullish (sudah aktif).
  Range bawah tetap ≥35 (floor safety).
- **Tujuan**: lihat apakah filter (token muda + dekat ATH + volume tinggi) menghasilkan
  kandidat yang beda dari screening sekarang, sebelum invest waktu ke Stage 1/2.

### Stage 1 — Filter kecil (±1 hari kerja)

- `athMcapMin` (ATH-mcap ≥ 250K) di gmgn.js — hitung dari `priceVsAthPct` + mcap.
- `minPctOfAth` ("baru bikin ATH" / token ATH terus) di gmgn.js.
- Preset entry baru `supertrend_bounce` di chart-indicators.js: ST bullish + harga dalam
  X% dari garis ST (definisi "retrace ke supertrend").
- Config keys baru → CONFIG_MAP (executor.js) + `settingValue()` mapping + settings UI
  (choiceButton untuk preset) + regression tests.

### Stage 2 — Double-sided deploy (2-3 hari, go/no-go terpisah, risiko tertinggi)

- Jalur deploy baru di dlmm.js: swap SOL→token → deploy `amount_x` + `amount_y`,
  bins -34/+34 (buka blokade single-side secara *opt-in*, bukan default).
- Sesuaikan safety checks executor (aturan bins_above, floor bins) khusus mode ini.
- PnL deposit tracking dua sisi di tools/pnl.js.
- **Wajib `DRY_RUN` dulu**, lalu live dengan size kecil terpisah dari posisi utama.

**Setiap stage butuh persetujuan terpisah sebelum dikerjakan.**

---

## Rules (dari bengshark, tetap berlaku)

1. Filter ketat — gak semua token qualify
2. Entry di supertrend bounce, bukan asal zap in
3. TP pendek 5-7%, jangan serakah
4. Cut loss cepat kalau breakdown, jangan nunggu miracle
5. Backtest → front test → validate → deploy

## Referensi

- Sumber: @bengsharksol, 29 May 2026
- Tools bengshark: bengbeng.fun (LP analysis & backtesting), Supertrend 15m
