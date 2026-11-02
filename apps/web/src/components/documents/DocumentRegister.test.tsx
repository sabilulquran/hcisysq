// DOC-002-F register and revoke dialog: the pure pieces and a static render, as this repo tests pages.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DocumentRegisterSection,
  RegisterRow,
  RevokeDocumentDialog,
  emptyRegisterMessage,
  type RegisterView,
} from "@/components/documents/DocumentRegister";
import {
  DEFAULT_REGISTER_FILTER,
  HrDocumentApiError,
  getDocumentRegister,
  readRegisterFilter,
  revokeIssuedDocument,
  revokeReasonProblem,
  writeRegisterFilter,
  type RegisterEntry,
  type RegisterFilter,
} from "@/lib/hrDocuments";

const warningLetter: RegisterEntry = {
  id: "11111111-1111-4111-8111-111111111111",
  documentKind: "DISCIPLINARY",
  documentCode: "SP2",
  documentNumber: "3/SP2/YSQ/XI/2026",
  status: "ISSUED",
  issuedAt: "2026-11-01T03:00:00Z",
  revokedAt: null,
  revokeReason: null,
  signer: null,
  employeeName: null,
  employeeNumber: null,
};

const revokedCertificate: RegisterEntry = {
  ...warningLetter,
  id: "22222222-2222-4222-8222-222222222222",
  documentKind: "CERTIFICATE",
  documentCode: "KETERANGAN_KERJA",
  documentNumber: "7/SKK/YSQ/X/2026",
  status: "REVOKED",
  revokedAt: "2026-11-02T02:00:00Z",
  revokeReason: "Diterbitkan untuk keperluan yang salah",
  employeeName: "Pegawai Sintetis",
  employeeNumber: "SYN-001",
};

function row(entry: RegisterEntry, canRevoke: boolean, busy = false) {
  return renderToStaticMarkup(<ul><RegisterRow entry={entry} canRevoke={canRevoke} busy={busy} onRevoke={() => {}} /></ul>);
}

function section(view: RegisterView, filter: RegisterFilter = DEFAULT_REGISTER_FILTER, canRevoke = true) {
  return renderToStaticMarkup(
    <DocumentRegisterSection filter={filter} view={view} canRevoke={canRevoke} busy={false}
      onFilterChange={() => {}} onRevoke={() => {}} onRetry={() => {}} />,
  );
}

describe("DOC-002-F1 Batalkan", () => {
  it("is offered on an issued letter to a holder of documents.correct", () => {
    expect(row(warningLetter, true)).toContain("Batalkan");
  });

  it("is hidden from an account without documents.correct", () => {
    expect(row(warningLetter, false)).not.toContain("Batalkan");
  });

  it("is never offered on a letter that is already revoked", () => {
    expect(row(revokedCertificate, true)).not.toContain(">Batalkan<");
  });

  it("locks while a revocation is in flight", () => {
    expect(row(warningLetter, true, true)).toContain("disabled");
  });
});

describe("DOC-002-F2/F5 register rows", () => {
  it("shows a warning letter by number and level only", () => {
    const markup = row(warningLetter, true);
    expect(markup).toContain("3/SP2/YSQ/XI/2026");
    expect(markup).toContain("SP2");
    expect(markup).toContain("Terbit");
    expect(markup).not.toContain("null");
  });

  it("shows a revoked letter as Dibatalkan with its date and reason", () => {
    const markup = row(revokedCertificate, true);
    expect(markup).toContain("Dibatalkan");
    expect(markup).toContain("Diterbitkan untuk keperluan yang salah");
    expect(markup).toContain("Pegawai Sintetis");
  });
});

