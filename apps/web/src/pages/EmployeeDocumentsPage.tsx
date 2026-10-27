// DOC-001 / DOC-002 employee surface: request a certificate, read issued letters,
// and acknowledge a warning letter. Spec: docs/domain/hr-documents.md.

import { FileText, Loader2, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/layouts/AppShell";
import { employeeShellUser } from "@/lib/employeeIdentity";
import { getEmployeeLeaveSummary, type EmployeeLeaveSummary } from "@/lib/employeeLeave";
import {
  acknowledgeDisciplinaryLetter,
  cancelDocumentRequest,
  documentStatusLabel,
  getMyDisciplinaryLetters,
  getMyDocumentRequests,
  getMyDocumentTypes,
  getMyIssuedDocuments,
  submitDocumentRequest,
  type DisciplinaryLetterSummary,
  type DocumentRequestSummary,
  type DocumentTypeOption,
  type IssuedDocumentSummary,
} from "@/lib/hrDocuments";

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

export function EmployeeDocumentsPage() {
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [types, setTypes] = useState<DocumentTypeOption[]>([]);
  const [requests, setRequests] = useState<DocumentRequestSummary[]>([]);
  const [issued, setIssued] = useState<IssuedDocumentSummary[]>([]);
  const [letters, setLetters] = useState<DisciplinaryLetterSummary[]>([]);
  const [documentCode, setDocumentCode] = useState("");
  const [purpose, setPurpose] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const user = useMemo(() => employeeShellUser(employee), [employee]);

  const load = async () => {
    setLoading(true);
    try {
      const [summary, typeList, requestList, issuedList, letterList] = await Promise.allSettled([
        getEmployeeLeaveSummary(),
        getMyDocumentTypes(),
        getMyDocumentRequests(),
        getMyIssuedDocuments(),
        getMyDisciplinaryLetters(),
      ]);
      if (summary.status === "fulfilled") setEmployee(summary.value.employee);
      if (typeList.status === "rejected") throw typeList.reason;
      setTypes(typeList.value);
      if (!documentCode && typeList.value[0]) setDocumentCode(typeList.value[0].code);
      if (requestList.status === "fulfilled") setRequests(requestList.value);
      if (issuedList.status === "fulfilled") setIssued(issuedList.value);
      if (letterList.status === "fulfilled") setLetters(letterList.value);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Dokumen tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await submitDocumentRequest(documentCode, purpose);
      setPurpose("");
      setNotice("Permintaan surat terkirim dan menunggu keputusan Human Capital.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Permintaan surat belum dapat dikirim.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (requestId: string) => {
    setBusy(true);
    try {
      await cancelDocumentRequest(requestId);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Permintaan belum dapat dibatalkan.");
    } finally {
      setBusy(false);
    }
  };

  const acknowledge = async (letterId: string) => {
    setBusy(true);
    try {
      await acknowledgeDisciplinaryLetter(letterId);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Konfirmasi belum dapat disimpan.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell user={user} activeItem="Dokumen">
      <section className="mx-auto max-w-4xl">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-primary-deep">Layanan Pegawai</p>
        <h1 className="mt-1 text-2xl font-bold text-brand-heading sm:text-3xl">Dokumen Kepegawaian</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Minta surat keterangan dan lihat dokumen yang sudah terbit untuk Anda. Surat keterangan penghasilan belum tersedia.
        </p>

        {error ? <div className="mt-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
        {notice ? <div className="mt-5 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}

        {loading ? (
          <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat dokumen...</div>
        ) : (
          <>
            <form onSubmit={submit} className="mt-6 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
              <h2 className="text-sm font-bold text-brand-heading">Minta surat keterangan</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="text-sm font-semibold text-brand-heading">
                  Jenis surat
                  <select
                    value={documentCode}
                    onChange={(event) => setDocumentCode(event.target.value)}
                    className="mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading"
                  >
                    {types.map((type) => <option key={type.code} value={type.code}>{type.label}</option>)}
                  </select>
                </label>
                <label className="text-sm font-semibold text-brand-heading sm:col-span-2">
                  Keperluan
                  <textarea
                    value={purpose}
                    onChange={(event) => setPurpose(event.target.value)}
                    required
                    minLength={5}
                    maxLength={500}
                    rows={3}
                    placeholder="Contoh: pengajuan beasiswa anak"
                    className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm font-normal text-brand-heading"
                  />
                </label>
              </div>
              <button
                type="submit"
                disabled={busy || !documentCode || purpose.trim().length < 5}
                className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50"
              >
                Kirim permintaan
              </button>
            </form>

            <section className="mt-6 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
              <h2 className="text-sm font-bold text-brand-heading">Permintaan saya</h2>
              {requests.length ? (
                <ul className="mt-3 divide-y divide-border/70">
                  {requests.map((request) => (
                    <li key={request.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-brand-heading">{request.documentLabel}</p>
                        <p className="text-sm text-muted-foreground">{request.purpose}</p>
                        <p className="mt-1 text-[11px] font-semibold text-muted-foreground">
                          {documentStatusLabel(request.status)} · {formatDate(request.createdAt)}
                          {request.documentNumber ? ` · ${request.documentNumber}` : ""}
                        </p>
                        {request.decisionNote ? <p className="mt-1 text-sm text-muted-foreground">Catatan: {request.decisionNote}</p> : null}
                      </div>
                      {request.status === "SUBMITTED" ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void cancel(request.id)}
                          className="min-h-11 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50"
                        >
                          Batalkan
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">Belum ada permintaan surat.</p>
              )}
            </section>

            <section className="mt-6 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
              <h2 className="text-sm font-bold text-brand-heading">Surat yang sudah terbit</h2>
              {issued.length ? (
                <ul className="mt-3 divide-y divide-border/70">
                  {issued.map((document) => (
                    <li key={document.id} className="py-3">
                      <p className="flex items-center gap-2 font-semibold text-brand-heading">
                        <FileText className="h-4 w-4 text-brand-primary-deep" aria-hidden="true" />
                        {String(document.contentSnapshot.documentLabel ?? document.documentCode)}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {document.documentNumber} · {formatDate(document.issuedAt)}
                        {document.status === "REVOKED" ? " · dibatalkan" : ""}
                      </p>
                      <p className="mt-1 text-[11px] font-semibold text-muted-foreground">
                        Ditandatangani {document.signer.name ?? "-"} ({document.signer.title})
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">Belum ada surat yang terbit.</p>
              )}
            </section>

            {letters.length ? (
              <section className="mt-6 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
                <h2 className="flex items-center gap-2 text-sm font-bold text-brand-heading">
                  <ShieldAlert className="h-4 w-4 text-danger-ink" aria-hidden="true" /> Surat peringatan
                </h2>
                <ul className="mt-3 divide-y divide-border/70">
                  {letters.map((letter) => (
                    <li key={letter.id} className="py-3">
                      <p className="font-semibold text-brand-heading">{letter.level} — {letter.subject}</p>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">{letter.narrative}</p>
                      <p className="mt-1 text-[11px] font-semibold text-muted-foreground">
                        {letter.documentNumber} · berlaku {formatDate(letter.effectiveDate)} s.d. {formatDate(letter.expiresOn)}
                        {letter.active ? "" : " · sudah tidak berlaku"}
                      </p>
                      {letter.acknowledgedAt ? (
                        <p className="mt-2 text-[11px] font-semibold text-muted-foreground">Dibaca {formatDate(letter.acknowledgedAt)}</p>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void acknowledge(letter.id)}
                          className="mt-2 min-h-11 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50"
                        >
                          Saya telah membaca
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  Konfirmasi membaca adalah tanda terima, bukan persetujuan, dan tidak membatalkan surat.
                </p>
              </section>
            ) : null}
          </>
        )}
      </section>
    </AppShell>
  );
}
