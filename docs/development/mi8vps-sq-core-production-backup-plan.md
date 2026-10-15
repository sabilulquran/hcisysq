# Mi8VPS SQ Core production database backup — change plan

**Spec ID:** OPS-MI8-BAK-001  
**Status:** APPLIED 2026-10-15 23:11–23:16 WIB. The owner approved all six items in §5, including permanent deletion of off-host sets beyond the newest 14. The first scheduled run passed on 2026-10-16 02:00 WIB (see §10).  
**Updated:** 2026-10-15  
**Related:** OPS-MI8-REL-001 (Mi8VPS HCIS release flow), `docs/operations/permanent-staging-retirement-2026-10-02.md`  
**Ready-to-apply diff:** [`mi8vps-sq-core-production-backup.patch`](mi8vps-sq-core-production-backup.patch)

## 1. Problem

Production HCIS, Akun SQ (Keycloak), SQ Hub and Aset SQ run on Mi8VPS (Android phone, Ubuntu chroot at `/data/local/ubuntu26`, Termux PostgreSQL 18.6 on `127.0.0.1:5432`). Their production databases have **no scheduled backup, local or off-host**:

- `/data/local/mi8vps/sq-core-backup.sh` runs daily at 02 UTC from `sq-core-worker.sh`. It dumps only the `sqcore_phase3_cutf8_20261004_*` rehearsal databases and labels each set `scope=non-production-rehearsal`.
- The Google Drive uploaders in the chroot's `/usr/local/sbin` (`h1-offhost-fresh-set`, `upload-h1-core-and-sqlite-gzip`, ...) are one-shot and approval-gated, and say "Never schedule". The only SQ Core set on Drive, `mi8_crypt:production/h1-20261012/sq-core/set-20261012T020012Z`, holds the rehearsal dumps.
- `/srv/hcis/backups` is empty.

Losing the phone's storage today would lose all production HCIS data since go-live.

## 2. Verified facts (read-only inspection, 2026-10-15)

