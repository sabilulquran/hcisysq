# Production release verification — hcis-d7b2e580-20261101 (OPS-MI8-REL-001)

**Date:** 2026-11-01 (10:00–10:02 UTC, 17:00–17:02 WIB)
**Operator:** AUTH-014 session (Claude Code), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). The device-wide release lock was free at preflight and was released after verify.

| Item | Value |
|---|---|
| Target SHA | `d7b2e5801c141104b56c412ba6accbef346885c3` (`origin/main`, merge of #253) |
| Previous release | `hcis-cdf13906-20261030` |
| Adds since `hcis-cdf13906-20261030` | ORG-011 role naming (#249, #250, documentation only); AUTH-014 machine self-vouch guard (#251); AUTH-014 account lookup route (#252); AUTH-014 policy errors answered 400 instead of 500 (#253) |
| Build | run [41295291164](https://github.com/sabilulquran/hcisysq/actions/runs/41295291164), bundle `hcis-d7b2e580-20261101.tar.gz` sha256 `9c7fab25e3b40d367141b787b9049e9d58429dd85cae41e13e292577e25b8d5d` |
| Migrations | 94 in bundle, **none pending**; `migrate` was a no-op, so the permission-migration window of §4.5 did not open |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-d7b2e580-20261101-20261101T100055Z.dump` (36 245 658 B, sha256 `9bf25d91cd83a5b3a99a72af81dc8059a647cc741857da5314779ebf3a9b7eca`), listed readable by `pg_restore --list` |
| Launcher / worker | `33b402776422427b` → `4cb252e7a3dd21c8` / `d2c6c171f78a6bdd` → `e35e56d5b73bf515` |
| Worker | KILL-restarted: pid 14533 → 30080 |
| Rollback target | `hcis-cdf13906-20261030`; no migration ran, so a rollback needs no database decision at all |

## Result (WIB)

| Time | Phase | Result |
|---|---|---|
| 17:00 | preflight (dry run) | PASS. Lock free, `hcis-cdf13906-20261030` running, 18 611 MB free, biometric OFF, database `sqcore_hcis`, no pending migrations. |
| 17:00 | upload, backup | Bundle checksum verified on the device; dump taken and listed. |
| 17:01 | migrate | No-op; nothing pending. |
| 17:01 | candidate | API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404 — all PASS. |
| 17:01 | cutover | New release running after about 26 s. |
| 17:02 | verify | Local and public checks PASS. Lock released. |

**Running release, proved from the process, not from the repository or the workflow:**

```text
30918 /data/local/ubuntu26/srv/hcis/releases/hcis-d7b2e580-20261101/apps/api
31355 /data/local/ubuntu26/srv/hcis/releases/hcis-d7b2e580-20261101/apps/web/dist
```

Read independently of the release script, by walking `/proc/*/cwd` on the device after verify. Note that the pid in `sq-core-pids/hcis.pid` is the `runuser` wrapper, whose `cwd` is the chroot root; the proof is the `node` child it execs.

Public after the release: `https://hcis.sabilulquran.or.id/api/health` → `{"status":"ok"}`, and `hub.sabilulquran.or.id` answers 200, so Hub's worker dependency gate recovered.

The worker log shows `launch service=hcis attempt=1` and `launch service=hcis-web attempt=2` at 17:01:50–17:02:06, with two `Hub dependency gate: HCIS unavailable` lines between them. That is the expected relaunch during cutover, not a crash loop, and the same `attempt=1` / `attempt=2` pair appears at every earlier cutover (2026-10-27 18:37, 2026-10-30 17:06, 2026-10-31 00:11).

**Ten-minute watch (17:02–17:13 WIB):** no further `launch service=hcis*` event, and both processes still run from `hcis-d7b2e580-20261101` — the same two `cwd` values as above, re-read at the end of the window.

**Not done, and it is not a formality:** the browser login and deep-link refresh that §4.8 asks of the operator. Signing in needs a password, which this session never types (owner rule). The release is therefore proved up to the public HTTP surface — `/api/health`, `/login` shell, missing-asset 404 — but not through an authenticated session. Someone who can sign in should do that once; if it fails, the rollback target is unchanged and no migration has to be undone.

## What changes for users

**Nothing visible.** Two of the five changes are documentation. The other three are on the SQ Hub role-administration channel, which stays switched off in production (`HCIS_ROLE_ADMIN_ENABLED` is not `1`): the routes answer `503` until the owner turns phase F5 on.

What this release does change is what will be true *when* that switch is flipped, which is why it was released before enabling the Hub side:

- a machine account can no longer present itself as the acting human (#251, found by a Keycloak probe on 2026-10-31);
- SQ Hub can translate a Keycloak subject into an HCIS account id, so no operator ever copies a UUID between two applications (#252);
- a mistyped date or a unit scope without a unit answers `400` with its own code instead of `500` (#253). SQ Hub reads `5xx` as "outcome unknown" and asks the operator to send the request again, so the old behaviour turned a typo into a request to retry.

Not recorded here: `final.env` values, tokens, cookies or employee data.
