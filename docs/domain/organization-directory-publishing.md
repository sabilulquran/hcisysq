# Organization Directory Publishing Boundary

**Status:** DISCOVERY
**Specification:** ORG-006
**Owner/domain:** Human Capital / HCIS
**First planned consumer:** SQ Hub Organization Directory
**Related:** ORG-002, ORG-004, APR-001
**Cross-repository dependency:** SQ Hub ADR-0007 and HUB-IMPL-018
**Discovery date:** 2026-09-18

## Purpose

Define the discovery contract for publishing HCIS workforce-organization facts to SQ Hub as a read-only projection/distribution layer.

This document is intentionally **documentation-only**. It does not define or authorize a runtime endpoint, database migration, worker, scheduler, event bus, message broker, webhook, deployment, or production configuration. Any future implementation requires a separate accepted contract and implementation change after the readiness gates at the end of this document are complete.

## Accepted cross-system boundary

The following boundary is already decided for this discovery:

1. **HCIS remains the authoring system and system of authority for workforce organization.**
2. **SQ Hub stores only a read-only local projection** for search, navigation, integration, and cross-application distribution.
3. SQ Hub must not become a second editor or second master for HCIS organization structure.
4. Changes in SQ Hub must not write organization facts back to HCIS.
5. Consumers must not read the HCIS database directly.
6. Approval routing and business workflow ownership do not move automatically to SQ Hub.
7. Each domain application remains responsible for its own approval/workflow policy.
8. Organization Directory carries approved structural facts, not every application's workflow decision.
9. Keycloak/Akun SQ handles identity/authentication. It is not the master for full workforce organization structure.
10. No dual-write model is allowed.

Cross-repository dependency:

- SQ Hub ADR-0007 establishes HCIS as the organization authoring/system-of-authority side and SQ Hub as the read-only projection/distribution side.
- SQ Hub HUB-IMPL-018 is the planned consumer implementation dependency.
- ORG-006 must remain synchronized with those decisions before implementation begins.

## Current ORG-004 operational state

The current production boundary must be stated precisely:

- ORG-004 code and schema are deployed;
- the tables and implementation foundation exist;
- inspected production evidence reports no active row in `organization_rollout_settings`;
- absence of rollout configuration resolves to `LEGACY`;
- the real YSQ structure has not yet been fully configured and accepted;
- SHADOW has not been accepted;
- STRUCTURE has not been activated;
- the production pilot has not been accepted.

Use this claim boundary:

```text
code/schema deployed
!= real YSQ structure configured
!= SHADOW validated
!= STRUCTURE activated
!= production pilot validated
```

A published ORG-004 snapshot and an HCIS workflow rollout mode are different concerns. Publishing organization data for directory use must not be treated as proof that HCIS approval routing is running in `STRUCTURE`.

## Three organization states that must remain distinct

### 1. Legacy operational mapping

Current legacy workflow mapping includes:

- `employees.direct_manager_employee_id`;
- current Unit Approver mapping;
- ORG-002 resolution and APR-001 approval snapshots.

While workflow rollout resolves to `LEGACY`, this mapping remains authoritative for HCIS approval routing.

### 2. Published ORG-004 structural snapshot

ORG-004 stores complete, effective-dated organization snapshots with lifecycle:

```text
DRAFT -> VALIDATED -> PUBLISHED
```

A `PUBLISHED` snapshot can exist while approval workflow rollout remains `LEGACY`.

After the real YSQ structure is configured and accepted, a published ORG-004 snapshot is the intended candidate source for Organization Directory facts. That does **not** mean every field in the snapshot is safe or necessary to distribute.

### 3. Workflow rollout mode

ORG-004 rollout uses:

```text
LEGACY / SHADOW / STRUCTURE
```

This mode determines which resolver is authoritative for an HCIS workflow/scope. It is **not**:

- the version of an Organization Directory projection;
- a universal activation flag for directory consumers;
- evidence that a structural snapshot has been accepted for every purpose.

Therefore:

```text
snapshot PUBLISHED != approval rollout STRUCTURE
```

## Existing model inventory

The inventory below distinguishes physical row identifiers, candidate stable business identifiers, snapshot identity, and employee/person identity. A primary-row `id` must not be assumed to be a stable external identifier.

