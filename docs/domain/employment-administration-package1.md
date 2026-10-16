# Employment Administration Package 1 — Status, Contract, Placement, Career Movement, and SK

**Status:** DRAFT — PENDING OWNER APPROVAL (no runtime implementation yet)  
**Specifications:** EMP-005, EMP-006, EMP-010  
**Prepared:** 2026-10-16  
**Parent direction:** `docs/domain/employment-administration.md` (ACCEPTED PRODUCT DIRECTION, 2026-09-22)  
**Related:** EMP-001, EMP-004, ORG-001, ORG-004, ORG-006, ORG-007, AUTH-010, AUTH-011, LEAVE-004 (annual-leave eligibility), PAY-003  
**Implementation plan:** `docs/domain/employment-administration-package1-implementation-plan.md`

Dokumen ini mengubah arah EMP-005/EMP-006 menjadi workflow yang dapat di-review dan diimplementasikan secara bertahap. Selama status masih DRAFT, tidak ada kode runtime, migration, atau perubahan production yang boleh dibuat atas dasar dokumen ini. Semua contoh nama, nomor, dan tanggal adalah data sintetis.

## 1. Why this package first

Hari ini status kerja, unit, jabatan, TMT, dan tanggal keluar pegawai hanya disimpan sebagai field terbaru di tabel `employees`, dan field tersebut ditimpa setiap kali workbook EMP-004 di-commit. Akibatnya:

- HC tidak dapat menjawab "sejak kapan Ahmad menjadi Wakasek?" atau "kontrak siapa yang habis bulan depan?";
- perpindahan unit/jabatan hilang tanpa jejak ketika workbook berikutnya diimpor;
- tidak ada tempat untuk mencatat nomor SK yang menjadi dasar perubahan;
- anti-copy guardrail roadmap ("mutable current employee state sebagai satu-satunya history") masih dilanggar oleh model saat ini.

Package 1 sengaja kecil tetapi bernilai tinggi: **status/hubungan kerja + kontrak + penempatan + promosi/demosi/mutasi + referensi SK**, dengan riwayat jabatan yang diturunkan dari record effective-dated. Ini adalah fondasi yang dibutuhkan semua paket berikutnya (pendidikan, kompetensi, keluarga, statutory, grade, payroll).

### Out of scope for Package 1

| Area | Alasan ditunda | Paket kandidat |
|---|---|---|
| Pendidikan & kualifikasi (EMP-007) | Tidak memengaruhi status/penempatan; field `education` lama tetap dipertahankan apa adanya. | Package 2 |
| Kompetensi & sertifikasi (EMP-008) | Bergantung PERF-001/TRAIN-001. | Package 3 |
| Keluarga/tanggungan (EMP-009) | Data sensitif; butuh privacy-purpose review tersendiri. | Package 3 |
| Statutory profile (PTKP/BPJS/risk) | Bergantung PAY-003. | Bersama PAY-003 |
| Job classification / grade | Specification ID masih TBD (roadmap §C). Package 1 **tidak** membuat tabel grade; promosi/demosi dinyatakan oleh HC, bukan dihitung dari grade. | Discovery terpisah |
| Perubahan kompensasi | Bergantung PAY-003. | Bersama PAY-003 |
| Upload file SK (PDF/foto) | Storage boundary dokumen pegawai belum diterima; Package 1 hanya menyimpan metadata/referensi SK. | DOC/storage package |
| Penugasan sementara/Plt dengan authority | Authority acting tetap milik ORG-004 `ACTING` incumbency. | Tetap ORG-004 |
| Approval workflow in-app (APR-001) untuk tindakan kepegawaian | Keputusan diambil di luar sistem dan dibuktikan oleh SK; lihat keputusan D-07. | Setelah pilot |
| Perpindahan lintas legal entity | ORG-007 masih discovery; ditolak fail-closed. | ORG-007 |

## 2. Specification IDs

| ID | Name | Package 1 coverage |
|---|---|---|
| EMP-005 | Employment relationship and contracts | Hubungan kerja, status kepegawaian, masa kontrak/periode, perpanjangan, pengangkatan tetap, pengakhiran hubungan kerja, baseline migration. |
| EMP-006 | Placement and career movement | Penempatan utama dan tambahan, mutasi, promosi, demosi, riwayat jabatan/karier, hubungan ke ORG-004. |
| EMP-010 | Employment decision document reference (Surat Keputusan) | **New ID.** Register metadata SK/dokumen dasar yang dapat ditautkan ke satu atau beberapa tindakan kepegawaian. File attachment di luar Package 1. |

EMP-010 dipilih karena EMP-001 s.d. EMP-009 sudah terpakai di `docs/product/feature-parity.yaml`; konsep SK sudah dijelaskan di parent direction tetapi belum memiliki ID. Acceptance criteria mengikuti pola `EMP-00X-A`, `EMP-00X-B`, dst.

## 3. What exists today (2026-10-16, origin/main `c2746a3`)

### Stored fields

`employees` (migration 0001, 0003, 0022):

