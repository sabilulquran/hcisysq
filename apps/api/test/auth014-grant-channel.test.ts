import { describe, expect, it } from "vitest";

import { AuthError, type AuthPrincipal } from "../src/modules/auth/service.js";
import {
  HC_OPERATIONAL_PERMISSIONS,
  IDENTITY_PERMISSIONS,
  MODULE_ADMIN_PERMISSIONS,
  MODULE_ADMIN_ROLE_KEY,
} from "../src/modules/auth/permissions.js";
import {
  assertRoleGrantor,
  canDelegateRole,
  carriesIdentityPermission,
  type GrantChannel,
} from "../src/modules/auth/role-assignment.js";

function principal(principalType: AuthPrincipal["principalType"]): AuthPrincipal {
  return { id: "11111111-1111-4111-8111-111111111111", principalType } as AuthPrincipal;
}

function expectAuthError(run: () => void, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

// AUTH-014 F3 (§2.5, §2.6, §3.1).
describe("AUTH-014 grant channel", () => {
  it("keeps break-glass exactly as strict as before: SUPER_ADMIN and nobody else", () => {
    expect(() => assertRoleGrantor(principal("SUPER_ADMIN"), "break_glass")).not.toThrow();
    for (const type of ["EMPLOYEE", "FOUNDATION_BOARD"] as const) {
      expectAuthError(() => assertRoleGrantor(principal(type), "break_glass"), "ROLE_GRANT_SUPER_ADMIN_ONLY");
    }
  });

  it("admits an employee account on the SQ Hub channel, and nothing else", () => {
    expect(() => assertRoleGrantor(principal("EMPLOYEE"), "sq_hub")).not.toThrow();
    // SUPER_ADMIN does not reach HCIS through SQ Hub, and a governance account is never a grantor.
    for (const type of ["SUPER_ADMIN", "FOUNDATION_BOARD"] as const) {
      expectAuthError(() => assertRoleGrantor(principal(type), "sq_hub"), "ROLE_GRANT_ACTOR_INVALID");
    }
  });

  it("refuses every role carrying an identity permission, on both channels", () => {
    for (const permission of IDENTITY_PERMISSIONS) {
      const role = { roleKey: "human_capital_admin", permissions: ["employees.manage", permission] };
      expect(carriesIdentityPermission(role)).toBe(true);
      for (const channel of ["sq_hub", "break_glass"] as GrantChannel[]) {
        expect(canDelegateRole(role, true, channel)).toBe(false);
      }
      // Even the old delegated path, which break-glass used to travel, is closed.
      expect(canDelegateRole(role, true)).toBe(false);
    }
  });

  it("lets a channel grant the privileged roles that no permission could unlock", () => {
    // access.roles.assign was removed from every role by migration 0057 and may never be granted
    // again, so no actor can hold it. Without the channel, only human_capital would be grantable.
    const moduleAdmin = { roleKey: MODULE_ADMIN_ROLE_KEY, permissions: [...MODULE_ADMIN_PERMISSIONS] };
    expect(canDelegateRole(moduleAdmin, false)).toBe(false);
    for (const channel of ["sq_hub", "break_glass"] as GrantChannel[]) {
      expect(canDelegateRole(moduleAdmin, false, channel)).toBe(true);
    }
  });

  it("still refuses roles and permissions HCIS does not know, whatever the channel", () => {
    for (const channel of ["sq_hub", "break_glass"] as GrantChannel[]) {
      expect(canDelegateRole({ roleKey: "sq_platform_administrator", permissions: ["access.manage"] }, true, channel)).toBe(false);
      expect(canDelegateRole({ roleKey: "human_capital", permissions: ["sq.platform.admin"] }, true, channel)).toBe(false);
      expect(canDelegateRole({ roleKey: "human_capital", permissions: [] }, true, channel)).toBe(false);
    }
  });

  it("leaves the undelegated path untouched for the one role that had it", () => {
    expect(canDelegateRole({ roleKey: "human_capital", permissions: [...HC_OPERATIONAL_PERMISSIONS] }, false)).toBe(true);
  });

  it("carries no identity permission in the module administrator bundle", () => {
    expect(carriesIdentityPermission({
      roleKey: MODULE_ADMIN_ROLE_KEY, permissions: [...MODULE_ADMIN_PERMISSIONS],
    })).toBe(false);
  });
});
