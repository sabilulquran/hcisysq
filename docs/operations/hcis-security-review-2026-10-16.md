# HCIS production security review — 2026-10-16 (public summary)

**Spec ID:** SEC-REV-2026-10-16 (security review gate of *Production ready*, `docs/product/scope.md`)
**Status:** REVIEW COMPLETE — FINDINGS OPEN. No production change was made.
**Scope:** production-facing surface of HCIS on Mi8VPS: auth/session, admin authorization (AUTH-011 manifest vs code), secrets handling on the device (names and modes only), public ingress (edge proxy, Cloudflare tunnels, ADMS host), personal data in logs, dependency vulnerabilities.
**Code baseline:** `origin/main` `c2746a3`; running release `hcis-3b670849-20261016`.
**Method:** static review of `apps/api` and `apps/web`; read-only device inspection via `ssh mi8vps-root` (process list, file modes, env **key names**, edge proxy source, tunnel ingress listing, sshd config, log pattern **counts**); unauthenticated HTTPS probes; `npm audit`. No secret, cookie or personal value was printed or stored.

> **Disclosure note.** `sabilulquran/hcisysq` is a **public** repository. This file is the redacted summary: it names each finding, its severity and the fix direction, but omits hostnames, ports, file locations and reproduction details for findings that are still exploitable. The full report (evidence with file:line, device paths and probes) is held by the owner outside Git. Move details into this file only after the finding is fixed.

## 1. Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 3 |
| Medium | 5 (1 mitigated after re-check: SEC-17) |
| Low | 10 |
| Info | 2 |

The authentication core is sound: OIDC with PKCE/state/nonce in production, opaque hashed server-side sessions in HttpOnly cookies, server-side permission checks on every admin route inspected, no IDOR found on employee-scoped reads, parameterized SQL throughout, all application ports bound to loopback, and the Keycloak admin console blocked at the edge (bypass variants tested). The main risks are the attendance device protocol, an out-of-date AUTH-011 route manifest whose test cannot notice new routes, and known advisories in the deployed web framework version.

## 2. Findings