| Column | Source header (EMP-004) | Meaning today | Package 1 treatment |
|---|---|---|---|
| `status` (`active`/`inactive`/`resigned`) | `STATUS AKTIF` | Population/access status; drives self-service eligibility, workflow eligibility, dashboards. | Becomes a **projection** of the effective employment (§8.4). |
| `employment_status` (free text) | `STATUS KEPEGAWAIAN` | e.g. tetap/kontrak/honorer (values not normalized). | Becomes `employment_category` on the employment/term; projection kept. |
| `employment_type` (free text) | `JENIS KEPEGAWAIAN` | e.g. guru/karyawan (DISCOVERY). | Kept as `staff_type` on the employment; projection kept. |
| `organizational_unit_id` | `UNIT` | Current unit reference (legacy ORG-001 reference table). | Becomes the primary placement unit; projection kept. |
| `position_id` | `JABATAN` | Current position label reference. | Becomes the primary placement position; projection kept. |
| `functional_position` (text) | `JABATAN FUNGSIONAL` | Free-text label. | Carried as label on the baseline placement. |
| `structural_position` (text) | `JABATAN STRUKTURAL` | Free-text label; real structural authority lives in ORG-004. | Carried as label on the baseline placement; never authority. |
| `started_on` | `TMT` | Hire/TMT date; used by annual-leave eligibility, Board dashboard, ORG-006 directory. | Becomes employment `started_on`; projection kept. |
| `ended_on` | `TAHUN KELUAR (TTTT-BB)` | Month-precision exit date. | Becomes employment `ended_on` with precision flag. |
| `removed_at` / `removal_reason` | — | EMP-001 population removal (not an employment fact). | Unchanged. Removal stays separate from employment ending. |
| `email`, `phone`, `education`, `full_name`, `employee_number` | various | Identity/contact. | Unchanged in Package 1. |

Raw source rows are preserved in `employee_import_source_snapshots` (0022), which gives evidence of what each import said but is not an effective-dated domain history.

### Write paths

- `POST /admin/employee-imports/:importId/commit` upserts every field above by NIP (permission `employees.manage`).
- `PATCH /admin/employees/:employeeId/contact` edits email/phone and writes `access_audit_events` `employee.contact.updated`.
- `PATCH /admin/employees/:employeeId/manager` (ORG-001 direct manager) — not touched by this package.
- There is **no** manual edit for status, unit, position, or dates; the workbook is currently the only write path.

### Read consumers that depend on current fields

- Annual leave eligibility (`started_on`).
- Board dashboard aggregates (`employment_status`, `started_on`).
- ORG-006 Organization Directory producer (`employment_status`, `started_on`).
- Attendance, leave, ADMS mapping, and ORG-001 screens (`status`, `organizational_unit_id`, `position_id`).

Package 1 keeps these columns as a compatibility projection so no consumer has to change in the same step (§8.4). Moving consumers to the resolver is a later, separate change.

### Relationship to ORG-004 today

ORG-004 stores structure as immutable change sets with stable keys (`organization_nodes.stable_key`, `organization_positions.stable_key`) and stores who sits in which seat as `organization_incumbencies` (`PRIMARY`/`ACTING`) and `organization_memberships`. Incumbency drives authority when rollout is `STRUCTURE`. Rollout is not activated in production.

## 4. Core model

```text
Employee (EMP-001 identity; unchanged)
  -> Employment (EMP-005)                one relationship with one legal entity for a period
       -> Employment Term (EMP-005)       contract / permanent / probation periods, never deleted
       -> Placement (EMP-006)             where and as what the employee works, effective-dated
       -> Employment Action (EMP-005/006) business action that opened/closed terms or placements
            -> Decision Document (EMP-010) SK metadata used as administrative basis
```

Account, role, permission, and login facts remain in AUTH-* tables. No Package 1 record stores or changes an account, role, password, or permission.

### 4.1 Employment (Hubungan Kerja)

| Attribute | Notes |
|---|---|
| `employee_id` | EMP-001 employee. |
| `legal_entity_key` | Nullable until ORG-007; all Package 1 rows belong to the implicit YSQ default entity. Cross-entity moves are rejected. |
| `staff_type` | `JENIS KEPEGAWAIAN` vocabulary (DISCOVERY: list from owner; e.g. Guru, Tenaga Kependidikan, Karyawan). |
| `started_on` | TMT of the relationship. Required except for baseline rows where the master has no TMT (`start_basis = UNKNOWN`). |
| `service_start_on` | Optional "tanggal mulai masa kerja" when it differs from `started_on` (e.g. rehire with recognized prior service). DRAFT; see D-05. Defaults to `started_on`. |
| `ended_on`, `end_reason` | Set only by a Termination action (or baseline). |
| `end_precision` | `DAY` or `MONTH` (baseline from `TAHUN KELUAR (TTTT-BB)` is month precision). |
| `source` | `BASELINE_FROM_MASTER`, `BASELINE_FROM_IMPORT`, or `ACTION`. |

Rule: at most one employment per employee is effective on any date (until ORG-007 allows one per legal entity). Rehire after an ended employment creates a **new** employment; the old one is never reopened by editing.

### 4.2 Employment Term (Masa/Status Kepegawaian & Kontrak)

A term states under which arrangement the employee works for a date range.

| Attribute | Notes |
|---|---|
| `employment_id` | Parent. |
| `category` | Normalized employment category (DISCOVERY vocabulary, D-02). Working proposal: `TETAP`, `KONTRAK`, `HONORER`, `MAGANG`, `PERCOBAAN`. Free-text `employment_status` values are mapped during baseline with an explicit mapping table approved by HC; unmapped values stay `BELUM_DIKLASIFIKASIKAN`. |
| `effective_from`, `effective_to` | Inclusive Asia/Jakarta dates. `effective_to` null = open-ended (e.g. tetap). Fixed-term categories require `effective_to` (configurable per category, D-03). |
| `contract_reference` | Optional contract number (not an SK). |
| `sequence` | 1, 2, 3 … within the employment; used to show "Kontrak ke-2". |
| `opened_by_action_id` | The action that created it. |

Rules:

- Terms inside one employment must not overlap (database exclusion constraint, same `btree_gist` approach as migration 0021).
- Gaps between terms are allowed but shown as a data-quality warning ("Ada jeda antara kontrak ke-1 dan ke-2").
- Legal limits (e.g. maximum PKWT duration, probation only for permanent staff) are **warnings only** until the owner confirms the applicable YSQ/legal rule (D-04). The system must not silently block or silently accept; it shows the warning in preview and records that the actor acknowledged it.

