# Attendance discovery and clock feedback — 2026-09-21

Status: IMPLEMENTATION; production verification pending.
Related: UX-001, ATT-005, ATT-006, ATT-008, ATT-009, NOTIF-001, NOTIF-003.
Baseline: b5751f16350aa6c00b0ed5a7a481a64c4000f448.

## Report and confirmed source findings

The operator can open employee and HC shift-exchange routes directly, but cannot discover them from normal navigation. The employee sidebar still exposes only the older primary sections; the HC shift-swap link is near the end of a horizontally scrolling workspace tab bar.

ADMS is already registered in the API and has fleet, registry, global transactions, mapping, recovery, command, and device-detail GUI. Its organization permission boundary is attendance.devices.read with additional permissions for sensitive operations. Do not duplicate the device plane or grant those permissions to every HC account to make the menu visible. RuangHadir tenant.mesin groups device workspace, operations, and recovery; reuse this discoverable grouping, not its vendor/tenant provisioning or transport implementation.

The notification bell was explicitly routed to a roadmap surface by commit 27d96dfa00dfd7e0bf39aaf6ee0ce4fc8f683b89. This is not proof that a working notification center was removed. Transactional outboxes are not the same as a recipient-owned read/unread inbox. New notification implementation remains subject to a separate product discussion.

The operator also reports a failed mobile clock-in after creating a schedule, assignment, and location. The exact browser/API error is not supplied. Repository nginx allows a 16 MB body and the checked nginx/Caddy files do not disable camera/geolocation through Permissions-Policy. Do not attribute the incident to geofence radius, browser permission, or headers without evidence.

## Correction scope

1. Discoverable employee attendance actions in the sidebar and a wrapping, keyboard-accessible attendance navigation region on attendance pages. Preserve the five-item mobile bottom bar.
2. Direct HC shift-swap entry; a separate, explicit ADMS device section. Preserve backend-derived permissions and make missing device access distinguishable from an unimplemented module.
3. All workforce tabs wrap on smaller screens instead of hiding later tabs beyond horizontal overflow. Show no protected tabs while authorization is unresolved.
4. Reconcile already implemented employee service links (schedule and overtime) without advertising face recognition as available.
5. Mobile capture: explicit loading/error states, permission explanations, photo preview, readiness checklist, and a stable request key across retry of an unchanged action/GPS/photo attempt. Never silently generate a second key after an ambiguous network/server failure. Preserve the existing geofence policy: outside/uncertain evidence remains reviewable, not silently rejected.
6. Add a rollback-only PostgreSQL regression exercising actual mobile write/evaluation with synthetic fixture rows. Run it only in the explicitly named loopback CI test database. No production account impersonation or real attendance mutation.

## Acceptance

- A user can discover Clock In/Out and Tukar Shift without typing a URL; mobile navigation remains usable without compressed touch targets.
- Authorized HC can discover shift approvals and ADMS; other principals do not gain backend capabilities.
- Failed initial mobile loading stops the spinner and offers reload. GPS/camera failures explain the next user action; API errors retain their code for diagnosis.
- Retrying an unchanged clock action reuses its idempotency key and payload. A new photo/action is an explicit new attempt.
- No notification inbox is fabricated or activated by this fix.
- UAT cleanup is NOT performed by this change. An exact, reviewed account manifest and dependency inventory must precede any production mutation; real employee/account records and immutable audit/attendance evidence remain protected.

## Verification boundary

CI is repository evidence, not proof of the operator's specific production clock-in failure. Report that distinction until the actual error and post-deploy outcome are available. No new GPS/photo retention policy, active device command, organization-rollout activation, or production data cleanup is included.
