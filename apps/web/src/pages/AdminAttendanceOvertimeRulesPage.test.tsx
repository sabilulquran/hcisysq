import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OvertimeWarnings } from "@/components/attendance/OvertimeWarnings";
import { canAccessAdminPath } from "@/lib/authorization";
import { hoursLabel, ruleStateLabel } from "@/pages/AdminAttendanceOvertimeRulesPage";
import type { AuthSession } from "@/types/hcis";

// ATT-011-6b-3: Pengaturan > Aturan lembur and the non-blocking PP 35/2021 warning. Synthetic data only.

const session = (permissions: string[]) => ({
  principal: { id: "synthetic", email: "synthetic@example.invalid", principalType: "EMPLOYEE" },
  authorization: { organizationPermissions: permissions },
}) as unknown as AuthSession;

describe("ATT-011-6b-3 Aturan lembur", () => {
  it("opens only with attendance.policy.manage", () => {
    expect(canAccessAdminPath(session(["attendance.policy.manage"]), "/admin/attendance/settings/overtime-rules")).toBe(true);
    expect(canAccessAdminPath(session(["attendance.overtime.manage"]), "/admin/attendance/settings/overtime-rules")).toBe(false);
  });

  it("words thresholds in hours and rule periods in Indonesian, without backend terms", () => {
    expect(hoursLabel(240)).toBe("4 jam");
    expect(hoursLabel(90)).toBe("1,5 jam");
    expect(ruleStateLabel({ state: "active", effectiveFrom: "2026-11-11", effectiveTo: null })).toBe("Berlaku sejak 2026-11-11");
    expect(ruleStateLabel({ state: "scheduled", effectiveFrom: "2026-12-01", effectiveTo: null })).toBe("Berlaku mulai 2026-12-01");
    expect(ruleStateLabel({ state: "ended", effectiveFrom: "2026-11-11", effectiveTo: "2026-11-20" })).toBe("Berakhir 2026-11-20");
  });

  it("shows warnings as a neutral note and nothing when there are none", () => {
    expect(renderToStaticMarkup(<OvertimeWarnings warnings={[]} />)).toBe("");
    const html = renderToStaticMarkup(<OvertimeWarnings warnings={[{
      code: "OVERTIME_DAILY_GUIDE_EXCEEDED", scope: "day", totalMinutes: 300, limitMinutes: 240,
      message: "Melebihi batas PP 35/2021: 5 j hari ini (acuan 4 j).",
    }]} />);
    expect(html).toContain('role="note"');
    expect(html).toContain("Melebihi batas PP 35/2021: 5 j hari ini (acuan 4 j).");
    expect(html).not.toContain("OVERTIME_DAILY_GUIDE_EXCEEDED");
  });
});
