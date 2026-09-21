# NOTIF-004 — In-App Notification Center

**Status:** IMPLEMENTED — REPOSITORY VERIFIED; PRODUCTION DEPLOYMENT PENDING
**Decision date:** 2026-09-21
**Related:** NOTIF-001, NOTIF-003, ATT-007, ATT-008, PAY-002

## Goal

Provide a real recipient-owned in-app notification center for already implemented HCIS workflows. This package does not claim email, WhatsApp, browser push, or schedule-reminder delivery.

## V1 scope

Recipient-owned inbox with:
- unread/all views;
- unread counter in the employee header;
- mark one as read;
- mark all as read;
- authorized deep links;
- idempotent event/recipient keys so workflow retries cannot create duplicates.

Initial event families:
- shift exchange request/accept/reject/final HC decision/cancel;
- overtime final HC decision;
- payslip publication.

No sensitive payload is copied into previews. Notification text may contain ordinary employee-visible workflow context such as a period or request state, but not salary values, GPS coordinates, photos, medical evidence, credentials, or biometric material.

## Authorization

Every read/update endpoint resolves the authenticated account and filters by recipient_account_id server-side. A deep link re-checks the destination's normal authorization. There is no global inbox and no cross-employee unread count.

## Persistence

Table: in_app_notifications

Columns include recipient, stable event_key, category, title, body, href, created_at, read_at, optional actor and safe metadata.

Unique(recipient_account_id,event_key) provides idempotency.

No delete endpoint is exposed in v1. Retention remains a separate policy decision.

## Product status

NOTIF-001 remains partially implemented because external delivery adapters (email/WhatsApp) are not included. NOTIF-003 reminder scheduling remains discovery.

The employee service catalog splits:
- Notifikasi — available (NOTIF-004 / in-app part of NOTIF-001)
- Pengingat — discovery (NOTIF-003)

## Acceptance

- NOTIF-004-A: authenticated employee can list only their own notifications.
- NOTIF-004-B: unread count is scoped to the current account.
- NOTIF-004-C: mark-read cannot update another account's row.
- NOTIF-004-D: repeated workflow delivery with the same event key is idempotent.
- NOTIF-004-E: shift swap creates counterpart/requester lifecycle notifications.
- NOTIF-004-F: overtime final decision notifies the employee.
- NOTIF-004-G: payslip publish notifies each published employee without salary values.
- NOTIF-004-H: bell opens a real notification center and displays unread count.
- NOTIF-004-I: reminder generation, email, WhatsApp, push, and announcements are not falsely advertised as implemented.
