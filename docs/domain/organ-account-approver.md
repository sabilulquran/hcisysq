# ORG-012 — Akun Organ Yayasan sebagai approver struktural

**Status:** ACCEPTED (keputusan owner 2026-11-03). Implementasi belum dimulai.
**Specification:** ORG-012
**Menutup:** gap W-3 di `organization-designer-ux-gap-analysis.md` dan keputusan E di `organization-designer-ux-implementation-plan.md`
**Related:** ORG-004 (`dynamic-organization-structure.md`), APR-001 (`workflows/approval-engine.md`), LEAVE-003-N, ORG-003, ORG-010, GOV-001 (`../product/organ-portal-concept.md`, DRAFT)

## Mengapa

Bagan production memuat jabatan Ketua dan Sekretaris yang dipegang akun Organ Yayasan (`holder_source = ACCOUNT`). Resolver ORG-004 saat ini menolak jabatan semacam itu dengan `INVALID_AUTHORITY_PRINCIPAL`, sehingga aturan yang sudah diputuskan, yaitu cuti Direktur disetujui Sekretaris Yayasan dan Ketua diberi tahu (LEAVE-003-N, ORG-004-O), tidak dapat berjalan di `STRUCTURE`.

Owner memutuskan pada 2026-11-03: **akun Organ Yayasan boleh menjadi approver** pada langkah yang jatuh ke jabatan yang dipegangnya. Keputusan ini tidak menambah aturan bisnis atau mesin baru. Aturan siapa menyetujui apa tetap berasal dari bagan dan spesifikasi workflow yang sudah ada.

## Ruang lingkup

Termasuk:

- resolver struktural boleh menghasilkan principal akun untuk jabatan `ACCOUNT`;
- penyimpanan langkah approval memakai bentuk principal yang sudah ada (`approver_account_id` XOR `approver_employee_id`);
- capability approval untuk akun Organ Yayasan;
- jalur keputusan untuk principal akun (API), yang menjadi dasar tampilan di Portal Organ Yayasan;
- notifikasi oversight ke jabatan `ACCOUNT` (misalnya Ketua diberi tahu).

Tidak termasuk:

- aturan workflow baru. Daftar alur yang melibatkan organ tetap berasal dari spesifikasi masing-masing;
- akses organ ke `/app` atau `/admin`. `FOUNDATION_BOARD` tetap ditolak di sana;
- akses payroll untuk Pengurus. ADR-0003 (amandemen 2026-10-27), ORG-003-F, dan ORG-010-F tetap berlaku;
- aktivasi `STRUCTURE`. ORG-012 hanya berpengaruh bila rollout workflow tersebut sudah `STRUCTURE`, dan aktivasi itu tetap melalui `org004-operational-validation.md`;
- persetujuan akhir MPP di Karir SQ (REC-IMPL-006). Aplikasi itu memakai mesinnya sendiri dan mengikuti keputusan yang sama di repository-nya.

## Aturan

### ORG-012-1 Resolusi jabatan `ACCOUNT`

Saat traversal resolver mencapai jabatan dengan incumbent efektif yang dipegang akun:

1. Akun harus `active`. Akun `suspended`, `inactive`, atau belum aktif dianggap tidak eligible, dan resolver lanjut sesuai `vacancy_policy` jabatan, sama seperti incumbent pegawai yang tidak eligible.
2. Akun harus memegang capability workflow yang diminta (misalnya `leave.approve`) melalui role assignment efektif. Kepemilikan jabatan tidak pernah memberi capability (APR-001, approval principal compatibility).
3. Bila akun tersebut terhubung ke record pegawai aktif (Pengurus bergaji, `EMPLOYEE`), langkah disimpan sebagai `approver_employee_id` pegawai itu. Selain itu langkah disimpan sebagai `approver_account_id`.
4. Larangan self-approval berlaku untuk keduanya. Bila akun terhubung ke pegawai pengaju, resolver memakai fallback yang terdokumentasi atau gagal sebagai configuration error.
5. Aturan duplicate approver APR-001 tetap berlaku antarbentuk principal. Akun dan pegawai yang mewakili orang yang sama dihitung sebagai satu approver.

Kegagalan tetap fail-closed. Tidak ada fallback diam-diam ke `LEGACY`.

### ORG-012-2 Capability akun Organ Yayasan

