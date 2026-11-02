// DOC-001 / DOC-002 Human Capital surface: decide requests, issue letters, keep the
// register, and issue warning letters. Spec: docs/domain/hr-documents.md.
//
// The API authorizes every call; a section the account cannot read simply stays empty.

import { useLocation, useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { DocumentRegisterSection, RevokeDocumentDialog, type RegisterView } from "@/components/documents/DocumentRegister";
import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import type { AuthSession } from "@/types/hcis";
import {
  HrDocumentApiError,
  approveDocumentRequest,
  documentStatusLabel,
  getDisciplinaryLetters,
  getDocumentRegister,
  getDocumentRequests,
  issueDisciplinaryLetter,
  issueDocumentRequest,
  readRegisterFilter,
  rejectDocumentRequest,
  revokeIssuedDocument,
  writeRegisterFilter,
  type DisciplinaryLetterSummary,
  type DocumentRequestSummary,
  type RegisterEntry,
  type RegisterFilter,
} from "@/lib/hrDocuments";

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

/** `YYYY-MM-DD` in Asia/Jakarta, so a form opened before 07:00 WIB does not default to yesterday. */
function todayInJakarta() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

export function AdminDocumentsPage() {
  const [requests, setRequests] = useState<DocumentRequestSummary[]>([]);
  const [letters, setLetters] = useState<DisciplinaryLetterSummary[]>([]);
  const [disciplineReadable, setDisciplineReadable] = useState(false);
  const [totals, setTotals] = useState({ requests: 0, letters: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    employeeId: "", level: "SP1" as DisciplinaryLetterSummary["level"],
    subject: "", narrative: "", effectiveDate: todayInJakarta(),
  });
  const [session, setSession] = useState<AuthSession | null>(null);
  // DOC-001/DOC-002: revoking needs documents.correct, which is a separate role grant. Without
  // it the button would only produce a raw 403, so it is not offered.
  const canRevoke = hasPermission(session, "documents.correct");
  const router = useRouter();
  const { searchStr } = useLocation();
  const registerFilter = readRegisterFilter(searchStr);
  const [registerView, setRegisterView] = useState<RegisterView>({ kind: "loading" });
  const [revokeTarget, setRevokeTarget] = useState<RegisterEntry | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const { kind: registerKind, status: registerStatus, page: registerPage, pageSize: registerPageSize } = registerFilter;
  const loadRegister = useCallback(async () => {
    setRegisterView({ kind: "loading" });
    try {
      const result = await getDocumentRegister({
        kind: registerKind, status: registerStatus, page: registerPage, pageSize: registerPageSize,
      });
      setRegisterView({ kind: "ready", items: result.items, total: result.pagination.total });
    } catch (cause) {
      if (cause instanceof HrDocumentApiError && cause.status === 403) setRegisterView({ kind: "forbidden" });
      else setRegisterView({ kind: "error", message: cause instanceof Error ? cause.message : "Register tidak dapat dimuat." });
    }
  }, [registerKind, registerStatus, registerPage, registerPageSize]);

  useEffect(() => { void loadRegister(); }, [loadRegister]);

  // ENG-LIST-001-J: a history entry per change, so refresh, sharing and Back all keep the view.
  const changeRegisterFilter = (next: RegisterFilter) => {
    router.history.push(`/admin/documents${writeRegisterFilter(searchStr, next)}`);
  };

  const load = async () => {
    setLoading(true);
    try {
      const [requestList, letterList] = await Promise.allSettled([
        getDocumentRequests(),
        getDisciplinaryLetters(),
      ]);
      if (requestList.status === "rejected") throw requestList.reason;
      setRequests(requestList.value.items);
      setTotals((current) => ({ ...current, requests: requestList.value.pagination.total }));
      setDisciplineReadable(letterList.status === "fulfilled");
      if (letterList.status === "fulfilled") {
        setLetters(letterList.value.items);
        setTotals((current) => ({ ...current, letters: letterList.value.pagination.total }));
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Dokumen tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    void getCurrentSession()
      .then(setSession)
      .catch(() => {
        // Without the session the page cannot tell which actions to offer, so say so rather
        // than silently hiding Batalkan from someone who does hold documents.correct.
        setSession(null);
        setError("Izin akun tidak dapat dibaca, sehingga sebagian tindakan disembunyikan. Muat ulang halaman.");
      });
  }, []);

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

  const openRevoke = (entry: RegisterEntry) => {
    setRevokeError(null);
    setRevokeTarget(entry);
  };

  const confirmRevoke = async (reason: string) => {
    if (!revokeTarget) return;
    setBusy(true);
    setRevokeError(null);
    setNotice(null);
    try {
      await revokeIssuedDocument(revokeTarget.id, reason);
      setRevokeTarget(null);
      setNotice(`Surat ${revokeTarget.documentNumber} dibatalkan; nomornya tetap terpakai.`);
      await Promise.all([loadRegister(), load()]);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Surat belum dapat dibatalkan.";
      if (cause instanceof HrDocumentApiError && (cause.status === 403 || cause.status === 409)) {
        // Forbidden or already revoked: the dialog cannot fix either, so close it and show
        // the register as it is now.
        setRevokeTarget(null);
        setError(message);
        await loadRegister();
      } else {
        setRevokeError(message);
      }
    } finally {
      setBusy(false);
    }
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
            {totals.requests > requests.length ? (
              <p className="mt-3 text-xs text-muted-foreground">Menampilkan {requests.length} terbaru dari {totals.requests}.</p>
            ) : null}
          </section>

          <DocumentRegisterSection
            filter={registerFilter}
            view={registerView}
            canRevoke={canRevoke}
            busy={busy}
            onFilterChange={changeRegisterFilter}
            onRevoke={openRevoke}
            onRetry={() => void loadRegister()}
          />

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
                        {letter.status === "REVOKED" ? " · dibatalkan" : letter.active ? "" : " · tidak berlaku"}
                        {letter.acknowledgedAt ? ` · dibaca ${formatDate(letter.acknowledgedAt)}` : " · belum dibaca"}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-5 text-sm text-muted-foreground">Belum ada surat peringatan.</p>
              )}
              {totals.letters > letters.length ? (
                <p className="mt-3 text-xs text-muted-foreground">Menampilkan {letters.length} terbaru dari {totals.letters}.</p>
              ) : null}
            </section>
          ) : null}
        </div>
      )}
      {revokeTarget ? (
        <RevokeDocumentDialog
          entry={revokeTarget}
          busy={busy}
          error={revokeError}
          onCancel={() => setRevokeTarget(null)}
          onConfirm={(reason) => void confirmRevoke(reason)}
        />
      ) : null}
    </AdminShell>
  );
}
