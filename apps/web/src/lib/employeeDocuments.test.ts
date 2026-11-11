import { afterEach, describe, expect, it, vi } from "vitest";

import { emptyDraft, expiryText, proposeMyDocument, updateEmployeeDocument } from "@/lib/employeeDocuments";

function captureFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: "x" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("EMP-011 client", () => {
  it("D-05: an edit keeps the stored number unless a new one is typed or clearing is chosen", async () => {
    const calls = captureFetch();
    const draft = { ...emptyDraft("NPWP"), title: " NPWP pribadi " };
    await updateEmployeeDocument("doc-1", draft);
    await updateEmployeeDocument("doc-1", { ...draft, documentNumber: "12.345" });
    await updateEmployeeDocument("doc-1", draft, true);
    const bodies = calls.map((call) => JSON.parse(String(call.init.body)) as Record<string, unknown>);
    expect(bodies[0]).not.toHaveProperty("documentNumber");
    expect(bodies[0]!.title).toBe("NPWP pribadi");
    expect(bodies[1]!.documentNumber).toBe("12.345");
    expect(bodies[2]!.documentNumber).toBeNull();
    expect(calls[0]!.init.method).toBe("PATCH");
  });

  it("a proposal never carries HC notes and sends blanks as null", async () => {
    const calls = captureFetch();
    await proposeMyDocument({ ...emptyDraft("KTP"), notes: "tidak boleh terkirim" }, { contentType: "application/pdf", contentBase64: "JVBERi0=" });
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(calls[0]!.url).toBe("/api/me/employee-documents");
    expect(body).not.toHaveProperty("notes");
    expect(body).toMatchObject({ documentType: "KTP", title: null, expiresOn: null, file: { contentType: "application/pdf" } });
  });

  it("D-15: words the expiry plainly", () => {
    const format = (value: string) => value;
    expect(expiryText({ expiresOn: null, daysLeft: null, expired: false }, format)).toBeNull();
    expect(expiryText({ expiresOn: "2027-01-10", daysLeft: 60, expired: false }, format)).toBe("Berlaku s.d. 2027-01-10 (60 hari lagi)");
    expect(expiryText({ expiresOn: "2026-11-01", daysLeft: -10, expired: true }, format)).toBe("Berakhir 2026-11-01 (lewat 10 hari)");
  });
});
