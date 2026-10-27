# Employment Administration Package 1 — Status, Contract, Placement, Career Movement, and SK

**Status:** ACCEPTED PRODUCT DIRECTION — owner accepted all decisions D-01..D-19 and their sub-items on 2026-10-16 (§15); runtime steps S1–S3 (schema, read API, admin read screens) merged and released with rollout mode OFF; S2B and S4–S8 not started (see implementation plan)  
**Specifications:** EMP-005, EMP-006, EMP-010  
**Prepared:** 2026-10-16  
**Parent direction:** `docs/domain/employment-administration.md` (ACCEPTED PRODUCT DIRECTION, 2026-09-22)  
**Related:** EMP-001, EMP-004, ORG-001, ORG-004, ORG-006, ORG-007, AUTH-010, AUTH-011, LEAVE-004 (annual-leave eligibility), PAY-003  
**Implementation plan:** `docs/domain/employment-administration-package1-implementation-plan.md`

Dokumen ini mengubah arah EMP-005/EMP-006 menjadi workflow yang dapat di-review dan diimplementasikan secara bertahap. Status ACCEPTED berarti arah produk dan keputusan sudah disetujui owner; implementasi tetap mengikuti langkah S1–S8 di implementation plan, masing-masing dengan PR, test, dan review sendiri. Perubahan production tetap hanya melalui OPS-MI8-REL-001 dengan persetujuan owner. Semua contoh nama, nomor, dan tanggal adalah data sintetis.

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
| Approval workflow in-app (APR-001) untuk tindakan kepegawaian | Keputusan diambil di luar sistem dan dibuktikan oleh Perjanjian Kerja/SK; D-07 diterima (opsi A). | Setelah pilot |
| Perpindahan lintas legal entity | ORG-007 masih discovery; ditolak fail-closed. | ORG-007 |
| Staf BUMY (Badan Usaha Milik Yayasan) | Owner 2026-10-16: staf BUMY **tidak** dikelola di HCIS. Package 1 tidak membuat employment untuk mereka (§8.2). Baris BUMY yang sudah ada di `employees` **tidak dihapus**; ditandai "di luar pengelolaan HCIS" (§8.7). | — |
| Pengurus Yayasan | Owner 2026-10-16: **bukan** status kepegawaian. Pengurus Yayasan tetap memakai principal `FOUNDATION_BOARD` yang sudah ada (akses Panel Organ Yayasan read-only, lihat `account-activation.md` dan MVP checkpoint). Package 1 tidak membuat employment untuk mereka; akun board tidak diubah. Baris master `employees` mereka **tidak dihapus**; ditandai "di luar pengelolaan HCIS" (§8.7). | — |

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
| `service_start_on` | "Tanggal mulai masa kerja". Owner D-05: masa kerja **berlanjut** selama kontrak diperpanjang tanpa putus dengan NIP yang sama (extensions and category changes stay inside one employment, so `service_start_on = started_on`). A **new NIP** means a new employee record and a new masa kerja; nothing is carried over automatically. |
| `ended_on`, `end_reason` | Set only by a Termination action (or baseline). |
| `end_precision` | `DAY` or `MONTH` (baseline from `TAHUN KELUAR (TTTT-BB)` is month precision). |
| `source` | `BASELINE_FROM_MASTER`, `BASELINE_FROM_IMPORT`, or `ACTION`. |

Rule: at most one employment per employee is effective on any date (until ORG-007 allows one per legal entity). Rehire after an ended employment creates a **new** employment; the old one is never reopened by editing. Under D-05 a rehire normally gets a new NIP; a rehire under the same NIP (TBD whether YSQ does this) starts a new employment and a new `service_start_on` unless the owner later decides otherwise.

### 4.2 Employment Term (Masa/Status Kepegawaian & Kontrak)

A term states under which arrangement the employee works for a date range.

| Attribute | Notes |
|---|---|
| `employment_id` | Parent. |
| `category` | Normalized status kepegawaian (owner list, D-02, §4.2.1). Free-text `employment_status` values are mapped during baseline with the explicit mapping table in §4.2.1; unmapped values stay `BELUM_DIKLASIFIKASIKAN`. |
| `effective_from`, `effective_to` | Inclusive Asia/Jakarta dates. `effective_to` null = open-ended (e.g. tetap). Fixed-term categories require `effective_to` (configurable per category, D-03). |
| `contract_reference` | Optional contract number (not an SK). |
| `sequence` | 1, 2, 3 … within the employment; used to show "Kontrak ke-2". |
| `opened_by_action_id` | The action that created it. |

#### 4.2.1 Status kepegawaian vocabulary and mapping (D-02)

Owner's intended list (2026-10-16):

| Code | Label | End date required (D-03) | Basis document (D-08) |
|---|---|---|---|
| `TETAP` | Guru/Pegawai Tetap | No | SK Pengangkatan |
| `KONTRAK` | Pegawai Kontrak | Yes | Perjanjian Kerja |
| `KONTRAK_HONORER` | Pegawai Kontrak Honorer | Yes (honorer staff are on a contract) | Perjanjian Kerja |
| `MAGANG` | Magang | Yes | Perjanjian Kerja (TBD: or a separate internship agreement) |
| `PERCOBAAN` | Masa Percobaan | Yes | Perjanjian Kerja (TBD) |
| `LEPAS` | Pegawai Lepas (kontrak lepas) | Yes | Perjanjian Kerja |

`LEPAS` is an owner-confirmed category of its own (2026-10-16), treated as "kontrak lepas": a fixed-term contract with a mandatory end date.

Values currently found in the active sheet `Master Data SDM YSQ` (column values only, no personal data read) and their baseline mapping:

| Column | Source value | Baseline mapping |
|---|---|---|
| STATUS KEPEGAWAIAN | Pegawai Tetap | `TETAP` |
| STATUS KEPEGAWAIAN | Pegawai Kontrak | `KONTRAK` |
| STATUS KEPEGAWAIAN | Calon Pegawai Tetap | `PERCOBAAN` (owner confirmed: same meaning) |
| STATUS KEPEGAWAIAN | Tenaga Pengabdian | `MAGANG` (owner confirmed) |
| STATUS KEPEGAWAIAN | Pegawai Lepas | `LEPAS` (own category, kontrak lepas with end date; baseline raises `BASELINE_CONTRACT_END_UNKNOWN` because the master has no contract end) |
| STATUS KEPEGAWAIAN | Pengurus Yayasan | **Excluded** — not an employment status; no employment created; issue `BASELINE_EXCLUDED_FOUNDATION_BOARD`; record marked "di luar pengelolaan HCIS" (§8.7). Board access stays with `FOUNDATION_BOARD` accounts. Owner 2026-10-17 (SQ Hub ADR-0009): a **salaried** Pengurus paid through HCIS payroll is an Employee with a real category chosen by HC; they count in "Pegawai aktif" (owner decision ORG-010 D2, 2026-10-17). |
| STATUS KEPEGAWAIAN | Tidak Aktif (stray) | Not a category. SHADOW review issue `BASELINE_CATEGORY_IS_STATUS`; category `BELUM_DIKLASIFIKASIKAN`; status taken from STATUS AKTIF. |
| STATUS AKTIF | Aktif | employment effective |
| STATUS AKTIF | Aktif PKWT | employment effective; category `KONTRAK` (owner confirmed). If STATUS KEPEGAWAIAN is blank or Pegawai Kontrak → `KONTRAK`. If STATUS KEPEGAWAIAN states another category (e.g. Pegawai Tetap) → SHADOW review issue `BASELINE_CATEGORY_CONFLICT_PKWT`, category `BELUM_DIKLASIFIKASIKAN` (never guessed). |
| STATUS AKTIF | Aktif BUMY | **Excluded** — no employment created; issue `BASELINE_EXCLUDED_BUMY`; record marked "di luar pengelolaan HCIS" (§8.7) |
| STATUS AKTIF | Tidak Aktif | employment ended (see §8.2) |
| JENIS KEPEGAWAIAN | Tenaga Pendidik / Tenaga Kependidikan | `staff_type` `PENDIDIK` / `KEPENDIDIKAN` |
| JENIS KEPEGAWAIAN | "#", "-", blank (stray) | `staff_type` null; SHADOW review issue `BASELINE_STAFF_TYPE_MISSING` |

Jenis kepegawaian (`staff_type`) vocabulary is confirmed as exactly **Tenaga Pendidik** and **Tenaga Kependidikan**. Pegawai Kontrak Honorer remains a contract category with a mandatory end date (D-03); it has no separate source value today and is assigned by HC through actions or the SHADOW review.

Note: today's EMP-004 import normalizes every `Aktif …` value (including `Aktif BUMY` and `Aktif PKWT`) to `employees.status = active`, so the distinction survives only in `employee_import_source_snapshots.source_data`. Baseline must read the latest source snapshot for STATUS AKTIF, not only `employees.status`.

Rules:

- Terms inside one employment must not overlap (database exclusion constraint, same `btree_gist` approach as migration 0021).
- Gaps between terms are allowed but shown as a data-quality warning ("Ada jeda antara kontrak ke-1 dan ke-2").
- Legal limits (e.g. maximum PKWT duration, probation only for permanent staff) are **warnings only, never blocking** (D-04 confirmed by the owner 2026-10-16): the preview shows the warning and HC must tick "Saya sudah memeriksa" before saving. The system must not silently block or silently accept; it shows the warning in preview and records that the actor acknowledged it.

### 4.3 Placement (Penempatan)

| Attribute | Notes |
|---|---|
| `employment_id` | Parent. |
| `kind` | `PRIMARY` (penempatan utama, exactly one effective per date while employment is active) or `ADDITIONAL` (jabatan/tugas tambahan, zero or more). Accepted (D-06). |
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

### 4.5 Basis documents: Perjanjian Kerja and Surat Keputusan (EMP-010)

Owner D-01/D-08: the two primary documents are the **Perjanjian Kerja (PK)** and the **Surat Keputusan (SK)**, and they are strictly different:

- **Perjanjian Kerja** — the employment contract between YSQ and the employee. Basis for contract hire and contract extension.
- **Surat Keputusan** — a decision issued by the foundation's authority. Basis for permanent appointment (SK Pengangkatan), transfer, promotion, demotion, and termination.

They are separate document kinds with their own numbering and fields, kept in one register (EMP-010) with `document_kind = PERJANJIAN_KERJA | SURAT_KEPUTUSAN`.

#### 4.5.1 Common fields

| Attribute | Notes |
|---|---|
| `document_kind` | `PERJANJIAN_KERJA` or `SURAT_KEPUTUSAN`. |
| `document_number` | Required. PK numbers and SK numbers are separate series. Uniqueness: per kind + number + signing year (format check with HC sample numbers in S4). |
| `signed_on` | Required. |
| `external_reference` | Optional pointer to where the signed original is kept. No file upload in Package 1. |
| `notes` | Optional. |

#### 4.5.2 Perjanjian Kerja fields

| Attribute | Notes |
|---|---|
| `pk_type` | `PK_BARU` (contract hire) or `PK_PERPANJANGAN` (extension); addendum TBD. |
| `employee_id` | A PK belongs to exactly one employee. |
| `contract_from`, `contract_to` | Contract period stated in the PK; `contract_to` required (all PK categories are fixed-term, D-03). |
| `category` | Status kepegawaian the PK establishes (`KONTRAK`, `KONTRAK_HONORER`, `MAGANG`, `PERCOBAAN`, `LEPAS`). |
| `signatory_employer_label` | Who signed for YSQ (text; optional ORG-004 position stable key). Does not grant authority. |
| `previous_pk_id` | For `PK_PERPANJANGAN`: the PK being extended. |

Rule: the term opened by `HIRE`/`CONTRACT_EXTENSION` must match the PK period and category; a mismatch is rejected (`PK_TERM_MISMATCH`), not silently adjusted.

#### 4.5.3 Surat Keputusan fields

| Attribute | Notes |
|---|---|
| `sk_type` | `SK_PENGANGKATAN`, `SK_MUTASI`, `SK_PROMOSI`, `SK_DEMOSI`, `SK_PEMBERHENTIAN`, `SK_PENEMPATAN` (optional use), `SK_LAINNYA`. |
| `subject` | Short subject ("Penempatan guru semester ganjil 2027/2028"). |
| `issuing_authority_label` | Text (e.g. "Ketua Yayasan"); optional ORG-004 position stable key. Does **not** grant or prove authority. |
| `effective_on`, `effective_to` | Dates stated in the SK; `effective_to` optional. |
| covered employees | An SK may cover one or many employees (collective SK); each link to an action is explicit. |

#### 4.5.4 First-draft field list (superseded by D-08)

Kept for review traceability only.

| Attribute | Notes |
|---|---|
| `document_type` | Superseded by `document_kind` + `pk_type`/`sk_type` (§4.5.2–4.5.3). |
| `document_number` | Required, unique per `document_type` + `issuing_authority_label` + `signed_on` year (DRAFT uniqueness rule). |
| `subject` | Short subject ("Penempatan guru semester ganjil 2027/2028"). |
| `issuing_authority_label` | Text (e.g. "Ketua Yayasan"); optional link to an ORG-004 position stable key. Does **not** grant or prove authority. |
| `signed_on`, `effective_on`, `effective_to` | Dates; `effective_to` optional. |
| `external_reference` | Optional pointer to where the signed original is kept (e.g. "Arsip HC lemari 2 / map 2027"). No file upload in Package 1. |
| `notes` | Optional. |