### 4.3 Placement (Penempatan)

| Attribute | Notes |
|---|---|
| `employment_id` | Parent. |
| `kind` | `PRIMARY` (penempatan utama, exactly one effective per date while employment is active) or `ADDITIONAL` (jabatan/tugas tambahan, zero or more). See D-06. |
| `unit_ref` | One of: ORG-004 node `stable_key` **or** legacy `organizational_units.id` (pre-ORG-004 acceptance). Exactly one is set. |
| `position_ref` | One of: ORG-004 position `stable_key` **or** legacy `positions.id`, or null if the employee is a member without a named seat. |
| `job_title_label` | Human label shown to users ("Guru Kelas", "Wakasek Kurikulum"). Required. |
| `functional_label`, `structural_label` | Optional text carried from the master for continuity; never used for authority. |
| `work_location_key` | Nullable; reserved for ORG-005. |
| `effective_from`, `effective_to` | Inclusive dates. `effective_to` is set when a later action closes the placement or the employment ends. |
| `effective_from_basis` | `RECORDED` (from an action) or `BASELINE_ASSUMED` (baseline: the real start of this placement is unknown). |
| `opened_by_action_id`, `closed_by_action_id` | Links to actions. |

Rules:

- No two `PRIMARY` placements overlap within one employment (exclusion constraint).
- `ADDITIONAL` placements may overlap each other and the primary placement, but not the same `position_ref` twice for the same dates.
- A placement must lie inside its employment dates.
- A placement references ORG-004 by **stable key**, so it remains valid across ORG-004 change sets; validation checks the key exists in the structure effective on `effective_from` (or the legacy reference exists).

### 4.4 Employment Action (Tindakan Kepegawaian)

The action is the unit HC works with. It is append-only. Recording an action opens/closes terms and placements in the same database transaction.

| Attribute | Notes |
|---|---|
| `employee_id`, `employment_id` | Target. |
| `action_type` | See §5. |
| `effective_on` | Required. Inclusive start date of the new situation. |
| `reason_code`, `reason_note` | Reason code required for termination/demotion; note optional, restricted visibility (§9). |
| `decision_document_ids` | Zero or more EMP-010 references. Required for some types (§5, D-08). |
| `previous_snapshot` / `new_snapshot` | Small, structured "dari → menjadi" summary (unit/position labels, category, dates) for display and audit. **Not** the source of truth; the opened/closed term/placement rows are. |
| `state` | `RECORDED` or `REVERSED` (§6). |
| `reverses_action_id` | Set on a reversal action. |
| `recorded_by_account_id`, `recorded_at` | Actor metadata. |
| `version` | Optimistic concurrency token per employment. |

### 4.5 Decision Document (Surat Keputusan — EMP-010)

| Attribute | Notes |
|---|---|
| `document_type` | `SK_PENGANGKATAN`, `SK_PENEMPATAN`, `SK_MUTASI`, `SK_PROMOSI`, `SK_DEMOSI`, `SK_PEMBERHENTIAN`, `PERJANJIAN_KERJA`, `ADENDUM_PERJANJIAN`, `LAINNYA` (DRAFT vocabulary, D-08). |
| `document_number` | Required, unique per `document_type` + `issuing_authority_label` + `signed_on` year (DRAFT uniqueness rule). |
| `subject` | Short subject ("Penempatan guru semester ganjil 2027/2028"). |
| `issuing_authority_label` | Text (e.g. "Ketua Yayasan"); optional link to an ORG-004 position stable key. Does **not** grant or prove authority. |
| `signed_on`, `effective_on`, `effective_to` | Dates; `effective_to` optional. |
| `external_reference` | Optional pointer to where the signed original is kept (e.g. "Arsip HC lemari 2 / map 2027"). No file upload in Package 1. |
| `notes` | Optional. |

Rules:

- One SK may be linked to many actions (e.g. one collective SK Mutasi for 12 teachers); each link is explicit per action.
- Once an SK is linked to a recorded action, its number/type/dates are immutable; mistakes are fixed by creating a corrected SK and reversing/re-recording the action, or by an audited `document correction` that keeps the previous values (D-09).
- The SK is evidence. The structured action, terms, and placements remain domain truth.

## 5. Action taxonomy (Package 1)

Operator labels are in Indonesian; codes are stable API values.

| Code | Label (UI) | Effect | SK | Notes |
|---|---|---|---|---|
| `BASELINE` | Data awal | Creates employment + first term + current placement from the existing master. System/backfill only. | No | Marked `source = BASELINE_*`; shown as "Data awal dari master pegawai". |
| `HIRE` | Mulai hubungan kerja | New employment, term #1, primary placement. | Policy (D-08); proposal: required | Rehire uses this too (new employment). |
| `CONTRACT_EXTENSION` | Perpanjang kontrak | New term of the same fixed-term category starting the day after the current term ends (or a chosen date). | Proposal: required (`PERJANJIAN_KERJA`/`ADENDUM`) | Previous term unchanged. |
| `CATEGORY_CHANGE` | Ubah status kepegawaian | Closes current term on `effective_on - 1`, opens a new term with another category (e.g. Kontrak → Tetap = pengangkatan pegawai tetap). | Proposal: required | |
| `PLACEMENT` | Penempatan | Opens a primary placement when none is effective, or adds/ends an `ADDITIONAL` placement. | Optional | Not a career move; used for first placement or added tasks. |
| `TRANSFER` | Mutasi | Closes current primary placement, opens a new one (different unit and/or position) at the same declared level. | Proposal: required | |
| `PROMOTION` | Promosi | Same mechanics as Transfer; HC declares it a promotion. | Required | Without a grade model, "naik/turun" is declared by HC with the SK, not computed. |
| `DEMOTION` | Demosi | Same mechanics; reason code required. | Required | Reason note visibility restricted. |
| `TERMINATION` | Akhiri hubungan kerja | Sets employment `ended_on` to the last working day entered by HC (§7.1), closes open term(s) and placement(s). Reason: `RESIGN`, `KONTRAK_BERAKHIR`, `PENSIUN`, `PEMBERHENTIAN`, `MENINGGAL_DUNIA`, `LAINNYA` (DRAFT, D-10). | Proposal: required except `MENINGGAL_DUNIA`/`RESIGN` (D-08) | Does **not** remove the employee (EMP-001 removal stays separate) and does not change any account directly (§8.5). |
| `REVERSAL` | Batalkan tindakan | Reverses one earlier recorded action (§6). | No (reason required) | Requires `employment.correct`. |

