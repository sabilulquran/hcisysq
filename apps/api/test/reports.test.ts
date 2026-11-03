// RPT-001 rules that need no database: scope arithmetic, period, file building, and the route
// order of checks (authorization before validation, scope inside the WHERE before LIMIT, the
// export limit before any audit). docs/domain/hr-reports.md.

import Fastify from "fastify";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import {
  EXPORT_ROW_LIMIT,
  HR_REPORTS,
  intersectScopes,
  isCalendarDate,
  periodError,
  REPORT_DEFINITIONS,
  reportCsv,
  sameScope,
  scopeFromAssignments,
  SENSITIVE_COLUMN_KEYS,
} from "../src/modules/reports/domain.js";
import { buildReportQuery, registerReportRoutes } from "../src/modules/reports/routes.js";

const UNIT_A = "00000000-0000-4000-8000-00000000000a";
const UNIT_B = "00000000-0000-4000-8000-00000000000b";

describe("RPT-001 domain", () => {
  it("D-02: organization wins; units are a sorted union", () => {
    expect(scopeFromAssignments([{ scopeType: "unit", unitId: UNIT_B }, { scopeType: "unit", unitId: UNIT_A }, { scopeType: "unit", unitId: UNIT_A }]))
      .toEqual({ organization: false, unitIds: [UNIT_A, UNIT_B] });
    expect(scopeFromAssignments([{ scopeType: "unit", unitId: UNIT_A }, { scopeType: "organization", unitId: null }]))
      .toEqual({ organization: true, unitIds: [] });
    expect(scopeFromAssignments([{ scopeType: "own", unitId: null }])).toEqual({ organization: false, unitIds: [] });
  });

  it("§4: an export scope is the intersection with the read scope", () => {
    const org = { organization: true, unitIds: [] };
    const a = { organization: false, unitIds: [UNIT_A] };
    const ab = { organization: false, unitIds: [UNIT_A, UNIT_B] };
    expect(intersectScopes(org, a)).toEqual(a);
    expect(intersectScopes(ab, org)).toEqual(ab);
    expect(intersectScopes(a, { organization: false, unitIds: [UNIT_B] })).toEqual({ organization: false, unitIds: [] });
    expect(intersectScopes(ab, a)).toEqual(a);
    expect(sameScope(org, org)).toBe(true);
    expect(sameScope(org, a)).toBe(false);
    expect(sameScope(ab, { organization: false, unitIds: [UNIT_B, UNIT_A] })).toBe(true);
    expect(sameScope(ab, a)).toBe(false);
  });

  it("D-10: periods are inclusive and at most 366 days", () => {
    expect(periodError("2026-01-01", "2026-12-31")).toBeNull();
    expect(periodError("2024-01-01", "2024-12-31")).toBeNull(); // 366 days in a leap year
    expect(periodError("2025-01-01", "2026-01-01")).toBeNull();
    expect(periodError("2025-01-01", "2026-01-02")).toBe("PERIOD_TOO_LONG");
    expect(periodError("2026-02-02", "2026-02-01")).toBe("PERIOD_REVERSED");
    expect(periodError(undefined, "2026-02-01")).toBe("PERIOD_REQUIRED");
    expect(periodError("2026-02-01", "2026-02-30")).toBe("PERIOD_REQUIRED");
    expect(isCalendarDate("2024-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false);
  });

  it("D-04: no report defines a sensitive column", () => {
    for (const report of HR_REPORTS) {
      for (const column of REPORT_DEFINITIONS[report].columns) {
        expect(SENSITIVE_COLUMN_KEYS as readonly string[], `${report}.${column.key}`).not.toContain(column.key);
        // "Cuti Tanpa Gaji" names a leave type, not a salary figure.
        expect(column.label).not.toMatch(/\bNIK\b|rekening|alamat|nominal|telepon|email|rupiah|\bRp\b/i);
      }
    }
  });

  it("§5.2: CSV has a BOM, quotes every cell and neutralises formulas", () => {
    const csv = reportCsv([{ key: "a", label: "Nama", kind: "text" }, { key: "b", label: "Jam", kind: "number" }],
      [{ a: '=HYPERLINK("x")', b: 1.5 }, { a: "Siti, \"Ustadzah\"", b: null }]);
    expect(csv).toBe('\uFEFF"Nama","Jam"\r\n"\'=HYPERLINK(""x"")","1.5"\r\n"Siti, ""Ustadzah""",""\r\n');
  });

  it("ENG-LIST-001: the scope predicate is in the WHERE of every report query, and the count wraps it", () => {
    for (const report of HR_REPORTS) {
      const query = buildReportQuery(report, { status: "active", from: "2026-10-01", to: "2026-10-31" },
        { organization: false, unitIds: [UNIT_A] });
      expect(query.sql, report).toMatch(/WHERE[\s\S]*employee\.organizational_unit_id = ANY\(\$\d+::uuid\[\]\)/);
      expect(query.sql, report).not.toMatch(/LIMIT/);
      expect(query.values).toContainEqual([UNIT_A]);
      expect(query.values).toContain(false);
    }
  });
});

// ---------------------------------------------------------------------------------- routes

interface FakeState {
  scopes: Record<string, Array<{ scopeType: string; unitId: string | null }>>;
  total: number;
  rows: Array<Record<string, unknown>>;
  audits: unknown[][];
  statements: string[];
}

function fakePool(state: FakeState): Pool {
  const query = async (text: string, values: unknown[] = []) => {
    state.statements.push(text);
    if (text.includes("FROM account_role_assignments")) return { rows: state.scopes[values[1] as string] ?? [] };
    if (text.startsWith("SELECT count(*)::int AS total FROM (")) return { rows: [{ total: state.total }] };
    if (/LIMIT \$\d+ OFFSET \$\d+$/.test(text)) {
      const [limit, offset] = values.slice(-2) as [number, number];
      return { rows: state.rows.slice(offset, offset + limit) };
    }
    if (text.includes("INSERT INTO access_audit_events")) { state.audits.push(values); return { rows: [] }; }
    if (text.includes("FROM organizational_units")) return { rows: [{ id: UNIT_A, name: "Unit A" }] };
    return { rows: [] };
  };
  return { query, connect: async () => ({ query, release: () => {} }) } as unknown as Pool;
}

describe("RPT-001 routes", () => {
  let state: FakeState;
  let principal: AuthPrincipal | null;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    state = { scopes: {}, total: 0, rows: [], audits: [], statements: [] };
    principal = { id: "00000000-0000-4000-8000-000000000001", email: "pimpinan@example.invalid", principalType: "EMPLOYEE" };
    const auth = { getSession: async () => (principal ? { principal, expiresAt: "2099-01-01T00:00:00Z" } : null) } as never;
    app = Fastify({ logger: false });
    await registerReportRoutes(app, fakePool(state), { AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig, auth);
  });

  const get = (url: string) => app.inject({ method: "GET", url });

  it("401 without a session, 403 before any validation without a report role", async () => {
    principal = null;
    expect((await get("/admin/reports/hr/employees")).statusCode).toBe(401);
    principal = { id: "00000000-0000-4000-8000-000000000001", email: "x@example.invalid", principalType: "EMPLOYEE" };
    for (const url of ["/admin/reports/hr/not-a-report?pageSize=9999", "/admin/reports/hr/x/export?q=1", "/admin/reports/hr/access"]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(403);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    // Only the scope lookup ran; no report data was read.
    expect(state.statements.every((text) => text.includes("FROM account_role_assignments"))).toBe(true);
  });

  it("a unit-scoped reader's page query carries its unit before LIMIT", async () => {
    state.scopes["reports.read.organization"] = [{ scopeType: "unit", unitId: UNIT_A }];
    state.total = 1;
    state.rows = [{ rowId: "r1", employeeNumber: "1", fullName: "A", unitName: "Unit A", status: "active" }];
    const response = await get("/admin/reports/hr/employees");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items).toEqual([{ rowId: "r1", employeeNumber: "1", fullName: "A", unitName: "Unit A", statusLabel: "Aktif" }]);
    expect(response.json().pagination).toEqual({ page: 1, pageSize: 25, total: 1, pageCount: 1 });
    expect((await get(`/admin/reports/hr/employees?unitId=${UNIT_B}`)).json().code).toBe("REPORT_SCOPE_FORBIDDEN");
  });

  it("D-11: an export above the limit is refused with 422, unaudited and unread", async () => {
    state.scopes["reports.read.organization"] = [{ scopeType: "organization", unitId: null }];
    state.scopes["reports.export.organization"] = [{ scopeType: "organization", unitId: null }];
    state.total = EXPORT_ROW_LIMIT + 1;
    const response = await get("/admin/reports/hr/employees/export?format=csv");
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("EXPORT_TOO_LARGE");
    expect(state.audits).toHaveLength(0);
    expect(state.statements.some((text) => /LIMIT \$\d+ OFFSET/.test(text))).toBe(false);
  });

  it("D-11: an export reads every row in batches of 1,000 and audits the full count", async () => {
    state.scopes["reports.read.organization"] = [{ scopeType: "organization", unitId: null }];
    state.scopes["reports.export.organization"] = [{ scopeType: "organization", unitId: null }];
    state.total = 2500;
    state.rows = Array.from({ length: 2500 }, (_, index) => ({ rowId: String(index), employeeNumber: `N${index}`, fullName: "X", unitName: null, status: "active" }));
    const response = await get("/admin/reports/hr/employees/export?format=csv&status=all");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body.trim().split("\r\n")).toHaveLength(2501);
    expect(state.statements.filter((text) => /LIMIT \$\d+ OFFSET/.test(text))).toHaveLength(3);
    expect(state.statements).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    expect(state.audits).toHaveLength(1);
    expect(JSON.parse(state.audits[0]![2] as string)).toEqual({
      report: "employees", format: "csv", filters: { unitId: null, status: "all", employmentType: null },
      scope: "organization", unitCount: null, rows: 2500,
    });
  });

  it("§4: an export narrower than the read scope needs a unit", async () => {
    state.scopes["reports.read.organization"] = [{ scopeType: "organization", unitId: null }];
    state.scopes["reports.export.organization"] = [{ scopeType: "unit", unitId: UNIT_A }];
    const response = await get("/admin/reports/hr/employees/export?format=csv");
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("REPORT_EXPORT_UNIT_REQUIRED");
    expect(state.audits).toHaveLength(0);
  });

  it("a read-only role cannot export; an unknown format or free-text search is 400", async () => {
    state.scopes["reports.read.organization"] = [{ scopeType: "organization", unitId: null }];
    expect((await get("/admin/reports/hr/employees/export?format=csv")).statusCode).toBe(403);
    state.scopes["reports.export.organization"] = [{ scopeType: "organization", unitId: null }];
    expect((await get("/admin/reports/hr/employees/export?format=pdf")).statusCode).toBe(400);
    expect((await get("/admin/reports/hr/employees/export?format=csv&q=Siti")).statusCode).toBe(400);
    expect(state.audits).toHaveLength(0);
  });
});
