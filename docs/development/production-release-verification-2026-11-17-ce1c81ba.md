# Production release verification — hcis-ce1c81ba-20261117 (OPS-MI8-REL-001)

**Date:** 2026-11-17 01:51–01:53 UTC (08:51–08:53 WIB), 10-minute watch until 02:03 UTC
**Operator:** Claude Code (release session dispatched for #356–#375), under the owner rule of 2026-10-27: release without confirmation, keeping the technical safeguards (dry run, backup before migrations, candidate gate, rollback if verification fails, report afterwards, never in the 19 UTC hour). The device-wide release lock was free at preflight, taken by the script, and released after verify.

| Item | Value |
|---|---|
| Target SHA | `ce1c81baf7b9f722453b49536b0a709909bdece7` (`origin/main`: merge of #365; tree equal to the PR head whose CI passed) |
| Previous release (rollback target) | `hcis-234db395-20261116` |
| Adds | #356 ASSET-001 docs; #357 PAY-003 §7.3 payroll result reader permission; #358 TRIP-001 package 2 `business_trip` attendance disposition; #359 ATT-014 §6.5c real-time attendance transactions; #360 PERF-001 → PAY-003 performance allowance (switch off); #361 DOC-001 package 2 income certificate; #362 ORG-011 package 4; #363 TRAIN-001 R3 evaluation; #364 REWARD-001 tilawah awards; #365 PAY-003-THR; #366 LOAN-001 package 2 payroll deduction (switch off); #367 TRIP-002 advances and per diem; #368 PAY-003 §7.4 annual PPh21 and 1721-A1; #369 test isolation; #370 TRAIN-001 R4 online modules (switch off); #371 migration renumber; #372 PAY-003 §7.5 PPh21 settings (switch off); #373 REIMB-001 §9 payroll handoff (switch off); #374 DOC-001 D-26; #375 TRIP-002 review fixes |
| Configuration | No `final.env` change (file unchanged since 2026-11-13). `LOAN_PAYROLL_DEDUCTION_ENABLED`, `REIMBURSEMENT_PAYROLL_HANDOFF_ENABLED`, `TRAINING_ONLINE_ENABLED` absent (default `0`); no `QURAN_*` key; the three `ASET_SQ_*` keys are the ones from ASSET-001, unchanged. The running API `node` process environment holds none of those switches or `QURAN_*` keys (count 0, values not read) |
| Build | run [43998018698](https://github.com/sabilulquran/hcisysq/actions/runs/43998018698), bundle `hcis-ce1c81ba-20261117.tar.gz` sha256 `cb1c4d01d8af31626d674dcc5bd40c8f68beba02c41a65e705986cd076f9fe6f` |
| Migrations | 142 in bundle; 14 applied: `0151_payroll_results_reader` … `0164_payroll_thr` (list below) |
| Pre-release backup | `/srv/hcis/backups/pre-release/hcis-ce1c81ba-20261117-20261117T015129Z.dump` (sha256 `c992b674…5e63cb63`, 40.5 MB), readable by `pg_restore --list` |
| Launcher / worker | `sq-core-launch.sh` `6c5a29cf7112aaf4` → `b59689a607d5ec47`; `sq-core-worker.sh` `d6742e23081c0463` → `061d99c366bbdd36` (sha256 prefixes) |
| Worker | restarted with KILL: pid 1879 → 10231 |
| Rollback target | `hcis-234db395-20261116`. Migrations are additive (new tables/columns with defaults, CHECK constraints rebuilt as supersets, unique keys widened by `kind`), so the old release runs on the new schema and rollback is application-only |

Migrations applied, in order: `0151_payroll_results_reader`, `0152_attendance_business_trip_disposition`, `0153_payroll_performance_percent_policy`, `0154_hr_document_income_certificate`, `0155_training_evaluation`, `0156_employee_loan_payroll_deduction`, `0157_payroll_pph21_annual_and_tax_identity`, `0158_training_online_modules`, `0159_reimbursement_payroll_handoff`, `0160_trip_advances`, `0161_payroll_pph21_settings`, `0162_rewards`, `0163_reward_permissions`, `0164_payroll_thr`.

Policy versions: of these, only `0164` inserts a `payroll_policy_versions` row (the `THR` version, effective 2026-01-01, note "DRAFT default agent 2026-11-17"). `0153` and `0161` only widen the policy-key CHECK. Read after migration: `payroll_policy_versions` holds no `PERFORMANCE_PERCENT`, `PPH21_SETTINGS` or `PPH21_ANNUAL` row, so the performance allowance and yayasan-borne PPh21 stay off.

`0151`, `0160` and `0163` grant new permission keys to existing roles, so the permission window of §4.5 was open between `migrate` (01:52:05 UTC) and the cutover (01:52:24–01:52:57 UTC), under a minute.

## Result

Preflight and the `all` dry run passed (lock free, 21.6 GB free on `/data`, biometric OFF, database `sqcore_hcis`, 14 pending migrations reviewed). Under `--apply`:
- upload, backup and migrate passed;
- the candidate gate passed (API `/health` and `/ready`; web `/`, no-store, `/login`, immutable entry asset, missing asset 404);
- after cutover (restart at 08:52:24 WIB, one `launch` per service, new release running after ~28 s), verify passed: release paths, API `/health` and `/ready`, web `/` no-store, current symlink, worker alive, public `/api/health`, `/login`, missing asset 404.

Read-only checks after verify:
- deep links `/app/attendance`, `/app/attendance/transactions`, `/admin/payroll`, `/admin/rewards`, `/app/training` return the SPA shell (200); the public entry asset `/assets/index-BKFRlf-e.js` returns 200;
- without a session, the new routes return 401, none 5xx: `/api/attendance/me/transactions`, `/api/me/rewards`, `/api/admin/rewards/rounds`, `/api/admin/trip-advances`, `/api/admin/trip-per-diem-rates`, `/api/admin/training/instruments`, `/api/admin/training/online/storage`, `/api/payroll/me/a1`, `/api/admin/job-classification-audit-events`;
- `hub.sabilulquran.or.id` and `aset.sabilulquran.or.id` answer 200;
- 10-minute watch (01:55–02:04 UTC): public `/api/health` and `/login` 200 every minute; `sq-core-worker.log` shows only the two cutover launches (08:52:42 `hcis`, 08:52:57 `hcis-web`) and the expected *Hub dependency gate* lines during those seconds; at 09:04 WIB the `hcis`, `hcis-web` and worker PIDs (10995, 11438, 10231) were unchanged; no error-level line in `api.log`.

Not done by the operator: browser login and an authenticated deep-link refresh. The agent never types credentials; HC or the owner checks this on the next sign-in.

## Not changed

No production data was edited by hand and no account, invitation or notification was created. The only rows written are the migrations' own: the `THR` component and DRAFT `THR` policy version (0164) and the permission grants (0151, 0160, 0163). Every new feature switch stays off.
