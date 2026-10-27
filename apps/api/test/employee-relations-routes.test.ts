// EMP-009 / EMP-003 P2-3 routes: who may read and write, what the domain
// refuses, the move that closes the previous address inside the transaction,
// and the audit rows that must carry no family data at all. Fake pool;
// synthetic records only.
//
// The period rules themselves belong to the database (exclusion constraints),
// so they are proved in employee-relations-records.integration.test.ts. What
// this file proves is the route: the refusals, the order of statements, and
// what the audit payload is allowed to contain.

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerEmployeeRelationsRoutes } from "../src/modules/employees/employee-relations-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://employee-relations-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "33".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000001";
const FAMILY_ID = "50000000-0000-4000-8000-000000000001";
const ADDRESS_ID = "50000000-0000-4000-8000-000000000002";

type Persona = "anonymous" | "employee" | "reader" | "hc";

const PERMISSIONS: Record<Persona, string[]> = {
  anonymous: [],
  employee: [],
  reader: ["employees.read.all"],
  hc: ["employees.read.all", "employees.manage"],
};

const FAMILY_ROW = {
  id: FAMILY_ID,
  employeeId: EMPLOYEE_ID,
  relation: "PASANGAN",
  fullName: "Nama Sintetis",
  birthDate: "1990-05-04",
  gender: "P",
  isDependent: true,
  dependentOrder: null,
  isEmergencyContact: true,
  emergencyPhone: "0800000000",
  emergencyPriority: 1,
  validFrom: "2015-06-01",
  validTo: null,
  notes: null,
  voidedAt: null,
  voidedReason: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
};

const ADDRESS_ROW = {
  id: ADDRESS_ID,
  employeeId: EMPLOYEE_ID,
  kind: "DOMISILI",
  addressLine: "Jalan Sintetis 1",
  village: null,
  district: null,
  city: "Bandung",
  province: "Jawa Barat",
  postalCode: "40111",
  validFrom: "2020-01-01",
  validTo: null,
  source: "HC",
  notes: null,
  voidedAt: null,
  voidedReason: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
};

const FAMILY_BODY = {
  relation: "PASANGAN",
  fullName: "Nama Sintetis",
  birthDate: "1990-05-04",
  gender: "P",
  isDependent: true,
  isEmergencyContact: true,
  emergencyPhone: "0800000000",
  emergencyPriority: 1,
  validFrom: "2015-06-01",
};

const ADDRESS_BODY = {
  kind: "DOMISILI",
  addressLine: "Jalan Sintetis 2",
  city: "Bandung",
  province: "Jawa Barat",
  postalCode: "40112",
  validFrom: "2026-11-01",
};

interface PoolOptions {
  employeeMissing?: boolean;
  recordMissing?: boolean;
  recordVoided?: boolean;
  ownerRemoved?: boolean;
  /** The employee is marked outside HCIS management (S2B §8.7). */
  ownerOutsideHcis?: boolean;
  /** The open address of the same kind, if any, that a move must close. */
  openAddress?: { id: string; validFrom: string; validTo: string | null } | null;
  /** The address rows a list returns, for the derived "in force" answer. */
  addressRows?: Array<Record<string, unknown>>;
  /**
   * The next write raises the named exclusion violation, as the database
   * would — constraint and all, because the route answers by its name.
   */
  periodConflict?: string;
  payload?: object;
}

interface AuditRow {
  action: string;
  payload: Record<string, unknown>;
}

