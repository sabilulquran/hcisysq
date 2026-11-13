# ATT-005 Full WDMS Physical Parity Ledger

Status ATT-005: **IMPLEMENTED** (software complete and deployed; parity status since 2026-11-13) — 7 physical rows verified; the rest wait for an owner-approved site session or owner decision (`docs/operations/adms-physical-verification-checklist.md`). **DRAFT:** "closed" in the closure rule below means parity status `verified`; `implemented` records software completion only.

Evidence review 2026-11-11: read-only aggregate queries on production (`attendance_adms_physical_capabilities`, `attendance_adms_physical_operations`, `attendance_adms_commands`, `attendance_adms_request_journal`, `attendance_adms_events`, `attendance_adms_devices`) and the API logs. No personal data, PIN or biometric material was read out. Production holds exactly three per-device capability rows, all `verified` on `SPK7245000707` (`time_sync`, `duplicate_punch_period`, `work_code_delivery`), backed by 5 physical operations and 7 device commands, all `succeeded` with return code 0. No other physical operation was ever run.

Everything still open is listed, with who does what, in `docs/operations/adms-physical-verification-checklist.md` (site items S-0 to S-8, owner decisions D-1 to D-5, export UAT U-1 to U-6). Both machines were offline at the time of the review (primary since 2026-11-09 12:33 WIB, second since 2026-10-23); item S-0 comes first.

Closure rule: every accepted row must end as `verified`, `verified_unsupported`, or `excluded_by_product_contract`. Repository implementation alone never changes a physical row to `verified`. No row with `not_verified` may remain when ATT-005 is closed.

Primary canary device: `SPK7245000707`. Second device `SPK7245000738` is not used for first experiments.

| Capability | Repository contract | Physical outcome now | Closure evidence required |
|---|---|---|---|
| Passive registration / last-seen | ingress journal + device timestamps + WDMS evidence API/UI | **verified** (2026-11-11 evidence review) | `SPK7245000707` registered 2026-08-28; 102 handshake requests (`GET /iclock/cdata`) 2026-08-29 → 2026-11-09, all HTTP 200; `last_seen_at` 2026-11-09 12:33 WIB |
| Heartbeat / getrequest | passive journal evidence | **verified** (2026-11-11 evidence review) | 585,103 `GET /iclock/getrequest` from `SPK7245000707` 2026-08-28 → 2026-11-09, all HTTP 200 (309,707 from `SPK7245000738`) |
| Push protocol metadata | safe `pushver`/`PushVersion` metadata + desired profile | **verified** (2026-11-11 evidence review) | every handshake with metadata carries `pushver=2.4.1` (102 on the primary); INFO read 2026-10-19 reports `PushVersion` `Ver 3.0.6S-20240829`, firmware `ZMM510-NF28VA-Ver2.0.16` |
| PUSH attendance-only profile | base `TransData + AttLog`; biometric/photo flags gated | **verified** (2026-11-11 evidence review) | all 102 handshake responses to the primary (67 to the second machine) send `TransFlag=TransData AttLog`, `Realtime=1`, `TimeZone=7`, no biometric/photo flag; the only redacted sensitive uploads (12, on 2026-08-30/31) came from the active USERINFO reads that were retired afterwards; none since, across 4,376 ATTLOG uploads |
| Active time sync | typed canary operation | **verified** (canary 2026-09-04) | after migration 0044 removed the blocker, canary `set_options_datetime` ran 2026-09-04 09:45:01 WIB, device return code 0 at 09:45:09, device requested server time (`rtdata type=time`) at 09:45:09.6; capability state `verified` 2026-09-04. After-check: the smallest (HCIS receive − device time) per month on the primary is −0.3 s (Sep), −2.2 s (Oct), −0.9 s (Nov), so the device clock stays within about 2 s of HCIS. No before/after photo of the device clock was taken |
| Duplicate-punch period | typed SET OPTION + reload | **verified** (2026-09-07) | canary `set_alarm_rerec` 3 s at 09:56 WIB (set + reload, both return 0), then execute 2 s at 10:01 (both return 0); capability `verified` 2026-09-07. The value before the canary was not recorded; site item S-7 reads the current value on the machine |
| Work Code upsert/delete | typed delivery + target state | **verified** (2026-09-07) | canary `work_code_upsert` (present) 13:54 WIB return 0, then execute `work_code_delete` (absent) of the same code 13:58 return 0; capability `verified` 2026-09-07 |
| Public message | typed SMS delivery/delete | not_verified | site item S-1: visible message + removal evidence |
| Private message assignment | typed SMS + explicit mapped PIN | not_verified | site item S-2: approved PIN receives only assigned message |
| User profile push | explicit employee.id -> effective PIN | not_verified | site item S-3: profile appears with leading-zero PIN preserved. The 2026-08-30 same-PIN name writes (3 × return 0) were the earlier Wave 2 narrow capability, not this typed operation, and do not close the row |
| User disable/enable | expiration/authorization only; no user delete | not_verified | site item S-4: disable, prove biometric survives, enable again |
| Reboot | typed reboot | not_verified | site item S-5: device reconnects and ATTLOG resumes |
| NTP configuration | typed NTP option | not_verified | site item S-6 after owner decision D-2 (server value) |
| ADMS server config | typed host/port; canary must preserve production ingress | not_verified | site item S-8: safe same-ingress rewrite + continued ingress, with a person at the machine as fallback |
| Firmware package/upgrade | model-bound explicit target + short-lived ticket | not_verified | owner decision D-4: no package for `ZMM510-NF28VA-Ver2.0.16` is held |
| Attendance photo | encrypted ingress + gated handshake flag | not_verified | owner decision D-3; the machine reports `PhotoFunOn=0` (INFO 2026-10-19) |
| Fingerprint template query | typed legacy query behind biometric gate | not_verified | approved single-PIN query and encrypted vault evidence (checklist D-1) |
| Unified BIODATA query | typed unified query behind biometric gate | not_verified | approved single-PIN query or unsupported evidence (checklist D-1) |
| Remote fingerprint enrollment | typed enrollment | not_verified | one approved employee/PIN canary (checklist D-1) |
| Unified biometric enrollment | typed enrollment | not_verified | one approved employee/PIN canary or unsupported evidence (checklist D-1) |
| Encrypted biometric backup | ingress encrypts before persistence | not_verified | credential created without routine plaintext exposure (checklist D-1) |
| Biometric restore same device | vault decrypt only at device polling | not_verified | same-device restore + match validation (checklist D-1) |
| Biometric distribution | explicit target device | not_verified | approved second-device distribution after primary workflow succeeds (checklist D-1) |
| Fingerprint delete | typed selected delete | not_verified | selected template removed, identity/master credential preserved (checklist D-1) |
| Legacy face delete | typed selected delete | not_verified | selected face removed or `verified_unsupported` (checklist D-1) |
| Unified BIODATA delete | typed selected delete | not_verified | selected credential removed or `verified_unsupported` (checklist D-1) |
| Clear attendance log | break-glass typed destructive operation | not_verified | last-phase canary with HCIS raw history preserved (checklist D-5) |
| Clear photo/cache | break-glass typed destructive operation | not_verified | last-phase canary with evidence (checklist D-5) |
| Clear all device data | highest-risk break-glass operation | not_verified | explicitly approved final canary or product-contract exclusion (checklist D-5) |
| Device inventory export | safe CSV | repository_ready | UAT export opens and excludes secrets (checklist U-1) |
| Mapping/user export | explicit/effective-dated CSV | repository_ready | UAT leading-zero PIN retained (checklist U-2) |
| Work Code delivery export | safe CSV | repository_ready | UAT target/delivery state (checklist U-3) |
| Physical operation history/export | safe metadata + return codes; no wire secrets | repository_ready | UAT export/history (checklist U-4) |
| Physical audit export | physical request/state/profile audit only | repository_ready | UAT export (checklist U-5) |
| Raw attendance export | raw facts only, no attendance policy inference | repository_ready | UAT sample reconciliation (checklist U-6) |
| Arbitrary/raw command | intentionally absent | excluded_by_product_contract | static/runtime guard remains absent |
| Active USERINFO reads | permanently retired after unsafe physical evidence | excluded_by_product_contract | DB trigger remains exactly one; UI/action absent |

