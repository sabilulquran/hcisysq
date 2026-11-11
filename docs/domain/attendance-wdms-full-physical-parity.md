# ATT-005 — Full WDMS Physical Parity Closure

Status: IMPLEMENTING  
Updated: 2026-09-04

## Closure rule

ATT-005 is not complete while any accepted parity row remains merely `not_verified`.

Every accepted row must finish in exactly one evidence-backed state:

- `implemented_verified` — HCIS implementation exists and, where hardware is involved, the exact capability passed a controlled physical canary on the target firmware;
- `verified_unsupported` — the documented capability was exercised through the approved typed canary and the deployed firmware/device family explicitly rejected or does not expose it;
- `excluded_by_product_contract` — the row is outside HCIS scope by the accepted parity contract, not an unfinished feature.

A successful repository build alone does not produce `implemented_verified` for a physical command.

## Canonical physical capability state

`attendance_adms_physical_capabilities` is the canonical per-device execution-evidence state for hardware operations. Admin read models must project this state instead of maintaining a second hardcoded capability truth.

Runtime states map to operator-facing execution as follows:

| Physical state | Operator-facing state | Device execution |
| --- | --- | --- |
| missing / `documented` | `not_verified` | blocked; typed canary may be offered |
| `canary_pending` | `not_verified` | blocked until terminal result; duplicate canary is rejected |
| `failed` | `not_verified` | blocked; review evidence before deliberate retry |
| `verified` | `available` | typed, explicit-target execution may be offered subject to the capability's other gates |
| `unsupported` | `blocked` | not executable |
| `blocked` | `blocked` | not executable |

The Wave 3 operations summary and Work Code/message delivery metadata must read this same per-device state. A `verified` state is never global firmware approval: it is evidence for the exact capability/device record and does not bypass biometric, destructive, firmware, authorization, confirmation, or rate-limit gates.

Changing an HCIS desired state or saving a catalog entry does not itself send a device command. Physical delivery remains a separate explicit operator action through typed endpoints.

## Non-negotiable safety boundaries

- active USERINFO reads stay retired because previous physical evidence showed sensitive side traffic;
- no arbitrary/raw command endpoint exists;
- employee→PIN mapping is explicit, effective-dated and preserves leading zeroes;
- device-user disable must not use `DATA DELETE user` because that can remove biometrics;
- raw attendance remains policy-neutral;
- biometric payloads and attendance photos never enter routine API/UI/log surfaces in plaintext;
- production biometric collection stays OFF until an explicit biometric canary gate is approved;
- destructive and firmware operations require typed confirmation, DB rate limiting and per-device canary evidence;
- destructive, firmware, biometric-maintenance and attendance-photo controls require the operator to type the displayed target-specific confirmation phrase; the browser must not silently manufacture that human confirmation;
- `canary_pending` is non-reentrant for physical capabilities: a second canary is rejected until the previous operation reaches a terminal result;
- ADMS server configuration is restricted server-side to the configured approved ingress host/port for both canary and execute; a verified capability does not authorize arbitrary redirects;
- HCIS raw ADMS history is not deleted by device-maintenance commands.

## Accepted parity matrix

