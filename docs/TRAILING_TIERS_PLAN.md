# Trailing Tiers — Plan Implementasi (Tiered Trailing Take-Profit)

> **Status: PLAN / DRAFT — belum diimplementasi.** Adaptasi dari draft Hermes
> (`~/.hermes/plans/trailing-tiers-development.md`, 2026-07-07) dengan koreksi desain
> dan analisis data peak PnL. Semua referensi `file.js:line` diverifikasi 2026-07-07.
> Setiap stage butuh go eksplisit dari operator.

## Ide & Tujuan

Trailing TP yang sekarang flat (`trailingTriggerPct=3`, `trailingDropPct=1.1` di
user-config live). Tujuan operator (klarifikasi 2026-07-07): **opportunity capture** —
selama pool masih eligible (in-range, fee masih ngalir), jangan biarkan wiggle kecil
menendang posisi keluar; kasih napas melebar seiring profit naik supaya fee terus
terakumulasi. Ini BUKAN fitur proteksi profit — proteksi sudah dipegang Rule 0/R1.
Framing ini penting: analisis apa pun yang hanya menghitung "exit di peak−drop"
undervalue policy yang lebar, karena tidak memodelkan fee yang terus masuk selama
posisi bertahan.

---

## Phase 0 — Analisis Data Peak (SELESAI 2026-07-07)

Metodologi: join `peak_pnl_pct` (state-archive.jsonl 829 + state.json closed 156)
dengan final `pnl_pct` + `close_reason` (lessons.json performance). Coverage
964/985. Simulasi first-order: kalau peak ≥ arming, exit ≈ `max(final, peak − drop(tier))`;
kalau tidak, exit = final aktual.

### Distribusi peak PnL (n=964, semua closed positions)

| | p50 | p75 | p90 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| peak pnl% | 0.59 | 1.86 | 3.64 | 4.38 | 6.98 | **12.10** |

| Threshold | ≥3% | ≥3.5% | ≥4.5% | ≥5% | ≥7.5% | ≥10% | ≥12.5% | ≥15% |
|---|---|---|---|---|---|---|---|---|
| posisi | 166 (17%) | 101 (10%) | 48 (5%) | 34 (3.5%) | 6 (0.6%) | 5 (0.5%) | **0** | **0** |

Rezim recent (sejak risk change 2026-06-21, n=62): max peak 6.28%, tidak ada yang ≥7.5%.

### Simulasi policy (avg exit pnl%/posisi; ALL n=964 / RECENT n=62)

| Policy | ALL | RECENT |
|---|---|---|
| ACTUAL (yang benar-benar terjadi) | 0.06% | 0.34% |
| Flat live (3 / 1.1) | 0.19% | 0.47% |
| **Ladder Hermes 6-tier (3.5 … 15)** | **0.14%** | **0.46%** |
| Collapsed 3-tier (3.5/0.9, 7.5/1.2, 12.5/1.5) | 0.14% | 0.46% |
| Flat retuned (2.5 / 0.8) | 0.24% | 0.49% |
| Tight 3-tier (2.5/0.8, 5/1.2, 8/1.8) | 0.23% | 0.49% |
| Flat tight (2 / 0.8) | 0.33% | 0.50% |
| Tighter 3-tier (2/0.7, 4/1.0, 6/1.5) | 0.34% | 0.51% |

### Temuan

1. **Ladder Hermes (tier sampai 15%) itu fantasi.** Peak ≥12.5% tidak pernah terjadi
   dalam 964 posisi; ≥7.5% cuma 6 kali (0.6%). Tier 3-6 dari draft = konfigurasi mati.
2. **Ladder Hermes malah LEBIH BURUK dari flat yang sekarang** (0.14 vs 0.19): naikin
   arming 3→3.5 membuang 65 posisi armed (166→101) — lebih mahal daripada untungnya
   drop 0.9 yang lebih ketat.
