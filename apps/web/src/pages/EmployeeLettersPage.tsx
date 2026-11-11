// DOC-003 "Nomor Surat": take an outgoing letter number for an issuer this employee holds a grant
// for, read that issuer's book, and change or void one's own numbers. The grant and every rule
// live in the API; this screen only shows what it answers. Spec: docs/domain/outgoing-letter-register.md §8.

import { Copy, Hash, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { AppShell } from "@/layouts/AppShell";
import { employeeShellUser } from "@/lib/employeeIdentity";
import { getEmployeeLeaveSummary, type EmployeeLeaveSummary } from "@/lib/employeeLeave";
import {
  LetterApiError,
  editMyLetterNumber,
  formatLetterDate,
  getMyLetterNumbers,
  getMyLetterOptions,
  takeLetterNumber,
  voidMyLetterNumber,
  type LetterNumber,
  type LetterTypeOption,
  type MyIssuerOption,
  type Pagination,
} from "@/lib/letters";

const field = "mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading";
const card = "mt-6 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]";

type Dialog = { mode: "edit" | "void"; row: LetterNumber } | null;

export function EmployeeLettersPage() {
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [issuers, setIssuers] = useState<MyIssuerOption[]>([]);
  const [types, setTypes] = useState<LetterTypeOption[]>([]);
  const [form, setForm] = useState({ issuerId: "", typeCode: "", subject: "", recipient: "", notes: "" });
  const [taken, setTaken] = useState<LetterNumber | null>(null);
  const [rows, setRows] = useState<LetterNumber[]>([]);
  const [paging, setPaging] = useState<Pagination>({ page: 1, pageSize: 25, total: 0, pageCount: 1 });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogText, setDialogText] = useState({ subject: "", recipient: "", reason: "" });
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const user = useMemo(() => employeeShellUser(employee), [employee]);
  const availableIssuers = issuers.filter((issuer) => issuer.available);

  const loadList = async (page = paging.page, pageSize = paging.pageSize) => {
    setListLoading(true);
    try {
      const result = await getMyLetterNumbers({ page, pageSize, q: search.trim().length >= 2 ? search : undefined, status });
      setRows(result.items);
      setPaging(result.pagination);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Buku nomor surat tidak dapat dimuat.");
    } finally {
      setListLoading(false);
    }
  };

  /** `keepError`: reload after a refused action without wiping the reason it was refused. */
  const load = async ({ keepError = false }: { keepError?: boolean } = {}) => {
    setLoading(true);
    try {
      const [summary, options] = await Promise.allSettled([getEmployeeLeaveSummary(), getMyLetterOptions()]);
      if (summary.status === "fulfilled") setEmployee(summary.value.employee);
      if (options.status === "rejected") throw options.reason;
      setIssuers(options.value.issuers);
      setTypes(options.value.types);
      setForm((current) => ({
        ...current,
        issuerId: current.issuerId || options.value.issuers.find((issuer) => issuer.available)?.id || "",
        typeCode: current.typeCode || options.value.types[0]?.code || "",
      }));
      if (!keepError) setError(null);
      await loadList(1);
    } catch (cause) {
      if (cause instanceof LetterApiError && cause.status === 403) setForbidden(true);
      else setError(cause instanceof Error ? cause.message : "Nomor surat tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const result = await takeLetterNumber({
        issuerId: form.issuerId, typeCode: form.typeCode, subject: form.subject.trim(), recipient: form.recipient.trim(),
        notes: form.notes.trim() || undefined,
      });
      setTaken(result);
      setForm((current) => ({ ...current, subject: "", recipient: "", notes: "" }));
      await loadList(1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nomor surat belum dapat diambil.");
      // A grant revoked or an issuer closed meanwhile: show the options as they are now.
      if (cause instanceof LetterApiError && (cause.status === 403 || cause.status === 409)) await load({ keepError: true });
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const openDialog = (mode: "edit" | "void", row: LetterNumber) => {
    setDialog({ mode, row });
    setDialogText({ subject: row.subject, recipient: row.recipient, reason: "" });
    setDialogError(null);
  };

  const confirmDialog = async () => {
    if (!dialog) return;
    setBusy(true);
    setDialogError(null);
    try {
      if (dialog.mode === "edit") {
        await editMyLetterNumber(dialog.row.id, {
          subject: dialogText.subject.trim(), recipient: dialogText.recipient.trim(), version: dialog.row.version,
        });
      } else {
        await voidMyLetterNumber(dialog.row.id, dialogText.reason.trim());
      }
      setDialog(null);
      await loadList();
    } catch (cause) {
      setDialogError(cause instanceof Error ? cause.message : "Perubahan belum dapat disimpan.");
      if (cause instanceof LetterApiError && cause.status === 409) await loadList();
    } finally {
      setBusy(false);
    }
  };

  const dialogValid = dialog?.mode === "void"
    ? dialogText.reason.trim().length >= 10
    : dialogText.subject.trim().length >= 3 && dialogText.recipient.trim().length >= 2;

  return (
    <AppShell user={user} activeItem="Semua Layanan">
      <section className="mx-auto max-w-4xl">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-primary-deep">Layanan Pegawai</p>
        <h1 className="mt-1 text-2xl font-bold text-brand-heading sm:text-3xl">Nomor Surat Keluar</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Ambil nomor untuk surat yang Anda buat atas nama unit atau panitia. Nomor tidak pernah dipakai ulang; nomor yang
          tidak jadi dipakai dibatalkan dan tetap tercatat.
        </p>

        {error ? <div role="alert" className="mt-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}

        {loading ? (
          <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat nomor surat...</div>
        ) : forbidden ? (
          <div className={card}><p className="text-sm text-muted-foreground">Nomor surat hanya tersedia untuk akun pegawai aktif.</p></div>
        ) : (
          <>
            {issuers.length === 0 ? (
              <div className={card}>
                <h2 className="text-sm font-bold text-brand-heading">Belum ada akses</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Anda belum diberi akses mengambil nomor surat. Hubungi Human Capital bila Anda perlu menomori surat unit atau panitia.
                </p>
              </div>
            ) : (
              <form onSubmit={submit} className={card}>
                <h2 className="text-sm font-bold text-brand-heading">Ambil nomor</h2>
                {availableIssuers.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">Penerbit Anda sedang tidak aktif. Hubungi Human Capital.</p>
                ) : null}
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <label className="text-sm font-semibold text-brand-heading">
                    Penerbit
                    <select value={form.issuerId} onChange={(event) => setForm({ ...form, issuerId: event.target.value })} className={field}>
                      {issuers.map((issuer) => (
                        <option key={issuer.id} value={issuer.id} disabled={!issuer.available}>
                          {issuer.code} — {issuer.name}{issuer.available ? "" : " (tidak aktif)"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm font-semibold text-brand-heading">
                    Jenis surat
                    <select value={form.typeCode} onChange={(event) => setForm({ ...form, typeCode: event.target.value })} className={field}>
                      {types.map((type) => <option key={type.code} value={type.code}>{type.code} — {type.label}</option>)}
                    </select>
                  </label>
                  <label className="text-sm font-semibold text-brand-heading sm:col-span-2">
                    Perihal
                    <input value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })}
                      required minLength={3} maxLength={300} placeholder="Contoh: Undangan rapat wali santri" className={field} />
                  </label>
                  <label className="text-sm font-semibold text-brand-heading sm:col-span-2">
                    Tujuan
                    <input value={form.recipient} onChange={(event) => setForm({ ...form, recipient: event.target.value })}
                      required minLength={2} maxLength={300} placeholder="Contoh: Wali santri kelas 7" className={field} />
                  </label>
                  <label className="text-sm font-semibold text-brand-heading sm:col-span-2">
                    Catatan (opsional)
                    <textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })}
                      maxLength={1000} rows={2}
                      className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm font-normal text-brand-heading" />
                  </label>
                </div>
                <button
                  type="submit"
                  disabled={busy || !form.issuerId || !form.typeCode || form.subject.trim().length < 3 || form.recipient.trim().length < 2
                    || !availableIssuers.some((issuer) => issuer.id === form.issuerId)}
                  className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Hash className="h-4 w-4" aria-hidden="true" />}
                  Ambil nomor
                </button>
                {taken ? (
                  <div className="mt-4 rounded-2xl border border-border bg-surface p-4" aria-live="polite">
                    <p className="text-xs font-semibold text-muted-foreground">Nomor surat Anda</p>
                    <p className="mt-1 break-all font-mono text-xl font-bold text-brand-heading">{taken.letterNumber}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{taken.subject} · {formatLetterDate(taken.letterDate)}</p>
                    <button type="button" onClick={() => void copy(taken.letterNumber)}
                      className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading">
                      <Copy className="h-4 w-4" aria-hidden="true" /> {copied ? "Tersalin" : "Salin nomor"}
                    </button>
                  </div>
                ) : null}
              </form>
            )}

            <section className={card}>
              <h2 className="text-sm font-bold text-brand-heading">Buku nomor surat</h2>
              <form
                className="mt-3 flex flex-wrap items-end gap-3"
                onSubmit={(event) => { event.preventDefault(); void loadList(1); }}
              >
                <label className="min-w-0 flex-1 text-sm font-semibold text-brand-heading">
                  Cari nomor, perihal, atau tujuan
                  <input value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} className={field} />
                </label>
                <label className="text-sm font-semibold text-brand-heading">
                  Status
                  <select value={status} onChange={(event) => setStatus(event.target.value)} className={field}>
                    <option value="">Semua</option>
                    <option value="ALLOCATED">Terpakai</option>
                    <option value="VOIDED">Dibatalkan</option>
                  </select>
                </label>
                <button type="submit" className="min-h-11 rounded-xl border border-border px-4 text-sm font-bold text-brand-heading">Terapkan</button>
              </form>
              {listLoading ? (
                <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</p>
              ) : rows.length ? (
                <ul className="mt-3 divide-y divide-border/70">
                  {rows.map((row) => (
                    <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="break-all font-mono text-sm font-bold text-brand-heading">{row.letterNumber}</p>
                        <p className="text-sm text-brand-heading">{row.subject}</p>
                        <p className="text-sm text-muted-foreground">Kepada: {row.recipient}</p>
                        <p className="mt-1 text-[11px] font-semibold text-muted-foreground">
                          {row.typeLabel} · {formatLetterDate(row.letterDate)} · {row.mine ? "Anda" : row.requestedByName}
                          {row.status === "VOIDED" ? ` · Dibatalkan: ${row.voidReason ?? "-"}` : ""}
                        </p>
                      </div>
                      {row.mine && row.status === "ALLOCATED" ? (
                        <div className="flex gap-2">
                          <button type="button" disabled={busy} onClick={() => openDialog("edit", row)}
                            className="min-h-11 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50">Ubah</button>
                          <button type="button" disabled={busy} onClick={() => openDialog("void", row)}
                            className="min-h-11 rounded-xl border border-danger-line px-3 text-sm font-bold text-danger-ink disabled:opacity-50">Batalkan</button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-4 text-sm text-muted-foreground">Belum ada nomor surat di buku Anda.</p>
              )}
            </section>
            <div className="mt-2 overflow-hidden rounded-2xl">
              <PaginationBar
                page={paging.page}
                pageSize={paging.pageSize}
                total={paging.total}
                onPageChange={(page) => void loadList(page)}
                onPageSizeChange={(pageSize) => void loadList(1, pageSize)}
              />
            </div>
          </>
        )}
      </section>

      {dialog ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" role="dialog" aria-modal="true"
          aria-label={dialog.mode === "edit" ? "Ubah nomor surat" : "Batalkan nomor surat"}>
          <div className="w-full max-w-lg rounded-3xl bg-surface-raised p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-brand-heading">{dialog.mode === "edit" ? "Ubah perihal dan tujuan" : "Batalkan nomor"}</h2>
                <p className="break-all font-mono text-sm text-muted-foreground">{dialog.row.letterNumber}</p>
              </div>
              <button type="button" onClick={() => setDialog(null)} className="rounded-lg p-2" aria-label="Tutup"><X className="h-4 w-4" /></button>
            </div>
            {dialog.mode === "edit" ? (
              <div className="mt-4 grid gap-3">
                <label className="text-sm font-semibold text-brand-heading">Perihal
                  <input value={dialogText.subject} maxLength={300} onChange={(event) => setDialogText({ ...dialogText, subject: event.target.value })} className={field} />
                </label>
                <label className="text-sm font-semibold text-brand-heading">Tujuan
                  <input value={dialogText.recipient} maxLength={300} onChange={(event) => setDialogText({ ...dialogText, recipient: event.target.value })} className={field} />
                </label>
              </div>
            ) : (
              <label className="mt-4 block text-sm font-semibold text-brand-heading">
                Alasan pembatalan (10–500 karakter)
                <textarea value={dialogText.reason} maxLength={500} rows={3}
                  onChange={(event) => setDialogText({ ...dialogText, reason: event.target.value })}
                  className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm font-normal text-brand-heading" />
                <span className="mt-1 block text-xs font-normal text-muted-foreground">Nomor yang dibatalkan tetap tercatat dan tidak dipakai lagi.</span>
              </label>
            )}
            {dialogError ? <p role="alert" className="mt-3 text-sm text-danger-ink">{dialogError}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setDialog(null)} className="min-h-11 rounded-xl border border-border px-4 text-sm font-bold text-brand-heading">Tutup</button>
              <button type="button" disabled={busy || !dialogValid} onClick={() => void confirmDialog()}
                className="min-h-11 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">
                {dialog.mode === "edit" ? "Simpan" : "Batalkan nomor"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