function createPool(persona: Persona, options: PoolOptions = {}) {
  const writes: string[] = [];
  const audits: AuditRow[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM auth_sessions s")) {
      if (persona === "anonymous") return { rows: [], rowCount: 0 };
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000100",
          accountId: "00000000-0000-4000-8000-000000000001",
          email: "persona@example.org",
          principalType: "EMPLOYEE",
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) {
      const keys = PERMISSIONS[persona];
      return { rows: keys.map((permissionKey) => ({ permissionKey })), rowCount: keys.length };
    }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("management_scope = 'OUTSIDE_HCIS' AS outside")) {
      return { rows: [{ outside: options.ownerOutsideHcis === true }], rowCount: 1 };
    }
    if (/SELECT id FROM employees WHERE id = \$1/.test(sql)) {
      // employeeMissing stands for "removed from the master": the read, which
      // does not filter on removed_at, still finds the row.
      const hidden = options.employeeMissing && sql.includes("removed_at IS NULL");
      return hidden ? { rows: [], rowCount: 0 } : { rows: [{ id: EMPLOYEE_ID }], rowCount: 1 };
    }
    if (sql.includes("valid_to IS NULL") && sql.includes("FOR UPDATE")) {
      const open = options.openAddress ?? null;
      return open ? { rows: [open], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("FOR UPDATE OF r")) {
      if (options.recordMissing) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          employeeId: EMPLOYEE_ID,
          voidedAt: options.recordVoided ? new Date("2026-10-02T00:00:00Z") : null,
          employeeRemoved: options.ownerRemoved === true,
          employeeOutsideHcis: options.ownerOutsideHcis === true,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM employee_family_members")) return { rows: [FAMILY_ROW], rowCount: 1 };
    if (sql.includes("FROM employee_addresses")) {
      const rows = options.addressRows ?? [ADDRESS_ROW];
      return { rows, rowCount: rows.length };
    }
    function conflict() {
      throw Object.assign(new Error("exclusion violation"), { code: "23P01", constraint: options.periodConflict });
    }
    if (sql.includes("INSERT INTO employee_family_members")) {
      if (options.periodConflict) conflict();
      writes.push("INSERT family");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO employee_addresses")) {
      if (options.periodConflict) conflict();
      writes.push("INSERT address");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE employee_family_members SET relation")) {
      if (options.periodConflict) conflict();
      writes.push("UPDATE family");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE employee_addresses SET kind")) {
      if (options.periodConflict) conflict();
      writes.push("UPDATE address");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE employee_addresses SET valid_to")) { writes.push("CLOSE address"); return { rows: [], rowCount: 1 }; }
    if (/UPDATE employee_(family_members|addresses) SET voided_at/.test(sql)) { writes.push("VOID"); return { rows: [], rowCount: 1 }; }
    if (sql.includes("INSERT INTO employee_profile_audit_events")) {
      writes.push("INSERT audit");
      audits.push({ action: String(values?.[2]), payload: JSON.parse(String(values?.[6])) as Record<string, unknown> });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in employee relations routes test: ${sql}`);
  });
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, query, writes, audits };
}

async function call(persona: Persona, method: "GET" | "POST" | "PATCH", url: string, options: PoolOptions = {}) {
  const { pool, writes, audits, query } = createPool(persona, options);
  const app = Fastify({ logger: false });
  await registerEmployeeRelationsRoutes(app, pool, config);
  const response = await app.inject({
    method,
    url,
    headers: persona === "anonymous" ? {} : { cookie: "hcis_session=test-token" },
    ...(options.payload ? { payload: options.payload } : {}),
  });
  await app.close();
  return { response, writes, audits, query };
}

const READ_URLS = [
  `/admin/employees/${EMPLOYEE_ID}/family`,
  `/admin/employees/${EMPLOYEE_ID}/addresses`,
];

const WRITE_CALLS: Array<["POST" | "PATCH", string, object]> = [
  ["POST", `/admin/employees/${EMPLOYEE_ID}/family`, FAMILY_BODY],
  ["PATCH", `/admin/family-records/${FAMILY_ID}`, FAMILY_BODY],
  ["POST", `/admin/family-records/${FAMILY_ID}/void`, { reason: "Salah entri" }],
  ["POST", `/admin/employees/${EMPLOYEE_ID}/addresses`, ADDRESS_BODY],
  ["PATCH", `/admin/address-records/${ADDRESS_ID}`, ADDRESS_BODY],
  ["POST", `/admin/address-records/${ADDRESS_ID}/void`, { reason: "Salah entri" }],
];

describe("EMP-009 / EMP-003 authorization", () => {
  it.each(READ_URLS)("refuses anonymous and an employee without the permission on %s", async (url) => {
    expect((await call("anonymous", "GET", url)).response.statusCode).toBe(401);
    expect((await call("employee", "GET", url)).response.json()).toMatchObject({ code: "FORBIDDEN" });
  }, 20_000);

  it.each(WRITE_CALLS)("refuses %s %s without employees.manage", async (method, url, payload) => {
    const { response, writes } = await call("reader", method, url, { payload });
    expect(response.statusCode).toBe(403);
    expect(writes).toEqual([]);
  }, 20_000);
});

describe("EMP-009 family records", () => {
  it("lists them with the derived counts", async () => {
    const { response } = await call("reader", "GET", `/admin/employees/${EMPLOYEE_ID}/family`);
    expect(response.json()).toMatchObject({ dependents: 1, emergencyContacts: 1 });
  });

  it("records one, auditing the relation and the flags but never the name or the phone", async () => {
    const { response, writes, audits } = await call("hc", "POST", `/admin/employees/${EMPLOYEE_ID}/family`, {
      payload: FAMILY_BODY,
    });
    expect(response.statusCode).toBe(201);
    expect(writes).toEqual(["INSERT family", "INSERT audit"]);
    expect(audits[0]).toMatchObject({
      action: "employee.family.recorded",
      payload: { relation: "PASANGAN", isDependent: true, isEmergencyContact: true },
    });
    const serialised = JSON.stringify(audits[0].payload);
    expect(serialised).not.toContain("Nama Sintetis");
    expect(serialised).not.toContain("0800000000");
    expect(serialised).not.toContain("1990-05-04");
  });

  it("never accepts an identity number, it refuses the request", async () => {
    // Spec §8: the column stays empty until column encryption exists, so the
    // field must not be quietly dropped either.
    const { response, writes } = await call("hc", "POST", `/admin/employees/${EMPLOYEE_ID}/family`, {
      payload: { ...FAMILY_BODY, identityNumber: "3273010101900001" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "EMPLOYEE_RECORD_INVALID" });
    expect(writes).toEqual([]);
  });

  it("refuses a dependent with no birth date and an emergency contact with no phone", async () => {
    const dependent = await call("hc", "POST", `/admin/employees/${EMPLOYEE_ID}/family`, {
      payload: { ...FAMILY_BODY, birthDate: null },
    });
    expect(dependent.response.json()).toMatchObject({ field: "birthDate" });
    const emergency = await call("hc", "POST", `/admin/employees/${EMPLOYEE_ID}/family`, {
      payload: { ...FAMILY_BODY, isDependent: false, birthDate: null, emergencyPhone: null },
    });
    expect(emergency.response.json()).toMatchObject({ field: "emergencyPhone" });
    expect(dependent.writes).toEqual([]);
    expect(emergency.writes).toEqual([]);
  });

  it("names the rule the database refused, not one code for all of them", async () => {
    const spouse = await call("hc", "POST", `/admin/employees/${EMPLOYEE_ID}/family`, {
      payload: FAMILY_BODY, periodConflict: "employee_family_single_spouse_excl",
    });
    expect(spouse.response.statusCode).toBe(409);
    expect(spouse.response.json()).toMatchObject({ code: "FAMILY_SPOUSE_OVERLAP" });
    expect(spouse.writes).toEqual([]);

    // A second emergency contact at the same priority is a different rule, and
    // the operator has to be told which one they broke (spec §9).
    const priority = await call("hc", "POST", `/admin/employees/${EMPLOYEE_ID}/family`, {
      payload: FAMILY_BODY, periodConflict: "employee_family_emergency_priority_excl",
    });
    expect(priority.response.json()).toMatchObject({ code: "EMERGENCY_PRIORITY_TAKEN" });
  });

  it("answers an overlap on amendment with 409 too, not 500", async () => {
    const { response, writes } = await call("hc", "PATCH", `/admin/family-records/${FAMILY_ID}`, {
      payload: FAMILY_BODY, periodConflict: "employee_family_single_spouse_excl",
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "FAMILY_SPOUSE_OVERLAP" });
    expect(writes).toEqual([]);
  });

  it("amends one, auditing the field names rather than their values", async () => {
    const { response, writes, audits } = await call("hc", "PATCH", `/admin/family-records/${FAMILY_ID}`, {
      payload: { ...FAMILY_BODY, fullName: "Nama Lain" },
    });
    expect(response.statusCode).toBe(200);
    expect(writes).toEqual(["UPDATE family", "INSERT audit"]);
    expect(audits[0].payload).toMatchObject({ changedFields: ["fullName"] });
    expect(JSON.stringify(audits[0].payload)).not.toContain("Nama Lain");
  });
});

describe("EMP-003 addresses", () => {
  it("says which address of each kind is in force on the business date", async () => {
    const { response } = await call("reader", "GET", `/admin/employees/${EMPLOYEE_ID}/addresses`);
    expect(response.json().current).toMatchObject({ DOMISILI: ADDRESS_ID, KTP: null });
  });

  it("does not call an address current when it has not started or has ended", async () => {
    // Open-ended is not the same question as in force: one of these starts
    // next year, the other ended last year.
    const future = await call("reader", "GET", `/admin/employees/${EMPLOYEE_ID}/addresses`, {
      addressRows: [{ ...ADDRESS_ROW, validFrom: "2099-01-01" }],
    });
    expect(future.response.json().current.DOMISILI).toBeNull();

    const ended = await call("reader", "GET", `/admin/employees/${EMPLOYEE_ID}/addresses`, {
      addressRows: [{ ...ADDRESS_ROW, validTo: "2020-12-31" }],
    });
    expect(ended.response.json().current.DOMISILI).toBeNull();
  });

  it("does not close the standing address for a record that already has an end date", async () => {
    // Filling in a past period must not leave the employee with no address
    // once that period runs out; the ranges do not overlap, so the database
    // would not catch it either.
    const { writes, response } = await call("hc", "POST", `/admin/employees/${EMPLOYEE_ID}/addresses`, {
      payload: { ...ADDRESS_BODY, validFrom: "2015-01-01", validTo: "2016-12-31" },
      openAddress: { id: ADDRESS_ID, validFrom: "2020-01-01", validTo: null },
    });
    expect(writes).toEqual(["INSERT address", "INSERT audit"]);
    expect(response.json().closedAddressId).toBeNull();
  });

  it("closes the open address of the same kind the day before the new one starts", async () => {
    const { response, writes, audits, query } = await call("hc", "POST", `/admin/employees/${EMPLOYEE_ID}/addresses`, {
      payload: ADDRESS_BODY,
      openAddress: { id: ADDRESS_ID, validFrom: "2020-01-01", validTo: null },
    });
    expect(response.statusCode).toBe(201);
    expect(writes).toEqual(["CLOSE address", "INSERT address", "INSERT audit"]);
    expect(response.json().closedAddressId).toBe(ADDRESS_ID);
    const closing = query.mock.calls.find(([sql]) => String(sql).includes("SET valid_to"));
    // 2026-11-01 starts, so the previous address ends on 2026-10-31.
    expect(closing?.[1]).toEqual([ADDRESS_ID, "2026-10-31"]);
    expect(audits[0]).toMatchObject({
      action: "employee.address.recorded",
      payload: { kind: "DOMISILI", closedAddressId: ADDRESS_ID },
    });
    expect(JSON.stringify(audits[0].payload)).not.toContain("Jalan Sintetis");
  });

  it("opens the first address of a kind without closing anything", async () => {
    const { writes, response } = await call("hc", "POST", `/admin/employees/${EMPLOYEE_ID}/addresses`, {
      payload: ADDRESS_BODY, openAddress: null,
    });
    expect(response.statusCode).toBe(201);
    expect(writes).toEqual(["INSERT address", "INSERT audit"]);
    expect(response.json().closedAddressId).toBeNull();
  });

  it("refuses a move that would have to close an address starting later", async () => {
    const { response, writes } = await call("hc", "POST", `/admin/employees/${EMPLOYEE_ID}/addresses`, {
      payload: ADDRESS_BODY,
      openAddress: { id: ADDRESS_ID, validFrom: "2027-01-01", validTo: null },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "ADDRESS_PERIOD_OVERLAP" });
    expect(writes).toEqual([]);
  });

  it("answers an overlapping amendment with the address code", async () => {
    const { response, writes } = await call("hc", "PATCH", `/admin/address-records/${ADDRESS_ID}`, {
      payload: ADDRESS_BODY, periodConflict: "employee_addresses_single_current_excl",
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "ADDRESS_PERIOD_OVERLAP" });
    expect(writes).toEqual([]);
  });

  it("locks the open address before deciding to close it", async () => {
    const { query } = await call("hc", "POST", `/admin/employees/${EMPLOYEE_ID}/addresses`, {
      payload: ADDRESS_BODY,
      openAddress: { id: ADDRESS_ID, validFrom: "2020-01-01", validTo: null },
    });
    const order = query.mock.calls.map(([sql]) => String(sql));
    const begin = order.findIndex((sql) => /^\s*BEGIN/.test(sql));
    const lock = order.findIndex((sql) => sql.includes("valid_to IS NULL") && sql.includes("FOR UPDATE"));
    const close = order.findIndex((sql) => sql.includes("SET valid_to"));
    expect(lock).toBeGreaterThan(begin);
    expect(close).toBeGreaterThan(lock);
  });

  it("refuses a postal code that is not five digits", async () => {
    const { response, writes } = await call("hc", "POST", `/admin/employees/${EMPLOYEE_ID}/addresses`, {
      payload: { ...ADDRESS_BODY, postalCode: "401" },
    });
    expect(response.json()).toMatchObject({ field: "postalCode" });
    expect(writes).toEqual([]);
  });
});

describe("EMP-009 / EMP-003 refusals", () => {
  it("refuses an unknown record with 404 and a voided one with 409", async () => {
    const missing = await call("hc", "PATCH", `/admin/address-records/${ADDRESS_ID}`, {
      payload: ADDRESS_BODY, recordMissing: true,
    });
    expect(missing.response.json()).toMatchObject({ code: "EMPLOYEE_RECORD_NOT_FOUND" });
    expect(missing.writes).toEqual([]);

    const voided = await call("hc", "POST", `/admin/family-records/${FAMILY_ID}/void`, {
      payload: { reason: "Salah entri" }, recordVoided: true,
    });
    expect(voided.response.statusCode).toBe(409);
    expect(voided.writes).toEqual([]);
  });

  it("refuses to touch a record of an employee removed from the master", async () => {
    const amend = await call("hc", "PATCH", `/admin/family-records/${FAMILY_ID}`, {
      payload: FAMILY_BODY, ownerRemoved: true,
    });
    expect(amend.response.statusCode).toBe(404);
    expect(amend.response.json()).toMatchObject({ code: "EMPLOYEE_NOT_FOUND" });
    expect(amend.writes).toEqual([]);
  });

  it("voids a record with a reason and refuses one without, auditing only its length", async () => {
    const ok = await call("hc", "POST", `/admin/address-records/${ADDRESS_ID}/void`, {
      payload: { reason: "Alamat ganda dari impor" },
    });
    expect(ok.response.json()).toMatchObject({ voided: true });
    expect(ok.writes).toEqual(["VOID", "INSERT audit"]);
    expect(ok.audits[0]).toMatchObject({ action: "employee.address.voided", payload: { reasonLength: 23 } });
    expect(JSON.stringify(ok.audits[0].payload)).not.toContain("Alamat ganda");

    const bad = await call("hc", "POST", `/admin/address-records/${ADDRESS_ID}/void`, { payload: { reason: "x" } });
    expect(bad.response.statusCode).toBe(400);
    expect(bad.writes).toEqual([]);
  });

  it("still reads the history of an employee removed from the master", async () => {
    // D-14: removed is read-only, not invisible. Writing is refused by the
    // lock on the record, which the case above proves.
    const family = await call("reader", "GET", `/admin/employees/${EMPLOYEE_ID}/family`, { employeeMissing: true });
    expect(family.response.statusCode).toBe(200);
    const addresses = await call("reader", "GET", `/admin/employees/${EMPLOYEE_ID}/addresses`, { employeeMissing: true });
    expect(addresses.response.statusCode).toBe(200);
  });

  it("refuses an unknown employee before touching anything", async () => {
    const { response, writes } = await call("hc", "POST", `/admin/employees/${EMPLOYEE_ID}/family`, {
      payload: FAMILY_BODY, employeeMissing: true,
    });
    expect(response.json()).toMatchObject({ code: "EMPLOYEE_NOT_FOUND" });
    expect(writes).toEqual([]);
  });
});
