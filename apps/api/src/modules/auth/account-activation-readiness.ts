// AUTH-002 §Aktivasi melalui Akun SQ: an account may be set `active` by an administrator only when
// it already has a way to sign in. Either a local password (legacy activation link), or an exact
// Akun SQ identity (issuer + sub) mapped through the audited operator command. Email is never used.

export interface ActivationReadinessInput {
  principalType: "EMPLOYEE" | "FOUNDATION_BOARD" | "SUPER_ADMIN";
  hasPassword: boolean;
  identityIssuer: string | null;
  identitySubject: string | null;
  employeeStatus: "active" | "inactive" | "resigned" | null;
}

export type ActivationReadiness =
  | { ready: true; method: "password" | "oidc_identity" }
  | { ready: false; code: "ACCOUNT_ACTIVATION_NOT_READY" | "OIDC_ISSUER_MISMATCH" | "EMPLOYEE_NOT_ACTIVE" };

export function activationReadiness(
  account: ActivationReadinessInput,
  configuredIssuer: string | undefined,
): ActivationReadiness {
  if (account.hasPassword) return { ready: true, method: "password" };
  if (!account.identityIssuer || !account.identitySubject) {
    return { ready: false, code: "ACCOUNT_ACTIVATION_NOT_READY" };
  }
  // A mapping from another realm can never sign in here, so it does not make the account ready.
  if (!configuredIssuer || account.identityIssuer !== configuredIssuer.replace(/\/$/, "")) {
    return { ready: false, code: "OIDC_ISSUER_MISMATCH" };
  }
  // Same rule as the activation link: an inactive Employee cannot get a newly activated account.
  if (account.principalType === "EMPLOYEE" && account.employeeStatus !== "active") {
    return { ready: false, code: "EMPLOYEE_NOT_ACTIVE" };
  }
  return { ready: true, method: "oidc_identity" };
}