Rules:

- One SK may be linked to many actions (e.g. one collective SK Mutasi for 12 teachers); each link is explicit per action. A PK links only to actions of its own employee.
- Once a PK/SK is linked to a recorded action, its number/type/dates are immutable; mistakes are fixed by an audited correction that keeps the previous values (D-09, accepted).
- PK and SK are evidence. The structured action, terms, and placements remain domain truth.

## 5. Action taxonomy (Package 1)

Operator labels are in Indonesian; codes are stable API values.

| Code | Label (UI) | Effect | Basis document (D-08) | Notes |
|---|---|---|---|---|
| `BASELINE` | Data awal | Creates employment + first term + current placement from the existing master. System/backfill only. | No | Marked `source = BASELINE_*`; shown as "Data awal dari master pegawai". |
| `HIRE` | Mulai hubungan kerja | New employment, term #1, primary placement. | Contract categories: **PK** (`PK_BARU`) required. Direct hire as `TETAP`: **SK Pengangkatan** required. | Rehire uses this too (new employment). |
| `CONTRACT_EXTENSION` | Perpanjang kontrak | New term of the same fixed-term category starting the day after the current term ends (or a chosen date). | **PK** (`PK_PERPANJANGAN`) required | Previous term unchanged; masa kerja continues (D-05). |
| `CATEGORY_CHANGE` | Ubah status kepegawaian | Closes current term on `effective_on - 1`, opens a new term with another category (e.g. Kontrak → Tetap = pengangkatan pegawai tetap). | To `TETAP`: **SK Pengangkatan** required. To a contract category (e.g. Percobaan → Kontrak): **PK** required. | Same employment; masa kerja continues. |
| `PLACEMENT` | Penempatan | Opens a primary placement when none is effective, or adds/ends an `ADDITIONAL` placement. | Optional (SK if one exists) | Not a career move; used for first placement or added tasks. |
| `TRANSFER` | Mutasi | Closes current primary placement, opens a new one (different unit and/or position) at the same declared level. | **SK Mutasi** required | |
| `PROMOTION` | Promosi | Same mechanics as Transfer; HC declares it a promotion. | **SK Promosi** required | Without a grade model, "naik/turun" is declared by HC with the SK, not computed. |
| `DEMOTION` | Demosi | Same mechanics; reason code required. | **SK Demosi** required | Reason note visibility restricted. |
| `TERMINATION` | Akhiri hubungan kerja | Sets employment `ended_on` to the last working day entered by HC (§7.1), closes open term(s) and placement(s). Reason: `RESIGN`, `KONTRAK_BERAKHIR`, `PENSIUN`, `PEMBERHENTIAN`, `MENINGGAL_DUNIA`, `LAINNYA` (D-10 accepted). | **SK Pemberhentian** required, except reasons `MENINGGAL_DUNIA` and `RESIGN` (optional) | Does **not** remove the employee (EMP-001 removal stays separate). The linked HCIS login account is deactivated **automatically** when the employment ends (D-15, §8.5). |
| `REVERSAL` | Batalkan tindakan | Reverses one earlier recorded action (§6). | No (reason required) | Requires `employment.correct`. |

Not in Package 1: compensation change, grade change, acting authority, cross-entity move, suspension/skorsing (DISCOVERY whether YSQ needs it).

## 6. States and transitions

### 6.1 Employment Action

```text
(preview)  --record-->  RECORDED  --reversal action-->  REVERSED
```

- `preview` is not persisted: `POST …/employment-actions/preview` validates and returns the "dari → menjadi" result without writing.
- There is no saved DRAFT state in Package 1 (keeps the model small). D-07 accepted option A (single recorder), so there is no maker-checker state. If maker-checker is wanted later, add `SUBMITTED -> RECORDED/REJECTED`; the record/terms/placements are created only on `RECORDED`.
- `REVERSED` is terminal. A reversed action stays visible in history with a strike-through and the reversal reason.

Reversal rules:

- Only the **latest recorded** non-reversed action of an employment can be reversed (stack discipline by recording time, not effective date, so a later backdated action is always undone first). To fix an older action, reverse newer ones first, or use an explicit correction sequence. This fails closed instead of silently rewriting later history.
- A reversal is refused (`EMPLOYMENT_ACTION_NOT_REVERSIBLE`) when a field it would restore no longer holds the value the action wrote, when a row it opened is already voided, or when re-opening the employment would overlap another employment of the same employee (e.g. undoing a termination after a rehire).
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
- **Backdated** actions are allowed with a mandatory reason when `effective_on` is before today; beyond a backdating window (31 days, D-13 accepted) they require `employment.correct`.
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

For each employee, including EMP-001-removed employees (`removed_at` set), which are backfilled read-only so history is complete (D-14, accepted):

0. Read STATUS AKTIF / STATUS KEPEGAWAIAN / JENIS KEPEGAWAIAN from the latest `employee_import_source_snapshots.source_data` (because `employees.status` has already collapsed `Aktif BUMY`/`Aktif PKWT` into `active`). If STATUS AKTIF is `Aktif BUMY` → **skip** the employee (no employment), issue `BASELINE_EXCLUDED_BUMY`. If STATUS KEPEGAWAIAN is `Pengurus Yayasan` → **skip** (no employment), issue `BASELINE_EXCLUDED_FOUNDATION_BOARD`; any `FOUNDATION_BOARD` account is left untouched. If no snapshot exists, use `employees` columns and raise issue `BASELINE_NO_SOURCE_SNAPSHOT`.

1. Create one employment:
   - `started_on = employees.started_on`; if null → `start_basis = UNKNOWN`, `started_on = NULL`, data-quality issue `BASELINE_START_UNKNOWN`.
   - If `status IN ('inactive','resigned')` and `ended_on` present → `ended_on` = last day of that month, `end_precision = MONTH`, `end_reason = RESIGN` when status `resigned`, else `LAINNYA_DARI_MASTER`.
   - If ended status but no `ended_on` → issue `BASELINE_END_UNKNOWN`; employment ended with `ended_on = NULL`, `end_basis = UNKNOWN` (explicitly not "active").
   - If status `active` but `ended_on` present → issue `BASELINE_STATUS_CONFLICT`; employment left active; HC must resolve.
2. Create term #1: `category` = mapped `employment_status` (mapping table §4.2.1, D-02), `effective_from = started_on`, `effective_to = ended_on` or NULL. Contract end dates are **not** known from the master; fixed-term categories get issue `BASELINE_CONTRACT_END_UNKNOWN` instead of an invented date.
3. Create one PRIMARY placement from `organizational_unit_id`, `position_id`, labels; `effective_from = baseline cutoff date`, `effective_from_basis = BASELINE_ASSUMED`. The placement does **not** claim the employee has held the position since TMT.
4. Create one `BASELINE` action referencing the source import job (`source_last_import_job_id`) and its source snapshot id.

