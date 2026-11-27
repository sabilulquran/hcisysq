# Pilot Cuti Tahunan General Affair — pemetaan, peserta per peran, dan urutan pelaksanaan

**Spec ID:** OPS-PILOT-GA-001 (menggantikan rencana aktif OPS-PILOT-TT-001)
**Status:** ACTIVE — rencana pilot yang berlaku sejak 2026-11-27. Belum ada satu langkah pun yang
dijalankan di production.
**Tanggal:** 2026-11-27
**Sumber angka production:** pembacaan baca-saja `ssh mi8vps-root` terhadap `sqcore_hcis` pada
2026-11-27, bagan terbit yang berlaku sejak 2026-11-10, rilis `hcis-6694a49e-20261126`.

Dokumen ini memakai **label peran**. Nama, penetapan per orang, kelompok hak cuti per pegawai, dan
rincian per anggota unit tidak dicatat di repository; daftar itu dipegang HCM.

---

## 1. Keputusan HCM 2026-11-27

| Keputusan | Akibat |
| --- | --- |
| Unit pilot Cuti Tahunan berpindah dari Taman Tahfizh ke **General Affair** | Rencana OPS-PILOT-TT-001 dan runbook-nya menjadi riwayat; mekanismenya (undangan, bagan terbit, Setujui/Tolak, pemberitahuan) dipakai ulang di sini |
| HCM menetapkan **dua peserta**, keduanya kelompok **Non-pendidikan** | **Peserta A** adalah pimpinan unit General Affair. **Peserta B** adalah anggota unit yang rantainya melewati dua penyetuju |
| Ukuran keberhasilan tetap **jalan A** | Dua pengajuan selesai diputuskan, dari dua peserta |

Kelompok Peserta A sudah tercatat `non_education` di production. Kelompok Peserta B **belum
tercatat** di production (pembacaan 2026-11-27). Pencatatannya adalah langkah HC (§6, G1). Sampai
saat itu, pengajuan Peserta B dijawab `409 UNSUPPORTED_ENTITLEMENT_GROUP`.

## 2. General Affair pada bagan terbit

```text
Dewan Pengurus
└── Direksi                  ← kursi Direktur (berpejabat)
    └── Bidang Operasional   ← kursi Kepala Bidang: KOSONG
        ├── General Affair   ← kursi Kepala GA (berpejabat)
        │   ├── tiga sub-node; dua tanpa ikatan sendiri
        │   └── satu sub-node dengan pimpinan sendiri (beserta anak node-nya)
        └── unit tetangga (di luar pilot)
```

| Ikatan | Kursi sasaran | Keadaan | Kebijakan kekosongan |
| --- | --- | --- | --- |
| General Affair · `LEADER` | Kepala GA | berpejabat, akun `invited` | `CLIMB_TO_PARENT` |
| General Affair · `UNIT_APPROVER` | Kepala Bidang Operasional | **kosong** | `CLIMB_TO_PARENT` → kursi induk, **Direktur** |
| Sub-node berpimpinan · `LEADER` | pimpinan sub-node | berpejabat, **belum berakun** | `CLIMB_TO_PARENT` |
| Sub-node berpimpinan · `UNIT_APPROVER` | Kepala GA | berpejabat, akun `invited` | `CLIMB_TO_PARENT` |
| Direksi · `LEADER` | Direktur | berpejabat, akun `invited` | `CLIMB_TO_PARENT` |

Kolom atasan lama (`direct_manager_employee_id`) kosong untuk seluruh anggota unit. Di mode
`LEGACY`, setiap pengajuan mereka dijawab `DIRECT_MANAGER_MISSING`. Pilot memakai **bagan terbit
sebagai satu-satunya sumber atasan**; kolom lama tidak diisi.

### 2.1 Rantai di bawah `STRUCTURE`

| Pemohon | Rantai |
| --- | --- |
| Anggota sub-node tanpa ikatan sendiri (Peserta B) | **Kepala GA → Direktur**. Kursi penyetuju unit yang kosong mendaki ke Direktur |
| Kepala GA (Peserta A) | **Direktur**. Langkah dirinya sendiri dibuang, dan penyetuju unit yang kosong mendaki ke Direktur |
| Anggota sub-node berpimpinan | Berhenti di `409 APPROVER_ACCOUNT_NOT_READY` di kursi pimpinan sub-node yang belum berakun. ORG-004 D-R5 tidak melompatinya |
| Unit lain, termasuk unit tetangga | Tetap `LEGACY`. Baris rollout pada node General Affair hanya menjangkau subtree-nya |

