import { describe, expect, it } from "vitest";

import {
  ATTENDANCE_SOURCES,
  ATTENDANCE_STATUSES,
  CLARIFICATION_KINDS,
  CLARIFICATION_MODES,
  MOBILE_REVIEW_STATES,
  REQUEST_STATUSES,
  SCAN_EVENT_KINDS,
  attendanceSourceLabel,
  attendanceStatusLabel,
  clarificationKindLabel,
  clarificationModeLabel,
  mobileReviewLabel,
  requestStatusLabel,
  scanEventLabel,
} from "@/lib/attendanceLabels";
import { attendanceSectionHref, attendanceSections, legacyAttendanceRedirects } from "@/lib/attendanceNavigation";
import { canAccessAdminPath } from "@/lib/authorization";
import type { AuthSession } from "@/types/hcis";

const session = (permissions: string[]): AuthSession => ({
  principal: { id: "synthetic", email: "synthetic@example.invalid", principalType: "EMPLOYEE" },
  expiresAt: "2099-01-01T00:00:00Z",
  authorization: { organizationPermissions: permissions },
});

describe("ATT-011 §3 operator vocabulary", () => {
  it.each([
    ["status", ATTENDANCE_STATUSES, attendanceStatusLabel],
    ["source", ATTENDANCE_SOURCES, attendanceSourceLabel],
    ["request status", REQUEST_STATUSES, requestStatusLabel],
    ["clarification mode", CLARIFICATION_MODES, clarificationModeLabel],
    ["clarification kind", CLARIFICATION_KINDS, clarificationKindLabel],
    ["mobile review", MOBILE_REVIEW_STATES, mobileReviewLabel],
    ["scan event", SCAN_EVENT_KINDS, scanEventLabel],
  ] as const)("never shows a raw %s enum", (_name, values, label) => {
    for (const value of values) {
      const text = (label as (value: unknown) => string)(value);
      expect(text, value).not.toBe(value);
      expect(text, value).not.toMatch(/_/);
      expect(text, value).not.toMatch(/^(draft|published|canonical|materialized|pending|incomplete|adms|mobile|manual)$/i);
    }
  });

  it("uses the dictionary words", () => {
    expect(attendanceStatusLabel("pending")).toBe("Belum absen");
    expect(attendanceStatusLabel("incomplete")).toBe("Tidak lengkap");
    expect(attendanceStatusLabel("configuration_error")).toBe("Jadwal bermasalah");
    expect(attendanceSourceLabel(["adms", "mobile", "manual"])).toBe("Mesin, HP, Koreksi HC");
    expect(clarificationModeLabel("correction")).toBe("Perbaiki jam");
    expect(clarificationModeLabel("justification")).toBe("Terima alasan");
    expect(requestStatusLabel("submitted")).toBe("Menunggu");
  });

  it("falls back to a neutral word for an unknown code instead of echoing it", () => {
    expect(attendanceStatusLabel("some_new_state")).toBe("Tidak diketahui");
    expect(attendanceSourceLabel("x_feed")).toBe("Lainnya");
    expect(attendanceSourceLabel([])).toBe("—");
  });
});

describe("ATT-011 Waktu & Kehadiran navigation (K-8)", () => {
  it("offers a section only when the account can load one of its tabs, opening on that tab", () => {
    const operator = session(["attendance.clarification.manage"]);
    expect(attendanceSectionHref(operator, "records")).toBe("/admin/attendance/clarifications");
    expect(attendanceSectionHref(operator, "summary")).toBe("/admin/attendance");
    for (const key of ["shifts", "schedules", "overtime", "devices", "settings"] as const) {
      expect(attendanceSectionHref(operator, key), key).toBeNull();
    }

    const swapsOnly = session(["attendance.shift_swap.manage"]);
    expect(attendanceSectionHref(swapsOnly, "schedules")).toBe("/admin/attendance/schedules/swaps");

    // ATT-014-2: Kalkulasi is read with attendance.reports.read; running it needs attendance.calculation.run.
    const calculationOnly = session(["attendance.calculation.run"]);
    expect(attendanceSectionHref(calculationOnly, "summary")).toBe("/admin/attendance");
    expect(attendanceSectionHref(calculationOnly, "records")).toBeNull();
    const reader = session(["attendance.reports.read"]);
    expect(attendanceSectionHref(reader, "records")).toBe("/admin/attendance/daily");
    expect(attendanceSectionHref(reader, "settings")).toBeNull();

    const devices = session(["attendance.devices.read"]);
    expect(attendanceSectionHref(devices, "devices")).toBe("/admin/attendance/adms");
    expect(attendanceSectionHref(devices, "summary")).toBeNull();
  });

  it("gates every tab on the permission its API needs", () => {
    const expected: Record<string, string> = {
      "/admin/attendance/shifts": "attendance.schedule.manage",
      "/admin/attendance/schedules": "attendance.schedule.manage",
      "/admin/attendance/schedules/dates": "attendance.schedule.manage",
      "/admin/attendance/schedules/swaps": "attendance.shift_swap.manage",
      "/admin/attendance/daily": "attendance.reports.read",
      "/admin/attendance/clarifications": "attendance.clarification.manage",
      "/admin/attendance/mobile-evidence": "attendance.clarification.manage",
      "/admin/attendance/corrections": "attendance.records.manage",
      "/admin/attendance/reports": "attendance.reports.read",
      "/admin/attendance/overtime": "attendance.overtime.manage",
      "/admin/attendance/settings/locations": "attendance.schedule.manage",
      "/admin/attendance/adms": "attendance.devices.read",
    };
    const tabs = attendanceSections.flatMap((section) => section.tabs).filter((tab) => tab.href !== "/admin/attendance");
    expect(tabs.map((tab) => tab.href).sort()).toEqual(Object.keys(expected).sort());
    for (const tab of tabs) {
      expect(canAccessAdminPath(session([expected[tab.href]!]), tab.href), tab.href).toBe(true);
      expect(canAccessAdminPath(session([]), tab.href), tab.href).toBe(false);
    }
  });

  it("denies the whole workspace to non-attendance accounts", () => {
    for (const permissions of [[], ["employees.manage"], ["attendance.devices.read"]]) {
      expect(canAccessAdminPath(session(permissions), "/admin/attendance")).toBe(false);
    }
  });

  it("forwards every pre-ATT-011 route to an existing new route", () => {
    const newPaths = new Set(attendanceSections.flatMap((section) => section.tabs.map((tab) => tab.href)));
    expect(Object.keys(legacyAttendanceRedirects).sort()).toEqual([
      "/admin/attendance/calculation",
      "/admin/attendance/settings/recalculate",
      "/admin/attendance/workforce",
      "/admin/attendance/workforce/assignments",
      "/admin/attendance/workforce/clarifications",
      "/admin/attendance/workforce/locations",
      "/admin/attendance/workforce/mobile",
      "/admin/attendance/workforce/overtime",
      "/admin/attendance/workforce/reports",
      "/admin/attendance/workforce/roster",
      "/admin/attendance/workforce/schedules",
      "/admin/attendance/workforce/shift-swaps",
    ]);
    for (const [from, to] of Object.entries(legacyAttendanceRedirects)) {
      expect(newPaths.has(to), `${from} -> ${to}`).toBe(true);
    }
  });
});
