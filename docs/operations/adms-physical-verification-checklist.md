# ATT-005 — Owner and site checklist for ADMS physical verification

**Spec:** ATT-005 (`docs/domain/attendance-wdms-full-physical-parity-ledger.md`), ATT-012 operator UX  
**Status:** OPEN — waiting for an owner-approved site session  
**Created:** 2026-11-11

This is what is left before the ATT-005 ledger can close. Everything here needs either a person at the fingerprint machine, an owner decision, or both. No item in this list can be done by software alone.

Hold in force (owner, 2026-11-11): no device commands, no PIN mapping changes and no schedules on production until the owner lifts it. `BIOMETRIC_COLLECTION_ENABLED` stays OFF. Production is pre-launch: do not activate staff accounts or send invitations as part of these tests.

## Before any test: both machines are offline

Read-only evidence on 2026-11-11 08:18 WIB:

| Machine | Last contact with HCIS | Last attendance received |
|---|---|---|
| `SPK7245000707` (primary test machine) | 2026-11-09 12:33 WIB | 2026-11-09 12:00 WIB |
| `SPK7245000738` | 2026-10-23 07:23 WIB | 2026-10-20 08:17 WIB |

HCIS itself is reachable (the ingress tunnel is up and other traffic flows), and no ADMS request has reached the API since those times. The likely cause is at the site: power, network, or the machine's server setting.

- [ ] **S-0.** At each machine: check power, network cable/Wi-Fi, and that the screen shows the server connection icon. Do not change the server address on the machine. After the fix, open Manajemen ADMS › Kesehatan & Alert and confirm the machine shows **Online**.
- [ ] **S-0b.** Ask staff to punch normally and confirm the punch appears under Transaksi within a minute.

## Session rules

1. Use only `SPK7245000707` until a capability passes there. Use `SPK7245000738` only for the second-machine biometric row.
2. One capability at a time, in the order below. Stop on the first unexpected result and report it; do not retry with a different syntax.
3. The first run of each capability is a **canary** from Mesin › Maintenance › Diagnostik teknis (needs `attendance.devices.technical`). After it passes, HCIS marks the capability verified for that machine and the operator button named in the table below becomes active; use that button for the second run.
4. The person at the machine takes a photo of the machine screen for each visible result (message, user, value). Photos must not show other staff's personal data or fingerprints; store them outside the repository.
5. Afterwards, record the result in the ledger (date, operation, result) and attach nothing personal.

## Site session (person at the machine)

| # | Capability (ledger row) | What the operator does in HCIS | What the person at the machine checks | Pass |
|---|---|---|---|---|
| S-1 | Public message | Data Mesin › Pesan: create a short test message for all users, send it (canary), then remove it | The message appears on the machine screen, then disappears after removal | both seen |
| S-2 | Private message | Same, but for one test employee whose PIN is already mapped | Only that PIN sees the message when punching; another PIN does not | seen for the one PIN only |
| S-3 | User profile push | Pengguna: "Kirim / perbarui pegawai" for one mapped test employee (a PIN with a leading zero if one exists) | User appears in the machine's user list with the right name; leading zero kept | user listed correctly |
| S-4 | User disable / enable | Pengguna: "Nonaktifkan" the same test user, then "Aktifkan" (status di mesin) | While disabled the user cannot punch; fingerprint still on the machine; after enable the user can punch again | punch blocked, then works; fingerprint kept |
| S-5 | Reboot | Ringkasan › "Mulai ulang mesin" (typed confirmation) | Machine restarts by itself; afterwards Kesehatan shows Online and a test punch arrives | reconnect + punch |
| S-6 | NTP configuration | Konfigurasi › Sumber waktu otomatis (value: see D-2) | Machine menu shows the NTP server; clock stays correct | value shown |
| S-7 | Duplicate-punch period (already verified) | none | Read the "duplicate punch" value in the machine menu and write it down; it should be the intended operating value (2 s was last set on 2026-09-07) | value recorded |
| S-8 | ADMS server config | Diagnostik teknis: same-target rewrite only (HCIS allows only the approved ingress host/port) | Machine stays connected; punches keep arriving. Keep the machine's current settings written down beforehand so they can be re-entered by hand | still Online after rewrite |

## Needs an owner decision first

| # | Item | Default proposed (`DRAFT`) | Why it needs the owner |
|---|---|---|---|
| D-1 | Biometric rows (fingerprint/BIODATA query, enrollment, backup, restore, distribution, deletes — 10 rows) | Stay `not_verified` until the owner approves turning the biometric gate on for one machine and one consenting employee/PIN | `BIOMETRIC_COLLECTION_ENABLED` is OFF by owner decision; turning it on is a privacy/security decision |
| D-2 | NTP server value for S-6 | `id.pool.ntp.org` | Network policy at the site may require a different server |
| D-3 | Attendance photo | Stay `not_verified`. The machine reports `PhotoFunOn=0` (INFO read 2026-10-19), so the photo function is off on the machine today | Turning photos on is a privacy decision and needs the restricted-media keyring |
| D-4 | Firmware upgrade | Stay `not_verified` until a vendor package for model/firmware `ZMM510-NF28VA-Ver2.0.16` is supplied. If none is supplied, propose closing as `excluded_by_product_contract` for this fleet | No compatible package is held; HCIS must not guess one |
| D-5 | Clear attendance log, clear photo/cache, clear all device data | Run last, only on the primary machine, after HCIS raw history is confirmed complete; or close `clear_all_data` as `excluded_by_product_contract` | Destructive on the machine; break-glass permission and the owner's explicit go-ahead |

## Owner UAT without a device (HCIS exports)

These rows touch no machine. The six exports sit in the export panel of **Mesin › Maintenance › Diagnostik teknis** and need an account with `attendance.devices.technical` and `attendance.devices.export` (the owner's SUPER_ADMIN account has both). Download each CSV once for `SPK7245000707` and open it in a spreadsheet.

- [ ] **U-1.** Device inventory: opens; no serial secrets, tokens or keys.
- [ ] **U-2.** Mapping/user export: leading-zero PINs stay as text (for example `0012`, not `12`).
- [ ] **U-3.** Work Code delivery export: each code shows its target and delivery state.
- [ ] **U-4.** Physical operation history: operation, state and result only; no wire command, no token.
- [ ] **U-5.** Physical audit export: request/state/profile audit only.
- [ ] **U-6.** Raw attendance export for one day: row count matches the Transaksi view for that day; no lateness/overtime/leave columns.

## After the session

Update the ledger rows with the outcome and date, and record the release/verification note under `docs/development/` as usual. ATT-005 moves to `implemented`/`verified` only when no ledger row is left `not_verified` (closure rule in `attendance-wdms-full-physical-parity.md`).
