# HCIS YSQ MVP

**Status:** VERIFIED COMPLETE  
**Updated:** 2026-08-22  
**Verified application SHA:** `be9967dd38f689139f7af8d44ff053f0ba85d78f`  
**Verification checkpoint:** `docs/product/mvp-release-checkpoint.md`

## Tujuan

MVP membuktikan bahwa HCIS baru memiliki employee master, fondasi akses, approval, attendance factual record, leave workflow, payslip import/read-only access, dan governance boundary yang stabil, dapat dijalankan dari satu repository canonical, serta sudah memberikan nilai self-service dasar kepada pegawai.

MVP tidak mengejar feature parity penuh dengan legacy HCIS dan tidak mencakup production cutover.

## Outcome MVP

### 1. Backend dan real access bootstrap

- API TypeScript berjalan pada local verification dan VPS verification environment.
- PostgreSQL tersedia untuk development, test, dan runtime verification.
- Migration terverifikasi pada clean database dan realistic upgrade path.
- Satu login surface digunakan untuk semua account type dan tidak menampilkan selector role.
- Account type: `EMPLOYEE`, `FOUNDATION_BOARD`, dan `SUPER_ADMIN`.
- Account dan employee record tetap entitas terpisah.
- Super Admin pertama dibootstrap melalui jalur one-time yang fail-closed, bukan public registration.
- Super Admin menggunakan password ter-hash, mandatory MFA, server-side session, secure HttpOnly cookie, dan audit event.
- Landing area mengikuti access model: employee `/app`, Foundation Board `/board`, Super Admin `/admin`.
- Direct URL tidak memberi principal akses ke area principal lain.
- Detail bootstrap mengikuti `docs/security/super-admin-bootstrap.md` dan model akses mengikuti `docs/domain/access-model.md`.

### 2. Employee master + import foundation

- Employee master menggunakan UUID internal dan NIP sebagai natural key import/upsert.
- Import employee menggunakan controlled preview -> confirm flow untuk CSV/XLSX sesuai `docs/domain/employee-import.md`.
- HTTP/admin import berada di belakang authorization backend.
- Import hanya mengambil allowlisted fields dan tidak otomatis membuat account.
- Unit dan position dasar dibentuk dari import; reporting line ditetapkan terpisah.
- Test fixture tetap synthetic dan ignored sensitive fields tidak dipersist.

### 3. Identity dan access foundation

- Employee aktif memperoleh base employee self-service access setelah account aktif.
- Role tambahan bersifat additive dan memiliki scope `own`, `unit`, atau `organization` sesuai assignment.
- Organization-wide Human Capital queues memerlukan effective organization-scoped capability; unit-scoped HC tidak mendapatkan akses global.
- Foundation Board memiliki panel statistik/report aggregate-first dan read-only.
- Super Admin digunakan untuk administrasi akses/audit dan tidak dianggap employee self-service.
- Cross-principal authorization telah diverifikasi di backend dan browser.

### 4. Employee workspace

- Login real digunakan; tidak ada mock-login sebagai runtime boundary.
- App shell responsive dan employee identity berasal dari linked employee record.
- Dashboard pegawai menggunakan live authenticated data.
- Attendance menampilkan factual check-in/check-out dan honest empty state tanpa inferensi telat/absen/overtime/jam kerja/payroll.
- Leave menampilkan entitlement, request, approval, dan task sesuai policy.
- Payslip read-only menampilkan published imported payslip milik employee sendiri.
- Management navigation hanya muncul ketika effective capability sesuai role + scope tersedia.

### 5. Attendance factual record

ATT-001 menyediakan:

- employee self-read;
- Super Admin read/create/update/delete untuk manual record;
- immutable audit events untuk manual mutation;
- explicit provenance/source;
- Asia/Jakarta business-time presentation;
- protection agar manual correction tidak menimpa integration provenance.

ATT-001 tidak menghitung status telat, absen, overtime, jam kerja, payroll deduction, atau attendance-resolution outcome.

### 6. Leave vertical slices

MVP memverifikasi end-to-end:

- annual leave preview, submit, snapshotted Direct Manager -> Unit Approver chain, approval, final state, dan audit/outbox;
- special leave + encrypted evidence + HC administrative validation;
- planned leave + line approval + planned-domain HC validation;
- unpaid leave dengan Unit Approver lalu actual Human Capital approval;
- attendance resolution setelah partial/not-validated administration;
- annual conversion hanya melalui explicit employee acceptance ketika applicable.

