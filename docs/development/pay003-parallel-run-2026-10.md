# PAY-003 parallel run — October 2026 (round 1)

**Date:** 2026-11-04. **Spec:** `docs/domain/payroll-calculation-v1.md` §9.2. **Release:** `hcis-27bc9aec-20261104` (released 09:51–09:54 WIB; pre-release backup `hcis-27bc9aec-20261104-20261104T025157Z.dump`).

Counts only; per-employee figures stay in the operator's scratch area and are never committed.

## Production data corrections before the run (owner decisions 2026-11-04)

| Step | Dry-run | Apply |
|---|---|---|
| `employment-baseline --reclassify KONTRAK_HONORER` for the 3 per-attendance (`Aktif PKWT`) contract staff | considered 3, `KONTRAK` → `KONTRAK_HONORER` 3 | reclassified 3 (audit `employment.baseline.reclassified`) |
| `payroll-initial-load` correction of `PERFORMANCE` (unrated staff under one year: monthly share 0, as in the legacy sheet) | `PERFORMANCE: CORRECT`, 0 errors | corrected (audit `payroll.policy.version_corrected`, previous payload kept) |

## How the run was done

October 2026 (cutoff 2026-09-23 … 2026-10-22) was created and calculated with the release's own period, attendance-input and calculation code inside one outer transaction that was rolled back. After the run `payroll_periods`, `payroll_results` and `payroll_period_inputs` were checked: 0 rows each. Legacy October child-education deductions and the 3 honorer staff's teaching hours/other income were fed as manual period inputs (12 rows). PAY-001/PAY-002 remain the official payslip path.

## Result

| Measure | Count |
|---|---|
| Legacy October employees | 104 |
| Compared (in both) | 97 |
| Exact match on every component | 70 |
| Only in legacy | 7 (5 hires of Aug–Oct 2026 not yet in HCIS, 2 others to check) |
| HCIS rows blocked `SERVICE_END_UNRESOLVED` + `PROFILE_MISSING` | 110 (former employees whose baseline end date is `UNKNOWN`) |

Differences among the 27 compared employees that did not match exactly:

| Cause | Employees | Components | Class |
|---|---|---|---|
| Kasbon balances not loaded yet (PAY-003-MIG step 2 waits for a finance account) | 19 | `LOAN` | Known gap in the data load, not a calculation difference |
| Overtime hours were entered in the legacy sheet; no approved overtime exists in HCIS for the window | 6 | `OVERTIME` | Input gap (ATT-011 overtime approval not in use yet) |
| Honorer transport: no attendance results for the 3 honorer staff in the window | 3 | `TRANSPORT` | Input gap (attendance data, see attendance readiness) |
| BPJS Kesehatan base | 3 | `BPJS_KES`, `BPJS_KES_ALLOW` (amounts below Rp30.000) | §9.2 intended change: BPJS base (D11) |
| Legacy "BPJS" deduction of an honorer, who has no BPJS in either system | 1 | `BPJS_KES` | Legacy sheet anomaly, owner/HC to check |
| Kepala HC's own profile not loaded (`OWN_RECORD`, needs another actor) | 1 | all | Known gap in the data load |
| Negative special-qualification amount | 1 | `SPECIAL_QUAL` (blocked) | Known: needs a salary adjustment input (PAY-003 §7) |

**Unexplained differences in the calculation itself: 0.** Basic salary, family, functional and positional allowances, performance and teaching-hours lines match for every compared salaried employee once the gaps above are excluded.

## Before round 2 (November 2026)

1. Load kasbon (needs an account holding `payroll.loans.manage`), the Kepala HC profile (another actor) and the 5 recent hires.
2. Resolve the 110 former employees with unknown end dates (HC enters end dates, or a baseline correction for staff already inactive in the master).
3. Record November overtime through HCIS (ATT-011) and calculate attendance before the cutoff, so overtime and honorer transport come from HCIS rather than the sheet.
