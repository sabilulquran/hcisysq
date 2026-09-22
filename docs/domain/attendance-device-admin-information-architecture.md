# Historical Fingerprint Device Admin Information Architecture\n\n> This document used ATT-006 before the canonical capability map reserved ATT-006 for Mobile Attendance. It is retained as historical design evidence only. The accepted operational source of truth is `attendance-adms-operational-management.md` (ATT-012).

**Status:** SUPERSEDED by ATT-012  
**Parent:** `ATT-005 — WDMS-Compatible Fingerprint Device Operations`  
**Updated:** 2026-08-30

## Decision under review

HCIS shall redesign the Super Admin fingerprint-device experience from one long multi-purpose page into a route-based, table-first device-management workspace.

The redesign keeps the existing ATT-005 device, command, raw-attendance, mapping, correction, and biometric safety boundaries. It changes information architecture, navigation, vocabulary, loading behavior, and task presentation so ordinary administration does not look like a protocol-debugging console.

No ADMS wire behavior, command semantics, attendance projection rule, PIN-mapping invariant, destructive-operation boundary, or biometric collection policy is relaxed by this specification.

## Why this specification exists

The current `/admin/attendance/devices` route mounts several large operational and diagnostic surfaces together:

- connectivity, discovery, recovery, and command operations;
- device detail and lifecycle administration;
- PIN mapping assistant;
- user-name synchronization and correction planning;
- historical USERINFO command evidence, with active USERINFO reads retired;
- Wave 1 detail/diagnostics;
- Wave 2 biometric control plane.

This creates four product problems.

1. **Information overload.** Ordinary device administration and engineering canary controls share the same visual hierarchy.
2. **Weak task hierarchy.** Registering a device, inspecting connectivity, mapping a PIN, reading a user, recovering transactions, inspecting commands, and controlling biometric pilots appear as peer sections instead of separate tasks.
3. **Duplicated device context.** Multiple mounted components keep their own selected device and load their own device lists, so the page can conceptually hold several different device selections at once.
4. **Hidden work is still work.** Collapsing technical panels with `<details>` reduces visible height but does not create a separate task boundary; hidden React children may still mount, fetch, or poll.

The result is closer to an internal engineering cockpit than an operational HCIS product surface.

## Research basis

### HCIS sources

This proposal is constrained by:

- `docs/design/ui-guidelines.md`;
- `docs/design/ui-foundation.md`;
- `docs/domain/attendance-adms-admin.md`;
- `docs/domain/attendance-adms-mapping-assistant.md`;
- `docs/domain/attendance-adms-device-user-correction.md`;
- `docs/domain/attendance-wdms-device-parity.md`;
- `docs/domain/attendance-wdms-implementation-plan.md`;
- `docs/domain/attendance-foundation.md`.

Existing UI guidance already requires:

- one obvious primary action per task;
- desktop-efficient administration;
- practical table filtering/sorting/pagination where data volume warrants it;
- safe loading/error/empty states;
- status meaning that is not communicated by color alone.

### WDMS reference

ATT-005 already defines ZKBio WDMS as the primary behavior/reference source for relevant device operations.

Reference material reviewed for this IA includes:

- ZKBio WDMS 9.0.5 User Manual, 2025-08-15;
- the ZKTeco ZKBio WDMS product/download page, which lists WDMS 9.0.7 as the published software build on 2026-05-20;
- earlier WDMS user manuals where screenshots are easier to inspect but navigation concepts remain consistent.

Reference URLs:

- `https://www.zkteco.com/en/ZKBio_WDMS/ZKBio_WDMS`
- `https://new-website-file.s3.ap-southeast-1.amazonaws.com/files/20250818/ZKBio%20WDMS%209.0.5_User%20Manual_20250815.pdf`
- `https://zkteco.eu/sites/default/files/content/downloads/zkbio-wdms_user-manual.pdf`

