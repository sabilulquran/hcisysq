# OPS-CLOSE-001 — Daftar penutupan HCIS sebelum dibuka ke seluruh pegawai

**Spec ID:** OPS-CLOSE-001
**Status:** ASSESSMENT (read-only) — 2026-11-20. Dokumen ini tidak mengubah gate mana pun; ia mencatat posisi tiap butir beserta buktinya.
**Gate induk:** `docs/product/scope.md` ("Pilot ready", "Production ready") lewat `docs/operations/hcis-readiness-gates-2026-10-16.md` (OPS-READY-001). Keputusan pembukaan dicatat di `docs/operations/go-live-decision-record-template.md` (OPS-GOLIVE-001).
**Rilis production saat dokumen ini ditulis:** `hcis-127b6068-20261118` (symlink `/srv/hcis/current` dipasang 18 Nov 16:05 WIB), bukti `docs/development/production-release-verification-2026-11-18-127b6068.md`.
**Sumber angka production:** pengukuran owner sendiri pada 2026-11-20 (§3). Penulis dokumen ini tidak punya akses production dan tidak menurunkan ulang angka tersebut.
**Sumber angka repository:** `origin/main` pada `2560b04f` (merge #390).

## 1. Kesimpulan yang harus dibaca lebih dulu

**HCIS belum pernah dipakai siapa pun di production.** Untuk 97 pegawai aktif hanya ada **4 akun aktif** (1 `EMPLOYEE`, 2 `FOUNDATION_BOARD`, 1 lain). Tidak ada satu pun pengajuan cuti, kasbon, atau reimbursement sepanjang umur sistem, dan tidak ada satu pun periode payroll. Yang benar-benar berjalan di production hanya dua hal: **penyerapan kehadiran dari mesin ADMS** dan **penyimpanan 5.202 slip gaji hasil impor historis**.

**Penghambat nomor satu untuk pembukaan: 95 dari 97 pegawai aktif tidak punya `direct_manager_employee_id`.** Ini bukan catatan kecil. Seluruh rantai persetujuan production berjalan dalam mode `LEGACY` — `organization_rollout_settings` kosong, sehingga `OrganizationRolloutService` jatuh ke `LEGACY` (`apps/api/src/modules/organization/repository.ts:750`) — dan resolver `LEGACY` membangun rantai hanya dari dua kolom: `employees.direct_manager_employee_id` dan `organizational_units.leave_approver_employee_id`. Bila kolom atasan kosong, `resolveLeaveLineApprovalChain` melempar `DIRECT_MANAGER_MISSING` ("Atasan langsung belum dikonfigurasi") dan pengajuan **gagal tertutup**, bukan jatuh ke HC (`apps/api/src/modules/leave/domain/approval-chain.ts`).

Resolver yang sama dipakai enam modul: cuti (`leave/employee-routes.ts`), cuti berencana (`leave/planned-leave-routes.ts`), pengaturan kerja ATT-015 (`attendance/work-arrangement-routes.ts`), kasbon (`loans/routes.ts`), reimbursement (`reimbursements/routes.ts`), dan perjalanan dinas (`trips/routes.ts`); lembur memakai jalur sejenis lewat `attendance/overtime-approver.ts`. Artinya, bila HCIS dibuka hari ini, **95 dari 97 pegawai akan menemui penolakan di hampir setiap layanan yang mereka coba**, dan penolakannya terbaca sebagai kesalahan sistem, bukan sebagai data yang belum diisi.

Pengisiannya tidak otomatis: impor pegawai EMP-004 tidak membawa kolom atasan sama sekali (tidak ada rujukan `direct_manager` di `apps/api/src/modules/employees/application/` maupun `infrastructure/`), dan satu-satunya jalur tulis adalah `PATCH /admin/employees/:employeeId/manager` — satu pegawai per panggilan, izin `approvals.policy.manage`.

**Laporan mana pun yang menyatakan "semua PRD sudah selesai" tidak menjawab pertanyaan ini.** PRD yang selesai berarti kode sudah di-merge. Dokumen ini memisahkan "sudah di-merge" dari "sudah dirilis", "sudah menyala", dan "sudah pernah dipakai".

## 2. Kosakata status

Lima status, dipakai persis seperti ini dan tidak dicampur:

| Status | Arti |
|---|---|
| **Belum selesai** | Pekerjaannya belum rampung di repository. |
| **Selesai belum dirilis** | Sudah di-merge ke `main`, tetapi belum ada di rilis production yang berjalan. |
| **Dirilis belum aktif** | Sudah ada di production, tetapi di balik saklar yang mati atau menunggu data, sehingga belum melakukan apa pun. |
| **Aktif belum diuji** | Hidup di production, tetapi belum pernah dijalankan dengan data nyata atau realistis. |
| **Sudah diuji** | Hidup di production dan terbukti bekerja, dengan bukti bertanggal. |

Setiap butir membawa lima keterangan: **status**, **bukti bertanggal**, **penghambat**, **langkah berikutnya**, **kriteria selesai**. Butir yang tidak dapat dipastikan dari repository ditulis **belum terverifikasi** dan masuk §8 beserta cara memeriksanya — tidak ada butir yang diam-diam dianggap beres.

## 3. Potret production — 2026-11-20

Angka di bawah ini diukur owner sendiri pada 2026-11-20 dan dipakai apa adanya.

| Fakta | Angka |
|---|---|
| Pegawai `active` | 97 |
| Akun `active` **total** | 4 (1 `EMPLOYEE`, 2 `FOUNDATION_BOARD`, 1 lain) |
| Pegawai `active` tanpa `direct_manager_employee_id` | **95 dari 97** |
| Pegawai `active` tanpa unit | 0 |
| `payroll_periods` / `payroll_results` | 0 / 0 |
| `payslips` (impor historis) | 5.202 |
| `payroll_policy_versions` per kunci | `BASIC_MULTIPLIER`, `BPJS_KESEHATAN`, `CONTRACT_RATES`, `EARLY_SERVICE`, `FAMILY`, `FUNCTIONAL_ALLOWANCE`, `OVERTIME`, `PERFORMANCE`, `POSITIONAL_ALLOWANCE`, `SALARY_SCALE`, `TEACHING_HOURS`, `VARIANCE_THRESHOLD` masing-masing 1; `THR` 2. **Tidak ada** `PPH21_SETTINGS`, `PPH21_TER`, `PPH21_ANNUAL`, `PAYSLIP_LAYOUT` |
| `organization_rollout_settings` | **0 baris** → setiap workflow `LEGACY` |
| `employment_rollout_settings` | 0 baris |
| `employments` / `employment_terms` | 326 / 326 |
| `employment_placements` | 96 (96 employment berbeda) |
| `attendance_schedule_assignments` | 93 |
| `attendance_daily_records` | 2.127 |
| `attendance_events` | 2.855 |
| `attendance_biometric_credentials` | 0 |
| `attendance_adms_request_journal` | 932.271 |
| `leave_requests` / `employee_loans` / `reimbursement_claims` | 0 / 0 / 0 |

Pegawai aktif per unit: SDIT Tahfizh 46, Pesantren Tahfizh 22, General Affair 12, Taman Tahfizh 9, Keuangan 2, Yayasan Sabilul Quran 2, Bidang Pendidikan 2, Divisi Media 1, Human Capital Management 1.

Pembacaan yang harus disebut terang-terangan:

- 4 akun aktif untuk 97 pegawai berarti sistem ini belum punya pengguna.
- 0 pengajuan cuti, kasbon, dan reimbursement berarti seluruh APR-001 belum pernah menyala sekali pun, bukan sekadar jarang dipakai.
- 0 periode payroll berarti PAY-003 belum pernah menghitung apa pun di production; 5.202 `payslips` seluruhnya berasal dari impor historis PAY-001.
- 932.271 baris `attendance_adms_request_journal` berbanding 2.855 `attendance_events`: jurnal itu log permintaan mentah mesin, bukan ukuran pemakaian oleh manusia.
- `attendance_biometric_credentials` = 0 **adalah kebijakan, bukan celah** (lihat §7 butir L15).

## 4. Garis rilis: apa yang di `main` tetapi belum di production

Production berhenti di `127b6068`. Semua yang di-merge sesudahnya **belum ada di production**.

| PR | Commit merge | Isi | Status |
|---|---|---|---|
| #390 | `2560b04f` | PERF-001 jalur keberatan kinerja (migrasi 0176) | Selesai belum dirilis |
| #387 | `7df37cf3` | PERF-001 rubrik berversi per kelompok jabatan + siklus semesteran (migrasi 0175) | Selesai belum dirilis |
| #384 | `64fe64bf` | LOAN-002 rantai persetujuan kasbon berbasis kursi (migrasi 0177, 0178) | Selesai belum dirilis |
| #389 | `89a096e2` | TRIP-002 tarif uang saku per SK 01.111/YSQ/VII/2026 (migrasi 0172) | Selesai belum dirilis |
| #386 | `61d05a9b` | LEAVE-009 C1 masa kritis tanpa tinjauan HC, TRIP-001 C4 dinas mundur 7 hari, NOTIF-003 D18 jendela pengingat 04.00–23.00 (migrasi 0174) | Selesai belum dirilis |
| #385 | `127b6068` | Spesifikasi PAY-004 dan REIMB-002 (dokumen saja) | **Ini batas production** |

Masih terbuka:

| PR | Isi | Status |
|---|---|---|
| #383 | ADR-0008 — Pengurus Yayasan membaca gaji per orang | **Belum selesai**: `CONFLICTING`, menunggu owner. Migrasinya masih bernomor `0168_governance_payroll_reader.sql`, nomor yang sudah dipakai ulang di `main`, jadi perlu penomoran ulang sebelum merge |
| #391 | LOAN-002 jalur tulis pemetaan kursi persetujuan | **Belum selesai**: `CONFLICTING`, sedang diperbaiki |

### Migrasi

| | |
|---|---|
| Di bundel rilis production `127b6068` | 145 berkas `.sql`, tertinggi **`0167_payroll_thr_non_permanent.sql`**; yang baru diterapkan pada rilis itu hanya `0166_leave_decision_request_id` |
| Di `origin/main` sekarang | 151 berkas `.sql` |
| **Belum ada di production** | `0172_trip_per_diem_decree`, `0174_leave_critical_review_retired`, `0175_performance_rubric_versions`, `0176_performance_objection`, `0177_approval_seat_registry`, `0178_employee_loan_approval_principals` — enam migrasi |

Nomor 0168–0171 dan 0173 tidak ada di `main`: nomor-nomor itu terpakai lalu dinomori ulang saat rebase (riwayatnya masih terbaca di `eb7cb663`, `b5b38cc1`, `8cc03998`, `ee70b7e2`). Identitas migrasi adalah nama berkas penuh, bukan awalannya (`apps/api/migrations/production-history-manifest.json`), jadi lompatan nomor bukan masalah selama tidak ada nama berkas yang dipakai ulang.

## 5. Cakupan wajib pra-pembukaan

Butir di bagian ini adalah yang harus benar sebelum ~97 pegawai diberi akses. Butir di luar itu ada di §7 dan **tidak** boleh ditarik ke sini.

| # | Butir | Status |
|---|---|---|
| W1 | Atasan langsung untuk 95 pegawai | Dirilis belum aktif |
| W2 | Penyetuju cuti per unit | Belum terverifikasi |
| W3 | Akun untuk 97 pegawai | Dirilis belum aktif |
| W4 | Cuti dan izin (LEAVE-001/002/008/009/010, APR-001) | Dirilis belum aktif |
| W5 | Penyerapan kehadiran dari mesin ADMS | Sudah diuji |
| W6 | Layanan kehadiran di atas penyerapan (ATT-002/007/008/015) | Dirilis belum aktif |
| W7 | Clock In/Out mobile (ATT-006) | Aktif belum diuji |
| W8 | Slip gaji pegawai (PAY-001/PAY-002) | Aktif belum diuji |
| W9 | Notifikasi in-app dan WhatsApp (NOTIF-003/004) | Aktif belum diuji |
| W10 | Isi Pengumuman dan Pusat Bantuan (NOTIF-002, HELP-001) | Dirilis belum aktif |
| W11 | Perilaku modul yang belum siap saat pintu dibuka | Belum selesai |
| W12 | Cadangan dan pemulihan | Aktif belum diuji |
| W13 | Keamanan dan matriks izin | Belum terverifikasi |
| W14 | Kepemilikan operasional, insiden, stop, rollback | Belum selesai |
| W15 | Merilis `main` ke production | Selesai belum dirilis |

### W1 — Atasan langsung untuk 95 pegawai

| | |
|---|---|
| **Status** | **Dirilis belum aktif.** Kolom, layar, dan resolvernya ada di production; datanya tidak ada, jadi rantai persetujuan tidak melakukan apa pun. |
| **Bukti bertanggal** | Pengukuran owner 2026-11-20: 95 dari 97 pegawai aktif tanpa `direct_manager_employee_id`. Kode: `resolveLeaveLineApprovalChain` melempar `DIRECT_MANAGER_MISSING` bila kolom kosong (`apps/api/src/modules/leave/domain/approval-chain.ts`); mode resolusi jatuh ke `LEGACY` karena `organization_rollout_settings` kosong (`apps/api/src/modules/organization/repository.ts:750`). HCIS sendiri sudah melaporkan angka ini sebagai metrik `without_direct_manager` di ringkasan Portal Organ (`apps/api/src/modules/governance/summary.ts:181`). |
| **Penghambat** | Tidak ada jalur isi massal. EMP-004 tidak membawa kolom atasan. Satu-satunya jalur tulis adalah `PATCH /admin/employees/:employeeId/manager`, satu pegawai per panggilan, izin `approvals.policy.manage`. Siapa atasan siapa adalah keputusan organisasi, bukan keputusan teknis, dan belum ada di dokumen mana pun di repository ini. |
| **Langkah berikutnya** | (1) HC menetapkan atasan langsung untuk 95 pegawai, per unit, memakai daftar pegawai per unit di §3 sebagai kerangka. (2) Isi lewat layar HC; bila owner memilih jalur SQL massal, itu **perubahan data production** dan wajib dry-run bersih serta jalur rollback yang jelas (AGENTS.md §2). (3) Pegawai yang memang tidak punya atasan (mis. Ketua Yayasan) ditangani eksplisit, bukan dibiarkan kosong. |
| **Kriteria selesai** | Metrik `without_direct_manager` pada `GET /governance/summary` bernilai **0**, atau setiap sisa punya alasan tertulis yang diterima owner, dan satu pengajuan cuti nyata dari pegawai di tiap unit berhasil melewati langkah atasan. |

### W2 — Penyetuju cuti per unit

| | |
|---|---|
| **Status** | **Belum terverifikasi.** Jumlah unit tanpa `leave_approver_employee_id` tidak diukur pada 2026-11-20. |
| **Bukti bertanggal** | Tidak ada bukti production bertanggal untuk butir ini. Yang diketahui: resolver `LEGACY` menuntut **keduanya** — atasan langsung dan penyetuju unit; tanpa penyetuju unit, pengajuan ditolak `UNIT_APPROVER_MISSING` ("Kepala Satuan Kerja / Unit Approver belum dikonfigurasi", `apps/api/src/modules/leave/organization-authority.ts`). Penyetuju dihitung ada hanya bila orangnya `active` dan masih dikelola HCIS (`apps/api/src/modules/board/aggregates.ts`). |
| **Penghambat** | Belum diukur. Mengisi atasan langsung saja tidak cukup: bila unit tidak punya penyetuju, pengajuan tetap gagal tertutup. |
| **Langkah berikutnya** | Baca metrik `units_without_approver` pada `GET /governance/summary` dengan akun Organ Yayasan (jalur baca yang sudah menyala, tidak perlu SQL), lalu isi penyetuju untuk setiap unit yang kosong dari 9 unit berpegawai aktif di §3. |
| **Kriteria selesai** | `units_without_approver` bernilai 0 dan pengajuan uji di setiap unit melewati langkah penyetuju unit. |

### W3 — Akun untuk 97 pegawai

| | |
|---|---|
| **Status** | **Dirilis belum aktif.** Alur aktivasi ada di production; 93 pegawai belum punya akun aktif. |
| **Bukti bertanggal** | Pengukuran owner 2026-11-20: 4 akun `active` total, 1 di antaranya `EMPLOYEE`. Pada 2026-10-16 OPS-READY-001 mencatat 4 `active`, 75 `invited`, 2 `inactive`; berapa yang `invited` hari ini tidak diukur. Jalur undangan lewat SQ Hub dipasang 2026-11-04 (`production-release-verification-2026-11-04-b28efeef.md`: `STAFF_ACTIVATION_ALLOWED_CLIENTS=hcis-api`, `HCIS_STAFF_VERIFY_BASE_URL` diperbaiki). |
| **Penghambat** | Undangan AUTH-002 berumur **14 hari** (`docs/domain/account-activation.md` §5, asumsi `DRAFT`); undangan dari Oktober hampir pasti kedaluwarsa dan harus dikirim ulang. Aktivasi menuntut email pegawai terisi — pegawai tanpa email ditolak `409 EMPLOYEE_EMAIL_MISSING` sebelum SQ Hub dipanggil. Kelengkapan email 97 pegawai belum diukur. OPS-READY-001 P9 (pemulihan kata sandi / fallback manual) masih **MISSING**. |
| **Langkah berikutnya** | (1) Hitung akun per status dan pegawai aktif tanpa email. (2) Lengkapi email yang kosong. (3) Kirim undangan bergelombang per unit, bukan 97 sekaligus, supaya kegagalan terbaca. (4) Putuskan jalur pemulihan kata sandi (P9) sebelum gelombang pertama, karena 97 orang akan lupa kata sandi. |
| **Kriteria selesai** | Setiap pegawai aktif yang harus memakai HCIS punya akun `active`, jalur reset kata sandi tertulis, dan satu gelombang penuh (satu unit) sudah masuk tanpa tiket terbuka. |

### W4 — Cuti dan izin

| | |
|---|---|
| **Status** | **Dirilis belum aktif.** Seluruh LEAVE-001/002, LEAVE-008 penundaan, LEAVE-009 masa kritis, LEAVE-010 pembatalan, dan APR-001 ada di production, tetapi tidak melakukan apa pun karena W1–W3. |
| **Bukti bertanggal** | Pengukuran owner 2026-11-20: `leave_requests` = 0 sepanjang umur sistem. OPS-READY-001 sudah mencatat 0 pada 2026-10-16 dengan kalimat yang sama: "no real leave workflow use yet". Satu bagian LEAVE-009 (C1, masa kritis tanpa tinjauan HC) ada di PR #386 dan **belum dirilis**. |
| **Penghambat** | W1, W2, W3. Tidak ada penghambat kode yang diketahui. |
| **Langkah berikutnya** | Setelah W1–W3: satu pengajuan cuti nyata per unit, melewati seluruh rantai sampai keputusan, dengan tanggal dan nomor pengajuannya dicatat. |
| **Kriteria selesai** | Minimal satu pengajuan per unit berpegawai aktif selesai disetujui atau ditolak, saldo cuti berubah sesuai LEAVE-002, dan notifikasi penyetuju sampai (W9). Status naik ke **Sudah diuji** hanya dengan bukti bertanggal itu. |

### W5 — Penyerapan kehadiran dari mesin ADMS

| | |
|---|---|
| **Status** | **Sudah diuji**, dengan batas yang disebutkan di bawah. Ini satu-satunya alur HCIS yang benar-benar berjalan dengan data nyata. |
| **Bukti bertanggal** | Pengukuran owner 2026-11-20: 932.271 baris `attendance_adms_request_journal`, 2.855 `attendance_events`, 2.127 `attendance_daily_records`, 93 `attendance_schedule_assignments`. OPS-READY-001 2026-10-16: 2 perangkat ADMS, 438 punch dalam 7 hari. Bukti canary fisik: `docs/development/attendance-adms-physical-canary-evidence.md`; ledger paritas ATT-005 mencatat 7 baris fisik terverifikasi (`docs/domain/attendance-wdms-full-physical-parity-ledger.md`). |
| **Penghambat** | Paritas fisik baru 7 baris; sisanya menunggu sesi di lokasi yang disetujui owner (`docs/operations/adms-physical-verification-checklist.md`). Jumlah perangkat hari ini belum diukur ulang. 93 penugasan jadwal untuk 97 pegawai aktif menyisakan selisih yang belum dijelaskan. |
| **Langkah berikutnya** | (1) Ukur ulang jumlah perangkat ADMS aktif dan punch 7 hari terakhir. (2) Jelaskan selisih 97 pegawai aktif vs 93 penugasan jadwal. (3) Jadwalkan sesi verifikasi fisik untuk sisa baris ledger. |
| **Kriteria selesai** | Setiap pegawai aktif yang wajib absen punya penugasan jadwal, dan sisa baris ledger paritas berstatus `verified` atau diputuskan owner untuk dilewati. |

### W6 — Layanan kehadiran di atas penyerapan

| | |
|---|---|
| **Status** | **Dirilis belum aktif.** Klarifikasi ATT-002, lembur ATT-007, tukar shift ATT-008, serta tugas luar/WFH ATT-015 ada di production tetapi memakai rantai persetujuan yang sama dengan W1. |
| **Bukti bertanggal** | Kode: `attendance/overtime-approver.ts` memakai `workflowKey: "OVERTIME"` dan membaca `direct_manager_employee_id`; `attendance/work-arrangement-routes.ts` memakai resolver bersama. Spesifikasi sudah menyebut risikonya sejak awal: `docs/domain/attendance-operational-simplification-spec.md` §890 menulis bahwa bila data atasan belum lengkap, "pengajuan lembur pegawai tanpa atasan gagal tertutup (422) dan HC harus melengkapi data struktur lebih dulu". |
| **Penghambat** | W1, W2, W3. |
| **Langkah berikutnya** | Setelah W1: satu pengajuan lembur dan satu klarifikasi nyata, lalu satu pengajuan tugas luar/WFH, masing-masing sampai keputusan. |
| **Kriteria selesai** | Satu contoh per jenis pengajuan selesai dengan bukti bertanggal. |

### W7 — Clock In/Out mobile (ATT-006)

| | |
|---|---|
| **Status** | **Aktif belum diuji.** Saklarnya menyala di production sejak 2026-11-04; belum ada bukti satu pun punch mobile nyata. |
| **Bukti bertanggal** | `docs/development/production-release-verification-2026-11-04-e402c38a.md`: `MOBILE_ATTENDANCE_ENABLED=1` ditambahkan ke `/srv/hcis/shared/final.env` pada 2026-11-04 16:5x UTC, keyring media terbatas sudah ada, `BIOMETRIC_COLLECTION_ENABLED` tetap kosong. Sebelum itu Clock In/Out menjawab `runtime_disabled`. |
| **Penghambat** | Hanya 1 akun `EMPLOYEE` aktif, jadi praktis tidak ada yang bisa mencobanya. Kebijakan retensi/purge foto **belum ditetapkan** dan implementasi sengaja tidak mengarang angka retensi serta belum menambahkan auto-purge (`docs/domain/attendance-engine-mobile.md`). Membuka ke 97 orang berarti foto kehadiran mulai menumpuk tanpa aturan hapus. |
| **Langkah berikutnya** | (1) Owner menetapkan retensi foto kehadiran sebelum pembukaan, atau menerima secara tertulis bahwa foto disimpan tanpa batas untuk sementara. (2) Uji satu clock in dan satu clock out nyata di lokasi kerja. |
| **Kriteria selesai** | Satu pasang punch mobile nyata tercatat dengan bukti GPS dan foto, dan aturan retensi tertulis. |

### W8 — Slip gaji pegawai (PAY-001/PAY-002)

| | |
|---|---|
| **Status** | **Aktif belum diuji.** Datanya ada dan jalurnya hidup, tetapi dengan 1 akun `EMPLOYEE` aktif praktis belum ada pegawai yang membaca slipnya sendiri. |
| **Bukti bertanggal** | Pengukuran owner 2026-11-20: 5.202 `payslips`, seluruhnya impor historis. OPS-READY-001 2026-10-16 mencatat angka yang sama (5.202) dan menyimpulkan HCIS hidup terutama untuk "payslip reading and attendance ingest". |
| **Penghambat** | W3. Selain itu, PAY-001/PAY-002 tetap jalur slip resmi sampai owner menutup parallel run PAY-003 (AGENTS.md §5) — jadi yang dibuka ke pegawai adalah slip impor, bukan hasil hitung. |
| **Langkah berikutnya** | Setelah gelombang akun pertama: minta beberapa pegawai membuka slipnya dan memastikan isinya cocok dengan slip kertas bulan yang sama. |
| **Kriteria selesai** | Minimal satu pegawai per unit mengonfirmasi slipnya benar, dengan tanggal konfirmasinya dicatat. |

### W9 — Notifikasi in-app dan WhatsApp

| | |
|---|---|
| **Status** | **Aktif belum diuji** untuk pengiriman nyata di luar daftar izin. |
| **Bukti bertanggal** | `docs/development/production-release-verification-2026-11-11-c78e8b6b.md`: `final.env` berisi `WHATSAPP_ADAPTER=kirim` dan `WHATSAPP_RECIPIENT_MODE=allowlist`, sehingga WhatsApp nyata hanya sampai ke NIP yang ada di daftar izin. `final.env` tidak berubah sejak 2026-11-13 15:35 WIB (`production-release-verification-2026-11-17-ee273bc5.md`). Runner pengingat berjalan di dalam proses API (`MEETING_RUNNER_ENABLED` tidak ada → menyala) dan `api.log` tidak menunjukkan kegagalan tick sejak 2026-11-02 (`production-release-verification-2026-11-02-78eadd09.md`). |
| **Penghambat** | Daftar izin adalah pengaman yang benar selama HCIS pra-pembukaan (NOTIF-001 ditutup dengan catatan itu, `docs/domain/reminders.md` §8). Melepasnya ke 97 orang adalah keputusan tersendiri: sepuluh aturan pengingat NOTIF-003 masih berstatus `DRAFT`, dan jendela pengingat 04.00–23.00 (D18) ada di PR #386 yang **belum dirilis**. Email memang tidak dibangun (D-10 `DRAFT`). |
| **Langkah berikutnya** | (1) Rilis #386 supaya jendela pengingat berlaku sebelum pesan mulai mengalir. (2) Owner menyetujui sepuluh aturan pengingat atau mematikan yang belum disetujui. (3) Lepas daftar izin satu unit lebih dulu, bukan seluruh yayasan. |
| **Kriteria selesai** | Satu unit menerima notifikasi nyata selama satu minggu penuh tanpa keluhan pesan salah sasaran atau salah jam, lalu daftar izin dilepas bertahap. |

### W10 — Isi Pengumuman dan Pusat Bantuan

| | |
|---|---|
| **Status** | **Dirilis belum aktif.** Fiturnya ada; isinya dikirim sebagai draf untuk ditinjau HC sebelum terbit. |
| **Bukti bertanggal** | `docs/product/hcis-capability-map.md` §9: "The initial content ships as drafts for HC to review before publishing". Apakah HC sudah menerbitkannya belum diukur. |
| **Penghambat** | 97 orang yang masuk pertama kali akan mencari penjelasan; pusat bantuan kosong atau berisi draf membuat beban jatuh ke HC lewat WhatsApp pribadi. |
| **Langkah berikutnya** | HC meninjau dan menerbitkan isi HELP-001 untuk layanan yang benar-benar dibuka (cuti, kehadiran, slip gaji), dan menulis satu pengumuman pembukaan. |
| **Kriteria selesai** | Topik bantuan untuk setiap layanan yang dibuka berstatus terbit, dan pengumuman pembukaan tayang. |

### W11 — Perilaku modul yang belum siap saat pintu dibuka

| | |
|---|---|
| **Status** | **Belum selesai.** Belum ada keputusan tertulis tentang apa yang dilihat 97 pegawai untuk modul yang dirilis tetapi belum siap dipakai. |
| **Bukti bertanggal** | Kasbon, reimbursement, perjalanan dinas, kinerja, pelatihan, kartu pegawai, kepanitiaan, dan kalender semuanya **ada di production** (§7). Semuanya memakai rantai persetujuan W1 atau data master yang masih kosong. `docs/product/hcis-capability-map.md` "Coming-soon rule" mensyaratkan status ditampilkan dengan jujur dan tidak ada data operasional palsu — tetapi aturan itu ditulis untuk layar yang belum dibangun, bukan untuk layar yang sudah dibangun dan akan gagal tertutup. |
| **Penghambat** | Tanpa keputusan ini, pembukaan menghasilkan menu penuh yang sebagian besar menjawab 422/409. Itu merusak kepercayaan pada sistem lebih lama daripada menu yang lebih pendek. |
| **Langkah berikutnya** | Owner memutuskan satu dari dua: (a) buka hanya menu yang W1–W10 sudah tutup (kehadiran, cuti, slip gaji, notifikasi, bantuan) dan sembunyikan sisanya sampai siap; atau (b) buka semuanya dengan label "belum dibuka" yang jujur di tiap modul. Rekomendasi: (a), karena lebih sedikit yang harus dijelaskan ke 97 orang. |
| **Kriteria selesai** | Keputusan tertulis di catatan go-live (OPS-GOLIVE-001), dan layar yang dibuka cocok dengan keputusan itu. |

### W12 — Cadangan dan pemulihan

| | |
|---|---|
| **Status** | **Aktif belum diuji** untuk skema hari ini. Latihan restore terakhir yang terbukti berasal dari 2026-10-16. |
| **Bukti bertanggal** | OPS-READY-001 gate P5 **DONE** dengan latihan restore terisolasi PASS 2026-10-16 (`docs/operations/hcis-restore-drill-2026-10-16.md`), 6/6 smoke check, 48 detik. Backup pra-rilis tetap diambil tiap rilis; yang terakhir `/srv/hcis/backups/pre-release/hcis-127b6068-20261118-20261118T090447Z.dump` (2026-11-18). |
| **Penghambat** | Latihan itu mendahului migrasi `0124`-an sampai `0167` yang kini ada di production. OPS-READY-001 sendiri menulis kriteria "Repeat after major schema changes". Gate R5 masih **PARTIAL**: pemulihan dari **kehilangan ponsel** (salinan Drive ke host lain, bundel rahasia) belum pernah diuji. |
| **Langkah berikutnya** | (1) Ulangi latihan restore terisolasi pada skema `0167`. (2) Jalankan satu latihan pemulihan di luar host sebelum 97 orang mulai menulis data nyata. |
| **Kriteria selesai** | Latihan restore pada skema terkini PASS dan tercatat, dan latihan di luar host PASS sekali. |

### W13 — Keamanan dan matriks izin

| | |
|---|---|
| **Status** | **Belum terverifikasi** untuk sisa temuan. |
| **Bukti bertanggal** | OPS-READY-001 gate R2 **PARTIAL** per 2026-10-16: 0 Critical; SEC-16 dan SEC-02 diperbaiki, SEC-01 risikonya diterima owner; SEC-05, SEC-06, dan bagian API SEC-07 diperbaiki dan hidup di `hcis-081ba89e-20261022` (2026-10-23); **bagian SPA/edge SEC-07 masih terbuka** pada tanggal itu. Apakah sudah ditutup sesudahnya tidak terbaca dari repository. |
| **Penghambat** | Matriks izin AUTH-011 pernah melewatkan 51 rute dan test matriksnya pernah dilewati di CI (SEC-02/03, diperbaiki #107 pada 2026-10-16). Membuka ke 97 orang memperbesar akibat setiap lubang izin yang tersisa. |
| **Langkah berikutnya** | (1) Periksa status SEC-07 bagian SPA/edge. (2) Jalankan ulang review keamanan terhadap rute yang ditambahkan sejak 2026-10-16 — PAY-003, EMP-011, ORG-013/014/015, LOAN, REIMB, TRIP-002, PERF — karena semuanya menyentuh izin, audit, atau data gaji. |
| **Kriteria selesai** | Tidak ada temuan High terbuka, setiap Medium diperbaiki atau diterima tertulis di catatan go-live, dan test matriks izin hijau di CI. |

### W14 — Kepemilikan operasional, insiden, stop, dan rollback

| | |
|---|---|
| **Status** | **Belum selesai.** |
| **Bukti bertanggal** | OPS-READY-001 gate P6 **MISSING** per 2026-10-16: peran hanya disebut sebagai placeholder, tidak ada kanal peringatan (OPS-MI8-BAK-001 §8), RPO/RTO masih `TBD`. Gate R3 **PARTIAL**: operator dan owner ada secara de facto lewat persetujuan rilis di chat, bukan sebagai peran bernama dengan cadangan. |
| **Penghambat** | Selama HCIS tidak punya pengguna, tidak ada yang terdampak bila ia mati. Begitu 97 orang memakainya untuk absen dan cuti, "siapa yang dihubungi saat sistem mati" menjadi pertanyaan nyata, dan jawabannya belum tertulis. |
| **Langkah berikutnya** | Owner mengisi `docs/operations/go-live-decision-record-template.md` §2 dan §4: nama pemilik insiden dan cadangannya, kanal peringatan, RPO/RTO, serta siapa yang berwenang menghentikan dan me-rollback. |
| **Kriteria selesai** | Catatan go-live terisi dan ditandatangani; satu uji kanal peringatan berhasil. |

### W15 — Merilis `main` ke production

| | |
|---|---|
| **Status** | **Selesai belum dirilis.** Enam PR dan enam migrasi menunggu. |
| **Bukti bertanggal** | §4. Production berhenti di `127b6068` sejak 2026-11-18 16:05 WIB. |
| **Penghambat** | Dua di antaranya menyentuh perilaku yang relevan untuk pembukaan: #386 (jendela pengingat 04.00–23.00, masa kritis cuti tanpa tinjauan HC) dan #389 (tarif uang saku). Empat migrasi dari rantai LOAN-002/PERF-001 membawa tabel baru yang belum pernah ada di production. |
| **Langkah berikutnya** | Rilis `main` lewat OPS-MI8-REL-001 dengan pengaman teknis yang biasa: dry-run bersih, backup sebelum migrasi, gate kandidat, rollback bila verifikasi gagal, tidak pada jam 19 UTC, laporan sesudahnya. Keenam migrasi diterapkan dalam satu rilis. |
| **Kriteria selesai** | Catatan `production-release-verification-<tanggal>-<sha>.md` baru dengan `verify OK` dan migrasi tertinggi `0178`. |

## 6. Saklar fitur: apa yang mati dan apa yang menunggu di baliknya

`final.env` tidak berubah sejak **2026-11-13 15:35 WIB** (2462 byte, `production-release-verification-2026-11-17-ee273bc5.md`).

| Saklar / kebijakan | Keadaan di production | Yang menunggu di baliknya |
|---|---|---|
| `MOBILE_ATTENDANCE_ENABLED` | `1` sejak 2026-11-04 | — (menyala; lihat W7) |
| `WHATSAPP_ADAPTER` / `WHATSAPP_RECIPIENT_MODE` | `kirim` / `allowlist` sejak 2026-11-11 | Pengiriman nyata ke seluruh pegawai (W9) |
| `GOVERNANCE_SUMMARY_ALLOWED_CLIENTS` | `sq-hub,sq-organ` sejak 2026-11-13 | — (Portal Organ R1 menyala) |
| `BIOMETRIC_COLLECTION_ENABLED` | **Tidak ada → mati.** Ini kebijakan, bukan celah | Pengumpulan template biometrik ATT-005, yang menunggu gate keamanan, retensi, dan manajemen kunci tersendiri |
| `GOVERNANCE_DECISIONS_ENABLED` | Tidak ada → mati (default `false`) | ORG-015: anggota organ memutuskan langkah persetujuan dari Portal Organ (R2) |
| `LOAN_PAYROLL_DEDUCTION_ENABLED` | Tidak ada → `0` (dipastikan 2026-11-17) | LOAN-001 Paket 2: potongan angsuran otomatis lewat payroll; menunggu PAY-003 menjadi jalur slip resmi |
| `REIMBURSEMENT_PAYROLL_HANDOFF_ENABLED` | Tidak ada → `0` (dipastikan 2026-11-13 dan 2026-11-17) | REIMB-001 §9: penyerahan reimbursement ke payroll; menunggu hal yang sama |
| `TRAINING_ONLINE_ENABLED` | Tidak ada → `0` (dipastikan 2026-11-17) | TRAIN-001 R4: modul daring dengan video; menunggu kapasitas media disediakan |
| `QURAN_SCOREBOARD_URL` + `QURAN_MACHINE_*` | Tidak ada satu pun kunci `QURAN_*` (dipastikan 2026-11-17) | REWARD-001: kandidat penghargaan dari papan nilai tilawah Al-Qur'an; sementara HC boleh impor CSV bulanan (`DRAFT`) |
| `ASET_SQ_PERSON_CUSTODY_URL` + `ASET_SQ_MACHINE_*` | Tiga kunci ada, tidak berubah (dipastikan 2026-11-17) | ASSET-001 dinyatakan "switched off in production" di peta kapabilitas sampai klien Keycloak `hcis-aset-custody`, flag dan jalur privat di Aset SQ siap. **Belum terverifikasi** apakah yang kurang tinggal di sisi Aset SQ |
| `ORGAN_PORTAL_URL` | Belum terverifikasi | Tautan dari HCIS ke Portal Organ |
| `ORG_DIRECTORY_EXPORT_ENABLED` | Belum terverifikasi (peta kapabilitas menyatakan ekspor menyala dan ditarik platform; tidak ada catatan rilis yang menyebut kuncinya) | ORG-006 Direktori Organisasi |
| `HCIS_ROLE_ADMIN_ENABLED` | Bukan `1` per 2026-11-01 → rute menjawab `503` | AUTH-014 fase F5: administrasi peran lewat kanal SQ Hub |
| `STAFF_IDENTITY_VERIFY_ENABLED` | Belum terverifikasi | Verifikasi identitas staf saat aktivasi |

### Kebijakan payroll yang belum punya versi

`payroll_policy_versions` punya satu versi untuk seluruh sebelas kunci wajib (`POLICY_KEYS` di `apps/api/src/modules/payroll/policy.ts`) ditambah `VARIANCE_THRESHOLD`, dan dua untuk `THR`. Yang **tidak ada**:

| Kunci | Akibat kekosongannya |
|---|---|
| `PPH21_SETTINGS` | Mesin memakai `DEFAULT_PPH21_SETTINGS`, yaitu "semuanya mati": PPh21 tidak ditanggung yayasan, premi BPJS Kesehatan yang dibayar yayasan tidak dihitung sebagai penghasilan kena pajak, dan TER harian untuk non-tetap mati. **Keputusan owner 2026-11-17 sudah dibangun tetapi belum berlaku di production.** |
| `PPH21_TER` | Tanpa tabel TER yang berlaku pada tanggal gajian, perhitungan menolak bila PPh21 ditanggung yayasan diaktifkan. |
| `PPH21_ANNUAL` | PPh21 tahunan Pasal 17, bukti potong 1721-A1, dan rekap e-Bupot tidak punya dasar. |
| `PAYSLIP_LAYOUT` | Slip memakai tata letak lama; blok "Ditanggung yayasan" yang diputuskan owner 2026-11-17 tidak muncul. |
| `PERFORMANCE_PERCENT` | Opsional menurut kode, tetapi tanpa versinya hasil PERF-001 tidak pernah menjadi tunjangan kinerja. |

Kesimpulannya untuk PAY-003: mesinnya ada di production, tetapi **tidak satu pun keputusan pajak owner 2026-11-17 berlaku di sana**. Itu status **Dirilis belum aktif**, bukan "payroll selesai".

## 7. Pengembangan lanjutan — di luar cakupan pembukaan

Butir di bawah ini **tidak** perlu ditutup sebelum pintu dibuka, selama W11 diputuskan. Daftarnya ada supaya tidak ada yang mengira butir ini sudah beres.

| # | Butir | Status | Bukti bertanggal | Penghambat | Langkah berikutnya | Kriteria selesai |
|---|---|---|---|---|---|---|
| L1 | PAY-003 mesin payroll, PPh21, THR | Dirilis belum aktif | 2026-11-20: 0 `payroll_periods`, 0 `payroll_results`; empat kebijakan PPh21/layout tidak ada (§6) | PAY-001/PAY-002 tetap jalur resmi sampai owner menutup parallel run (AGENTS.md §5); `docs/development/pay003-parallel-run-2026-10.md` | Isi `PPH21_SETTINGS`, `PPH21_TER`, `PPH21_ANNUAL`, `PAYSLIP_LAYOUT`; jalankan satu periode bayangan | Satu periode payroll selesai dan cocok dengan slip jalur lama, lalu owner menutup parallel run |
| L2 | EMP-005/006/010 riwayat kepegawaian | Dirilis belum aktif | 2026-11-20: `employment_rollout_settings` 0 baris → mode `OFF`; 326 `employments`, 96 `employment_placements`. Baseline dimuat 2026-11-03, koreksi 2026-11-04 | Runbook `employment-pilot-activation-runbook.md` langkah 1–7 belum satu pun dijalankan; 115 `BASELINE_END_UNKNOWN` dan 47 `BASELINE_CONTRACT_END_UNKNOWN` saat pemuatan | Jalankan langkah 1–7 runbook, mulai dari backup dan `SHADOW` | Mode `AUTHORITATIVE` dengan tujuh kriteria keluar runbook §7 terpenuhi |
| L3 | ORG-004 `STRUCTURE` dan ORG-013 kursi organ | Dirilis belum aktif | 2026-11-20: `organization_rollout_settings` 0 baris → semua `LEGACY`. OPS-READY-001 2026-10-16: 15 change set PUBLISHED, 3 VALIDATED, 7 DRAFT | Gate P1–P3 dan P10 OPS-READY-001 masih MISSING: unit pilot belum dipilih, SHADOW belum dijalankan, go/no-go belum ditandatangani | Pilih unit pilot, jalankan `SHADOW`, bandingkan dengan `LEGACY`, lalu aktifkan `STRUCTURE` per workflow | Nol ketidakcocokan tak terjelaskan di `SHADOW` dan catatan go/no-go ditandatangani |
| L4 | Portal Organ R1 (ORG-010/ORG-014) | Sudah diuji, sekali | `production-release-verification-2026-11-13-e54353aa.md`: Portal Organ dinyalakan di SQ Hub 2026-11-13 01:33 UTC; pertukaran `azp = sq-organ` terbukti pada sign-in pertama owner sebagai anggota organ (satu baris audit `governance.summary.served`). 2 akun `FOUNDATION_BOARD` aktif per 2026-11-20 | Baru satu sesi nyata; ringkasan yang dibaca organ akan menampilkan "95 pegawai tanpa atasan langsung" sampai W1 ditutup | Minta anggota organ membuka ringkasan setelah W1 selesai | Kedua akun organ pernah membuka ringkasan dan daftar pegawai setelah data atasan terisi |
| L5 | Portal Organ R2 / keputusan organ (ORG-015) | Dirilis belum aktif | `production-release-verification-2026-11-18-127b6068.md`: rute `GET`/`POST /governance/decisions` menjawab `404` selama `GOVERNANCE_DECISIONS_ENABLED` mati; migrasi 0166 hanya menambah satu kolom kosong | Urutan ORGAN-IMPL-001-r2-keycloak §5 baru sampai langkah 4. Langkah 6 (probe `acr` harus bernilai `"2"` setelah pertukaran token) **butuh sesi nyata, jadi langkah owner** dan merupakan gerbang ADR-0012 D4 | Daftarkan `decision_path`/`decision_audience` di Admin Center (langkah 5), jalankan probe (langkah 6), lalu nyalakan kedua flag mulai dari HCIS | `acr` selamat melewati pertukaran token dan satu keputusan organ nyata tercatat |
| L6 | LOAN-001 kasbon dan LOAN-002 rantai kursi | Dirilis belum aktif + Selesai belum dirilis | 2026-11-20: 0 `employee_loans`. LOAN-002 ada di PR #384 (migrasi 0177/0178), belum dirilis; PR #391 jalur tulis pemetaan kursi masih `CONFLICTING` | Rantai `LEGACY` kasbon berdiri di atas W1; kursi persetujuan LOAN-002 belum punya jalur tulis yang di-merge | Selesaikan #391, rilis bersama #384, lalu HC memetakan kursi | Satu pengajuan kasbon nyata melewati rantai kursi sampai pencairan |
| L7 | REIMB-001 reimbursement | Dirilis belum aktif | 2026-11-20: 0 `reimbursement_claims` | W1; penyerahan ke payroll mati di balik `REIMBURSEMENT_PAYROLL_HANDOFF_ENABLED=0` | Setelah W1: satu klaim nyata sampai verifikasi Keuangan dan pembayaran di luar payroll | Satu klaim selesai dibayar dengan bukti bertanggal |
| L8 | REIMB-002 reimbursement pengadaan | **Belum selesai** | `docs/domain/procurement-reimbursement.md` berstatus `DRAFT`; AGENTS.md §5 melarang implementasinya sampai owner menjawab §13. Spesifikasinya masuk production lewat #385 sebagai dokumen saja | Menunggu jawaban owner atas §13 | Owner menjawab §13 | Spesifikasi naik ke ACCEPTED, implementasi dimulai |
| L9 | PAY-004 penjagaan honorarium dari kehadiran | **Belum selesai** | `docs/domain/honorarium-attendance-guard.md` berstatus `DRAFT`; AGENTS.md §5 melarang implementasinya sampai owner menjawab §15 | Menunggu jawaban owner atas §15 | Owner menjawab §15 | Spesifikasi naik ke ACCEPTED |
| L10 | TRIP-001/TRIP-002 perjalanan dinas dan uang saku | Dirilis belum aktif + Selesai belum dirilis | TRIP-002 tarif per SK 01.111/YSQ/VII/2026 ada di PR #389 (migrasi 0172), belum dirilis; mundur 7 hari (D18) ada di PR #386, belum dirilis | W1; tarif uang saku belum ada di production | Rilis #386 dan #389 (W15), lalu HC memasukkan versi tarif | Satu perjalanan dinas nyata dengan uang muka dan penyelesaiannya |
| L11 | PERF-001 kinerja | Dirilis belum aktif + Selesai belum dirilis | Rubrik berversi dan siklus semesteran (#387, migrasi 0175) dan jalur keberatan (#390, migrasi 0176) belum dirilis | W1; `PERFORMANCE_PERCENT` tidak punya versi, jadi hasil kinerja tidak menjadi tunjangan | Rilis #387 dan #390, lalu HC menyusun rubrik | Satu siklus penilaian selesai, termasuk satu keberatan yang diproses |
| L12 | TRAIN-001 modul daring (R4) | Dirilis belum aktif | `TRAINING_ONLINE_ENABLED` tidak ada → `0`, dipastikan 2026-11-17. Kode mewajibkan `TRAINING_MEDIA_DIR` bila dinyalakan | Kapasitas media di Mi8VPS belum disediakan | Sediakan direktori media dan kapasitas, lalu nyalakan | Satu modul daring ditonton sampai selesai oleh pegawai nyata |
| L13 | ASSET-001 aset pegawai | Dirilis belum aktif | Peta kapabilitas: dimatikan di production sampai klien Keycloak `hcis-aset-custody`, flag dan jalur privat Aset SQ, serta pengaturan `ASET_SQ_*` HCIS siap. Tiga kunci `ASET_SQ_*` ada di `final.env`, tidak berubah per 2026-11-17 | Sisi Aset SQ; **belum terverifikasi** apa tepatnya yang kurang | Periksa di repository Aset SQ apa yang masih kurang | Satu pegawai membuka Asset Saya dan melihat aset nyata |
| L14 | REWARD-001 penghargaan pegawai | Dirilis belum aktif | Tidak ada kunci `QURAN_*` di `final.env` maupun di environment proses API (dipastikan 2026-11-17, jumlah 0) | Al-Qur'an R1 belum menyediakan kontrak snapshot (`rewards.md` §12) | Sementara: HC impor CSV bulanan (`DRAFT`). Permanen: tunggu Al-Qur'an R1 | Satu penghargaan bulanan terbit dengan kandidat dari sumber nyata |
| L15 | ATT-005 pengumpulan biometrik | Dirilis belum aktif — **disengaja** | `BIOMETRIC_COLLECTION_ENABLED` tidak ada di `final.env` (dipastikan 2026-11-04 dan setiap preflight rilis). `mi8vps-hcis-release.md` §67 menjadikan "absen atau `0`" sebagai syarat preflight; OPS-READY-001 gate P7 **DONE** dengan kriteria "Keep checking at each release preflight"; `attendance-adms-capability-matrix.md` dan `attendance-device-admin-verification.md` menyatakan ia tetap OFF sampai gate keamanan, retensi, manajemen kunci, dan perangkat keras terkendali terpenuhi | — | Jangan ubah. Pastikan tetap absen di tiap preflight | Tidak ada; ini keadaan yang dikehendaki. `attendance_biometric_credentials` = 0 adalah **kebijakan yang dipatuhi, bukan celah** |
| L16 | ORG-011 katalog klasifikasi jabatan | Dirilis belum aktif | Roadmap §C, status 2026-11-17: "Katalog production dibiarkan kosong untuk diisi HC. Payroll belum membaca klasifikasi" | PAY-003 belum punya titik sambung (spec §4.1) | HC mengisi katalog bila dan ketika PAY-003 membutuhkannya | Katalog terisi dan resolver dipakai payroll |
| L17 | DOC-003 nomor surat | Dirilis belum aktif — interim | Keputusan owner 2026-11-12: buku nomor surat yayasan pindah ke Sekretariat SQ (SEK-001), menggantikan D-01. Implementasi HCIS berjalan hanya sampai cutover | Menunggu Sekretariat SQ | Jangan kembangkan lebih jauh di HCIS | HCIS membaca buku Sekretariat SQ |
| L18 | ORG-006 Direktori Organisasi | Belum terverifikasi | Peta kapabilitas menyatakan ekspor production menyala dan ditarik platform; tidak ada catatan rilis yang menyebut `ORG_DIRECTORY_EXPORT_ENABLED` | — | Periksa kunci di `final.env` | Keadaan saklar tercatat bertanggal |
| L19 | MIG-002 migrasi dan pembekuan sistem lama | **Belum selesai** | OPS-READY-001 gate R1/R4/R6 **MISSING** per 2026-10-16: belum ada rehearsal, sistem lama bahkan belum teridentifikasi di repository; rencana `docs/migration/legacy-migration-and-freeze-plan.md` berstatus DRAFT/DISCOVERY | Owner belum menyebut sistem lama dan administratornya (D1) | Owner menjawab MIG-002 D1 | Rehearsal cutover berhasil dan rekonsiliasinya cocok |
| L20 | ORG-007 multi legal entity | Ditunda | Peta kapabilitas: DEFERRED atas arahan owner 2026-11-11; ADR-0005 tetap PROPOSED sebagai rujukan | — | Tidak ada | Tidak ada sampai entity kedua benar-benar dibutuhkan |

## 8. Butir yang belum terverifikasi dan cara memeriksanya

Butir berikut tidak dapat dipastikan dari repository pada 2026-11-20. Tidak satu pun dari butir ini boleh dianggap beres sampai diperiksa. Semua pemeriksaan di bawah ini **baca saja**; inspeksi read-only via `ssh mi8vps` / `ssh mi8vps-root` selalu diperbolehkan (AGENTS.md §2).

| # | Yang belum diketahui | Cara memverifikasi |
|---|---|---|
| V1 | Berapa unit tanpa penyetuju cuti aktif (W2) | Buka `GET /governance/summary` dengan akun Organ Yayasan dan baca metrik `units_without_approver`. Tidak perlu SQL — jalur ini sudah menyala sejak 2026-11-13 |
| V2 | Berapa akun `invited` yang masih terbuka, berapa kedaluwarsa, berapa `inactive` (W3) | `SELECT status, principal_type, count(*) FROM accounts GROUP BY 1,2` di dalam `BEGIN READ ONLY … ROLLBACK` |
| V3 | Berapa pegawai aktif tanpa email login (W3) | `SELECT count(*) FROM employees WHERE status='active' AND (email IS NULL OR btrim(email)='')`, read-only |
| V4 | Apakah ada punch mobile ATT-006 nyata sejak 2026-11-04 (W7) | `SELECT source, count(*) FROM attendance_events GROUP BY 1` — kolom `source` bernilai `adms`, `mobile`, atau `manual` (`apps/api/migrations/0046_attendance_workforce_engine.sql`), read-only |
| V5 | Apakah ada pegawai yang benar-benar membuka slip gajinya (W8) | Cari audit event baca slip untuk principal `EMPLOYEE` pada rentang sejak 2026-10-01, read-only |
| V6 | Keadaan `GOVERNANCE_SUMMARY_ENABLED`, `ORG_DIRECTORY_EXPORT_ENABLED`, `STAFF_IDENTITY_VERIFY_ENABLED`, `ORGAN_PORTAL_URL` di production (§6, L18) | Periksa keberadaan kunci di `/srv/hcis/shared/final.env` **berdasarkan nama kunci saja, tanpa membaca nilainya**, sebagaimana dilakukan di catatan rilis 2026-11-13 dan 2026-11-17 |
| V7 | Apakah bagian SPA/edge SEC-07 sudah ditutup sejak 2026-10-16 (W13) | Baca `docs/operations/hcis-security-review-2026-10-16.md` dan telusuri PR yang menyebut SEC-07 setelah 2026-10-23 |
| V8 | Apakah latihan restore pernah diulang setelah skema `0167` (W12) | Cari berkas `docs/operations/hcis-restore-drill-*.md` bertanggal setelah 2026-10-16 |
| V9 | Berapa pegawai aktif yang `management_scope <> 'MANAGED'` ("di luar pengelolaan HCIS") | `SELECT management_scope, count(*) FROM employees WHERE status='active' GROUP BY 1`, read-only. Angka ini mengubah penyebut W1: catatan BUMY dan Pengurus Yayasan memang sengaja ditandai di luar pengelolaan |
| V10 | Berapa role assignment HC yang ada sekarang | OPS-READY-001 mencatat hanya 2 pada 2026-10-16 (1 Human Capital, 1 Human Capital Administrator). hitung `account_role_assignments` yang masih berlaku, digabung ke `roles`, read-only. Dua orang tidak cukup untuk melayani 97 pegawai |
| V11 | Siapa saja yang ada di daftar izin WhatsApp (W9) | Periksa nilai daftar izin di `final.env` lewat operator; jangan salin nomor atau NIP ke dokumen mana pun |
| V12 | Apakah isi HELP-001 sudah terbit atau masih draf (W10) | Buka layar admin Pusat Bantuan dengan akun HC, atau hitung baris berstatus terbit, read-only |
| V13 | Berapa perangkat ADMS aktif dan berapa punch dalam 7 hari terakhir (W5) | Read-only `count(*)` pada tabel perangkat dan `attendance_events` dengan filter tanggal, seperti pada OPS-READY-001 §1 |
| V14 | Mengapa 93 penugasan jadwal untuk 97 pegawai aktif (W5) | Bandingkan daftar pegawai aktif dengan `attendance_schedule_assignments`, read-only; empat selisih itu bisa jadi pegawai yang memang tidak absen |
| V15 | Apa yang masih kurang di sisi Aset SQ untuk ASSET-001 (L13) | Periksa repository Aset SQ: klien Keycloak `hcis-aset-custody`, flag ASQ-004, dan jalur privat |
| V16 | Apakah entri worker untuk penyegaran proyeksi kepegawaian sudah ada (L2) | Baca `sq-core-worker.sh` di Mi8VPS dan Mi8VPS Platform Runbook; runbook langkah 6 |

## 9. Hubungan dengan dokumen lain

- `docs/operations/hcis-readiness-gates-2026-10-16.md` (OPS-READY-001) tetap berlaku sebagai penilaian gate; dokumen ini tidak menggantikannya. Status gate yang dikutip di sini bertanggal **2026-10-16** dan belum tentu masih sama.
- `docs/operations/go-live-decision-record-template.md` (OPS-GOLIVE-001) adalah tempat keputusan pembukaan ditandatangani; W11, W13, dan W14 bermuara ke sana.
- `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001) adalah satu-satunya jalur rilis; W15 dijalankan lewat itu.
- `docs/product/hcis-capability-map.md` adalah arah produk, bukan bukti implementasi, dan menyatakan itu sendiri di bagian penutupnya. Dokumen ini menyediakan sisi buktinya.
- `docs/development/employment-pilot-activation-runbook.md` adalah runbook L2.

Dokumen ini diperbarui ketika salah satu butirnya berubah status, dengan bukti bertanggal baru. Butir tidak boleh naik status tanpa bukti.
