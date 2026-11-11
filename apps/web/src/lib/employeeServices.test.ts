import { describe, expect, it } from "vitest";

import {
  employeeServices,
  employeeServiceStageLabel,
  getEmployeeService,
} from "@/lib/employeeServices";

describe("employee service catalog", () => {
  it("keeps implemented and planned employee services distinguishable", () => {
    expect(getEmployeeService("attendance")?.stage).toBe("available");
    expect(getEmployeeService("reimbursement")?.stage).toBe("deferred");
    // PERF-001 Package 1 ships self-assessment, rating, validation and history.
    expect(getEmployeeService("performance")?.stage).toBe("available");
    expect(getEmployeeService("performance")?.href).toBe("/app/performance");
    expect(getEmployeeService("clock-in")?.stage).toBe("available");
    expect(getEmployeeService("work-schedule")?.stage).toBe("available");
    expect(getEmployeeService("attendance-clarification")?.stage).toBe("available");
    expect(getEmployeeService("shift-swap")?.stage).toBe("available");
    expect(getEmployeeService("shift-swap")?.href).toBe("/app/attendance/shift-swap");
    expect(getEmployeeService("notifications")?.stage).toBe("available");
    expect(getEmployeeService("notifications")?.href).toBe("/app/notifications");
    expect(getEmployeeService("reminders")?.stage).toBe("discovery");
    expect(getEmployeeService("documents")?.stage).toBe("available");
    expect(getEmployeeService("documents")?.href).toBe("/app/documents");
    // DOC-003: every employee sees the service; taking a number needs an HC grant (API-checked).
    expect(getEmployeeService("letters")?.stage).toBe("available");
    expect(getEmployeeService("letters")?.href).toBe("/app/letters");
    expect(getEmployeeService("announcements")?.stage).toBe("available");
    expect(getEmployeeService("announcements")?.href).toBe("/app/announcements");
    expect(getEmployeeService("business-travel")?.featureIds).toContain("TRIP-001");
    // ATT-015 Package 1: tugas luar, WFH/WFA and schedule change requests.
    expect(getEmployeeService("work-arrangements")?.href).toBe("/app/attendance/arrangements");
    expect(getEmployeeService("work-arrangements")?.featureIds).toContain("ATT-015");
    // TRIP-001 Package 1 ships request, approval and the surat tugas.
    expect(getEmployeeService("business-travel")?.stage).toBe("available");
    expect(getEmployeeService("business-travel")?.href).toBe("/app/trips");
    // LOAN-001 Package 1 ships request, approval, schedule and repayment records.
    expect(getEmployeeService("loan")?.stage).toBe("available");
    expect(getEmployeeService("loan")?.href).toBe("/app/loans");
    // EMP-012 Package 1: every employee sees their own card.
    expect(getEmployeeService("employee-card")?.stage).toBe("available");
    expect(getEmployeeService("employee-card")?.href).toBe("/app/employee-card");
    // ORG-012 Package 1: every employee sees the committees they are on.
    expect(getEmployeeService("committees")?.stage).toBe("available");
    expect(getEmployeeService("committees")?.href).toBe("/app/committees");
    // HELP-001 Package 1: every employee reads the help center.
    expect(getEmployeeService("help")?.stage).toBe("available");
    expect(getEmployeeService("help")?.href).toBe("/app/help");
    expect(getEmployeeService("training")?.stage).toBe("available");
    expect(getEmployeeService("training")?.href).toBe("/app/training");
    // EMP-003: employees review their data and request changes at /app/my-data.
    expect(getEmployeeService("profile-change")?.stage).toBe("available");
    expect(getEmployeeService("profile-change")?.href).toBe("/app/my-data");
  });

  it("maps every planned service to a real coming-soon route and feature id", () => {
    const planned = employeeServices.filter((service) => service.stage !== "available");

    expect(planned.length).toBeGreaterThan(0);
    for (const service of planned) {
      expect(service.href).toBe(`/app/services/${service.key}`);
      expect(service.featureIds.length).toBeGreaterThan(0);
    }
  });

  it("uses plain-language roadmap labels", () => {
    expect(employeeServiceStageLabel("available")).toBe("Tersedia");
    expect(employeeServiceStageLabel("discovery")).toBe("Dalam perencanaan");
    expect(employeeServiceStageLabel("planned")).toBe("Direncanakan");
    expect(employeeServiceStageLabel("deferred")).toBe("Setelah MVP");
  });
});
