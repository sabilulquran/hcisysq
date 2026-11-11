// EMP-011 §10: employee detail → tab "Dokumen" for HC. Reading needs employee_documents.read,
// every write employee_documents.manage; the API authorizes and audits each call (the list read
// itself is audited, D-11).

import { Download, FileText, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { DocumentForm } from "@/components/employee-documents/DocumentForm";
import { formatDate } from "@/lib/employment";
import {
  EmployeeDocumentApiError,
  STATUS_LABEL,
  employeeDocumentFileUrl,
  expiryText,
  formatBytes,
  getEmployeeDocuments,
  rejectEmployeeDocument,
  removeEmployeeDocument,
  statusTone,
  updateEmployeeDocument,
  uploadEmployeeDocument,
  verifyEmployeeDocument,
  type EmployeeDocument,
  type EmployeeDocumentList,
} from "@/lib/employeeDocuments";

type View =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: EmployeeDocumentList };

const quietButton = "inline-flex min-h-9 items-center gap-1 rounded-xl border border-border px-3 text-xs font-bold text-foreground hover:bg-surface";
const primaryButton = "inline-flex min-h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground hover:bg-brand-primary-deep";

export function EmployeeDocumentsPanel({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState(false);
  const [form, setForm] = useState<{ mode: "hc-upload" } | { mode: "hc-edit"; document: EmployeeDocument } | null>(null);
  const [decision, setDecision] = useState<{ action: "reject" | "remove"; document: EmployeeDocument } | null>(null);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setView({ kind: "loading" });
    void getEmployeeDocuments(employeeId, { page, includeHistory: history })
      .then((data) => setView({ kind: "ready", data }))
      .catch((cause: unknown) => {
        if (cause instanceof EmployeeDocumentApiError && cause.status === 403) setView({ kind: "forbidden" });
        else setView({ kind: "error", message: cause instanceof Error ? cause.message : "Dokumen tidak dapat dimuat." });
      });
  }, [employeeId, page, history]);

  useEffect(load, [load]);

  async function run(action: () => Promise<unknown>, done: string) {
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
      setDecision(null);
      setReason("");
      load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tindakan tidak dapat diproses.");
    }
  }

  if (view.kind === "loading") return <p className="text-sm text-muted-foreground">Memuat dokumen…</p>;
  if (view.kind === "forbidden") {
    return <p className="text-sm text-muted-foreground">Akun ini tidak berhak membuka arsip dokumen pegawai.</p>;
  }
  if (view.kind === "error") return <p role="alert" className="text-sm text-danger-ink">{view.message}</p>;

  const { data } = view;
  const writable = canManage && data.employee.managementScope === "MANAGED";
  return (
    <section aria-label="Dokumen pegawai" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Pindaian KTP, KK, ijazah, sertifikat, dan dokumen pribadi lain. Setiap unduhan tercatat di audit.
        </p>
        <div className="flex flex-wrap gap-2">
          <label className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            <input type="checkbox" checked={history} onChange={(event) => { setPage(1); setHistory(event.target.checked); }} />
            Tampilkan riwayat
          </label>
          {writable && !form ? (
            <button type="button" className={primaryButton} onClick={() => setForm({ mode: "hc-upload" })}>
              <Upload className="h-4 w-4" aria-hidden="true" /> Unggah dokumen
            </button>
          ) : null}
        </div>
      </div>

      {notice ? <p role="status" className="rounded-xl bg-success-soft px-3 py-2 text-sm text-success-ink">{notice}</p> : null}
      {error ? <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger-ink">{error}</p> : null}

      {form ? (
        <DocumentForm
          mode={form.mode}
          types={data.types}
          replaceable={data.items}
          {...(form.mode === "hc-edit" ? { initial: form.document } : {})}
          onCancel={() => setForm(null)}
          onSubmit={async (draft, file, clearNumber) => {
            if (form.mode === "hc-edit") {
              await updateEmployeeDocument(form.document.id, draft, clearNumber);
              setNotice("Data dokumen diperbarui.");
            } else {
              await uploadEmployeeDocument(employeeId, draft, file!);
              setNotice("Dokumen diunggah dan terverifikasi.");
            }
            setForm(null);
            load();
          }}
        />
      ) : null}

      {decision ? (
        <form
          className="space-y-2 rounded-2xl border border-warning-line bg-warning-soft p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () => decision.action === "reject"
                ? rejectEmployeeDocument(decision.document.id, reason)
                : removeEmployeeDocument(decision.document.id, reason),
              decision.action === "reject" ? "Usulan ditolak; berkasnya dihapus." : "Isi berkas dihapus permanen.",
            );
          }}
        >
          <p className="text-sm font-bold text-warning-ink">
            {decision.action === "reject"
              ? `Tolak usulan ${decision.document.typeLabel}? Alasan ini dibaca pegawai, dan berkasnya dihapus.`
              : `Hapus isi berkas ${decision.document.typeLabel}? Tindakan ini permanen; data ringkas dan audit tetap tersimpan.`}
          </p>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-semibold">Alasan (5–300 karakter)</span>
            <input className="h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm" minLength={5} maxLength={300} required value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="flex gap-2">
            <button type="submit" className={primaryButton}>{decision.action === "reject" ? "Tolak usulan" : "Hapus berkas"}</button>
            <button type="button" className={quietButton} onClick={() => { setDecision(null); setReason(""); }}>Batal</button>
          </div>
        </form>
      ) : null}

      {data.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          <FileText className="mx-auto mb-2 h-6 w-6" aria-hidden="true" />
          {data.pagination.total > 0 ? "Halaman ini kosong." : "Belum ada dokumen untuk pegawai ini."}
        </div>
      ) : (
        <ul className="space-y-3">
          {data.items.map((document) => {
            const expiry = expiryText(document, formatDate);
            return (
              <li key={document.id} className="rounded-2xl border border-border/70 bg-surface-raised p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold text-brand-heading">
                      {document.typeLabel}{document.title ? ` · ${document.title}` : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {[document.numberMasked, document.issuer, document.issuedOn ? `terbit ${formatDate(document.issuedOn)}` : null,
                        document.source === "EMPLOYEE" ? "diunggah pegawai" : "diunggah HC",
                        document.file && !document.file.purged ? formatBytes(document.file.byteSize) : null]
                        .filter(Boolean).join(" · ")}
                    </p>
                    {expiry ? <p className="mt-1 text-xs font-semibold">{expiry}</p> : null}
                    {document.decisionReason ? <p className="mt-1 text-xs text-muted-foreground">Alasan penolakan: {document.decisionReason}</p> : null}
                    {document.endReason ? <p className="mt-1 text-xs text-muted-foreground">Alasan penghapusan: {document.endReason}</p> : null}
                    {document.notes ? <p className="mt-1 text-xs text-muted-foreground">Catatan HC: {document.notes}</p> : null}
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${statusTone(document)}`}>{STATUS_LABEL[document.status]}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {document.file && !document.file.purged ? (
                    <a className={quietButton} href={employeeDocumentFileUrl(document.id)}>
                      <Download className="h-3.5 w-3.5" aria-hidden="true" /> Unduh
                    </a>
                  ) : null}
                  {writable && document.status === "PENDING_REVIEW" ? (
                    <>
                      <button type="button" className={quietButton} onClick={() => void run(() => verifyEmployeeDocument(document.id), "Usulan diverifikasi.")}>Verifikasi</button>
                      <button type="button" className={quietButton} onClick={() => setDecision({ action: "reject", document })}>Tolak</button>
                    </>
                  ) : null}
                  {writable && (document.status === "PENDING_REVIEW" || document.status === "VERIFIED") ? (
                    <button type="button" className={quietButton} onClick={() => setForm({ mode: "hc-edit", document })}>Ubah data</button>
                  ) : null}
                  {writable && (document.status === "VERIFIED" || document.status === "REPLACED") ? (
                    <button type="button" className={quietButton} onClick={() => setDecision({ action: "remove", document })}>Hapus berkas</button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {data.pagination.total > data.pagination.pageSize ? (
        <PaginationBar page={data.pagination.page} pageSize={data.pagination.pageSize} total={data.pagination.total} onPageChange={setPage} />
      ) : null}
    </section>
  );
}