| ID | Area | Severity | Finding (redacted) | Fix direction | Needs owner approval |
|---|---|---|---|---|---|
| SEC-01 | Attendance device ingress | High — **risk accepted by owner 2026-10-16** | Device push requests are accepted on protocol identifiers alone; the protocol has no device credential. Unregistered serials never create attendance events and can be blocked in the device admin (WDMS) screen; the residual risk is spoofing a **registered** serial. | Owner declined a network allowlist at the edge (2026-10-16), because every new site would need a rule change. Optional app-level controls that need no per-network maintenance: alert when a registered device appears from a new source IP, per-device rate limit, cap on auto-detected devices. | Accepted; app controls optional backlog |
| SEC-02 | AUTH-011 governance | **High** | `docs/domain/AUTH-011-admin-route-permissions.json` lists 135 routes; 51 admin/HC routes registered in code are missing. All 51 were hand-checked and enforce a permission today; the risk is an unguarded **future** route, because `apps/api/test/auth011-postgres.integration.test.ts` only iterates the manifest and asserts a fixed length. | Route-collection test (`onRoute`) that fails when a non-public route is missing from the manifest; regenerate the manifest; extend the 401/403 matrix. | No (code PR) |
| SEC-16 | Dependencies | ~~High~~ **Fixed in production 2026-10-16** | `npm audit --omit=dev`: `fastify <=5.12.4` (GHSA-p68q-wchp-6fh7, GHSA-667r-xxjv-c9mm, GHSA-hwr6-493r-vm6h, GHSA-9q9j-q6p8-xq58, GHSA-4mh8-r7rc-xpvc), plus `fast-uri`, `brace-expansion`, `js-yaml`, `seroval`, `source-map-js`; `uuid` via `exceljs` (not used in the affected way). Dev-only: `vitest`/`tinypool`/`@vitest/mocker` (never shipped; release bundle has production deps only). | `npm audit fix` (non-breaking) in a separate PR, then a normal OPS-MI8-REL-001 release. Vitest major upgrade separately. | Release only |
| SEC-03 | AUTH-011 CI | Medium | The AUTH-011 route-matrix test is skipped in CI because its database variable is not set in any workflow. | Wire it to the existing PostgreSQL service; do with SEC-02. | No |
| SEC-17 | Host access | ~~Medium~~ **Mitigated** (re-checked 2026-10-16) | Host administration access published through a tunnel hostname. Follow-up check: every such hostname redirects to an identity-aware access login before any connection, and sshd is key-only. | Keep the access policy; review authorized keys and access-policy membership periodically. | No further change |
| SEC-05 | OIDC login | Medium | Login state is not bound to the initiating browser (login CSRF class). | Short-lived HttpOnly state cookie checked at the callback. | No (auth change → extra review) |
| SEC-06 | CSRF | Medium | Mutations rely on SameSite=Lax only; same-site sibling apps share the registrable domain. | Origin / `Sec-Fetch-Site` check for unsafe methods. | No (auth change → extra review) |
| SEC-07 | Browser headers | Medium | Production responses carry no HSTS, CSP, frame-ancestors, nosniff or Referrer-Policy. | `@fastify/helmet` for the API plus headers at one edge layer; CSP report-only first. | Edge part yes |
| SEC-04 | Proxy trust | Low | API trusts any proxy hop for client IP. The production edge overwrites the forwarding header and production uses OIDC, so not exploitable through the public path today. | Trust only the loopback proxy; use `request.ip` everywhere. | No |
| SEC-08 | Cookie flag | Low | Secure cookie flag derives from `NODE_ENV` (production value verified correct). | Refuse to start with an https redirect URI unless production mode. | No |
| SEC-09 | Logging | Low | Logger has no redaction config. Production log scan (counts only): 0 auth headers, cookies, passwords, e-mail addresses, bearer tokens or bodies found; OIDC callback already silent. | pino `redact` (cookie, authorization, `err.detail`); drop query strings for non-device routes. | No |
| SEC-10 | Error handling | Low | Some 5xx responses echo internal error messages. | Generic 5xx body; details in logs only. | No |
| SEC-11 | Device ingress | Low | Raw body parser keeps reading past its buffer (edge limit mitigates in production). | Hard cap with 413. | No |
| SEC-12 | Session/MFA | Low | TOTP replay inside the window (local mode only), no idle timeout, no `id_token_hint` at logout. | Last-step tracking, idle timeout, hint on logout. | No |
| SEC-13 | Exports | Low | CSV exports do not neutralize formula prefixes. | Prefix `= + - @` cells. | No |
| SEC-14 | Import | Low | Spreadsheet import loads files fully into memory on a phone-class host (admin-only). | Lower limit / check uncompressed size. | No |
| SEC-18 | Device secrets hygiene | Low | Older copies of environment files remain beside the live one (correct owners/modes; values not inspected). | Confirm unused, then archive root-only or delete; keep a secret inventory. | Yes (device) |
| SEC-19 | Change control | Low | The edge proxy and SPA static server exist only on the device, outside version control. | Version them; record their hash in release notes. | No |
| SEC-15 | Config default | Info | Code default `AUTH_MODE` is `local` (production is `oidc`). | Require explicit value in production. | No |
| SEC-20 | Logs | Info | API log grows ≈ 150 MB between releases (device polling); one rotated file is world-readable. | Rotate API log in the existing logrotate script; `0640`; lower device-poll log level. | Yes (device) |

## 3. Verified OK

- Every application port binds to `127.0.0.1`; PostgreSQL is loopback-only.
- Keycloak admin console and master realm are not reachable publicly, including path-normalization variants.
- No public API documentation endpoints; the internal directory export requires a pinned machine token.
- Protected endpoints answer 401 to anonymous requests.
- Employee-scoped reads (payslips, leave evidence, mobile photos, notifications, shift swaps, approvals) are filtered by the caller server-side.
- No development/test bypass flag that a production environment could enable.
- Evidence uploads: size limit, type + magic-byte check, encryption at rest. Payslip import is CSV-only, in memory, permission-gated.
- Biometric collection is OFF in production.
- Tunnel tokens are read from root-only files, not passed on the command line; `/proc` is mounted with `hidepid=2`.

## 4. Not covered (DISCOVERY)

Cloudflare dashboard settings (WAF, TLS mode; the zone sits in a Cloudflare account the operator cannot access); Keycloak realm policy (password policy, brute-force detection, staff MFA, token lifetimes); SQ Hub and Aset SQ code; Android host patch level and ADB exposure.

## 5. Remediation order

1. ~~SEC-16 dependency update~~ — PR #106, live in `hcis-4a578253-20261016` (fastify 5.12.7 verified on the device).
2. SEC-01 — risk accepted by the owner on 2026-10-16 (no edge allowlist); optional app-level controls in the backlog. SEC-17 needed no change.
3. SEC-02 + SEC-03 — route-coverage test and CI wiring.
4. SEC-07 — headers (code + edge).
5. SEC-05, SEC-06 — auth hardening with extra review.
6. SEC-09, SEC-10, SEC-13 — code hardening.
7. SEC-18, SEC-19, SEC-20 — device hygiene (owner-approved).
8. Remaining Low/Info — backlog.

*Production ready* requires no open High, and every Medium fixed or explicitly accepted by the owner in the go-live decision record (`go-live-decision-record-template.md`).
