# Perjalanan Dinas

**Status:** ACCEPTED (Paket 1 dan Paket 2) — Paket 1 (pengajuan, persetujuan, surat tugas) dan Paket 2 (disposisi kehadiran `business_trip`, §9.2) sudah dibangun. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal.
**Spesifikasi:** TRIP-001
**Tanggal:** 2026-11-02
**Terkait:** APR-001, ORG-002, ORG-004, DOC-001, NOTIF-004, ATT-014, ATT-015, LEAVE-001, PAY-003, REIMB-001, AUTH-011, ENG-LIST-001
**Roadmap:** `docs/product/roadmap.md` §G, `docs/product/hcis-capability-map.md` §5, `docs/design/employee-self-service-experience.md` (Layanan Pegawai)

## 1. Tujuan

Pegawai YSQ yang ditugaskan ke luar tempat kerja (rapat di yayasan mitra, pelatihan, kunjungan sekolah, pengantaran santri) hari ini meminta izin lisan atau lewat pesan, lalu HC mengetik surat tugas manual. Akibatnya tidak ada catatan siapa menyetujui, nomor surat tugas tidak berurutan, dan HC tidak tahu siapa sedang dinas ketika membaca rekap kehadiran.

Yang dituju Paket 1:

- pegawai mengajukan perjalanan dinas dari HCIS dan melihat statusnya;
- persetujuan berjalan lewat approval engine APR-001 yang sama dengan cuti: rantai disnapshot saat pengajuan;
- HC menerbitkan **surat tugas bernomor** yang tercatat di register dokumen yang sama dengan DOC-001;
- perjalanan bisa dibatalkan dengan alasan, dan diselesaikan dengan laporan singkat;
- setiap langkah tercatat sebagai riwayat dan audit event;
- perjalanan yang sudah disetujui **terlihat** di tab Pengecualian rekap kehadiran, tanpa mengubah hasil kehadiran.

Yang ditambah Paket 2 (§9.2): hari kerja terjadwal yang tertutup perjalanan bersurat tugas (`ISSUED`/`COMPLETED`) tidak lagi tampil "Tidak hadir", melainkan **Dinas** (`business_trip`), dan payroll PAY-003 membacanya sebagai hari hadir.

## 2. Batas

Termasuk (Paket 1):

- pengajuan oleh pegawai untuk dirinya sendiri;
- persetujuan berurutan oleh atasan langsung lalu approver unit (APR-001);
- penerbitan surat tugas bernomor oleh HC;
- pembatalan oleh pegawai atau HC, penyelesaian oleh pegawai;
- riwayat per pengajuan dan register HC;
- notifikasi in-app melalui NOTIF-004;
- tampilan baca-saja di tab Pengecualian ATT-014.

**Tidak** termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| Uang muka, biaya, uang harian, akomodasi, tiket | TRIP-001 tidak menyimpan nominal apa pun dan tidak menghitung biaya. Biaya yang sudah dikeluarkan (tiket, akomodasi, konsumsi) diklaim lewat REIMB-001 dengan menautkan perjalanan `APPROVED`/`ISSUED`/`COMPLETED` (`docs/domain/reimbursement.md` D-06). Uang muka dan uang harian belum ada (REIMB-001 §2). |
| Pengajuan oleh atasan untuk bawahan, atau satu pengajuan untuk rombongan | Paket 1 satu pengajuan = satu pegawai yang berangkat (D-02). |
| Perubahan tanggal setelah diajukan | Batalkan lalu ajukan ulang (D-09). |
| Lampiran undangan/agenda | Belum ada object storage untuk berkas pegawai (sama dengan DOC-001 §2). |
| Reassignment tahap approval | Mengikuti APR-001; prosedurnya belum dibangun untuk modul mana pun. HC dapat membatalkan pengajuan yang macet (D-08). |
| Penyetuju akun yayasan (`FOUNDATION_BOARD`) | Rantai Paket 1 hanya berisi pegawai. Perjalanan Direktur yang hanya punya penyetuju akun yayasan gagal tertutup dengan pesan konfigurasi (§5.1). |

