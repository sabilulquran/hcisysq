// EMP-005 S5A: the allowlist a temporary reactivation opens must name routes
// that actually exist, or a former employee gets a grant that opens nothing.
// This test ties the list to the routes the application registers.

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { isAllowedWhileReactivated } from "../src/modules/auth/employment-access.js";

/** The three read-only areas the owner allowed (D-15), plus signing in and out. */
const ALLOWED_SAMPLES = [
  "/payslips",
  "/payslips/4fbf1f1a-0000-4000-8000-000000000001",
  "/attendance/me",
  "/attendance/me/workforce",
  "/attendance/resolutions/me",
  "/leave/me/summary",
  "/leave/me/requests",
  "/leave/planned/me/summary",
  "/leave/special/me/summary",
  "/auth/me",
  "/auth/launcher",
];

/** Routes that stay closed: submissions, other people's data, administration. */
const REFUSED_SAMPLES = [
  "/employees/me/employment",
  "/notifications/me",
  "/attendance/me/schedule",
  "/attendance/clarifications/me",
  "/leave/approvals",
  "/admin/employees",
  "/admin/access",
];

interface ManifestEntry {
  method: string;
  url: string;
  access?: string;
}

async function manifest(): Promise<ManifestEntry[]> {
  const raw = await readFile(new URL("../../../docs/domain/AUTH-011-admin-route-permissions.json", import.meta.url), "utf8");
  return JSON.parse(raw) as ManifestEntry[];
}

/** AUTH-011 keeps these out of the manifest; they authenticate inside the handler. */
const PUBLIC_SELF_SERVICE = new Set(["/auth/me", "/auth/launcher", "/auth/logout"]);

function matchesManifest(entries: ManifestEntry[], path: string): boolean {
  if (PUBLIC_SELF_SERVICE.has(path)) return true;
  return entries.some((entry) => {
    const pattern = new RegExp(`^${entry.url.replace(/:[^/]+/g, "[^/]+")}$`);
    return pattern.test(path);
  });
}

describe("EMP-005 D-15 reactivation allowlist", () => {
  it("names only paths the application really serves", async () => {
    const entries = await manifest();
    for (const path of ALLOWED_SAMPLES) {
      expect(matchesManifest(entries, path), `${path} is not a route this application serves`).toBe(true);
    }
  });

  it("opens every allowed page for a reading request", () => {
    for (const path of ALLOWED_SAMPLES) {
      expect(isAllowedWhileReactivated("GET", path), path).toBe(true);
    }
    expect(isAllowedWhileReactivated("POST", "/auth/logout")).toBe(true);
  });

  it("keeps everything else closed, writes included", () => {
    for (const path of REFUSED_SAMPLES) {
      expect(isAllowedWhileReactivated("GET", path), path).toBe(false);
    }
    for (const path of ALLOWED_SAMPLES) {
      expect(isAllowedWhileReactivated("POST", path), `POST ${path}`).toBe(false);
      expect(isAllowedWhileReactivated("DELETE", path), `DELETE ${path}`).toBe(false);
    }
  });

  it("is not fooled by a query string, a trailing slash, or a different case", () => {
    expect(isAllowedWhileReactivated("GET", "/payslips?page=2")).toBe(true);
    expect(isAllowedWhileReactivated("GET", "/payslips/")).toBe(true);
    expect(isAllowedWhileReactivated("GET", "/PAYSLIPS")).toBe(false);
    expect(isAllowedWhileReactivated("GET", "//payslips")).toBe(false);
    expect(isAllowedWhileReactivated("GET", "/payslips/../admin/employees")).toBe(false);
  });
});
