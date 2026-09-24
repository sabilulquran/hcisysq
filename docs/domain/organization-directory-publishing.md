# ORG-006 — Organization Directory publishing to SQ Hub

**Status:** ACCEPTED  
**Owner/domain:** Human Capital / HCIS  
**Decision date:** 2026-09-24  
**First consumer:** SQ Hub Organization Directory  
**Cross-repository contract:** SQ Hub ADR-0007 and HUB-IMPL-018  
**Runtime deployment:** Not implied by specification acceptance

## Purpose

Authorize the HCIS producer contract for publishing the minimum workforce-organization facts required by SQ Hub as a read-only projection/distribution layer.

HCIS remains the single authoring system and system of authority. This specification does not authorize SQ Hub writeback, direct database access, dual-write, a parallel employee/organization master, Keycloak as organization master, a new event bus, or a new microservice.

## Audited HCIS source model

The current repository provides these authoritative source facts.

### Organization snapshot

`organization_change_sets` stores effective-dated snapshots with lifecycle:

`DRAFT -> VALIDATED -> PUBLISHED`

Only `PUBLISHED` snapshots are eligible for export. Effective selection is:

`effective_on <= asOf`

ordered by:

`effective_on DESC, published_at DESC, created_at DESC, id DESC`

A published snapshot does not activate HCIS workflow rollout. `LEGACY / SHADOW / STRUCTURE` remains a separate HCIS approval-routing concern.

### Stable structural identifiers

- `organization_nodes.stable_key` is preserved when snapshots are cloned and is the accepted v1 unit business identifier.
- `organization_positions.stable_key` is preserved when snapshots are cloned and is the accepted v1 position business identifier.
- snapshot-local row `id` values are persistence identifiers and are not external unit/position identities.
- `organization_change_sets.id` identifies one snapshot but is not an ordered cursor.

External forms:

- unit: `hcis:org-node:<uuid>`
- position: `hcis:org-position:<uuid>`

`integration_code`, name, and title are not identity keys.

### Employee/person identifier and lifecycle

`employees.id` is the accepted v1 person identifier:

`hcis:employee:<uuid>`

Evidence:
- employee import matches existing records by `employee_number` and updates the same row;
- a new employee creates a new UUID;
- normal employee update therefore preserves `employees.id`.

`employee_number`, email, and name must not be used as cross-system identity joins.

Lifecycle facts:
- `status = active|inactive|resigned`;
- `removed_at` is a separate population-removal fact;
- directory `active=true` only when `status='active'` and `removed_at IS NULL`;
- inactive, resigned, or removed people remain identifiable and are exported as inactive rather than hard-deleted.

### Placement and position

ORG-004 supplies:
- unit hierarchy through `organization_nodes.parent_node_key`;
- positions through `organization_positions`;
- employee membership through `organization_memberships`;
- position occupancy through `organization_incumbencies`;
- explicit `is_primary_structural` for the reporting anchor when an employee holds multiple structural positions;
- inclusive `effective_from/effective_to` date ranges.

Raw authority bindings, approval policy, rollout configuration, reporting-override reasons, and acting reasons are not general-purpose directory facts and are excluded from v1.

### Source/update metadata

Source metadata available for the producer:
- snapshot `id`;
- `effective_on`;
- `published_at`;
- `created_at`;
- employee `updated_at`;
- source import references internally.

Raw import source snapshots are never exported.

## Producer contract

### Transport

v1 is **pull + full snapshot** over authenticated HTTP.

Endpoint:

`GET /internal/v1/organization-directory/snapshot?asOf=YYYY-MM-DD`

The date is an Asia/Jakarta business date. Full snapshot was chosen because it gives bootstrap, replay, retry, reconciliation, and atomic consumer apply without an event bus or ordered delta cursor.

Delta/event feed is outside v1 and requires a superseding contract if later needed.

### Export gate

Production export is default OFF:

`ORG_DIRECTORY_EXPORT_ENABLED=0`

It may be enabled only after Human Capital/operator acceptance that the real ORG-004 structure is suitable for directory publication.

