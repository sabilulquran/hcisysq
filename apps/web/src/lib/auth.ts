import type { AuthSession, LoginCredentials } from "@/types/hcis";
import { canAccessAdminPath } from "@/lib/authorization";

interface ErrorPayload {
  code?: string;
  message?: string;
}

export type AuthMode = "local" | "oidc";

export class AuthApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthApiError";
  }
}

async function readError(response: Response): Promise<AuthApiError> {
  let payload: ErrorPayload = {};
  try {
    payload = (await response.json()) as ErrorPayload;
  } catch {
    // The fallback below is intentionally generic.
  }

  return new AuthApiError(
    response.status,
    payload.code ?? "AUTH_REQUEST_FAILED",
    payload.message ?? "Permintaan autentikasi gagal.",
  );
}

export async function getAuthMode(): Promise<AuthMode> {
  const response = await fetch("/api/auth/mode", {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await readError(response);
  const payload = (await response.json()) as { mode?: string };
  if (payload.mode !== "local" && payload.mode !== "oidc") {
    throw new AuthApiError(500, "INVALID_AUTH_MODE", "Konfigurasi autentikasi tidak valid.");
  }
  return payload.mode;
}

export async function login(credentials: LoginCredentials): Promise<AuthSession> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });

  if (!response.ok) throw await readError(response);
  return (await response.json()) as AuthSession;
}

export async function getCurrentSession(): Promise<AuthSession | null> {
  try {
    const response = await fetch("/api/auth/me", {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (response.status === 401) return null;
    if (!response.ok) return null;
    return (await response.json()) as AuthSession;
  } catch {
    return null;
  }
}

async function requestLogout(): Promise<string | null> {
  const response = await fetch("/api/auth/logout", {
    method: "POST",
    headers: { Accept: "application/json" },
  });

  if (response.status === 204) return null;
  if (!response.ok) throw await readError(response);

  const payload = (await response.json()) as { logoutUrl?: string | null };
  return payload.logoutUrl ?? null;
}

/**
 * Compatibility helper for existing shells. OIDC navigation is initiated when
 * the backend returns an Identity end-session URL; local callers may keep their
 * existing local navigation behavior.
 */
export async function logout(): Promise<void> {
  const logoutUrl = await requestLogout();
  if (logoutUrl) window.location.assign(logoutUrl);
}

/**
 * Preferred account-menu flow. One navigation decision owns the transition so
 * a local redirect cannot overwrite Akun SQ (Keycloak) end-session navigation.
 */
export async function logoutFromAccountMenu(): Promise<void> {
  const logoutUrl = await requestLogout();
  window.location.assign(logoutUrl ?? "/");
}

export function oidcLoginFailureMessage(category: string | null): string | null {
  switch (category) {
    case "access_denied":
      return "Anda berhasil masuk dengan Akun SQ, tetapi akun ini belum memiliki akses ke HCIS. Hubungi administrator SQ jika akses diperlukan.";
    case "access_unavailable":
      return "HCIS belum dapat memverifikasi hak akses Anda. Silakan coba lagi beberapa saat.";
    case "account_inactive":
      return "Akun HCIS Anda sedang tidak aktif. Hubungi Human Capital jika status ini perlu diperiksa.";
    case "oidc_failed":
      return "Masuk dengan Akun SQ belum berhasil. Silakan coba lagi.";
    default:
      return null;
  }
}

export const OIDC_START_PATH = "/api/auth/oidc/start";

export interface LoginSearch {
  returnTo?: string;
  authError?: string;
}

/** Keeps only the string query values the login entry understands. */
export function loginSearch(search: Record<string, unknown>): LoginSearch {
  const result: LoginSearch = {};
  if (typeof search.returnTo === "string") result.returnTo = search.returnTo;
  if (typeof search.authError === "string") result.authError = search.authError;
  return result;
}

// eslint-disable-next-line no-control-regex
const RETURN_TO_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Browser-side pre-check for the page to return to after Akun SQ sign-in. The API
 * applies the authoritative rule again; this only avoids sending values it would drop.
 */
export function isSafeReturnTo(value: string | null | undefined): value is string {
  if (!value || value.length > 512) return false;
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("\\") || RETURN_TO_CONTROL_CHARACTERS.test(value)) return false;
  return !/^\/(api|auth)(\/|[?#]|$)/i.test(value);
}

export function oidcStartHref(returnTo?: string | null): string {
  if (!isSafeReturnTo(returnTo) || returnTo === "/") return OIDC_START_PATH;
  return `${OIDC_START_PATH}?${new URLSearchParams({ returnTo }).toString()}`;
}

/**
 * Akun SQ passes through silently when its session is still active, so the login entry
 * goes straight to the authorization start. A callback failure (`authError`) stops the
 * automatic start so a failing sign-in cannot loop; the visitor retries with the button.
 */
export function shouldStartOidcAutomatically(mode: AuthMode | null, search: LoginSearch): boolean {
  return mode === "oidc" && search.authError === undefined;
}

export function landingPath(
  session: AuthSession,
): "/app" | "/admin" | "/board" {
  if (session.principal.principalType === "FOUNDATION_BOARD") return "/board";
  if (session.principal.principalType === "EMPLOYEE") return "/app";
  if (canAccessAdminPath(session, "/admin")) return "/admin";
  return "/app";
}