The command:

- runs `--dry-run` by default and prints counts and issue codes only (no names, no NIP) to stdout; detailed per-employee issues go to the consistency report behind `employment.read`;
- is idempotent: an employee that already has an employment is skipped;
- writes `employment.baseline.created` audit per employee and one summary audit event per run;
- requires mode `OFF` or `SHADOW`; refuses in `AUTHORITATIVE`;
- **never** deactivates accounts: baseline employments that are already ended do not trigger the D-15 automatic deactivation (their account state is whatever access administration set before). Only a `TERMINATION` action recorded in `AUTHORITATIVE` does.

### 8.3 Data-quality review before AUTHORITATIVE

HC reviews the consistency report in SHADOW: unknown start dates, unknown contract end dates, unmapped categories, status conflicts, employees without unit/position, and differences between `structural_label`/ORG-004 incumbency. HC fixes them by:

- correcting the source workbook and re-importing while in SHADOW, then re-running baseline for affected employees (baseline re-run allowed only while the employee has only a `BASELINE` action); or
- after AUTHORITATIVE, recording real actions (e.g. `CONTRACT_EXTENSION` with the actual contract dates).

Exit criteria for AUTHORITATIVE are listed in the implementation plan.

### 8.4 Compatibility projection

- On every recorded/reversed action, the projection writer updates the nine `employees` columns from the resolver **in the same transaction**.
- A daily job (and a manual "refresh" command) at 00:05 Asia/Jakarta re-projects employees whose state changes on that date (scheduled future actions, contract end flags). The job is idempotent and writes one summary audit event. DISCOVERY: Mi8VPS has no systemd/cron for the API; the job must run under the existing `sq-core-worker.sh` supervision or as an in-process scheduler — decide in step S5 with ops review.
- If the projection job has not run, the resolver-based screens are still correct; only legacy consumers are stale. The consistency report shows "Proyeksi tertinggal" when any employee's projection differs from the resolver.

### 8.5 Account and access boundary (D-15: automatic deactivation, time-boxed reactivation)

Account facts stay in AUTH tables; employment records never store account status. D-15 (owner, 2026-10-16) adds one **explicit, audited cross-boundary effect**: when an employment ends, the employee's HCIS login account is deactivated automatically. This is an auth change and needs the extra review AGENTS.md §8 requires, plus permission tests.

No other action (hire, extension, category change, placement, transfer, promotion, demotion) changes an account, role assignment, password, MFA, or Keycloak/OIDC state.

#### 8.5.1 Automatic deactivation on termination

