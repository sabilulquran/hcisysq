// OPS-PILOT-TT-001 dry-run against production. ONE transaction, ALWAYS rolled back.
// Reads the running release's compiled code; prints names/codes only (no NIP, email, env values).
//
// Evidence: docs/operations/pilot-tt-readiness-evidence-2026-11-26.md §3–§4.
// Inside the transaction it temporarily inserts a STRUCTURE rollout row for the Taman Tahfizh node
// and marks the three pilot accounts active, so the resolver can show the full chain; the final
// ROLLBACK discards both, and the before/after counts are compared from a second connection.
// Run on the device as the HCIS service user, with DATABASE_URL and
// ANNUAL_LEAVE_SEMESTER_QUOTA_EFFECTIVE_FROM taken from the running API process, and
// REL_DIR=/srv/hcis/releases/<release>/apps/api. Never during the 19 UTC backup hour.
import { createRequire } from "node:module";

const REL = process.env.REL_DIR; // /srv/hcis/releases/hcis-<sha8>-<date>/apps/api
const require = createRequire(`${REL}/package.json`);
const { Pool, Client } = require("pg");
const dist = (p) => import(`file://${REL}/dist/${p}`);

const { validateAnnualLeaveRequest } = await dist("modules/leave/domain/annual-leave-request.js");
const { calculateWorkingDays, decodeWorkingWeekdays } = await dist("modules/leave/domain/working-calendar.js");
const { buildAnnualPreview, jakartaToday } = await dist("modules/leave/employee-routes.js");
const { resolveLeaveAuthorities } = await dist("modules/leave/organization-authority.js");
const { leaveWorkflowKey } = await dist("modules/organization/workflow-keys.js");
const { annualLeaveSemesterQuotaEffectiveFrom } = await dist("config/env.js");

const effectiveFrom = annualLeaveSemesterQuotaEffectiveFrom({
  ANNUAL_LEAVE_SEMESTER_QUOTA_EFFECTIVE_FROM: process.env.ANNUAL_LEAVE_SEMESTER_QUOTA_EFFECTIVE_FROM,
});
const today = jakartaToday();
const out = (...a) => console.log(...a);
out(`today=${today} semesterEffectiveFrom=${effectiveFrom}`);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();
const counts = async (c) => (await c.query(`SELECT
  (SELECT count(*) FROM organization_rollout_settings)::int AS rollout,
  (SELECT count(*) FROM accounts WHERE status='active')::int AS active_accounts,
  (SELECT count(*) FROM accounts WHERE status='invited')::int AS invited_accounts,
  (SELECT count(*) FROM leave_requests)::int AS leave_requests,
  (SELECT count(*) FROM account_activation_invitations)::int AS invitations,
  (SELECT count(*) FROM employees WHERE leave_entitlement_group IS NULL AND status='active')::int AS unclassified`)).rows[0];

const ctxSql = `SELECT e.id, e.employee_number AS "employeeNumber", e.full_name AS "fullName", e.status,
  e.started_on::text AS "startedOn", e.leave_entitlement_group AS "leaveEntitlementGroup",
  u.id AS "unitId", u.name AS "unitName", NULL::text AS "positionName",
  e.direct_manager_employee_id AS "directManagerEmployeeId",
  u.leave_approver_employee_id AS "unitApproverEmployeeId",
  a.id AS "accountId", a.status AS "accountStatus"
  FROM employees e
  LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
  LEFT JOIN accounts a ON a.employee_id = e.id AND a.principal_type = 'EMPLOYEE'
  WHERE e.full_name ILIKE $1 AND e.status = 'active' AND e.removed_at IS NULL`;
const person = async (pattern) => {
  const r = await client.query(ctxSql, [pattern]);
  if (r.rows.length !== 1) throw new Error(`expected 1 active row for ${pattern}, got ${r.rows.length}`);
  return r.rows[0];
};