## 3. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| D-01 | Persetujuan memakai **APR-001 dengan rantai atasan langsung → approver unit**, sama dengan Cuti Tahunan. Kunci alur rollout ORG-004: `TRIP`. Tanpa baris rollout, mode `LEGACY` (atasan langsung pegawai dan approver unit pada unitnya). HC **tidak** menjadi tahap approval. | DRAFT |
| D-02 | Satu pengajuan untuk satu pegawai, dan hanya pegawai itu sendiri yang mengajukan. Perjalanan rombongan = tiap anggota mengajukan sendiri dan masing-masing menerima surat tugas. | DRAFT |
| D-03 | Lama perjalanan paling banyak **30 hari kalender** per pengajuan, dihitung inklusif. | DRAFT |
| D-04 | Tanggal berangkat paling cepat **hari ini (WIB)**. Tidak ada pengajuan mundur di Paket 1; perjalanan mendadak yang sudah berjalan dicatat HC di luar sistem. | DRAFT |
| D-05 | Perjalanan tidak boleh tumpang tindih dengan perjalanan lain milik pegawai yang belum ditolak atau dibatalkan (`IN_REVIEW`, `APPROVED`, `ISSUED`, `COMPLETED`) atau dengan cuti yang `in_review`/`approved`. | DRAFT |
| D-06 | Nomor surat tugas memakai register DOC-001: `<urut>/ST/YSQ/<bulan romawi>/<tahun>`, urut per tahun takwim Jakarta, dialokasikan **hanya saat terbit**, tidak pernah didaur ulang. | DRAFT (mengikuti DOC-001 D-04) |
| D-07 | Penandatangan surat tugas: **Kepala Human Capital Management**, fallback **Direktur**, tanpa self-sign — resolver yang sama dengan DOC-001 D-05/PAYSLIP-005. | DRAFT |
| D-08 | Pembatalan: pegawai boleh membatalkan selama `IN_REVIEW` atau `APPROVED`. Setelah surat tugas terbit (`ISSUED`), hanya HC (`trips.manage`) yang membatalkan, dan surat tugasnya berubah `REVOKED` dengan nomor tetap terpakai. HC juga boleh membatalkan pengajuan `IN_REVIEW`/`APPROVED` yang macet. Alasan selalu wajib. | DRAFT |
| D-09 | Tidak ada perubahan tanggal atau tujuan setelah diajukan. Perubahan = batalkan, lalu ajukan baru. | DRAFT |
| D-10 | Penyelesaian: pegawai menandai selesai dengan **laporan singkat** (10–2000 karakter) setelah surat tugas terbit dan pada/sesudah tanggal kembali. Tidak ada verifikasi HC atas laporan di Paket 1. | DRAFT |
| D-11 | Perjalanan `APPROVED`, `ISSUED`, dan `COMPLETED` tampil di tab Pengecualian rekap kehadiran (ATT-014 §20.2) sebagai baris baca-saja. Hasil kehadiran harian, keterlambatan, dan payroll **tidak** berubah di Paket 1; perjalanan tidak pernah menyintesis punch. | DRAFT |
| D-12 | `trips.read` dan `trips.manage` dibawa `human_capital_admin`, berscope organisasi. Super Admin tidak menerimanya lewat kompatibilitas legacy. Atasan melihat pengajuan bawahan hanya lewat antrean approval-nya sendiri. | DRAFT |
| D-13 | Surat tugas hanya memuat nama, NIP, jabatan, unit, tujuan, keperluan, tanggal, dan penandatangan. Tidak memuat nominal, rekening, NIK, atau alamat rumah (DOC-001 D-15). | ACCEPTED |
| D-14 | Surat tugas **tidak** dapat dibatalkan lewat tombol Batalkan register DOC-001, karena status perjalanan harus ikut berubah. Satu-satunya jalan adalah pembatalan perjalanan (D-08). | ACCEPTED |
| D-15 | Paket 2: hanya perjalanan `ISSUED`/`COMPLETED` yang menjadi disposisi kehadiran; `APPROVED` tanpa surat tugas tetap hanya terlihat di Pengecualian (D-11). Urutan: jadwal bermasalah/libur → cuti atau penyelesaian final → **perjalanan dinas** → tugas luar/WFH ATT-015 → punch. Perjalanan menang atas tugas luar/WFH pada hari yang sama (biasanya tidak terjadi karena D-05/ATT-015 D-08 saling menolak). Pada hari dinas dengan punch, menit telat dan pulang awal disimpan **0** (bukan sekadar `justified`), sehingga punch yang terlambat dibaca `present`; `absent`/`incomplete` diganti `business_trip` dengan jam punch yang tercatat tetap disimpan. | DRAFT |
| D-16 | Label status `business_trip` di layar pegawai dan HC: **"Dinas"**. Simbol rekap: **`PD`**. Kolom rekap "Tugas luar/WFH" menjadi "Tugas luar/WFH/Dinas" (`TL/WFH/PD` pada matriks) dan menjumlah ketiganya. | DRAFT |
| D-17 | Payroll PAY-003 memperlakukan hari `business_trip` **sama dengan `field_assignment`**: hari kerja yang dihitung satu kali untuk transport PKWT (`CONTRACT_ATTENDANCE_DAYS`), selama perjalanannya masih `ISSUED`/`COMPLETED`. Tidak ada komponen biaya perjalanan (uang harian, uang saku) di payroll; biaya mengikuti REIMB-001. | DRAFT |