When disabled, or when no valid effective `PUBLISHED` snapshot exists, the endpoint fails closed. There is:
- no ORG-002/legacy fallback;
- no synthetic production fallback;
- no automatic structure generation from employee text fields.

### Authentication and least privilege

Dedicated Keycloak client-credentials identity is required.

v1 contract:
- recommended caller client id: `sq-hub-organization-directory`;
- expected audience: `hcis-organization-directory`;
- required scope: `organization-directory.read`;
- issuer is environment-specific Akun SQ/Keycloak issuer;
- allowed client IDs are explicit configuration.

HCIS verifies JWT signature via issuer JWKS and checks issuer, audience, expiry/not-before, allowlisted `azp/client_id`, and required scope.

Human credentials, HCIS browser sessions, Hub browser cookies, and Aset user tokens are not accepted.

### Envelope and version

Response envelope:

```json
{
  "schemaVersion": "hcis-organization-directory.v1",
  "source": {
    "system": "hcis",
    "snapshotId": "00000000-0000-4000-8000-000000000101",
    "effectiveOn": "2026-09-01",
    "publishedAt": "2026-09-01T01:00:00.000Z",
    "createdAt": "2026-08-25T01:00:00.000Z"
  },
  "asOf": "2026-09-24",
  "version": "sha256:<hex>",
  "generatedAt": "2026-09-24T01:30:00.000Z",
  "counts": { "units": 2, "positions": 2, "people": 3 },
  "units": [],
  "positions": [],
  "people": []
}
```

`version` is a SHA-256 digest of canonical validated content including source metadata, `asOf`, units, positions, and people. `generatedAt` is excluded from the digest.

Consequences:
- the same source content produces the same version;
- retry is idempotent;
- employee-master changes change the version even if the ORG-004 snapshot ID did not change;
- version is content identity, not an ordered integer;
- consumers must not compare versions using greater-than/less-than.

### Unit projection

Each unit contains only:
- `id`;
- `name`;
- `nodeType`;
- `parentUnitId`;
- `active`;
- `effectiveFrom`;
- `effectiveTo`.

Future-effective unit rows with `effectiveFrom > asOf` are not exposed early.

### Position projection

Each position contains only:
- `id`;
- `unitId`;
- `title`;
- `parentPositionId`;
- `active`;
- `effectiveFrom`;
- `effectiveTo`.

Future-effective position rows with `effectiveFrom > asOf` are not exposed early.

### Person projection

Each person contains:
- `id`;
- `employeeNumber` for authorized internal lookup/display;
- `displayName`;
- `active`;
- `employmentStatus`;
- `startedOn`;
- `endedOn`;
- `currentPrimaryUnitId`;
- `structuralPositionIds`;
- `primaryStructuralPositionId`;
- zero or more opaque `identityRefs` with `issuer + subject`.

Current primary membership and structural position fields are resolved only for relationships whose inclusive effective interval contains `asOf`.

An OIDC identity reference is projected only from an existing HCIS employee-account identity mapping. Missing mapping remains missing; email/NIP must never be used to guess `sub`.

### Privacy exclusions

Never export:
- NIK/national identity;
- password/hash;
- access/refresh tokens;
- session/cookie data;
- client secrets;
- address/phone;
- payroll/payslip/bank data;
- health/medical/biometric data;
- employee documents;
- raw import source snapshots;
- free-text removal, acting, or reporting reasons;
- raw approval history;
- roles/capability grants;
- raw audit payload.

## Effective-date semantics

All date-only values use `YYYY-MM-DD`.

Intervals are inclusive:

`effectiveFrom <= asOf && (effectiveTo == null || effectiveTo >= asOf)`

The producer does not convert these dates through UTC. Future-effective published change sets are not selected early.

## Idempotency and failure behavior

Producer behavior is read-only.

- repeated identical requests over unchanged source data return the same content version;
- producer failure does not mutate HCIS organization/employee state;
- authentication failure returns 401/403;
- invalid `asOf` returns 400;
- export disabled or no effective valid snapshot returns 503;
- unexpected generation/validation failure returns 500 without a partial payload;
- there is no write retry that can duplicate source state.

