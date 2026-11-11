// EMP-011 pure rules and route guards. No database, synthetic data only.

import Fastify from "fastify";
import type { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import {
  ADMIN_PERMISSIONS,
  EMPLOYEE_DOCUMENT_PERMISSIONS,
  HC_ADMIN_PERMISSIONS,
  UNIT_SCOPED_PERMISSIONS,
} from "../src/modules/auth/permissions.js";
import {
  daysUntil,
  decodeDocumentFile,
  DOCUMENT_TYPES,
  downloadFileName,
  MAX_FILE_BYTES,
  numberLast4,
  validateMetadata,
} from "../src/modules/employee-documents/domain.js";
import { fileDownloadHeaders } from "../src/modules/employee-documents/file-store.js";
import { registerEmployeeDocumentRoutes } from "../src/modules/employee-documents/routes.js";

const PDF = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF");
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const b64 = (buffer: Buffer) => buffer.toString("base64");

describe("EMP-011 rules", () => {
  it("D-02: checks the file signature against the declared type", () => {
    expect(decodeDocumentFile("application/pdf", b64(PDF))).toEqual(PDF);
    expect(decodeDocumentFile("image/png", b64(PNG))).toEqual(PNG);
    expect(decodeDocumentFile("image/jpeg", b64(JPEG))).toEqual(JPEG);
    for (const [type, bytes] of [["application/pdf", PNG], ["image/png", JPEG], ["image/jpeg", PDF]] as const) {
      expect(() => decodeDocumentFile(type, b64(bytes))).toThrow(expect.objectContaining({ code: "EMPLOYEE_DOCUMENT_FILE_INVALID", statusCode: 400 }));
    }
    // An executable renamed to .pdf is refused by content, whatever the browser claims.
    expect(() => decodeDocumentFile("application/pdf", b64(Buffer.from("MZ\x90\x00 executable"))))
      .toThrow(expect.objectContaining({ code: "EMPLOYEE_DOCUMENT_FILE_INVALID" }));
    expect(() => decodeDocumentFile("application/pdf", "")).toThrow(expect.objectContaining({ code: "EMPLOYEE_DOCUMENT_FILE_INVALID" }));
    expect(() => decodeDocumentFile("application/pdf", "not base64!")).toThrow(expect.objectContaining({ code: "EMPLOYEE_DOCUMENT_FILE_INVALID" }));
  });

  it("D-02: refuses a file over 4 MB with 413", () => {
    const big = Buffer.concat([PDF, Buffer.alloc(MAX_FILE_BYTES)]);
    expect(() => decodeDocumentFile("application/pdf", b64(big))).toThrow(expect.objectContaining({ code: "EMPLOYEE_DOCUMENT_FILE_TOO_LARGE", statusCode: 413 }));
    const exact = Buffer.concat([PDF, Buffer.alloc(MAX_FILE_BYTES - PDF.length)]);
    expect(decodeDocumentFile("application/pdf", b64(exact)).length).toBe(MAX_FILE_BYTES);
  });

  it("D-07: refuses PDFs with visible active content", () => {
    for (const marker of ["/JavaScript", "/JS (app.alert(1))", "/Launch", "/EmbeddedFile", "/RichMedia", "/XFA"]) {
      const pdf = Buffer.from(`%PDF-1.7\n1 0 obj << /OpenAction << ${marker} >> >> endobj`);
      expect(() => decodeDocumentFile("application/pdf", b64(pdf)), marker)
        .toThrow(expect.objectContaining({ code: "EMPLOYEE_DOCUMENT_FILE_ACTIVE_CONTENT", statusCode: 400 }));
    }
    // Readers decode #xx in names, so the check does too.
    for (const escaped of ["/J#61vaScript", "/J#53", "/L#61unch"]) {
      const pdf = Buffer.from(`%PDF-1.7
<< /S ${escaped} (x) >>`);
      expect(() => decodeDocumentFile("application/pdf", b64(pdf)), escaped)
        .toThrow(expect.objectContaining({ code: "EMPLOYEE_DOCUMENT_FILE_ACTIVE_CONTENT" }));
    }
    // Scanners write /OpenAction to open on page one; that alone is not refused.
    expect(decodeDocumentFile("application/pdf", b64(Buffer.from("%PDF-1.7 /OpenAction [3 0 R /Fit]")))).toBeTruthy();
    // A name that merely starts with JS is not active content.
    expect(decodeDocumentFile("application/pdf", b64(Buffer.from("%PDF-1.7 /JSONData")))).toBeTruthy();
  });

  it("D-07: every download is a sandboxed, uncached attachment", () => {
    const headers = fileDownloadHeaders("application/pdf", "KTP-2026-11-11.pdf");
    expect(headers["Content-Disposition"]).toBe('attachment; filename="KTP-2026-11-11.pdf"');
    expect(headers["Cache-Control"]).toBe("private, no-store");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Content-Security-Policy"]).toContain("sandbox");
  });

  it("D-03: names a download after the type and the WIB date, never the original name", () => {
    expect(downloadFileName("KTP", new Date("2026-11-10T18:00:00Z"), "application/pdf")).toBe("KTP-2026-11-11.pdf");
    expect(downloadFileName("SK", new Date("2026-11-10T01:00:00Z"), "image/png")).toBe("SK-2026-11-10.png");
    expect(downloadFileName("IJAZAH", new Date("2026-11-10T01:00:00Z"), "image/jpeg")).toBe("IJAZAH-2026-11-10.jpg");
  });

  it("D-05: masks to the last four characters without separators", () => {
    expect(numberLast4("3201.0123.4567-8901")).toBe("8901");
    expect(numberLast4("12.345.678.9-012.345")).toBe("2345");
    expect(numberLast4("AB1")).toBe("AB1");
  });

  it("D-04, §5.2: expiry, title and date rules", () => {
    const today = "2026-11-11";
    expect(() => validateMetadata({ documentType: "SIM" }, today)).toThrow(expect.objectContaining({ field: "expiresOn" }));
    expect(validateMetadata({ documentType: "SIM", expiresOn: "2030-01-01" }, today).expiresOn).toBe("2030-01-01");
    expect(() => validateMetadata({ documentType: "LAINNYA" }, today)).toThrow(expect.objectContaining({ field: "title" }));
    expect(() => validateMetadata({ documentType: "LAINNYA", title: "   " }, today)).toThrow(expect.objectContaining({ field: "title" }));
    expect(() => validateMetadata({ documentType: "KTP", issuedOn: "2026-11-12" }, today)).toThrow(expect.objectContaining({ field: "issuedOn" }));
    expect(() => validateMetadata({ documentType: "KTP", issuedOn: "2026-02-30" }, today)).toThrow(expect.objectContaining({ field: "issuedOn" }));
    expect(() => validateMetadata({ documentType: "SERTIFIKAT", issuedOn: "2026-01-01", expiresOn: "2025-12-31" }, today))
      .toThrow(expect.objectContaining({ field: "expiresOn" }));
    expect(() => validateMetadata({ documentType: "KTP", documentNumber: "3201<script>" }, today))
      .toThrow(expect.objectContaining({ field: "documentNumber" }));
    const value = validateMetadata({ documentType: "KTP", title: " ", documentNumber: " 3201 0123 ", notes: "" }, today);
    expect(value).toEqual({ title: null, issuer: null, issuedOn: null, expiresOn: null, documentNumber: "3201 0123", notes: null });
  });

  it("D-15: counts days in WIB calendar days, negative once past", () => {
    expect(daysUntil("2026-11-11", "2026-11-11")).toBe(0);
    expect(daysUntil("2027-01-10", "2026-11-11")).toBe(60);
    expect(daysUntil("2026-11-01", "2026-11-11")).toBe(-10);
  });

  it("the type catalog matches the database CHECK in migration 0142", async () => {
    const sql = await readFile(new URL("../migrations/0142_employee_documents.sql", import.meta.url), "utf8");
    const check = /document_type text NOT NULL CHECK \(document_type IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? "";
    expect(check.match(/'[A-Z_]+'/g)?.map((value) => value.slice(1, -1))).toEqual([...DOCUMENT_TYPES]);
  });

  it("D-09: HC Admin carries both keys; legacy Super Admin and unit-scoped roles carry none", () => {
    for (const key of EMPLOYEE_DOCUMENT_PERMISSIONS) {
      expect(HC_ADMIN_PERMISSIONS as readonly string[]).toContain(key);
      expect(ADMIN_PERMISSIONS as readonly string[]).not.toContain(key);
      expect(UNIT_SCOPED_PERMISSIONS).not.toContain(key);
    }
  });
});

describe("EMP-011 route guards", () => {
  async function appFor(principal: AuthPrincipal | null, permissions: string[] = []) {
    const app = Fastify({ logger: false });
    // Guards answer before any query, so an inert pool proves no data is read.
    await registerEmployeeDocumentRoutes(app, {} as Pool, { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32) } as ApiConfig, {
      getSession: async () => (principal ? { principal, expiresAt: "2099-01-01T00:00:00Z" } : null),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never);
    return app;
  }

  const employee = { id: "e", email: "e@example.invalid", principalType: "EMPLOYEE" as const };
  const id = "not-a-uuid";
  const readRoutes: Array<{ method: "GET"; url: string }> = [
    { method: "GET", url: "/admin/employee-documents/expiring" },
    { method: "GET", url: "/admin/employee-documents/pending" },
    { method: "GET", url: `/admin/employee-documents/employees/${id}` },
    { method: "GET", url: `/admin/employee-documents/${id}/file` },
  ];
  const manageRoutes: Array<{ method: "POST" | "PATCH"; url: string }> = [
    { method: "POST", url: `/admin/employee-documents/employees/${id}` },
    { method: "PATCH", url: `/admin/employee-documents/${id}` },
    { method: "POST", url: `/admin/employee-documents/${id}/verify` },
    { method: "POST", url: `/admin/employee-documents/${id}/reject` },
    { method: "POST", url: `/admin/employee-documents/${id}/remove` },
  ];
  const selfRoutes = [
    { method: "GET" as const, url: "/me/employee-documents" },
    { method: "POST" as const, url: "/me/employee-documents" },
    { method: "GET" as const, url: `/me/employee-documents/${id}/file` },
    { method: "POST" as const, url: `/me/employee-documents/${id}/withdraw` },
  ];
  const inject = (app: Awaited<ReturnType<typeof appFor>>, route: { method: string; url: string }) =>
    app.inject({ method: route.method as "GET", url: route.url, ...(route.method === "GET" ? {} : { payload: {} }) });

  it("answers 401 without a session and 403 to a non-employee on /me routes", async () => {
    const anonymous = await appFor(null);
    for (const route of [...readRoutes, ...manageRoutes, ...selfRoutes]) {
      expect((await inject(anonymous, route)).statusCode, route.url).toBe(401);
    }
    for (const principalType of ["SUPER_ADMIN", "FOUNDATION_BOARD"] as const) {
      const other = await appFor({ id: "x", email: "x@example.invalid", principalType });
      for (const route of selfRoutes) expect((await inject(other, route)).statusCode, route.url).toBe(403);
    }
  });

  it("EMP-011-A: every admin route needs its permission before validating anything", async () => {
    // Neighbouring HC permissions — including everything a manager or the legacy Super Admin
    // carries — never open the archive (D-09).
    const neighbours = await appFor(employee, [
      ...ADMIN_PERMISSIONS, "employees.read.unit", "employees.read.all", "employment.read", "employment.manage",
      "documents.read", "documents.manage", "employee_cards.manage", "training.manage",
    ]);
    for (const route of [...readRoutes, ...manageRoutes]) {
      const response = await inject(neighbours, route);
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(response.json().code).toBe("EMPLOYEE_DOCUMENT_FORBIDDEN");
    }
    // A Super Admin principal is refused too: no legacy compatibility (D-09).
    const superAdmin = await appFor({ id: "s", email: "s@example.invalid", principalType: "SUPER_ADMIN" }, [...ADMIN_PERMISSIONS]);
    for (const route of [...readRoutes, ...manageRoutes]) expect((await inject(superAdmin, route)).statusCode).toBe(403);
    // read does not open manage routes.
    const reader = await appFor(employee, ["employee_documents.read"]);
    for (const route of manageRoutes) expect((await inject(reader, route)).statusCode, route.url).toBe(403);
    // With the permission the same requests reach validation (400), still without a query.
    const manager = await appFor(employee, ["employee_documents.manage"]);
    for (const route of manageRoutes) expect((await inject(manager, route)).statusCode, route.url).toBe(400);
    for (const route of readRoutes.filter((entry) => entry.url.includes(id))) {
      expect((await inject(reader, route)).statusCode, route.url).toBe(400);
    }
  });

  it("refuses invalid worklist filters and upload bodies before touching the database", async () => {
    const reader = await appFor(employee, ["employee_documents.read"]);
    for (const url of [
      "/admin/employee-documents/expiring?withinDays=45",
      "/admin/employee-documents/expiring?pageSize=101",
      "/admin/employee-documents/pending?page=0",
    ]) {
      expect((await reader.inject({ method: "GET", url })).statusCode, url).toBe(400);
    }
    const manager = await appFor(employee, ["employee_documents.manage"]);
    const valid = "00000000-0000-4000-8000-000000000001";
    const upload = (payload: unknown) => manager.inject({ method: "POST", url: `/admin/employee-documents/employees/${valid}`, payload: payload as object });
    expect((await upload({ documentType: "KTP" })).statusCode).toBe(400);
    expect((await upload({ documentType: "PASSPORT", file: { contentType: "application/pdf", contentBase64: b64(PDF) } })).statusCode).toBe(400);
    expect((await upload({ documentType: "KTP", file: { contentType: "text/html", contentBase64: b64(PDF) } })).statusCode).toBe(400);
    expect((await upload({ documentType: "KTP", fileName: "ktp.pdf", file: { contentType: "application/pdf", contentBase64: b64(PDF) } })).statusCode).toBe(400);
    const mismatch = await upload({ documentType: "KTP", file: { contentType: "application/pdf", contentBase64: b64(PNG) } });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().code).toBe("EMPLOYEE_DOCUMENT_FILE_INVALID");
    const reason = (url: string, payload: unknown) => manager.inject({ method: "POST", url, payload: payload as object });
    expect((await reason(`/admin/employee-documents/${valid}/reject`, { reason: "no" })).statusCode).toBe(400);
    expect((await reason(`/admin/employee-documents/${valid}/remove`, {})).statusCode).toBe(400);
  });
});