Database names come from the env file each launcher sources (`sq-core-launch.sh` sources `/srv/<app>/shared/final.env`; Keycloak's `start-final.sh` sources `/srv/keycloak/shared/final.env`). Only database names were extracted; no credential was printed.

| App | Env key | Production database | Size | Current rehearsal dump source |
| --- | --- | --- | --- | --- |
| Keycloak (Akun SQ) | `KC_DB_URL` | `sqcore_keycloak` | 13 MB | `sqcore_phase3_cutf8_20261004_keycloak` |
| HCIS | `DATABASE_URL` | `sqcore_hcis` | 331 MB | `sqcore_phase3_cutf8_20261004_hcis` |
| SQ Hub | `DATABASE_URL` | `sqcore_hub` | 10 MB | `sqcore_phase3_cutf8_20261004_hub` |
| Aset SQ | `DATABASE_URL` | `sqcore_aset` | 9 MB | `sqcore_phase3_cutf8_20261004_aset` |

`pg_stat_activity` confirmed live sessions from `sqcore_hcis_owner` on `sqcore_hcis` and `sqcore_keycloak_owner` on `sqcore_keycloak`. Hub and Aset had no open connection at the time of the check; their env files are the evidence.

Capacity and tooling:

- Rehearsal set size: about 23 MB (HCIS custom-format dump 22 MB, the others under 300 KB). A production set should be similar; HCIS is 331 MB live versus 255 MB rehearsal, so expect about 25–30 MB.
- Local `/data`: 31 GB free of 49 GB. The current rehearsal sets use 155 MB.
- Google account: Drive `used` 9.43 GB + `other` 3.24 GB = 12.67 GB. The quota guard (`check-drive-effective-quota`) blocks above 14.0 GB total and above 1.2 GB for the whole `mi8_crypt:` vault. The vault holds 203 MB in 29 files, so about 1.0 GB of vault headroom remains.
- Chroot tools: `rclone` v1.75.2, `flock`, `python3`, `timeout`, `sha256sum`, `gzip` (no `zstd`). A root SSH login starts in Termux, so chroot commands need an explicit `PATH`.
- Termux: `pg_dump`, `pg_restore`, `psql`, `createdb`, `dropdb`. As in the current script, they run as the Termux user over the local socket; TCP needs a password.
- About 20 leftover rehearsal databases (`sqcore_rehearsal_*`, `sqcore_phase2_c_*`, `sqcore_icu_*`, `sqcore_phase3_*`, `sqcore_phase4_*`) take about 1.1 GB. Removing them is out of scope (§9).

Current script hashes, for drift detection before applying the patch:

```text
144fc82cf8629fdb7dba351e2e7f589652599f4f927ea82a6cf1c72ee23e6955  /data/local/mi8vps/sq-core-backup.sh
52ce6f8f5be8a9ba9e495eff5a8b36ef32ef58a2ca629f412e13fe4c231bc350  /data/local/mi8vps/sq-core-worker.sh
758eb684bc119c0eb863c64df0678807c901d1a2f381d30c4783edcc121eefa4  /data/local/mi8vps/sq-core-logrotate.sh
```

## 3. Target behaviour

| Layer | What | Where | Schedule | Retention |
| --- | --- | --- | --- | --- |
| Local set | `pg_dump -Fc` of the 4 production DBs, Keycloak providers/themes, Aset attachments, config metadata (paths and modes only), `manifest.tsv`, `SHA256SUMS` | `/srv/sq-core-backups/production-sets/set-<UTC stamp>/` (chroot path), root `0700` | Daily 19 UTC (02:00 WIB) | 14 newest OK sets, plus the set being written. Failed sets are kept as evidence. |
| Off-host copy | The newest OK local set, unchanged, through rclone crypt | `mi8_crypt:production/sq-core-daily/set-<UTC stamp>/` | Right after a successful local set | 14 newest sets, about 350–420 MB. Older sets are purged without Drive trash. |
| Restore check | Restore each dump into a disposable `sqcore_restorecheck_<app>` DB, compare table count with live, drop | Termux PostgreSQL | Weekly, Sunday 20 UTC (Monday 03:00 WIB) | Log only |

Recovery point objective: 24 hours. Off-host loss window: one daily set.

### Why 19 UTC instead of 02 UTC

02 UTC is 09:00 WIB, inside working hours. The worker also stops supervising services while the backup runs. 19 UTC (02:00 WIB) is the quietest window. If the owner prefers to keep 02 UTC, change `BACKUP_HOUR_UTC` in the worker. The restore check must still run at least one hour after the backup.

## 4. Changes (see the patch)

### 4.1 `sq-core-backup.sh` (modified)

- Dumps `sqcore_keycloak`, `sqcore_hcis`, `sqcore_hub`, `sqcore_aset`. It no longer dumps the rehearsal databases.
- Labels each set `scope=production` and writes it to a new root, `/srv/sq-core-backups/production-sets`, so production and rehearsal sets never share a retention pool.
- Writes `manifest.tsv` with scope, creation stamp, `pg_dump --version` and app→database pairs. The manifest is included in `SHA256SUMS`.
- Runs `pg_restore --list` on every dump before accepting it, which catches truncated archives.
- Archives Keycloak providers/themes from the `current` symlink instead of a hardcoded release. It refuses anything that does not resolve to `releases/keycloak-*`.
- Raises local retention from 7 to 14 sets (`SQ_CORE_BACKUP_KEEP`). The retention pool contains only `scope=production` sets.
- Still never copies `shared/*.env` or other secret values (§9).

### 4.2 `/usr/local/sbin/sq-core-offhost-daily` (new, chroot, root `0700`)

The script is modelled on `h1-offhost-fresh-set` and uses the same guarantees, with scope fixed to SQ Core production sets:

1. Requires root, a `0600` non-symlink `rclone.conf`, the quota guard and a `0700` set root.
2. Takes the global lock `/srv/sq-core-backups/offhost-state/.offhost.lock` with `flock -n`, so two producers never run in parallel.
3. Picks the newest set whose `backup.log` ends `result=OK scope=production`. It exits `ALREADY_DONE` if that set already has a success marker.
4. Checks the set's owner and mode, the `scope<TAB>production` line in its manifest, that it contains no symlinks, `sha256sum -c`, and an exact allow-list of 10 files.
5. Runs `check-drive-effective-quota` on those files and fails closed (exit 42) when the 14 GB account or 1.2 GB vault limit would be crossed.
6. Runs `rclone copy --immutable` (bandwidth 4 MB/s, 1 transfer), then `cryptcheck --one-way`, then downloads the set again and compares it with `sha256sum -c` and `diff -qr`.
7. Writes `offhost-state/<set>.ok` only after the comparison passes.
8. Only then purges remote sets beyond 14 (`SQ_CORE_OFFHOST_KEEP`, minimum 3) with `--drive-use-trash=false`. Trashed bytes would still count against the 15 GB budget. The purge refuses to touch the set it just uploaded, and it only matches `set-YYYYMMDDTHHMMSSZ` directory names under `production/sq-core-daily/`. The existing `h1-*` sets are never touched.

### 4.3 `sq-core-restore-check.sh` (new, Android shell, root `0700`)

- Uses the newest OK production set and checks `SHA256SUMS`.
- For each app it creates `sqcore_restorecheck_<app>`, runs `pg_restore --no-owner --no-acl --exit-on-error`, and compares the number of user tables with the live database. A mismatch, an empty restore or a restore error fails the check.
- Always drops the disposable databases in an `EXIT` trap. `dropdb` refuses any name outside the four `sqcore_restorecheck_*` names.
- Prints counts only, never row data. Prints `SQ_CORE_RESTORE_CHECK result=PASS|FAIL`.
- Peak extra disk use is about 350 MB while HCIS is restored. The restore adds load to the same PostgreSQL that serves production, which is why it runs at 03:00 WIB.

### 4.4 `sq-core-worker.sh` (modified)

- Moves the daily backup from hour `02` to `BACKUP_HOUR_UTC=19`.
- After a successful backup it runs the off-host copy in the chroot with a clean environment and `timeout 1800`, logging to `sq-core-offhost.log`. An off-host failure never removes the local set; the worker logs `scheduled off-host copy FAILED exit=<n>`.
- Runs the weekly restore check on Sunday at 20 UTC, logging to `sq-core-restore-check.log`.
- Logs failures in upper case (`FAILED`) with the exit code, so they can be grepped.

### 4.5 `sq-core-logrotate.sh` (modified)

Adds `sq-core-offhost.log` and `sq-core-restore-check.log` to the bounded rotation.

## 5. Approval scope the owner is asked to grant

1. Dump the four production databases daily to local root-only storage on Mi8VPS.
2. Upload those sets, encrypted with the existing `mi8_crypt:` key, to Google Drive daily, inside the existing 14 GB / 1.2 GB guard.
3. **Permanently delete** off-host SQ Core daily sets older than the newest 14 under `mi8_crypt:production/sq-core-daily/`, without Drive trash.
4. Create and drop the four disposable `sqcore_restorecheck_*` databases weekly on the production PostgreSQL.
5. Move the daily SQ Core backup from 09:00 WIB to 02:00 WIB.
6. Restart `sq-core-worker.sh`. The running app processes are unaffected because they are `nohup` children. `start-services.sh` relaunches the worker within about 120 s.

If item 3 is refused, set `SQ_CORE_OFFHOST_KEEP` very high and prune by hand. At about 28 MB per set the vault cap is then reached in about 35 days, and the guard will start blocking uploads.

## 6. Rollout (each numbered step needs the owner's go-ahead)

All commands run as `ssh mi8vps-root`. Keep the output and record PASS/FAIL in the runbook.

1. **Drift check.** Compare `sha256sum` of the three scripts against §2. If they differ, stop and regenerate the patch.
2. **Back up the current scripts.**

   ```sh
   cd /data/local/mi8vps
   for f in sq-core-backup.sh sq-core-worker.sh sq-core-logrotate.sh; do cp -p "$f" "$f.pre-ops-mi8-bak-001"; done
   ```

3. **Apply the patch** on a workstation copy of the three scripts (`patch -p1` against a tree laid out as `data/local/...`). Copy the five resulting files to the device: three to `/data/local/mi8vps/` and `sq-core-offhost-daily` to `/data/local/ubuntu26/usr/local/sbin/`. Set `chmod 0700` and owner root on each, and run `sh -n` (`bash -n` for the uploader) on the device.
4. **Run the backup by hand**, then inspect the set.

   ```sh
   /data/local/mi8vps/sq-core-backup.sh
   S=$(ls -1d /data/local/ubuntu26/srv/sq-core-backups/production-sets/set-* | tail -1)
   cat "$S/backup.log" "$S/manifest.tsv"
   ```

   Expected: four `result=OK` lines with production database names, then `result=OK scope=production`.
5. **Run the restore check by hand.** `/data/local/mi8vps/sq-core-restore-check.sh` should print `result=PASS`. Then confirm no `sqcore_restorecheck_*` database remains (`psql -l`).
6. **Run the off-host copy by hand.**

   ```sh
   chroot /data/local/ubuntu26 /usr/bin/env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /usr/local/sbin/sq-core-offhost-daily
   ```

   Expected: `EFFECTIVE_QUOTA_15GB_PREFLIGHT_PASS`, then `SQ_CORE_ENCRYPTED_OFFHOST_PASS`. Running it a second time should print `ALREADY_DONE`.
7. **Restart the worker.** Kill the PID in `sq-core-worker.pid`, wait for `start-services.sh` to relaunch it, and confirm `SQ Core worker started` in `sq-core-worker.log` and that all services are ready (`sq-corectl.sh status`).
8. **Observe the first scheduled run** after 19 UTC. Expect `scheduled backup completed` and `scheduled off-host copy completed`. After the first Sunday, expect `weekly restore check passed`.

### Rollback

Restore the three `*.pre-ops-mi8-bak-001` files, remove `sq-core-restore-check.sh` and `/usr/local/sbin/sq-core-offhost-daily`, and restart the worker. Leave the local and off-host production sets in place. They are encrypted, inert and valuable; deleting them is a separate owner decision.

## 7. Restore procedure (for an actual recovery)

1. Pick the set. Use the local one if the phone storage is intact. Otherwise download it from Drive: `rclone copy mi8_crypt:production/sq-core-daily/<set> <empty dir>`, then `sha256sum -c SHA256SUMS`.
2. Stop the affected app with `sq-corectl.sh` (Hub depends on HCIS and Keycloak, and Aset depends on HCIS and Hub).
3. Restore into a new database: `createdb` and `pg_restore --no-owner --no-acl --exit-on-error`. Grant ownership to the app role (`sqcore_<app>_owner`). Then either switch the database name in `final.env` or rename the databases while the app is stopped. Never `pg_restore --clean` over the live database.
4. Restore secrets and env files separately (§9). The sets intentionally hold none.
5. Start the app and verify with the release-flow health checks (OPS-MI8-REL-001).

The four dumps are taken one after another within about a minute, not in one snapshot. Cross-app references (Keycloak subject ↔ HCIS account ↔ Hub) can therefore differ by changes made during that minute. At 02:00 WIB that risk is negligible, but note it in any recovery report.

## 8. Failure behaviour and monitoring

| Failure | Effect | Signal |
| --- | --- | --- |
| `pg_dump` or `pg_restore --list` fails | Set kept as `result=FAIL`; retention ignores it; no upload | `scheduled backup FAILED` in `sq-core-worker.log` |
| Quota guard blocks | No upload; local set intact | `EFFECTIVE_QUOTA_15GB_BLOCKED` in `sq-core-offhost.log`, `off-host copy FAILED exit=42` |
| Network or Drive error, or verify mismatch | No `.ok` marker; the next day's run uploads the next set | `SQ_CORE_OFFHOST_BLOCKED` with reason |
| Restore check fails | Disposable DBs dropped | `weekly restore check FAILED` |
| Worker restarted during hour 19 | The backup can run a second time that day (existing behaviour) | Extra set; harmless |

No alerting channel exists yet. Until one does, the owner or an operator should check, at least weekly:

```sh
grep -E 'scheduled (backup|off-host)|restore check' /data/local/mi8vps/sq-core-worker.log | tail -20
```

Pushing these lines to an alert channel is a follow-up (`TBD`).

## 9. Out of scope / open items

- **Secrets and env files** (`shared/final.env`, directory-proxy TLS key, Keycloak client secrets) are not in these sets by design. A full rebuild also needs them. Whether `upload-mi8-recovery-bundle` already covers them off-host is `DISCOVERY`; this needs a separate owner decision with its own encryption scope.
- **HCIS file storage:** no upload or attachment directory was found under `/srv/hcis`, and `final.env` has no storage-path key. Whether HCIS stores employee documents outside PostgreSQL is `DISCOVERY` and must be confirmed before calling HCIS fully backed up.
- **Rehearsal leftovers:** the old rehearsal sets under `/srv/keycloak/backups/sq-core-host-sets` (155 MB), the rehearsal set on Drive under `h1-20261012/sq-core/` (about 23 MB) and about 1.1 GB of rehearsal databases are no longer produced. Their deletion is a separate owner decision.
- The worker's `service_pid` patterns and launcher paths still name the 2026-10-04 releases. That belongs to OPS-MI8-REL-001 and is not changed here.

## 10. Applied evidence (2026-10-15, via `ssh mi8vps-root`)

| Step | Result |
| --- | --- |
| 1. Drift check | PASS. The three device scripts matched the §2 hashes. Backups were created as `*.pre-ops-mi8-bak-001` with their original modes. |
| 2–3. Install | PASS. The patch applied cleanly to byte copies of the live scripts, with no CRLF. Files were installed root-owned through a temp file and `mv`, so the running worker kept its old inode. `sh -n` / `bash -n` passed on the device. Installed sha256: backup `71aafc8e…3988`, logrotate `6e961a3e…21ff`, worker `a4e2adb0…a2b` (mode 0755 kept), restore-check `a0f6a306…a47`, offhost-daily `0340ab1a…153df`. |
| 4. Manual backup | PASS in 17 s. Set `set-20261015T161121Z` has `result=OK scope=production` with `sqcore_keycloak` 266 513 B, `sqcore_hcis` 27 801 896 B, `sqcore_hub` 251 864 B and `sqcore_aset` 66 155 B. It contains 10 files, all `0600 root`. The set and its roots are `0700 root`. `SHA256SUMS` verified; total size 28 MB. |
| 5. Manual restore check | PASS in 41 s. Table counts restored/live: keycloak 100/100, hcis 92/92, hub 10/10, aset 18/18. No `sqcore_restorecheck_*` database and no temp dump remained. |
| 6. Manual off-host copy | PASS in 90 s. `EFFECTIVE_QUOTA_15GB_PREFLIGHT_PASS` was printed (vault 203 MB → about 233 MB; account headroom after upload 2.30 GB). `cryptcheck` found 0 differences across 10 matching files, then `SQ_CORE_ENCRYPTED_OFFHOST_PASS` with `REMOTE_SETS=1 PURGED=0`. The second run printed `ALREADY_DONE`. |
| 7. Worker restart | PASS. TERM was sent to pid 31376 at 23:14:26. `start-services.sh` relaunched the worker as pid 31701 at 23:16:12, and only one worker is running. All SQ Core local health endpoints and public hcis/hub/aset/login returned 200/302. |
| 8. First scheduled run | PASS. `2026-10-16 02:00:18 scheduled backup completed` (set `set-20261015T190001Z`, `result=OK scope=production`), then `02:01:50 scheduled off-host copy completed`. `cryptcheck` found 0 differences across 10 files; `SQ_CORE_ENCRYPTED_OFFHOST_PASS` with `REMOTE_SETS=2 PURGED=0`. The weekly restore check is first due Sunday 18 Oct 20 UTC (Mon 03:00 WIB). |

Observation, not caused by this change: before the install, the worker restarted Keycloak 6× on 9 Oct, 5× on 14 Oct and 3× on 15 Oct after its readiness check failed. That needs separate investigation.

The Aset attachments archive is 10 KB, which matches an almost empty `shared/attachments`. Confirm this is expected before relying on the set for Aset file recovery.
