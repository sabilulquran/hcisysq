# Employee Master Import

**Status:** ACCEPTED FOR MVP  
**Specification:** EMP-004  
**Related:** EMP-001, ORG-001, SEC-001

## Goal

Populate and maintain the employee master from the existing HC source without requiring staff to enter employees one by one.

The import is a controlled data-ingestion flow. It does not create login accounts automatically and the uploaded file is not the long-term system of record.

## Source format

Preferred operational format: **CSV UTF-8**.

Compatibility format: `.xlsx` workbook.

CSV accepts comma or semicolon delimiters. The importer scans the first 10 non-empty records for the required header row because the current Google Sheets export contains a numbering row before the actual headers. Direct exports from the current source therefore remain valid without manual row deletion.

For XLSX compatibility, the importer reads only the sheet named `Master Data SDM YSQ`, with header row 2 and data starting at row 3. Formula-derived identifiers are read from their cached/displayed result as text and are never intentionally coerced through JavaScript numeric precision.

The importer uses an allowlist. Columns outside this list are ignored.

| Source header | Target | Required | Notes |
|---|---|---:|---|
| `NIP` | `employeeNumber` | yes | Unique natural key for employee-master upsert. Database PK remains UUID. A genuine duplicate NIP in one import file is blocking. |
| `NAMA` | `fullName` | yes | Trimmed; empty name is an error. |
| `STATUS AKTIF` | `status` | yes | Normalized to `active`, `inactive`, or `resigned`; unknown values fail closed to inactive with warning. |
| `STATUS KEPEGAWAIAN` | `employmentStatus` | no | Descriptive value. |
| `UNIT` | organization unit | no | Normalized reference; missing value is warning. |
| `JABATAN` | position | no | Normalized reference; missing value is warning. |
| `JENIS KEPEGAWAIAN` | `employmentType` | no | Descriptive value. |
| `JABATAN FUNGSIONAL` | `functionalPosition` | no | `-` becomes null. |
| `JABATAN STRUKTURAL` | `structuralPosition` | no | `-` becomes null. |
| `EMAIL` | `email` | no | Invalid/placeholder email becomes warning and is ignored. Employee still imports and Admin may correct it manually after confirmation. |
| `NO HP` | `phone` | no | Stored as text. |
| `PENDIDIKAN TERAKHIR` | `education` | no | Descriptive value. |
| `TMT` | `startedOn` | no | Accepts native spreadsheet dates, ISO dates, and Indonesian month-name dates produced by the current Google Sheets CSV export. |
| `TAHUN KELUAR (TTTT-BB)` | `endedOn` | no | Optional. `0`, `00:00:00`, `N/A`, `-`, and the spreadsheet epoch around 30 December 1899 are treated as empty. |

## NIP, NIK, and rehire semantics

NIP and NIK have different meanings and must not be conflated.

- **NIP** identifies the employee/employment record used for deterministic HCIS upsert. It is required and must be unique within one import file.
- **NIK** is a sensitive person-identity attribute. It remains excluded from the MVP import payload and is not persisted, logged, or used as the employee-master natural key.
- A repeated NIK in the source can legitimately represent a former employee who is recruited again under a different NIP. That must not be mislabeled as duplicate NIP.

If person-level consolidation is introduced later, it must preserve employment periods rather than overwrite history. The agreed candidate-selection rule for that future person-resolution step is: prefer an active employment record; otherwise prefer the record with the latest valid TMT. That future rule applies to person/NIK reconciliation, **not** to NIP uniqueness.

## Spreadsheet anomalies

The current source includes several spreadsheet-specific anomalies that the importer handles conservatively:

- zero-like exit dates can be rendered by spreadsheet software as dates around 1899/1900; these normalize to null;
- Google Sheets CSV exports render normal dates using Indonesian month names such as `01 September 2026`; these are accepted as normal source values;
- if an NIP cell itself contains a spreadsheet error token such as `#VALUE!`, the row is blocked with an explicit source-formula error instead of being treated as a duplicate identifier;
- invalid email remains a warning and does not block employee creation.

## Fields excluded from MVP

The source contains additional sensitive fields. MVP does not ingest them merely because they exist.

Currently excluded include NIK, BPJS identifiers, bank account, NPWP, family identifiers, document markers, full address, and unclassified free-form notes.

Adding any excluded field to persisted HCIS data requires an explicit product/security decision and matching authorization/audit behavior.

## Import flow

```text
Admin selects CSV (preferred) or XLSX
  -> server detects and validates the required headers/source shape
  -> rows are normalized using the allowlist
  -> genuine duplicate NIP is rejected
  -> server compares valid NIP with employee master
  -> preview persists sanitized supported fields only
  -> Admin reviews insert/update/warning/error counts
  -> Admin confirms commit
  -> one transaction upserts references and employees
  -> import job becomes committed
```

Raw upload bytes are not stored permanently.

**EMP-005 source classification (2026-10-16, Package 1 S2).** Commit additionally writes one row per committed employee to `employee_import_source_snapshots` with exactly four raw classification cell values: `STATUS AKTIF`, `STATUS KEPEGAWAIAN`, `JENIS KEPEGAWAIAN`, and `TAHUN KELUAR (TTTT-BB)` (text, max 120 characters each). These are codes, not personal data. They are kept because the normalized `status` collapses `Aktif BUMY` and `Aktif PKWT` into `active`, and the employment baseline needs to tell them apart (spec `employment-administration-package1.md` §4.2.1, §8.2). Previews created before this change commit without a snapshot. No other source column is retained.

## Preview states

- `insert`: NIP does not exist yet;
- `update`: NIP already exists;
- `error`: row cannot be committed;
- `skip`: reserved for future explicit skip workflows.

Warnings do not block commit. Errors do.

## Validation rules

Blocking errors include missing required headers, missing NIP, an NIP spreadsheet/formula error, missing employee name, genuine duplicate NIP, malformed source structure, and configured file/row limit violations.

Warnings include invalid email, invalid optional date, missing unit/position, unknown status defaulted to inactive, and conservative month-only date normalization.

Invalid email never creates an account and does not block employee import. Admin may verify the email with the employee and update employee contact data manually in the employee detail panel.

## Account boundary

Employee import does not automatically create or activate accounts. Account activation remains a separate AUTH flow.

## Audit and history

Persist import job UUID, filename, source type/sheet, checksum, row/insert/update/warning/error counts, actor, timestamps, and sanitized per-row outcome/messages. Ignored sensitive source columns must never be persisted in import payloads.

## Acceptance criteria

1. CSV UTF-8 is the preferred source and XLSX remains supported.
2. The current Google Sheets CSV export is accepted with its header on row 2.
3. Indonesian display dates from Google Sheets CSV normalize deterministically.
4. `0`, `00:00:00`, `N/A`, `-`, and spreadsheet-epoch exit dates normalize to null.
5. Unique long NIP values, including cached XLSX formula results, remain exact strings.
6. A genuine duplicate NIP in one file blocks commit; it is never auto-selected as a rehire record.
7. NIK remains excluded from persisted MVP import data and does not drive NIP upsert.
8. Invalid email does not block employee creation and can be corrected manually by Admin later.
9. Ignored sensitive columns never appear in persisted import payloads.
10. Commit is transactional and raw source bytes are not retained.
11. Tests and fixtures use synthetic data only.
