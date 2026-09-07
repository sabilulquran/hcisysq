export type PrincipalType = "EMPLOYEE" | "FOUNDATION_BOARD" | "SUPER_ADMIN";

export interface LoginCredentials {
  email: string;
  password: string;
  mfaCode?: string;
}

export interface AuthPrincipal {
  id: string;
  email: string;
  principalType: PrincipalType;
}

export interface AuthSession {
  principal: AuthPrincipal;
  expiresAt: string;
  authorization?: { organizationPermissions: string[] };
}
