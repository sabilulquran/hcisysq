# Verifikasi rilis production — `hcis-e65aea1d-20261127`

**Spec ID:** OPS-MI8-REL-001 (catatan pelaksanaan)
**Tanggal:** 2026-11-27
**Operator:** agen, atas permintaan owner (keputusan owner 2026-10-27: `--apply` berjalan tanpa menunggu persetujuan, dengan gate teknis yang tetap wajib)
**Hasil:** **berhasil**, verify lulus pada percobaan pertama, tanpa rollback.

| | |
|---|---|
| SHA | `e65aea1d4c1b3da1fe139d16b3e90f0efb1e41d7` (merge PR #426, ATT-014) |
| Rilis sebelumnya / sasaran rollback | `hcis-6694a49e-20261126` |
| Build | run 45931198774, bundle `hcis-e65aea1d-20261127.tar.gz`, sha256 `dfa75c6e24c1203427db5b83a24a9ce066cdff54b7dd0fd7023b5b85109bc14d`, 158 migrasi |
| Terpasang di | `/srv/hcis/releases/hcis-e65aea1d-20261127` |
| Migrasi diterapkan | **tidak ada** — `preflight` membaca "pending migrations: none", `migrate` no-op |
| Cutover | 27 Nov 2026 **10:03 WIB** (03:03 UTC) |
| Launcher / worker | `57ad03e203440eee` → `762f673da9ef103f`; `33f5c3cd041cd602` → `e9949e65964aa5cb` |
| Worker pid | 23990 → 2821 |
| Sehat kembali | ~30 detik |
| Lock | diambil dan dilepas; `release_lock=released` |

## Isi rilis

Hanya perubahan presentasi di `apps/web`, terbatas pada layar Kehadiran pegawai
(`/app/attendance`) dan komponen yang dipakainya. Tidak ada perubahan API, izin, audit, data,
atau skema database — karena itu tidak ada migrasi tertunda sama sekali. Tidak ada perubahan data
pegawai maupun konfigurasi pilot.

Ringkasnya: satu header dengan satu tombol Clock In/Out, blok Hari Ini yang datar, dan tiga tab
(Riwayat, Jadwal, Pengajuan) menggantikan lima bagian yang dulu tampil bersamaan. Rinciannya di
`docs/design/kehadiran-2026-11-26.md`.

## Prasyarat yang diperiksa sebelum apply

- Tidak ada lock rilis di perangkat (`sq-core-release.lock` tidak ada).
- 03:03 UTC — di luar jam backup 19 UTC (OPS-MI8-BAK-001).
- Ruang `/data`: 18 GB bebas dari 49 GB.
- `main` bersih dan sama dengan sasaran bundle.

## Dry-run

Dijalankan lengkap sebelum `--apply`, semua fase lolos:

```
target is current origin/main
bundle ok: hcis-e65aea1d-20261127 sha256=dfa75c6e… migrations=158
pending migrations: none
preflight OK
trip-002 gate: uang saku dinas is OFF on the device and no advance is left stranded
```

Setiap perintah yang mengubah perangkat dicetak, tidak dijalankan.

## Gerbang kandidat

Rilis kandidat dijalankan pada port terpisah (API `:3391`, web `:3291`) sebelum cutover; tujuh
pemeriksaan lulus, `candidate_gate=PASS`.

## Verifikasi setelah cutover

```
PASS api release      PASS web release
PASS api /health      PASS api /ready          PASS web / no-store
PASS current symlink  PASS worker alive
PASS public /api/health   PASS public /login   PASS public /assets/does-not-exist.js
```

Dibuktikan terpisah dari `cwd` proses yang benar-benar berjalan, bukan dari symlink `current`
maupun keluaran skrip:

```
4033 | /srv/hcis/releases/hcis-e65aea1d-20261127/apps/api      | /usr/bin/node dist/server.js
4620 | /srv/hcis/releases/hcis-e65aea1d-20261127/apps/web/dist | /usr/bin/python3 spa_static_server.py
```

Bundel web yang terpasang memang membawa perubahan ini: `assets/index-B35tW8bR.js` memuat
`Lihat rincian` (label tombol rincian yang baru) dan `Bagian kehadiran` (nama tablist).

## Yang belum dikerjakan

Layar `/app/attendance` sendiri belum dibuka di domain production sesudah cutover: rute itu
ber-login dan mengalihkan ke SSO `login.sabilulquran.or.id`, sedangkan agen tidak mengisi
kredensial. Yang terbukti adalah rilis yang berjalan, kesehatan layanan, halaman publik, dan isi
bundel terpasang. Pembuktian tampilan dilakukan di lingkungan uji dengan data sintetis
(`docs/design/kehadiran-2026-11-26.md` §4a–§4d), termasuk tangkapan layar 375/768/1440.

HCIS juga belum dibuka untuk seluruh pegawai (OPS-CLOSE-001), sehingga rilis ini belum dipakai
pengguna akhir.