The product pattern to adopt is not WDMS visual styling. The relevant pattern is its separation of Device Management into distinct list/task surfaces such as Device, Device Command, data/transaction, logs, personnel/device synchronization, and configuration instead of one endlessly stacked page.

## Actor

Primary actor:

- `SUPER_ADMIN`.

Future capability-specific permissions may narrow individual actions, but this specification does not add or broaden permissions.

## User goals

A Super Admin should be able to answer these questions without scanning unrelated technical controls:

1. Which fingerprint devices are online, offline, disabled, or quarantined?
2. Which device needs attention?
3. What users/PINs are known on one selected device, and which HCIS employees are they mapped to?
4. What raw transactions did one device produce?
5. Was a requested device operation delivered and completed?
6. What configuration belongs to the device itself?
7. Where can an authorized technical operator inspect low-level diagnostics when needed?

## Product principles

### 1. List first, detail second

The fingerprint-device landing route is a device list, not a dashboard made from unrelated cards.

A device row opens one persistent device context. Device-specific work happens inside that context.

### 2. Route context is authoritative

The current device is determined by the route parameter, not independent selectors in each child component.

For example:

`/admin/attendance/devices/:deviceId/users`

means every control on that route acts on the same `deviceId`.

No visible page may contain several independent device selectors for different panels.

### 3. Operational vocabulary before protocol vocabulary

Ordinary Admin UI uses task language such as:

- `Baca data pengguna` only as a historical command label;
- `Sinkronkan nama`;
- `Ambil ulang transaksi`;
- `Riwayat perintah`;
- `Hubungkan ke pegawai`;
- `Status koneksi`.

Protocol/internal language such as:

- `USERINFO`;
- `DATA QUERY`;
- `DATA UPDATE`;
- `update_user_info`;
- `Return 0`;
- `CMD DATA`;
- `Wave 1`;
- `Wave 2`;
- `canary`;
- `control plane`;

is restricted to an explicit technical-detail or diagnostics surface.

### 4. Progressive disclosure

Ordinary views show the information needed for the current task.

Raw wire commands, request identifiers, protocol result fields, low-level upload evidence, biometric pilot controls, and hardware-canary tools are not primary page content.

### 5. One obvious primary action per task

A view should not present multiple unrelated primary buttons competing for attention.

Examples:

- device list primary action: `Tambah mesin` when manual registration is relevant;
- users tab primary task: review/search users; per-row actions remain row actions;
- transactions tab primary task: inspect/filter transactions; `Ambil ulang transaksi` is secondary operational action;
- commands tab is primarily observational;
- diagnostics is explicitly technical and may contain several controlled actions because its actor intent differs.

### 6. Hidden UI must not create hidden polling

Collapsed, inactive, or unvisited technical areas must not mount expensive polling/fetch flows merely because they exist in the component tree.

Each route/tab loads only data required by that route/tab.

## Super Admin navigation architecture

The current flat Super Admin navigation should move toward grouped product domains.

Proposed hierarchy:

```text
Ringkasan

Pegawai
  - Daftar Pegawai
  - Impor Pegawai
  - Riwayat Impor

Organisasi
  - Struktur Organisasi

Kehadiran
  - Rekaman Kehadiran
  - Mesin Fingerprint

Cuti
  - Kebijakan Cuti
  - Kalender Kerja

Payslip
  - Pengelolaan Payslip

Sistem
  - Account & Akses
```

Requirements:

- desktop sidebar shows group hierarchy clearly;
- mobile/tablet Admin navigation may use a drawer or grouped compact navigation rather than one overflowing horizontal strip;
- active parent domain remains visually clear when a child route is selected;
- adding future child screens should not create another first-level sidebar item by default.

This grouped navigation is part of the same IA cleanup because `Mesin Fingerprint` is a child capability of the Attendance domain, not an isolated top-level product.

## Route model

### Device collection

`GET UI /admin/attendance/devices`

Purpose:

- answer fleet-level health questions;
- search/filter devices;
- enter one device context;
- optionally register/claim a device through a focused flow.

### Device detail — overview

