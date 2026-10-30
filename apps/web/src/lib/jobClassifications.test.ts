// ORG-011 catalog client. No network; the fetch boundary is stubbed.

import { afterEach, describe, expect, it, vi } from "vitest";

import { canAccessAdminPath } from "@/lib/authorization";
import {
  amendJobClassification,
  deactivateJobGrade,
  jobFamilyLabels,
  listJobClassifications,
  listJobGrades,
} from "@/lib/jobClassifications";
import type { AuthSession } from "@/types/hcis";

function stubFetch(body: unknown, status = 200) {
  const spy = vi.fn(async (_input: unknown, _init?: unknown) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => { vi.unstubAllGlobals(); });

function session(permissions: string[]): AuthSession {
  return {
    principal: { id: "synthetic", email: "synthetic@example.invalid", principalType: "EMPLOYEE" },
    expiresAt: "2099-01-01T00:00:00Z",
    authorization: { organizationPermissions: permissions },
  } as AuthSession;
}

describe("ORG-011 catalog client", () => {
  it("sends includeHistory as a word, because the API reads words not booleans", async () => {
    const spy = stubFetch({ classifications: [], onDate: "2026-10-30", includeHistory: false,
      pagination: { page: 1, pageSize: 25, total: 0, pageCount: 1 } });
    await listJobClassifications({ onDate: "2026-10-30", includeHistory: false, family: "FUNCTIONAL" });
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain("includeHistory=false");
    expect(url).toContain("onDate=2026-10-30");
    expect(url).toContain("family=FUNCTIONAL");
  });

  it("omits includeHistory when the caller says nothing", async () => {
    const spy = stubFetch({ grades: [], onDate: "2026-10-30", includeHistory: false,
      pagination: { page: 1, pageSize: 25, total: 0, pageCount: 1 } });
    await listJobGrades({ page: 2 });
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).not.toContain("includeHistory");
    expect(url).toContain("page=2");
  });

  it("escapes the code in the path so a stray character cannot change the route", async () => {
    const spy = stubFetch({ classification: {} });
    await amendJobClassification("FUNC/GURU", { effectiveFrom: "2026-11-01", name: "Guru" });
    expect(String(spy.mock.calls[0]?.[0])).toContain("/admin/job-classifications/FUNC%2FGURU/amendments");
  });

  it("surfaces the API's own code and message on failure", async () => {
    stubFetch({ code: "GRADE_STILL_REFERENCED", message: "Golongan G3 masih dipakai." }, 409);
    await expect(deactivateJobGrade("G3", { endOn: "2026-12-31", reason: "Tidak dipakai" }))
      .rejects.toMatchObject({ status: 409, code: "GRADE_STILL_REFERENCED" });
  });

  it("names the three families in Indonesian", () => {
    expect(jobFamilyLabels.FUNCTIONAL).toBe("Fungsional");
    expect(jobFamilyLabels.STRUCTURAL).toBe("Struktural");
    expect(jobFamilyLabels.SUPPORT).toBe("Penunjang");
  });
});

describe("ORG-011 menu access", () => {
  it("opens the catalog on its own read permission, not on organization.manage", () => {
    // The catalog is HC-only. Someone who may publish structure does not automatically see it,
    // and a menu entry leading to a 403 would be worse than no entry at all.
    expect(canAccessAdminPath(session(["job_classifications.read"]), "/admin/job-classifications")).toBe(true);
    expect(canAccessAdminPath(session(["organization.manage"]), "/admin/job-classifications")).toBe(false);
    expect(canAccessAdminPath(session([]), "/admin/job-classifications")).toBe(false);
  });
});
