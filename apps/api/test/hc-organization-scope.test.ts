import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { hasAttendanceResolutionPermission } from "../src/modules/leave/attendance-resolution-routes.js";
import { hasActivePermission } from "../src/modules/leave/planned-leave-routes.js";
import { hasHcValidationPermission } from "../src/modules/leave/special-leave-routes.js";

const accountId = "00000000-0000-4000-8000-000000000101";

function result<T>(rows: T[]) {
  return {
    rows,
    rowCount: rows.length,
    command: "SELECT",
    oid: 0,
    fields: [],
  };
}

function capabilityPool(scope: "unit" | "organization", active = true) {
  const query = vi.fn(async (sql: string) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    expect(normalized).toContain("assignment.scope_type = 'organization'");
    expect(normalized).toContain("assignment.starts_on IS NULL OR assignment.starts_on <= current_date");
    expect(normalized).toContain("assignment.ends_on IS NULL OR assignment.ends_on >= current_date");
    return result([{ allowed: scope === "organization" && active }]);
  });

  return { query, pool: { query } as unknown as Pool };
}

describe("organization-scoped Human Capital capability", () => {
  it("does not grant global HC capabilities to a unit-scoped assignment", async () => {
    const special = capabilityPool("unit");
    const attendance = capabilityPool("unit");
    const planned = capabilityPool("unit");

    await expect(hasHcValidationPermission(special.pool, accountId)).resolves.toBe(false);
    await expect(hasAttendanceResolutionPermission(attendance.pool, accountId)).resolves.toBe(false);
    await expect(hasActivePermission(planned.pool, accountId, "leave.validate")).resolves.toBe(false);
  });

  it("grants global HC capabilities to an active organization-scoped assignment", async () => {
    const special = capabilityPool("organization");
    const attendance = capabilityPool("organization");
    const planned = capabilityPool("organization");

    await expect(hasHcValidationPermission(special.pool, accountId)).resolves.toBe(true);
    await expect(hasAttendanceResolutionPermission(attendance.pool, accountId)).resolves.toBe(true);
    await expect(hasActivePermission(planned.pool, accountId, "leave.validate")).resolves.toBe(true);
  });

  it("does not grant an expired organization-scoped assignment", async () => {
    const special = capabilityPool("organization", false);

    await expect(hasHcValidationPermission(special.pool, accountId)).resolves.toBe(false);
  });
});
