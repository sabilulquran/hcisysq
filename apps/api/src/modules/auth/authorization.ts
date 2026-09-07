import {
  AUTH_COOKIE_NAME,
  AuthError,
  readCookie,
  type AuthPrincipal,
  type AuthService,
  type PrincipalType,
} from "./service.js";
import type { AdminPermission } from "./permissions.js";

export async function requirePermissionsFromCookie(
  auth: Pick<AuthService, "getSession" | "getAuthorizationContext">,
  cookieHeader: string | undefined,
  required: AdminPermission | readonly AdminPermission[],
): Promise<AuthPrincipal> {
  const session = await auth.getSession(readCookie(cookieHeader, AUTH_COOKIE_NAME));
  if (!session) throw new AuthError(401, "UNAUTHENTICATED", "Sesi tidak ditemukan atau sudah berakhir.");
  const context = await auth.getAuthorizationContext(session.principal);
  const permissions = typeof required === "string" ? [required] : required;
  if (!permissions.length || !permissions.every((key) => context.organizationPermissions.includes(key))) {
    throw new AuthError(403, "FORBIDDEN", "Akun ini tidak memiliki izin administrasi yang diperlukan.");
  }
  return session.principal;
}

export async function requirePrincipalFromCookie(
  auth: Pick<AuthService, "getSession">,
  cookieHeader: string | undefined,
  expected: PrincipalType,
): Promise<AuthPrincipal> {
  const token = readCookie(cookieHeader, AUTH_COOKIE_NAME);
  const session = await auth.getSession(token);

  if (!session) {
    throw new AuthError(401, "UNAUTHENTICATED", "Sesi tidak ditemukan atau sudah berakhir.");
  }

  if (session.principal.principalType !== expected) {
    throw new AuthError(403, "FORBIDDEN", "Akun ini tidak memiliki akses ke area tersebut.");
  }

  return session.principal;
}
