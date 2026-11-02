# Audit parity HCIS lama → HCIS baru

**Status:** DISCOVERY
**Tanggal:** 2026-11-02
**Related:** `docs/product/feature-parity.yaml`, `docs/product/hcis-capability-map.md`, `docs/migration/legacy-migration-and-freeze-plan.md` (D1)

## Sumber

| Sumber | Versi | Isi |
|---|---|---|
| GitHub `hcysq/hcis-ysq` | `30264ba`, 31 Jul 2026 | Laravel: `routes/web.php`, `routes/careers.php`, `routes/console.php`, `app/Http/Controllers`, `app/Models`, `app/Notifications`, `app/Console/Commands`, `database/migrations`, `config/features.php` |
| GitHub `hcysq/GAS-HCIS` | HEAD Jan 2026 | Apps Script: login PIN, cuti, profil + histori mutasi, slip gaji PDF + WhatsApp Starsender |

Kedua repository hanya dibaca. Semua flag di `config/features.php` legacy default `true` (loans, performance, foundation, trainings, data_change, director, bidang, reimbursement, reminders), jadi modul-modul tersebut aktif di legacy. Legacy sendiri sudah menghapus permanen Quran, Inbox, Tasks, dan GA daily report (migrasi `drop_removed_feature_tables`).

Legacy evidence adalah bukti, bukan kebenaran produk (aturan `feature-parity.yaml`).

## (a) Sudah ada di HCIS baru

| Fitur legacy | Bukti legacy | HCIS |
|---|---|---|
| Login email/Google, reset password, akun nonaktif | `Auth/*`, `GoogleAuthController` | AUTH-001, AUTH-002, AUTH-003 (Akun SQ) |
| Data pegawai, profil, import | `EmployeeController`, `EmployeeImportController`, `ImportHubController` | EMP-001, EMP-002, EMP-004 |
| Usulan perubahan data | `DataChangeRequestController`, `admin/data-changes` | EMP-003 |
| Pendidikan, keahlian | `EmployeeEducation`, `EmployeeSkill`, `profile/educations|skills` | EMP-007, EMP-008 |
| Histori mutasi (GAS) | `Profile.js logProfilMutation_` | EMP-006 |
| Unit, jabatan, hierarki, Direktur/Kabid, Plt/delegasi | `UnitController`, `PositionController`, `OrgPositionController`, `PositionDelegation`, `OrganizationTemplate` | ORG-001, ORG-004 (ACTING), ORG-008 |
| Organ yayasan (Pembina/Pengurus/Pengawas), dashboard yayasan | `FoundationSeat`, `FoundationMember`, `YayasanDashboardController` | ORG-010, ORG-003 |
| Role & permission | `RolePermissionController` | AUTH-010 |
| Approval policy berantai, Persetujuan Saya | `ApprovalPolicy*`, `MyApprovalsController` | APR-001 |
| Absensi, foto, lokasi/geofence, fingerprint, webhook | `AttendanceController`, `AttendanceLocation*`, `FingerprintMachine`, `Api/AttendanceWebhookController` | ATT-001, ATT-005, ATT-006, ATT-012 |
| Klarifikasi (lupa absen, koreksi jam) dan izin (terlambat, pulang awal, keluar sementara) | `AttendanceClarification`, `AttendanceException` | ATT-002, ATT-010 |
| Jam kerja, jadwal kerja, libur | `WorkHours`, `WorkSchedule*`, `Holiday` | ATT-003, ATT-013 |
| Lembur termasuk perintah lembur atasan | `OvertimeRequestController` (`overtime/order`) | ATT-007, ATT-011 |
| Monitoring dan ekspor absensi | `AttendanceMonitoringController`, `admin/attendance/export` | ATT-009, ATT-014 |
| Cuti, saldo, jenis cuti, validasi HC | `LeaveRequestController`, `LeaveTypeController`, `LeaveBalance` | LEAVE-001..007 |
| Import payroll, slip gaji, pengaturan slip | `PayrollImportController`, `PayrollController`, `payroll/settings` | PAY-001, PAY-002 |
| Surat keterangan kerja, surat peringatan | `WorkCertificateController`, `WarningLetterController` | DOC-001, DOC-002 |
| Perjalanan dinas | `WorkAssignment` tipe `perjalanan_dinas` | TRIP-001 |
| Pengumuman, broadcast, notifikasi in-app | `AnnouncementController`, `Admin/BroadcastController`, `NotificationController` | NOTIF-002, NOTIF-004 |
| Agenda rapat dan kalender | `AgendaController`, `CalendarController`, `HolidayTarget` | CAL-001 (dibangun) |

## (b) Tercatat tetapi belum dibangun