// Counts come from a separate session, never from the one that holds the dry-run transaction.
const observe = async () => {
  const other = new Client({ connectionString: process.env.DATABASE_URL });
  await other.connect();
  try {
    const pid = (await other.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    return { pid, ...(await counts(other)) };
  } finally { await other.end(); }
};
const dryRunPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
const { pid: observerBefore, ...before } = await observe();
if (observerBefore === dryRunPid) throw new Error("observer shares the dry-run session");
out("before", JSON.stringify(before));

try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '2s'");
  await client.query("SET LOCAL statement_timeout = '20s'");
  // A stalled or suspended process must not keep the pilot accounts' rows locked.
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");

  // ---------- A. quota rule with the production calendar ----------
  const cal = async (s, e) => {
    const m = (await client.query("SELECT working_weekday_mask AS m FROM leave_calendar_settings WHERE singleton = true")).rows[0]?.m;
    const ex = (await client.query(
      `SELECT calendar_date::text AS date, is_working_day AS "isWorkingDay" FROM leave_calendar_exceptions
       WHERE calendar_date BETWEEN $1::date AND $2::date ORDER BY 1`, [s, e])).rows;
    return { workingWeekdays: decodeWorkingWeekdays(m), exceptions: ex };
  };
  const quota = async (label, s, e, used = {}) => {
    const days = calculateWorkingDays(s, e, await cal(s, e)).workingDays;
    try {
      const v = validateAnnualLeaveRequest({
        entitlementGroup: "non_education", employmentStartedOn: "2021-07-01", submittedOn: today,
        leaveStartOn: s, leaveEndOn: e, requestedWorkingDays: days, usedDaysByQuarter: used,
        semesterEffectiveFrom: effectiveFrom,
      });
      out(`QUOTA ${label}: ${s}..${e} ${days}hk -> DITERIMA ${v.quotaScheme} ${v.periodKey} batas=${v.periodLimitDays} terpakai=${v.usedDaysBeforeRequest} sisa_sesudah=${v.availableDaysAfterRequest}`);
    } catch (err) {
      out(`QUOTA ${label}: ${s}..${e} ${days}hk -> DITOLAK ${err.code ?? err.name}: ${err.message}`);
    }
  };
  await quota("A1 Des 2026, 3 hk", "2026-12-07", "2026-12-09");
  await quota("A2 Des 2026, 4 hk", "2026-12-07", "2026-12-10");
  await quota("A3 Des 2026 sisa triwulan 1", "2026-12-14", "2026-12-15", { OCT_DEC: 2 });
  await quota("A4 lintas tahun mulai Des", "2026-12-28", "2027-01-05");
  await quota("A5 Jan 2027, 6 hk", "2027-01-04", "2027-01-11");
  await quota("A6 Jan 2027, 7 hk", "2027-01-04", "2027-01-12");
  await quota("A7 Mar-Apr 2027 satu semester, 6 hk", "2027-03-29", "2027-04-05");
  for (const r of (await client.query(
    `SELECT extract(year FROM calendar_date)::int AS y, count(*)::int AS n,
            count(*) FILTER (WHERE NOT is_working_day)::int AS libur
     FROM leave_calendar_exceptions GROUP BY 1 ORDER BY 1`)).rows) out(`CALENDAR ${r.y}: ${r.n} pengecualian, ${r.libur} libur`);
  await quota("A8 30 Jun-1 Jul 2027", "2027-06-29", "2027-07-02");
  await quota("A9 semester terpakai 4, minta 3", "2027-05-03", "2027-05-05", { JAN_MAR: 4 });
  await quota("A10 semester terpakai 4, minta 2", "2027-05-03", "2027-05-04", { JAN_MAR: 4 });
  await quota("A11 tahun terpakai 12", "2027-12-06", "2027-12-06", { JAN_MAR: 3, APR_JUN: 3, JUL_SEP: 6 });

  // ---------- B. routing from the published structure ----------
  const ros = await person("Rosaliana%");
  const pip = await person("Pipit Fithriyah%");
  const muc = await person("Muchsalmina%");
  const guru = await person("Ida Parida%");
  out(`people: Rosaliana acct=${ros.accountStatus} grp=${ros.leaveEntitlementGroup ?? "kosong"}; Pipit acct=${pip.accountStatus}; Muchsalmina acct=${muc.accountStatus}`);

  const resolve = async (label, emp) => {
    await client.query("SAVEPOINT r");
    try {
      const r = await resolveLeaveAuthorities(client, {
        workflowKey: leaveWorkflowKey("annual"), requesterEmployeeId: emp.id, effectiveDate: today,
        legacy: { directManagerEmployeeId: emp.directManagerEmployeeId, unitApproverEmployeeId: emp.unitApproverEmployeeId },
        policyChain: "LINE_AND_UNIT", allowAccountPrincipal: true,
      });
      const names = [];
      for (const s of r.approvalChain) {
        names.push(s.employeeId ? (await client.query("SELECT full_name FROM employees WHERE id=$1", [s.employeeId])).rows[0].full_name : "akun");
      }
      out(`ROUTE ${label}: sumber=${r.context?.authoritativeSource ?? JSON.stringify(r.context).slice(0, 120)} rantai=${names.join(" -> ")}`);
    } catch (err) {
      out(`ROUTE ${label}: DITOLAK ${err.code ?? err.name}: ${err.message}`);
    }
    await client.query("ROLLBACK TO SAVEPOINT r");
  };

  await resolve("B1 Rosaliana, tanpa baris rollout (LEGACY)", ros);

  const latest = (await client.query(
    `SELECT id, name, effective_on::text AS eff FROM organization_change_sets
     WHERE status = 'PUBLISHED' AND effective_on <= $1::date
     ORDER BY effective_on DESC, published_at DESC LIMIT 1`, [today])).rows[0];
  const nodes = (await client.query(
    `SELECT stable_key, name FROM organization_nodes
     WHERE change_set_id = $1 AND name ILIKE 'Taman Tahfizh%' AND active`, [latest.id])).rows;
  if (nodes.length !== 1) throw new Error(`expected exactly one Taman Tahfizh node, got ${nodes.length}`);
  const node = { ...nodes[0], cs: latest.name, eff: latest.eff };
  out(`node: ${node.name} dari bagan terbit "${node.cs}" (berlaku ${node.eff})`);
  const actor = (await client.query(
    "SELECT id FROM accounts WHERE status='active' AND principal_type <> 'EMPLOYEE' ORDER BY created_at LIMIT 1")).rows[0]
    ?? (await client.query("SELECT id FROM accounts WHERE status='active' ORDER BY created_at LIMIT 1")).rows[0];
  await client.query(
    `INSERT INTO organization_rollout_settings (id, workflow_key, node_key, mode, effective_from, reason, changed_by_account_id)
     VALUES (gen_random_uuid(), 'leave.annual', $1, 'STRUCTURE', $2::date, 'DRY-RUN OPS-PILOT-TT-001 (rolled back)', $3)`,
    [node.stable_key, today, actor.id]);

  await resolve("B2 Rosaliana, STRUCTURE, akun penyetuju masih invited", ros);

  await client.query(
    "UPDATE accounts SET status='active' WHERE id = ANY($1::uuid[])",
    [[ros.accountId, pip.accountId, muc.accountId]]);
  await resolve("B3 Rosaliana (Tata Usaha), STRUCTURE, akun aktif", ros);
  await resolve("B4 Pipit (kepala unit) sebagai pemohon", pip);
  await resolve("B5 Ida Parida (Guru) — pendakian dari node Guru", guru);
  const otherId = (await client.query(
    `SELECT e.id FROM employees e JOIN organizational_units u ON u.id = e.organizational_unit_id
     WHERE e.status='active' AND e.removed_at IS NULL AND u.name NOT ILIKE 'Taman Tahfizh%'
       AND u.name NOT ILIKE 'Bidang Pendidikan%' ORDER BY e.id LIMIT 1`)).rows[0].id;
  const other = (await client.query(ctxSql.replace("e.full_name ILIKE $1", "e.id = $1"), [otherId])).rows[0];
  // Not named in the output: this person has nothing to do with the pilot.
  await resolve("B6 satu pegawai unit lain — harus tetap LEGACY", other);

  // ---------- C. the whole preview Rosaliana would see (quota + chain together) ----------
  for (const [s, e] of [["2026-12-07", "2026-12-09"], ["2027-01-04", "2027-01-11"]]) {
    await client.query("SAVEPOINT p");
    try {
      const p = await buildAnnualPreview(client, { ...ros, leaveEntitlementGroup: "non_education" },
        { startOn: s, endOn: e }, today, { semesterEffectiveFrom: effectiveFrom });
      out(`PREVIEW Rosaliana ${s}..${e}: ${p.calculation.workingDays}hk ${p.validation.quotaScheme} ${p.validation.periodKey} batas=${p.validation.periodLimitDays} rantai=${p.approvalChain.map((x) => x.name).join(" -> ")}`);
    } catch (err) {
      out(`PREVIEW Rosaliana ${s}..${e}: DITOLAK ${err.code ?? err.name}: ${err.message}`);
    }
    await client.query("ROLLBACK TO SAVEPOINT p");
  }
} finally {
  try {
    await client.query("ROLLBACK");
    out("ROLLBACK done");
  } finally {
    client.release();
  }
}
await pool.end();
const { pid: observerAfter, ...after } = await observe();
out(`observer sessions ${observerBefore}/${observerAfter}, dry-run session ${dryRunPid}`);
out("after ", JSON.stringify(after));
out(JSON.stringify(before) === JSON.stringify(after) ? "UNCHANGED: production identik sebelum dan sesudah" : "WARNING: counts differ");
