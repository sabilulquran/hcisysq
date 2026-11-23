# Special Leave and Human Capital Validation

**Status:** VERIFIED MVP BASELINE  
**Specification:** LEAVE-005  
**Related:** LEAVE-003, LEAVE-004, APR-001, AUTH-010

## Purpose

Implement the first special-leave vertical slice without turning Human Capital into a discretionary approver for rights that are primarily medical, emergency, or administrative in nature.

The baseline follows the current YSQ leave-policy working master. Policy values remain configurable and should be legally reviewed when the formal SOP/Peraturan Perusahaan is finalized.

## HC role semantics

HCIS distinguishes three behaviors:

- **HC notified**: receives information only.
- **HC validator**: verifies policy conditions, period, and supporting evidence. The validator does not decide whether an employee is "allowed" to be sick, miscarry, menstruate, or experience another protected/emergency condition.
- **HC approver**: makes an approval decision only where YSQ policy explicitly grants that authority, such as Cuti Tanpa Gaji. This is outside LEAVE-005 and is implemented by a separate later slice.

A validator may either:

1. mark administration as valid; or
2. request administrative correction/completion with a note.

`request_correction` does **not** reject the employee's underlying condition or right.

## LEAVE-005 supported request types

Initial supported special types are:

- Cuti Hamil dan Melahirkan;
- Cuti Keguguran;
- Istirahat karena Haid;
- Cuti Sakit;
- Cuti Pendampingan Istri Melahirkan;
- Cuti Pendampingan Istri Keguguran;
- Cuti Keluarga Meninggal Dunia.

The remaining line-approval special types (marriage, child marriage, child circumcision, Hajj) and Cuti Tanpa Gaji are intentionally not routed through this slice. They must not be silently downgraded to notification-only workflows.

## Workflow

### HC validation type

```text
Employee records/submits condition
  -> direct manager notified (when configured)
  -> HC validation task
      -> validated -> request completed
      -> needs correction -> employee adds supporting evidence -> HC queue again
```

A missing direct-manager notification target does not block line-notification workflows. It is logged as an unresolved line-notification event so organization setup can be corrected later.

### HC notification-only type

```text
Employee records condition
  -> direct manager notified when configured
  -> request recorded as completed
  -> HC notified
```

`Istirahat karena Haid` uses this baseline. Any later medical follow-up required by policy is a follow-up action and must not invalidate the current occurrence automatically.

## Evidence handling

Supporting evidence is intentionally not stored as plaintext.

Initial implementation:

- accepts PDF, JPEG, and PNG only;
- maximum 2 MB per file;
- validates basic file signature against declared content type;
- encrypts file bytes with AES-256-GCM before persistence;
- stores encrypted payload and metadata in PostgreSQL;
- decrypts only for the owning employee or an active organization-scoped Human Capital role;
- sends `Cache-Control: private, no-store` on evidence download;
- records evidence events without copying file content to audit payloads.

This database-backed encrypted storage is an initial adapter. A future object-storage adapter may replace physical storage without changing request/evidence authorization semantics.

For `required_deferred_allowed` policies, emergency submission may proceed without evidence, but HC cannot complete validation until required evidence exists.

## Policy rules encoded in this slice

- Hamil/melahirkan: H-30 and evidence required on initial submission.
- Keguguran: emergency notice allowed; evidence may follow.
- Sakit: emergency notice allowed; evidence may follow.
- Istirahat karena haid: maximum two working days per request in the current slice; HC notified, not validator by default.
- Pendampingan istri melahirkan: the initial automated slice covers the two-day base right. Additional days up to the policy maximum require a later explicit exception/decision workflow and are not silently treated as HC validation.
- Pendampingan istri keguguran: maximum two working days per request.
- Keluarga meninggal dunia: maximum two working days per request.

Long medical periods are represented by start/end dates; `working_days` remains the attendance impact calculated from the configured working calendar.

## Authorization