Consumer retry/reconciliation is defined by HUB-IMPL-018. HCIS supports it by making a complete validated snapshot safely repeatable.

## Reconciliation and last-known-good boundary

HCIS does not own the Hub last-known-good store.

HCIS guarantees that a consumer can:
1. re-pull a complete snapshot for the target business date;
2. validate schema and references;
3. compare content version/counts;
4. repeat the operation safely.

SQ Hub owns atomic apply, last-known-good, `synchronizedAt`, staleness, reconciliation status, and consumer read availability.

HUB-IMPL-018 defines a target pull cadence of 5 minutes and stale threshold of 15 minutes.

## Observability

Producer logs may include:
- request/correlation ID;
- client ID;
- `asOf`;
- source snapshot ID;
- version;
- counts;
- outcome/error category.

Logs must not contain bearer tokens, secrets, full directory payload, bulk names/NIP values, or identity subjects.

## Configuration

Required when export is enabled:
- `ORG_DIRECTORY_EXPORT_ENABLED=1`;
- `ORG_DIRECTORY_TOKEN_ISSUER`;
- `ORG_DIRECTORY_TOKEN_AUDIENCE=hcis-organization-directory`;
- `ORG_DIRECTORY_ALLOWED_CLIENTS=sq-hub-organization-directory`;
- `ORG_DIRECTORY_REQUIRED_SCOPE=organization-directory.read` (default).

Secrets remain in environment/secret management. The producer itself has no client secret because it verifies bearer JWTs using public JWKS.

## Tests required

Implementation must cover:
- disabled export;
- missing/invalid bearer token;
- wrong audience/issuer;
- non-allowlisted client;
- missing scope;
- only effective PUBLISHED snapshot selection;
- same-effective-date deterministic revision selection inherited from ORG-004;
- future-effective entity exclusion;
- stable identifier mapping;
- inclusive effective relationships;
- inactive/resigned/removed person behavior;
- missing OIDC mapping without guessing;
- privacy field exclusion;
- deterministic version/idempotent repeat;
- version change when person/source content changes;
- no-source snapshot failure.

Use synthetic data only.

## Rollout

1. Merge/review ORG-006 producer and synchronized HUB-IMPL-018 contract.
2. Deploy code with export gate OFF.
3. Provision dedicated Keycloak machine client and audience/scope per environment.
4. Validate staging with synthetic/staging-approved data.
5. Human Capital accepts the real ORG-004 structure for directory use.
6. Enable export.
7. SQ Hub performs initial full snapshot bootstrap and validates version/counts without logging person payload.
8. Verify repeated pull/idempotency, stale/LKG behavior on Hub, deactivation, identity lookup, and ancestry.
9. Onboard Aset SQ through the Hub read API. No direct-HCIS fallback.

## Rollback and recovery

Producer rollback:
- set export gate OFF;
- revert application release if needed;
- no HCIS data rollback/migration is required for the read endpoint.

Recovery:
- correct authoritative data in HCIS using normal HCIS authoring/lifecycle;
- publish a valid source snapshot where structure changes are required;
- Hub re-pulls and atomically replaces its projection;
- never mutate HCIS production tables from SQ Hub to repair projection state.

## Acceptance

ORG-006 implementation is acceptable when:
- HCIS ownership remains explicit;
- identifiers/lifecycle are unambiguous;
- authenticated least-privilege producer exists;
- schema/validation/privacy contract is enforced;
- repeat pulls are idempotent;
- effective dates and deactivation are correct;
- no legacy/synthetic production fallback exists;
- tests/typecheck/lint/build pass;
- configuration, observability, rollout/rollback/recovery are documented;
- no secret/production personal data is in diff/log fixtures;
- no deployment or merge is claimed without separate review/evidence.

## Runtime status

Specification v1 is **ACCEPTED**. Repository implementation evidence and deployment evidence are separate. A merged producer still remains disabled until the explicit runtime export gate is enabled after the required organization acceptance.
