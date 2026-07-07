# Trailing Tiers — Plan Implementasi (Tiered Trailing Take-Profit)

> **Status: PLAN / DRAFT — belum diimplementasi.** Adaptasi dari draft Hermes
> (`~/.hermes/plans/trailing-tiers-development.md`, 2026-07-07) dengan koreksi desain
> dan analisis data peak PnL. Semua referensi `file.js:line` diverifikasi 2026-07-07.
> Setiap stage butuh go eksplisit dari operator.

## Ide

Trailing TP yang sekarang flat (`trailingTriggerPct=3`, `trailingDropPct=1.1` di
user-config live). Ide dari draft Hermes: drop tolerance melebar seiring profit naik —
profit kecil di-trail ketat, runner besar dikasih napas.

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

### Kesimpulan Phase 0

Nilai terbesar yang tersedia adalah **retune parameter flat** (config-only, nol kode,
reversible). Tiers layak dibangun hanya sebagai penyempurnaan kecil di atasnya —
ketat di bawah, longgar di atas — bukan sebagai ladder 6 tingkat.

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

## Stage A — Retune flat (config-only, NOL kode) — GATE: persetujuan operator

Ini perubahan parameter uang — butuh nilai eksplisit dari operator.

- Usulan berdasarkan simulasi + margin keamanan terhadap bias-ketat:
  `trailingTriggerPct 3 → 2.5`, `trailingDropPct 1.1 → 0.9`.
  (Simulasi bilang 1.5/0.7 paling tinggi, tapi itu di ujung bias optimis — jangan
  lompat ke sana; turunkan bertahap dan ukur.)
- Terapkan via Telegram `/settings` (live tanpa restart).
- Perlakukan sebagai eksperimen ala operator: catat tanggal + review date (~2 minggu),
  bandingkan realized exit vs baseline dengan skill `lp-eval`.
- **Go/no-go Stage B ditentukan setelah data Stage A masuk.**

## Stage B — Implementasi `trailingTiers` (kode) — GATE: go terpisah

Bentuk config (maks 3 tier):

```json
"trailingTiers": [
  { "abovePct": 2.5, "dropPct": 0.9 },
  { "abovePct": 5,   "dropPct": 1.2 },
  { "abovePct": 8,   "dropPct": 1.8 }
]
```

(Angka final di-anchor ke data Stage A saat go diberikan — jangan pakai tabel ini
mentah-mentah tanpa cek ulang distribusi terbaru.)

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

Join `state-archive.jsonl` + `state.json` closed (`peak_pnl_pct`) dengan
`lessons.json` performance (`pnl_pct`, `close_reason`) key `position`; simulasi
`exit = peak ≥ arm ? max(final, peak − drop(tier(peak))) : final`. Jalankan ulang
dengan window recent untuk rezim saat ini sebelum menetapkan angka.