| Entity | Current HCIS source/table | Current identifier | Stability across change sets | Effective dating | Candidate for publication | Privacy classification | Notes/open risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Organization change set | `organization_change_sets` | row `id` / `change_set_id` reference | Identifies one snapshot only; UUID is not proven to be an ordered external version | `effective_on`; lifecycle timestamps include `published_at` | Yes, as publication metadata | Restricted organization metadata | External ordered version/cursor remains TBD |
| Organizational node | `organization_nodes` | row `id`; `stable_key` inside snapshot; optional `integration_code` | row `id` changes when a draft is cloned; `stable_key` is preserved by current clone behavior, but external-safety contract is TBD | `effective_from` / `effective_to` | Yes | Candidate directory data | Whether `stable_key` may be exposed and semantics of `integration_code` remain TBD |
| Job profile | `organization_job_profiles` | row `id`; `stable_key` | row `id` is snapshot-local; `stable_key` is preserved by current clone behavior | `effective_from` / `effective_to` | Yes, as reference | Candidate directory data | External stable identifier contract remains TBD |
| Position | `organization_positions` | row `id`; `stable_key` | row `id` is snapshot-local; `stable_key` is preserved by current clone behavior | `effective_from` / `effective_to` | Yes | Candidate directory data | `parent_position_key` references stable key within the snapshot; external-safety contract remains TBD |
| Membership | `organization_memberships` | row `id`; employee/node/job-profile references | No dedicated stable membership key exists in current schema | `effective_from` / `effective_to` | Yes, selected fields only | Restricted organization/person linkage | Consumer identity for the membership relation is TBD |
| Incumbency | `organization_incumbencies` | row `id`; position + employee + kind | No dedicated stable incumbency key exists in current schema | `effective_from` / `effective_to` | Yes, selected occupancy facts | Restricted organization/person linkage | `reason` for acting incumbency is not directory data by default |
| Acting incumbency | `organization_incumbencies` where `kind=ACTING` | row `id`; position + employee + effective period | No dedicated stable acting-assignment key exists | `effective_from` / `effective_to` | Indicator/reference may be candidate | Restricted | Acting `reason` remains internal/restricted unless explicitly approved |
| Authority binding | `organization_authority_bindings` | row `id`; semantic composite references | No dedicated stable binding key exists | `effective_from` / `effective_to` | TBD / normally restricted | Restricted organization/workflow metadata | HCIS workflow meaning must not be generalized into universal approval policy |
| Reporting override | `organization_reporting_overrides` | row `id`; employee + manager reference | No dedicated stable override key exists | `effective_from` / `effective_to` | Raw entity: no by default | Restricted/internal | Effective reporting fact may later be normalized for a directory; raw `reason` is restricted |
| Employee reference | `employee_id` foreign keys to `employees.id` | HCIS employee UUID | Stable enough for HCIS relational use is evidenced; cross-system identity contract is not | Employee lifecycle is separate; organization relations are effective-dated | Required conceptually, exact representation TBD | Restricted person reference | Global person/employee mapping with SQ Hub remains TBD |
| Rollout configuration | `organization_rollout_settings` | row `id`; workflow/node/effective window | Runtime configuration rows, not organization entity identity | `effective_from` / `effective_to` | No | HCIS internal/runtime-only | Directory export must not use rollout mode as its publication version |
| Audit event | `organization_audit_events` | event row `id` | Event identity only | `occurred_at` | Raw event: no | Explicitly excluded/internal | Raw `payload` must not be distributed as directory data |

### Identifier classes

#### Row identifier

Examples: primary `id` columns on nodes, positions, memberships, incumbencies, bindings, and overrides.

Current draft cloning creates new row IDs for copied structural rows. Therefore row IDs are physical persistence identifiers and are not a safe default for external identity.

#### Stable business identifier

ORG-004 exposes `stable_key` on nodes, job profiles, and positions. Current repository behavior preserves these keys when a new draft is cloned from a published snapshot.

That behavior makes `stable_key` a **candidate** business identifier, but the repository does not yet prove that it is approved for cross-system exposure, permanent global uniqueness semantics, or never-changing integration use. External use is therefore **TBD** pending an explicit decision.

#### Snapshot/version identifier

`organization_change_sets.id` identifies one change set/snapshot.

Current effective-snapshot loading orders published snapshots by `effective_on DESC, published_at DESC`. The UUID `change_set_id` is not used as an ordered cursor. Therefore:

- `change_set_id` may identify a snapshot;
- `change_set_id` must not be treated as the sole ordered external version without a new contract.

#### Cross-system employee/person identifier

Current organization rows use HCIS `employee_id` foreign keys.

