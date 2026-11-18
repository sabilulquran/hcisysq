// LOAN-002: the owner's kasbon chain end to end under ORG-004 `STRUCTURE`, against the real
// schema — approver unit, Kepala Keuangan, Direktur, Ketua Yayasan, Bendahara Yayasan, plus
// Pembina above the threshold. Synthetic rows only; every test runs inside one rolled-back
// transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { registerLoanRoutes } from "../src/modules/loans/routes.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

/** The routes own their transactions; BEGIN/COMMIT/ROLLBACK become savepoints of the test's. */
function savepointPool(client: PoolClient): Pool {
  let depth = 0;
  const run = async (text: string, values?: unknown[]) => {
    const statement = String(text).trim().toUpperCase();
    if (statement.startsWith("BEGIN")) return client.query(`SAVEPOINT seat_chain_${++depth}`);
    if (statement.startsWith("COMMIT")) {
      const name = `seat_chain_${depth}`;
      depth -= 1;
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (statement.startsWith("ROLLBACK")) {
      const name = `seat_chain_${depth}`;
      depth -= 1;
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    return client.query(text, values);
  };
  const handle = { query: run, release: () => {} };
  return { query: run, connect: async () => handle } as unknown as Pool;
}

const SEATS = ["KEPALA_KEUANGAN", "DIREKTUR", "KETUA_YAYASAN", "BENDAHARA_YAYASAN", "PEMBINA"] as const;
type Seat = (typeof SEATS)[number];
/** The three seats the owner's chain expects to be held by an organ account. */
const ACCOUNT_SEATS: readonly Seat[] = ["KETUA_YAYASAN", "BENDAHARA_YAYASAN", "PEMBINA"];

describe.skipIf(!allowed)("LOAN-002 seat chain under STRUCTURE (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let principal: AuthPrincipal;
  let permissions: string[];

  const employees = {} as Record<"requester" | "unitHead" | "finance", string>;
  const accounts = {} as Record<"requester" | "unitHead" | "finance", string>;
  /** The organ accounts holding the three account seats. */
  const organ = {} as Record<Seat, string>;
  const positions = {} as Record<Seat | "unitHead", string>;
  const nodeKey = randomUUID();
  let changeSet = "";
  let loanRoleId = "";

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  async function addEmployee(name: string, email: string | null) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on, email, management_scope)
       VALUES ($1,$2,$3,'active','2020-01-06',$4,'MANAGED')`,
      [id, `L002-${id.slice(0, 8)}`, name, email],
    );
    return id;
  }

  async function addAccount(employeeId: string | null, email: string, type = "EMPLOYEE") {
    const id = randomUUID();
    // ORG-013-1: an organ account without an Akun SQ identity is a CONFLICT for the resolver —
    // it cannot be told apart from an employee — so a seat it holds would never resolve.
    await client.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status, identity_issuer, identity_subject)
       VALUES ($1,$2,$3,$4,'active',$5,$6)`,
      [id, employeeId, email, type,
        type === "FOUNDATION_BOARD" ? "https://akun.example.invalid" : null,
        type === "FOUNDATION_BOARD" ? `subject-${id}` : null],
    );
    return id;
  }

  /** Gives an organ account the loan governance capability for the whole organisation. */
  async function grantLoanCapability(accountId: string) {
    await client.query(
      `INSERT INTO account_role_assignments(id, account_id, role_id, scope_type, ends_on, reason)
       VALUES ($1,$2,$3,'organization','2099-12-31','Synthetic SK LOAN-002')`,
      [randomUUID(), accountId, loanRoleId],
    );
  }

  async function mapSeat(seat: Seat, positionKey: string) {
    await client.query(
      `INSERT INTO organization_approval_seats (id, seat_key, position_key, seat_label, effective_from)
       VALUES ($1,$2,$3,$4,'2020-01-01'::date)`,
      [randomUUID(), seat, positionKey, `${seat} - sintetis`],
    );
  }

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");

    loanRoleId = (await client.query("SELECT id FROM roles WHERE role_key = 'governance_loan_approver'")).rows[0].id;

    for (const name of ["requester", "unitHead", "finance"] as const) {
      employees[name] = await addEmployee(`Synthetic ${name}`, `${name}-${randomUUID()}@example.invalid`);
      accounts[name] = await addAccount(employees[name], `acct-${randomUUID()}@example.invalid`);
    }
    for (const seat of ACCOUNT_SEATS) {
      organ[seat] = await addAccount(null, `organ-${seat.toLowerCase()}-${randomUUID()}@example.invalid`, "FOUNDATION_BOARD");
      await grantLoanCapability(organ[seat]);
    }

    // A published structure in force: the requester's unit, its unit approver seat, and the five
    // approval seats. Kepala Keuangan and Direktur are employee-held; the three organ seats are
    // account-held, as they are in the real foundation.
    changeSet = randomUUID();
    await client.query(
      `INSERT INTO organization_change_sets (id, name, effective_on, status, created_by_account_id, validated_at, published_at)
       VALUES ($1,'Struktur uji LOAN-002','2020-01-01'::date,'PUBLISHED',$2, now(), now())`,
      [changeSet, accounts.finance],
    );
    await client.query(
      `INSERT INTO organization_nodes (id, change_set_id, stable_key, name, node_type, parent_node_key, effective_from)
       VALUES ($1,$2,$3,'Unit Uji','UNIT',NULL,'2020-01-01')`,
      [randomUUID(), changeSet, nodeKey],
    );
    for (const key of ["unitHead", ...SEATS] as const) {
      positions[key] = randomUUID();
      const accountHeld = (ACCOUNT_SEATS as readonly string[]).includes(key);
      await client.query(
        `INSERT INTO organization_positions (id, change_set_id, stable_key, node_key, title, effective_from, holder_source, vacancy_policy)
         VALUES ($1,$2,$3,$4,$5,'2020-01-01',$6,'BLOCK')`,
        [randomUUID(), changeSet, positions[key], nodeKey, `Jabatan ${key}`,
          accountHeld ? "ACCOUNT" : "EMPLOYEE"],
      );
    }
    // Incumbents: the unit head, and one employee for each of the two employee-held seats.
    const financeSeatHolder = await addEmployee("Synthetic kakeu", `kakeu-${randomUUID()}@example.invalid`);
    await addAccount(financeSeatHolder, `kakeu-acct-${randomUUID()}@example.invalid`);
    const directorHolder = await addEmployee("Synthetic direktur", `direktur-${randomUUID()}@example.invalid`);
    await addAccount(directorHolder, `direktur-acct-${randomUUID()}@example.invalid`);
    for (const [positionKey, employeeId] of [
      [positions.unitHead, employees.unitHead],
      [positions.KEPALA_KEUANGAN, financeSeatHolder],
      [positions.DIREKTUR, directorHolder],
    ] as const) {
      await client.query(
        `INSERT INTO organization_incumbencies (id, change_set_id, position_key, employee_id, kind, effective_from)
         VALUES ($1,$2,$3,$4,'PRIMARY','2020-01-01')`,
        [randomUUID(), changeSet, positionKey, employeeId],
      );
    }
    for (const seat of ACCOUNT_SEATS) {
      await client.query(
        `INSERT INTO organization_incumbencies (id, change_set_id, position_key, employee_id, account_id, kind, effective_from)
         VALUES ($1,$2,$3,NULL,$4,'PRIMARY','2020-01-01')`,
        [randomUUID(), changeSet, positions[seat], organ[seat]],
      );
    }
    await client.query(
      `INSERT INTO organization_memberships (id, change_set_id, employee_id, node_key, is_primary, effective_from)
       VALUES ($1,$2,$3,$4,true,'2020-01-01')`,
      [randomUUID(), changeSet, employees.requester, nodeKey],
    );
    await client.query(
      `INSERT INTO organization_authority_bindings (id, change_set_id, subject_kind, subject_key, binding_type, target_position_key, vacancy_policy, effective_from)
       VALUES ($1,$2,'NODE',$3,'UNIT_APPROVER',$4,'BLOCK','2020-01-01')`,
      [randomUUID(), changeSet, nodeKey, positions.unitHead],
    );

    for (const seat of SEATS) await mapSeat(seat, positions[seat]);

    // ORG-004: LOAN on STRUCTURE. Without this row the mode is LEGACY and nothing below applies.
    await client.query(
      `INSERT INTO organization_rollout_settings (id, workflow_key, node_key, mode, effective_from, reason, changed_by_account_id)
       VALUES ($1,'LOAN',NULL,'STRUCTURE','2020-01-01','Uji LOAN-002',$2)`,
      [randomUUID(), accounts.finance],
    );

    app = Fastify({ logger: false });
    await registerLoanRoutes(
      app,
      savepointPool(client),
      { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32) } as ApiConfig,
      {
        getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
        getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
      } as never,
    );
  });

  afterEach(async () => {
    await app?.close();
    await client.query("ROLLBACK");
    client.release();
  });

  const actAs = (accountId: string, granted: string[] = [], type: AuthPrincipal["principalType"] = "EMPLOYEE") => {
    principal = { id: accountId, email: "actor@example.invalid", principalType: type };
    permissions = granted;
  };

  async function submit(amount: number) {
    actAs(accounts.requester);
    return app.inject({
      method: "POST",
      url: "/loans/me",
      payload: {
        principal: amount, tenorMonths: 3,
        purpose: "Biaya perbaikan rumah setelah hujan deras",
        idempotencyKey: randomUUID(),
      },
    });
  }

  const storedChain = async (loanId: string) => (await client.query<{ sources: string[]; employeeId: string | null; accountId: string | null }>(
    `SELECT sources, approver_employee_id AS "employeeId", approver_account_id AS "accountId"
       FROM employee_loan_approval_steps WHERE loan_id = $1 ORDER BY step_order`,
    [loanId],
  )).rows;

  it("builds the owner's six steps above the threshold, organ accounts included", async () => {
    const response = await submit(6_000_000);
    expect(response.statusCode, response.body).toBe(201);
    const chain = await storedChain(response.json().id);
    expect(chain.map((step) => step.sources)).toEqual([
      ["UNIT_APPROVER"], ["SEAT_KEPALA_KEUANGAN"], ["SEAT_DIREKTUR"],
      ["SEAT_KETUA_YAYASAN"], ["SEAT_BENDAHARA_YAYASAN"], ["SEAT_PEMBINA"],
    ]);
    expect(chain[0]!.employeeId).toBe(employees.unitHead);
    // The three organ seats are account principals, with no employee id at all (migration 0169).
    expect(chain.slice(3).map((step) => [step.employeeId, step.accountId])).toEqual([
      [null, organ.KETUA_YAYASAN], [null, organ.BENDAHARA_YAYASAN], [null, organ.PEMBINA],
    ]);
  });

  it("D-17: stops at Bendahara Yayasan at or below the threshold", async () => {
    const response = await submit(5_000_000);
    expect(response.statusCode, response.body).toBe(201);
    expect((await storedChain(response.json().id)).map((step) => step.sources[0]))
      .toEqual(["UNIT_APPROVER", "SEAT_KEPALA_KEUANGAN", "SEAT_DIREKTUR", "SEAT_KETUA_YAYASAN", "SEAT_BENDAHARA_YAYASAN"]);
  });

  it("M2 (D-20): the unit approver who is also Kepala Keuangan stays two steps, not one", async () => {
    // The likeliest case: a Staf Keuangan whose unit approver is the Kepala Keuangan. Merging would
    // turn five approvals into four with nothing saying so.
    await client.query(
      "UPDATE organization_incumbencies SET employee_id = $2 WHERE change_set_id = $1 AND position_key = $3",
      [changeSet, employees.unitHead, positions.KEPALA_KEUANGAN],
    );
    const response = await submit(1_000_000);
    expect(response.statusCode, response.body).toBe(201);
    const chain = await storedChain(response.json().id);
    expect(chain).toHaveLength(5);
    expect(chain.slice(0, 2)).toEqual([
      { sources: ["UNIT_APPROVER"], employeeId: employees.unitHead, accountId: null },
      { sources: ["SEAT_KEPALA_KEUANGAN"], employeeId: employees.unitHead, accountId: null },
    ]);
  });

  it("M1: a unit head's own request says so, instead of blaming the configuration", async () => {
    await client.query(
      `INSERT INTO organization_memberships (id, change_set_id, employee_id, node_key, is_primary, effective_from)
       VALUES ($1,$2,$3,$4,true,'2020-01-01')`,
      [randomUUID(), changeSet, employees.unitHead, nodeKey],
    );
    actAs(accounts.unitHead);
    const response = await app.inject({
      method: "POST", url: "/loans/me",
      payload: {
        principal: 1_000_000, tenorMonths: 3,
        purpose: "Biaya perbaikan rumah setelah hujan deras", idempotencyKey: randomUUID(),
      },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe("LOAN_UNIT_APPROVER_SELF");
    expect(response.json().message).not.toContain("belum dikonfigurasi");
  });

  it("M4 (D-19): a requester whose own organ account holds a seat cannot submit at all", async () => {
    // The organ account is the same person, matched by the e-mail rule of ORG-013-1 butir 5 — the
    // same rule `governanceActorIsRequester` applies at decision time. Submission must not pass:
    // if it did, the loan would jam, because that decision gate then refuses approve AND reject
    // and the request would sit in IN_REVIEW with nobody able to act.
    //
    // Two gates refuse it, deliberately. ORG-013-1 gets there first: an organ account whose
    // e-mail matches an active employee is a CONFLICT and the seat does not resolve at all. The
    // route repeats the check with the decision gate's own predicate, so the two cannot drift
    // apart. Either refusal is correct; what matters is that nothing is stored.
    const requesterEmail = (await client.query<{ email: string }>(
      "SELECT email FROM employees WHERE id = $1", [employees.requester],
    )).rows[0]!.email;
    await client.query("UPDATE accounts SET email = $2 WHERE id = $1", [organ.KETUA_YAYASAN, requesterEmail]);

    const response = await submit(1_000_000);
    expect(response.statusCode, response.body).toBe(409);
    expect(["LOAN_APPROVAL_SEAT_SELF", "LOAN_APPROVAL_SEAT_UNAVAILABLE"]).toContain(response.json().code);
    expect(response.json().message).toContain("Ketua Yayasan");
    // APR-001 all-or-nothing: nothing is stored.
    expect((await client.query("SELECT count(*)::int AS n FROM employee_loans WHERE employee_id = $1", [employees.requester]))
      .rows[0].n).toBe(0);
  });

  it("D-18: an unmapped seat refuses, names the seat, and stores nothing", async () => {
    // The registry is append-and-end only (migration 0168), so the mapping is ended rather than
    // deleted; ending it before it started means it never applied.
    await client.query(
      `UPDATE organization_approval_seats
          SET effective_to = DATE '2019-12-31', ended_at = now(), end_reason = 'Uji'
        WHERE seat_key = 'DIREKTUR'`,
    );
    const response = await submit(1_000_000);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe("LOAN_APPROVAL_SEAT_UNMAPPED");
    expect(response.json().message).toContain("Direktur");
    // Scoped to this requester: other suites share the database and a loan row is never deleted.
    expect((await client.query("SELECT count(*)::int AS n FROM employee_loans WHERE employee_id = $1", [employees.requester]))
      .rows[0].n).toBe(0);
  });

  it("D-18: a vacant seat refuses, names the seat, and never climbs", async () => {
    await client.query(
      "DELETE FROM organization_incumbencies WHERE change_set_id = $1 AND position_key = $2",
      [changeSet, positions.DIREKTUR],
    );
    const response = await submit(1_000_000);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe("LOAN_APPROVAL_SEAT_UNAVAILABLE");
    expect(response.json().message).toContain("Direktur");
  });

  it("ORG-013-1: an organ seat whose account lost the role is refused at submission", async () => {
    await client.query("DELETE FROM account_role_assignments WHERE account_id = $1", [organ.KETUA_YAYASAN]);
    const response = await submit(1_000_000);
    expect(response.statusCode, response.body).toBe(409);
    // Holding the seat is never the capability: the seat simply does not resolve.
    expect(["LOAN_APPROVAL_SEAT_UNAVAILABLE", "APPROVER_ACCOUNT_NOT_READY"]).toContain(response.json().code);
  });

  it("D-14 finding (e): the organ approver cannot disburse from their employee account either", async () => {
    const submitted = await submit(6_000_000);
    expect(submitted.statusCode, submitted.body).toBe(201);
    const loanId = submitted.json().id as string;
    await client.query(
      "UPDATE employee_loans SET status = 'APPROVED', final_decided_at = now() WHERE id = $1", [loanId],
    );
    await client.query("UPDATE employee_loan_approval_steps SET status = 'approved' WHERE loan_id = $1", [loanId]);

    // The Ketua Yayasan is also a salaried officer with loans.manage. Their seat step carries an
    // account id that is not this session's, and no employee id at all, so every id comparison
    // misses — only the person match catches it.
    const organEmail = (await client.query<{ email: string }>(
      "SELECT email FROM accounts WHERE id = $1", [organ.KETUA_YAYASAN],
    )).rows[0]!.email;
    // The person is matched through their employee record; `accounts.email` is unique, so the two
    // accounts of one person never carry the same address anyway — which is exactly why matching
    // ids alone was not enough.
    await client.query("UPDATE employees SET email = $2 WHERE id = $1", [employees.finance, organEmail]);

    actAs(accounts.finance, ["loans.read", "loans.manage"]);
    const disburse = await app.inject({
      method: "POST", url: `/admin/loans/${loanId}/disburse`,
      payload: { disbursedOn: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date()), method: "CASH" },
    });
    expect(disburse.statusCode, disburse.body).toBe(403);
    expect(disburse.json().code).toBe("LOAN_APPROVER_CANNOT_DISBURSE");
  });

  it("ORG-013-5: the organ account decides its own step, and nobody else's", async () => {
    const submitted = await submit(6_000_000);
    const loanId = submitted.json().id as string;
    const chain = await storedChain(loanId);
    const steps = (await client.query<{ id: string; order: number }>(
      `SELECT id, step_order AS "order" FROM employee_loan_approval_steps WHERE loan_id = $1 ORDER BY step_order`,
      [loanId],
    )).rows;
    expect(chain).toHaveLength(6);

    // Approve the three employee rungs so the Ketua Yayasan step becomes pending.
    for (const [index, account] of [[0, accounts.unitHead]] as const) {
      actAs(account);
      const response = await app.inject({
        method: "POST", url: `/loans/approvals/${steps[index]!.id}/decision`, payload: { decision: "approve" },
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    // The remaining employee rungs are approved directly so the test stays about the organ step.
    await client.query(
      `UPDATE employee_loan_approval_steps SET status = 'approved' WHERE id = ANY($1::uuid[])`,
      [[steps[1]!.id, steps[2]!.id]],
    );
    await client.query("UPDATE employee_loan_approval_steps SET status = 'pending' WHERE id = $1", [steps[3]!.id]);

    // A different organ account may not decide this step, even holding the capability.
    actAs(organ.BENDAHARA_YAYASAN, [], "FOUNDATION_BOARD");
    const wrongSeat = await app.inject({
      method: "POST", url: `/loans/approvals/${steps[3]!.id}/decision`, payload: { decision: "approve" },
    });
    expect(wrongSeat.statusCode, wrongSeat.body).toBe(403);
    expect(wrongSeat.json().code).toBe("APPROVAL_FORBIDDEN");

    actAs(organ.KETUA_YAYASAN, [], "FOUNDATION_BOARD");
    const decided = await app.inject({
      method: "POST", url: `/loans/approvals/${steps[3]!.id}/decision`, payload: { decision: "approve" },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json().nextPendingStepId).toBe(steps[4]!.id);
  });
});
