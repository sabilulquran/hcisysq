# Production release verification — 2026-10-26 (Mi8VPS, hcis-b1657745)

**Status:** RELEASED AND VERIFIED. The operator's browser check of the rebuilt Kehadiran menu is not yet confirmed (see Notes).

**Owner approval:** 2026-10-26, in chat: "Ya, saya setujui rilis hcis-b1657745-20261026 ke produksi sekarang dengan --apply --confirm RELEASE_b1657745. Tidak ada migrasi. Rollback aplikasi kalau ada cek yang gagal."

**Flow:** `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001), dry run first, then `release-mi8.sh all --apply --confirm RELEASE_b1657745`.

## Why

Ships the five ATT-014 R1 packages the owner asked for after trying the previous release in production (#170, #171, #172, #173, #174):

- Kalkulasi is no longer a tab of its own; it became the "Tarik data" step inside Laporan, followed by raw transaction data and then a report model.
- A real print document: letterhead with the existing `ysq-mark.png`, report identity, separate "data dihitung" and "dicetak" lines, repeated table headers, page numbers, optional signature block. Printing uses its own route, not `window.print()` over the app page.
- The work-date bug in Koreksi HC and in the employee clarification form is fixed, with a server-side window check.
- Klarifikasi and Koreksi HC merged into one tab, "Perbaikan Absen".
- "Bukti HP" is gone as a tab; phone evidence now lives in Laporan → Data Transaksi with a source column.

Menu Kehadiran shrank from six tabs to three.

## Release

| Item | Value |
|---|---|
| Target SHA | `b1657745e91de5d2c8fe1a751f6c6b05b36bdad7` (`origin/main`) |
| Contents since running release | #171, #172, #170, #173, #174 |
| Release name | `hcis-b1657745-20261026` |
| Build | `build-mi8-release.yml` run [40277959267](https://github.com/sabilulquran/hcisysq/actions/runs/40277959267), green |
| Bundle sha256 | `c8921c551dffebaa2485afeeb376565ff6861642a09047da044add93aa8e2711` |
| Previous release | `hcis-254caa95-20261026`, kept in place for rollback |
| Migrations | 61 in bundle, **none pending**; `migrate` was a no-op |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-b1657745-20261026-20261026T061732Z.dump` (33 171 835 B, sha256 `245d39681aaa8ccf7dba21a868f28dddab4d45ea3836881aa48df0e5558f060c`) |

## Timeline (WIB, UTC+7)

| Time | Phase | Result |
|---|---|---|
| 13:14 | `all` dry run | PASS. `hcis-254caa95-20261026` was running, the target was absent, the lock was free, about 23.6 GB was free, biometric collection was OFF, no migrations pending. |
| 13:17 | preflight, upload, backup, migrate | PASS. Lock taken, 128 MB installed, backup verified with `pg_restore --list`, migrate a no-op. |
| 13:17 | candidate gate (:3391, :3291) | PASS: API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing-asset 404. |
| 13:18 | cutover | Launcher `3cdba9fd20291bb7…` → `cb3702617b318f69…`, worker `2d51c7fde677a071…` → `9d06302d4636efdb…`. Worker 12411 → 21235. Services restarted 13:18:08 and ran the new release after about 26 s. |
| 13:18 | verify | PASS: API and web release, `/health`, `/ready`, no-store, current symlink, worker alive, public `/api/health`, `/login`, missing-asset 404. Release lock released. |
| 13:19 | menu check (public bundle) | The served entry bundle contains "Perbaikan Absen" at `/admin/attendance/corrections`, "Data Transaksi", "Tarik data", `/admin/attendance/reports/print`, and the redirect map (`clarifications` → `corrections`, `mobile-evidence` → Laporan with the mobile source filter). The label "Bukti HP" no longer appears anywhere. |
| 13:20–13:29 | 10-minute watch | PASS. Public `/api/health` returned 200 every minute. One `launch service=hcis` (13:18:23) and one `hcis-web` (13:18:39), with no later launches. Both processes run from `hcis-b1657745-20261026`. `hub` and `aset` answer 200. |

## Notes

- No migration and no permission change in this release; the attendance schema is unchanged from `hcis-254caa95-20261026`.
- The conflict between #172 and #173 in `apps/api/src/modules/attendance/workforce-routes.ts` was resolved before the merge by the session that wrote both sides, which kept both imports and re-checked the print output.
- Page numbers in the print document use CSS margin boxes, verified in Chrome. Firefox and Safari do not support them, and the screen states that limitation instead of hiding it.
- Still to confirm by the operator: open Waktu & Kehadiran with a real HC account, run one Kalkulasi from Laporan, print one report, and save one correction from Perbaikan Absen on a past date.
- No `final.env` values, tokens, cookies or employee data are recorded here.

## Rollback

`scripts/mi8/release-mi8.sh rollback --bundle <bundle> --sha b1657745e91de5d2c8fe1a751f6c6b05b36bdad7 --apply --confirm RELEASE_b1657745` returns to `hcis-254caa95-20261026`, which has the six-tab Kehadiran menu and the work-date bug. The database needs no action: this release applied no migration.