The repository does not yet establish that this internal employee UUID is the canonical identifier that SQ Hub and every consumer should persist. The mapping between HCIS employee identity, SQ Hub person/account identity, and any external identifier is **TBD**.

### Audited identifier fields

| Field | Current meaning | Discovery conclusion |
| --- | --- | --- |
| `change_set_id` | Snapshot/change-set identity and foreign-key scope | Snapshot identity; not proven ordered cursor |
| `stable_key` | Stable structural key used within a change set and preserved by current draft cloning for nodes/job profiles/positions | Candidate stable business identifier; cross-system exposure TBD |
| `integration_code` | Optional node field, unique within a change set when non-null | Purpose and external semantics TBD |
| `employee_id` | HCIS employee foreign key | Internal employee reference; cross-system mapping TBD |
| `effective_on` | Date on which a published change set becomes eligible as effective snapshot | Accepted effective-snapshot input |
| `effective_from` / `effective_to` | Entity relationship/assignment effective period | Accepted source facts; consumer semantics still need contract |
| `published_at` | Timestamp when validated change set is published | Useful publication metadata; not by itself the effective date |
| `status` | `DRAFT`, `VALIDATED`, or `PUBLISHED` | Only `PUBLISHED` is eligible for effective snapshot use |
| parent node/position references | `parent_node_key`, `parent_position_key` | Structural references to stable keys within one snapshot; external key contract TBD |

## Data projection boundary

Fields are classified for discovery, not declared as a final API schema.

### 1. Candidate public directory field

Candidate means potentially suitable for a read-only organization directory after identifier/privacy decisions are accepted.

- stable node identifier — exact external form TBD;
- node name;
- node type/classification;
- parent node reference;
- node active state;
- node effective period;
- position stable identifier — exact external form TBD;
- position title;
- parent position reference;
- position active state;
- position effective period;
- vacancy state as a normalized directory fact, if semantics are defined;
- primary/acting occupancy indicator;
- primary membership indicator;
- job profile reference and, if approved, display name;
- publication/snapshot metadata required to establish source/effective state.

### 2. Restricted organization field

Potentially useful to a trusted consumer, but not public-by-default and subject to semantic/privacy review:

- employee reference;
- membership linkage;
- incumbency linkage;
- authority bindings;
- reporting relationship derived from an override;
- vacancy policy;
- selected governance facts;
- publication/operator metadata beyond the minimum safe version metadata.

### 3. HCIS internal/runtime-only field

Not part of Organization Directory by default:

- rollout configuration and rollout mode;
- resolver explanation paths;
- approval eligibility result;
- account active/suspended state used by workflow eligibility;
- capability/permission evaluation;
- validation implementation details;
- internal row IDs where a stable business identifier is available;
- draft editing/audit operator fields not required by consumer semantics.

### 4. Explicitly excluded

Organization Directory must not publish by default:

- passwords or credentials;
- Keycloak identifiers when not specifically required, and all tokens;
- account/session data;
- NIK or other national identity numbers;
- payroll data;
- employee documents;
- medical data;
- raw audit payload;
- private free-text reason fields;
- approval history;
- role/capability grants;
- raw personal data not required for the directory.

Specific safeguards:

- `organization_reporting_overrides.reason` is internal/restricted and excluded from the directory unless a later explicit decision says otherwise.
- `organization_incumbencies.reason` for acting assignments is internal/restricted and excluded from the directory unless a later explicit decision says otherwise.

### 5. TBD

These require an explicit decision before implementation:

- whether raw `stable_key` is the cross-system node/position/job-profile identifier;
- whether and how `integration_code` is used;
- exact employee/person reference exposed to SQ Hub;
- whether a normalized direct-reporting relationship is published;
- whether any authority binding represents a general governance fact versus HCIS workflow policy;
- directory history depth and retired-entity representation;
- exact publication/version envelope.

## Organization fact versus application policy

| Data/decision | Owner |
| --- | --- |
| Node/unit structure | HCIS |
| Position structure | HCIS |
| Employee membership | HCIS |
| Primary/acting incumbent | HCIS |
| Effective dates | HCIS |
| Structural reporting fact | HCIS |
| Application Access | SQ Hub |
| Keycloak authentication/session | Keycloak / Akun SQ |
| Finance approval policy | Finance |
| Leave approval policy | HCIS Leave |
| Workspace task policy | Workspace application |
| Consumer-specific authorization | Each application |

### Authority-binding boundary

ORG-004 authority bindings currently include workflow-relevant semantics such as `UNIT_APPROVER`, `GOVERNANCE_APPROVER`, and `OVERSIGHT_PARENT`.