## 4. Actor

| Actor | Tindakan |
| --- | --- |
| Pegawai (pemohon) | Melihat pratinjau rantai approval, mengajukan, membatalkan (D-08), menyelesaikan (D-10), melihat riwayat dan surat tugas miliknya |
| Approver tahap aktif | Menyetujui atau menolak tahap yang sedang `pending` miliknya |
| HC dengan `trips.read` | Melihat register perjalanan seluruh pegawai beserta riwayatnya |
| HC dengan `trips.manage` | Menerbitkan surat tugas, membatalkan perjalanan (D-08) |
| Sistem | Snapshot rantai, transisi, audit, notifikasi |

## 5. Alur dan state

### 5.1 Pengajuan

Precondition: akun `EMPLOYEE` aktif yang terhubung ke pegawai `active`.

Input: `destination` (3–200), `purpose` (10–1000), `startOn`, `endOn` (`YYYY-MM-DD`), `idempotencyKey` (UUID).

Langkah, dalam satu transaksi:

1. kunci baris pegawai (`FOR UPDATE`), sehingga dua pengajuan bersamaan diperiksa berurutan;
2. bila `idempotencyKey` sudah dipakai pegawai ini, kembalikan pengajuan yang sama (replay, bukan duplikat);
3. validasi D-03, D-04, D-05;
4. resolusi rantai APR-001 (D-01): atasan langsung dan approver unit menjadi pegawai konkret, self-approval dibuang, approver ganda digabung;
5. setiap approver harus pegawai aktif dengan akun aktif; bila tidak, pengajuan **gagal** dengan pesan konfigurasi — tidak ada rantai setengah jadi;
6. simpan pengajuan `IN_REVIEW`, tahap pertama `pending`, sisanya `waiting`, snapshot resolusi;
7. audit `trip.request.submitted`, notifikasi ke approver tahap pertama.

Pratinjau (`POST /trips/me/preview`) menjalankan langkah 3–5 tanpa menyimpan, supaya pegawai tahu siapa penyetujunya sebelum mengirim.

