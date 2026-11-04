# Super Admin Authentication Bootstrap

**Status:** ACTIVE IMPLEMENTATION BASELINE  
**Specifications:** AUTH-001, AUTH-010, SEC-001  
**Initial identifier:** `admin@hcis.sabilulquran.or.id`

> **Production note (2026-11-04).** Production runs with `AUTH_MODE=oidc`: every person, admins included, signs in through **Akun SQ** (OIDC), and `POST /auth/login` answers `404 LOCAL_AUTH_DISABLED`. The email + password + TOTP flow below applies only to `AUTH_MODE=local` (local development and tests). The docker-compose VPS procedure is historical: that VPS is terminated. On Mi8VPS the release flow is `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001); a bootstrap there, if ever needed, runs the same CLI from the current release directory with the Mi8 env file, following the Mi8VPS Platform Runbook.

This document defines the smallest real authentication boundary required before HCIS exposes employee import or other privileged administration surfaces.

## Scope

This phase creates one real `SUPER_ADMIN` account without implementing the full employee invitation, Google sign-in, role assignment, or permission-management UI.

The bootstrap account is an account principal, not an employee record. It must not be linked to a fake employee merely to obtain access.

## Invariants

- No public registration.
- No role selector on the login page.
- Passwords are hashed with scrypt and are never committed or logged.
- Super Admin MFA is mandatory from the first usable login.
- TOTP secrets are encrypted at rest with AES-256-GCM using `AUTH_ENCRYPTION_KEY` supplied by runtime configuration.
- Recovery codes are shown once and stored only as hashes.
- Browser sessions are opaque random tokens; only SHA-256 token hashes are stored in PostgreSQL.
- Production cookies use `HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/`.
- Account state must be `active` before a session can be created or reused.
- `/admin` is the Super Admin landing area. `/app` remains employee-only.
- Backend authorization remains authoritative; frontend route guards are usability boundaries, not the final authorization mechanism.
- Login success, login failure, MFA failure, recovery-code use, logout, and bootstrap are auditable events.

## Bootstrap safety

The bootstrap command:

1. requires `HCIS_ALLOW_SUPER_ADMIN_BOOTSTRAP=1` for that invocation;
2. receives the password through `HCIS_BOOTSTRAP_PASSWORD`, not a command-line argument;
3. takes the email from `--email`, defaulting to `admin@hcis.sabilulquran.or.id`;
4. acquires a PostgreSQL advisory transaction lock;
5. refuses to run when any `SUPER_ADMIN` already exists;
6. creates password + TOTP + recovery codes atomically;
7. never supports password rotation or a second privileged account through the bootstrap path.

Administrative account management after bootstrap must be implemented through the normal audited account-management domain, not by weakening this guard.

## Runtime secrets

Generate the MFA encryption key once per environment:

```bash
openssl rand -hex 32
```

Store the resulting 64 hexadecimal characters only in the runtime environment as:

```text
AUTH_ENCRYPTION_KEY=<64 hex characters>
AUTH_SESSION_TTL_HOURS=8
```

Do not rotate `AUTH_ENCRYPTION_KEY` casually. Rotation makes existing encrypted TOTP secrets unreadable unless a controlled re-encryption migration exists.

## Historical: old Docker VPS bootstrap procedure

**HISTORICAL.** Kept as a record of how the first Super Admin was created on the terminated Docker VPS. `infra/docker-compose.vps.yml` was removed from the repository on 2026-11-04; do not run this.

```bash
cd /var/www/hcis
COMPOSE="docker compose --env-file infra/.env.vps -f infra/docker-compose.vps.yml"

read -s -p "Super Admin password: " HCIS_BOOTSTRAP_PASSWORD
echo
export HCIS_BOOTSTRAP_PASSWORD

$COMPOSE run --rm \
  -e HCIS_ALLOW_SUPER_ADMIN_BOOTSTRAP=1 \
  -e HCIS_BOOTSTRAP_PASSWORD \
  api \
  node apps/api/dist/modules/auth/cli/bootstrap-super-admin.js \
  --email admin@hcis.sabilulquran.or.id

unset HCIS_BOOTSTRAP_PASSWORD
```

The command prints a TOTP secret, an `otpauth://` URI, and recovery codes once. These values are sensitive and must not be pasted into chat, screenshots, issue trackers, or repository files.

## Login behavior

```text
POST /api/auth/login
  -> validate email + password
  -> if Super Admin MFA is configured and code is absent: MFA_REQUIRED
  -> validate TOTP or one unused recovery code
  -> create opaque server-side session
  -> set secure HttpOnly cookie
  -> frontend lands SUPER_ADMIN on /admin
```

Session lookup:

```text
GET /api/auth/me
```

Logout:

```text
POST /api/auth/logout
```

## Rate limit baseline

The first implementation limits failed login attempts per API process using an in-memory key composed from client IP + normalized email:

- maximum 5 failed attempts;
- 15-minute window.

This is acceptable for the current single API instance. Before horizontal API scaling, move this limiter to a shared adapter/store so the security boundary does not weaken across replicas.

## Acceptance criteria

- AUTH-001-A: entering `/app` without an authenticated employee session does not expose the employee workspace.
- AUTH-001-B: a bootstrapped Super Admin lands at `/admin`, not `/app`.
- AUTH-001-C: an invalid password does not create a session and produces an audit event.
- AUTH-001-D: Super Admin cannot create a session without valid MFA.
- AUTH-001-E: recovery codes are single-use and stored only as hashes.
- AUTH-001-F: session cookies are HttpOnly and Secure in production.
- AUTH-001-G: suspended/inactive accounts cannot reuse an otherwise valid session.
- AUTH-001-H: bootstrap refuses to create another Super Admin once one exists.