3. **Tiering per se hampir tidak menambah apa-apa vs flat yang di-retune** (0.23 vs
   0.24; 0.34 vs 0.33). Distribusi peak kita nyaris tanpa ekor (p99 = 6.98%) — premis
   "runner besar butuh napas lebar" tidak ada di data kita, karena begitu trailing
   armed, OOR langsung close (state.js:551 `oorLimit=0` saat armed) — runner ditutup,
   bukan dibiarkan lari ke 15%.
4. **Simulasi bilang: makin ketat makin bagus** (flat 1.5/0.7 paling tinggi). TAPI
   simulasinya optimis dan bias ke arah ketat — dia asumsi fill persis di garis
   peak−drop. Kasus nyata: "peak 6.06% → exit −0.57%" (jatuh 6.63pt menembus garis
   drop 0.5 sebelum sempat ke-fill). Drop yang terlalu ketat di dunia nyata: kena
   wick transien, fill jauh di bawah garis saat dump cepat, dan memotong posisi yang
   masih menghasilkan fee (biaya kesempatan tidak dimodelkan).

### Kesimpulan Phase 0 (direvisi setelah klarifikasi tujuan)

Simulasi peak-based valid untuk membunuh ladder Hermes (threshold 7.5-15% tidak pernah
tersentuh) tapi **bias untuk tujuan opportunity capture**: distribusi peak historis
tersensor oleh policy closing itu sendiri (posisi yang dipotong drop 1.1 di 4% tidak
pernah sempat menunjukkan peak 8%), dan exit dini yang "menang" di simulasi tidak
membayar fee yang hilang. Kesimpulan "tighter is better" dari simulasi ini TIDAK
dipakai untuk desain — lihat Phase 0.5.

---

## Phase 0.5 — Analisis Wiggle In-Range (SELESAI 2026-07-07)

Sumber data yang tidak tersensor arah: `[PnL poll diag]` di log harian — time series
PnL per posisi resolusi ~3 detik. Window tersedia: 7 hari (2026-07-01 → 07-07),
36 posisi, 149 episode drawdown (depth > 0.05pt). Episode = turun dari running max;
"recovered" = balik bikin high baru; "terminal" = tidak pernah balik (close/akhir data).

### Depth drawdown per level profit saat drawdown mulai (pnl-pt)

| Bucket | Recovered: n / p50 / p90 / p95 / max | Terminal: n / max |
|---|---|---|
| 0-2% | 98 / 0.20 / 1.59 / 2.88 / 5.11 | 6 / 16.23 |
| 2-4% | 31 / 0.25 / **1.72** / 1.82 / 3.00 | 2 / 4.61 |
| 4-6% | 9 / 0.19 / 1.04 / 1.04 / 1.04 | 2 / 1.27 |
| ≥6% | 1 / 0.21 | 0 |

### Survival rate wiggle-recoverable per kandidat dropPct (bucket 2-4% / 4-6%)

| dropPct | 2-4% | 4-6% |
|---|---|---|
| 0.9 | 74% | 89% |
| **1.1 (live)** | **77%** | 100% |
| 1.5 | 84% | 100% |
| **1.8** | **94%** | 100% |
| 2.2 | 97% | 100% |

### Temuan Phase 0.5

1. **Intuisi operator terkonfirmasi**: di zona profit 2-4%, drop 1.1 yang sekarang
   memotong ~23% wiggle yang sebenarnya recover (akan bikin high baru). Melebarkan
   ke 1.8 menaikkan survival ke 94%.
2. Biaya pelebarannya kecil: terminal dump di zona itu (n=2) depth-nya 4.61pt —
   menembus drop lebar mana pun; biaya marginal 1.1→1.8 ≈ 0.7pt ekstra giveback per
   terminal, vs 17-20% lebih banyak posisi yang tetap hidup dan terus menghasilkan.
3. Caveat: window cuma 7 hari / 36 posisi; bucket atas sample tipis; confirm window
   3s (pecut) sudah menolak sebagian wick transien, jadi survival real di 1.1
   sedikit lebih baik dari angka mentah. Ulangi analisis ini saat mau menetapkan
   angka final (metodologi di bawah).