Not in Package 1: compensation change, grade change, acting authority, cross-entity move, suspension/skorsing (DISCOVERY whether YSQ needs it).

## 6. States and transitions

### 6.1 Employment Action

```text
(preview)  --record-->  RECORDED  --reversal action-->  REVERSED
```

- `preview` is not persisted: `POST …/employment-actions/preview` validates and returns the "dari → menjadi" result without writing.
- There is no saved DRAFT state in Package 1 (keeps the model small). If the owner wants maker-checker (D-07), add `SUBMITTED -> RECORDED/REJECTED` before pilot; the record/terms/placements are created only on `RECORDED`.
- `REVERSED` is terminal. A reversed action stays visible in history with a strike-through and the reversal reason.

Reversal rules:

- Only the **latest** non-reversed action of an employment can be reversed (stack discipline). To fix an older action, reverse newer ones first, or use an explicit correction sequence. This fails closed instead of silently rewriting later history.
- Reversal restores the previous term/placement closure exactly (re-opens what the action closed, voids what it opened) in one transaction; voided rows keep `voided_by_action_id` and remain readable.
- `BASELINE` can be reversed only while it is the only action and only by the backfill tooling (re-run baseline), not from the UI.

### 6.2 Derived employment state (shown to users)

For a given date `d` (default: today, Asia/Jakarta):

| Derived state | Condition | `employees.status` projection |
|---|---|---|
| `AKTIF` | An employment is effective on `d` (started_on ≤ d and (ended_on null or d ≤ ended_on)). | `active` |
| `AKAN_MULAI` | Only a future employment exists. | `inactive` |
| `BERAKHIR` | Latest employment ended before `d` with reason `RESIGN`. | `resigned` |
| `BERAKHIR` (other reasons) | Latest employment ended before `d`, other reason. | `inactive` |
| `TANPA_DATA` | No employment (baseline not yet loaded). | unchanged (import remains authoritative) |

Additional derived flags (not states): `KONTRAK_SEGERA_BERAKHIR` (term ends within N days, default 60, D-11), `KONTRAK_LEWAT_TANPA_TINDAK_LANJUT` (fixed term ended, employment not terminated, no next term), `TANPA_PENEMPATAN` (active employment without primary placement).

When a fixed-term contract passes its end date without extension or termination, the system **does not** end the employment automatically. It shows `KONTRAK_LEWAT_TANPA_TINDAK_LANJUT` in the HC worklist. Silent auto-termination would change access and leave eligibility without a human decision (D-12).

## 7. Effective dating and derivation of current state

### 7.1 Date semantics

- All dates are Asia/Jakarta business dates, inclusive on both ends, consistent with ORG-004.
- `effective_on` of an action = first day of the new situation. The closed record gets `effective_to = effective_on - 1 day`.
- Termination: `effective_on` is the **last working day** entered by HC as "Tanggal terakhir bekerja", stored as `ended_on`; the UI asks for the last day, not "the day after", to avoid off-by-one errors. (API field: `lastDayOn` for `TERMINATION`.)

### 7.2 Current state is derived

```text
current employment(d)  = employment where started_on <= d <= coalesce(ended_on, +inf), not voided
current term(d)        = term of that employment covering d, not voided
primary placement(d)   = PRIMARY placement of that employment covering d, not voided
additional placements(d) = ADDITIONAL placements covering d, not voided
career history         = RECORDED/REVERSED actions ordered by effective_on, recorded_at
```

A resolver in the domain layer computes these from rows; nothing writes "current" as a separate truth. The `employees` columns are a cached projection (§8.4).

### 7.3 Ordering rules

- **Future-dated** actions are allowed (scheduled change, e.g. SK signed in June, effective 1 July). They appear as "Terjadwal" in the timeline. The projection changes on the effective date (§8.4).
- **Backdated** actions are allowed with a mandatory reason when `effective_on` is before today; beyond a backdating window (proposal 31 days, D-13) they require `employment.correct`.
- **Out-of-order** actions are rejected: a new action whose `effective_on` is on or before the `effective_on` of an existing non-reversed later action for the same employment fails with `EMPLOYMENT_ACTION_OUT_OF_ORDER`. HC must reverse the later action first. This prevents silently re-cutting history.
- **Same-day multiple actions** (e.g. category change and transfer on the same date) are allowed if they touch different record kinds; they are ordered by `recorded_at`.
- Backdating never rewrites approval snapshots, leave requests, attendance results, or payslips already created. Those modules read the projection/resolver for **new** work only.

### 7.4 Overlap and consistency guards (fail closed)

- one effective employment per employee (per legal entity later);
- no overlapping terms in one employment;
- no overlapping PRIMARY placements in one employment;
- placement within employment dates; term within employment dates;
- fixed-term category requires `effective_to` (per D-03);
- referenced ORG-004 node/position stable key exists in the structure effective on `effective_from`, or the legacy reference exists;
- legal entity unchanged across a transfer (cross-entity move rejected).

## 8. Migration from current employee fields

### 8.1 Rollout modes