| Fitur legacy | Bukti legacy | HCIS |
|---|---|---|
| Pinjaman/kasbon dengan cicilan, approval HCM → Keuangan → Yayasan | `Loan`, `LoanInstallment`, `AdminLoanController` | LOAN-001 (kajian paralel) |
| Penilaian kinerja bulanan, aspek berbobot, grade, trend, acknowledge | `PerformanceReview`, `PerformanceAspect` | PERF-001 (kajian paralel) |
| Pelatihan klasik + LMS, check-in QR, form evaluasi, kuis, sertifikat | `Training*`, `Lms*`, `Form*` | TRAIN-001 (kajian paralel) |
| Reimbursement | `ReimbursementController`, `admin/reimbursements` | REIMB-001 (deferred) |
| Pengingat terjadwal + preferensi per pegawai | `DispatchReminders`, `GenerateAttendanceReminders`, `GenerateDomainReminders`, `ReminderPreference` | NOTIF-003 (pertama lewat CAL-001) |
| Notifikasi WhatsApp/email, validasi nomor WhatsApp | `StarsenderService`, `WhatsAppValidationController`, `AdminWhatsAppSettingsController` | NOTIF-001, Kirim SQ (ADR-0011) |
| Kontrak dan SK | (benchmark; legacy hanya dokumen) | EMP-005, EMP-010 |
| Auto-approve klarifikasi/izin yang menggantung 24 jam | `AutoApproveStaleAttendanceCommand` (hourly) | Disebut di ATT-002 `legacy_evidence`; tidak dibawa sampai ada keputusan |
| Migrasi data legacy | — | MIG-001, MIG-002 |

## (c) Belum tercatat sama sekali — entri baru (DISCOVERY)

| ID baru | Fitur | Bukti legacy |
|---|---|---|
| ORG-012 | Kepanitiaan: usul → setujui → aktif → selesai/batal, ketua/sekretaris/bendahara/anggota | `Committee`, `CommitteeMember`, `CommitteeService`, `committees/*` |
| DOC-003 | Penomoran surat keluar umum yayasan, hak akses ambil nomor, cetak, impor/ekspor | `LetterNumber`, `LetterType`, `LetterNumberAccessGrant`, `letter-numbers/*` |
| ATT-015 | Pengajuan tugas luar, WFH/WFA, dan ubah jadwal sendiri | `WorkAssignment` tipe `tugas_luar`, `wfh_wfa`, `perubahan_shift` |
| LEAVE-008 | Penangguhan cuti dengan usulan tanggal pengganti | `LeaveApprovalService::suspend`, `leave/{id}/accept-suspension` |
| LEAVE-009 | Masa kritis (cuti wajib lewat HC) | `CriticalPeriod`, `ApprovalChainBuilder::isCriticalPeriodActive` |
| EMP-011 | Arsip berkas dokumen pegawai (KTP, KK, ijazah, sertifikat) dengan masa berlaku | `EmployeeDocument`, `profile/documents`, `documents/*` |
| RPT-001 | Laporan & ekspor HR (daftar pegawai, cuti, rekap payroll) | `Admin/ReportsController` |
| HELP-001 | Pusat bantuan: FAQ, panduan, kontak | `HelpController` |

## (d) Sengaja tidak dibawa

| Fitur legacy | Bukti legacy | Alasan |
|---|---|---|
| Rekrutmen, portal karier, tes, rubrik | `routes/careers.php`, `JobOpening`, `TestPackage`, `AssessmentRubric`, `rekrutmen-saya` | Aplikasi Karir SQ terpisah (REC-001, keputusan owner 2026-10-16) |
| Aset pegawai | — (legacy tidak punya) | Aset SQ adalah sistem pencatat (ASSET-001) |
| Booking meja | — | WORK-001 dihapus owner 2026-11-02 |
| Portal slip gaji OTP terpisah | `SlipGajiOTPController`, `slipgaji/*` | Diganti login tunggal Akun SQ (PAY-002) |
| Login PIN Apps Script, sesi per perangkat | `GAS-HCIS/Auth.js`, `Session.js` | Diganti Akun SQ |
| Riwayat login, kelola sesi aktif, akun Google unlink | `LoginHistoryController`, `SessionController`, `auth/google/unlink` | Milik Akun SQ / Keycloak, bukan HCIS |
| Backup, restore, log viewer, failed jobs, maintenance, cache, feature flag, system info, file cleanup | `Admin/BackupController`, `LogViewerController`, `FailedJobController`, `AdminToolsController`, `FeatureFlagController`, `FileManagerController`, `DatabaseBackup` | Operasi Mi8VPS (OPS-MI8-REL-001 dan runbook), bukan fitur aplikasi |
| Halaman Welfare Hub dan "Pengajuan Bantuan" | `WelfareController`, `welfare/index.blade.php` | Hanya halaman menu; "Pengajuan Bantuan" tidak pernah dibangun di legacy (Coming Soon) |
| Quran, Inbox/chat, Tasks, GA daily report | `drop_removed_feature_tables` | Sudah dihapus permanen di legacy; chat dan project management di luar scope HCIS |
| Halaman privasi, syarat, tentang yayasan, deskripsi unit | `PolicyController`, `FoundationAboutController`, `unit-kerja/deskripsi` | Konten statis; dapat menjadi bagian HELP-001 atau SQ Hub |
| Preferensi zona waktu per pegawai | `settings/timezone` | HCIS memakai zona waktu organisasi; perlu alasan bisnis sebelum dibawa |

## Catatan

- Perbaikan kecil di file yang sama: `planning_note` EMP-010 di `feature-parity.yaml` diubah menjadi block scalar karena nilai tak berkutip yang memuat `: ` membuat file gagal di-parse YAML.
- Detail legacy untuk PERF-001, TRAIN-001, dan LOAN-001 diserahkan ke sesi kajian masing-masing; spesifikasinya tetap milik sesi tersebut.
