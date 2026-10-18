import { describe, expect, it } from "vitest";

import { activationReadiness, type ActivationReadinessInput } from "../src/modules/auth/account-activation-readiness.js";

const issuer = "https://login.example.invalid/realms/sq-staff";
const board: ActivationReadinessInput = {
  principalType: "FOUNDATION_BOARD",
  hasPassword: false,
  identityIssuer: null,
  identitySubject: null,
  employeeStatus: null,
};

describe("AUTH-002 activation readiness", () => {
  it("keeps the local-password rule", () => {
    expect(activationReadiness({ ...board, hasPassword: true }, undefined)).toEqual({ ready: true, method: "password" });
  });

  it("allows a Foundation Board account with a mapped Akun SQ identity and no password", () => {
    expect(activationReadiness({ ...board, identityIssuer: issuer, identitySubject: "opaque-sub" }, `${issuer}/`))
      .toEqual({ ready: true, method: "oidc_identity" });
  });

  it("refuses an account with neither a password nor a complete identity mapping", () => {
    expect(activationReadiness(board, issuer)).toEqual({ ready: false, code: "ACCOUNT_ACTIVATION_NOT_READY" });
    expect(activationReadiness({ ...board, identityIssuer: issuer }, issuer))
      .toEqual({ ready: false, code: "ACCOUNT_ACTIVATION_NOT_READY" });
  });

  it("refuses a mapping from another realm or when no issuer is configured", () => {
    const mapped = { ...board, identityIssuer: "https://other.example.invalid/realms/x", identitySubject: "opaque-sub" };
    expect(activationReadiness(mapped, issuer)).toEqual({ ready: false, code: "OIDC_ISSUER_MISMATCH" });
    expect(activationReadiness({ ...mapped, identityIssuer: issuer }, undefined))
      .toEqual({ ready: false, code: "OIDC_ISSUER_MISMATCH" });
  });

  it("requires an active employee for a mapped Employee account", () => {
    const employee = { ...board, principalType: "EMPLOYEE" as const, identityIssuer: issuer, identitySubject: "opaque-sub" };
    expect(activationReadiness({ ...employee, employeeStatus: "resigned" }, issuer))
      .toEqual({ ready: false, code: "EMPLOYEE_NOT_ACTIVE" });
    expect(activationReadiness({ ...employee, employeeStatus: "active" }, issuer))
      .toEqual({ ready: true, method: "oidc_identity" });
  });
});