Same pattern as ORG-004 `LEGACY / SHADOW / STRUCTURE`, one installation-wide setting `employment_history_mode`:

| Mode | Behaviour |
|---|---|
| `OFF` (default after deploy) | New tables exist and are empty or ignored. EMP-004 import remains the only writer of employee employment fields. No UI change except hidden tabs. |
| `SHADOW` | Baseline loaded. HC can read history tabs and the consistency report. Actions are **disabled**. Import still writes `employees`; each import commit also produces a "would differ from history" report. |
| `AUTHORITATIVE` | Actions enabled. For employees with an employment record, import **no longer writes** `status`, `employment_status`, `employment_type`, `organizational_unit_id`, `position_id`, `functional_position`, `structural_position`, `started_on`, `ended_on`; preview shows them as "Diabaikan — dikelola lewat riwayat kepegawaian". Projection writer maintains those columns from history. |

Mode changes require `access.governance.manage` (Super Admin governance) and an audit reason; production activation additionally requires owner approval under OPS-MI8-REL-001 practice.

### 8.2 Baseline backfill (idempotent command, not a SQL data migration)

For each employee with `removed_at IS NULL` (removed employees are backfilled too, read-only, so history is complete; D-14):

1. Create one employment:
   - `started_on = employees.started_on`; if null → `start_basis = UNKNOWN`, `started_on = NULL`, data-quality issue `BASELINE_START_UNKNOWN`.
   - If `status IN ('inactive','resigned')` and `ended_on` present → `ended_on` = last day of that month, `end_precision = MONTH`, `end_reason = RESIGN` when status `resigned`, else `LAINNYA_DARI_MASTER`.
   - If ended status but no `ended_on` → issue `BASELINE_END_UNKNOWN`; employment ended with `ended_on = NULL`, `end_basis = UNKNOWN` (explicitly not "active").
   - If status `active` but `ended_on` present → issue `BASELINE_STATUS_CONFLICT`; employment left active; HC must resolve.
2. Create term #1: `category` = mapped `employment_status` (HC-approved mapping table, D-02), `effective_from = started_on`, `effective_to = ended_on` or NULL. Contract end dates are **not** known from the master; fixed-term categories get issue `BASELINE_CONTRACT_END_UNKNOWN` instead of an invented date.
3. Create one PRIMARY placement from `organizational_unit_id`, `position_id`, labels; `effective_from = baseline cutoff date`, `effective_from_basis = BASELINE_ASSUMED`. The placement does **not** claim the employee has held the position since TMT.
4. Create one `BASELINE` action referencing the source import job (`source_last_import_job_id`) and its source snapshot id.

The command:

- runs `--dry-run` by default and prints counts and issue codes only (no names, no NIP) to stdout; detailed per-employee issues go to the consistency report behind `employment.read`;
- is idempotent: an employee that already has an employment is skipped;
- writes `employment.baseline.created` audit per employee and one summary audit event per run;
- requires mode `OFF` or `SHADOW`; refuses in `AUTHORITATIVE`.

### 8.3 Data-quality review before AUTHORITATIVE

HC reviews the consistency report in SHADOW: unknown start dates, unknown contract end dates, unmapped categories, status conflicts, employees without unit/position, and differences between `structural_label`/ORG-004 incumbency. HC fixes them by:

- correcting the source workbook and re-importing while in SHADOW, then re-running baseline for affected employees (baseline re-run allowed only while the employee has only a `BASELINE` action); or
- after AUTHORITATIVE, recording real actions (e.g. `CONTRACT_EXTENSION` with the actual contract dates).

Exit criteria for AUTHORITATIVE are listed in the implementation plan.

### 8.4 Compatibility projection

- On every recorded/reversed action, the projection writer updates the nine `employees` columns from the resolver **in the same transaction**.
- A daily job (and a manual "refresh" command) at 00:05 Asia/Jakarta re-projects employees whose state changes on that date (scheduled future actions, contract end flags). The job is idempotent and writes one summary audit event. DISCOVERY: Mi8VPS has no systemd/cron for the API; the job must run under the existing `sq-core-worker.sh` supervision or as an in-process scheduler — decide in step S5 with ops review.
- If the projection job has not run, the resolver-based screens are still correct; only legacy consumers are stale. The consistency report shows "Proyeksi tertinggal" when any employee's projection differs from the resolver.

### 8.5 Account and access boundary

- No action changes an account, role assignment, password, MFA, or Keycloak/OIDC state.
- Ending an employment changes `employees.status` through the projection exactly as an import changing `STATUS AKTIF` does today; whatever access consequence the existing auth rules attach to `employees.status` therefore stays the same. After a termination the UI shows a follow-up hint: "Periksa akses akun pegawai ini di menu Akses" (link only, no automatic deactivation). D-15 asks whether this should become automatic later.

### 8.6 Rollback plan

| Stage | Rollback |
|---|---|
| Schema deployed, mode `OFF` | Additive tables only; no consumer reads them. Leave in place, or run the documented down script (drop new tables/permissions) before any baseline is loaded. Restore not required. |
| Baseline loaded, mode `SHADOW` | Set mode `OFF`. Optionally purge baseline rows with the backfill command's `--purge-baseline` (only rows whose sole action is `BASELINE`). `employees` columns were never written by the new code, so nothing to restore. |
| Mode `AUTHORITATIVE` with real actions | Set mode `OFF`: import becomes the writer again and projection stops; `employees` keeps the last projected values. History tables are **kept** (never dropped once real actions exist) so no administrative fact is lost; re-enabling `AUTHORITATIVE` later requires re-running the consistency report because imports may have changed columns meanwhile. A verified database backup is taken before switching to `AUTHORITATIVE` (OPS-MI8 backup procedure). |

## 9. Permissions and visibility

