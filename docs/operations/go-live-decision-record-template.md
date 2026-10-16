# HCIS go-live decision record — template

**Spec ID:** OPS-GOLIVE-001
**Status:** TEMPLATE (copy to `docs/operations/go-live-decision-<scope>-<yyyy-mm-dd>.md` and fill in; one record per decision)
**Prepared:** 2026-10-16
**Used for:** the *Pilot ready* "human go/no-go decision before STRUCTURE activation/deployment changes" and the *Production ready* "broader production go-live/cutover is approved by the authorized operational owner" (`docs/product/scope.md`).

Rules: use role names or pseudonyms where a record leaves the owner's hands; no credentials, no personal data, no screenshots of real employee data. A field left `TBD` blocks GO.

---

## 1. Decision

| Field | Value |
|---|---|
| Decision ID | `GOLIVE-<scope>-<yyyy-mm-dd>` |
| Scope | ☐ One-unit pilot (ORG-004 STRUCTURE canary) ☐ Broader activation ☐ Full legacy cutover ☐ Other: … |
| Units / population in scope | (unit codes, number of people — no names) |
| Window | start … / end or review date … (WIB) |
| Application release | `hcis-<sha8>-<yyyymmdd>`, SHA `…` (from the running process `cwd`, OPS-MI8-REL-001) |
| Decision | ☐ GO ☐ GO with conditions ☐ NO-GO |
| Decided by (authorized operational owner) | role + name |
| Date/time and channel of the decision | … (quote the approval sentence) |

## 2. Owners (must all be named)

| Responsibility | Primary | Backup | How to reach (channel, not personal number in Git) |
|---|---|---|---|
| Authorized operational owner (final GO / NO-GO) | | | |
| **Stop owner** — may stop the pilot/cutover at any time, without further approval | | | |
| **Rollback owner** — approves and triggers rollback (application, ORG-004 routing, data) | | | |
| Operator — runs release/rollback/restore commands on Mi8VPS | | | |
| Observability / health watch | | | |
| Incident owner — opens, coordinates and closes incidents | | | |
| Human Capital owner — data correctness, user communication | | | |
| Security / access reviewer | | | |
| Attendance device owner (only if devices are in scope) | | | |

## 3. Gate evidence (link each item; every mandatory item must be PASS)

| Gate | Mandatory for | Evidence link | Result |
|---|---|---|---|
| Pilot unit + participants selected, data-use boundary written | Pilot | `org004-pilot-unit-validation.md` form (outside Git for real names) | |
| Manager/approver/acting/role/calendar validated | Pilot | | |
| LEGACY baseline + SHADOW comparison, zero unexplained mismatch | Pilot | | |
| Positive/negative access UAT executed (`docs/testing/hcis-pilot-uat.md`) | Pilot | | |
| Isolated restore drill PASS (`hcis-isolated-restore-drill.md`) | Pilot + Production | | |
| Daily backup + off-host copy + weekly restore check green in the last 7 days (OPS-MI8-BAK-001) | Pilot + Production | | |
| Security review: no open Critical/High (`hcis-security-review-2026-10-16.md` or newer) | Production (High may be accepted for pilot with owner sign-off) | | |
| Biometric collection OFF (or separate approval linked) | Pilot + Production | | |
| Password recovery / notification: required, or manual fallback accepted | Pilot | | |
| Legacy migration rehearsal reconciles (MIG-002) | Full cutover | | |
| Legacy freeze/read-only plan approved | Full cutover | | |
| RPO and RTO decided by the owner | Production | RPO: … RTO: … | |

## 4. Monitoring during the window

| Signal | Where / how | Who watches | Frequency | Threshold that triggers STOP |
|---|---|---|---|---|
| HCIS API/web health | `https://hcis.sabilulquran.or.id/api/health`, `/login` | | e.g. every 30 min in working hours | 2 consecutive failures, or > 15 min down |
| Worker restarts | `grep 'launch service=hcis' /data/local/mi8vps/sq-core-worker.log` | | daily | > 3 unplanned restarts/day |
| Keycloak (login) health | `login.sabilulquran.or.id` 302 / worker log | | daily | users cannot log in > 15 min |
| Backup / off-host / restore check | `grep -E 'scheduled (backup|off-host)|restore check' sq-core-worker.log` | | daily | any `FAILED` |
| Authorization anomalies | pilot user reports; audit tables for privileged changes | | daily | any cross-employee data exposure or wrong approver |
| Approval routing | SHADOW/STRUCTURE comparison for pilot requests | HC | per request | any unexplained routing |
| Device ingress (if in scope) | ADMS admin last-seen | | daily | device silent > 1 working day |

No alerting channel exists yet (OPS-MI8-BAK-001 §8); record here who checks manually and when.

## 5. Stop conditions (any one → stop owner stops; no discussion needed first)

- Cross-employee or cross-unit data exposure, or privilege obtained without an explicit grant.
- Wrong approver resolved for a real request, or a submitted approval snapshot changes.
- Data integrity concern (missing/duplicated records, failed reconciliation).
- Production down beyond the agreed tolerance, or repeated critical errors.
- Backup or restore check failing and not fixed within 24 h.
- Any unapproved device/biometric action.

## 6. Rollback plan (filled in before GO)

| Layer | Trigger | Action | Approver | Expected duration |
|---|---|---|---|---|
| Application release | failed verify / regression | `scripts/mi8/release-mi8.sh rollback …` (OPS-MI8-REL-001) | Rollback owner | ≈ 1 min + 10 min watch |
| ORG-004 routing | wrong/unexplained routing | future-effective `LEGACY` rollout setting for the pilot scope; submitted snapshots untouched | Rollback owner + HC | |
| Data | corruption / bad migration | restore per OPS-MI8-BAK-001 §7 into a **new** DB, then switch; never restore over live | Owner | measured in drill: … |
| Legacy cutover | go/no-go #2 fails | MIG-002 §6 rollback (re-open legacy writes) | Owner | |

## 7. Communication

| When | Audience | Message owner | Channel |
|---|---|---|---|
| Before window | pilot users / all staff | HC | |
| On STOP / rollback | same | HC + incident owner | |
| On close | owner + HC | operator | |

## 8. Close-out

| Field | Value |
|---|---|
| Outcome | ☐ Completed ☐ Stopped ☐ Rolled back |
| Incidents (IDs, no personal data) | |
| Follow-ups | |
| Closed by / date | |