describe("ENG-LIST-001-M register states", () => {
  it("covers loading, forbidden and error with a retry", () => {
    expect(section({ kind: "loading" })).toContain("Memuat register");
    expect(section({ kind: "forbidden" })).toContain("tidak berhak");
    const failed = section({ kind: "error", message: "Server sedang sibuk." });
    expect(failed).toContain("Server sedang sibuk.");
    expect(failed).toContain("Coba lagi");
  });

  it("names the tab and filter when the list is empty", () => {
    expect(section({ kind: "ready", items: [], total: 0 })).toContain("Belum ada surat keterangan yang terbit.");
    expect(emptyRegisterMessage({ ...DEFAULT_REGISTER_FILTER, kind: "DISCIPLINARY", status: "REVOKED" }))
      .toBe("Tidak ada surat peringatan yang dibatalkan.");
  });

  it("offers a way back from a page past the last", () => {
    const markup = section({ kind: "ready", items: [], total: 30 }, { ...DEFAULT_REGISTER_FILTER, page: 9 });
    expect(markup).toContain("Kembali ke halaman 1");
  });

  it("pages with the shared bar and explains what the warning-letter tab leaves out", () => {
    const markup = section(
      { kind: "ready", items: [warningLetter], total: 26 },
      { ...DEFAULT_REGISTER_FILTER, kind: "DISCIPLINARY", page: 2 },
    );
    expect(markup).toContain("Menampilkan 26–26 dari 26");
    expect(markup).toContain("Nama pegawai dan isi surat tidak");
  });
});

describe("ENG-LIST-001-J register query string", () => {
  it("reads defaults and refuses values outside the contract", () => {
    expect(readRegisterFilter("")).toEqual(DEFAULT_REGISTER_FILTER);
    expect(readRegisterFilter("?registerKind=X&registerStatus=Y&registerPage=-2&registerPageSize=1000"))
      .toEqual(DEFAULT_REGISTER_FILTER);
  });

  it("round-trips and keeps unrelated parameters", () => {
    const filter: RegisterFilter = { kind: "DISCIPLINARY", status: "REVOKED", page: 3, pageSize: 50 };
    const search = writeRegisterFilter("?other=1", filter);
    expect(search).toContain("other=1");
    expect(readRegisterFilter(search)).toEqual(filter);
    expect(writeRegisterFilter("", DEFAULT_REGISTER_FILTER)).toBe("");
  });
});

describe("DOC-002-F3 revoke reason", () => {
  it("is required and at least ten characters after trimming", () => {
    expect(revokeReasonProblem("")).toContain("wajib");
    expect(revokeReasonProblem("   singkat   ")).toContain("minimal 10");
    expect(revokeReasonProblem("x".repeat(501))).toContain("maksimal 500");
    expect(revokeReasonProblem("  Diterbitkan atas pegawai yang keliru ")).toBeNull();
  });

  it("keeps the confirm button disabled until a reason is typed", () => {
    const markup = renderToStaticMarkup(
      <RevokeDocumentDialog entry={warningLetter} busy={false} error={null} onCancel={() => {}} onConfirm={() => {}} />,
    );
    expect(markup).toContain("Batalkan surat 3/SP2/YSQ/XI/2026?");
    expect(markup).toContain("Nomornya tetap terpakai");
    expect(markup).toMatch(/<button type="submit" disabled=""/);
  });

  it("shows the API's refusal inside the dialog", () => {
    const markup = renderToStaticMarkup(
      <RevokeDocumentDialog entry={warningLetter} busy={false} error="Alasan pembatalan wajib diisi, 10 sampai 500 karakter."
        onCancel={() => {}} onConfirm={() => {}} />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Alasan pembatalan wajib diisi, 10 sampai 500 karakter.");
  });
});

describe("register client", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("asks for one kind and status per page", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      items: [], pagination: { page: 2, pageSize: 25, total: 0, pageCount: 1 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await getDocumentRegister({ kind: "DISCIPLINARY", status: "ISSUED", page: 2, pageSize: 25 });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/admin/documents/register?kind=DISCIPLINARY&page=2&pageSize=25&status=ISSUED");
  });

  it("keeps the status and code of a refusal, so the screen can tell 403 from 409", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: "DOCUMENT_NOT_REVOCABLE", message: "Surat tidak ditemukan atau sudah dibatalkan.",
    }), { status: 409 })));
    const failure = await revokeIssuedDocument(warningLetter.id, "Diterbitkan atas pegawai yang keliru").catch((cause) => cause);
    expect(failure).toBeInstanceOf(HrDocumentApiError);
    expect(failure).toMatchObject({ status: 409, code: "DOCUMENT_NOT_REVOCABLE" });
  });
});
