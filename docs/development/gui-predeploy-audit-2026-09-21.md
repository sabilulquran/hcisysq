# GUI Pre-deployment Audit — 2026-09-21

**Status:** REPOSITORY VERIFIED — PRODUCTION DEPLOYMENT PENDING  
**Baseline:** `36196e3bedd85563669ee97d442ddf43cc36388d`  
**Scope:** employee workspace, Human Capital workspace, Admin navigation, Attendance, ADMS, notification entry points, service catalogs, responsive discoverability.

## Audit rule

A feature is not considered GUI-complete merely because its route can be typed manually.

For an implemented capability, the audit checks:

1. a normal desktop entry point exists;
2. a normal mobile entry point exists where that persona uses mobile;
3. service/catalog status does not claim an implemented feature is Coming Soon;
4. old service URLs do not regress to Coming Soon after the feature becomes available;
5. navigation respects the same permission model as the route;
6. later tabs do not disappear behind horizontal overflow where wrapping is viable;
7. deliberately unavailable capability is not advertised as implemented.

## Confirmed gaps

### Employee / Human Capital workspace

- Clock In/Out and Tukar Shift are now discoverable through employee attendance navigation and desktop sidebar.
- Notifikasi is reachable from the header bell and employee service catalog.
- Human Capital task links are inconsistent because `AppShell` receives HC capability from selected pages. On other employee pages the same authorized user can lose the HC section.
- On mobile, the desktop HC sidebar is hidden and there is no equivalent HC quick-navigation surface.

Decision:
- derive HC GUI capability from the authenticated session permission set;
- show leave validation/planned-leave links when `leave.validate` exists;
- show attendance-resolution link when `attendance.resolution.manage` exists;
- keep backend/API authorization authoritative;
- preserve the existing five-item employee bottom navigation and add a compact mobile-only HC task panel instead of adding a sixth bottom tab.

### Admin module catalog

Confirmed stale catalog state:
- ATT-008 Tukar Shift is implemented but still marked `planned`;
- Mobile Attendance still lists Face recognition even though ATT-006 explicitly excludes it;
- Back Office ADMS is implemented and directly navigable but absent from the admin module catalog;
- Admin Coming Soon page does not redirect an already-available service to its real route;
- copy still describes the page as only future modules while it contains available modules.

Decision:
- mark Shift Exchange available and link directly to HC approval workspace;
- add Back Office ADMS as available;
- remove Face recognition from implemented Mobile Attendance details;
- use direct routes for implemented attendance tiles;
- make available service bookmarks redirect to their real page;
- rename roadmap-only wording to module-catalog wording.

### ADMS device detail

- Device detail has seven primary tabs plus diagnostics in a horizontal scroll strip.
- Biometric and settings tabs are rendered even when the current account cannot open those routes.

Decision:
- filter device-detail links with the same `canAccessAdminPath` contract used by the router;
- wrap tabs on small widths instead of hiding later tabs behind horizontal scrolling;
- keep diagnostics as a secondary action;
- no permission is broadened by this GUI change.

## Non-gaps confirmed

- Employee special leave and planned leave are reachable from Cuti & Izin.
- Employee attendance resolution is intentionally surfaced when action is required from the dashboard.
- Notification inbox has a normal header-bell entry and service-catalog entry.
- Admin attendance workforce tabs already wrap and are permission-filtered.
- Back Office ADMS, device list, and global transactions have first-level Admin navigation.
- Device detail dynamic routes are reachable from fleet/device rows.
- Foundation Board route is a separate principal workspace and not part of employee/admin navigation.

## Acceptance

- No implemented ATT-008 tile says Coming Soon.
- No implemented mobile attendance UI claims Face recognition.
- An authorized HC employee retains HC task navigation across employee pages and on mobile.
- Unauthorized employee sessions do not gain HC routes from GUI changes.
- Device detail hides biometrics/settings links when route permission is absent.
- Device-detail navigation wraps instead of requiring horizontal scrolling.
- Old admin service URLs for an available service forward to its real route.
- Tests cover the above navigation/status contracts before merge.


## Repository verification

The functional head before this status-only source-of-truth update passed Pull Request Validation run #456:

- clean migration and migration source-of-truth checks;
- recovered-production migration rehearsal;
- pre-ORG-004 -> ORG-004 rehearsal;
- Wave 1 -> Wave 2 rehearsal;
- USERINFO and user-correction rehearsals;
- TypeScript typecheck;
- lint;
- API/web tests including GUI discoverability and permission regressions;
- web/API build;
- staging Compose validation.

The final PR head must pass the same workflow again before merge. Production browser/device UAT is still a separate post-deployment gate and is not claimed by repository CI.