Pemeriksaan D-05 hanya berjalan dari sisi perjalanan pada Paket 1: modul cuti belum menolak cuti yang beririsan dengan perjalanan yang sudah disetujui. Cek arah sebaliknya adalah tindak lanjut di LEAVE-001, bukan bagian paket ini.

Sejak ATT-015 (D-08), perjalanan juga ditolak bila beririsan dengan tugas luar atau WFH/WFA milik pegawai yang `IN_REVIEW`/`APPROVED` (`TRIP_ARRANGEMENT_OVERLAP`); ATT-015 menolak arah sebaliknya.

Kegagalan (409 kecuali disebut lain): `TRIP_DATE_RANGE`, `TRIP_TOO_LONG`, `TRIP_START_IN_PAST`, `TRIP_OVERLAP`, `TRIP_LEAVE_OVERLAP`, `DIRECT_MANAGER_MISSING`, `UNIT_APPROVER_MISSING`, `APPROVAL_CHAIN_EMPTY`, `APPROVER_NOT_ACTIVE`, `APPROVER_ACCOUNT_NOT_READY`; input tidak valid 400 `INVALID_TRIP_REQUEST`; akun bukan pegawai aktif 403 `EMPLOYEE_NOT_ACTIVE`.

> Konsekuensi yang diketahui: sebelum akun pemimpin diaktifkan, pengajuan di production berhenti di `APPROVER_ACCOUNT_NOT_READY`. Itu perilaku yang benar (APR-001-E), bukan cacat. Alurnya diuji dengan data sintetis di test integrasi.

### 5.2 State pengajuan

```text
IN_REVIEW -> APPROVED      (tahap terakhir disetujui)
IN_REVIEW -> REJECTED      (salah satu tahap menolak)
IN_REVIEW -> CANCELLED     (pegawai atau HC, dengan alasan)
APPROVED  -> ISSUED        (HC menerbitkan surat tugas)
APPROVED  -> CANCELLED     (pegawai atau HC, dengan alasan)
ISSUED    -> COMPLETED     (pegawai, laporan singkat, D-10)
ISSUED    -> CANCELLED     (HC saja; surat tugas -> REVOKED)
REJECTED / CANCELLED / COMPLETED -> terminal
```

`APPROVED` dan `ISSUED` dipisah karena alasan yang sama dengan DOC-001 §5.1: penerbitan yang gagal (tidak ada penandatangan eligible) tidak boleh menghapus keputusan approver.

### 5.3 State tahap approval

```text
waiting -> pending -> approved
                   -> rejected
waiting/pending -> cancelled   (pengajuan dibatalkan; riwayat tahap tidak dihapus)
```

Satu tahap `pending` per pengajuan dijaga indeks unik parsial, sehingga dua keputusan bersamaan tidak dapat memenangkan transisi yang sama (APR-001-G). Keputusan mengunci baris tahap dan pengajuan (`FOR UPDATE`).

### 5.4 Keputusan approval

Hanya approver yang tersimpan pada tahap `pending` yang dapat memutuskan; lainnya 403 `APPROVAL_FORBIDDEN`. Tahap yang bukan aktif 409 `STEP_NOT_PENDING`. Menolak mewajibkan catatan (5–1000). Menyetujui tahap terakhir membuat pengajuan `APPROVED` dan memberi tahu pegawai serta tidak ada notifikasi massal ke HC — HC melihat antrean "Siap diterbitkan".

### 5.5 Penerbitan surat tugas

Actor `trips.manage`; precondition `APPROVED` dan pegawai masih `active` (bila tidak: 409 `TRIP_EMPLOYEE_NOT_ACTIVE`, HC membatalkan perjalanannya). Dalam satu transaksi: resolusi penandatangan (D-07), alokasi nomor (D-06), simpan dokumen `ASSIGNMENT` di `hr_issued_documents` dengan snapshot isi (D-13), pengajuan → `ISSUED`, audit `trip.assignment.issued`, notifikasi pegawai. Tanpa penandatangan eligible: 409 `DOCUMENT_SIGNER_UNAVAILABLE`, pengajuan tetap `APPROVED`, nomor tidak terpakai.