Those bindings must **not** automatically become universal approval policy for other applications.

If a subset of bindings is later determined to represent a general governance fact rather than HCIS-specific workflow configuration, that subset needs:

- a defined cross-domain semantic;
- privacy review;
- a documented owner;
- explicit inclusion in the producer contract.

Until then, authority bindings remain restricted/TBD for directory publication.

## Candidate publication contract

This section records what the existing model already guarantees versus what remains proposed/TBD for cross-system publication.

| Candidate rule | Status in discovery | Evidence/boundary |
| --- | --- | --- |
| Only `PUBLISHED` snapshots may be candidates for publication | **Accepted by existing model** | Effective snapshot loader selects only `status='PUBLISHED'` |
| `DRAFT` and `VALIDATED` must not be visible to directory consumers | **Accepted direction / existing effective-loader behavior** | Existing resolver excludes them; external producer still not implemented |
| Future-effective snapshot must not become active early | **Accepted by existing model** | Effective loader requires `effective_on <= effective date`; OpenAPI publish description states future snapshot does not activate early |
| One consumer apply must represent one internally consistent snapshot/version | **Proposed requirement** | ORG-004 snapshot is change-set scoped, but no external publication transaction exists yet |
| Consumer must never observe a mixed set from two change sets | **Proposed requirement** | Required for projection correctness; transport/envelope TBD |
| Retired/deactivated entity semantics must be explicit | **TBD** | `active` and `effective_to` exist, but cross-system retirement semantics are not defined |
| Ordered version comparison must be documented | **TBD** | `change_set_id` is UUID identity, not proven ordered cursor |
| Replay/reconciliation must be possible | **Proposed requirement** | Mechanism not implemented |
| Applying the same publication must be idempotent | **Proposed requirement** | Consumer contract not implemented |
| Consumer must be able to detect a version gap | **Proposed requirement** | Requires ordered external version/cursor decision |
| Consumer must be able to detect stale data | **Proposed requirement** | Freshness/SLA and threshold are TBD |
| SQ Hub writeback is rejected | **Accepted architecture boundary** | SQ Hub is read-only projection/distribution layer |
| Export/publication must not activate `STRUCTURE` | **Accepted boundary** | Organization publication lifecycle and rollout settings are separate |
| Export/publication must not rewrite approval snapshots | **Accepted APR-001/ORG-004 boundary** | Existing submitted approval chains remain immutable |
| Export/publication grants no access, role, or capability | **Accepted boundary** | Structure and authorization remain separate |
| Export/publication must not create or activate an account | **Accepted boundary** | ORG-004 explicitly separates structural incumbency from account eligibility |

### Ordering warning

Do not define a consumer cursor as "larger `change_set_id` wins."

A UUID can safely identify a snapshot but, in the current repository, it does not define chronological or causal ordering. A future external contract may use a dedicated monotonic sequence, an explicit predecessor/reference, a producer version envelope, or another mechanism. The choice remains **TBD**.

### Atomicity warning

"Published" in HCIS means the change set lifecycle reached `PUBLISHED`; it does not currently mean a cross-system transfer completed.

A future producer/consumer contract must define how one full version is transferred and applied atomically so SQ Hub cannot expose half of one snapshot and half of another.

## Consumer behavior for SQ Hub Organization Directory

The planned SQ Hub behavior is conceptual until HUB-IMPL-018 and ORG-006 implementation contracts are accepted.

SQ Hub should maintain a local read-only projection with at least the conceptual state needed to record:

- last successfully applied source version;
- received timestamp;
- applied timestamp;
- source effective date;
- reconciliation status;
- stale/gap status.

Required behavior:

1. SQ Hub page requests must not require a live HCIS database or API call for every directory read.
2. SQ Hub reads from its last successfully applied local projection according to an accepted stale policy.
3. A structural change is applied atomically; partial application must not become visible.
4. SQ Hub must not infer authority from title text.
5. SQ Hub must not create a new hierarchy that contradicts the HCIS snapshot.
6. SQ Hub must not mutate or "correct" HCIS facts.
7. Consumer-specific access control remains the consumer application's responsibility.
8. Directory projection state must visibly distinguish healthy/current state from stale/gap/reconciliation problems after the terminology is accepted.

Candidate terminology only, **not final API enum values**:

- `CURRENT`;
- `STALE`;
- `GAP_DETECTED`;
- `RECONCILIATION_REQUIRED`.

The final names, threshold, and transitions remain TBD.