---

## Koreksi Desain vs Draft Hermes

1. **Seleksi tier WAJIB dari `pos.peak_pnl_pct` (confirmed), bukan current PnL.**
   Draft Hermes pakai current → saat drawdown tier ikut turun → drop lebar tier
   tinggi tidak pernah benar-benar berlaku. Peak-based = ratchet monotonic; peak
   sudah tick-confirmed via `confirmPeak` (dipanggil dari poller 3s, index.js:978),
   jadi tidak butuh mekanisme konfirmasi baru.
2. **Maksimal 3 tier.** Tier dengan drop yang sama dengan tier di bawahnya identik
   perilakunya (terbukti di simulasi: 6-tier ≡ 3-tier collapsed).
3. **Semantik arming**: kalau `trailingTiers` ada dan valid → tier pertama = arming
   threshold, flat keys DIABAIKAN. Kalau absen/invalid → flat. Tidak ada mode campur.
4. **Field tier**: `{ abovePct, dropPct }` — bukan `trailingTriggerPct` di dalam tier
   (membingungkan dengan key flat).
5. **Dua titik integrasi, bukan satu** (draft Hermes cuma sebut state.js):
   - `state.js:489` — arming (`peak ≥ trigger` → pakai tier-1 abovePct)
   - `state.js:534-539` — Rule 2 queue (`dropFromPeak ≥ drop` → pakai drop tier aktif)
   - `index.js:183` — **timer confirm resolve** membaca `config.management.trailingDropPct`
     langsung; harus derive drop dari tier yang sama (dari peak), kalau tidak
     queue/resolve mismatch.
6. **state.js tidak mengimpor config** (aturan repo): resolver = pure function
   `resolveTrailingTier(peakPnlPct, mgmtConfig)` di state.js, nilai via `mgmtConfig`
   yang memang sudah di-thread. Gampang diunit-test.
7. Urutan emergency-before-peak-gate di poller (index.js:978-987) tidak boleh berubah.

---

## Stage A — Quick win flat (config-only, NOL kode) — ✅ APPLIED 2026-07-07

**Status: AKTIF sejak 2026-07-07 08:02 UTC** — operator apply via /settings
(`trailingTriggerPct 2.5`, `trailingDropPct 1.5`; verified live setelah restart
18:23 UTC). Review ~2026-07-21. Detail eksperimen di memory
`trailing-stage-a-experiment`.

Ini perubahan parameter uang — butuh nilai eksplisit dari operator. Flat tidak bisa
melebar per level (itu kerjaan Stage B), tapi ada dua tweak murah selagi Stage B
dibangun:

- `trailingTriggerPct 3 → 2.5` (arming lebih awal — 40% cohort armed historis ada
  di [3, 3.5); menangkap lebih banyak posisi ke dalam rezim trailing).
- `trailingDropPct 1.1 → 1.5` (kompromi satu-angka ke arah capture: survival 2-4%
  naik 77%→84% tanpa menunggu tiers; JANGAN 0.9 — itu arah proteksi, kebalikan
  tujuan).
- Terapkan via Telegram `/settings` (live tanpa restart).
- Perlakukan sebagai eksperimen ala operator: catat tanggal + review date (~2 minggu),
  bandingkan realized exit + fee capture vs baseline (tabel Phase 0/0.5 di atas;
  rerun analisis wiggle dengan log segar — metodologi di bagian bawah dokumen ini).
- **Go/no-go Stage B ditentukan setelah data Stage A masuk.**

## Stage B — Implementasi `trailingTiers` (kode) — GATE: go terpisah

Bentuk config (maks 3 tier), arah **melebar ke atas** (opportunity capture — dari
data Phase 0.5):

```json
"trailingTiers": [
  { "abovePct": 2.5, "dropPct": 1.2 },
  { "abovePct": 4,   "dropPct": 1.8 },
  { "abovePct": 6,   "dropPct": 2.2 }
]
```