- Employee endpoints require an active `EMPLOYEE` principal linked to an active employee record.
- HC queue/decision/evidence endpoints require an active `human_capital` role assignment with `organization` scope and effective dates covering the current date.
- The migration grants `leave.validate` and `leave.evidence.read` permissions to the Human Capital system role.
- Frontend route guards only enforce principal type; the API is authoritative for HC role authorization.
- A unit-scoped `human_capital` assignment does not grant organization-wide queue access.

**Di luar pengelolaan HCIS (EMP-005 S2B §8.7; keputusan owner D-20, 23 November 2026).**
Data pegawai yang ditandai di luar pengelolaan HCIS — staf BUMY dan Pengurus Yayasan — hanya dapat dibaca. Ia
**tidak dapat mengajukan cuti khusus baru, termasuk pratinjaunya**: pengajuan baru dijawab `409
EMPLOYEE_OUTSIDE_HCIS_READ_ONLY`, "Data Anda di luar pengelolaan HCIS, jadi pengajuan baru tidak dapat dibuat.
Riwayat Anda tetap terbaca. Hubungi Human Capital bila ini keliru." — pesannya menyebut apa yang masih
berjalan dan langkah berikutnya, dan tidak pernah mengatakan akunnya tidak aktif. Ia juga tidak pernah dipilih
sebagai approver. Yang tetap jalan: seluruh pembacaan, riwayat sebelum penandaan, dan pembatalan pengajuan
yang sudah berjalan. Aturan ini mulanya hanya ditetapkan untuk cuti (S2B-b, 11 November 2026); keputusan owner
D-20 pada 23 November 2026 memperluasnya ke seluruh layanan mandiri. Rinciannya, termasuk yang masih `DRAFT`,
ada di `employment-administration-package1.md` §8.7.

## Data model

LEAVE-005 adds:

- request metadata: `line_handling`, `evidence_requirement`, `emergency_notice`, `validation_summary`;
- `leave_request_hc_tasks` for validator/approver semantics;
- `leave_request_evidence` for encrypted evidence payloads.

Annual leave approval snapshots remain unchanged.

## Audit and notification events

At minimum:

- `leave.special.submitted`;
- `leave.special.line_notified`;
- `leave.special.line_notification_unresolved`;
- `leave.evidence.added`;
- `leave.hc.validated`;
- `leave.hc.correction_requested`.

Notification outbox targets use employee identifiers or the `human_capital` role key; they do not embed sensitive evidence.

## Verification

Final isolated synthetic browser UAT verified:

- special-leave submission with synthetic evidence;
- encrypted evidence handling and authorized access;
- organization-scoped HC queue access;
- HC administrative validation to final state;
- unit-scoped HC denial for organization-wide queues;
- separation of special-leave validation from planned/unpaid HC task domains.

The production/pre-release browser pass also verified that unauthorized `403` responses terminate with a clear UI state rather than an infinite loading spinner.

## Slice boundary at final MVP

Cuti Tanpa Gaji remains outside LEAVE-005 semantics. The final MVP implements unpaid leave separately with Unit Approver followed by **actual HC approval**. That later implementation must not be interpreted as changing LEAVE-005 validator semantics.

## Acceptance criteria

- LEAVE-005-A: special leave uses policy-specific HC behavior rather than a universal approval chain.
- LEAVE-005-B: emergency types may be recorded immediately and may defer evidence where policy allows.
- LEAVE-005-C: required initial evidence blocks submission when absent.
- LEAVE-005-D: HC validation requires an active organization-scoped Human Capital role.
- LEAVE-005-E: validator can validate or request correction, but the correction action is not represented as rejection of the leave right.
- LEAVE-005-F: required/deferred evidence must exist before HC validation can complete.
- LEAVE-005-G: evidence is encrypted at rest and download authorization is enforced server-side.
- LEAVE-005-H: missing manager notification does not block notification-only workflows, but is auditable.
- LEAVE-005-I: special leave UI is reachable on desktop and mobile employee navigation.
- LEAVE-005-J: Cuti Tanpa Gaji is outside this slice and must use its separate explicit HC approver flow rather than being routed through HC validation.