### 5.6 Pembatalan

Input `reason` (pegawai 5–500, HC 10–500). Tahap `waiting`/`pending` menjadi `cancelled`. Bila surat tugas sudah terbit, statusnya `REVOKED` dalam transaksi yang sama, nomor tetap terpakai. Pembatalan oleh HC memberi tahu pegawai. Status yang tidak mengizinkan: 409 `TRIP_NOT_CANCELLABLE`.

### 5.7 Penyelesaian

Pegawai, status `ISSUED`, tanggal hari ini (WIB) ≥ `endOn`, `report` 10–2000. Lainnya 409 `TRIP_NOT_COMPLETABLE`.

## 6. Permission

| Permission | Arti | Pembawa |
| --- | --- | --- |
| `trips.read` | Register perjalanan dan riwayat seluruh pegawai | `human_capital_admin` |
| `trips.manage` | Menerbitkan surat tugas dan membatalkan perjalanan | `human_capital_admin` |

Akses pegawai ke perjalanannya sendiri adalah kepemilikan dari sesi, bukan permission. Akses approver adalah kepemilikan tahap snapshot, bukan permission.

Migrasi `0116` menambah izin ke role yang sudah ada, jadi rilisnya berdiri sendiri (DOC-001 D-17, OPS-MI8-REL-001 §4.5). `HC_ADMIN_PERMISSIONS` dan allowlist `HCIS_PERMISSIONS` berubah dalam perubahan yang sama.

## 7. Audit dan riwayat

Tabel `business_trip_events` adalah riwayat per pengajuan sekaligus audit event:

`trip.request.submitted`, `trip.approval.approved_step`, `trip.request.approved`, `trip.request.rejected`, `trip.request.cancelled`, `trip.assignment.issued`, `trip.assignment.revoked`, `trip.request.completed`.

Setiap event memuat aktor, waktu (`clock_timestamp()`, sehingga dua event dalam satu transaksi tetap berurutan), dan metadata aman (id tahap, nomor surat, peran pembatal). Alasan penolakan/pembatalan disimpan sebagai `note`. Tidak ada nominal, karena Paket 1 tidak punya nominal.

Penerbitan dan pencabutan surat tugas juga dicatat di log register DOC-001 (`doc.issued`, `doc.revoked`, metadata `source = TRIP-001`).

Pegawai melihat riwayat perjalanannya sendiri; pemegang `trips.read` melihat riwayat semua perjalanan.

## 8. Notifikasi (NOTIF-004, kategori `system`)

- tahap menjadi `pending` → approver tahap itu;
- disetujui akhir / ditolak → pegawai;
- surat tugas terbit → pegawai;
- dibatalkan oleh HC → pegawai.

Notifikasi ditulis dalam transaksi yang sama dengan transisinya dan idempoten per `eventKey`.

## 9. Kehadiran

### 9.1 Paket 1

`GET /admin/attendance/exceptions` (ATT-014 §20.2) menambah baris `kind = "trip"` untuk perjalanan `APPROVED`, `ISSUED`, `COMPLETED` yang beririsan dengan rentang, dengan `type = destination`, `reason = purpose`, `status` = status perjalanan. Baca-saja; tidak ada penulisan ke tabel kehadiran.

### 9.2 Paket 2: disposisi `business_trip` (dibangun 2026-11-17)

Kontrak:

- Hari kerja terjadwal yang tertutup perjalanan `ISSUED`/`COMPLETED` mendapat disposisi `business_trip` di engine harian, dengan prioritas di bawah cuti yang disetujui.
- Disposisi itu menggantikan `absent`/`incomplete` saja. Hari dengan punch tetap memakai punch-nya; tidak ada punch yang dibuat dari jam jadwal (anti-copy guardrail roadmap).
- Keterlambatan dan pulang awal pada hari dinas tidak dihitung.
- Payroll membaca hari `business_trip` sebagai hadir, tanpa komponen biaya.