- **Trigger:** a recorded `TERMINATION` action in mode `AUTHORITATIVE`. Not baseline, not import, not mode changes.
- **When:** at the start of the day after `ended_on` (Asia/Jakarta). If `ended_on` is already in the past when HC records the action, deactivation happens in the same transaction. If it is in the future, the daily job (§8.4) performs it; the preview tells HC: "Akun login pegawai akan dinonaktifkan otomatis mulai 1 Agu 2027."
- **What:** every `principal_type = EMPLOYEE` account linked to that employee with status `invited` or `active` becomes `inactive`; all sessions and activation tokens are revoked (the same effects as today's `PATCH /admin/access/accounts/:accountId/status`). `suspended` accounts stay `suspended`. Role assignments are not deleted (their effect already depends on an active account and active employee).
- **Fail closed if the job is late:** session validation and login additionally deny an EMPLOYEE principal whose latest employment has `ended_on < today` and who has no valid temporary reactivation (§8.5.2), even before the job has run.
- **Scope:** only the HCIS account. The shared Akun SQ (Keycloak/SQ Hub identity) and other applications are not changed; OIDC sign-in to HCIS is still refused because the HCIS account is inactive. Whether Akun SQ itself should be disabled is an SQ Hub decision outside this package.
- **Reversal of a termination** does **not** reactivate the account automatically (fail closed). HC reactivates it through the normal access flow; the reversal preview says so.
- **Audit:** `account.status.updated` (existing event) with `actor = system`, `cause = employment_termination`, `employmentActionId`, plus `employment.account.deactivated`.

#### 8.5.2 Time-boxed temporary reactivation

Purpose: a former employee may briefly need access (e.g. to download own payslips or finish a handover).

- Only an **HC Admin** (holder of `access.accounts.temporary_reactivate`, granted to `human_capital_admin`) grants a **temporary reactivation**, with a mandatory reason and a mandatory expiry (`expires_at`). Maximum **30 days** (owner, 2026-10-16); the form defaults to 7 days. No open-ended reactivation exists for an ended employment.
- The grant is a separate record (`account_temporary_reactivations`: account, granted by, reason, starts at, expires at, revoked at/by), never a plain status flip without expiry.
- While valid, the account can sign in. **What it may access** is an explicit allowlist of own read-only self-service pages (owner, 2026-10-16): **own payslips, own attendance history, own leave history**. Nothing else — no submissions, no requests, no HC/admin/approver capability, not even own employment history. Every other permission check keeps requiring an active employee.
- On expiry, the account returns to `inactive` automatically and its sessions are revoked; login/session checks also enforce `expires_at` directly, so a late job cannot extend access.
- The admin can revoke early. Granting to one's own account is forbidden. Extending means a new grant with a new reason (audited), within the maximum.
- Audit: `account.temporary_reactivation.granted`, `.revoked`, `.expired` (ids, dates, reason length — not the reason text).

### 8.6 Rollback plan

| Stage | Rollback |
|---|---|
| Schema deployed, mode `OFF` | Additive tables only; no consumer reads them. Leave in place, or run the documented down script (drop new tables/permissions) before any baseline is loaded. Restore not required. |
| Baseline loaded but no real action, schema must go | Mode OFF → verified backup + `pg_dump --data-only -t 'employment*'` export → purge baseline rows in one transaction with `SET LOCAL hcis.employment_baseline_purge = 'on'` → down script. Full steps in the `0056_employment_history_foundation.sql` header. TRUNCATE is always refused. |
| Baseline loaded, mode `SHADOW` | Set mode `OFF`. Optionally purge baseline rows with the backfill command's `--purge-baseline` (only rows whose sole action is `BASELINE`). `employees` columns were never written by the new code, so nothing to restore. |
| Outside-HCIS markers applied (§8.7) | Unmark with reason (audited); no data was deleted, so nothing to restore. |
| Mode `AUTHORITATIVE` with real actions | Set mode `OFF`: automatic deactivation stops (accounts already deactivated stay inactive; HC reactivates manually if needed); import becomes the writer again and projection stops; `employees` keeps the last projected values. History tables are **kept** (never dropped once real actions exist) so no administrative fact is lost; re-enabling `AUTHORITATIVE` later requires re-running the consistency report because imports may have changed columns meanwhile. A verified database backup is taken before switching to `AUTHORITATIVE` (OPS-MI8 backup procedure). |

### 8.7 Records outside HCIS management ("di luar pengelolaan HCIS")

Owner, 2026-10-16: BUMY staff and Pengurus Yayasan records already in `employees` are **not deleted**. They are marked as outside HCIS management.

- **Marker:** a dedicated management-scope marker on the employee record (`management_scope = MANAGED | OUTSIDE_HCIS`, with reason code `BUMY` or `PENGURUS_YAYASAN`, marked at/by, audited). It is separate from EMP-001 `removed_at` (population removal) and from `status` (employment status). This is an EMP-001 change delivered inside Package 1 (plan step S2B).
- **How records get marked:** the baseline dry-run lists candidates (from the source snapshot values `Aktif BUMY` and `Pengurus Yayasan`); HC confirms them in the SHADOW review; applying marks them. Marking is never inferred silently by an import commit — the import preview flags new candidates for HC to confirm.
- **Read-only:** contact edits, manager assignment, employment actions, and import updates are refused for marked records (`EMPLOYEE_OUTSIDE_HCIS_READ_ONLY`); the import preview shows them as "Di luar pengelolaan HCIS — dilewati".
- **Hidden from active lists:** excluded from the default admin employee list, active-employee counts, Board aggregates, workflow eligibility (leave, attendance scheduling, approval routing), and ORG-006 directory publishing. The admin list has a filter "Di luar pengelolaan HCIS" to find them.
- **History preserved:** existing leave, attendance, payslip, import-snapshot, and audit history stays readable to authorized readers; nothing is deleted or rewritten.
- **Accounts:** `FOUNDATION_BOARD` accounts of Pengurus Yayasan are not linked to employee records and are unaffected. Any `EMPLOYEE` account still linked to a marked record is listed in the consistency report for HC/access review; this package does not change it automatically.
- **Reversible:** HC Admin can unmark with a reason (audited), e.g. if a record was marked by mistake.
- **Audit:** `employee.management_scope.changed` (employee id, from, to, reason code).

## 9. Permissions and visibility

New permission keys (additive migration, assigned explicitly — never inferred from job title or ORG-004 position):

| Permission | Grants | Proposed default assignment |
|---|---|---|
| `employment.read` | Read employment, terms, placements, actions, SK metadata, consistency report for employees within the actor's existing employee-admin scope. | `human_capital_admin` |
| `employment.manage` | Preview/record actions types `HIRE` … `TERMINATION`; create/edit unlinked SK records. | `human_capital_admin` |
| `employment.correct` | `REVERSAL`, backdating beyond the window, PK/SK correction after link, baseline re-run per employee. | D-16 (accepted): senior HC officer only, granted as a separate explicit assignment — not part of the default `human_capital_admin` bundle. |
| `access.accounts.temporary_reactivate` | Grant/revoke a time-boxed reactivation of an ended employee's HCIS account (§8.5.2). | `human_capital_admin` only (owner, 2026-10-16). Not granted to Super Admin. Requires an active account different from the target. |

- Scope: verified in S2 — AUTH-011 permissions are effective only through **organization-scoped** role assignments (`scope_type = 'organization'`); unit-scoped assignments never satisfy an organization permission. So an `employment.*` holder acts on all employees; there is no unit-scoped employment administration in Package 1.
- Self-approval guard: an actor cannot record an action on their **own** employee record (`EMPLOYMENT_SELF_ACTION_FORBIDDEN`).
- Super Admin (technical) does not receive `employment.manage` by default (least privilege; MVP keeps Super Admin out of HR decisions). Mode switching uses `access.governance.manage`.
- Employee self-service (`employees.read.own`), D-17 accepted — employee sees own current status, current placement, contract end date, and a timeline of action type + date + unit/position + PK/SK number. Employee does **not** see `reason_note`, demotion reason code, or internal notes.
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
| `employment.decision_document.created` / `.updated` / `.corrected` | PK/SK register | document id, kind, type, changed field names |
| `employment.decision_document.linked` | Link to action | document id, action id |
| `employment.projection.refreshed` | Daily/manual job | date, number of employees re-projected, number of mismatches |
| `employment.mode.changed` | Rollout mode | from, to, reason length, actor |
| `employment.import.fields_ignored` | Import commit in AUTHORITATIVE | import job id, count of employees with ignored fields |
| `employment.account.deactivated` | Automatic deactivation (D-15) | employee id, account id(s), employment action id, effective date, sessions revoked count |
| `account.temporary_reactivation.granted` / `.revoked` / `.expired` | Time-boxed reactivation (D-15) | account id, grant id, actor, starts/expires at, reason length |
| `employee.management_scope.changed` | Mark/unmark outside HCIS management (§8.7) | employee id, from, to, reason code |

## 11. Approval needs

- Package 1 records decisions already taken outside HCIS; the PK or SK is the approval evidence. HCIS does not route an approval request for these actions. D-07 accepted option A: one HC officer records with the PK/SK as evidence.
- Required basis document per action type is configurable policy with the accepted defaults in §5 (D-08). When required and missing → `DECISION_DOCUMENT_REQUIRED`; when the wrong kind is linked (e.g. an SK for a contract extension) → `DECISION_DOCUMENT_KIND_INVALID`.
- Maker-checker (D-07 option B) is not used in Package 1; it remains a possible later option.
- No action changes ORG-004 authority. If an action places someone into an ORG-004 authority-bearing position, the preview says: "Penempatan ini tidak mengubah kewenangan approval. Perbarui juga Struktur Organisasi (draft perubahan) bila pegawai ini menjadi pemegang jabatan." The consistency report lists placement vs incumbency mismatches. D-18 (confirmed 2026-10-16): a placement into a head seat does **not** update ORG-004 incumbency automatically; HCIS shows the mismatch warning in the preview and in the consistency report, and the ORG-004 change is made by the organization administrator in the Organization Designer.

## 12. Failure behaviour

All failures return an error code and an Indonesian message; nothing is partially written (single transaction per action).

| Code | HTTP | Condition | UI message (Indonesian) |
|---|---|---|---|
| `EMPLOYMENT_MODE_NOT_AVAILABLE` | 409 | Switching to AUTHORITATIVE before S5/S5A are released. | "Mode AUTHORITATIVE belum tersedia pada rilis ini." |
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
| `DECISION_DOCUMENT_REQUIRED` | 422 | PK/SK required by policy. | "Tindakan ini membutuhkan dokumen dasar (Perjanjian Kerja atau SK)." |
| `DECISION_DOCUMENT_KIND_INVALID` | 422 | Wrong kind/type for the action (e.g. SK for an extension). | "Jenis dokumen tidak sesuai. Perpanjangan kontrak memakai Perjanjian Kerja; mutasi/promosi/demosi/pengangkatan/pemberhentian memakai SK." |
| `PK_TERM_MISMATCH` | 422 | Contract period/category differs from the linked PK. | "Masa kontrak tidak sama dengan yang tertulis di Perjanjian Kerja." |
| `DECISION_DOCUMENT_LOCKED` | 409 | Editing a PK/SK already linked. | "Dokumen sudah dipakai pada tindakan; gunakan koreksi." |
| `DECISION_DOCUMENT_NOT_FOUND` | 404 | The PK/SK, or the previous PK referenced, does not exist. (Added with S4.) | "Dokumen tidak ditemukan." |
| `DECISION_DOCUMENT_NUMBER_TAKEN` | 409 | The number already exists in the same kind and signing year. (Added with S4.) | "Nomor dokumen ini sudah tercatat untuk tahun yang sama." |
| `DECISION_DOCUMENT_INVALID` | 400 | A required field of the kind is missing or inconsistent; the response carries the offending `field`. (Added with S4.) | Field-specific, e.g. "Tanggal akhir kontrak wajib diisi." |
| `EMPLOYEE_NOT_FOUND` | 404 | The employee of a Perjanjian Kerja does not exist. (Added with S4.) | "Pegawai tidak ditemukan." |
| `EMPLOYMENT_ACTION_NOT_REVERSIBLE` | 409 | Not the latest action, already reversed, or baseline. | "Tindakan ini tidak dapat dibatalkan." |
| `EMPLOYMENT_ACTION_NOT_FOUND` | 404 | The action does not exist. (Added with S7.) | "Tindakan tidak ditemukan." |
| `EMPLOYEE_ACCOUNT_REQUIRED` | 403 | A non-employee account opening the employee self-service page. (Added with S7.) | "Halaman ini hanya untuk akun pegawai." |
| `EMPLOYMENT_VERSION_CONFLICT` | 409 | `expectedVersion` stale (concurrent edit). | "Data berubah sejak Anda membuka halaman. Muat ulang lalu ulangi." |
| `EMPLOYMENT_BASELINE_MISSING` | 409 | Action on an employee without baseline in AUTHORITATIVE. | "Data awal kepegawaian pegawai ini belum tersedia." |
| `EMPLOYMENT_BACKDATE_REASON_REQUIRED` | 400 | Effective date before today without a reason. | "Tindakan yang berlaku mundur wajib disertai alasan." |
| `EMPLOYMENT_TERM_END_REQUIRED` | 400 | Fixed-term category (D-03) without an end date. | "Status kepegawaian ini wajib memiliki tanggal akhir kontrak." |
| `EMPLOYMENT_TERM_INVALID` | 422 | Unclassified category, end before start, `TETAP` with an end date, same category again, or extension of a non-contract term. | "Status kepegawaian atau masa kontrak tidak valid." |
| `EMPLOYMENT_REASON_REQUIRED` | 400 | Termination/demotion/reversal without a valid reason code. | "Pilih alasan tindakan." |
| `EMPLOYMENT_WARNINGS_NOT_ACKNOWLEDGED` | 409 | Recording while a preview warning (D-04) is not acknowledged. | "Periksa dan centang peringatan sebelum menyimpan." |
| `DECISION_DOCUMENT_EMPLOYEE_MISMATCH` | 422 | Perjanjian Kerja of another employee linked. | "Perjanjian Kerja ini milik pegawai lain." |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Recording an action without the header. (Added with S5.) | "Permintaan tindakan membutuhkan header Idempotency-Key." |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | The key already recorded an action for another employee. (Added with S5.) | "Kunci idempotensi ini sudah dipakai untuk pegawai lain." |
| `EMPLOYMENT_EXCLUDED_BUMY` | 422 | Action on an employee excluded as BUMY staff. | "Staf BUMY tidak dikelola di HCIS." |
| `EMPLOYMENT_EXCLUDED_FOUNDATION_BOARD` | 422 | Action on a record excluded as Pengurus Yayasan. | "Pengurus Yayasan bukan pegawai; aksesnya diatur sebagai akun Organ Yayasan." |
| `EMPLOYEE_OUTSIDE_HCIS_READ_ONLY` | 409 | Any write to a record marked outside HCIS management. | "Data ini di luar pengelolaan HCIS dan hanya dapat dibaca." |
| `REACTIVATION_EXPIRY_REQUIRED` | 400 | Temporary reactivation without expiry or beyond maximum. | "Tentukan tanggal berakhir akses (maksimal 30 hari)." |
| `REACTIVATION_SELF_FORBIDDEN` | 403 | Admin targets own account. | "Anda tidak dapat mengaktifkan kembali akun Anda sendiri." |
| `REACTIVATION_NOT_APPLICABLE` | 409 | Employment still active or account suspended. | "Akun ini tidak memerlukan aktivasi sementara." |
| `REACTIVATION_NOT_FOUND` | 404 | No live grant to revoke. (Added with S5A.) | "Aktivasi sementara tidak ditemukan." |
| `EMPLOYMENT_ENDED` | 401 | The latest employment ended and no grant is valid. (Added with S5A.) | "Hubungan kerja sudah berakhir, sehingga akun HCIS tidak aktif." |
| `EMPLOYMENT_ENDED_READ_ONLY` | 403 | A reactivated account outside the allowlist. (Added with S5A.) | "Akses sementara hanya untuk slip gaji, riwayat kehadiran, dan riwayat cuti Anda sendiri." |

`POST` requests that record actions require an `Idempotency-Key`; a replay returns the original result.

## 13. Screens (bahasa pengguna)

All screens follow the existing admin shell, with loading, empty, error, forbidden/session-expired, and mobile states (EMP-004-G pattern). Labels below are the user-facing text.

### 13.1 Detail pegawai — tab **Kepegawaian & Kontrak**

- Kartu ringkas: **Status**: Aktif / Akan mulai / Berakhir · **Status kepegawaian**: Kontrak (ke-2) · **Masa kontrak**: 1 Jul 2027 – 30 Jun 2028 · **TMT**: 1 Jul 2026 · **Masa kerja**: 1 tahun 3 bulan.
- Badge peringatan: "Kontrak berakhir dalam 45 hari", "Kontrak sudah lewat dan belum ditindaklanjuti", "Tanggal mulai belum diketahui (data awal)".
- Tabel **Riwayat kontrak**: Ke-, Status kepegawaian, Mulai, Selesai, No. Perjanjian Kerja, SK Pengangkatan (bila tetap).
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
3. **Dasar** — sistem menunjukkan dokumen yang diperlukan: **Perjanjian Kerja** (mulai kontrak, perpanjangan) atau **SK** (pengangkatan tetap, mutasi, promosi, demosi, pemberhentian). Pilih yang sudah ada atau **+ Catat Perjanjian Kerja baru** (nomor PK, jenis: baru/perpanjangan, masa kontrak, status kepegawaian, penanda tangan, tanggal tanda tangan, lokasi arsip) / **+ Catat SK baru** (nomor SK, jenis SK, perihal, pejabat penerbit, tanggal tanda tangan, tanggal berlaku, lokasi arsip).
4. **Periksa** — ringkasan "Dari → Menjadi", daftar peringatan (mis. "Total masa kontrak melebihi batas yang biasa dipakai; pastikan sesuai kebijakan") dengan centang "Saya sudah memeriksa".
5. **Simpan** — pesan sukses: "Promosi dicatat dan berlaku mulai 1 Jul 2027."

Khusus **Akhiri hubungan kerja**, langkah Periksa menampilkan: "Akun login HCIS pegawai ini akan dinonaktifkan otomatis mulai {tanggal sesudah hari terakhir bekerja}. Akses sementara hanya dapat diberikan oleh admin dengan batas waktu."

Mobile: langkah tampil satu per layar dengan tombol Lanjut/Kembali.

### 13.4 Menu **Kepegawaian → Kontrak akan berakhir**

Daftar pegawai dengan masa kontrak berakhir dalam 30/60/90 hari, plus "Sudah lewat, belum ditindaklanjuti". Kolom: Pegawai, Unit, Status kepegawaian, Berakhir, Sisa hari, Aksi (Perpanjang / Akhiri). Filter unit dan rentang.

### 13.5 Menu **Kepegawaian → Perjanjian Kerja & SK**

Dua tab terpisah: **Perjanjian Kerja** (cari nomor/nama pegawai, filter jenis baru/perpanjangan, tahun, status kepegawaian) dan **Surat Keputusan** (cari nomor/perihal, filter jenis SK dan tahun). Detail dokumen memperlihatkan tindakan yang memakainya. Dokumen yang sudah dipakai ditandai "Terkunci".

### 13.6 Menu **Pegawai → Kecocokan Data** (halaman "Periksa Kecocokan Data"; SHADOW dan sesudahnya)

Kelompok masalah dengan jumlah: "Staf BUMY (tidak dikelola)", "Pengurus Yayasan (bukan pegawai)", "Status kepegawaian bertentangan dengan Aktif PKWT", "Jenis kepegawaian kosong/tidak valid", "Tanggal mulai belum diketahui", "Masa kontrak belum diketahui", "Status kepegawaian belum dikelompokkan", "Status aktif bertentangan dengan tanggal keluar", "Tanpa unit/jabatan", "Berbeda dengan Struktur Organisasi", "Proyeksi tertinggal". Setiap baris menautkan ke detail pegawai.

### 13.7 Pegawai — **Profil saya → Kepegawaian** (D-17 disetujui)

Read-only: status, status kepegawaian, masa kontrak, unit/jabatan saat ini, riwayat singkat (jenis tindakan, tanggal, unit/jabatan, nomor PK/SK).

### 13.8 Menu **Akses → Akun** — **Aktifkan sementara** (D-15)

Untuk akun pegawai yang hubungan kerjanya sudah berakhir: tombol **Aktifkan sementara** (hanya untuk HC Admin) membuka form *Alasan* (wajib) dan *Akses berakhir pada* (wajib, maksimal 30 hari). Info di form: "Selama akses sementara, pegawai hanya dapat melihat slip gaji, riwayat kehadiran, dan riwayat cuti miliknya sendiri." Daftar akun menampilkan badge "Aktif sementara s.d. 14 Agu 2027" dan tombol **Hentikan sekarang**. Pesan setelah kedaluwarsa: "Akses sementara berakhir; akun kembali nonaktif."

### 13.9 Daftar pegawai — **Di luar pengelolaan HCIS**

Daftar pegawai default hanya menampilkan pegawai yang dikelola HCIS. Filter **Di luar pengelolaan HCIS** menampilkan staf BUMY dan Pengurus Yayasan dengan badge abu-abu "Di luar pengelolaan HCIS — BUMY" / "— Pengurus Yayasan". Detailnya hanya bisa dibaca; semua tombol ubah disembunyikan. Riwayat cuti, kehadiran, dan slip tetap terlihat bagi yang berwenang.

## 14. Acceptance criteria

EMP-005:

- EMP-005-A: Recording `HIRE`, `CONTRACT_EXTENSION`, `CATEGORY_CHANGE`, `TERMINATION` creates new term/employment rows and never updates or deletes an earlier term except setting its closure through the action, all in one transaction with an audit event.
- EMP-005-B: Current status/category/contract dates are derived by the resolver for any date; a future-dated action changes the derived state only from its effective date.
- EMP-005-C: Overlapping employments/terms, out-of-order actions, and missing effective dates are rejected with the codes in §12; no partial write.
- EMP-005-D: A fixed-term contract that passes its end date is flagged, not auto-terminated.
- EMP-005-E: Baseline backfill is idempotent, dry-run by default, never invents contract end or start dates, and records issue codes.
- EMP-005-F: In `AUTHORITATIVE`, EMP-004 import does not overwrite employment fields for baselined employees and reports ignored fields; in `OFF`/`SHADOW` import behaviour is unchanged.
- EMP-005-G: The `employees` projection equals the resolver result after every action and after the daily refresh; annual-leave eligibility, Board, and ORG-006 outputs are unchanged for unchanged data.
- EMP-005-H: No action other than `TERMINATION` changes any account; no action changes roles or permissions.
- EMP-005-I (D-15): A recorded `TERMINATION` deactivates the linked EMPLOYEE account(s) and revokes sessions/activation tokens from the day after `ended_on`; login and session checks deny the account even if the daily job has not run; baseline and reversal never reactivate or deactivate accounts.
- EMP-005-J (D-15): Temporary reactivation requires reason and expiry within the maximum, cannot target one's own account, is grantable only by HC Admin (max 30 days), grants only own payslips, own attendance history, and own leave history, ends automatically at expiry (enforced at login/session time), and every grant/revoke/expiry is audited. Positive and negative auth tests are mandatory.
- EMP-005-L (§8.7): BUMY and Pengurus Yayasan records are never deleted; once marked "di luar pengelolaan HCIS" they are read-only, hidden from active lists/counts/workflow eligibility/ORG-006, keep their history, and every mark/unmark is audited.
- EMP-005-K (D-02): Baseline excludes `Aktif BUMY` and `Pengurus Yayasan` records (no employment; FOUNDATION_BOARD accounts untouched), maps the §4.2.1 values (Calon Pegawai Tetap → Masa Percobaan, Tenaga Pengabdian → Magang, Aktif PKWT → Pegawai Kontrak, Pegawai Lepas → Lepas), and sends conflicts and stray values to the SHADOW review list as `BELUM_DIKLASIFIKASIKAN`.

EMP-006:

- EMP-006-A: `PLACEMENT`, `TRANSFER`, `PROMOTION`, `DEMOTION` close the previous primary placement at `effective_on - 1` and open a new one; career history shows "dari → menjadi" with SK.
- EMP-006-B: At most one PRIMARY placement is effective per date; ADDITIONAL placements are supported per D-06.
- EMP-006-C: Placements reference ORG-004 by stable key (or legacy reference before ORG-004 acceptance) and are validated against the structure effective on the date.
- EMP-006-D: No EMP-006 action changes ORG-004 incumbency, authority bindings, rollout, or existing approval snapshots; mismatches are reported.
- EMP-006-E: Reversal of the latest action restores the previous state exactly and keeps both actions visible.

EMP-010:

- EMP-010-A: Perjanjian Kerja and SK are separate document kinds with their own numbering and fields; both can be created, searched, and linked to actions (SK to many employees, PK to one).
- EMP-010-B: An SK linked to a recorded action cannot be silently edited; corrections keep prior values and are audited.
- EMP-010-C: The required document kind is enforced per action type (§5); a wrong kind and a PK/term mismatch are rejected.

Cross-cutting:

- EMP-PKG1-X1: `employment.read`, `employment.manage`, `employment.correct`, `access.accounts.temporary_reactivate` each have positive/negative backend tests, including self-action denial and unit-scope denial.
- EMP-PKG1-X2: All screens have loading, empty, error, forbidden, and mobile states verified in a browser with synthetic data.
- EMP-PKG1-X3: Audit payloads contain no reason notes, contact data, or identity numbers.

## 15. Owner decisions (recorded 2026-10-16)

Status: **Accepted** = owner accepted (as proposed or as amended). All 19 decisions and their sub-items are accepted as of 2026-10-16; no owner decision remains open for Package 1.

| ID | Decision | Status | Outcome |
|---|---|---|---|
| D-01 | Package 1 scope. | Accepted | Package 1 records the employment journey: hire, status/contract, placement, transfer/promotion/demotion, termination. Two separate document kinds: PK (contract hire, extension) and SK (permanent appointment, transfer, promotion, demotion, termination). Education/family/statutory/grade/compensation deferred. |
| D-02 | Status kepegawaian / jenis kepegawaian vocabulary and mapping. | Accepted | Categories: Pegawai Tetap, Pegawai Kontrak, Pegawai Kontrak Honorer, Magang, Masa Percobaan, Pegawai Lepas. Mapping: Calon Pegawai Tetap → Masa Percobaan; Tenaga Pengabdian → Magang; Aktif PKWT → Pegawai Kontrak; Pengurus Yayasan → not employment (FOUNDATION_BOARD); Aktif BUMY → excluded; stray values → SHADOW review. Jenis: Tenaga Pendidik / Tenaga Kependidikan (§4.2.1). Pegawai Lepas = kontrak lepas with end date. Existing BUMY/Pengurus Yayasan records kept and marked outside HCIS management (§8.7). |
| D-03 | Categories requiring an end date. | Accepted | Kontrak, Kontrak Honorer (honorer staff are on a contract), Magang, Percobaan, Lepas (kontrak lepas): required. Tetap: not required. |
| D-04 | Contract length/probation rules: block or warn. | Accepted | Warnings only, no blocking; HC acknowledges before saving. |
| D-05 | Masa kerja on extension and rehire. | Accepted (amended) | Masa kerja continues while the contract is extended continuously under the same NIP; a new NIP means a new masa kerja start. |
| D-06 | ADDITIONAL placements (jabatan/tugas tambahan). | Accepted | Yes. |
| D-07 | Recording model. | Accepted | A: one HC officer records with PK/SK as evidence. |
| D-08 | Mandatory basis document per action. | Accepted (amended) | PK and SK strictly separate. **PK**: contract hire, contract extension. **SK**: permanent appointment (SK Pengangkatan), transfer, promotion, demotion, termination (optional for resign/death). Separate kinds, numbers, and fields. |
| D-09 | Fixing a mistyped document already used. | Accepted | Audited correction keeping old values. |
| D-10 | Termination reasons. | Accepted | Resign, Kontrak berakhir, Pensiun, Pemberhentian, Meninggal dunia, Lainnya. |
| D-11 | Contract reminder window. | Accepted | 60 days (list also shows 30/90). |
| D-12 | Expired contract without follow-up. | Accepted | Flag only, no auto-end. |
| D-13 | Backdating window before extra permission. | Accepted | 31 days. |
| D-14 | Backfill EMP-001-removed employees. | Accepted | Yes, read-only. |
| D-15 | Account on termination. | Accepted (changed) | **Automatic** deactivation of the HCIS login account when the employment ends; an admin may grant a time-boxed, audited temporary reactivation with a mandatory reason and expiry (§8.5). Auth change → extra review. Sub-items accepted: maximum 30 days; access limited to own payslips, own attendance history, own leave history; granted only by HC Admin with mandatory reason, audited, auto-expiring. |
| D-16 | Holder of `employment.correct`. | Accepted | Senior HC officer only, separate assignment. |
| D-17 | Employee sees own employment history. | Accepted | Yes, without reasons/internal notes. |
| D-18 | Should a placement into a head seat also update ORG-004 incumbency automatically? | Accepted | No automatic ORG-004 seat update; mismatch warning and report only. |
| D-19 | Workbook role after AUTHORITATIVE. | Accepted | New hires via **Mulai hubungan kerja**; workbook keeps identity/contact only; transitional baseline for new NIPs allowed. |

## 16. Remaining implementation-time checks (no owner decision needed)

- Done 2026-10-16: distinct values of STATUS KEPEGAWAIAN / STATUS AKTIF / JENIS KEPEGAWAIAN collected from the active master sheet (values only, §4.2.1). Counts per value remain DISCOVERY for the SHADOW review.
- TBD: whether YSQ ever rehires under the same NIP.
- DISCOVERY: whether YSQ uses skorsing/suspension or cuti di luar tanggungan as an employment state (the latter is currently handled as Cuti Tanpa Gaji in the leave module).
- Resolved in S2: AUTH-011 employee-admin permissions are organization-scoped only (§9).
- Finding in S2: no code in the repository wrote `employee_import_source_snapshots` (the table came from a recovered production migration). S2 adds the writer for the four classification columns; production rows written by any earlier importer are unknown (DISCOVERY, read-only count before baseline). **Before the baseline dry-run, HC must re-import the current master once** so every employee has a snapshot; otherwise `BASELINE_NO_SOURCE_SNAPSHOT` is raised and BUMY staff cannot be detected.
- Follow-up: `docs/api/openapi.yaml` does not parse as YAML at the ADMS device schema (pre-existing on main); employment paths live in `docs/api/employment.openapi.yaml`.
- TBD: scheduler host for the daily projection refresh on Mi8VPS.
- TBD: whether ORG-006 directory should later publish placement history (default: no; current only).