Rasional: tier 1 ≈ ketatnya sekarang (profit kecil, tidak banyak yang dilindungi);
tier 2 di zona 4%+ pakai 1.8 (survival wiggle 94% di bucket yang wiggle-nya paling
besar); tier 3 = opsi murah pada ekor — jarang aktif, dan kalau aktif membiarkan
posisi ride. (Angka final di-anchor ulang: jalankan lagi analisis Phase 0.5 dengan
log terbaru saat go Stage B diberikan.)

1. **Config key** via skill `add-config-key`, dengan catatan khusus:
   - Array-of-objects → TIDAK masuk `CONFIG_MAP`/LLM-settable (parseConfigValue tidak
     siap); edit via file + restart, atau `OPERATOR_ONLY_KEYS` kalau mau via Telegram.
   - Validasi di config.js: array ≤ 3, `abovePct` strictly ascending, `dropPct` > 0
     non-decreasing; invalid → log warn + fallback flat (JANGAN crash startup).
2. **Resolver**: `resolveTrailingTier(peakPnlPct, mgmtConfig)` pure function di
   state.js; return `{ armed, dropPct, tierIndex }`.
3. **Integrasi 3 titik** (lihat Koreksi Desain #5). Log saat tier naik:
   `[STATE] Trailing tier 2 active for <pos> (peak 5.1% → drop 1.2%)`.
4. **Observability**: tier aktif tampil di /positions & briefing (read-only);
   `/settings` menampilkan ladder (read-only, `settingValue("trailingTiers")`).
5. **Tests** (regression-test.js): functional — resolver diimpor dan dites:
   peak-based ratchet (peak turun ≠ tier turun), fallback flat kalau key absen,
   fallback kalau invalid (unsorted, drop negatif), boundary tepat di abovePct;
   source-check — index.js:183 path tidak lagi baca `trailingDropPct` mentah.
6. **Rollback**: hapus `trailingTiers` dari user-config + restart (atau set null via
   operator key) → perilaku flat kembali. Didokumentasikan di sini = cukup.

Checklist quality bar CLAUDE.md "Any code change" + "New config key" berlaku penuh.

## Stage C — di luar scope (jangan disentuh tanpa diskusi baru)

- Evolusi tier via lessons.js/darwin, per-pool override, edit ladder via Telegram.

---

## Risiko

| Risiko | Mitigasi |
|---|---|
| Simulasi optimis (fill di garis, fee terpotong tidak dimodelkan) | Stage A dulu (reversible), langkah kecil, review date + lp-eval |
| Queue/resolve mismatch (drop beda antara state.js dan index.js:183) | Tes source-check + functional; derive dari peak di kedua sisi |
| Ladder basi saat rezim berubah | Angka di-anchor ulang ke distribusi peak saat go Stage B |
| Startup gagal karena config invalid | Validasi fail-open → fallback flat + warn |

## Metodologi analisis (untuk diulang nanti)

**Phase 0 (distribusi peak, tersensor policy):** join `state-archive.jsonl` +
`state.json` closed (`peak_pnl_pct`) dengan `lessons.json` performance (`pnl_pct`,
`close_reason`) key `position`; simulasi
`exit = peak ≥ arm ? max(final, peak − drop(tier(peak))) : final`.

**Phase 0.5 (wiggle, tidak tersensor arah — INI yang dipakai untuk sizing drop):**
parse `[PnL poll diag]` dari `logs/agent-*.log`
(regex `pos pnl=X% peak=Y% in_range=bool`), per posisi bentuk episode drawdown dari
running max; klasifikasi recovered (balik bikin high baru) vs terminal; bucket by
profit level saat mulai; hitung survival rate per kandidat dropPct. Filter posisi
test (POOL_XXX) — log dipollusi regression test. Retensi log terbatas (~7-14 hari),
jadi jalankan segera sebelum menetapkan angka, jangan pakai angka basi.