New permission keys (additive migration, assigned explicitly — never inferred from job title or ORG-004 position):

| Permission | Grants | Proposed default assignment |
|---|---|---|
| `employment.read` | Read employment, terms, placements, actions, SK metadata, consistency report for employees within the actor's existing employee-admin scope. | `human_capital_admin` |
| `employment.manage` | Preview/record actions types `HIRE` … `TERMINATION`; create/edit unlinked SK records. | `human_capital_admin` |
| `employment.correct` | `REVERSAL`, backdating beyond the window, SK correction after link, baseline re-run per employee. | Owner decision D-16 (proposal: `human_capital_admin` with a second-person rule, or a separate HC lead role). |

- Scope follows AUTH-011 role-assignment scope already used for `employees.manage`/`employees.read.all`; an organization-scoped HC admin acts on all employees, a unit-scoped holder only on employees whose **current primary placement unit** is in scope (TBD: verify exact AUTH-011 scope semantics during implementation step S2).
- Self-approval guard: an actor cannot record an action on their **own** employee record (`EMPLOYMENT_SELF_ACTION_FORBIDDEN`).
- Super Admin (technical) does not receive `employment.manage` by default (least privilege; MVP keeps Super Admin out of HR decisions). Mode switching uses `access.governance.manage`.
- Employee self-service (`employees.read.own`): proposal (D-17) — employee sees own current status, current placement, contract end date, and a timeline of action type + date + unit/position + SK number. Employee does **not** see `reason_note`, demotion reason code, or internal notes.
- Foundation Board: aggregates only (unchanged; counts by category keep working through the projection).
- Every new permission has positive and negative automated tests (AGENTS.md §7).

## 10. Audit events

Stored in a new `employment_audit_events` table written in the same transaction as the change (pattern of `organization_audit_events`). Payloads carry ids, codes, and dates — not reason notes, not contact data, not national ID numbers.

| Event | When | Payload (safe) |
|---|---|---|
| `employment.baseline.created` | Backfill per employee | employee id, employment id, issue codes, source import job id |
| `employment.baseline.run` | Backfill summary | counts per issue code, mode, dry-run flag |
| `employment.action.recorded` | Any action recorded | action id, type, employment id, effective_on, opened/closed row ids, SK ids, acknowledged warning codes |
| `employment.action.reversed` | Reversal | reversal action id, reversed action id, reason code |
| `employment.decision_document.created` / `.updated` / `.corrected` | SK register | document id, type, changed field names |
| `employment.decision_document.linked` | Link to action | document id, action id |
| `employment.projection.refreshed` | Daily/manual job | date, number of employees re-projected, number of mismatches |
| `employment.mode.changed` | Rollout mode | from, to, reason length, actor |
| `employment.import.fields_ignored` | Import commit in AUTHORITATIVE | import job id, count of employees with ignored fields |

## 11. Approval needs

- Package 1 records decisions already taken outside HCIS; the SK (or signed contract) is the approval evidence. HCIS does not route an approval request for these actions (D-07).
- Required SK per action type is configurable policy, proposal in §5 (D-08). When required and missing → `DECISION_DOCUMENT_REQUIRED`.
- If maker-checker is chosen (D-07 option B), the recorder and the confirmer must be different accounts and both events are audited; recording becomes effective only on confirmation.
- No action changes ORG-004 authority. If an action places someone into an ORG-004 authority-bearing position, the preview says: "Penempatan ini tidak mengubah kewenangan approval. Perbarui juga Struktur Organisasi (draft perubahan) bila pegawai ini menjadi pemegang jabatan." The consistency report lists placement vs incumbency mismatches. Auto-creating ORG-004 drafts is a later option (D-18).

## 12. Failure behaviour

All failures return an error code and an Indonesian message; nothing is partially written (single transaction per action).

| Code | HTTP | Condition | UI message (Indonesian) |
|---|---|---|---|
| `EMPLOYMENT_HISTORY_DISABLED` | 409 | Actions while mode is not `AUTHORITATIVE`, or reads while mode is `OFF`. | "Riwayat kepegawaian belum diaktifkan." |
| `EMPLOYMENT_FORBIDDEN` | 403 | Missing permission/scope. | "Anda tidak memiliki akses untuk tindakan ini." |
| `EMPLOYMENT_SELF_ACTION_FORBIDDEN` | 403 | Actor targets own employee record. | "Tindakan kepegawaian untuk diri sendiri harus dicatat oleh petugas lain." |
| `EMPLOYMENT_EFFECTIVE_DATE_REQUIRED` | 400 | Missing/invalid date. | "Tanggal berlaku wajib diisi." |
| `EMPLOYMENT_NOT_ACTIVE` | 409 | Career/contract action on an employment not effective on `effective_on`. | "Hubungan kerja pegawai tidak aktif pada tanggal tersebut." |
| `EMPLOYMENT_ALREADY_ACTIVE` | 409 | `HIRE` while an employment is effective. | "Pegawai masih memiliki hubungan kerja aktif." |
| `EMPLOYMENT_OVERLAP` | 409 | Term/placement/employment overlap. | "Periode bertabrakan dengan data yang sudah ada." |
| `EMPLOYMENT_ACTION_OUT_OF_ORDER` | 409 | A later non-reversed action exists. | "Sudah ada tindakan lain setelah tanggal ini. Batalkan tindakan tersebut lebih dulu." |
| `EMPLOYMENT_BACKDATE_NOT_ALLOWED` | 403 | Beyond window without `employment.correct`. | "Tanggal terlalu jauh ke belakang; butuh kewenangan koreksi." |
| `EMPLOYMENT_REFERENCE_INVALID` | 422 | Unit/position key not found in effective structure. | "Unit atau jabatan tujuan tidak ditemukan pada struktur yang berlaku." |
| `EMPLOYMENT_CROSS_ENTITY_UNSUPPORTED` | 422 | Legal entity change. | "Perpindahan antar badan hukum belum didukung." |
| `DECISION_DOCUMENT_REQUIRED` | 422 | SK required by policy. | "Tindakan ini membutuhkan SK/dokumen dasar." |
| `DECISION_DOCUMENT_LOCKED` | 409 | Editing an SK already linked. | "SK sudah dipakai pada tindakan; gunakan koreksi." |
| `EMPLOYMENT_ACTION_NOT_REVERSIBLE` | 409 | Not the latest action, already reversed, or baseline. | "Tindakan ini tidak dapat dibatalkan." |
| `EMPLOYMENT_VERSION_CONFLICT` | 409 | `expectedVersion` stale (concurrent edit). | "Data berubah sejak Anda membuka halaman. Muat ulang lalu ulangi." |
| `EMPLOYMENT_BASELINE_MISSING` | 409 | Action on an employee without baseline in AUTHORITATIVE. | "Data awal kepegawaian pegawai ini belum tersedia." |

