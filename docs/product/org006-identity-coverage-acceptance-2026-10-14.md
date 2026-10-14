# ORG-006 — Initial production identity coverage acceptance (2026-10-14)

**Status:** ACCEPTED — `HCIS_DIRECTORY_INTEGRATION_PASS` (bounded initial production scope)  
**Decision authority:** Human Capital / Product Owner  
**Decision date:** 14 October 2026 (Asia/Jakarta)  
**Related contracts:** HCIS ORG-006, SQ Hub HUB-IMPL-018, Aset SQ ASQ-002  
**Scope:** Product/operations decision and evidence only. No code, database, deployment, authentication, or runtime configuration change is authorized by this record.

## Explicit Product Owner decision

The Product Owner **accepts 2 usable exact OIDC identity mappings among 97 active Directory people as the initial production operational coverage**. The remaining **95 active Directory people without OIDC identity refs** are an accepted scope limitation, **not a technical integration failure** and not a requirement to provision 95 accounts automatically.

This decision authorizes closure of the technical Directory integration as `HCIS_DIRECTORY_INTEGRATION_PASS` **for the accepted initial coverage**. It does **not** assert that every HCIS employee can access `Aset Saya` or other self-identity-dependent workflows.

Mandatory boundaries:

1. **No automatic account provisioning** or bulk identity linking solely to satisfy a coverage percentage. Any subsequent account onboarding requires its own accepted, authorized provisioning workflow and verification evidence.
2. **No guessed identity joins** by name, email, NIP/employee number, or similar mutable display attributes. Cross-system identity correspondence requires an explicitly stored **exact OIDC issuer + subject** mapping.
3. When a person lacks a valid identity mapping, self-identity-dependent actions (including `Aset Saya`) **fail closed**. Authorized administrative unit/person search may continue using the validated Directory projection; it must not fabricate an OIDC relation.
4. HCIS remains the sole authoring authority for employment and workforce organization; SQ Hub only distributes the read model; Aset SQ remains the asset-domain authorization authority. No direct HCIS database fallback, parallel employee/organization master, synthetic production mapping, or silent asset reassignment is permitted.
5. Identity coverage may expand **incrementally after explicit authorization**. A change in coverage does not by itself alter the Directory contract, approval routing, or organization snapshot governance.

## Accepted operational evidence

The following sanitized evidence was provided from the Codex controlled, read-only production acceptance performed **14 October 2026, 10:49–11:00 WIB**. This record transcribes that evidence; it does not claim a new independent test, deployment, or production modification.

| Acceptance area | Evidence and result |
| --- | --- |
| HCIS producer | Dedicated Hub client credentials; issuer/audience/client/scope verified; authenticated snapshot GET 200; valid published `hcis-organization-directory.v1` contract and privacy validation — PASS |
| SQ Hub reader | Dedicated `aset-sq-directory` identity; audience `sq-hub-organization-directory`; unit/person limit-1 GET 200; repeated reads/version consistent — PASS |
| Real Aset SQ adapter | Compiled production `SqHubDirectoryAdapter` with production configuration: owning-unit, custodian, ancestry, and exact issuer+subject lookup successful; non-exact identity fails — PASS |
| Sync and LKG | Five-minute scheduler cadence, idempotent `UNCHANGED`, last-known-good preservation, stale threshold 15 minutes and fail-closed consumer behavior — PASS by live history plus source/test evidence |
| Protected workloads | HCIS, Hub, Aset, Keycloak, PostgreSQL and neighboring services healthy; critical PIDs unchanged during acceptance — PASS |
| Identity coverage | 2 usable enabled/active exact OIDC mappings, 95 active people not mapped, zero ambiguous/duplicate identity pairs — TECHNICAL PASS; limited operational scope now accepted by Product Owner |

At the 11:00:19 WIB evidence checkpoint: source `hcis`; `asOf=2026-10-14`; effective published source snapshot `2026-08-27`; content version `sha256:904d409f9b46087ae7b2afe2c3e1baba82944c05ef918b60debf673ef8bdcdbc`; **51 units, 28 positions, 329 people, 97 active people**; `stale=false`. Last successful synchronization: **10:55:59 WIB**. Snapshot values are point-in-time evidence, **not permanent cardinality requirements**.

Test evidence reported by Codex: SQ Hub focused tests **42/42**, Aset focused tests **18/18**, and Aset exact-release API tests **272/272**. Authenticated Aset browser-session UAT was not repeated on 14 October; historical production user acceptance from 25 September remains a separate recorded checkpoint. Live consumer evidence on 14 October was obtained through the compiled production adapter.

## Operational scope and ongoing obligations

- Maintain Directory freshness monitoring (target sync every five minutes; stale at 15 minutes), machine authentication, LKG/recovery and fail-closed behavior. The historical `source_auth` failure on 9 October 2026 was followed by successful automatic sync; it is not an open incident at this decision checkpoint.
- Human Capital/product operations may enroll and link additional eligible staff accounts later under a separately approved workflow. Verify the exact issuer+subject mapping before enabling identity-dependent services for each person.
- Do not backfill or rewrite existing custody/asset ownership as a side effect of employee identity onboarding.
- When investigating a user's `Aset Saya` access, distinguish **Directory synchronization health** from **the user's missing identity mapping**, and communicate the limitation without exposing employee identifiers.
- Re-evaluate coverage and acceptance if the active population, account rollout policy, mapping semantics, or service requirements materially change. Do not invent a mandatory coverage target or deadline from this decision.
- Production remains unchanged by this documentation-only closure. No new staging deployment is authorized; see the permanent staging retirement runbook.

## Closure

**`HCIS_DIRECTORY_INTEGRATION_PASS` — technically complete and Product Owner accepted for limited initial identity coverage (2 of 97 active people as at 14 October 2026).**

Further identity coverage expansion is an independent operational workflow, **not a blocker for moving to HCIS ADMS Prompt 4**.

Cross-repository references: SQ Hub `docs/operations/HUB-IMPL-018-production-acceptance-2026-09-25.md` and Aset SQ `docs/operations/ASQ-002-directory-closure-2026-09-25.md`.