`GET UI /admin/attendance/devices/:deviceId`

or canonical redirect to:

`/admin/attendance/devices/:deviceId/overview`

### Device users

`/admin/attendance/devices/:deviceId/users`

### Device transactions

`/admin/attendance/devices/:deviceId/transactions`

### Device commands

`/admin/attendance/devices/:deviceId/commands`

### Device settings

`/admin/attendance/devices/:deviceId/settings`

### Technical diagnostics

`/admin/attendance/devices/:deviceId/diagnostics`

Diagnostics is not a normal primary tab in the ordinary Admin task flow. It is reached from an overflow/technical action such as `Diagnostik teknis` and remains `SUPER_ADMIN`-guarded.

All device-detail routes keep the same persistent device header and context.

## Device list specification

### Page header

Title:

`Mesin Fingerprint`

Supporting summary examples:

- `2 mesin`;
- `1 online`;
- `1 offline`;
- `0 perlu tindakan`.

Do not place protocol descriptions in the page header.

### Toolbar

Required:

- search by display name or serial number;
- status filter;
- lifecycle filter when useful;
- explicit refresh state / last refreshed indication.

Future optional filters:

- work location;
- model;
- capability.

### Table

Recommended desktop columns:

- connectivity status;
- device display name;
- serial number;
- work location/context where available;
- last source IP;
- last activity;
- user count;
- transaction count;
- row action menu.

Optional density/column controls may expose model, firmware, push version, fingerprint count, face count, palm count, and last sync without forcing all fields into the default table.

Each row is navigable to Device Detail.

### Status presentation

Connectivity and lifecycle are separate concepts.

Examples:

- `Online` / `Offline` / `Belum diketahui`;
- `Aktif` / `Dinonaktifkan` / `Karantina`.

Color may reinforce status but text/icon must carry the meaning.

### Responsive behavior

Desktop:

- table-first.

Small screens:

- do not squeeze every desktop column;
- use a compact row/card showing status, name, serial, last activity, and a detail affordance.

## Device detail shell

### Persistent header

Every device-detail child route shows:

- display name;
- serial number;
- connectivity status;
- lifecycle status if not normal/active;
- last activity summary;
- optional work-location context.

Example:

```text
SDIT Tahfizh
Online · SPK7245000707 · Terakhir terhubung 8 detik lalu
```

The current device does not change while switching child tabs/routes.

### Operational navigation

Primary device tabs:

1. `Ringkasan`
2. `Pengguna`
3. `Transaksi`
4. `Perintah`
5. `Pengaturan`

`Diagnostik teknis` is separated from the ordinary primary tabs by an overflow/secondary affordance.

## Ringkasan device

Purpose:

- provide fast health/context without exposing command internals.

Show compact groups for:

- connectivity;
- last activity;
- IP;
- model;
- firmware;
- Push/protocol version;
- users;
- fingerprints;
- faces;
- palms where supported;
- transactions;
- last synchronization/reconciliation state when available.

The overview may surface concise attention items such as:

- offline device;
- unresolved mapping count;
- failed recent command count;
- stale reconciliation.

It must not become another long page containing the full users, transactions, commands, and diagnostics tables.

## Pengguna device

This route replaces the current conceptual separation between the large Mapping Assistant panel, Device User Correction panel, and ordinary USERINFO operations.

### Users table

Recommended columns:

- PIN;
- name on device;
- card number;
- mapped HCIS employee;
- mapping status;
- last observed/read time;
- row actions.

Example statuses:

- `Terhubung`;
- `Belum terhubung`;
- `Perlu ditinjau`;
- `Data mesin belum dibaca`.

### Mapping workflow

For an unmapped PIN, `Hubungkan` opens a focused drawer/modal.

The candidate list may use the existing name-only similarity ranking defined by the mapping-assistant specification.

The UI must communicate that:

- similarity is a recommendation only;
- Admin explicitly chooses the employee;
- no PIN/card/NIP/unit/external-id guessing becomes an automatic mapping rule.

