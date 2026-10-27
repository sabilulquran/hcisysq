// DOC-001 / DOC-002 Human Capital surface: decide requests, issue letters, keep the
// register, and issue warning letters. Spec: docs/domain/hr-documents.md.
//
// The API authorizes every call; a section the account cannot read simply stays empty.

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { AdminShell } from "@/layouts/AdminShell";
import {
  approveDocumentRequest,
  documentStatusLabel,
  getDisciplinaryLetters,
  getDocumentRegister,
  getDocumentRequests,
  issueDisciplinaryLetter,
  issueDocumentRequest,
  rejectDocumentRequest,
  revokeIssuedDocument,
  type DisciplinaryLetterSummary,
  type DocumentRequestSummary,
  type IssuedDocumentSummary,
} from "@/lib/hrDocuments";

type RegisterRow = IssuedDocumentSummary & { employeeName: string; employeeNumber: string };

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

export function AdminDocumentsPage() {
  const [requests, setRequests] = useState<DocumentRequestSummary[]>([]);
  const [register, setRegister] = useState<RegisterRow[]>([]);
  const [letters, setLetters] = useState<DisciplinaryLetterSummary[]>([]);
  const [disciplineReadable, setDisciplineReadable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    employeeId: "", level: "SP1" as DisciplinaryLetterSummary["level"],
    subject: "", narrative: "", effectiveDate: new Date().toISOString().slice(0, 10),
  });

  const load = async () => {
    setLoading(true);
    try {
      const [requestList, registerList, letterList] = await Promise.allSettled([
        getDocumentRequests(),
        getDocumentRegister(),
        getDisciplinaryLetters(),
      ]);
      if (requestList.status === "rejected") throw requestList.reason;
      setRequests(requestList.value);
      if (registerList.status === "fulfilled") setRegister(registerList.value);
      setDisciplineReadable(letterList.status === "fulfilled");
      if (letterList.status === "fulfilled") setLetters(letterList.value);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Dokumen tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tindakan belum dapat diselesaikan.");
    } finally {
      setBusy(false);
    }
  };

  const reject = (requestId: string) => {
    const note = window.prompt("Alasan penolakan (minimal 5 karakter)");
    if (!note || note.trim().length < 5) return;
    void run(() => rejectDocumentRequest(requestId, note.trim()), "Permintaan ditolak.");
  };

  const revoke = (documentId: string) => {
    const reason = window.prompt("Alasan pembatalan (minimal 10 karakter)");
    if (!reason || reason.trim().length < 10) return;
    void run(() => revokeIssuedDocument(documentId, reason.trim()), "Surat dibatalkan; nomornya tetap terpakai.");
  };

  const submitLetter = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await issueDisciplinaryLetter(form);
      if (result.warnings.length) setNotice(`Surat terbit ${result.documentNumber}. ${result.warnings.join(" ")}`);
      setForm({ ...form, subject: "", narrative: "" });
    }, "Surat peringatan terbit.");
  };

  return (
    <AdminShell active="services" title="Dokumen Kepegawaian" description="Surat keterangan dan surat peringatan pegawai.">
      {error ? <div className="mb-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
      {notice ? <div className="mb-5 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat dokumen...</div>
      ) : (
        <div className="grid gap-6">
          <section className="rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
            <h2 className="text-sm font-bold text-brand-heading">Permintaan surat keterangan</h2>
            {requests.length ? (
              <ul className="mt-3 divide-y divide-border/70">
                {requests.map((request) => (
                  <li key={request.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-brand-heading">{request.employeeName} · {request.documentLabel}</p>
                      <p className="text-sm text-muted-foreground">{request.purpose}</p>
                      <p className="mt-1 text-[11px] font-semibold text-muted-foreground">
                        {documentStatusLabel(request.status)} · {formatDate(request.createdAt)}
                        {request.documentNumber ? ` · ${request.documentNumber}` : ""}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      {request.status === "SUBMITTED" ? (
                        <>
                          <button type="button" disabled={busy}
                            onClick={() => void run(() => approveDocumentRequest(request.id), "Permintaan disetujui.")}
                            className="min-h-11 rounded-xl bg-brand-primary px-3 text-sm font-bold text-brand-foreground disabled:opacity-50">
                            Setujui
                          </button>
                          <button type="button" disabled={busy} onClick={() => reject(request.id)}
                            className="min-h-11 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50">
                            Tolak
                          </button>
                        </>
                      ) : null}
                      {request.status === "APPROVED" ? (
                        <button type="button" disabled={busy}
                          onClick={() => void run(() => issueDocumentRequest(request.id), "Surat terbit.")}
                          className="min-h-11 rounded-xl bg-brand-primary px-3 text-sm font-bold text-brand-foreground disabled:opacity-50">
                          Terbitkan
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">Belum ada permintaan surat.</p>
            )}
          </section>

          <section className="rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
            <h2 className="text-sm font-bold text-brand-heading">Register surat terbit</h2>
            {register.length ? (
              <ul className="mt-3 divide-y divide-border/70">
                {register.map((document) => (
                  <li key={document.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-brand-heading">{document.documentNumber}</p>
                      <p className="text-sm text-muted-foreground">
                        {document.employeeName} ({document.employeeNumber}) · {formatDate(document.issuedAt)}
                        {document.status === "REVOKED" ? " · dibatalkan" : ""}
                      </p>
                    </div>
                    {document.status === "ISSUED" ? (
                      <button type="button" disabled={busy} onClick={() => revoke(document.id)}
                        className="min-h-11 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50">
                        Batalkan
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">Belum ada surat yang terbit.</p>
            )}
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              Nomor surat tidak pernah dipakai ulang. Surat yang dibatalkan tetap memegang nomornya.
            </p>
          </section>

          {disciplineReadable ? (
            <section className="rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
              <h2 className="text-sm font-bold text-brand-heading">Surat peringatan</h2>
              <form onSubmit={submitLetter} className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="text-sm font-semibold text-brand-heading">
                  ID pegawai
                  <input required value={form.employeeId} onChange={(event) => setForm({ ...form, employeeId: event.target.value })}
                    className="mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading" />
                </label>
                <label className="text-sm font-semibold text-brand-heading">
                  Tingkat
                  <select value={form.level}
                    onChange={(event) => setForm({ ...form, level: event.target.value as DisciplinaryLetterSummary["level"] })}
                    className="mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading">
                    <option value="SP1">SP1</option>
                    <option value="SP2">SP2</option>
                    <option value="SP3">SP3</option>
                  </select>
                </label>
                <label className="text-sm font-semibold text-brand-heading">
                  Tanggal berlaku
                  <input type="date" required value={form.effectiveDate}
                    onChange={(event) => setForm({ ...form, effectiveDate: event.target.value })}
                    className="mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading" />
                </label>
                <label className="text-sm font-semibold text-brand-heading">
                  Perihal
                  <input required minLength={5} value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })}
                    className="mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading" />
                </label>
                <label className="text-sm font-semibold text-brand-heading sm:col-span-2">
                  Uraian
                  <textarea required minLength={10} rows={4} value={form.narrative}
                    onChange={(event) => setForm({ ...form, narrative: event.target.value })}
                    className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm font-normal text-brand-heading" />
                </label>
                <button type="submit" disabled={busy}
                  className="inline-flex min-h-11 items-center rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">
                  Terbitkan surat peringatan
                </button>
              </form>

              {letters.length ? (
                <ul className="mt-5 divide-y divide-border/70">
                  {letters.map((letter) => (
                    <li key={letter.id} className="py-3">
                      <p className="font-semibold text-brand-heading">{letter.level} · {letter.employeeName}</p>
                      <p className="text-sm text-muted-foreground">{letter.subject}</p>
                      <p className="mt-1 text-[11px] font-semibold text-muted-foreground">
                        {letter.documentNumber} · {formatDate(letter.effectiveDate)} s.d. {formatDate(letter.expiresOn)}
                        {letter.active ? "" : " · tidak berlaku"}
                        {letter.acknowledgedAt ? ` · dibaca ${formatDate(letter.acknowledgedAt)}` : " · belum dibaca"}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-5 text-sm text-muted-foreground">Belum ada surat peringatan.</p>
              )}
            </section>
          ) : null}
        </div>
      )}
    </AdminShell>
  );
}
