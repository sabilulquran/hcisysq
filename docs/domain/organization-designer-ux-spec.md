# ORG-008 — Penyederhanaan Designer Struktur Organisasi: Spesifikasi UX

**Status:** ACCEPTED PRODUCT DIRECTION — keputusan owner O-1..O-10 dicatat 2026-10-16 (§10: "Setuju semua rekomendasi O-1 sampai O-10"); O-11 (unit pilot) tetap terbuka untuk owner. Belum ada implementasi. Asumsi teknis bertanda DRAFT/TBD diverifikasi di masing-masing paket; setiap paket tetap membutuhkan PR, test, dan persetujuan rilis owner sendiri (OPS-MI8-REL-001).  
**Specification:** ORG-008  
**Drafted:** 2026-10-16  
**Gap analysis:** `organization-designer-ux-gap-analysis.md`  
**Related:** ORG-004 (`dynamic-organization-structure.md`, `organization-designer-visual-ranking.md`), ORG-002 (`organization-mapping.md`), ORG-001/AUTH-010 (`organization-access-foundation.md`), ORG-006 (`organization-directory-publishing.md`), APR-001 (`workflows/approval-engine.md`), ATT-011 (PR #103: D-5, D-10, D-11), EMP-006 (PR #102)

## 1. Tujuan dan batas

ORG-008 mengubah **cara Human Capital (HC) bekerja** dengan struktur organisasi agar lima pertanyaan sehari-hari bisa dijawab tanpa memahami model data ORG-004:

```text
1. Unit dan jabatan apa saja yang ada, dan siapa pejabatnya?
2. Setiap pegawai ada di unit mana?
3. Siapa atasan langsung setiap pegawai? Siapa Plt-nya bila jabatan kosong?
4. Apa dampaknya bila saya mengubah struktur mulai tanggal X?
5. Siapa yang menyetujui cuti/lembur pegawai ini, dan siapa yang diberi tahu?
```

ORG-008 **tidak** mengganti model kebenaran backend ORG-004 dan **tidak** mengaktifkan `SHADOW`/`STRUCTURE`. Yang tetap:

| Invariant | Sumber | Konsekuensi untuk ORG-008 |
|---|---|---|
| I-1 Struktur berlaku per tanggal (effective dating) | ORG-004 | Setiap perubahan disusun sebagai "Perubahan struktur berlaku mulai tanggal …"; struktur yang sudah terbit tidak pernah ditimpa. |
| I-2 Snapshot terbit immutable | ORG-004 | "Ubah" pada struktur berlaku selalu membuat perubahan baru; tidak ada edit langsung. |
| I-3 Approval snapshot saat submit | APR-001, ORG-004 | Layar dampak selalu menyebut "pengajuan yang sudah dikirim tidak berubah". |
| I-4 Resolver gagal tertutup | ORG-004 | UI tidak pernah menebak atasan; pegawai tanpa atasan ditampilkan sebagai masalah yang harus diperbaiki. |
| I-5 Rollout terpisah dari terbit | ORG-004, APR-001 | Menerbitkan struktur tidak mengubah mode `LEGACY/SHADOW/STRUCTURE`; aktivasi tetap keputusan owner terpisah (runbook `org004-operational-validation.md`). |
| I-6 Struktur, kewenangan, dan workflow terpisah | ORG-004 | UI boleh menggabungkan beberapa langkah menjadi satu wizard, tetapi backend tetap menyimpan node, posisi, penjabat, anggota, dan binding sebagai catatan terpisah yang masing-masing diaudit. |
| I-7 Tidak ada inferensi dari judul jabatan / level | ORG-004, ORG-002 | Wizard boleh mengusulkan judul "Kepala {unit}" sebagai teks, tetapi kewenangan hanya dibuat dari pilihan eksplisit HC. Usulan dari data lama (O-3) hanya memakai relasi eksplisit, bukan teks jabatan. |
| I-8 Rank visual tanpa kewenangan | ORG-004-VIS | Tetap; dipindah ke menu "Tampilan". |
| I-9 Struktur tidak memberi role/permission | ORG-004, AUTH-011 | Tidak ada paket ORG-008 yang memberi akses karena jabatan. |
| I-10 Audit setiap mutasi privileged dalam transaksi yang sama | ORG-004, SEC-001 | Perintah gabungan menghasilkan event audit per catatan primitif plus satu event ringkasan. |

Non-goal: aktivasi `SHADOW`/`STRUCTURE`, pemilihan unit pilot, pemetaan akun Dewan sebagai approver, workflow builder, matrix organisasi, payroll/grading, upload SK, edit struktur dari HP (O-10).

## 2. Actor

| Actor | Permission saat ini | Peran di ORG-008 |
|---|---|---|
| HC Admin | `human_capital_admin`: `organization.manage` (tanpa `approvals.policy.manage`) | **O-1:** menyusun seluruh isi perubahan — unit, jabatan, anggota, pejabat, Plt, pemimpin/penyetuju unit, atasan khusus, kewenangan khusus — memeriksa, dan membuang. Tidak menerbitkan. |
| Penerbit (Kepala HC / owner) | `approvals.policy.manage` (saat ini hanya kompatibilitas Super Admin) | **O-1:** pemeriksa kedua; satu-satunya yang dapat **Terbitkan**. Siapa yang menerima izin ini (role/akun Kepala HC) = penugasan akses operasional terpisah, TBD. |
| HC Operator | `human_capital` (tanpa `organization.manage`) | Tidak berubah; tidak melihat menu struktur. |
| Pegawai | own data | Tidak berubah di ORG-008. Kartu "Atasan saya" di aplikasi pegawai = usulan lanjutan (bukan paket ini). |
| Owner | — | Telah memutuskan O-1..O-10; memutuskan O-11 (unit pilot) dan aktivasi rollout (di luar ORG-008). |

Tidak ada permission baru. Keputusan O-1 mengubah **permission yang diwajibkan endpoint penyusunan draft** (pejabat, Plt, kewenangan, atasan khusus: `approvals.policy.manage` → `organization.manage`), sementara **Terbitkan** tetap `approvals.policy.manage`. Perubahan ini menjadi paket tersendiri ORG-008-8 dengan test otorisasi lengkap dan review tambahan (AGENTS.md §7, §8).

## 3. Navigasi target dan kamus istilah

Menu admin **Struktur Organisasi** dengan tab:

```text
Struktur Organisasi
  Kesiapan            (halaman pertama: status, masalah, perubahan yang sedang disusun)
  Bagan               (lihat struktur pada tanggal tertentu)
  Pegawai             (setiap pegawai: unit, jabatan, atasan langsung, alasan)
  Plt & jabatan kosong
  Cek persetujuan     (siapa menyetujui siapa, untuk cuti dan lembur)
  Perubahan           (menyusun, memeriksa, menerbitkan perubahan; riwayat)
```

- Route lama `/admin/organization?effectiveDate=…&draftId=…` tetap bekerja dan membuka tab yang sesuai (Bagan atau Perubahan) minimal satu rilis.
- Tab dan tombol hanya tampil bila server menyatakan user punya permission untuk aksinya (`GET /admin/organization/capabilities`, §8). Tidak ada tombol yang pasti berakhir `403`.
- Setiap tab menampilkan **banner mode** yang sama (§4.1).

### Kamus istilah UI (wajib)

| Backend / layar lama | Label operator |
|---|---|
| Organization Designer | Struktur Organisasi |
| change set / draft | Perubahan struktur |
| `DRAFT` | Sedang disusun |
| `VALIDATED` | Siap diterbitkan |
| `PUBLISHED` + `effective_on` > hari ini | Terjadwal berlaku {tanggal} |
| `PUBLISHED` + berlaku | Berlaku |
| publish | Terbitkan |
| validate + impact | Periksa & lihat dampak |
| node / kelompok | Unit (jenis: Yayasan, Bidang, Sekolah/Unit, Divisi, Bagian, Tim) |
| position / posisi | Jabatan |
| primary incumbent | Pejabat |
| acting incumbent | Plt (pelaksana tugas) |
| vacant | Kosong |
| membership | Anggota unit |
| `LEADER` binding | Pemimpin unit (atasan langsung anggota unit) |
| `UNIT_APPROVER` binding | Penyetuju cuti unit |
| `parentPositionKey` / `SUPERVISORY_PARENT` | Melapor ke |
| `GOVERNANCE_APPROVER` | Penyetuju khusus untuk jabatan ini |
| `OVERSIGHT_PARENT` | Diberi tahu setelah disetujui |
| reporting override | Atasan khusus (pengecualian) |
| `CLIMB_TO_PARENT` | Bila kosong: naik ke atasan berikutnya |
| `REQUIRE_ACTING_OR_BLOCK` | Bila kosong: wajib ada Plt, kalau tidak pengajuan ditahan |
| `BLOCK` | Bila kosong: pengajuan ditahan |
| visual rank offset | Tampilan: turunkan kotak 1/2 tingkat |
| `LEGACY` | Persetujuan memakai **data atasan lama** |
| `SHADOW` | Uji banding (data lama tetap dipakai) |
| `STRUCTURE` | Persetujuan memakai **struktur ini** |
| unresolved | Atasan belum bisa ditentukan |

UUID, kode error, enum Inggris, "resolver", "binding", "snapshot", dan "authority" tidak boleh tampil di layar utama. Boleh tampil di panel **Detail teknis** yang tertutup secara default (untuk dukungan teknis).

## 4. Layar

### 4.1 Banner mode (semua tab)

```text
ⓘ Persetujuan cuti saat ini memakai data atasan lama (dari Detail Pegawai dan Konfigurasi Cuti).
  Struktur di halaman ini belum dipakai untuk persetujuan. [Apa artinya?]
```

- Sumber: `GET /admin/organization/rollout` yang sudah ada, diperluas per workflow (§8).
- Saat `SHADOW` untuk unit tertentu: "Unit SDIT sedang uji banding…". Saat `STRUCTURE`: "Persetujuan cuti unit SDIT memakai struktur ini sejak 1 Nov".
- Banner ini **hanya informasi**; tidak ada tombol untuk mengubah mode dari ORG-008.

### 4.2 Kesiapan (halaman pertama)

```text
Struktur berlaku: "Struktur YSQ Oktober" sejak 1 Okt 2026 · 412 pegawai aktif

Perubahan yang sedang disusun
  Restruktur 2027 · berlaku 1 Jan 2027 · 12 perubahan · terakhir Siti, 15 Okt   [Lanjutkan]

Perlu dibereskan                                   (dihitung untuk tanggal: [hari ini ▼])
  ⚠ 23 pegawai aktif belum punya unit                                   [Tempatkan]
  ⚠ 7 pegawai atasannya belum bisa ditentukan                           [Lihat]
  ⚠ 2 jabatan kosong yang mewajibkan Plt, tanpa Plt                      [Lihat]
  ⓘ 1 Plt berakhir dalam 14 hari (Kepala Divisi Sosial, 31 Okt)          [Perpanjang]
  ⓘ 4 atasan belum punya akun HCIS aktif / izin menyetujui               [Lihat]
  ⓘ 1 jabatan dipakai aturan lain (Direktur: lembur tidak berlaku)       [Lihat]

Dibanding data atasan lama                                               [Buka laporan]
  398 sama · 9 berbeda · 5 belum bisa ditentukan
```

- Setiap baris membuka tab terkait yang sudah difilter.
- "Dibanding data atasan lama" = laporan read-only §4.6; **bukan** mode `SHADOW` dan tidak menyentuh rollout.
- Empty (belum ada struktur terbit): "Belum ada struktur. [Mulai dari data yang sudah ada] [Mulai dari kosong]" (O-3).
- Forbidden: tanpa `organization.manage` menu tidak tampil; akses langsung → "Anda tidak punya akses ke Struktur Organisasi".

### 4.3 Bagan

- Tampilan pohon yang sama (renderer ORG-004-VIS dipertahankan) dengan tambahan: **Cari** (unit/jabatan/pegawai), **Fokus unit** (hanya cabang terpilih), **Ciutkan semua**, zoom.
- Pilih tanggal: "Lihat struktur pada [tanggal]"; badge Berlaku/Terjadwal/Riwayat.
- Klik unit/jabatan → **panel samping** (bukan modal), read-only di luar Perubahan:
  - Unit: pemimpin, penyetuju cuti unit, jumlah anggota (daftar), "Staf HC yang menangani unit ini" (dari scope role, §6.3), atasan anggota (dengan keterangan "dari unit induk" bila diwarisi).
  - Jabatan: pejabat, Plt + tanggal, melapor ke, bila kosong, penyetuju khusus/diberi tahu, aturan lain yang memakai jabatan ini (misalnya ATT-011 D-10).
  - Tombol **Ubah di perubahan…** membuka (atau membuat) Perubahan struktur dengan item yang sama terpilih.
- Mobile < 768px: bagan diganti **daftar bertingkat** yang bisa dibuka-tutup; panel jadi layar penuh. Tidak ada aksi edit di HP (O-10).

### 4.4 Pegawai — "atasan langsung setiap pegawai"

Tabel (kartu di HP), paging 50, filter: Unit (termasuk sub-unit), Status masalah, cari nama/NIP.

```text
Pegawai        Unit                  Jabatan              Atasan langsung            Status
Ahmad (S-014)  SDIT › Kurikulum      Guru                 Yusuf · Wakil Kep. Kurik.  ✓
Budi  (S-022)  SDIT › Kurikulum      Guru                 Hasan · Kepala SDIT ⓘ      ✓ atasan khusus
Citra (S-031)  —                     —                    —                          ⚠ belum punya unit
Dodi  (S-040)  Divisi Sosial         Staf                 Direktur ⓘ                 ✓ naik (jabatan kosong)
Eka   (S-051)  Humas                 Staf                 —                          ⚠ unit belum punya pemimpin
```

- Kolom tambahan saat ada perbandingan: **Atasan di data lama** dan penanda "berbeda".
- Klik baris → panel **Kenapa atasannya ini?** dalam kalimat:

```text
Ahmad adalah anggota SDIT › Kurikulum.
Pemimpin unit Kurikulum adalah jabatan Wakil Kepala Kurikulum.
Pejabatnya Yusuf (sejak 1 Jul 2026).
→ Atasan langsung Ahmad: Yusuf.
Penyetuju cuti unit: Kepala SDIT (Hasan).
```

  Untuk kasus jabatan kosong: "Jabatan Kepala Divisi Sosial kosong dan aturannya 'naik ke atasan berikutnya' → Direktur (Fulan)". Untuk Plt: "… diisi Plt Yusuf sampai 31 Des". Untuk gagal: kalimat penyebab + tombol perbaikan (Atur pemimpin unit / Tunjuk Plt / Tempatkan).
- Aksi massal (hanya di dalam Perubahan): **Pindahkan ke unit**, **Atur atasan khusus**.

### 4.5 Plt & jabatan kosong

Dua daftar:

1. **Plt**: `Jabatan | Plt | Mulai | Sampai | Alasan | Sisa hari`, filter "berakhir ≤ 14 hari".
2. **Jabatan kosong**: `Jabatan | Unit | Bila kosong | Saat ini ditangani oleh | Masalah` (mis. "Wajib Plt — pengajuan ditahan").

Wizard **Tunjuk Plt** (membuka/membuat Perubahan berlaku mulai tanggal Plt bila belum ada; DRAFT — lihat O-7):

```text
Jabatan   [Kepala Divisi Sosial ▼]   (pejabat: kosong)
Plt       [cari pegawai aktif…]
Mulai     [1 Sep 2026]   Sampai [31 Des 2026]  (wajib)
Alasan    [Kepala divisi mengundurkan diri; menunggu pengangkatan]  (wajib)
          [ ] catat nomor surat tugas (opsional, teks)
[Lihat dampak] → "5 staf Divisi Sosial: atasan Direktur → Yusuf (1 Sep–31 Des)."
[Simpan ke perubahan]
```

**Akhiri Plt lebih cepat** dan **Perpanjang** memakai wizard yang sama. Menghapus Plt atau menandai jabatan kosong selalu melalui konfirmasi yang menyebut dampaknya.

### 4.6 Cek persetujuan

```text
Pegawai  [cari…]      Jenis  [Cuti tahunan ▼ | Cuti tanpa upah | Lembur]
Tanggal  [hari ini]   Struktur [Berlaku ▼ | Terjadwal 1 Jan 2027 | Perubahan "Restruktur 2027"]

Ahmad mengajukan cuti tahunan pada 20 Okt 2026
  1. Yusuf — Wakil Kepala Kurikulum (atasan langsung)
  2. Hasan — Kepala SDIT (penyetuju cuti unit)
  Setelah disetujui: Direktur (Fulan) diberi tahu        [hanya bila mode STRUCTURE]
  Catatan: pengajuan yang sudah dikirim tidak berubah bila struktur diubah.

Dengan data atasan lama (yang berlaku hari ini): Yusuf → Hasan   ✓ sama
```

- Untuk **Lembur**: memakai satu langkah atasan langsung sesuai ATT-011 §7.3; bila ATT-011-6b belum dirilis, pilihan Lembur menampilkan "pratinjau — belum berlaku" (DRAFT).
- Aturan ATT-011 D-10 yang mengenai pegawai pada tanggal itu ditampilkan: "Lembur tidak berlaku untuk jabatan Direktur".
- Gagal → kalimat penyebab (§7) + tombol perbaikan, bukan error 409.
- **Laporan "Bandingkan dengan data lama"**: pilih unit (atau seluruh yayasan) + tanggal → daftar `Pegawai | Data lama | Struktur | Hasil (sama/beda/belum bisa)`; read-only, tidak menulis apa pun, tidak mengubah rollout. Ini alat persiapan pilot, bukan pengganti bukti `SHADOW` resmi.

### 4.7 Perubahan (menyusun, memeriksa, menerbitkan)

**Daftar perubahan**: `Nama | Berlaku mulai | Status | Jumlah perubahan | Disusun oleh | Terakhir diubah`. Status: Sedang disusun / Siap diterbitkan / Terjadwal / Berlaku / Dibuang. Riwayat terbit tidak bisa dihapus.

**Mulai perubahan**: nama + berlaku mulai (≥ hari ini). Isi awal = struktur yang berlaku pada tanggal itu (perilaku sekarang). Bila sudah ada perubahan yang sedang disusun, tampil "Lanjutkan perubahan yang ada" (O-7).

**Ruang kerja perubahan** — bagan + panel samping editable + daftar "Yang berubah" di sisi kanan (bahasa manusia, bisa dibatalkan per baris selama belum terbit):

```text
Yang berubah (12)                                  [Periksa & lihat dampak]
  + Unit "Bidang Pendidikan" di bawah Yayasan                       [batalkan]
  ↻ Kepala SDIT kini melapor ke Kepala Bidang Pendidikan             [batalkan]
  + Plt Kepala Divisi Sosial: Yusuf (1 Sep–31 Des)                   [batalkan]
  − Tim "Humas Lama" dinonaktifkan                                   [batalkan]
```

Aksi di panel samping:

| Pada | Aksi | Menggabungkan (backend tetap terpisah) |
|---|---|---|
| Unit | **Tambah unit di bawah** (wizard: nama, jenis, pemimpin unit = jabatan baru/ada, pejabat, "pemimpin ini juga penyetuju cuti unit" ✓ default) | node + position + incumbency + `LEADER` + `UNIT_APPROVER` |
| Unit | **Tempatkan pegawai** (cari, filter unit lama, hanya aktif; konflik "sudah di unit X → pindahkan?") | membership ditambah/dipindah per pegawai, bukan ganti seluruh daftar |
| Unit | **Ubah pemimpin / penyetuju cuti** | ganti binding `LEADER`/`UNIT_APPROVER` (akhiri lama + buat baru di perubahan) |
| Unit | Ganti nama, pindah induk, **Nonaktifkan** (ditolak bila masih ada anggota/jabatan aktif; tampil daftarnya) | node patch |
| Jabatan | **Tambah jabatan** (judul, melapor ke — default pemimpin unit, pejabat, bila kosong) | position + incumbency |
| Jabatan | **Tetapkan pejabat**, **Tunjuk Plt**, **Kosongkan** (dengan konfirmasi dampak) | incumbency |
| Jabatan | **Melapor ke** (satu isian) | `parentPositionKey`; binding `SUPERVISORY_PARENT` lama yang bertentangan diakhiri dengan konfirmasi |
| Jabatan | **Penyetuju khusus / Diberi tahu** (kalimat, di bawah "Pengaturan lanjutan") | `GOVERNANCE_APPROVER` / `OVERSIGHT_PARENT` |
| Jabatan | **Nonaktifkan** (ditolak bila ada pejabat/Plt aktif atau dipakai aturan lain tanpa konfirmasi) | position patch |
| Pegawai | **Atur atasan khusus** (atasan = jabatan, mulai, sampai opsional, alasan wajib) | reporting override |
| Unit/Jabatan | **Tampilan** (turunkan 1/2 tingkat) | visual rank offset |
| Item baru di perubahan ini | **Hapus** | menghapus catatan draft (belum pernah terbit) |

**Periksa & lihat dampak** (satu tombol = validasi + dampak):

```text
Restruktur 2027 · berlaku 1 Jan 2027

✓ Tidak ada masalah struktur
Atasan langsung berubah: 31 pegawai          [lihat daftar: Ahmad Yusuf → Hasan, …]
Penyetuju cuti unit berubah: 2 unit          [lihat]
Atasan belum bisa ditentukan: 0
Jabatan kosong: 3 (2 naik ke atas, 1 dengan Plt)
Hanya tampilan: 1 perubahan (tidak memengaruhi persetujuan)
Belum punya unit: 0
Aturan lain yang terkena: Direktur (lembur tidak berlaku) — jabatan tetap aktif ✓

ⓘ Pengajuan yang sudah dikirim tidak berubah.
ⓘ Persetujuan saat ini memakai data atasan lama; terbit tidak mengubah itu.

[Kembali ubah]                                          [Terbitkan berlaku 1 Jan 2027]
```

- Masalah ditulis sebagai kalimat dengan nama item dan tombol **Buka** (§7); **Terbitkan** nonaktif selama ada masalah.
- **Kembali ubah** pada status Siap diterbitkan mengembalikan ke Sedang disusun (perlu periksa ulang).
- Bila struktur dasar sudah berubah sejak perubahan ini dibuat (ada terbitan lain): "Struktur sudah diubah oleh 'Koreksi Oktober' (terbit 20 Okt). [Perbarui perubahan ini dari struktur terbaru]" — **Terbitkan** ditolak sampai diperbarui (§5.2).
- **Buang perubahan** (konfirmasi, alasan opsional): status Dibuang, tetap tercatat di riwayat dan audit.
- Setelah terbit: "Struktur terbit, berlaku 1 Jan 2027. Persetujuan masih memakai data atasan lama." Tidak ada `window.confirm`; konfirmasi memakai dialog dengan ringkasan dampak.

### 4.8 Kegagalan, empty, forbidden, mobile, lambat

| Kondisi | Layar |
|---|---|
| Belum ada struktur | Kesiapan: "Belum ada struktur" + dua pilihan mulai (O-3). |
| Unit tanpa anggota / jabatan | Panel: "Belum ada anggota. [Tempatkan pegawai]". |
| Gagal memuat daftar pegawai | Error eksplisit "Daftar pegawai tidak dapat dimuat. [Coba lagi]" — bukan daftar kosong. |
| Tanpa permission aksi | Tombol tidak tampil; bila dipaksa → "Anda tidak punya izin untuk {aksi}. Hubungi {peran yang berwenang menurut O-1}." |
| Jabatan read-only (dipegang akun Dewan / penanda jabatan utama lama) | Badge "Belum bisa diubah di sini" + alasan + langkah penyelesaian (ORG-008-4 alur jabatan utama; akun Dewan menunggu keputusan pemetaan). |
| Konflik simpan (perubahan diubah orang lain) | "Perubahan ini baru saja diubah Siti. [Muat ulang]" — tidak menimpa diam-diam (§5.2). |
| HP < 768px | Kesiapan, Pegawai, Plt, Cek persetujuan sebagai kartu; Bagan sebagai daftar bertingkat; Perubahan hanya baca + "Buka di laptop untuk mengubah". |
| Lambat | Indikator per panel; "Periksa & lihat dampak" menampilkan progres. Target DRAFT: aksi edit < 1 dtk, periksa dampak < 10 dtk untuk 500 pegawai di Mi8VPS; diukur di UAT sintetis ORG-008-2. |

## 5. Perilaku backend

### 5.1 Read model baru (read-only)

- `GET /admin/organization/people?asOf&draftId&nodeKey&issue&q&page` — per pegawai aktif: unit, jabatan, atasan langsung terhitung, sumber (`MEMBERSHIP_LEADER | INHERITED_LEADER | POSITION_PARENT | OVERRIDE | ACTING | VACANCY_CLIMB`), penyetuju cuti unit, masalah (kode resolver), serta — bila diminta — hasil data lama (ORG-002). Menghitung dengan resolver ORG-004 yang sama; tidak menulis apa pun.
- `GET /admin/organization/readiness?asOf&draftId` — hitungan §4.2. Termasuk pegawai aktif yang **bukan anggota unit mana pun** (memperbaiki P-3).
- `GET /admin/organization/explanation?employeeId&asOf&draftId` — langkah penjelasan terstruktur (kode + parameter); kalimat dibuat di web.
- `POST /admin/organization/resolution-preview` (tanpa wajib draft) — `{ employeeId, workflow: LEAVE_ANNUAL | LEAVE_UNPAID | OVERTIME, date, source: CURRENT | draftId }`; mengisi `oversight` dan `warnings` yang sekarang selalu kosong. Endpoint lama `/drafts/:id/resolution-preview` tetap sebagai alias satu rilis.
- `GET /admin/organization/designer/employees?q&status=active&page` — pencarian dan paging; default hanya aktif.
- `GET /admin/organization/capabilities` — daftar aksi yang diizinkan untuk user saat ini (gating tombol).
- `GET /admin/organization/rollout` diperluas: daftar setting per workflow/node yang efektif hari ini (bukan hanya baris terakhir).

Read model menghitung per pegawai secara batch (satu snapshot dimuat sekali). Batas: paging 50; laporan perbandingan per unit atau seluruh yayasan dengan batas DRAFT 1.000 pegawai per permintaan.

### 5.2 Siklus perubahan (draft)

- `GET /admin/organization/designer/drafts?status` — daftar perubahan.
- `POST /drafts/:id/reopen` — `VALIDATED → DRAFT`, menghapus laporan validasi; audit `organization.draft.reopened`.
- `POST /drafts/:id/discard` — status baru `DISCARDED` (migration: perluas CHECK status); catatan tetap ada; audit `organization.draft.discarded`.
- **Penjaga dasar usang:** `publish` menolak `409 ORGANIZATION_DRAFT_BASE_STALE` bila ada terbitan lain yang `published_at` lebih baru dari `created_at` draft **dan** efektif ≤ `effective_on` draft (sehingga draft tidak memuatnya), atau bila draft berlaku lebih awal dari terbitan terjadwal yang dibuat dari dasar lama (draft terjadwal itu kemudian ditandai usang di layar Kesiapan). Aturan persis = DRAFT, difinalkan dengan test property di ORG-008-3.
- `POST /drafts/:id/rebase` — membuat ulang isi draft dari struktur terbaru lalu menerapkan ulang daftar perubahan draft (dari jurnal perubahan, §5.3); konflik ditampilkan per baris, tidak diselesaikan diam-diam.
- **Konkurensi edit:** setiap mutasi draft membawa `If-Match: <draft revision>`; revisi naik per mutasi; mismatch → `409 ORGANIZATION_DRAFT_CHANGED`.
- Satu perubahan terbuka (DRAFT/VALIDATED) sekaligus untuk seluruh organisasi (O-7, diterima); pembuatan kedua → `409 ORGANIZATION_DRAFT_ALREADY_OPEN` dengan tautan.

### 5.3 Perintah gabungan dan koreksi

- `POST /drafts/:id/commands` dengan `type`: `ADD_UNIT`, `PLACE_EMPLOYEES` (tambah/pindah, bukan ganti seluruh daftar), `APPOINT_ACTING` (alasan wajib, disimpan ke `reason` incumbency — memperbaiki alasan tetap "Explicit acting mandate"), `SET_REPORTS_TO`, `SET_UNIT_LEADER`, `SET_UNIT_APPROVER`, `SET_OVERRIDE`. Satu transaksi; audit per primitif + `organization.command.applied` (tipe, jumlah item; tanpa data pribadi berlebih).
- Jurnal perubahan draft: tabel `organization_change_set_journal` (id, change_set_id, seq, command type, payload ringkas, actor, created_at) — sumber daftar "Yang berubah", **batalkan per baris**, dan rebase. DRAFT: bila jurnal terlalu mahal untuk v1, "Yang berubah" dihitung dari diff draft vs dasar (tanpa batalkan per baris).
- `DELETE /drafts/:id/authority-bindings/:bindingId`, `PATCH …/:bindingId` (akhiri) — hanya di draft (memperbaiki W-1). Hapus node/posisi/binding hanya untuk item yang `stableKey`-nya belum pernah terbit; item terbit hanya bisa dinonaktifkan/diakhiri.
- Nonaktif unit/jabatan ditolak `409 ORGANIZATION_ITEM_IN_USE` bila masih punya anggota/pejabat/Plt aktif atau menjadi target binding aktif; respons menyertakan daftar.
- Konflik anggota diperiksa saat `PLACE_EMPLOYEES` (bukan baru saat validasi): pegawai yang sudah anggota utama unit lain → harus `move: true`.
- Alur **jabatan utama** untuk pegawai yang memegang dua jabatan (`is_primary_structural`): perintah `SET_PRIMARY_STRUCTURAL_POSITION` menggantikan blokir `PRIMARY_STRUCTURAL_EDIT_REQUIRES_REVIEW` (review tambahan; menyentuh data production hasil migrasi 0020–0023). Jabatan akun Dewan tetap read-only.

### 5.4 Keterkaitan ATT-011

- **Unit HC (D-11):** tambah kolom nullable `organization_nodes.legacy_unit_id → organizational_units(id)` (O-9) agar "unit pegawai atau unit induknya" dapat dihitung dari struktur bertingkat, sementara scope role tetap menunjuk `organizational_units`. Panel unit menampilkan staf HC yang scope-nya cocok (read-only, link ke Akses). Tanpa tautan: notifikasi ATT-011 mengikuti fallback organisasi (sudah DRAFT di ATT-011 §7.4).
- **Direktur (D-10):** aturan tetap dikelola di **Pengaturan → Aturan lembur** (ATT-011) dengan pemilih jabatan ORG-008 (cari jabatan dengan jalur unit). ORG-008 hanya menampilkan "aturan yang memakai jabatan ini" dan memperingatkan saat jabatan tersebut dinonaktifkan/dipindah di perubahan (O-8).
- **Atasan lembur (D-5):** Cek persetujuan memakai resolver yang sama dengan ATT-011-6b; tidak ada resolver kedua di ORG-008.

## 6. State dan transisi perubahan

```text
            buat                 periksa (lulus)              terbitkan
(none) ───────────► Sedang disusun ─────────────► Siap diterbitkan ─────────► Terjadwal ──(tanggal tiba)──► Berlaku ──► Riwayat
                      ▲     │  ▲                        │
                      │     │  └──── kembali ubah ──────┘
                      │     └── buang ──► Dibuang
                      └── perbarui dari struktur terbaru (dasar usang)
```

| Transisi | Actor (O-1) | Audit |
|---|---|---|
| buat | HC Admin | `organization.draft.created` (ada) |
| ubah (perintah/primitif) | HC Admin (termasuk pejabat, Plt, kewenangan) | event primitif (ada) + `organization.command.applied` |
| periksa | HC Admin | `organization.draft.validated` (ada) |
| kembali ubah | HC Admin | `organization.draft.reopened` (baru) |
| buang | HC Admin | `organization.draft.discarded` (baru) |
| perbarui dari terbaru | HC Admin | `organization.draft.rebased` (baru) |
| terbitkan | pemegang `approvals.policy.manage` (Kepala HC/owner) | `organization.draft.published` (ada) |

## 7. Pesan masalah (pengganti kode)

| Kode | Pesan operator |
|---|---|
| `PRIMARY_MEMBERSHIP_OVERLAP` | "{Pegawai} tercatat di dua unit ({A}, {B}). Pilih satu." |
| `PRIMARY_INCUMBENCY_OVERLAP` | "Jabatan {J} punya dua pejabat pada periode yang sama." |
| `AUTHORITY_BINDING_OVERLAP` | "Unit {U} punya dua pemimpin/penyetuju untuk periode yang sama. Hapus salah satu." |
| `STRUCTURAL_NODE_CYCLE` / `SUPERVISORY_POSITION_CYCLE` / `AUTHORITY_LOOP` | "Hubungan melapor berputar: {A} → {B} → {A}." |
| `INACTIVE_INCUMBENT` | "{Pegawai} sudah tidak aktif tetapi masih menjabat {J}." |
| `INVALID_*_PARENT` / `INVALID_*_REFERENCE` | "{Item} menunjuk ke unit/jabatan yang sudah tidak ada." |
| `AUTHORITY_NOT_CONFIGURED` (leader) | "Unit {U} dan unit di atasnya belum punya pemimpin." |
| `MEMBERSHIP_NOT_CONFIGURED` | "{Pegawai} belum punya unit." |
| `AMBIGUOUS_MEMBERSHIP` | "{Pegawai} anggota lebih dari satu unit." |
| `AUTHORITY_VACANT` | "Jabatan {J} kosong dan aturannya menahan pengajuan." |
| `ACTING_AUTHORITY_REQUIRED` | "Jabatan {J} kosong dan wajib Plt." |
| `AUTHORITY_INELIGIBLE` | "{Pegawai} menjadi atasan tetapi belum punya akun HCIS aktif / izin menyetujui." |
| `AUTHORITY_SELF_RESOLUTION` | "{Pegawai} akan menjadi atasan dirinya sendiri. Periksa 'Melapor ke' jabatan {J}." |
| `AUTHORITY_TRAVERSAL_LIMIT` | "Rantai atasan terlalu panjang; periksa hubungan melapor." |
| `ORGANIZATION_DRAFT_BASE_STALE` | "Struktur sudah diubah oleh '{nama}'. Perbarui perubahan ini dulu." |
| `ORGANIZATION_DRAFT_CHANGED` | "Perubahan ini baru saja diubah {nama}. Muat ulang." |
| `PRIMARY_STRUCTURAL_EDIT_REQUIRES_REVIEW` | "Pejabat ini memegang lebih dari satu jabatan. Tentukan jabatan utamanya dulu." |
| `ACCOUNT_HELD_POSITION_EDIT_REQUIRES_REVIEW` | "Jabatan ini dipegang akun Dewan dan belum bisa diubah di sini." |

API mengembalikan `code` + `details` (nama/ID item); web menyusun kalimat. Pesan Inggris API tetap untuk log/diagnostik.

## 8. Ringkasan permission

| Aksi | Hari ini | Keputusan O-1 (2026-10-16) |
|---|---|---|
| Lihat semua tab | `organization.manage` | sama |
| Susun unit/jabatan/anggota, periksa, buang | `organization.manage` | sama |
| Pejabat, Plt, atasan khusus, kewenangan (di dalam perubahan yang belum terbit) | `approvals.policy.manage` | `organization.manage` (ORG-008-8) — aman karena tidak ada yang berlaku sebelum diterbitkan |
| Terbitkan | `approvals.policy.manage` | tetap `approvals.policy.manage`, dipegang Kepala HC/owner ("empat mata") |
| Ubah rollout | `approvals.policy.manage` | tidak ada UI di ORG-008 |

Setiap endpoint baru masuk manifest AUTH-011 (`AUTH-011-admin-route-permissions.json`) dengan test cakupan rute (PR #107).

## 9. Paket implementasi

Setiap paket = satu PR, dapat di-merge dan dirilis sendiri melalui OPS-MI8-REL-001 dengan persetujuan owner.

| Paket | Isi | API/kontrak | Migration + rollback | Test minimum |
|---|---|---|---|---|
| **ORG-008-1** Bahasa, banner, gating | Kamus §3; banner mode §4.1 (pakai `GET /rollout` yang ada); pesan §7 dari `code` yang ada; tombol tersembunyi sesuai permission (sementara: cek respons 403 + daftar permission sesi); pencarian pegawai **di sisi klien** pada daftar yang ada, sembunyikan nonaktif; konfirmasi untuk Kosongkan/Hapus Plt; draft tetap terbuka saat tanggal diganti (perbaiki D-1 sebagian); empty/error state. **UAT sintetis** walkthrough §3 gap analysis untuk mengonfirmasi temuan *(UAT)*. | Tidak berubah. | Tidak ada. Rollback = rilis sebelumnya. | Label (tidak ada enum/kode mentah di layar utama); tombol tidak tampil tanpa permission; banner menampilkan LEGACY saat tidak ada baris rollout; pemetaan setiap kode §7; mobile smoke; typecheck/lint/build. |
| **ORG-008-2** Pegawai, Kesiapan, Cek persetujuan (read-only) | §4.2, §4.4, §4.5 (lihat saja), §4.6 termasuk laporan perbandingan; dampak dengan nama. | Baru: `GET /people`, `GET /readiness`, `GET /explanation`, `POST /resolution-preview` (tanpa draft), `GET /designer/employees?q&page`, `GET /capabilities`; `GET /rollout` diperluas. OpenAPI. | Tidak ada. Rollback = rilis sebelumnya. | Pegawai tanpa unit terhitung; pewarisan leader diberi sumber `INHERITED_LEADER`; Plt dan naik-saat-kosong terjelaskan; perbandingan data lama tidak menulis apa pun dan tidak mengubah rollout; oversight terisi; 403 per endpoint + manifest AUTH-011; tidak ada data sensitif (NIK, alamat) di respons; performa 500 pegawai sintetis (DRAFT target §4.8). |
| **ORG-008-3** Siklus perubahan aman | §5.2: daftar, lanjutkan, kembali ubah, buang, penjaga dasar usang, rebase, revisi `If-Match`, satu perubahan terbuka (O-7). Layar Perubahan + "Periksa & lihat dampak" gabungan. | Baru: `GET /drafts`, `POST /drafts/:id/reopen`, `/discard`, `/rebase`; `publish` → `409 ORGANIZATION_DRAFT_BASE_STALE`; mutasi → `409 ORGANIZATION_DRAFT_CHANGED`. OpenAPI. | Perluas CHECK `organization_change_sets.status` dengan `DISCARDED`; kolom `revision int NOT NULL DEFAULT 0`. Rollback: rilis lama mengabaikan kolom; baris `DISCARDED` tidak pernah dipilih rilis lama karena hanya `PUBLISHED` yang dimuat sebagai struktur berlaku — verifikasi bahwa rilis lama tidak gagal membaca status asing (DRAFT, test). Data terbit tidak berubah. | Dua draft dari dasar sama → terbit kedua ditolak; draft 2027 lalu koreksi besok → draft 2027 ditandai usang dan tidak bisa terbit sebelum rebase; reopen menghapus status siap; buang tidak menghapus riwayat; revisi konflik 409; snapshot terbit tidak berubah; audit tercatat. **Review tambahan: migration + publish.** |
| **ORG-008-4** Perintah gabungan dan koreksi | §5.3: Tambah unit, Tempatkan/pindahkan, Tunjuk Plt beralasan, Melapor ke, pemimpin/penyetuju unit, atasan khusus (UI baru untuk API yang ada), hapus/akhiri binding di draft, nonaktif dengan cek pemakaian, jurnal "Yang berubah", alur jabatan utama. | Baru: `POST /drafts/:id/commands`, `DELETE/PATCH /drafts/:id/authority-bindings/:id`, `DELETE /drafts/:id/{nodes,positions}/:id` (hanya item belum terbit). Endpoint primitif lama tetap. OpenAPI. | Tabel `organization_change_set_journal` (additive). Rollback: rilis lama mengabaikan jurnal; isi draft tetap konsisten karena perintah menulis catatan primitif biasa. | Perintah atomik (gagal di tengah = nol perubahan); audit per primitif; pindah anggota tanpa overlap; Plt tanpa alasan → 400; hapus item terbit → 409; nonaktif dipakai → 409 dengan daftar; binding ganda tidak bisa dibuat via perintah; resolver menghasilkan atasan yang sama dengan preview (property test); permission per perintah (O-1). **Review tambahan: authority/permission.** |
| **ORG-008-5** Pengaturan lanjutan | Penyetuju khusus & diberi tahu sebagai kalimat; tampilan rank dipindah ke "Tampilan"; bagan cari/fokus/ciutkan; daftar bertingkat mobile. | Memakai ORG-008-4. | Tidak ada. | Aturan Direktur → Sekretaris, Ketua diberi tahu tersusun dari kalimat dan lolos Cek persetujuan (sintetis, dengan akun Dewan tetap read-only); rank tidak mengubah dampak routing; mobile. |
| **ORG-008-6** Tautan ATT-011 | §5.4: `legacy_unit_id` pada node + layar tautan unit; panel "Staf HC unit ini"; pemilih jabatan untuk aturan lembur ATT-011 (dipakai ATT-011-6b); peringatan restrukturisasi saat jabatan bertanda aturan berubah. | `PATCH /drafts/:id/nodes/:id` menerima `legacyUnitId`; `GET /admin/organization/positions/search?q&asOf`. OpenAPI. | Kolom nullable `organization_nodes.legacy_unit_id` (FK, ikut di-clone ke draft). Rollback: kolom diabaikan; ATT-011 kembali ke fallback organisasi untuk notifikasi (dicatat di release note). | Unit induk dihitung dari struktur; scope unit HC cocok; tanpa tautan → fallback; aturan Direktur tetap menunjuk stable key setelah restrukturisasi; peringatan nonaktif. **Review tambahan: migration + notifikasi.** |
| **ORG-008-8** Izin penyusunan (O-1) | HC Admin dapat menyusun seluruh isi perubahan; **Terbitkan** tetap untuk pemegang `approvals.policy.manage`. Layar menampilkan "Siap diterbitkan — menunggu Kepala HC" untuk HC Admin. | Endpoint `PUT /drafts/:id/incumbencies`, `POST /drafts/:id/authority-bindings`, `POST /drafts/:id/reporting-overrides` (dan perintah ORG-008-4 yang setara) mewajibkan `organization.manage`; `POST /drafts/:id/publish` dan `PATCH /rollout` tetap `approvals.policy.manage`. Manifest AUTH-011 + OpenAPI diperbarui. | Tidak ada migration. Rollback: rilis lama kembali mewajibkan `approvals.policy.manage` untuk penyusunan (HC Admin kembali terkena 403; tidak ada data berubah). | HC Admin: susun pejabat/Plt/kewenangan → 2xx, terbitkan → 403; pemegang `approvals.policy.manage`: terbitkan → 2xx; tanpa `organization.manage` → 403 di semua; HC Operator 403; grant ber-scope unit tidak memberi akses organisasi; rollout tetap 403 untuk HC Admin; tes cakupan rute AUTH-011 lulus. **Review tambahan: permission.** |
| **ORG-008-7** Usulan awal dari data lama (O-3 diterima) | "Mulai dari data yang sudah ada": membuat perubahan **Sedang disusun** dari `organizational_units` (unit), Unit Approver ORG-002 (jabatan penyetuju unit), dan `direct_manager_employee_id` (atasan khusus atau pemimpin unit bila semua anggota unit punya atasan yang sama). Tidak memakai teks jabatan. Semua hasil ditandai "usulan — tinjau". | `POST /drafts/from-legacy`. | Tidak ada (menulis draft biasa). Rollback: buang draft. | Tidak ada inferensi dari teks jabatan; hasil Cek persetujuan draft = data lama untuk ≥ semua pegawai yang data lamanya lengkap (dibuktikan laporan perbandingan); tidak menyentuh rollout; audit. |

Area dengan review tambahan (AGENTS.md §8): ORG-008-3 (migration + publish), ORG-008-4 (authority/permission), ORG-008-6 (migration + notifikasi), ORG-008-8 (permission).

Urutan: **ORG-008-1 → ORG-008-8 → ORG-008-2 → ORG-008-3 → ORG-008-4 → (ORG-008-6 ∥ ORG-008-5) → ORG-008-7**. ORG-008-8 maju karena tanpa itu HC Admin tidak dapat mengisi pejabat/Plt sama sekali. Sebelum ATT-011-6b dirilis, minimal ORG-008-2 (agar HC tahu siapa yang akan gagal mengajukan lembur) dan ORG-008-6 (notifikasi HC per unit) harus sudah ada. ORG-008-3 sebaiknya mendahului pengisian struktur YSQ yang sebenarnya karena memperbaiki risiko perubahan hilang (gap D-2).

## 10. Keputusan owner

Dicatat 2026-10-16. Kata owner: "Setuju semua rekomendasi O-1 sampai O-10. Untuk O-11 (unit pilot) saya tentukan nanti."

| ID | Pertanyaan | Pilihan | Keputusan |
|---|---|---|---|
| O-1 | Siapa boleh mengubah bagian kewenangan (pejabat, Plt, pemimpin unit, atasan khusus) dan siapa boleh **Terbitkan**? Hari ini HC Admin tidak bisa sama sekali. | (a) HC Admin boleh semuanya; (b) HC Admin menyusun semuanya, **Terbitkan** oleh pemegang izin approval (Kepala HC/owner); (c) izin baru khusus kewenangan. | **Diterima (rekomendasi):** **(b)** — HC bekerja lancar, tetap ada pemeriksa kedua sebelum berlaku. |
| O-2 | Selama masih `LEGACY`, di mana HC mengatur atasan? | (a) tetap tiga tempat lama; (b) struktur menjadi tempat utama, data lama ditampilkan berdampingan untuk dibandingkan, lalu dikunci saat `STRUCTURE` aktif per unit. | **Diterima (rekomendasi):** **(b)**. |
| O-3 | Boleh membuat **usulan awal** struktur dari data atasan/Unit Approver yang sudah ada (bukan dari judul jabatan), untuk ditinjau HC? | Ya / Tidak (mulai dari kosong). | **Diterima (rekomendasi):** **Ya** — menghemat pengetikan ulang ratusan pegawai. |
| O-4 | Penempatan pegawai ke unit/jabatan dilakukan di mana: Struktur Organisasi atau administrasi kepegawaian EMP-006 (PR #102)? | (a) Struktur sekarang, EMP-006 nanti menulis ke catatan yang sama; (b) hanya EMP-006. | **Diterima (rekomendasi):** **(a)** — satu catatan ORG-004, dua pintu masuk yang konsisten; diselaraskan di EMP-006. |
| O-5 | Plt: alasan wajib? nomor surat tugas? | Alasan wajib + nomor surat opsional (teks, tanpa upload) / keduanya wajib. | **Diterima (rekomendasi):** **Alasan wajib, nomor surat opsional**. |
| O-6 | Bila jabatan pimpinan unit kosong tanpa Plt, default pengajuan: naik ke atasan berikutnya atau ditahan? | Naik / Wajib Plt / Ditahan. | **Diterima (rekomendasi):** **Naik ke atasan berikutnya** untuk pimpinan unit; "wajib Plt" hanya untuk jabatan yang owner tetapkan. |
| O-7 | Boleh lebih dari satu perubahan disusun bersamaan? | Satu untuk seluruh yayasan / banyak dengan penjaga dasar usang. | **Diterima (rekomendasi):** **Satu** — paling sederhana; penjaga dasar usang tetap dipasang. |
| O-8 | Jabatan Direktur untuk aturan "lembur tidak berlaku" (ATT-011 D-10) ditandai di mana? | Dipilih di Pengaturan → Aturan lembur / ditandai di struktur. | **Diterima (rekomendasi):** **Aturan lembur** memilih jabatan; struktur hanya menampilkan dan memperingatkan. |
| O-9 | Unit di struktur dihubungkan dengan "unit" lama (dipakai scope staf HC) agar notifikasi lembur tepat sasaran (D-11)? | Tautkan setiap unit struktur ke unit lama / pindahkan scope role ke unit struktur (lebih besar). | **Diterima (rekomendasi):** **Tautkan** dulu. |
| O-10 | Mengubah struktur dari HP? | Hanya lihat di HP / boleh ubah. | **Diterima (rekomendasi):** **Hanya lihat** (sejalan dengan ATT-011 D-8). |
| O-11 | Unit pilot pertama untuk uji banding dan aktivasi. | — | **Terbuka** — owner menentukan kemudian; saran: unit kecil dengan atasan lengkap (tetap pending di `org004-pilot-unit-validation.md`). |

Konsekuensi keputusan untuk implementasi:

- **O-1** → paket ORG-008-8 (§8, §9); Terbitkan tetap pemeriksa kedua. Penugasan izin `approvals.policy.manage` ke akun Kepala HC adalah tindakan akses operasional terpisah dengan persetujuan owner, bukan bagian PR kode.
- **O-2** → tab Pegawai dan Cek persetujuan menampilkan data lama berdampingan (ORG-008-2). Saat `STRUCTURE` diaktifkan untuk satu unit, isian atasan langsung di Detail Pegawai dan Unit Approver di Konfigurasi Cuti untuk unit itu menjadi read-only dengan tautan ke Struktur Organisasi — paket lanjutan yang dirilis bersama/setelah aktivasi, bukan sebelum.
- **O-3** → ORG-008-7 masuk rencana (tanpa inferensi dari teks jabatan).
- **O-4** → penempatan dilakukan di Struktur Organisasi; EMP-006 (PR #102) wajib menulis ke catatan keanggotaan/penjabat ORG-004 yang sama, bukan salinan terpisah (diselaraskan di spesifikasi EMP-006).
- **O-5** → `APPOINT_ACTING` mewajibkan alasan; nomor surat tugas opsional (teks, tanpa upload).
- **O-6** → wizard Tambah unit / Tambah jabatan memakai default "Bila kosong: naik ke atasan berikutnya"; "wajib Plt" hanya dipilih eksplisit untuk jabatan yang owner tetapkan.
- **O-7** → satu perubahan terbuka untuk seluruh yayasan + penjaga dasar usang (ORG-008-3).
- **O-8** → jabatan Direktur dipilih di Pengaturan → Aturan lembur (ATT-011-6b) dengan pencarian jabatan ORG-008-6.
- **O-9** → kolom `legacy_unit_id` (ORG-008-6); scope role HC tetap pada unit lama.
- **O-10** → edit hanya di laptop/tablet; HP untuk melihat.
- **O-11** → tetap terbuka; tidak menghambat paket ORG-008 mana pun, tetapi menghambat uji banding/aktivasi.

Asumsi DRAFT yang belum diverifikasi: jumlah jabatan production dengan penanda jabatan utama lama atau dipegang akun Dewan (cek read-only Mi8VPS, tanpa data pribadi di repository); target waktu §4.8 di Mi8VPS; capability approver lembur (ATT-011-6b); aturan persis penjaga dasar usang (§5.2); kelayakan jurnal perubahan v1.

## 11. Acceptance (setelah ACCEPTED, per paket)

- ORG-008-A: HC melihat setiap pegawai aktif dengan unit, jabatan, dan atasan langsung beserta alasan dalam kalimat, untuk tanggal berlaku, terjadwal, atau perubahan terbuka.
- ORG-008-B: Pegawai tanpa unit dan pegawai yang atasannya belum bisa ditentukan terlihat di Kesiapan sebelum aktivasi apa pun.
- ORG-008-C: HC mendaftarkan satu unit dengan pemimpin, pejabat, dan penyetuju cuti dalam satu wizard.
- ORG-008-D: HC menempatkan/memindahkan pegawai dengan pencarian; konflik dua unit dicegah saat itu juga.
- ORG-008-E: HC menunjuk, memperpanjang, dan mengakhiri Plt dengan alasan dan melihat dampaknya sebelum menyimpan.
- ORG-008-F: HC mengecek siapa menyetujui cuti dan lembur seorang pegawai serta siapa diberi tahu, tanpa membuat perubahan.
- ORG-008-G: HC membandingkan data atasan lama dan struktur untuk satu unit tanpa mengubah mode rollout.
- ORG-008-H: Perubahan yang sedang disusun dapat ditemukan kembali, dikembalikan ke penyusunan setelah diperiksa, dan dibuang.
- ORG-008-I: Terbitan tidak dapat menghapus diam-diam terbitan lain (penjaga dasar usang).
- ORG-008-J: Tidak ada kode, enum Inggris, atau UUID di layar utama; tombol hanya tampil bila diizinkan.
- ORG-008-K: Banner selalu menyatakan dengan benar apakah persetujuan memakai data lama atau struktur.
- ORG-008-L: Invariant I-1..I-10 tetap terbukti oleh test yang ada dan test paket; snapshot approval yang sudah ada tidak berubah.
- ORG-008-M: Typecheck, lint, test, build, clean migration lulus di CI; UAT sintetis di environment nyata sebelum rilis; tidak ada data pegawai nyata di test/screenshot.
