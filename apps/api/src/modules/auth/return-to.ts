const MAX_RETURN_TO_LENGTH = 512;
const PLACEHOLDER_ORIGIN = "https://hcis.invalid";
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const LOGIN_FLOW_PATH = /^\/(api|auth)(\/|$)/i;

/**
 * The only post-login redirect HCIS accepts: a same-origin path such as
 * "/app/leave?tab=history". Protocol-relative ("//host"), backslash, scheme and
 * control-character values are rejected, as are API/callback paths that would
 * restart the login flow. Returns null when the value is not safe to redirect to.
 */
export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_RETURN_TO_LENGTH) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\") || CONTROL_CHARACTERS.test(value)) return null;

  let parsed: URL;
  try {
    parsed = new URL(value, PLACEHOLDER_ORIGIN);
  } catch {
    return null;
  }
  if (parsed.origin !== PLACEHOLDER_ORIGIN) return null;

  // Dot segments are resolved here, so "/.//host" must be checked again after parsing.
  const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (normalized.startsWith("//") || normalized.length > MAX_RETURN_TO_LENGTH) return null;
  if (LOGIN_FLOW_PATH.test(parsed.pathname)) return null;
  return normalized;
}
