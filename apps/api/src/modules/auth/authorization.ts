import {
  AUTH_COOKIE_NAME,
  AuthError,
  readCookie,
  type AuthPrincipal,
  type AuthService,
  type PrincipalType,
} from "./service.js";
import type { Pool } from "pg";
import { hasBoardAccess, type AdminPermission } from "./permissions.js";

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

/** ORG-010 §1.3/§2: /board accepts an active FOUNDATION_BOARD session, or an active EMPLOYEE session
 * with effective organization-scope board.read. The cookie session already requires an active account. */
export async function requireBoardAccessFromCookie(
  auth: Pick<AuthService, "getSession">,
  db: Pick<Pool, "query">,
  cookieHeader: string | undefined,
): Promise<AuthPrincipal> {
  const session = await auth.getSession(readCookie(cookieHeader, AUTH_COOKIE_NAME));
  if (!session) throw new AuthError(401, "UNAUTHENTICATED", "Sesi tidak ditemukan atau sudah berakhir.");
  if (!(await hasBoardAccess(db, session.principal))) {
    throw new AuthError(403, "FORBIDDEN", "Akun ini tidak memiliki akses ke area tersebut.");
  }
  return session.principal;
}
