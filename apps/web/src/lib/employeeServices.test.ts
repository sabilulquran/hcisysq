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
    expect(getEmployeeService("performance")?.stage).toBe("discovery");
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
    expect(employeeServiceStageLabel("deferred")).toBe("Setelah MVP");
  });
});