The large standalone Mapping Assistant panel is removed once this workflow is available.

### Per-user actions

Row overflow/actions may include only capability-safe operations, for example:

- `Sinkronkan nama`;
- `Koreksi PIN`;
- `Akhiri hubungan ke pegawai` where applicable.

Raw wire-command names are not action labels.

### Name synchronization

`Sinkronkan nama` keeps the existing narrow safety contract:

- target PIN remains the same PIN;
- target name is server-derived from the explicitly mapped HCIS employee;
- no arbitrary USERINFO fields;
- no privilege/card/password/PIN/biometric mutation through this action.

After request creation, the UI shows the human-readable command state. A technical detail drawer may expose protocol evidence if needed.

### PIN correction

`Koreksi PIN` opens a focused workflow explaining that changing a device PIN is not yet executed while biometric-preservation/transfer safety is unproven.

The current safe capability remains planning-only unless a future accepted specification changes that boundary.

Ordinary button label:

`Simpan rencana koreksi`

not:

`Catat koreksi PIN · tidak eksekusi`.

The confirmation must clearly say that the machine is not changed.

## Transaksi device

Purpose:

- inspect raw attendance evidence from one device;
- recover bounded device history when required;
- keep attendance facts separate from lateness/absence/payroll interpretation.

### Transaction table

Filters should support:

- date/time range;
- PIN;
- mapped employee when available;
- source/result context where useful.

Recommended columns:

- device timestamp;
- received timestamp;
- PIN;
- mapped employee;
- raw/source status;
- mapping/projection context summary where appropriate.

### Recovery action

Use the product action label:

`Ambil ulang transaksi`

This opens a modal/dialog asking for a bounded start/end period and explaining that HCIS will ask the selected device to re-upload stored transactions for that period.

The resulting device request appears in `Perintah`.

Do not present `DATA QUERY ATTLOG` as the primary action label.

## Perintah device

Purpose:

- provide one place to answer whether a device operation is waiting, delivered, completed, failed, expired, or cancelled.

### Commands table

Recommended columns:

- command/reference ID, e.g. `C:8`;
- human-readable action;
- status;
- created/requested time;
- delivered time;
- completed time;
- outcome summary.

Examples of human-readable command-history actions:

- `Baca informasi mesin`;
- `Baca data pengguna <PIN>` for preserved historical rows only;
- `Sinkronkan nama pengguna 205291319`;
- `Ambil ulang transaksi 29 Agu 06:15–06:25`.

### Technical detail

Clicking a command may open a drawer/detail panel containing:

- command type;
- reason;
- wire command where disclosure is safe;
- return code;
- result command;
- attempt count;
- low-level timestamps;
- request/source correlation identifiers.

This is where values such as `update_user_info`, `DATA UPDATE USERINFO`, `Return 0`, and `CMD DATA` belong.

Technical detail must never expose biometric payloads, secrets, or casually expose raw sensitive request bodies.

## Pengaturan device

Ordinary settings may contain:

- display name;
- work-location/context assignment when supported;
- lifecycle management;
- timezone/transfer configuration only when capability and ATT-005 implementation status permit it.

Routine settings must not contain destructive biometric/device-reset operations mixed with simple rename/edit controls.

Future destructive maintenance remains a dedicated break-glass flow under ATT-005 safeguards.

## Diagnostik teknis

Purpose:

- preserve engineering observability without making it the ordinary Admin experience.

This route may contain:

- protocol-level command/result evidence;
- safe request/upload diagnostics;
- physical canary tools;
- capability discovery detail;
- Wave implementation verification aids while still needed;
- biometric collection/control-plane metadata and pilot controls subject to existing security gates;
- low-level health/reconciliation evidence.

Rules:

1. `SUPER_ADMIN` only.
2. Not shown as an ordinary primary workflow tab.
3. Clear warning that the surface is for troubleshooting/technical validation.
4. Technical terminology is permitted here.
5. Biometric collection remains governed by existing global + per-device gates and security policy.
6. No raw biometric/template/ciphertext/key material is exposed.
7. Destructive operations remain separately guarded; diagnostics does not become a bypass.
8. The route is lazy-loaded/mounted only when visited; closing or leaving it stops its route-specific polling.

## Vocabulary map

| Internal / protocol term | Ordinary Admin copy |
| --- | --- |
| Mapping | Hubungkan ke pegawai / Hubungan pegawai |
| Historical USERINFO query | Baca data pengguna — historical command label only |
| update_user_info | Sinkronkan nama pengguna |
| DATA QUERY ATTLOG | Ambil ulang transaksi |
| command evidence | Status perintah |
| Command | Perintah |
| Return code | Kode hasil — technical detail only |
| CMD result | Hasil protocol — technical detail only |
| Wave 1 / Wave 2 | hidden from ordinary UI |
| Canary | Tes teknis — diagnostics only |
| Control plane | Pengelolaan biometrik / diagnostics context |
| Safe roster observation | Data pengguna terakhir dibaca |
| planning-only correction | Rencana koreksi belum dijalankan ke mesin |

## Data loading and state rules

### Device list

- one fleet-level device query/state owner;
- connectivity refresh may poll at a sensible interval;
- visible `last updated`/refresh feedback;
- no per-device users/commands/biometric payload queries until required by a detail route.

### Device detail

- `deviceId` comes from route state;
- shared persistent header reads the selected device once;
- each child route fetches only its own resource group;
- switching tabs must not silently switch device;
- no child route owns a second unrelated device selector.

### Polling

Polling should be scoped to information that benefits from it, such as connectivity or an actively observed command state.

Do not poll:

- biometric inventory;
- mapping candidate lists;
- historical raw events;
- hidden diagnostics panels;

merely because their components exist elsewhere in the feature.

### Refresh

Every refresh control must have:

- visible loading/busy state;
- a clearly scoped target, e.g. `Muat status terbaru`;
- success/error feedback when the action is not otherwise visually obvious.

## Loading, empty, error, and stale states

Every new route must explicitly cover:

- loading;
- empty;
- API error;
- forbidden/not found;
- offline device;
- stale last-seen information;
- command pending vs terminal state;
- unavailable capability.

A device being offline is not the same as an API error and not the same as lifecycle `disabled`.

## Safety and domain boundaries

This IA must preserve all existing invariants, including:

- `attendance_adms_events` remains raw device evidence;
- `attendance_daily_records` remains neutral factual punch/correction data;
- no lateness/absence/overtime/work-hour/payroll inference in device UI;
- manual attendance is not overwritten by fingerprint projection;
- explicit device PIN -> employee mapping only;
- leading-zero PIN preservation;
- name similarity is recommendation only;
- historical PIN mappings remain attributable according to effective mapping history;
- PIN correction is not a naive device-user rename;
- biometric collection remains OFF until separately approved;
- raw biometric/template material is never exposed in ordinary Admin UI;
- device-side deletion and HCIS-vault deletion remain separate operations.

## Permissions and audit

This specification does not change authorization.

All existing sensitive operations continue to require the current backend authorization and audit behavior.

Moving an action to a different route does not make client-side navigation an authorization boundary.

## API and migration impact

### Initial IA refactor

Preferred first implementation phase:

- no database migration;
- no ADMS wire-command change;
- reuse existing Admin APIs where practical;
- route/UI composition changes only;
- preserve old API contracts while new pages are introduced.

### Follow-up optimization

After the route model is stable, API responses may be consolidated or specialized to reduce duplicate queries, but any contract change must update OpenAPI and tests.

No API aggregation optimization may weaken authorization or expose raw sensitive payloads merely to simplify frontend code.

## Implementation sequence after acceptance

This specification should be implemented incrementally, but the target IA must remain coherent.

### Phase 1 — Admin navigation hierarchy

- grouped Admin navigation;
- correct active parent/child state;
- responsive grouped navigation.