## Invariants

- `BIOMETRIC_COLLECTION_ENABLED=0` on initial production deployment.
- No per-device biometric collection gate is enabled by deploy/verify.
- No biometric canary without explicit user approval, configured keyring, primary canary-only gate, and one approved employee/PIN.
- No raw biometric template, ciphertext, hash, IV, auth tag, key ID, or reusable firmware token in routine API/UI/logs.
- No `DATA DELETE user`.
- No identity inference from name, NIP, unit, card, or external ID.
- Attendance remains raw/policy-neutral.
- `scripts/verify-vps.sh` must finish with `verification_device_commands_requested=0`.

This ledger intentionally retains physical rows as `not_verified` until one-capability-at-a-time hardware canaries are actually completed. Therefore ATT-005 is not DONE at repository merge time.

## Remaining rows by blocker (2026-11-11)

| Blocker | Rows | Count |
|---|---|---|
| Site session, person at the machine | public message, private message, user profile push, user disable/enable, reboot, ADMS server config | 6 |
| Owner decision, then site | NTP (server value), firmware (no package held), attendance photo (privacy; photo function off on the machine) | 3 |
| Biometric gate (owner; `BIOMETRIC_COLLECTION_ENABLED` OFF) | fingerprint query, BIODATA query, fingerprint enrollment, unified enrollment, encrypted backup, restore, distribution, fingerprint delete, face delete, BIODATA delete | 10 |
| Break-glass, last phase (owner) | clear attendance log, clear photo/cache, clear all device data | 3 |
| Owner UAT in HCIS, no machine | device inventory, mapping, Work Code delivery, operation history, physical audit, raw attendance exports | 6 |

Already closed: 7 `verified` (passive registration, heartbeat, push metadata, attendance-only profile, time sync, duplicate-punch period, Work Code) and 2 `excluded_by_product_contract` (arbitrary/raw command, active USERINFO reads).

The production hold of 2026-11-11 (no device commands, no mapping or schedule changes) blocks every row except the export UAT until the owner lifts it.