- Role baru `foundation_board_approver` (label "Penyetuju Organ Yayasan") membawa capability approval yang memang dipakai alur organ. Untuk v1 hanya `leave.approve`, karena hanya cuti Direktur yang saat ini jatuh ke jabatan organ.
- Scope `organization`. Hanya Super Admin yang memberikan, dengan alasan wajib, misalnya nomor SK kepengurusan.
- Role ini tidak membawa `board.read`, data pribadi, atau payroll. Akses baca dasbor tetap lewat ORG-003/ORG-010.
- Capability approval di luar `leave.approve` ditambahkan hanya ketika sebuah spesifikasi workflow menetapkan langkah yang jatuh ke jabatan organ.

### ORG-012-3 Keputusan oleh principal akun

- Principal akun memutuskan langkah miliknya lewat endpoint keputusan khusus organ, bukan lewat route `/app`. Endpoint menerima sesi cookie `/board` dan, setelah Portal Organ Yayasan tersedia, token hasil token exchange dengan audience HCIS seperti `GET /governance/summary` (ORG-010 §3).
- Data yang dikembalikan untuk satu langkah dibatasi pada yang dibutuhkan untuk memutuskan: jenis pengajuan, nama dan jabatan pengaju, periode, alasan, dan riwayat langkah. Tidak ada NIP lengkap, dokumen identitas, atau data payroll.
- Keputusan (setuju, tolak dengan alasan) memakai transisi, audit event, concurrency, dan notifikasi APR-001 yang sudah ada. Tidak ada state baru.
- Tampilan v1 (`DRAFT`): sampai Portal Organ Yayasan tersedia, kotak persetujuan tampil di `/board`. Setelah portal tersedia, `/board` hanya menautkan ke portal.

### ORG-012-4 Notifikasi oversight

Penerima notifikasi oversight (misalnya Ketua setelah cuti Direktur disetujui) boleh berupa jabatan `ACCOUNT`. Penerima disimpan sebagai `account_id` pada notification intent. Notifikasi bersifat informasi dan tidak memberi capability.

## Audit

Tidak ada audit event baru. Event approval dan oversight yang sudah ada mencatat principal akun lewat `actor_account_id`. Pemberian dan pencabutan role `foundation_board_approver` memakai audit role assignment yang ada.

## Data dan migrasi

- Tidak ada kolom baru pada langkah approval. Bentuk `approver_account_id` sudah ada.
- Migrasi menambah role sistem `foundation_board_approver` dan permission mapping-nya. Rollback: hapus assignment, lalu role, lewat migrasi pembalik. Langkah yang sudah tersimpan dengan `approver_account_id` tetap auditable, dan bila akunnya tidak lagi memegang capability, langkah itu dialihkan lewat reassignment APR-001.

## Test wajib

- jabatan `ACCOUNT` dengan akun aktif dan `leave.approve` menghasilkan langkah `approver_account_id`;
- akun tanpa capability, akun suspended, atau akun inactive mengikuti `vacancy_policy` (BLOCK menghasilkan error, CLIMB naik);
- akun yang terhubung ke pegawai menghasilkan `approver_employee_id`;
- self-approval lewat akun yang terhubung ke pengaju ditolak;
- cuti Direktur di `STRUCTURE`: Sekretaris (akun) menyetujui, Ketua (akun) mendapat notification intent, Pembina tidak;
- principal akun tidak bisa memutuskan langkah milik orang lain, dan token tukar tidak diterima di route `/app` atau `/admin`;
- `FOUNDATION_BOARD` tetap 403 di `/app` dan `/admin`;
- mode `LEGACY` tidak berubah perilakunya.

## Acceptance criteria

- ORG-012-A: di `STRUCTURE`, jabatan `ACCOUNT` dengan akun aktif yang memegang capability workflow menghasilkan langkah approval milik akun itu.
- ORG-012-B: kepemilikan jabatan tanpa capability tidak pernah menghasilkan approver.
- ORG-012-C: akun yang terhubung ke pegawai aktif disimpan sebagai principal pegawai, dan larangan self-approval serta duplicate approver berlaku antarbentuk principal.
- ORG-012-D: principal akun memutuskan lewat endpoint organ dengan transisi dan audit APR-001, tanpa akses `/app` atau `/admin`.
- ORG-012-E: role `foundation_board_approver` hanya membawa `leave.approve` di v1 dan tidak memberi `board.read`, data pribadi, atau payroll.
- ORG-012-F: perilaku `LEGACY` dan `SHADOW` tidak berubah.
