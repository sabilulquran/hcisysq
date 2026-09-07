import { describe, expect, it, vi } from "vitest";
import { ADMIN_PERMISSIONS, HC_ADMIN_PERMISSIONS, HC_OPERATIONAL_PERMISSIONS, hasLegacySuperAdminCompatibility } from "../src/modules/auth/permissions.js";
import { requirePermissionsFromCookie } from "../src/modules/auth/authorization.js";
import { canDelegateRole } from "../src/modules/auth/role-assignment.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";

const employee: AuthPrincipal = { id: "synthetic", email: "synthetic@example.invalid", principalType: "EMPLOYEE" };
describe("AUTH-011 permission and delegation boundaries", () => {
  it.each(ADMIN_PERMISSIONS)("isolates legacy compatibility for %s", (key) => {
    expect(hasLegacySuperAdminCompatibility({ ...employee, principalType: "SUPER_ADMIN" }, key)).toBe(true);
    expect(hasLegacySuperAdminCompatibility(employee, key)).toBe(false);
    expect(hasLegacySuperAdminCompatibility({ ...employee, principalType: "FOUNDATION_BOARD" }, key)).toBe(false);
  });
  it.each(["leave.approve", "leave.hc.approve", "platform.admin", "new.unreviewed.permission"])("denies compatibility for %s", (key) => {
    expect(hasLegacySuperAdminCompatibility({ ...employee, principalType: "SUPER_ADMIN" }, key)).toBe(false);
  });
  it("requires every permission for combined destructive biometric operations", async () => {
    const auth = { getSession: vi.fn(async () => ({ principal: employee, expiresAt: "2099-01-01T00:00:00Z" })),
      getAuthorizationContext: vi.fn(async () => ({ organizationPermissions: ["attendance.devices.biometrics"] })) };
    await expect(requirePermissionsFromCookie(auth, "hcis_session=synthetic", ["attendance.devices.biometrics", "attendance.devices.destructive"]))
      .rejects.toMatchObject({ statusCode: 403 });
    auth.getAuthorizationContext.mockResolvedValue({ organizationPermissions: ["attendance.devices.biometrics", "attendance.devices.destructive"] });
    await expect(requirePermissionsFromCookie(auth, "hcis_session=synthetic", ["attendance.devices.biometrics", "attendance.devices.destructive"]))
      .resolves.toEqual(employee);
  });
  it("rejects role aliases, external permissions, approval and technical delegation by normal admins", () => {
    expect(canDelegateRole({ roleKey: "human_capital", permissions: [...HC_OPERATIONAL_PERMISSIONS] }, false)).toBe(true);
    expect(canDelegateRole({ roleKey: "human_capital_admin", permissions: [...HC_ADMIN_PERMISSIONS] }, false)).toBe(false);
    expect(canDelegateRole({ roleKey: "human_capital_admin", permissions: [...HC_ADMIN_PERMISSIONS] }, true)).toBe(true);
    for (const key of ["leave.approve", "leave.hc.approve", "attendance.devices.destructive", "access.roles.delegate", "sq.platform.admin"]) {
      expect(canDelegateRole({ roleKey: "human_capital", permissions: [...HC_OPERATIONAL_PERMISSIONS, key] }, false)).toBe(false);
    }
    expect(canDelegateRole({ roleKey: "sq_platform_administrator", permissions: ["access.manage"] }, true)).toBe(false);
    expect(canDelegateRole({ roleKey: "human_capital", permissions: ["sq.platform.admin"] }, true)).toBe(false);
  });
});
