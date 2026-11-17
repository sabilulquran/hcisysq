# Verifikasi rilis produksi — hcis-ee273bc5-20261117 (OPS-MI8-REL-001)

**Tanggal:** 2026-11-17 14:01–14:04 UTC (21:01–21:04 WIB), pengamatan 10 menit sampai 14:14 UTC
**Operator:** Claude Code (sesi rilis untuk #377–#381), di bawah aturan owner 2026-10-27: rilis tanpa konfirmasi, dengan pengaman teknis tetap dijalankan (dry run lebih dulu, backup basis data sebelum migrasi, gate kandidat, rollback bila verifikasi gagal, laporan sesudahnya, tidak pernah pada jam 19 UTC). Kunci rilis perangkat kosong saat preflight, diambil skrip, dan dilepas setelah verify.

| Item | Nilai |
|---|---|
| SHA target | `ee273bc53bb8f902ab3207d94d3519143ae5ce8a` (`origin/main`: merge #381; pohonnya sama dengan head PR yang CI-nya hijau) |
| Rilis sebelumnya (sasaran rollback) | `hcis-ce1c81ba-20261117` |
| Isi | #376 catatan verifikasi rilis `ce1c81ba`; #378 PAY-003 §7.5–7.6: premi BPJS Kesehatan yang ditanggung yayasan boleh masuk basis PPh21, dan tata letak slip baru dengan blok *Ditanggung yayasan* (migrasi 0165, sakelar mati); #377 PAY-003-THR: THR honorer dan pekerja lepas dari rata-rata upah 12 bulan, input periode `THR_AVERAGE_WAGE` dan blocker barunya (migrasi 0167); #379 DOC-004 spesifikasi konsumen Sekretariat dan skrip ekspor DOC-003; #381 DOC-001 surat penghasilan mengikuti bruto slip baru dan menyebut premi BPJS yang ditanggung yayasan, plus perbaikan total laporan/slip (tanpa migrasi) |
| Konfigurasi | Tidak ada perubahan `final.env` (berkas tidak berubah sejak 2026-11-13 15:35 WIB, 2462 byte). Rentang `ce1c81ba..ee273bc5` tidak menyentuh `apps/api/src/config/env.ts`, jadi tidak ada kunci lingkungan baru yang wajib |
| Build | run [44097767779](https://github.com/sabilulquran/hcisysq/actions/runs/44097767779), bundel `hcis-ee273bc5-20261117.tar.gz` sha256 `6c9178d2ea991f398486ac1c1ed3e18490a28d488252413b66adf2e1ce218564` |
| Migrasi | 144 di bundel; 2 diterapkan: `0165_payroll_payslip_layout_policy`, `0167_payroll_thr_non_permanent`. Nomor 0166 memang tidak dipakai — runner mencocokkan migrasi dari nama berkas, bukan dari nomor tertinggi, jadi lompatan nomor tidak berpengaruh |
| Backup pra-rilis | `/srv/hcis/backups/pre-release/hcis-ee273bc5-20261117-20261117T140216Z.dump` (sha256 `5abaebad…de49fa88`, 40.770.629 byte), terbaca oleh `pg_restore --list` |
| Launcher / worker | `sq-core-launch.sh` `1dd50b99ca3e4582` → `7e02cd301076dd7b`; `sq-core-worker.sh` `72902bd54df83d79` → `5317d9ff12df8dd4` (awalan sha256) |
| Worker | direstart dengan KILL: pid 14906 → 17458 |
| Sasaran rollback | `hcis-ce1c81ba-20261117`. Kedua migrasi hanya melebarkan CHECK dan menambah satu CHECK baru serta memecah versi kebijakan `THR`, jadi rilis lama tetap jalan di skema baru dan rollback cukup di sisi aplikasi |

## Dampak kebijakan dan sakelar

Semua perubahan perilaku #377 dan #378 berada di balik versi kebijakan yang tidak dibuka:

- `0165` hanya melebarkan CHECK `payroll_policy_versions_policy_key_check` agar kunci `PAYSLIP_LAYOUT` boleh ditulis. Tidak menyisipkan baris, tidak mengubah slip, tidak memberi izin.
- `0167` melebarkan tiga CHECK `payroll_period_inputs` (`input_key_check`, `reason_required`, `adjustment_has_decision`), menambah satu CHECK baru (`payroll_period_inputs_thr_average_wage_whole`), lalu menutup versi kebijakan `THR` yang terbuka dan membuka versi baru. Tidak ada tabel, kolom, rute atau izin baru, sehingga jendela izin §4.5 tidak terbuka pada rilis ini.

Dibaca setelah migrasi, `payroll_policy_versions` berisi dua baris `THR` dan tidak satu pun baris `PPH21_SETTINGS` maupun `PAYSLIP_LAYOUT`:

| policy_key | effective_from | effective_to | id |
|---|---|---|---|
| `THR` | 2026-01-01 | 2026-11-16 | `7a0f3c2e-5b1d-4e8a-9c41-0d2b6e8f1a52` |
| `THR` | 2026-11-17 | terbuka | `3c1e9b7a-64f2-4d0b-8a55-2f7d1c9e0b43` |

Versi lama mempertahankan payload-nya (`eligibleTermCategories` tetap `["TETAP", "PERCOBAAN", "KONTRAK"]`), versi baru menambah `KONTRAK_HONORER` dan `LEPAS` serta `averageWageComponents` = `["TRANSPORT", "TEACH_FEE", "PJ_MEDIA", "OTHER_INCOME"]`. Karena tidak ada periode `THR` berstatus APPROVED ke atas, tanggal mulai versi baru jatuh tepat pada tanggal keputusan owner, 2026-11-17. `0167` juga menulis satu `payroll_audit_events` `payroll.policy.version_opened` (actor `NULL`, `origin = migration 0167_payroll_thr_non_permanent`, `effective_from = 2026-11-17`) — satu-satunya baris non-skema yang ditulis rilis ini.

Hitungan kunci kebijakan setelah rilis: `BASIC_MULTIPLIER`, `BPJS_KESEHATAN`, `CONTRACT_RATES`, `EARLY_SERVICE`, `FAMILY`, `FUNCTIONAL_ALLOWANCE`, `OVERTIME`, `PERFORMANCE`, `POSITIONAL_ALLOWANCE`, `SALARY_SCALE`, `TEACHING_HOURS`, `VARIANCE_THRESHOLD` masing-masing 1 baris, `THR` 2 baris. Tidak ada `PPH21_SETTINGS`, `PPH21_ANNUAL`, `PPH21_TER`, `PERFORMANCE_PERCENT` atau `PAYSLIP_LAYOUT`, jadi PPh21 yang ditanggung yayasan dan tata letak slip baru tetap mati.

## Hasil

Preflight dan dry run `all` lolos (kunci kosong, 23.011 MB bebas di `/data`, biometrik OFF, basis data `sqcore_hcis`, 2 migrasi tertunda ditinjau, exit 0). Dengan `--apply`:

- upload, backup dan migrate lolos (`applied 0165…`, `applied 0167…`, lalu `all bundle migrations applied`);
- gate kandidat lolos: API `/health` dan `/ready`, web `/` dengan `no-store`, `/login`, aset entri `immutable`, aset hilang 404 — tujuh PASS, kedua port ditutup lagi;
- setelah cutover (restart 21:03:03 WIB, satu `launch` per layanan pada 21:03:20 dan 21:03:36, rilis baru jalan setelah ~28 detik) verify lolos: jalur rilis API dan web, `/health`, `/ready`, web `/` `no-store`, symlink `current`, worker hidup, publik `/api/health`, `/login`, aset hilang 404.

Tidak ada rollback. Tidak ada fase yang gagal.

## Pemeriksaan baca-saja setelah verify

- `https://hcis.sabilulquran.or.id/api/health` → 200, badan `{"status":"ok"}`.
- Tanpa sesi, rute-rute ini menjawab 401 (bukan 5xx, bukan 200): `/api/attendance/me/transactions` (badan `{"code":"UNAUTHENTICATED","message":"Sesi tidak ditemukan atau sudah berakhir."}`), `/api/payslips`, `/api/payroll/periods`, `/api/payroll/policies`. Jadi transaksi kehadiran tetap hanya untuk yang berautentikasi.
- Deep link `/login`, `/app/attendance/transactions`, `/app/payslips` dan `/admin/payroll` mengembalikan shell SPA (200); `/assets/does-not-exist.js` 404.
- `hub.sabilulquran.or.id` dan `aset.sabilulquran.or.id` menjawab 200.
- Pengamatan 10 menit (14:04–14:14 UTC): `/api/health` dan `/login` 200 pada setiap menit; proses `hcis` (pid 18296) dan `hcis-web` (pid 18597) serta worker (pid 17458) tidak berubah; `cwd` keduanya di dalam `hcis-ee273bc5-20261117`; `current` → `releases/hcis-ee273bc5-20261117`; tidak ada baris level error di `api.log`.

## Angka yang tidak berubah

Dibandingkan dengan nilai yang dibaca tepat sebelum migrasi:

| Pemeriksaan | Sebelum | Sesudah |
|---|---|---|
| Slip terbit: jumlah dan sidik jari `md5(string_agg(id‖md5(lines)))` | 5202, `28ae332d04d6530d6a471fdf73ea4b70` | 5202, `28ae332d04d6530d6a471fdf73ea4b70` |
| Lima slip terbit terbaru (id, periode, kind, `md5(lines)`) | identik | identik |
| `payroll_periods` / `payroll_results` / `payroll_result_lines` / `payroll_period_inputs` | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |

Catatan kejujuran untuk uji petik laporan periode: produksi **belum punya satu pun baris `payroll_periods`** — modul penggajian belum dipakai menghitung periode di produksi, dan 5202 slip yang ada adalah hasil impor riwayat. Jadi tidak ada laporan periode penggajian yang bisa dibandingkan sebelum dan sesudah; yang bisa dan sudah dibandingkan adalah seluruh himpunan slip terbit, yang sidik jarinya identik. Uji petik laporan periode baru bisa dilakukan setelah HC menghitung periode pertama di produksi.

## Yang tidak berubah

Tidak ada data produksi yang disunting tangan, tidak ada akun, undangan atau notifikasi yang dibuat. Baris yang ditulis rilis ini hanya milik migrasi sendiri: penutupan versi `THR` lama, versi `THR` baru, dan satu kejadian audit pembukaan versi (0167). Setiap sakelar fitur baru tetap mati — tidak ada baris `PPH21_SETTINGS` maupun `PAYSLIP_LAYOUT`, sehingga tidak ada angka penggajian, slip, atau surat penghasilan yang berubah.

Tidak dikerjakan operator: login lewat peramban dan penyegaran deep link dalam keadaan terautentikasi. Agen tidak pernah mengetik kredensial; HC atau owner yang memeriksanya pada masuk berikutnya.
