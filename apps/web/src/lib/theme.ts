// Light / dark / follow-system preference from the account menu (sabilulquran/SQ-Hub docs/design/sq-core-app-shell.md).
// "system" removes the override so `prefers-color-scheme` decides; styles.css reads data-theme.
// Kept in a cookie on the parent domain so the choice follows the user across SQ Core apps.

export type ThemePreference = "light" | "dark" | "system";

const COOKIE_NAME = "sq-theme";
const SHARED_DOMAIN = "sabilulquran.or.id";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function readThemePreference(): ThemePreference {
  if (typeof document === "undefined") return "system";
  try {
    const match = document.cookie.match(/(?:^|;\s*)sq-theme=(light|dark)(?:;|$)/);
    return match ? (match[1] as ThemePreference) : "system";
  } catch {
    // Cookies blocked (sandboxed frame or strict privacy setting): follow the system.
    return "system";
  }
}

/** Applies the stored choice before the first render so the page does not flash. */
export function initThemePreference(): void {
  const preference = readThemePreference();
  if (preference !== "system") document.documentElement.dataset.theme = preference;
}

export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") delete root.dataset.theme;
  else root.dataset.theme = preference;

  const { hostname, protocol } = window.location;
  const attributes = [
    "Path=/",
    "SameSite=Lax",
    preference === "system" ? "Max-Age=0" : `Max-Age=${ONE_YEAR_SECONDS}`,
    hostname === SHARED_DOMAIN || hostname.endsWith(`.${SHARED_DOMAIN}`) ? `Domain=${SHARED_DOMAIN}` : "",
    protocol === "https:" ? "Secure" : "",
  ].filter(Boolean);
  try {
    document.cookie = `${COOKIE_NAME}=${preference === "system" ? "" : preference}; ${attributes.join("; ")}`;
  } catch {
    // Cookies blocked: the choice still applies to this page.
  }
}