Approval wajib mengikuti `docs/domain/workflows/approval-engine.md`. HC validation, HC notification, dan actual HC approval tetap konsep yang berbeda.

### 7. Payslip read-only melalui import

HCIS **tidak menghitung payroll** pada MVP. Perhitungan payroll berada di luar MVP dan dikerjakan sebagai modul pasca-MVP PAY-003 (ADR-0003 ACCEPTED, `docs/domain/payroll-calculation-v1.md`); batas MVP di bagian ini tidak berubah dan PAY-001/PAY-002 tetap jalur slip resmi sampai parallel run PAY-003 lulus.

Workflow terverifikasi:

```text
Authorized importer
  -> upload synthetic CSV
  -> preview
  -> review
  -> commit draft
  -> publish
  -> employee membaca published payslip miliknya
```

Verified boundaries:

- draft belum terlihat employee;
- published payslip hanya dapat dibaca owner;
- Foundation Board tidak mendapat personal payslip/import capability;
- published data immutable melalui MVP surface/database invariant;
- imported period diperlakukan sebagai canonical `YYYY-MM` tanpa timezone month shift;
- lines tetap opaque display data, bukan input payroll calculation.

### 8. Foundation Board panel

Panel Organ Yayasan bersifat read-only, aggregate-first, dan tidak membuka personal employee/payslip data. Browser authorization test juga memverifikasi Board tidak dapat masuk ke `/app` atau `/admin`.

### 9. Super Admin minimum

- user/account access overview;
- role + scope assignment;
- organization/employee administration surfaces;
- attendance administration;
- leave/calendar administration;
- payslip import/review/publish;
- technical access administration with MFA boundary.

Super Admin tidak otomatis memperoleh employee self-service.

## MVP verification evidence

Final verification menggunakan dua jalur yang saling melengkapi:

1. **VPS/pre-release browser and runtime verification** untuk real route isolation, employee/Board/Super Admin surfaces, HTTPS health, dan post-fix regression.
2. **Isolated synthetic mutation UAT** menggunakan PostgreSQL 16, local API/web runtime, Microsoft Edge + Playwright, dan synthetic personas untuk seluruh mutation flow tanpa menyentuh production/VPS data.

Final synthetic UAT menghasilkan PASS untuk:

- organization-scoped HC positive access;
- unit-scoped HC negative access;
- attendance create/update/delete + audit;
- annual leave E2E;
- special leave + HC validation;
- planned leave;
- unpaid leave actual HC approval;
- attendance resolution;
- payslip import/preview/review/commit/publish/self-read;
- data privacy/authorization boundaries.

Satu defect ditemukan pada payslip period serialization dan diperbaiki pada final application SHA di atas. Tidak ada release blocker tersisa pada MVP verification.

## Di luar MVP

- Reimbursement.
- Payroll calculation dan payroll reconciliation penuh.
- Loan/cicilan.
- Performance review penuh.
- LMS/training penuh.
- Recruitment.
- Employee data-change request.
- Production email/WhatsApp notification adapters.
- GPS/photo/fingerprint attendance production flow.
- Attendance schedule, shift, lateness tolerance, overtime/work-hour calculation.
- Legacy data cutover dan reconciliation penuh.
- Production go-live/security sign-off.

## Definition of MVP complete

MVP dianggap selesai ketika:

1. repository canonical dapat di-setup lokal dari clone/worktree bersih;
2. lint, typecheck, automated test, dan build lulus;
3. clean PostgreSQL dapat dimigrasikan dan synthetic verification environment dapat dijalankan;
4. real Super Admin authentication memiliki password hashing, mandatory MFA, server-side session, secure cookie, route isolation, dan audit coverage;
5. employee import preview/commit memiliki automated test dan tidak menyimpan ignored sensitive fields;
6. employee dapat menyelesaikan leave flow end-to-end dengan synthetic data;
7. approval chain stabil terhadap perubahan organisasi setelah request dibuat;
8. role/scope memiliki authorization test termasuk organization-vs-unit HC capability;
9. payslip import dan read-only employee access memiliki automated + synthetic E2E verification;
10. Foundation Board tidak dapat melakukan mutation/personal self-service;
11. audit event tersedia untuk operasi sensitif;
12. tidak ada secret atau real employee/payroll data di repository/test fixture.

**Semua kriteria di atas telah dipenuhi untuk MVP pada checkpoint 2026-08-22.**

MVP complete bukan berarti Pilot Ready atau Production Ready. Gate berikutnya mengikuti `docs/product/scope.md` dan membutuhkan keputusan operasional/security/cutover tersendiri.