### Phase 2 — Device collection

- new `/admin/attendance/devices` list-first landing page;
- fleet summary, search/filter, device status;
- remove ordinary operational panels from the landing page.

### Phase 3 — Device detail shell + Ringkasan

- route-param device context;
- persistent header;
- secondary device navigation;
- overview/health counters.

### Phase 4 — Pengguna

- users/roster table;
- mapping workflow in row/drawer context;
- name-sync action;
- read-user action;
- planning-only PIN correction;
- retire standalone Mapping Assistant/User Correction ordinary panels.

### Phase 5 — Transaksi + Perintah

- raw transaction table and bounded recovery flow;
- dedicated command history/status route;
- protocol evidence moves to command technical detail.

### Phase 6 — Pengaturan + Diagnostics extraction

- routine settings separated from technical tools;
- existing Wave/canary/control-plane UI moved to diagnostics or replaced by task-specific diagnostics;
- diagnostics lazy-mounted only when visited.

### Phase 7 — Remove monolithic route composition

- remove old long-page composition once feature-equivalent routes are verified;
- remove duplicate device selectors and redundant fetching/polling;
- browser regression for deep links and back/forward navigation.

## Non-goals

This specification does not approve:

- actual legacy-PIN -> intended-PIN mutation on a device;
- biometric template query/transfer pilot;
- enabling `BIOMETRIC_COLLECTION_ENABLED`;
- arbitrary ADMS command execution;
- destructive device maintenance;
- new attendance policy inference;
- payroll/late/overtime logic;
- copying WDMS visual design or recreating WDMS Personnel as a second employee master.

## Acceptance criteria

This historical IA no longer advances status. ATT-012 is the accepted successor and owns current ADMS operational IA.

Implementation is complete only when all of the following are true:

1. `/admin/attendance/devices` is a list-first fleet view rather than a stack of all device functions.
2. Opening one device establishes one persistent route-owned `deviceId` context.
3. Ordinary device-detail navigation provides Ringkasan, Pengguna, Transaksi, Perintah, and Pengaturan.
4. Diagnostics is separate from ordinary task navigation and not mounted/fetched until visited.
5. No ordinary page contains multiple independent selected-device controls for peer panels.
6. Mapping Assistant behavior is available through the Pengguna workflow without automatic mapping.
7. Name sync and read-user operations are available in user context using admin-facing vocabulary.
8. Planning-only PIN correction remains clearly non-executing.
9. Transaction recovery uses admin-facing language and the resulting command is observable under Perintah.
10. Command table provides human-readable action/status while technical protocol evidence remains available on demand.
11. Existing safety, authorization, audit, attendance, PIN, and biometric invariants remain unchanged.
12. Hidden/inactive routes do not continue route-specific background polling.
13. Loading, empty, error, offline, stale, unavailable-capability, and mobile states are implemented.
14. Keyboard navigation, visible focus, semantic labels, and WCAG 2.1 AA targets remain applicable.
15. Typecheck, lint, test, build, and browser smoke tests pass before merge of implementation code.

## Required browser regression scenarios

At minimum:

1. open device list, filter/search, open one device;
2. refresh and retain the same device route;
3. switch Ringkasan -> Pengguna -> Transaksi -> Perintah and verify device context never changes;
4. use browser back/forward without losing route correctness;
5. inspect an offline device without confusing offline with disabled/quarantined;
6. open an unmapped user and map explicitly;
7. inspect a mapped user and request safe read-user/name-sync actions;
8. inspect resulting command in Perintah;
9. enter and leave Diagnostics and verify diagnostics polling stops when route is left;
10. verify ordinary routes do not expose raw biometric material or engineering-only canary controls.

## Review note

Until this specification is accepted and implemented, physical device canaries do not need to be continued merely to compensate for the current confusing Admin information architecture. Hardware capability evidence already gathered remains valid; further physical testing should resume from the accepted, task-oriented UI unless a backend/protocol defect independently requires immediate verification.
