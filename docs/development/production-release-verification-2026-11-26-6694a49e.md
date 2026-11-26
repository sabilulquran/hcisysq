# Verifikasi rilis production — `hcis-6694a49e-20261126`

**Spec ID:** OPS-MI8-REL-001 (catatan pelaksanaan)
**Tanggal:** 2026-11-26
**Operator:** agen, atas permintaan owner (keputusan owner 2026-10-27: `--apply` berjalan tanpa menunggu persetujuan, dengan gate teknis yang tetap wajib)
**Hasil:** **berhasil**, verify lulus pada percobaan pertama, tanpa rollback.

| | |
|---|---|
| SHA | `6694a49e5ad1e70b7ac9691f1a4f5ebe22254a47` (merge PR #422, UI-TYPE-001) |
| Rilis sebelumnya / sasaran rollback | `hcis-7fd89146-20261126` |
| Build | run 45790861793, bundle `hcis-6694a49e-20261126.tar.gz`, sha256 `62fb4da85b9f863d69ed5d49fdfedeed71c4a20152d5165f021168643f49ce49`, 158 migrasi |
| Terpasang di | `/srv/hcis/releases/hcis-6694a49e-20261126` (134 MB) |
| Backup pra-rilis | `/srv/hcis/backups/pre-release/hcis-6694a49e-20261126-20261126T092822Z.dump`, 42.430.889 byte, sha256 `9da45a5afe89f2347c70ede76e60a501fa8e645fa5af6ff98a1533a9c5b34c1a` |
| Migrasi diterapkan | **tidak ada** — `preflight` membaca "pending migrations: none", `migrate` no-op |
| Cutover | 26 Nov 2026 **16:29 WIB** (09:29 UTC) |
| Launcher / worker | `9e56294d4e90405a` → `57ad03e203440eee`; `dcf8a2c4d33f742e` → `33f5c3cd041cd602` |
| Worker pid | 9349 → 23990 |
| Sehat kembali | ~28 detik |
| Lock | diambil dan dilepas; `release_lock=released` |

## Isi rilis

Hanya perubahan presentasi di `apps/web`. Tidak ada perubahan API, izin, audit, data, atau skema
database — karena itu tidak ada migrasi tertunda sama sekali.

Yang berubah (PR #422, lanjutan #417 dan #419):

- Layar biometrik mesin: 30 tombol tanpa handler dihapus, dan keadaan mesin per template
  ditampilkan di samping keadaan HCIS.
- Bilah petunjuk pada halaman cetak laporan kehadiran: kontras diperbaiki (sebelumnya ±1:1 di
  tema gelap).
- Dua halaman verifikasi publik (`/cek/$code`, `/verifikasi/penghargaan/$code`): vonis dinaikkan
  ke 24px dan warna status mentah diganti token status HCIS.

Rinciannya di `docs/design/unslop-2026-11-25/README.md` §8.

## Dry-run

Dijalankan lengkap sebelum `--apply`, semua fase lolos:

```
target is current origin/main
bundle ok: hcis-6694a49e-20261126 sha256=62fb4da8… migrations=158
pending migrations: none
preflight OK
trip-002 gate: uang saku dinas is OFF on the device and no advance is left stranded
```

Setiap perintah yang mengubah perangkat dicetak, tidak dijalankan.

## Gerbang TRIP-002

`trip_002_gate_pre_migrate` tidak berjalan: bundle tidak membawa `0172`, dan migrasi itu sudah
lama diterapkan. `trip_002_gate_mapped` berjalan dalam bentuk ringkasnya — uang saku dinas **mati**
di perangkat dan tidak ada uang muka yang tertinggal tanpa penyelesaian (TRIP-002 D-22).

## Gerbang kandidat

Rilis kandidat dijalankan pada port terpisah (API `:3391`, web `:3291`) sebelum cutover. Tujuh
pemeriksaan lulus:

```
PASS api /health      PASS api /ready
PASS web / status     PASS web / no-store      PASS web /login
PASS web entry asset immutable                 PASS web missing asset 404
candidate_gate=PASS
```

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
/srv/hcis/releases/hcis-6694a49e-20261126/apps/api      | /usr/bin/node dist/server.js
/srv/hcis/releases/hcis-6694a49e-20261126/apps/web/dist | /usr/bin/python3 spa_static_server.py
```

## Yang belum dikerjakan

Login lewat browser dan refresh deep-link pada domain production belum dijalankan sesudah cutover;
`verify` sudah memeriksa `/login` dan fallback aset dari sisi publik. HCIS juga belum dibuka untuk
seluruh pegawai (lihat OPS-CLOSE-001), sehingga rilis ini belum dipakai pengguna akhir.
