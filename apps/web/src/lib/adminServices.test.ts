import { describe, expect, it } from "vitest";

import {
  adminServices,
  adminServiceStageLabel,
  getAdminService,
} from "@/lib/adminServices";

describe("admin module catalog", () => {
  it("covers accepted future HCIS operational modules", () => {
    expect(getAdminService("payroll")?.featureIds).toContain("PAY-003");
    expect(getAdminService("recruitment")?.featureIds).toContain("REC-001");
    expect(getAdminService("sites")?.featureIds).toContain("ORG-005");
    expect(getAdminService("mobile-attendance")?.featureIds).toContain("ATT-006");
    expect(getAdminService("mobile-attendance")?.stage).toBe("available");
    expect(getAdminService("mobile-attendance")?.href).toBe("/admin/attendance/workforce/mobile");
    expect(getAdminService("mobile-attendance")?.details ?? []).not.toContain("Face recognition");
    expect(getAdminService("schedules")?.stage).toBe("available");
    expect(getAdminService("schedules")?.href).toBe("/admin/attendance/workforce/schedules");
    expect(getAdminService("shift-exchange")?.stage).toBe("available");
    expect(getAdminService("shift-exchange")?.href).toBe("/admin/attendance/workforce/shift-swaps");
    expect(getAdminService("adms")?.stage).toBe("available");
    expect(getAdminService("adms")?.href).toBe("/admin/attendance/adms");
  });

  it("routes every planned module to the authenticated admin coming-soon surface", () => {
    for (const service of adminServices.filter((item) => item.stage !== "available")) {
      expect(service.href).toBe(`/admin/services/${service.key}`);
      expect(service.featureIds.length).toBeGreaterThan(0);
    }
  });

  it("uses plain-language roadmap labels", () => {
    expect(adminServiceStageLabel("available")).toBe("Tersedia");
    expect(adminServiceStageLabel("planned")).toBe("Direncanakan");
    expect(adminServiceStageLabel("discovery")).toBe("Dalam perencanaan");
    expect(adminServiceStageLabel("deferred")).toBe("Setelah MVP");
  });
});