`POST` requests that record actions require an `Idempotency-Key`; a replay returns the original result.

## 13. Screens (bahasa pengguna)

All screens follow the existing admin shell, with loading, empty, error, forbidden/session-expired, and mobile states (EMP-004-G pattern). Labels below are the user-facing text.

### 13.1 Detail pegawai — tab **Kepegawaian & Kontrak**

- Kartu ringkas: **Status**: Aktif / Akan mulai / Berakhir · **Status kepegawaian**: Kontrak (ke-2) · **Masa kontrak**: 1 Jul 2027 – 30 Jun 2028 · **TMT**: 1 Jul 2026 · **Masa kerja**: 1 tahun 3 bulan.
- Badge peringatan: "Kontrak berakhir dalam 45 hari", "Kontrak sudah lewat dan belum ditindaklanjuti", "Tanggal mulai belum diketahui (data awal)".
- Tabel **Riwayat kontrak**: Ke-, Status kepegawaian, Mulai, Selesai, No. perjanjian, Dasar (SK).
- Tombol tindakan (sesuai izin): **Perpanjang kontrak**, **Ubah status kepegawaian**, **Akhiri hubungan kerja**, **Mulai hubungan kerja baru** (hanya bila tidak ada yang aktif).
- Kosong: "Belum ada data kepegawaian. Data awal akan dibuat oleh petugas HC saat fitur diaktifkan."

### 13.2 Detail pegawai — tab **Penempatan & Karier**

- **Penempatan saat ini**: Unit, Jabatan, sejak tanggal (atau "sejak data awal"), Tugas tambahan.
- **Riwayat jabatan** (timeline vertikal, terbaru di atas): "Promosi · 1 Jul 2027 · Guru Kelas, SDIT → Wakasek Kurikulum, SDIT · Dasar: SK Ketua Yayasan No. 012/SK/YSQ/VI/2027". Tindakan yang dibatalkan tampil dicoret dengan keterangan "Dibatalkan pada … oleh … — alasan".
- Tindakan terjadwal tampil dengan label **Terjadwal**.
- Tombol: **Penempatan**, **Mutasi**, **Promosi**, **Demosi**.
- Info ORG-004 (bila relevan): "Struktur Organisasi mencatat pegawai ini sebagai pemegang jabatan lain. Periksa kecocokan."

### 13.3 Dialog **Catat tindakan kepegawaian** (satu pola untuk semua tindakan)

1. **Tindakan** — sudah terpilih dari tombol; dapat diganti.
2. **Isi data** — Tanggal berlaku (atau "Tanggal terakhir bekerja" untuk pengakhiran), Unit tujuan, Jabatan tujuan, Label jabatan, Status kepegawaian & masa kontrak (untuk tindakan kontrak), Alasan.
3. **Dasar** — pilih SK yang sudah ada atau **+ Catat SK baru** (nomor, jenis, perihal, pejabat penanda tangan, tanggal tanda tangan, tanggal berlaku, lokasi arsip).
4. **Periksa** — ringkasan "Dari → Menjadi", daftar peringatan (mis. "Total masa kontrak melebihi batas yang biasa dipakai; pastikan sesuai kebijakan") dengan centang "Saya sudah memeriksa".
5. **Simpan** — pesan sukses: "Promosi dicatat dan berlaku mulai 1 Jul 2027."

Mobile: langkah tampil satu per layar dengan tombol Lanjut/Kembali.

### 13.4 Menu **Kepegawaian → Kontrak akan berakhir**

Daftar pegawai dengan masa kontrak berakhir dalam 30/60/90 hari, plus "Sudah lewat, belum ditindaklanjuti". Kolom: Pegawai, Unit, Status kepegawaian, Berakhir, Sisa hari, Aksi (Perpanjang / Akhiri). Filter unit dan rentang.

### 13.5 Menu **Kepegawaian → Surat Keputusan**

Register SK: cari nomor/perihal, filter jenis dan tahun; detail SK memperlihatkan daftar tindakan yang memakai SK tersebut. SK yang sudah dipakai ditandai "Terkunci".

### 13.6 Menu **Kepegawaian → Periksa kecocokan data** (SHADOW dan sesudahnya)

Kelompok masalah dengan jumlah: "Tanggal mulai belum diketahui", "Masa kontrak belum diketahui", "Status kepegawaian belum dikelompokkan", "Status aktif bertentangan dengan tanggal keluar", "Tanpa unit/jabatan", "Berbeda dengan Struktur Organisasi", "Proyeksi tertinggal". Setiap baris menautkan ke detail pegawai.

### 13.7 Pegawai — **Profil saya → Kepegawaian** (bila D-17 disetujui)

Read-only: status, status kepegawaian, masa kontrak, unit/jabatan saat ini, riwayat singkat (jenis tindakan, tanggal, unit/jabatan, nomor SK).

