import type { IncomingHttpHeaders } from "node:http";

import type { ApiConfig } from "../../config/env.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The browser origin of the HCIS app, known from the OIDC callback; null in local login mode. */
export function publicOrigin(config: Pick<ApiConfig, "AUTH_MODE" | "OIDC_REDIRECT_URI">): string | null {
  return config.AUTH_MODE === "oidc" && config.OIDC_REDIRECT_URI ? new URL(config.OIDC_REDIRECT_URI).origin : null;
}

/**
 * SEC-06: session cookies are SameSite=Lax, and sibling SQ Core apps share the registrable domain, so a
 * same-site page could still send a cookie-bearing mutation. A browser marks every request with
 * Sec-Fetch-Site; only the HCIS page itself (same-origin) or a user-typed navigation (none) may change
 * data. Clients without Sec-Fetch-Site and Origin (devices, machine tokens, scripts) carry no browser
 * cookie risk and pass.
 */
export function isCrossSiteMutation(
  method: string,
  url: string,
  headers: IncomingHttpHeaders,
  origin: string | null,
): boolean {
  if (!UNSAFE_METHODS.has(method) || url.startsWith("/iclock/")) return false;
  const site = headers["sec-fetch-site"];
  if (typeof site === "string") return site !== "same-origin" && site !== "none";
  const requestOrigin = headers.origin;
  if (typeof requestOrigin !== "string" || !origin) return false;
  return requestOrigin !== origin;
}
