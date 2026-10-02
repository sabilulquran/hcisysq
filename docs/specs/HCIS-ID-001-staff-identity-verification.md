# HCIS-ID-001 — Staff identity verification for SQ Hub

**Status:** ACCEPTED for HUB-IMPL-013, 2026-10-02

HCIS remains the employee master. This read-only contract lets SQ Hub verify one exact employee number immediately before Akun SQ provisioning. It does not grant application access, change HCIS status, or imply global offboarding.

## Contract

`POST /internal/v1/staff-identity/verify-employee` with body `{"employeeNumber":"<exact NIP>"}`. The body avoids placing NIP in proxy URL logs. The response contains only `employeeId` in `hcis:employee:<uuid>` form, exact `employeeNumber`, `displayName`, current contact `email` or null, `status` (`active|inactive|resigned`), and `verifiedAt` timestamp. Removed employees return 404. Ambiguous matches return 409. Responses set `Cache-Control: no-store`. The endpoint is disabled by default.

Caller authentication uses a dedicated Keycloak client-credentials service identity. HCIS verifies signature, issuer, audience `hcis-staff-identity`, expiry, allowlisted `azp/client_id`, and scope `staff-identity.verify`. Browser cookies and human credentials are rejected. Configuration uses `STAFF_IDENTITY_VERIFY_ENABLED`, `STAFF_IDENTITY_TOKEN_ISSUER`, `STAFF_IDENTITY_TOKEN_AUDIENCE`, and `STAFF_IDENTITY_ALLOWED_CLIENTS`. The allowlist contains only the approved Hub lifecycle client in the target production environment under a reviewed change.

No NIK, payroll, credential, token, session, domain role, or bulk employee data is returned or logged. The result is a current HCIS fact for provisioning, not a durable employment snapshot. Hub must fail closed on 401/403/404/409/503 and cannot use Organization Directory as a substitute for this check.

## Verification and recovery

Synthetic contract tests cover exact match, removed/missing employee, invalid request, disabled gate, unauthorized client/scope and safe response fields. Enable staging only after the caller's least-privilege service identity and Hub consumer contract are verified. Disable the gate to roll back; no HCIS schema migration or employee write is involved.