## Employee/person privacy boundary

Organization Directory needs a person reference to show occupancy, but it does not automatically need the employee master record.

The minimum cross-system person shape is not yet accepted. Discovery rules:

- publish only the minimum identifier/display data required for the directory use case;
- do not export national identifiers, payroll, documents, medical data, private notes, account/session details, or authorization grants;
- cross-system employee/person identity mapping must be explicit;
- do not assume `employees.id`, Keycloak subject, email address, or any other current identifier is the global person key until the decision is accepted;
- if SQ Hub already has a person/account reference, mapping ownership and failure behavior must be documented.

## Writeback and direct-database prohibitions

The future integration must reject these designs:

```text
SQ Hub -> UPDATE HCIS organization tables
consumer -> direct SELECT from HCIS production database
HCIS + SQ Hub dual-write the same organization fact
Keycloak organization/group structure becomes the HCIS master
```

A consumer may store its own read-only projection and consumer-specific metadata. It may not change HCIS organization truth through that projection.

## SQ Hub handoff

### HCIS responsibility

HCIS owns:

- organization authoring;
- organization validation;
- source publication decision;
- source identifiers;
- effective dating;
- producer schema;
- source version semantics;
- replay/reconciliation support.

### SQ Hub responsibility

SQ Hub owns:

- ingestion;
- local read-only projection;
- last-applied state;
- consumer API/UI;
- stale/gap visibility;
- distribution to other applications;
- rejection of organization writeback.

### Shared decisions

HCIS and SQ Hub must agree on:

- cross-system employee/person mapping;
- schema/version compatibility;
- privacy classification and minimum fields;
- service identity;
- freshness expectations;
- incident/recovery procedure.

## Open decisions

No item in this table is a hidden implementation decision. Items remain open until accepted in the appropriate domain/architecture/security source of truth.

| Decision | Status | Recommended owner | Dependency | Consequence if unresolved |
| --- | --- | --- | --- | --- |
| Global structural identifier contract | TBD | HCIS domain + SQ Hub architecture | ORG-004 identifiers | Consumer cannot safely persist long-lived node/position references |
| Cross-system employee/person mapping | TBD | Human Capital + SQ Hub identity | Employee identity model | Occupancy cannot be linked reliably across systems |
| Whether `stable_key` is safe to expose cross-system | TBD | HCIS domain + Security/Privacy | Identifier review | Producer schema cannot finalize node/position/job-profile IDs |
| Purpose and lifecycle of `integration_code` | TBD | HCIS domain/integration owner | Organization authoring semantics | Consumer may misuse a code whose stability is undefined |
| Full snapshot versus delta | TBD | HCIS + SQ Hub platform | Transport/version design | Payload, replay, atomicity, and gap handling remain undefined |
| Ordered external version/cursor | TBD | HCIS integration architecture | Snapshot identity | Gap detection and deterministic ordering cannot be implemented safely |
| Publication transport: pull API, notification+pull, or other | TBD | HCIS + SQ Hub architecture | Service identity, network boundary | No implementation mechanism can be selected |
| Freshness/SLA | TBD | Human Capital product + SQ Hub product/operations | Operational expectations | "Stale" has no measurable meaning |
| Retry semantics | TBD | Integration/platform engineering | Transport | Transient failures may duplicate or lose application attempts |
| Idempotency key/envelope | TBD | Integration/platform engineering | External version | Safe replay cannot be guaranteed |
| Gap detection | TBD | HCIS + SQ Hub platform | Ordered version/cursor | Consumer may silently skip a source version |
| History retention | TBD | Human Capital + Data governance | Consumer use cases/privacy | Historical browsing/storage cost and privacy cannot be bounded |
| Replay support | TBD | HCIS operations/platform | Retention + transport | Consumer recovery from corruption or missed versions is undefined |
| Deletion/retirement semantics | TBD | Human Capital domain + Data governance | Effective dating | Consumer may incorrectly delete, hide, or retain structural entities |
| Schema evolution/versioning | TBD | HCIS + SQ Hub architecture | Producer contract | Independent deploys may become incompatible |
| Service identity | TBD | Platform/Security | Identity provider/service auth | Producer cannot authenticate consumer securely |
| Token audience and scope | TBD | Platform/Security + Akun SQ/Keycloak owners | Service identity | Tokens may be over-broad or unusable |
| Endpoint authorization | TBD | Platform/Security + HCIS | Transport | Organization data may be exposed to an unintended caller |
| Field-level privacy | TBD | Human Capital + Security/Privacy | Final field set | Over-sharing or unusably narrow data contract risk |
| Consumer stale threshold | TBD | SQ Hub product/operations | Freshness/SLA | UI cannot decide when last-good data is still acceptable |
| Reconciliation cadence | TBD | HCIS + SQ Hub operations | Replay/gap detection | Divergence may persist unnoticed |
| Operational alerting | TBD | HCIS + SQ Hub operations | Reconciliation/stale semantics | Failures may remain silent |
| Initial bootstrap | TBD | HCIS + SQ Hub platform | Full/delta + versioning | First projection load is undefined |
| Behavior before real ORG-004 structure is accepted | TBD | Human Capital product + SQ Hub product | ORG-004 operational validation | Directory may expose an unaccepted or empty structural model |
| Temporary legacy projection versus wait for ORG-004 | TBD | Human Capital product + SQ Hub architecture | Previous item | Teams may accidentally create a second temporary source of truth |
| Ownership of operations and incident response | TBD | HCIS operations + SQ Hub operations | Transport/SLA/recovery | Failures may have no accountable responder |