## 14. Acceptance criteria

EMP-005:

- EMP-005-A: Recording `HIRE`, `CONTRACT_EXTENSION`, `CATEGORY_CHANGE`, `TERMINATION` creates new term/employment rows and never updates or deletes an earlier term except setting its closure through the action, all in one transaction with an audit event.
- EMP-005-B: Current status/category/contract dates are derived by the resolver for any date; a future-dated action changes the derived state only from its effective date.
- EMP-005-C: Overlapping employments/terms, out-of-order actions, and missing effective dates are rejected with the codes in §12; no partial write.
- EMP-005-D: A fixed-term contract that passes its end date is flagged, not auto-terminated.
- EMP-005-E: Baseline backfill is idempotent, dry-run by default, never invents contract end or start dates, and records issue codes.
- EMP-005-F: In `AUTHORITATIVE`, EMP-004 import does not overwrite employment fields for baselined employees and reports ignored fields; in `OFF`/`SHADOW` import behaviour is unchanged.
- EMP-005-G: The `employees` projection equals the resolver result after every action and after the daily refresh; annual-leave eligibility, Board, and ORG-006 outputs are unchanged for unchanged data.
- EMP-005-H: No action changes any account, role, or permission.

EMP-006:

- EMP-006-A: `PLACEMENT`, `TRANSFER`, `PROMOTION`, `DEMOTION` close the previous primary placement at `effective_on - 1` and open a new one; career history shows "dari → menjadi" with SK.
- EMP-006-B: At most one PRIMARY placement is effective per date; ADDITIONAL placements are supported per D-06.
- EMP-006-C: Placements reference ORG-004 by stable key (or legacy reference before ORG-004 acceptance) and are validated against the structure effective on the date.
- EMP-006-D: No EMP-006 action changes ORG-004 incumbency, authority bindings, rollout, or existing approval snapshots; mismatches are reported.
- EMP-006-E: Reversal of the latest action restores the previous state exactly and keeps both actions visible.

EMP-010:

- EMP-010-A: SK metadata can be created, searched, and linked to one or many actions.
- EMP-010-B: An SK linked to a recorded action cannot be silently edited; corrections keep prior values and are audited.
- EMP-010-C: Policy-required SK is enforced per action type.

Cross-cutting:

- EMP-PKG1-X1: `employment.read`, `employment.manage`, `employment.correct` each have positive/negative backend tests, including self-action denial and unit-scope denial.
- EMP-PKG1-X2: All screens have loading, empty, error, forbidden, and mobile states verified in a browser with synthetic data.
- EMP-PKG1-X3: Audit payloads contain no reason notes, contact data, or identity numbers.

## 15. Owner decisions needed

| ID | Decision | Proposal |
|---|---|---|
| D-01 | Approve Package 1 scope (status/contract, placement, promotion/demotion/transfer, SK reference) and defer education/family/statutory/grade/compensation. | Approve. |
| D-02 | Official list of **status kepegawaian** and **jenis kepegawaian** values, and the mapping from today's free-text values. | HC provides the list; mapping reviewed in SHADOW. |
| D-03 | Which categories must have an end date (kontrak, honorer, magang, percobaan?). | Kontrak, Magang, Percobaan: wajib; Tetap: tidak; Honorer: TBD. |
| D-04 | Contract length/extension rules and probation rules to warn about (legal review). | Warnings only in Package 1. |
| D-05 | Rehire: does prior service count for masa kerja/leave eligibility? | Separate `service_start_on`, default = new TMT. |
| D-06 | Support jabatan/tugas tambahan (ADDITIONAL placements) in Package 1? | Yes (data already has structural + functional labels). |
| D-07 | Recording model: A) one HC officer records with SK as evidence; B) maker-checker (second HC officer confirms). | A for pilot; B if HC prefers four-eyes for promotion/demotion/termination. |
| D-08 | For which actions is an SK/contract mandatory? | Mandatory: Hire, Extension, Category change, Transfer, Promotion, Demotion, Termination (except resign/death). |
| D-09 | How to fix a mistyped SK already used. | Audited correction keeping old values. |
| D-10 | Termination reason list. | Resign, Kontrak berakhir, Pensiun, Pemberhentian, Meninggal dunia, Lainnya. |
| D-11 | Contract reminder window. | 60 days (list also shows 30/90). |
| D-12 | Expired contract without follow-up: flag only, or auto-end? | Flag only. |
| D-13 | Backdating window before extra permission. | 31 days. |
| D-14 | Backfill removed (EMP-001 `removed_at`) employees too? | Yes, read-only. |
| D-15 | After termination, should account deactivation stay manual? | Manual + hint in Package 1. |
| D-16 | Who holds `employment.correct`? | Senior HC officer only (separate assignment). |
| D-17 | Employee sees own employment history (without reasons)? | Yes. |
| D-18 | Should a placement into an authority seat auto-create an ORG-004 draft? | Not in Package 1; mismatch report only. |
| D-19 | After AUTHORITATIVE, is the workbook still used for new hires? | New hires via **Mulai hubungan kerja**; workbook keeps identity/contact only. Transitional: import may create baseline for new NIPs. |

## 16. Open questions / DISCOVERY

- DISCOVERY: actual distribution of `employment_status`/`employment_type` values and data quality (counts only, gathered read-only on production with owner approval; never exported).
- DISCOVERY: whether YSQ uses skorsing/suspension or cuti di luar tanggungan as an employment state (the latter is currently handled as Cuti Tanpa Gaji in the leave module).
- TBD: exact AUTH-011 unit-scope semantics for employee admin permissions.
- TBD: scheduler host for the daily projection refresh on Mi8VPS.
- TBD: whether ORG-006 directory should later publish placement history (default: no; current only).