Implementasi (`materializeAttendanceResult`, ATT-007; aturan urutan D-15):

```text
jadwal bermasalah        -> configuration_error   (tidak berubah)
libur / tanpa jadwal     -> off                   (tidak berubah)
cuti / penyelesaian final -> leave | absent       (tidak berubah)
perjalanan ISSUED/COMPLETED:
   tanpa punch            -> business_trip, menit kerja 0, justified
   dengan punch           -> penilaian punch biasa, lalu:
                               absent | incomplete -> business_trip (jam punch tetap disimpan)
                               late               -> present
                               menit telat dan pulang awal = 0; telat/pulang awal/di luar lokasi justified
tugas luar / WFH ATT-015 -> seperti sebelumnya
selain itu               -> penilaian punch biasa
```

- Hari yang menjadi `business_trip` karena punch tidak lengkap tetap menyimpan sesinya, tetapi tidak ditandai `incomplete_session`: harinya sudah diputus perjalanan.
- Hari multi-blok (ATT-013) mengikuti aturan yang sama: tanpa punch sama sekali → `business_trip`; dengan punch → penilaian per blok, lalu rollup hari diperlakukan seperti di atas. Bila hari menjadi `business_trip`, baris blok tidak disimpan (sama dengan hari tanpa punch), supaya tidak ada blok "Tidak hadir" di bawah hari Dinas yang dihitung penuh; bila hari `present`, blok disimpan dengan blok terlambat dibaca hadir dan menit 0.
- Versi hasil menyimpan `attendance_result_versions.source_business_trip_id`; id perjalanan (bukan statusnya) masuk ke `input_hash`, sehingga penerbitan dan pembatalan menghasilkan versi baru, sedangkan penyelesaian (`ISSUED` → `COMPLETED`) tidak.
- **Hitung ulang** (sama dengan ATT-015 §7.3): menerbitkan surat tugas dan pembatalan perjalanan `ISSUED` menghitung ulang tanggal perjalanan yang sudah dimulai (sampai hari ini), setelah COMMIT, berurutan; gagal satu tanggal tidak menggagalkan transisi dan Kalkulasi memperbaikinya. Jawaban membawa `recalculatedDates`. Tanggal mendatang dihitung saat harinya tiba. Tanggal yang gagal dihitung ulang tetap terlihat: penanda "Berubah sejak dikalkulasi" (ATT-014 §6.5) menyala untuk hari yang tertutup perjalanan yang terbit, selesai, atau dibatalkan setelah surat tugas terbit sesudah hasilnya dihitung.
- Daftar status perjalanan yang memutus kehadiran (`ISSUED`, `COMPLETED`) ada di satu konstanta `TRIP_ATTENDANCE_STATUSES` (`apps/api/src/modules/trips/domain.ts`) yang dipakai engine, tampilan harian/Pantauan, penanda perubahan, dan resolver PAY-003.
- Status, label, dan rekap (D-16): `business_trip` | **Dinas** | simbol `PD` | Normal 1 | Riil 1. Laporan periode dan per unit menghitungnya sebagai hari hadir. Tampilan harian yang membaca hari belum dihitung dan Pantauan Hari Ini memakai disposisi yang sama (penanda "Dinas" di kolom Keterangan; kartu Pantauan tetap fakta scan). Antrean tindakan hanya memuat `incomplete` dan `configuration_error`, jadi hari dinas tidak muncul di sana.
- Payroll PAY-003 (D-17): resolver kehadiran (`resolveAttendanceDays`) menghitung hari `business_trip` seperti `field_assignment` — satu hari hadir untuk transport PKWT pada hari kerja (atau hari libur yang dijadwalkan kerja), hanya selama perjalanannya masih `ISSUED`/`COMPLETED`. Tidak ada input biaya, uang harian, atau komponen lain yang lahir dari perjalanan. Jalur slip resmi PAY-001/PAY-002 tidak berubah.
- Tab Pengecualian (§9.1) tidak berubah.