Kondisi aktual (kursi, pejabat, status akun, ikatan) berasal dari **pembacaan baca-saja**
production 2026-11-27. Rantai dan skenario HTTP-nya dibuktikan di **database uji sintetis dengan
topologi yang sama** (§4). Pilot ini tidak memakai uji kering yang menulis ke production, termasuk
yang dibungkus ROLLBACK: pembuktian di production hanya lewat pembacaan baca-saja dan, kelak,
pengajuan nyata oleh pemegang akun.

**Dua pimpinan berbeda unit.** Rantai pilot melewati Kepala GA dan Direktur, karena kursi Kepala
Bidang Operasional kosong. **Bila kursi itu diisi sebelum atau selama pilot**, penyetuju unit
berpindah ke pejabat baru, dan pratinjau pengajuan harus dibaca ulang sebelum pengajuan pertama.

## 3. Ringkasan anggota dan kesiapan

| Yang diukur (2026-11-27) | Hasil |
| --- | --- |
| Anggota aktif di subtree General Affair | 12 |
| Kelompok hak cuti tercatat `non_education` | 1 (Peserta A) |
| Punya email dan akun `invited` | 8 |
| Tanpa email dan tanpa akun | 4, termasuk pimpinan sub-node berpimpinan |
| Masa kerja kurang dari 12 bulan | 3 |
| Penyetuju pilot (Kepala GA, Direktur) | keduanya berpejabat, email ada, akun `invited` |

Hak Cuti Tahunan individual hanya ada bila kelompok hak cuti tercatat `non_education`. Unit, node,
atau jabatan tidak membuktikan hak itu. Penetapan kelompok adalah keputusan HCM/HC.

**Isolasi.** Satu baris rollout pada node General Affair menjangkau seluruh subtree, termasuk
sub-node berpimpinan. Anggota sub-node itu bukan peserta, dan pengajuan mereka berhenti tertutup
(`409`) baik di `LEGACY` maupun `STRUCTURE`, jadi tidak ada perilaku yang memburuk. Unit di luar
subtree tidak terpengaruh.

## 4. Bukti otomatis

`apps/api/test/ops-pilot-ga-001-flow.postgres.test.ts` memakai bagan sintetis berbentuk sama
dengan §2. Semua data sintetis, dalam satu transaksi yang selalu di-ROLLBACK. Yang diuji:

1. Tanpa baris rollout, pengajuan dijawab `DIRECT_MANAGER_MISSING`. Dengan baris rollout tetapi
   Kepala GA masih `invited`, dijawab `APPROVER_ACCOUNT_NOT_READY`.
2. Anggota sub-node tanpa ikatan sendiri mendapat rantai Kepala GA → Direktur, karena kursi
   penyetuju unit yang kosong mendaki.
3. Kepala GA sebagai pemohon diputuskan Direktur saja.
4. Anggota di bawah sub-node berpimpinan yang pimpinannya belum berakun berhenti di
   `APPROVER_ACCOUNT_NOT_READY`.
5. Unit tetangga tetap `LEGACY`.
6. Skenario dua peserta, berurutan:
   - baris rollout ditulis lewat route admin;
   - undangan dan aktivasi untuk Direktur, Kepala GA, dan Peserta B;
   - pengajuan Peserta B dijawab `409` sebelum kelompoknya ditetapkan;
   - Peserta B: Setujui dua langkah;
   - Peserta B: Tolak di langkah pertama, tanpa sampai ke Direktur;
   - Peserta A: Setujui oleh Direktur;
   - tiga pemberitahuan hasil;
   - **Akhiri**, dengan audit `organization.rollout.changed` dan `organization.rollout.ended`.

Uji ini dijalankan CI. Sesi agen 2026-11-27 tidak dapat menjalankannya secara lokal, karena
instalasi dependensi dan PostgreSQL lokal tertahan kebijakan CLI.

## 5. Kalender

Sama dengan runbook Taman Tahfizh §4: SKB 2026 (1497/2/5 Tahun 2025) dan SKB 2027 (1205/3/2 Tahun
2026), setneg.go.id. Production hanya mencatat 2026-08-25.

- Selama tanggal-tanggal ini belum dicatat HC di Admin → Kalender Kerja, tanggal pilot menjauhi
  **24 dan 25 Desember 2026** serta **1 dan 5 Januari 2027**.
- Cuti yang mulai sebelum 1 Januari 2027 dibatasi 3 hari kerja per triwulan; sejak tanggal itu,
  6 hari kerja per semester.

## 6. Urutan pelaksanaan (dijalankan pemegang akun, bukan agen)

