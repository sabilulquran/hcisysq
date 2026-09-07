import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal, AuthSessionResult } from "../src/modules/auth/service.js";
import {
  hasPayslipCapability,
  parsePayslipCsv,
  registerPayslipRoutes,
} from "../src/modules/payslips/routes.js";

const config: ApiConfig = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://synthetic.invalid/hcis",
  AUTH_ENCRYPTION_KEY: "a".repeat(64),
  AUTH_SESSION_TTL_HOURS: 8,
};

const employeeId = "10000000-0000-4000-8000-000000000001";
const payslipId = "20000000-0000-4000-8000-000000000002";
const batchId = "30000000-0000-4000-8000-000000000003";

const employeePrincipal: AuthPrincipal = {
  id: "40000000-0000-4000-8000-000000000004",
  email: "employee@example.invalid",
  principalType: "EMPLOYEE",
};
const adminPrincipal: AuthPrincipal = {
  id: "50000000-0000-4000-8000-000000000005",
  email: "admin@example.invalid",
  principalType: "SUPER_ADMIN",
};

function session(principal: AuthPrincipal): AuthSessionResult {
  return { principal, expiresAt: new Date(Date.now() + 60_000).toISOString() };
}

function auth(principal: AuthPrincipal) {
  return { getSession: vi.fn(async () => session(principal)) };
}