## 10. Penyimpanan

```text
business_trip_requests        pengajuan, snapshot resolusi, laporan penyelesaian
business_trip_approval_steps  snapshot rantai APR-001
business_trip_events          riwayat dan audit
hr_issued_documents           surat tugas (document_kind = 'ASSIGNMENT', number_code 'ST')
attendance_result_versions.source_business_trip_id   Paket 2: perjalanan yang memutus hari itu
```

Aturan:

- `business_trip_requests` unik pada `(employee_id, idempotency_key)`; `CHECK (end_on >= start_on)` dan `CHECK (end_on - start_on <= 29)`;
- `business_trip_approval_steps` unik pada `(request_id, step_order)`, satu `pending` per pengajuan (indeks unik parsial);
- `hr_issued_documents.document_kind` menerima `ASSIGNMENT`;
- Paket 2 (migrasi `0151`): status hasil kehadiran menerima `business_trip`; kolom `source_business_trip_id` (FK ke `business_trip_requests`, indeks parsial);
- tidak ada endpoint hapus.

Rollback migrasi ditulis sebagai komentar `-- Down:` di berkas migrasi. Untuk `0151`, mengembalikan CHECK status hasil hanya aman bila belum ada versi hasil berstatus `business_trip`; bila sudah ada, rollback kode cukup (build lama tidak menulis status baru dan membaca status asing sebagai "·").

## 11. API

Pegawai: `GET /trips/me` (halaman), `GET /trips/me/:id`, `POST /trips/me/preview`, `POST /trips/me`, `POST /trips/me/:id/cancel`, `POST /trips/me/:id/complete`.

Approver: `GET /trips/approvals`, `POST /trips/approvals/:stepId/decision`.

HC: `GET /admin/trips` (halaman, filter status dan pegawai), `GET /admin/trips/:id`, `POST /admin/trips/:id/issue`, `POST /admin/trips/:id/cancel`.

Kontrak lengkap: `docs/api/openapi.yaml`, tag `Business Travel`. Daftar mengikuti ENG-LIST-001: `page`/`pageSize` default 25 maks 100 dengan `total`; filter pegawai di layar HC memakai pencarian typeahead.

## 12. Layar

- Pegawai: `/app/trips` di Layanan Pegawai — formulir pengajuan dengan pratinjau penyetuju, daftar perjalanan berhalaman, detail berisi tahap approval, riwayat, surat tugas siap cetak, tombol batal/selesai sesuai state.
- Approver: bagian "Perjalanan Dinas" di halaman Persetujuan.
- HC: `/admin/trips` di Layanan Pegawai admin — register berhalaman dengan filter status dan pencarian pegawai, detail sebagai pop-up (`?perjalanan=<id>`) (aturan app-shell "Detail views open as a pop-up", 2026-11-13), Terbitkan surat tugas, Batalkan. Surat tugas tetap dicetak dari pop-up itu tanpa terpotong.

State loading, kosong, galat, terlarang (403), dan mobile wajib ada di ketiga layar.

## 13. Acceptance criteria

