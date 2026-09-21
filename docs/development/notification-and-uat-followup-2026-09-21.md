# Notification and UAT follow-up — 2026-09-21

Status: NOTIFICATION V1 IMPLEMENTATION IN PROGRESS / UAT INVENTORY ONLY. No production cleanup is authorized by this document.

## Notification investigation

Source evidence:
- Before the employee UX redesign, AppShell at ca38db08e85f064ffe5513f32ae0b75c11a3cf56 rendered a notification button with no click handler or notification destination.
- Commit 27d96dfa00dfd7e0bf39aaf6ee0ce4fc8f683b89 changed the bell destination from the announcement roadmap to the notification roadmap.
- Current employeeServices still lists NOTIF-001 / NOTIF-003 as discovery. The registered API and frontend route inventory at b5751f16350aa6c00b0ed5a7a481a64c4000f448 does not contain a recipient inbox/read-unread notification module.
- Leave transaction/outbox infrastructure is not itself evidence of a usable employee notification center.

Conclusion: the inspected release history does not establish removal of a functioning notification center. Preserve that uncertainty about other historical systems. Do not simply mark notifications available or restore a mock unread count.

### In-app first release — implemented in repository scope

One in-app notification center is shared by the header bell and Semua Layanan. The initial repository implementation covers shift-exchange lifecycle notifications, overtime final decisions, and payslip publication. Leave/approval expansion can follow without changing the recipient-owned inbox model.

Each message has a concrete recipient/account snapshot, event key, created time, short text, authorized deep link, read time, and category. A unique event/recipient key prevents duplicate messages on retries. Reading a message must not approve a request. Re-check current authorization on every linked resource and every inbox/read endpoint; no cross-employee access and no global unread count leak.

Separate informational messages from the actionable approval/task queue. Reuse existing transaction/outbox boundaries where appropriate without pretending the leave outbox covers every domain today. Existing requests are not retroactively spammed as new events.

Schedule-aware reminders are a second step: respect published rosters, holidays, approved leave, overnight shifts, actual evidence, deduplication and quiet hours. Do not infer absence or payroll consequences from a reminder.

Email/WhatsApp/browser push delivery remain separate adapters and configuration decisions, not prerequisites for the in-app inbox. NOTIF-003 reminder scheduling also remains discovery. No GPS coordinates, photos, medical attachments, salary values or credentials in notification previews. No retention period, channel mandate or release date is invented here.

## UAT cleanup boundary

The operator reports UAT accounts/records still visible. No exact production target IDs have been supplied or directly inventoried in this task. A fixture's display name, role, or occurrence of the word UAT is not sufficient evidence for deletion. The real operator account and real employee records are not test fixtures merely because they were used during acceptance testing.

A safe sequence is:
1. Read-only private inventory. The companion SQL flags only known-style synthetic hints and reports IDs/status/dependency counts. It is a candidate list, not a deletion allowlist, and may miss fixtures with other naming conventions.
2. Owner reviews exact account IDs and employee IDs, identifies purpose and dependencies, and explicitly approves an allowlist. Keep the resulting personal-data inventory outside the public repository and Actions logs.
3. Prefer disabling approved test accounts, revoking their sessions and ending their access assignments through existing authorized domain operations. Mark genuine synthetic employee records inactive/removed only after dependency review. Verify real account access remains unaffected.
4. Preserve immutable audit, approval, attendance and raw-device history. Do not disable append-only triggers, reset production, delete by a broad name/email pattern, or run a cascade against real data. Any exceptional historical data-remediation requires a separate approved plan, backup and rollback path.
5. Use isolated synthetic environments for future mutation UAT. Retained test source code is not production test data and must not be deleted as 'cleanup'.

Nothing in the navigation/capture fix changes production accounts, permissions, sessions, device configuration, or stored attendance records.
