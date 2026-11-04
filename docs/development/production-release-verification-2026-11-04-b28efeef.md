# Production release 2026-11-04: hcis-b28efeef (AUTH-002-INVITE) + SQ Hub hub-8e6ec046 (HUB-IMPL-024)

**Spec:** `docs/domain/account-activation.md` §AUTH-002-INVITE; SQ Hub `docs/specs/HUB-IMPL-024-hcis-staff-activation-invite.md`.
**Code:** HCIS PR #307 (merge `d151c24d`), released at `main` `b28efeef`. SQ Hub PR #177 (merge `8e6ec046`).
**Approval basis:** owner standing rule (2026-10-27) for production releases; owner request 2026-11-04.

## Order and results (UTC)

| Time | Step | Result |
| --- | --- | --- |
| 03:05 | SQ Hub `hub-8e6ec046-20261104` with `sq-core-ops/scripts/mi8/hub-release.sh`, under the device release lock | DB dump `pre-hub-8e6ec046-20261104.dump`, no new migration, healthy after 16 s. The launcher had drifted back to `hub-0a6f87ea` while `hub-6f97628e` was running (a later release restored an older launcher copy); this release replaced both paths, so launcher, worker and running process now agree. |
| 03:07 | Hub `final.env` (backup `final.env.pre-staff-activation-20261104`): `STAFF_ACTIVATION_ALLOWED_CLIENTS=hcis-api`; `HCIS_STAFF_VERIFY_BASE_URL` changed to `http://127.0.0.1:3301/` | Validated with the release's `loadConfig()` before restart. The previous value (`https://hcis.sabilulquran.or.id`, no `/api/`) answered 501 from the static server, so HUB-IMPL-013 HCIS verification could not have succeeded. Hub API restarted alone; new pid, `/health` 200. Invite route: 401 without token on loopback, 404 at the edge. |
| 03:08 | Machine probe with the `hcis-api` token (claims `azp=client_id=hcis-api`, `aud=sq-hub-api`) | Bad body → 400 `INVALID_REQUEST`; owner's NIP → 409 `EMPLOYEE_IDENTITY_CONFLICT`. HCIS verification over loopback works. Nothing was created or sent: the owner's Akun SQ predates the `hcisEmployeeId` link. |
| 03:09 | `release-mi8.sh all` dry run, then `--apply --confirm RELEASE_b28efeef` | Pre-release dump, migration `0138_account_activation_invitations.sql`, candidate gate PASS, cutover, verify OK. |
| 03:12 | HCIS → SQ Hub client probe from the release (`SqHubStaffActivationClient`, derived URL `http://127.0.0.1:3302/internal/v1/staff-activation/invite`) | 409 `EMPLOYEE_IDENTITY_CONFLICT` for the owner, as above. Public `POST /api/admin/access/accounts/:id/activation-invitation` without a session → 401. |

## Not tested in production

- A real send (Keycloak e-mail + WhatsApp). HCIS is not live; the only `active` account is the owner's, and the button only exists for `invited` accounts. The two other allowlisted NIPs are real staff, so no activation was sent to them.
- Keycloak SMTP delivery of `execute-actions-email` is untested since HUB-IMPL-013 (one `password_initialization` failure on 2026-10-17 has no recorded cause).

## Rollback

- HCIS: `release-mi8.sh rollback` to `hcis-27bc9aec-20261104`; migration 0138 is additive and can stay.
- SQ Hub: restore `final.env.pre-staff-activation-20261104` and restart the Hub API (route disappears); release rollback with `sq-core-launch.sh.pre-hub-8e6ec046-20261104` / `sq-core-worker.sh.pre-hub-8e6ec046-20261104`.