- TRIP-001-A: pegawai aktif dapat mengajukan dan melihat perjalanannya; pegawai lain tidak dapat membaca, membatalkan, atau menyelesaikannya.
- TRIP-001-B: rantai approval disnapshot saat pengajuan; mengubah atasan sesudahnya tidak mengubah tahap yang tersimpan.
- TRIP-001-C: approver yang tidak memegang tahap aktif menerima 403; keputusan ganda hanya menghasilkan satu transisi.
- TRIP-001-D: resolver yang gagal atau approver dengan akun belum aktif menggagalkan pengajuan tanpa menyimpan apa pun.
- TRIP-001-E: tanggal mundur, lebih dari 30 hari, atau tumpang tindih dengan perjalanan/cuti ditolak.
- TRIP-001-F: surat tugas hanya terbit dari `APPROVED`, oleh pemegang `trips.manage`, dengan nomor `ST` unik; tanpa penandatangan, pengajuan tetap `APPROVED` dan nomor tidak terpakai.
- TRIP-001-G: pegawai tidak dapat membatalkan setelah `ISSUED`; pembatalan HC mencabut surat tugas dan nomornya tetap terpakai.
- TRIP-001-H: surat tugas tidak dapat dibatalkan lewat register DOC-001.
- TRIP-001-I: penyelesaian hanya dari `ISSUED` dan pada/sesudah tanggal kembali.
- TRIP-001-J: tanpa `trips.read` register HC menjawab 403; Super Admin legacy tidak menerima `trips.*`.
- TRIP-001-K: setiap transisi menulis event riwayat dengan aktor.
- TRIP-001-L: perjalanan yang disetujui tampil di tab Pengecualian; tidak ada baris yang ditulis ke tabel kehadiran.
- TRIP-001-M: tidak ada kolom atau field nominal di skema maupun kontrak.
- TRIP-001-N (Paket 2): hari kerja terjadwal tanpa punch yang tertutup perjalanan `ISSUED`/`COMPLETED` dihitung `business_trip`; perjalanan `APPROVED` tidak mengubah hasil; tidak ada baris baru di `attendance_events`.
- TRIP-001-O (Paket 2): pada hari dinas dengan punch, punch tetap dipakai; `absent`/`incomplete` menjadi `business_trip`, menit telat dan pulang awal 0.
- TRIP-001-P (Paket 2): cuti atau penyelesaian final pada hari dinas menang; hari libur dan jadwal bermasalah tidak berubah.
- TRIP-001-Q (Paket 2): menerbitkan surat tugas dan pembatalan HC menghitung ulang tanggal yang sudah dimulai; setelah pembatalan hari kembali dinilai dari punch saja.
- TRIP-001-R (Paket 2): resolver kehadiran PAY-003 menghitung hari `business_trip` sebagai satu hari hadir PKWT, tidak untuk perjalanan yang sudah dibatalkan, dan tidak menghasilkan input biaya.

## 14. Asumsi DRAFT yang perlu dikonfirmasi pemilik produk

| # | Pertanyaan | Default yang dipakai |
| --- | --- | --- |
| D-01 | Siapa yang menyetujui perjalanan dinas? | Atasan langsung → approver unit, HC tidak menyetujui |
| D-02 | Rombongan satu pengajuan atau per orang? | Per orang |
| D-03 | Batas lama perjalanan? | 30 hari kalender |
| D-04 | Boleh diajukan setelah berangkat? | Tidak |
| D-06 | Format nomor surat tugas? | `001/ST/YSQ/XI/2026` |
| D-07 | Siapa penanda tangan surat tugas? | Kepala HCM, cadangan Direktur |
| D-08 | Siapa boleh membatalkan setelah surat terbit? | HC saja |
| D-10 | Perlu laporan setelah kembali? | Ya, singkat, tanpa verifikasi HC |
| D-11 | Dampak ke kehadiran? | Terlihat di Pengecualian; status "Dinas" otomatis sejak Paket 2 (§9.2) |
| D-15 | Perjalanan atau tugas luar yang menang bila keduanya ada? Telat pada hari dinas dihapus atau hanya dijelaskan? | Perjalanan menang; menit telat/pulang awal 0 dan status `present` |
| D-16 | Label dan simbol rekap hari dinas? | "Dinas", simbol `PD` |
| D-17 | Hari dinas PKWT mendapat transport? | Ya, sama dengan tugas luar (ATT-015 D-07); tanpa uang harian |
