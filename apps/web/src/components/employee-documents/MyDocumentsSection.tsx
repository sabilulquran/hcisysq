// EMP-011 §10: Data Saya → "Dokumen Pribadi". The employee sees, downloads and proposes their own
// documents; one HC officer verifies each proposal (D-06). The API derives the employee from the
// session, so nothing here can name another person.

import { Download, FileText, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { DocumentForm } from "@/components/employee-documents/DocumentForm";
import { formatDate } from "@/lib/employment";
import {
  STATUS_LABEL,
  expiryText,
  getMyDocuments,
  myDocumentFileUrl,
  proposeMyDocument,
  statusTone,
  withdrawMyDocument,
  type MyDocumentList,
} from "@/lib/employeeDocuments";

type View = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: MyDocumentList };

const quietButton = "inline-flex min-h-11 items-center gap-1 rounded-xl border border-border px-3 text-xs font-bold text-foreground hover:bg-surface";
const primaryButton = "inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary-deep px-4 text-sm font-bold text-white disabled:opacity-60";

export function MyDocumentsSection() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [page, setPage] = useState(1);
  const [proposing, setProposing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void getMyDocuments(page)
      .then((data) => setView({ kind: "ready", data }))
      .catch((cause: unknown) => setView({ kind: "error", message: cause instanceof Error ? cause.message : "Dokumen tidak dapat dimuat." }));
  }, [page]);

  useEffect(load, [load]);

  return (
    <section aria-labelledby="my-documents-title" className="space-y-3 rounded-2xl border border-border/70 bg-surface-raised p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="my-documents-title" className="text-base font-bold text-brand-heading">Dokumen Pribadi</h2>
          <p className="text-xs text-muted-foreground">
            KTP, KK, ijazah, sertifikat, dan dokumen lain yang tersimpan di HC. Hanya Anda dan petugas HC yang berwenang dapat membukanya.
          </p>
        </div>
        {view.kind === "ready" && view.data.canPropose && !proposing ? (
          <button type="button" className={primaryButton} onClick={() => { setNotice(null); setProposing(true); }}>
            <Upload className="h-4 w-4" aria-hidden="true" /> Unggah dokumen
          </button>
        ) : null}
      </div>

      {notice ? <p role="status" className="rounded-xl bg-success-soft px-3 py-2 text-sm text-success-ink">{notice}</p> : null}
      {error ? <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger-ink">{error}</p> : null}
      {view.kind === "loading" ? <p className="text-sm text-muted-foreground">Memuat dokumen…</p> : null}
      {view.kind === "error" ? <p role="alert" className="text-sm text-danger-ink">{view.message}</p> : null}

      {view.kind === "ready" && proposing ? (
        <>
          <p className="text-xs text-muted-foreground">
            Dokumen yang Anda unggah menunggu verifikasi HC sebelum tercatat. Paling banyak {view.data.maxPending} usulan menunggu sekaligus.
          </p>
          <DocumentForm
            mode="self-upload"
            types={view.data.types}
            replaceable={view.data.items}
            onCancel={() => setProposing(false)}
            onSubmit={async (draft, file) => {
              await proposeMyDocument(draft, file!);
              setProposing(false);
              setNotice("Dokumen terkirim dan menunggu verifikasi HC.");
              load();
            }}
          />
        </>
      ) : null}

      {view.kind === "ready" ? (
        view.data.items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            <FileText className="mx-auto mb-2 h-6 w-6" aria-hidden="true" />
            Belum ada dokumen tersimpan.
          </div>
        ) : (
          <ul className="space-y-2">
            {view.data.items.map((document) => {
              const expiry = expiryText(document, formatDate);
              return (
                <li key={document.id} className="rounded-xl border border-border/70 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-bold text-brand-heading">{document.typeLabel}{document.title ? ` · ${document.title}` : ""}</p>
                      <p className="text-xs text-muted-foreground">
                        {[document.numberMasked, document.issuedOn ? `terbit ${formatDate(document.issuedOn)}` : null].filter(Boolean).join(" · ") || "—"}
                      </p>
                      {expiry ? <p className="mt-1 text-xs font-semibold">{expiry}</p> : null}
                      {document.status === "REJECTED" && document.decisionReason ? (
                        <p className="mt-1 text-xs text-danger-ink">Ditolak HC: {document.decisionReason}</p>
                      ) : null}
                    </div>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${statusTone(document)}`}>{STATUS_LABEL[document.status]}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {document.status === "VERIFIED" || document.status === "PENDING_REVIEW" ? (
                      <a className={quietButton} href={myDocumentFileUrl(document.id)}>
                        <Download className="h-3.5 w-3.5" aria-hidden="true" /> Unduh
                      </a>
                    ) : null}
                    {document.status === "PENDING_REVIEW" ? (
                      <button
                        type="button"
                        className={quietButton}
                        onClick={() => {
                          setError(null);
                          void withdrawMyDocument(document.id)
                            .then(() => { setNotice("Usulan ditarik dan berkasnya dihapus."); load(); })
                            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Usulan tidak dapat ditarik."));
                        }}
                      >
                        Tarik usulan
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
      {view.kind === "ready" && view.data.pagination.total > view.data.pagination.pageSize ? (
        <PaginationBar page={view.data.pagination.page} pageSize={view.data.pagination.pageSize} total={view.data.pagination.total} onPageChange={setPage} />
      ) : null}
    </section>
  );
}
