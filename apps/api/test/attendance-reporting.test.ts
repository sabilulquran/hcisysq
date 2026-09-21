import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { buildAttendanceReport } from "../src/modules/attendance/reporting.js";

function poolWithEmptyQuery() {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  return { pool: { query } as unknown as Pool, query };
}

describe("ATT-009 attendance report filters", () => {
  it("applies operational filters to session reports", async () => {
    const { pool, query } = poolWithEmptyQuery();
    await buildAttendanceReport(pool, {
      type: "sessions",
      from: "2026-09-01",
      to: "2026-09-07",
      employeeId: "00000000-0000-4000-8000-000000000001",
      unitId: "00000000-0000-4000-8000-000000000002",
      scheduleId: "00000000-0000-4000-8000-000000000003",
      locationId: "00000000-0000-4000-8000-000000000004",
      source: "adms",
      deviceId: "00000000-0000-4000-8000-000000000005",
    });

    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("employee.organizational_unit_id");
    expect(sql).toContain("result.schedule_template_id");
    expect(sql).toContain("schedule_version.work_location_id");
    expect(sql).toContain("event.source");
    expect(sql).toContain("deviceId");
    expect(values).toEqual([
      "2026-09-01",
      "2026-09-07",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000004",
      "adms",
      "00000000-0000-4000-8000-000000000005",
    ]);
  });

  it("applies unit, source, and device filters to scan reports", async () => {
    const { pool, query } = poolWithEmptyQuery();
    await buildAttendanceReport(pool, {
      type: "scans",
      from: "2026-09-01",
      to: "2026-09-07",
      unitId: "00000000-0000-4000-8000-000000000002",
      source: "mobile",
      deviceId: "00000000-0000-4000-8000-000000000005",
    });

    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("employee.organizational_unit_id");
    expect(sql).toContain("event.source");
    expect(sql).toContain("deviceId");
    expect(values).toEqual([
      "2026-09-01",
      "2026-09-07",
      "00000000-0000-4000-8000-000000000002",
      "mobile",
      "00000000-0000-4000-8000-000000000005",
    ]);
  });

  it("applies unit filter to overtime reports", async () => {
    const { pool, query } = poolWithEmptyQuery();
    await buildAttendanceReport(pool, {
      type: "overtime",
      from: "2026-09-01",
      to: "2026-09-07",
      unitId: "00000000-0000-4000-8000-000000000002",
    });

    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("employee.organizational_unit_id");
    expect(values).toEqual([
      "2026-09-01",
      "2026-09-07",
      "00000000-0000-4000-8000-000000000002",
    ]);
  });
});
