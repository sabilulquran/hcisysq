# Pilot Cuti Tahunan General Affair — pemetaan, calon peserta, dan urutan pelaksanaan

**Spec ID:** OPS-PILOT-GA-001 (menggantikan rencana aktif OPS-PILOT-TT-001)
**Status:** ACTIVE — rencana pilot yang berlaku sejak 2026-11-27. Belum ada satu langkah pun yang
dijalankan di production.
**Tanggal:** 2026-11-27
**Sumber angka production:** pembacaan baca-saja `ssh mi8vps-root` terhadap `sqcore_hcis` pada
2026-11-27, bagan terbit "Kursi Staf Kasir untuk peran kasbon" (berlaku 2026-11-10), rilis yang
berjalan `hcis-6694a49e-20261126`. Yang disalin hanya nama, status, dan ada/tidaknya email; tidak
ada email, NIP, nomor telepon, atau tanggal lahir.

---

## 1. Keputusan HCM 2026-11-27

> "pendidikan. pilotnya yg general affair aja kalau gitu"

| Keputusan | Akibat |
| --- | --- |
| **Rosaliana ditetapkan kelompok Pendidikan** (`education`) | Rosaliana tidak berhak atas Cuti Tahunan individual, sehingga tidak dapat menjadi peserta. **Belum tercatat di production** (kelompoknya masih kosong pada pembacaan 2026-11-27); pencatatannya langkah HC di Admin → Kebijakan Cuti, bukan pekerjaan agen |
| **Unit pilot berpindah dari Taman Tahfizh ke General Affair**, tetap modul **Cuti Tahunan** | Rencana OPS-PILOT-TT-001, runbook-nya (PR #425), dan buktinya menjadi riwayat persiapan; mekanismenya (undangan, bagan terbit, Setujui/Tolak, pemberitahuan) dipakai ulang di sini |
| Ukuran keberhasilan tetap **jalan A** | Dua pengajuan selesai diputuskan, dari dua peserta; peserta dihitung hanya bila kelompoknya `non_education` sudah tercatat atas penetapan HCM |

## 2. General Affair pada bagan terbit

```text
Pembina
└── Dewan Pengurus           ← kursi Sekretaris
    └── Direksi              ← kursi Direktur: Ichwanudin
        └── Bidang Operasional   ← kursi Kepala: KOSONG
            ├── General Affair   ← kursi Kepala: Abdul Kholik
            │   ├── Keamanan     (tanpa ikatan sendiri)
            │   ├── Kebersihan   (tanpa ikatan sendiri)
            │   └── Dapur        ← kursi Koordinator: Roanah
            │       └── Juru Masak (tanpa ikatan sendiri)
            └── Keuangan, …      (unit tetangga, di luar pilot)
```

| Ikatan | Kursi sasaran | Pejabat | Akun | Kebijakan kekosongan |
| --- | --- | --- | --- | --- |
| General Affair · `LEADER` | Kepala (General Affair) | Abdul Kholik | `invited` | `CLIMB_TO_PARENT` |
| General Affair · `UNIT_APPROVER` | Kepala (Bidang Operasional) | **kosong** | — | `CLIMB_TO_PARENT` → kursi induknya, **Direktur** |
| Dapur · `LEADER` | Koordinator (Dapur) | Roanah | **tanpa akun, tanpa email** | `CLIMB_TO_PARENT` |
| Dapur · `UNIT_APPROVER` | Kepala (General Affair) | Abdul Kholik | `invited` | `CLIMB_TO_PARENT` |
| Bidang Operasional · `LEADER` | Kepala (Bidang Operasional) | kosong | — | `CLIMB_TO_PARENT` |
| Direksi · `LEADER` | Direktur | Ichwanudin | `invited` | `CLIMB_TO_PARENT` |

Kolom atasan lama: `direct_manager_employee_id` **kosong** untuk ke-12 anggota, jadi di mode
`LEGACY` setiap pengajuan mereka dijawab `DIRECT_MANAGER_MISSING`. Pilot memakai **bagan terbit
sebagai satu-satunya sumber atasan**; kolom lama tidak diisi.

### 2.1 Rantai yang dihasilkan bagan di bawah `STRUCTURE`

| Pemohon dari | Rantai | Dasar |
| --- | --- | --- |
| Keamanan, Kebersihan | **Abdul Kholik → Ichwanudin** | Kedua node mendaki ke ikatan General Affair; kursi penyetuju unit kosong mendaki ke Direktur |
| Kepala General Affair sendiri | **Ichwanudin** | Langkah dirinya sendiri dibuang; penyetuju unit yang kosong mendaki ke Direktur |
| Dapur, Juru Masak | **berhenti `409 APPROVER_ACCOUNT_NOT_READY`** di kursi Koordinator | Pejabatnya ada tetapi tanpa akun; ORG-004 D-R5 tidak melompatinya |
| Unit lain, termasuk Keuangan | tetap `LEGACY` | Baris rollout pada node General Affair hanya menjangkau subtree-nya |

Rantai ini **dibuktikan dengan bagan sintetis berbentuk sama** (§5). Pembuktian langsung di
production dengan uji kering yang selalu di-ROLLBACK (`scripts/mi8/pilot-ga-dryrun.mjs`) belum
dijalankan: mengunggah skrip ke perangkat tertahan kebijakan CLI sesi agen pada 2026-11-27.

**Cakupan lebih dari satu pimpinan.** Pilot ini melewati dua orang yang berbeda unit: Kepala GA dan
Direktur. Sebabnya kursi Kepala Bidang Operasional kosong. **Bila HCM mengisi kursi itu sebelum
atau selama pilot**, penyetuju unit berpindah ke pejabat baru tersebut; pratinjau pengajuan harus
dibaca ulang sebelum pengajuan pertama.

## 3. Anggota dan calon peserta

Hak Cuti Tahunan individual hanya ada bila kelompok hak cuti tercatat `non_education`. Unit,
node, atau jabatan **tidak** membuktikan hak itu.

| Node | Pegawai | Kelompok tercatat | Email | Akun | Masa kerja ≥ 12 bulan |
| --- | --- | --- | --- | --- | --- |
| General Affair | **Abdul Kholik** (Kepala) | **`non_education`** | ada | `invited` | ya |
| Keamanan | Mh. Iqbal Erfandi | kosong | ada | `invited` | ya |
| Keamanan | Taufik Hidayat | kosong | ada | `invited` | ya |
| Keamanan | Wahyu Sanjaya | kosong | ada | `invited` | ya |
| Keamanan | Sudharma | kosong | ada | `invited` | belum |
| Kebersihan | Ahmad Yani | kosong | ada | `invited` | ya |
| Kebersihan | Dikcy Wahyudi | kosong | ada | `invited` | belum |
| Kebersihan | Irwan | kosong | ada | `invited` | belum |
| Kebersihan | Nurochman | kosong | **tidak ada** | tanpa akun | ya |
| Dapur | Roanah (Koordinator) | kosong | **tidak ada** | tanpa akun | ya |
| Juru Masak | Muslihah | kosong | **tidak ada** | tanpa akun | ya |
| Juru Masak | Nining Ningrum | kosong | **tidak ada** | tanpa akun | ya |

Penyetuju: **Abdul Kholik** (`invited`) dan **Ichwanudin** (Direktur, `invited`). Keduanya punya akun
dan harus masuk sekali sebelum pengajuan pertama.

### 3.1 Rekomendasi

| | Calon | Dasar | Status |
| --- | --- | --- | --- |
| Peserta 1 | **Abdul Kholik** | Satu-satunya anggota yang **tercatat** `non_education`; email dan akun ada; masa kerja cukup | Menunggu HCM mengesahkannya sebagai peserta |
| Peserta 2 | **Belum ada calon resmi** | Tidak ada anggota lain yang kelompoknya tercatat | Menunggu HCM menetapkan kelompok satu orang |

Untuk peserta kedua, HCM menetapkan kelompok hak cuti salah satu orang yang **secara teknis siap**:
email dan akun ada, masa kerja ≥ 12 bulan, dan rantainya melewati dua penyetuju. Mereka adalah
Mh. Iqbal Erfandi, Taufik Hidayat, Wahyu Sanjaya (Keamanan), atau Ahmad Yani (Kebersihan). Daftar
ini **bukan** klaim bahwa mereka berhak; hanya HCM yang menetapkan kelompoknya. Anggota Dapur dan
Juru Masak tidak disarankan, karena tanpa email dan rantainya berhenti di Koordinator tanpa akun.

Dua peserta itu menutup keempat sasaran: pengajuan peserta Keamanan/Kebersihan melewati **dua**
penyetuju (Setujui dan Tolak), dan pengajuan Kepala GA melewati **satu** penyetuju yang berbeda.

## 4. Kemajuan production sejak 2026-11-26

Pembacaan 2026-11-27: **tidak ada perubahan.** 0 baris rollout, 0 undangan aktivasi, 0 pengajuan
cuti, akun 4 `active` / 75 `invited` / 2 `inactive`, 91 pegawai aktif tanpa kelompok hak cuti, dan
kalender hanya mencatat 2026-08-25.

## 5. Bukti otomatis

`apps/api/test/ops-pilot-ga-001-flow.postgres.test.ts`, dengan bagan sintetis berbentuk sama dengan
§2:

1. tanpa baris rollout, `DIRECT_MANAGER_MISSING`; dengan baris tetapi Kepala GA masih `invited`,
   `APPROVER_ACCOUNT_NOT_READY`;
2. Keamanan dan Kebersihan: Kepala GA → Direktur (kursi penyetuju unit kosong mendaki);
3. Kepala GA sebagai pemohon: Direktur saja;
4. Juru Masak: berhenti `APPROVER_ACCOUNT_NOT_READY` di Koordinator Dapur tanpa akun;
5. unit tetangga tetap `LEGACY`;
6. dua peserta: baris rollout dari route admin, undangan dan aktivasi Direktur, Kepala GA, dan
   peserta kedua; `409` sebelum kelompok peserta kedua ditetapkan; Setujui dua langkah; Tolak di
   langkah pertama tanpa sampai ke Direktur; Setujui oleh Direktur untuk Kepala GA; tiga
   pemberitahuan hasil; **Akhiri** dengan audit `organization.rollout.changed` dan `ended`.

Uji itu dijalankan oleh CI pada PR yang membawa dokumen ini. Sesi agen 2026-11-27 tidak dapat
menjalankannya secara lokal, karena instalasi dependensi dan PostgreSQL lokal tertahan kebijakan CLI.

## 6. Kalender

Sama dengan OPS-PILOT-TT-001 runbook §4, dari SKB 2026 (1497/2/5 Tahun 2025) dan SKB 2027
(1205/3/2 Tahun 2026), setneg.go.id. Production hanya mencatat 2026-08-25. Tanggal pilot menjauhi
**24 dan 25 Desember 2026** serta **1 dan 5 Januari 2027** selama tanggal itu belum dicatat HC di
Admin → Kalender Kerja. Cuti yang mulai sebelum 1 Januari 2027 dibatasi 3 hari kerja per triwulan;
sejak tanggal itu 6 hari kerja per semester.

## 7. Urutan pelaksanaan (dijalankan pemegang akun, bukan agen)

| # | Langkah | Di mana | Siapa | Yang harus terlihat |
| --- | --- | --- | --- | --- |
| G1 | Sahkan peserta 1 (usul: Abdul Kholik) dan tetapkan peserta 2 beserta kelompoknya | Keputusan HCM; HC mencatat kelompok di Admin → **Kebijakan Cuti** | HCM, HC | Peserta 2 tercatat `non_education`; audit `leave.entitlement_group.changed` |
| G2 | Catat kelompok Pendidikan Rosaliana (keputusan HCM 2026-11-27) | Admin → **Kebijakan Cuti** | HC | Kelompok Rosaliana `education` |
| G3 | Catat libur nasional dan cuti bersama masa pilot | Admin → **Kalender Kerja** | HC | Audit `leave.calendar.exception.upserted` |
| G4 | **Kirim aktivasi** ke **Ichwanudin**, lalu **Abdul Kholik**; masing-masing mengisi kata sandinya sendiri dan masuk sekali | Admin → **Account & Akses** | HC, lalu orangnya | Kedua akun `active` |
| G5 | Kirim aktivasi ke peserta 2; ia masuk sekali | Sama | HC, lalu peserta 2 | Akun `active` |
| G6 | Pindahkan unit **General Affair** · **Cuti Tahunan** · sumber **Struktur ini** · berlaku hari ini · alasan `Pilot Cuti Tahunan General Affair` | Admin → **Struktur Organisasi** → **Mode persetujuan per unit** | HCM | Satu baris berlaku; audit `organization.rollout.changed` |
| S1 | Peserta 2 mengajukan satu hari → Abdul Kholik **Setujui** → Ichwanudin **Setujui** | Cuti & Izin; Persetujuan | Peserta 2, penyetuju | Pemohon menerima "Pengajuan cuti Anda disetujui" |
| S2 | Peserta 2 mengajukan hari lain → Abdul Kholik **Tolak** dengan alasan | Sama | Peserta 2, Abdul Kholik | "ditolak" tanpa alasan di lonceng; Ichwanudin tidak menerimanya |
| S3 | Abdul Kholik mengajukan satu hari → Ichwanudin **Setujui** | Sama | Abdul Kholik, Ichwanudin | "disetujui" |

Contoh tanggal bila G1–G6 selesai paling lambat 3 Desember 2026: S1 Kamis 10 Desember, S2 Kamis
17 Desember, S3 Jumat 11 Desember 2026. Pengajuan yang ditolak tidak memakai kuota.

Pembacaan bukti per langkah memakai kueri baca-saja yang sama dengan runbook Taman Tahfizh §5,
dengan nama peserta General Affair. Jalan mundur: **Akhiri** pada baris rollout; pemohon
**Batalkan pengajuan**; HC menangguhkan akun.

## 8. Hubungan dengan dokumen lain

- `docs/operations/pilot-cuti-taman-tahfizh-2026-11-25.md` (OPS-PILOT-TT-001) — rencana sebelumnya;
  §3–§7 tetap berguna sebagai bukti mekanisme.
- `docs/operations/pilot-tt-runbook-2026-11-26.md` — runbook Taman Tahfizh (PR #425); tabel
  kalender dan kueri bukti dipakai ulang.
- `docs/operations/pilot-tt-readiness-evidence-2026-11-26.md` — bukti aturan kuota, uji kering
  routing, dan perbaikan 409/400 yang dirilis.
- `docs/development/hcis-closure-list.md` (OPS-CLOSE-001).