| # | Langkah | Di mana | Siapa | Yang harus terlihat |
| --- | --- | --- | --- | --- |
| G1 | Catat kelompok **Non-pendidikan** Peserta B sesuai keputusan HCM | Admin → **Kebijakan Cuti** | HC | Kelompok tercatat; audit `leave.entitlement_group.changed` |
| G2 | Catat libur nasional dan cuti bersama yang diikuti yayasan selama masa pilot | Admin → **Kalender Kerja** | HC | Audit `leave.calendar.exception.upserted` |
| G3 | **Kirim aktivasi** ke Direktur, lalu ke Kepala GA. Masing-masing mengisi kata sandinya sendiri dan masuk sekali | Admin → **Account & Akses** | HC, lalu orangnya | Kedua akun `active` |
| G4 | Kirim aktivasi ke Peserta B; ia masuk sekali | Sama | HC, lalu Peserta B | Akun `active` |
| G5 | Pindahkan unit: **General Affair** · **Cuti Tahunan** · sumber **Struktur ini** · berlaku hari ini · alasan `Pilot Cuti Tahunan General Affair` | Admin → **Struktur Organisasi** → **Mode persetujuan per unit** | HCM | Satu baris berlaku; audit `organization.rollout.changed` |
| S1 | Peserta B mengajukan satu hari → Kepala GA **Setujui** → Direktur **Setujui** | Cuti & Izin; Persetujuan | Peserta B, penyetuju | Pemohon menerima "Pengajuan cuti Anda disetujui" |
| S2 | Peserta B mengajukan hari lain → Kepala GA **Tolak** dengan alasan | Sama | Peserta B, Kepala GA | Lonceng menampilkan "ditolak" tanpa alasan; Direktur tidak menerimanya |
| S3 | Peserta A mengajukan satu hari → Direktur **Setujui** | Sama | Peserta A, Direktur | "disetujui" |

**Contoh tanggal**, bila G1–G5 selesai paling lambat 3 Desember 2026:

- S1: Kamis 10 Desember 2026
- S2: Kamis 17 Desember 2026
- S3: Jumat 11 Desember 2026

Pengajuan yang ditolak tidak memakai kuota.

Pembacaan bukti per langkah memakai kueri baca-saja di runbook Taman Tahfizh §5. Hasilnya dicatat
hanya sebagai jumlah, status, dan kode.

Jalan mundur tersedia di tiga tingkat:

- **Akhiri** pada baris rollout;
- pemohon **Batalkan pengajuan**;
- HC menangguhkan akun.

## 7. Status — kesiapan teknis dan pilot nyata dicatat terpisah

| Cakupan | Arti | Bukti yang menutupnya |
| --- | --- | --- |
| **Persiapan teknis** | Peta alur dan skenario HTTP terbukti di database uji sintetis dengan topologi yang sama, dan dokumennya ada di `main` | `ops-pilot-ga-001-flow.postgres` lulus di CI dan tidak dilewati (skip) |
| **Pilot nyata** | Dua pengajuan nyata dari dua peserta selesai diputuskan di production, termasuk satu Setujui dan satu Tolak, dengan pemberitahuan sampai ke pemohon | Pembacaan baca-saja production sesudah S1–S3 (runbook Taman Tahfizh §5) |

Kesiapan teknis **tidak** menyatakan pilot berjalan. Pilot nyata baru dapat dimulai setelah
pemegang akun menjalankan langkah-langkah berikut, dalam urutan ini:

| # | Tugas | Pemegang |
| --- | --- | --- |
| 1 | Catat kelompok Non-pendidikan Peserta B (G1) | HC |
| 2 | Catat libur masa pilot (G2) | HC |
| 3 | Kirim aktivasi ke Direktur, Kepala GA, lalu Peserta B; masing-masing masuk sekali (G3–G4) | HC, lalu orangnya |
| 4 | Tulis baris rollout General Affair dari layar (G5) | HCM |
| 5 | Jalankan S1–S3 | Peserta dan penyetuju |

## 8. Hubungan dengan dokumen lain

- `docs/operations/pilot-cuti-taman-tahfizh-2026-11-25.md` (OPS-PILOT-TT-001) — rencana
  sebelumnya. §3–§7 tetap berguna sebagai bukti mekanisme.
- `docs/operations/pilot-tt-runbook-2026-11-26.md` — tabel kalender dan kueri bukti dipakai ulang.
- `docs/operations/pilot-tt-readiness-evidence-2026-11-26.md` — bukti aturan kuota, uji kering
  routing, dan perbaikan 409/400 yang sudah dirilis.
- `docs/development/hcis-closure-list.md` (OPS-CLOSE-001).