function result(rows: unknown[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function compactSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

function csvPayload(rows: string[]) {
  return Buffer.from(`employee_number,period,lines_json\n${rows.join("\n")}\n`);
}

function createTestApp() {
  const app = Fastify();
  app.addContentTypeParser(
    "text/csv",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  return app;
}

function syntheticClient(query: ReturnType<typeof vi.fn>) {
  return {
    query,
    release: vi.fn(),
  };
}

describe("payslip import contract", () => {
  it("parses opaque imported lines without deriving payroll values", () => {
    const csv = Buffer.from(
      'employee_number,period,lines_json\nSYN-001,2026-08,"[{""label"":""Imported A"",""value"":""synthetic-value""}]"\n',
    );
    const rows = parsePayslipCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.errors).toEqual([]);
    expect(rows[0]?.period).toBe("2026-08-01");
    expect(rows[0]?.lines).toEqual([{ label: "Imported A", value: "synthetic-value" }]);
  });

  it("rejects business-shape assumptions outside the generic line contract", () => {
    const csv = Buffer.from("employee_number,period,net_salary\nSYN-001,2026-08,100\n");
    expect(() => parsePayslipCsv(csv)).toThrow(/header CSV wajib/i);
  });
});

describe("payslip capability scope", () => {
  function capabilityPool(scope: "organization" | "unit" | "own", active: boolean) {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      const normalized = compactSql(sql);
      expect(values).toEqual([employeePrincipal.id, "payslips.import"]);
      expect(normalized).toContain("assignment.scope_type = 'organization'");
      expect(normalized).toContain("assignment.starts_on IS NULL OR assignment.starts_on <= current_date");
      expect(normalized).toContain("assignment.ends_on IS NULL OR assignment.ends_on >= current_date");
      return scope === "organization" && active ? result([{ allowed: true }]) : result([]);
    });
    return { pool: { query } as unknown as Pool, query };
  }

  it("allows an active organization-scoped permission", async () => {
    const { pool } = capabilityPool("organization", true);
    await expect(hasPayslipCapability(pool, employeePrincipal, "payslips.import")).resolves.toBe(true);
  });

  it.each(["unit", "own"] as const)("denies the same permission with %s scope", async (scope) => {
    const { pool } = capabilityPool(scope, true);
    await expect(hasPayslipCapability(pool, employeePrincipal, "payslips.import")).resolves.toBe(false);
  });

  it("denies an expired organization assignment", async () => {
    const { pool } = capabilityPool("organization", false);
    await expect(hasPayslipCapability(pool, employeePrincipal, "payslips.import")).resolves.toBe(false);
  });

  it("never grants Foundation Board operational payslip capability", async () => {
    const pool = { query: vi.fn() } as unknown as Pool;
    await expect(
      hasPayslipCapability(
        pool,
        {
          id: "60000000-0000-4000-8000-000000000006",
          email: "board@example.invalid",
          principalType: "FOUNDATION_BOARD",
        },
        "payslips.publish",
      ),
    ).resolves.toBe(false);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("grants Super Admin system-admin capability without making it employee self", async () => {
    const pool = { query: vi.fn() } as unknown as Pool;
    await expect(hasPayslipCapability(pool, adminPrincipal, "payslips.import")).resolves.toBe(true);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe("payslip endpoint authorization", () => {
  it("serializes preview periods without a timezone month shift", async () => {
    const query = vi.fn(async (sql: string) => {
      const normalized = compactSql(sql);
      if (normalized.includes("FROM payslip_import_batches")) {
        return result([
          {
            id: batchId,
            sourceFilename: "synthetic.csv",
            status: "previewed",
            rowCount: 1,
            validCount: 1,
            errorCount: 0,
          },
        ]);
      }
      if (normalized.includes("FROM payslip_import_rows")) {
        expect(normalized).toContain("to_char(period, 'YYYY-MM') AS period");
        return result([
          {
            rowNumber: 2,
            employeeNumber: "SYN-001",
            period: "2026-07",
            lines: [{ label: "Synthetic", value: "opaque" }],
            errors: [],
          },
        ]);
      }
      if (normalized.startsWith("INSERT INTO payslip_audit_events")) return result([]);
      throw new Error(`Unexpected query in synthetic test: ${normalized}`);
    });
    const app = Fastify();
    await registerPayslipRoutes(app, { query } as unknown as Pool, config, auth(adminPrincipal));
    const response = await app.inject({
      method: "GET",
      url: `/admin/payslip-imports/${batchId}`,
      headers: { cookie: "hcis_session=synthetic" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().rows[0]?.period).toBe("2026-07");
    await app.close();
  });

  it("rejects Foundation Board from import endpoints server-side", async () => {
    const app = Fastify();
    const pool = { query: vi.fn() } as unknown as Pool;
    await registerPayslipRoutes(
      app,
      pool,
      config,
      auth({
        id: "60000000-0000-4000-8000-000000000006",
        email: "board@example.invalid",
        principalType: "FOUNDATION_BOARD",
      }),
    );
    const response = await app.inject({
      method: "GET",
      url: "/admin/payslip-imports",
      headers: { cookie: "hcis_session=synthetic" },
    });
    expect(response.statusCode).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not treat Super Admin as an employee self principal", async () => {
    const app = Fastify();
    const pool = { query: vi.fn() } as unknown as Pool;
    await registerPayslipRoutes(app, pool, config, auth(adminPrincipal));
    const response = await app.inject({
      method: "GET",
      url: "/payslips",
      headers: { cookie: "hcis_session=synthetic" },
    });
    expect(response.statusCode).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
    await app.close();
  });

  it("employee A cannot read employee B payslip even with its UUID", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      const normalized = compactSql(sql);
      if (normalized.includes("FROM accounts account JOIN employees employee")) {
        expect(values).toEqual([employeePrincipal.id]);
        return result([{ employeeId }]);
      }
      if (normalized.includes("FROM payslips") && normalized.includes("WHERE id = $1")) {
        expect(values).toEqual([payslipId, employeeId]);
        return result([]);
      }
      throw new Error(`Unexpected query in synthetic test: ${normalized}`);
    });
    const app = Fastify();
    await registerPayslipRoutes(app, { query } as unknown as Pool, config, auth(employeePrincipal));
    const response = await app.inject({
      method: "GET",
      url: `/payslips/${payslipId}`,
      headers: { cookie: "hcis_session=synthetic" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it.each(["inactive", "resigned"])(
    "rejects an active account linked to a %s employee",
    async () => {
      const query = vi.fn(async (sql: string, values?: unknown[]) => {
        const normalized = compactSql(sql);
        expect(normalized).toContain("JOIN employees employee ON employee.id = account.employee_id");
        expect(normalized).toContain("account.status = 'active'");
        expect(normalized).toContain("employee.status = 'active'");
        expect(values).toEqual([employeePrincipal.id]);
        return result([]);
      });
      const app = Fastify();
      await registerPayslipRoutes(app, { query } as unknown as Pool, config, auth(employeePrincipal));
      const response = await app.inject({
        method: "GET",
        url: "/payslips",
        headers: { cookie: "hcis_session=synthetic" },
      });
      expect(response.statusCode).toBe(403);
      expect(query).toHaveBeenCalledTimes(1);
      await app.close();
    },
  );

  it("has no employee mutation route", async () => {
    const app = Fastify();
    const pool = { query: vi.fn() } as unknown as Pool;
    await registerPayslipRoutes(app, pool, config, auth(employeePrincipal));
    const response = await app.inject({
      method: "PATCH",
      url: `/payslips/${payslipId}`,
      headers: { cookie: "hcis_session=synthetic" },
      payload: { value: "must-not-exist" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe("payslip transaction boundaries", () => {
  it("persists preview rows and audit on one connected client", async () => {
    const poolQuery = vi.fn(async (sql: string, values?: unknown[]) => {
      const normalized = compactSql(sql);
      expect(normalized).toContain("FROM employees");
      expect(values).toEqual([["SYN-001"]]);
      return result([{ id: employeeId, employeeNumber: "SYN-001" }]);
    });
    const clientQuery = vi.fn(async () => result());
    const client = syntheticClient(clientQuery);
    const connect = vi.fn(async () => client);
    const pool = { query: poolQuery, connect } as unknown as Pool;
    const app = createTestApp();
    await registerPayslipRoutes(app, pool, config, auth(adminPrincipal));

    const response = await app.inject({
      method: "POST",
      url: "/admin/payslip-imports/preview",
      headers: {
        cookie: "hcis_session=synthetic",
        "content-type": "text/csv",
        "x-file-name": "synthetic-payslip.csv",
      },
      payload: csvPayload([
        'SYN-001,2026-08,"[{""label"":""Imported"",""value"":""opaque""}]"',
      ]),
    });

    expect(response.statusCode).toBe(201);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
    const statements = clientQuery.mock.calls.map(([sql]) => compactSql(String(sql)));
    expect(statements[0]).toBe("BEGIN");
    expect(statements).toContain("COMMIT");
    expect(statements.some((sql) => sql.startsWith("INSERT INTO payslip_import_batches"))).toBe(true);
    expect(statements.some((sql) => sql.startsWith("INSERT INTO payslip_import_rows"))).toBe(true);
    expect(statements.some((sql) => sql.startsWith("INSERT INTO payslip_audit_events"))).toBe(true);
    expect(statements).not.toContain("ROLLBACK");
    expect(poolQuery).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("rolls back preview persistence when a row insert fails", async () => {
    const poolQuery = vi.fn(async () =>
      result([{ id: employeeId, employeeNumber: "SYN-001" }]),
    );
    let rowInsertCount = 0;
    const clientQuery = vi.fn(async (sql: string) => {
      const normalized = compactSql(sql);
      if (normalized.startsWith("INSERT INTO payslip_import_rows")) {
        rowInsertCount += 1;
        if (rowInsertCount === 2) throw new Error("synthetic row persistence failure");
      }
      return result();
    });
    const client = syntheticClient(clientQuery);
    const pool = {
      query: poolQuery,
      connect: vi.fn(async () => client),
    } as unknown as Pool;
    const app = createTestApp();
    await registerPayslipRoutes(app, pool, config, auth(adminPrincipal));

    const response = await app.inject({
      method: "POST",
      url: "/admin/payslip-imports/preview",
      headers: {
        cookie: "hcis_session=synthetic",
        "content-type": "text/csv",
        "x-file-name": "synthetic-payslip.csv",
      },
      payload: csvPayload([
        'SYN-001,2026-08,"[{""label"":""A"",""value"":""one""}]"',
        'SYN-001,2026-09,"[{""label"":""B"",""value"":""two""}]"',
      ]),
    });

    expect(response.statusCode).toBe(500);
    const statements = clientQuery.mock.calls.map(([sql]) => compactSql(String(sql)));
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(statements.some((sql) => sql.startsWith("INSERT INTO payslip_audit_events"))).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("uses one connected client for commit lock, inserts, state update, audit, and commit", async () => {
    const poolQuery = vi.fn();
    const clientQuery = vi.fn(async (sql: string) => {
      const normalized = compactSql(sql);
      if (normalized.includes("FROM payslip_import_batches") && normalized.includes("FOR UPDATE")) {
        return result([{ status: "previewed", errorCount: 0 }]);
      }
      if (normalized.includes("FROM payslip_import_rows") && normalized.includes("validation_errors")) {
        return result([
          {
            employeeId,
            period: "2026-08-01",
            lines: [{ label: "Imported", value: "opaque" }],
          },
        ]);
      }
      if (normalized.startsWith("SELECT 1 FROM payslips payslip")) return result([]);
      return result();
    });
    const client = syntheticClient(clientQuery);
    const connect = vi.fn(async () => client);
    const pool = { query: poolQuery, connect } as unknown as Pool;
    const app = Fastify();
    await registerPayslipRoutes(app, pool, config, auth(adminPrincipal));

    const response = await app.inject({
      method: "POST",
      url: `/admin/payslip-imports/${batchId}/commit`,
      headers: { cookie: "hcis_session=synthetic" },
    });

    expect(response.statusCode).toBe(200);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
    const statements = clientQuery.mock.calls.map(([sql]) => compactSql(String(sql)));
    expect(statements[0]).toBe("BEGIN");
    expect(statements.some((sql) => sql.includes("FOR UPDATE"))).toBe(true);
    expect(statements.some((sql) => sql.startsWith("INSERT INTO payslips"))).toBe(true);
    expect(statements.some((sql) => sql.startsWith("UPDATE payslip_import_batches"))).toBe(true);
    expect(statements.some((sql) => sql.startsWith("INSERT INTO payslip_audit_events"))).toBe(true);
    expect(statements.at(-1)).toBe("COMMIT");
    await app.close();
  });

  it("rolls back a partially inserted commit and never marks the batch committed", async () => {
    let payslipInsertCount = 0;
    const clientQuery = vi.fn(async (sql: string) => {
      const normalized = compactSql(sql);
      if (normalized.includes("FROM payslip_import_batches") && normalized.includes("FOR UPDATE")) {
        return result([{ status: "previewed", errorCount: 0 }]);
      }
      if (normalized.includes("FROM payslip_import_rows") && normalized.includes("validation_errors")) {
        return result([
          { employeeId, period: "2026-08-01", lines: [{ label: "A", value: "one" }] },
          {
            employeeId: "10000000-0000-4000-8000-000000000009",
            period: "2026-08-01",
            lines: [{ label: "B", value: "two" }],
          },
        ]);
      }
      if (normalized.startsWith("SELECT 1 FROM payslips payslip")) return result([]);
      if (normalized.startsWith("INSERT INTO payslips")) {
        payslipInsertCount += 1;
        if (payslipInsertCount === 2) throw new Error("synthetic second insert failure");
      }
      return result();
    });
    const client = syntheticClient(clientQuery);
    const pool = {
      query: vi.fn(),
      connect: vi.fn(async () => client),
    } as unknown as Pool;
    const app = Fastify();
    await registerPayslipRoutes(app, pool, config, auth(adminPrincipal));

    const response = await app.inject({
      method: "POST",
      url: `/admin/payslip-imports/${batchId}/commit`,
      headers: { cookie: "hcis_session=synthetic" },
    });

    expect(response.statusCode).toBe(500);
    const statements = clientQuery.mock.calls.map(([sql]) => compactSql(String(sql)));
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(statements.some((sql) => sql.startsWith("UPDATE payslip_import_batches"))).toBe(false);
    expect(statements.some((sql) => sql.startsWith("INSERT INTO payslip_audit_events"))).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("rolls back payslip publication if the batch publish state update fails", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      const normalized = compactSql(sql);
      if (normalized.startsWith("SELECT status FROM payslip_import_batches")) {
        return result([{ status: "committed" }]);
      }
      if (normalized.startsWith("UPDATE payslips")) return result([{ id: payslipId }]);
      if (normalized.startsWith("UPDATE payslip_import_batches")) {
        throw new Error("synthetic batch publish update failure");
      }
      return result();
    });
    const client = syntheticClient(clientQuery);
    const poolQuery = vi.fn();
    const pool = {
      query: poolQuery,
      connect: vi.fn(async () => client),
    } as unknown as Pool;
    const app = Fastify();
    await registerPayslipRoutes(app, pool, config, auth(adminPrincipal));

    const response = await app.inject({
      method: "POST",
      url: `/admin/payslip-imports/${batchId}/publish`,
      headers: { cookie: "hcis_session=synthetic" },
    });

    expect(response.statusCode).toBe(500);
    expect(poolQuery).not.toHaveBeenCalled();
    const statements = clientQuery.mock.calls.map(([sql]) => compactSql(String(sql)));
    expect(statements[0]).toBe("BEGIN");
    expect(statements.some((sql) => sql.startsWith("UPDATE payslips"))).toBe(true);
    expect(statements.some((sql) => sql.startsWith("UPDATE payslip_import_batches"))).toBe(true);
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(statements.some((sql) => sql.startsWith("INSERT INTO payslip_audit_events"))).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