## Behavior before real ORG-004 acceptance

The repository currently proves the ORG-004 software/schema foundation, not the accepted real YSQ organization.

Therefore ORG-006 does not decide whether the initial SQ Hub directory should:

1. wait until a real ORG-004 structure is configured, reviewed, and accepted; or
2. temporarily project a carefully defined subset of legacy ORG-002 organization data.

That is an explicit product/architecture decision. A temporary legacy projection must not be invented inside implementation, and it must not create a second master.

Until that decision is accepted, "code/schema deployed" is not permission to expose a purported real organization directory.

## Failure and recovery principles

A future contract must fail safely:

- source publication failure must not change HCIS organization authoring state;
- consumer ingestion failure must not change HCIS;
- last-good projection may remain readable only under the accepted stale policy;
- a gap must not be silently skipped;
- replay must not duplicate visible entities;
- reconciliation must be able to compare a consumer-applied version with the HCIS source version;
- recovery must not require direct mutation of HCIS production tables by SQ Hub.

Exact retry counts, timeouts, alert thresholds, and recovery cadence are TBD.

## Security principles

- Use a dedicated service identity if machine-to-machine transport is selected.
- Apply least privilege and explicit token audience/scope.
- Do not reuse user session cookies as an integration credential.
- Do not publish role/capability grants through the directory.
- Do not publish Keycloak tokens or session identifiers.
- Do not use organization title text as an authorization input.
- Consumer authorization is evaluated by the consumer application against its own accepted policy.
- HCIS organization structure alone does not grant application access.

## Implementation-readiness gate

ORG-006 remains **DISCOVERY** until all required gates below are complete.

- [ ] Real organization authoring/acceptance status is known for the intended first publication.
- [ ] Canonical external identifiers are decided.
- [ ] Cross-system employee/person mapping is decided.
- [ ] Producer/consumer data contract is accepted.
- [ ] Field-level privacy review is complete.
- [ ] Publication transport is selected.
- [ ] Authentication and authorization are agreed.
- [ ] Snapshot versus delta semantics are agreed.
- [ ] Ordered version/cursor and gap semantics are agreed.
- [ ] Bootstrap, replay, reconciliation, and gap recovery are agreed.
- [ ] Deletion/retirement semantics are agreed.
- [ ] Stale/freshness behavior is agreed.
- [ ] Producer tests are planned.
- [ ] Consumer tests are planned.
- [ ] Operational owner and incident owner are assigned.
- [ ] Operational alerting/reconciliation approach is agreed.
- [ ] Rollback/recovery plan is available.
- [ ] Behavior before real ORG-004 structure acceptance is explicitly decided.
- [ ] SQ Hub HUB-IMPL-018 is synchronized with the accepted ORG-006 contract.

Until these gates are complete, no ORG-006 runtime coding should be treated as implementation-ready.

## Non-goals

ORG-006 discovery does not:

- implement a new API endpoint;
- change `docs/api/openapi.yaml`;
- add or change database schema;
- add a queue, event bus, webhook, cron, worker, or scheduler;
- activate `SHADOW` or `STRUCTURE`;
- create real organization data;
- change HCIS approval routing;
- change submitted approval snapshots;
- create or activate user accounts;
- grant roles or capabilities;
- create a Keycloak organization model;
- redesign HCIS UI;
- access or copy production employee data;
- assert that SQ Hub is ready to ingest before the contract is accepted.