| Area | Capability | HCIS implementation target | Physical closure |
| --- | --- | --- | --- |
| A | manual/discovered registry, area/context, attendance-only role, unit/worksite binding | WDMS profile on device registry | HCIS-only |
| A | transfer mode and heartbeat profile | PUSH-only registry + handshake profile | passive handshake evidence |
| A/B | serial/model/FW/PUSH version, last seen, health, counts | passive INFO/PUSH metadata | passive/INFO evidence |
| B | reboot | typed `REBOOT` operation | per-device canary |
| B | firmware upgrade | model-bound package + target-bound short-lived download ticket | per-device firmware canary |
| C | realtime ATTLOG | existing PUSH ingress | verified |
| C | bounded/manual/scheduled/long-range recovery | existing typed ATTLOG recovery | verified |
| C | pending queue lifecycle | existing command ledger + safe cancellation | verified |
| D | raw searchable transactions, filters, CSV, saved filters | existing Package 3 operations | verified |
| E1 | device user roster/mapping | passive safe roster + explicit mapping | verified without active USERINFO reads |
| E1 | push selected HCIS employee to device | typed modern user update | per-device canary |
| E1 | remote enable/disable without identity/biometric deletion | expiry + authorization update, never `DATA DELETE user` | per-device canary |
| E2 | biometric backup/query | legacy fingerprint/unified BIODATA typed query + encrypted vault | biometric-gated canary |
| E2 | remote enrollment | typed `ENROLL_FP` / `ENROLL_BIO` | biometric-gated canary |
| E2 | restore/distribute | decrypt only at delivery; legacy/unified restore | biometric-gated canary |
| E2 | selected device delete | typed legacy/unified delete; HCIS master preserved | biometric-gated canary |
| F | Work Code catalog and delivery/removal | HCIS catalog + typed device delivery | per-device canary |
| G | attendance photo | redacted ingress + encrypted restricted-media storage | keyring-gated canary |
| H | active time sync | typed ZKTeco DateTime update | per-device canary |
| H | duplicate-punch period | typed AlarmReRec + reload | per-device canary |
| H | NTP server | typed NTPServer + reload | per-device canary; unsupported is acceptable only after evidence |
| H | ADMS server address/port | typed WebServerIP/WebServerPort; server-side approved-ingress allowlist applies to canary and execute | per-device same-target canary |
| H | PUSH protocol profile | registry desired version + handshake negotiation, no invented device setter | passive handshake evidence |
| I | attendance-state mapping | raw status/verify/work-code facts only | HCIS-only |
| J | clear attendance/photo/cache/all | typed break-glass operations; HCIS history preserved | per-device destructive canary |
| K | templates/shifts | excluded | `excluded_by_product_contract` |
| L | public/private device messages | HCIS catalog + SMS/USER_SMS typed delivery | per-device canary |
| L | email via WDMS | excluded | `excluded_by_product_contract` |
| M | MTD | excluded | `excluded_by_product_contract` |
| N | enhanced Job Code | neutral raw-reference catalog only | HCIS-only |
| O | operational exports/reporting | transaction/inventory/mapping/operation evidence exports | HCIS-only |
| P | search/sort/saved configs | existing saved-filter and paginated admin UX | HCIS-only |
| Q | SUPER_ADMIN, audit, typed confirmation, rate limit, break-glass | application + DB guard | verified by tests + production verifier |
| R | organization security matrix outside fingerprint operations | excluded | `excluded_by_product_contract` |

## Canary device and execution order

Physical proof is performed only on `SPK7245000707` first. No command is sent by deployment or verifier.

Recommended progression is least destructive to most sensitive:

1. passive handshake/profile evidence;
2. Work Code and message add/remove;
3. time sync, duplicate-punch, NTP, same-target server rewrite;
4. user profile upsert and non-destructive enable/disable;
5. reboot;
6. biometric query/enrollment/backup/restore/distribute/delete after explicit biometric gate approval;
7. attendance-photo encrypted ingress;
8. clear attendance/photo/cache/all with break-glass confirmation;
9. firmware upgrade last, using a firmware package explicitly matching the physical model.

Each canary records command number/result, capability state and audit evidence. A failed documented command is not silently retried with guessed syntax.

## Production completion

Repository completion requires migrations, typecheck, lint, tests, build and compose validation all green. Production completion then requires:

`MERGE → one deploy → verifier → controlled canary ledger → browser UAT → final parity ledger with no not_verified rows`.

Until that final ledger exists, ATT-005 remains `implementing`.

## Status 2026-11-11

Repository and production deployment are complete. The ledger records 7 physical rows `verified` from production evidence and 2 `excluded_by_product_contract`; 22 physical rows and 6 HCIS-only export rows remain open. Each open row is mapped to a site item, owner decision, or export UAT step in `docs/operations/adms-physical-verification-checklist.md`. ATT-005 stays `implementing` under the closure rule above.
