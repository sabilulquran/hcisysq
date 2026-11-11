// DOC-003 "Buku Nomor Surat" for Human Capital: the joined register (book + HCIS-issued letters)
// with search, paging and CSV export; letter types, issuers and starting numbers; and the grants
// that let employees take numbers. documents.read opens the screen; every change needs
// documents.manage, which the API checks on each call — the screen only hides what would be refused.
// Spec: docs/domain/outgoing-letter-register.md §5.4–§5.5, §8.

import { Download, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  ISSUER_KIND_LABEL,
  LetterApiError,
  RESET_PERIOD_LABEL,
  createLetterGrant,
  createLetterIssuer,
  createLetterType,
  findIssuerByCode,
  formatLetterDate,
  getLetterGrants,
  getLetterIssuers,
  getLetterRegister,
  getLetterTypes,
  letterRegisterExportUrl,
  raiseLetterCounter,
  revokeLetterGrant,
  searchIssuerTargets,
  searchLetterEmployees,
  updateLetterIssuer,
  updateLetterType,
  voidLetterNumber,
  type EmployeeOption,
  type GrantRow,
  type IssuerKind,
  type IssuerRow,
  type LetterTypeRow,
  type Pagination,
  type RegisterFilter,
  type RegisterRow,
  type ResetPeriod,
  type TargetOption,
} from "@/lib/letters";
import type { AuthSession } from "@/types/hcis";

type Tab = "register" | "settings" | "grants";
const field = "mt-1 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading";
const panel = "min-w-0 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]";
const button = "min-h-11 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50";
const primary = "min-h-11 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50";
const EMPTY_PAGE: Pagination = { page: 1, pageSize: 25, total: 0, pageCount: 1 };

function message(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

/** ENG-LIST-001-J: the register view lives in the query string, so refresh and Back keep it. */
function readFilter(): RegisterFilter {
  const params = new URLSearchParams(window.location.search);
  const page = Number(params.get("page") ?? "1");
  const pageSize = Number(params.get("pageSize") ?? "25");
  const source = params.get("source");
  const status = params.get("status");
  return {
    source: source === "BOOK" || source === "HCIS" ? source : "ALL",
    issuerCode: params.get("issuerCode") ?? "",
    typeCode: params.get("typeCode") ?? "",
    status: status === "ACTIVE" || status === "VOIDED" ? status : "",
    year: /^\d{4}$/.test(params.get("year") ?? "") ? params.get("year")! : "",
    q: params.get("q") ?? "",
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: [10, 25, 50, 100].includes(pageSize) ? pageSize : 25,
  };
}

function writeFilter(filter: RegisterFilter) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== "" && !(key === "source" && value === "ALL") && !(key === "page" && value === 1) && !(key === "pageSize" && value === 25)) {
      params.set(key, String(value));
    }
  }
  const search = params.toString();
  window.history.pushState(null, "", `/admin/letters${search ? `?${search}` : ""}`);
}

export function AdminLettersPage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const canManage = hasPermission(session, "documents.manage");
  const [tab, setTab] = useState<Tab>("register");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [types, setTypes] = useState<LetterTypeRow[]>([]);

  useEffect(() => {
    void getCurrentSession().then(setSession).catch(() => {
      setSession(null);
      setError("Izin akun tidak dapat dibaca, sehingga tombol pengubah disembunyikan. Muat ulang halaman.");
    });
  }, []);

  const loadTypes = useCallback(async () => {
    try {
      setTypes(await getLetterTypes());
    } catch (cause) {
      setError(message(cause, "Jenis surat tidak dapat dimuat."));
    }
  }, []);
  useEffect(() => { void loadTypes(); }, [loadTypes]);

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "register", label: "Register" },
    { key: "settings", label: "Jenis & Penerbit" },
    { key: "grants", label: "Hak Ambil Nomor" },
  ];

  return (
    <AdminShell active="letters" title="Buku Nomor Surat" description="Nomor surat keluar yayasan, unit, dan panitia, beserta surat yang diterbitkan HCIS.">
      <div className="space-y-5">
        <div role="tablist" aria-label="Bagian buku nomor surat" className="flex flex-wrap gap-2">
          {tabs.map((item) => (
            <button key={item.key} type="button" role="tab" aria-selected={tab === item.key}
              onClick={() => { setTab(item.key); setNotice(null); setError(null); }}
              className={`min-h-11 rounded-xl px-4 text-sm font-bold ${tab === item.key ? "bg-brand-primary text-brand-foreground" : "border border-border text-brand-heading"}`}>
              {item.label}
            </button>
          ))}
        </div>
        {error ? <div role="alert" className="rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
        {notice ? <div className="rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}
        {tab === "register" ? <RegisterTab types={types} canManage={canManage} onError={setError} onNotice={setNotice} /> : null}
        {tab === "settings" ? <SettingsTab types={types} reloadTypes={loadTypes} canManage={canManage} onError={setError} onNotice={setNotice} /> : null}
        {tab === "grants" ? <GrantsTab canManage={canManage} onError={setError} onNotice={setNotice} /> : null}
      </div>
    </AdminShell>
  );
}

type Feedback = { onError: (value: string | null) => void; onNotice: (value: string | null) => void };

function RegisterTab({ types, canManage, onError, onNotice }: { types: LetterTypeRow[]; canManage: boolean } & Feedback) {
  const [filter, setFilter] = useState<RegisterFilter>(readFilter);
  const [draft, setDraft] = useState<RegisterFilter>(filter);
  const [rows, setRows] = useState<RegisterRow[]>([]);
  const [paging, setPaging] = useState<Pagination>(EMPTY_PAGE);
  const [state, setState] = useState<"loading" | "ready" | "forbidden" | "error">("loading");
  const [voidTarget, setVoidTarget] = useState<RegisterRow | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef(0);

  const load = useCallback(async (next: RegisterFilter) => {
    const id = ++request.current;
    setState("loading");
    try {
      const result = await getLetterRegister(next);
      if (id !== request.current) return;
      setRows(result.items);
      setPaging(result.pagination);
      setState("ready");
    } catch (cause) {
      if (id !== request.current) return;
      setState(cause instanceof LetterApiError && cause.status === 403 ? "forbidden" : "error");
      onError(message(cause, "Register tidak dapat dimuat."));
    }
  }, [onError]);

  useEffect(() => { void load(filter); }, [filter, load]);
  useEffect(() => {
    const back = () => { const next = readFilter(); setFilter(next); setDraft(next); };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);

  const apply = (next: RegisterFilter) => { writeFilter(next); setFilter(next); setDraft(next); };

  const confirmVoid = async () => {
    if (!voidTarget) return;
    setBusy(true);
    try {
      await voidLetterNumber(voidTarget.id, reason.trim());
      onNotice(`Nomor ${voidTarget.letterNumber} dibatalkan dan tetap tercatat.`);
      setVoidTarget(null);
      await load(filter);
    } catch (cause) {
      onError(message(cause, "Nomor belum dapat dibatalkan."));
      setVoidTarget(null);
      await load(filter);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={panel}>
      <form className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6" onSubmit={(event) => { event.preventDefault(); apply({ ...draft, page: 1 }); }}>
        <label className="text-xs font-semibold text-brand-heading lg:col-span-2">Cari nomor, perihal, tujuan
          <input value={draft.q} maxLength={100} onChange={(event) => setDraft({ ...draft, q: event.target.value })} className={field} />
        </label>
        <label className="text-xs font-semibold text-brand-heading">Sumber
          <select value={draft.source} onChange={(event) => setDraft({ ...draft, source: event.target.value as RegisterFilter["source"] })} className={field}>
            <option value="ALL">Semua</option><option value="BOOK">Buku nomor</option><option value="HCIS">Terbitan HCIS</option>
          </select>
        </label>
        <label className="text-xs font-semibold text-brand-heading">Kode penerbit
          <input value={draft.issuerCode} maxLength={16} placeholder="mis. YSQ" onChange={(event) => setDraft({ ...draft, issuerCode: event.target.value.toUpperCase() })} className={field} />
        </label>
        <label className="text-xs font-semibold text-brand-heading">Jenis
          <select value={draft.typeCode} onChange={(event) => setDraft({ ...draft, typeCode: event.target.value })} className={field}>
            <option value="">Semua</option>
            {types.map((type) => <option key={type.code} value={type.code}>{type.code} — {type.label}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-brand-heading">Status
          <select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as RegisterFilter["status"] })} className={field}>
            <option value="">Semua</option><option value="ACTIVE">Terpakai</option><option value="VOIDED">Dibatalkan</option>
          </select>
        </label>
        <label className="text-xs font-semibold text-brand-heading">Tahun
          <input value={draft.year} inputMode="numeric" maxLength={4} placeholder="Semua" onChange={(event) => setDraft({ ...draft, year: event.target.value.replace(/\D/g, "") })} className={field} />
        </label>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-3 lg:col-span-6">
          <button type="submit" className={primary}>Terapkan</button>
          <a href={letterRegisterExportUrl(filter)} className={`${button} inline-flex items-center gap-2`}>
            <Download className="h-4 w-4" aria-hidden="true" /> Ekspor CSV
          </a>
          <span className="text-xs text-muted-foreground">Ekspor memakai filter yang sedang tampil.</span>
        </div>
      </form>

      {state === "loading" ? (
        <p className="mt-5 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat register...</p>
      ) : state === "forbidden" ? (
        <p className="mt-5 text-sm text-muted-foreground">Akun ini tidak memiliki akses ke buku nomor surat.</p>
      ) : state === "error" ? (
        <button type="button" className={`mt-5 ${button}`} onClick={() => void load(filter)}>Coba lagi</button>
      ) : rows.length === 0 ? (
        <p className="mt-5 text-sm text-muted-foreground">Tidak ada nomor surat yang cocok dengan filter ini.</p>
      ) : (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr><th className="py-2 pr-3">Nomor</th><th className="py-2 pr-3">Tanggal</th><th className="py-2 pr-3">Penerbit / Jenis</th><th className="py-2 pr-3">Perihal & tujuan</th><th className="py-2 pr-3">Status</th><th className="py-2" /></tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {rows.map((row) => (
                <tr key={`${row.source}-${row.id}`} className="align-top">
                  <td className="py-2 pr-3 font-mono text-xs font-bold text-brand-heading">{row.letterNumber}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{formatLetterDate(row.letterDate)}</td>
                  <td className="py-2 pr-3">{row.issuerName}<br /><span className="text-xs text-muted-foreground">{row.typeLabel}</span></td>
                  <td className="py-2 pr-3">{row.subject}{row.recipient ? <><br /><span className="text-xs text-muted-foreground">Kepada: {row.recipient}</span></> : null}
                    {row.requestedByName ? <><br /><span className="text-xs text-muted-foreground">Diambil oleh {row.requestedByName}</span></> : null}</td>
                  <td className="py-2 pr-3">{row.status === "VOIDED" ? <span className="font-semibold text-danger-ink">Dibatalkan</span> : "Terpakai"}
                    {row.voidReason ? <><br /><span className="text-xs text-muted-foreground">{row.voidReason}</span></> : null}</td>
                  <td className="py-2">
                    {canManage && row.source === "BOOK" && row.status === "ACTIVE" ? (
                      <button type="button" className={button} onClick={() => { setVoidTarget(row); setReason(""); }}>Batalkan</button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 overflow-hidden rounded-2xl">
        <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total}
          onPageChange={(page) => apply({ ...filter, page })}
          onPageSizeChange={(pageSize) => apply({ ...filter, page: 1, pageSize })} />
      </div>

      {voidTarget ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label="Batalkan nomor surat">
          <div className="w-full max-w-lg rounded-3xl bg-surface-raised p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-base font-bold text-brand-heading">Batalkan {voidTarget.letterNumber}</h2>
              <button type="button" onClick={() => setVoidTarget(null)} className="rounded-lg p-2" aria-label="Tutup"><X className="h-4 w-4" /></button>
            </div>
            <label className="mt-4 block text-sm font-semibold text-brand-heading">Alasan pembatalan (10–500 karakter)
              <textarea value={reason} maxLength={500} rows={3} onChange={(event) => setReason(event.target.value)}
                className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm font-normal text-brand-heading" />
            </label>
            <p className="mt-1 text-xs text-muted-foreground">Nomor yang dibatalkan tetap tercatat dan tidak dipakai lagi.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={button} onClick={() => setVoidTarget(null)}>Tutup</button>
              <button type="button" className={primary} disabled={busy || reason.trim().length < 10} onClick={() => void confirmVoid()}>Batalkan nomor</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SettingsTab({ types, reloadTypes, canManage, onError, onNotice }: {
  types: LetterTypeRow[]; reloadTypes: () => Promise<void>; canManage: boolean;
} & Feedback) {
  const [issuers, setIssuers] = useState<IssuerRow[]>([]);
  const [issuerPage, setIssuerPage] = useState<Pagination>(EMPTY_PAGE);
  const [issuerSearch, setIssuerSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [typeForm, setTypeForm] = useState({ code: "", label: "", resetPeriod: "YEARLY" as ResetPeriod });
  const [issuerForm, setIssuerForm] = useState({ code: "", name: "", kind: "UNIT" as IssuerKind, targetQuery: "", target: null as TargetOption | null });
  const [targets, setTargets] = useState<TargetOption[]>([]);
  const [counterForm, setCounterForm] = useState({ issuerCode: "", typeCode: "", periodKey: "", lastSequence: "" });

  const loadIssuers = useCallback(async (page = 1, q = issuerSearch) => {
    setLoading(true);
    try {
      const result = await getLetterIssuers({ page, pageSize: 25, q: q.trim().length >= 2 ? q : undefined });
      setIssuers(result.items);
      setIssuerPage(result.pagination);
    } catch (cause) {
      onError(message(cause, "Penerbit tidak dapat dimuat."));
    } finally {
      setLoading(false);
    }
  }, [issuerSearch, onError]);
  useEffect(() => { void loadIssuers(1); }, []);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    onError(null);
    try {
      await action();
      onNotice(success);
      return true;
    } catch (cause) {
      onError(message(cause, "Perubahan belum dapat disimpan."));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const findTargets = async (q: string) => {
    setIssuerForm((current) => ({ ...current, targetQuery: q, target: null }));
    if (q.trim().length < 2 || (issuerForm.kind !== "UNIT" && issuerForm.kind !== "COMMITTEE")) { setTargets([]); return; }
    try {
      setTargets(await searchIssuerTargets(issuerForm.kind, q));
    } catch (cause) {
      onError(message(cause, "Pencarian tidak dapat dijalankan."));
    }
  };

  const needsTarget = issuerForm.kind === "UNIT" || issuerForm.kind === "COMMITTEE";

  const raiseCounter = async () => {
    const issuer = await findIssuerByCode(counterForm.issuerCode);
    if (!issuer) throw new Error("Kode penerbit tidak ditemukan.");
    const result = await raiseLetterCounter({
      issuerId: issuer.id, typeCode: counterForm.typeCode, periodKey: counterForm.periodKey.trim(),
      lastSequence: Number(counterForm.lastSequence),
    });
    return result;
  };

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <section className={panel}>
        <h2 className="text-sm font-bold text-brand-heading">Jenis surat</h2>
        <ul className="mt-3 divide-y divide-border/70">
          {types.map((type) => (
            <li key={type.code} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span><span className="font-mono font-bold">{type.code}</span> — {type.label}
                <span className="block text-xs text-muted-foreground">{RESET_PERIOD_LABEL[type.resetPeriod]}{type.active ? "" : " · nonaktif"}</span></span>
              {canManage ? (
                <span className="flex gap-2">
                  {type.used ? null : (
                    <button type="button" className={button} disabled={busy}
                      onClick={() => void run(() => updateLetterType(type.code, { resetPeriod: type.resetPeriod === "YEARLY" ? "MONTHLY" : "YEARLY" }), `Periode ${type.code} diubah.`).then(reloadTypes)}>
                      {type.resetPeriod === "YEARLY" ? "Jadikan bulanan" : "Jadikan tahunan"}
                    </button>
                  )}
                  <button type="button" className={button} disabled={busy}
                    onClick={() => void run(() => updateLetterType(type.code, { active: !type.active }), `Jenis ${type.code} ${type.active ? "dinonaktifkan" : "diaktifkan"}.`).then(reloadTypes)}>
                    {type.active ? "Nonaktifkan" : "Aktifkan"}
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {canManage ? (
          <form className="mt-4 grid gap-3 sm:grid-cols-3" onSubmit={(event) => {
            event.preventDefault();
            void run(() => createLetterType({ ...typeForm, code: typeForm.code.trim().toUpperCase(), label: typeForm.label.trim() }), "Jenis surat ditambahkan.")
              .then(async (ok) => { if (ok) { setTypeForm({ code: "", label: "", resetPeriod: "YEARLY" }); await reloadTypes(); } });
          }}>
            <label className="text-xs font-semibold text-brand-heading">Kode
              <input value={typeForm.code} maxLength={10} onChange={(event) => setTypeForm({ ...typeForm, code: event.target.value.toUpperCase() })} className={field} />
            </label>
            <label className="text-xs font-semibold text-brand-heading">Nama
              <input value={typeForm.label} maxLength={120} onChange={(event) => setTypeForm({ ...typeForm, label: event.target.value })} className={field} />
            </label>
            <label className="text-xs font-semibold text-brand-heading">Periode
              <select value={typeForm.resetPeriod} onChange={(event) => setTypeForm({ ...typeForm, resetPeriod: event.target.value as ResetPeriod })} className={field}>
                <option value="YEARLY">Tahunan</option><option value="MONTHLY">Bulanan</option>
              </select>
            </label>
            <button type="submit" className={`${primary} sm:col-span-3`} disabled={busy || !typeForm.code || typeForm.label.trim().length < 2}>Tambah jenis</button>
          </form>
        ) : null}
      </section>

      <section className={panel}>
        <h2 className="text-sm font-bold text-brand-heading">Penerbit</h2>
        <form className="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); void loadIssuers(1); }}>
          <input value={issuerSearch} onChange={(event) => setIssuerSearch(event.target.value)} placeholder="Cari kode atau nama" aria-label="Cari penerbit" className={field} />
          <button type="submit" className={button}>Cari</button>
        </form>
        {loading ? <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</p> : (
          issuers.length ? (
            <ul className="mt-3 divide-y divide-border/70">
              {issuers.map((issuer) => (
                <li key={issuer.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span><span className="font-mono font-bold">{issuer.code}</span> — {issuer.name}
                    <span className="block text-xs text-muted-foreground">
                      {ISSUER_KIND_LABEL[issuer.kind]}{issuer.unitName ? ` · ${issuer.unitName}` : ""}{issuer.committeeName ? ` · ${issuer.committeeName} (${issuer.committeeStatus})` : ""}
                      {` · ${issuer.activeGrants} pemegang akses`}{issuer.active ? "" : " · nonaktif"}
                    </span></span>
                  {canManage ? (
                    <button type="button" className={button} disabled={busy}
                      onClick={() => void run(() => updateLetterIssuer(issuer.id, { active: !issuer.active }), `Penerbit ${issuer.code} ${issuer.active ? "dinonaktifkan" : "diaktifkan"}.`).then(() => loadIssuers(issuerPage.page))}>
                      {issuer.active ? "Nonaktifkan" : "Aktifkan"}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : <p className="mt-3 text-sm text-muted-foreground">Belum ada penerbit yang cocok.</p>
        )}
        <div className="mt-2 overflow-hidden rounded-2xl">
          <PaginationBar page={issuerPage.page} pageSize={issuerPage.pageSize} total={issuerPage.total} onPageChange={(page) => void loadIssuers(page)} />
        </div>
        {canManage ? (
          <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={(event) => {
            event.preventDefault();
            void run(() => createLetterIssuer({
              code: issuerForm.code.trim().toUpperCase(), name: issuerForm.name.trim(), kind: issuerForm.kind,
              ...(issuerForm.kind === "UNIT" && issuerForm.target ? { organizationalUnitId: issuerForm.target.id } : {}),
              ...(issuerForm.kind === "COMMITTEE" && issuerForm.target ? { committeeId: issuerForm.target.id } : {}),
            }), "Penerbit ditambahkan.").then(async (ok) => {
              if (ok) { setIssuerForm({ code: "", name: "", kind: "UNIT", targetQuery: "", target: null }); setTargets([]); await loadIssuers(1); }
            });
          }}>
            <label className="text-xs font-semibold text-brand-heading">Kode penerbit
              <input value={issuerForm.code} maxLength={16} onChange={(event) => setIssuerForm({ ...issuerForm, code: event.target.value.toUpperCase() })} className={field} />
            </label>
            <label className="text-xs font-semibold text-brand-heading">Jenis penerbit
              <select value={issuerForm.kind} onChange={(event) => { setIssuerForm({ ...issuerForm, kind: event.target.value as IssuerKind, target: null, targetQuery: "" }); setTargets([]); }} className={field}>
                {(Object.keys(ISSUER_KIND_LABEL) as IssuerKind[]).map((kind) => <option key={kind} value={kind}>{ISSUER_KIND_LABEL[kind]}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold text-brand-heading sm:col-span-2">Nama
              <input value={issuerForm.name} maxLength={200} onChange={(event) => setIssuerForm({ ...issuerForm, name: event.target.value })} className={field} />
            </label>
            {needsTarget ? (
              <div className="sm:col-span-2">
                <label className="text-xs font-semibold text-brand-heading">{issuerForm.kind === "UNIT" ? "Unit" : "Panitia"} (ketik minimal 2 huruf)
                  <input value={issuerForm.target ? issuerForm.target.name : issuerForm.targetQuery} onChange={(event) => void findTargets(event.target.value)} className={field} />
                </label>
                {!issuerForm.target && targets.length ? (
                  <ul className="mt-1 max-h-48 overflow-auto rounded-xl border border-border">
                    {targets.map((target) => (
                      <li key={target.id}><button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-surface"
                        onClick={() => { setIssuerForm({ ...issuerForm, target }); setTargets([]); }}>{target.name}{target.status ? ` (${target.status})` : ""}</button></li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <button type="submit" className={`${primary} sm:col-span-2`}
              disabled={busy || !issuerForm.code || issuerForm.name.trim().length < 2 || (needsTarget && !issuerForm.target)}>Tambah penerbit</button>
          </form>
        ) : null}
      </section>

      {canManage ? (
        <section className={`${panel} xl:col-span-2`}>
          <h2 className="text-sm font-bold text-brand-heading">Nomor awal (lanjutan buku manual)</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Isi nomor terakhir yang sudah terpakai di buku manual. Nomor berikutnya dari HCIS melanjutkan setelahnya. Nomor awal hanya dapat dinaikkan.
          </p>
          <form className="mt-3 grid gap-3 sm:grid-cols-5" onSubmit={(event) => {
            event.preventDefault();
            void run(raiseCounter, "Nomor awal disimpan.").then((ok) => { if (ok) setCounterForm({ issuerCode: "", typeCode: "", periodKey: "", lastSequence: "" }); });
          }}>
            <label className="text-xs font-semibold text-brand-heading">Kode penerbit
              <input value={counterForm.issuerCode} maxLength={16} onChange={(event) => setCounterForm({ ...counterForm, issuerCode: event.target.value.toUpperCase() })} className={field} />
            </label>
            <label className="text-xs font-semibold text-brand-heading">Jenis
              <select value={counterForm.typeCode} onChange={(event) => setCounterForm({ ...counterForm, typeCode: event.target.value })} className={field}>
                <option value="">Pilih</option>
                {types.map((type) => <option key={type.code} value={type.code}>{type.code} — {type.label}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold text-brand-heading">Periode (YYYY atau YYYY-MM)
              <input value={counterForm.periodKey} maxLength={7} onChange={(event) => setCounterForm({ ...counterForm, periodKey: event.target.value })} className={field} />
            </label>
            <label className="text-xs font-semibold text-brand-heading">Nomor terakhir terpakai
              <input value={counterForm.lastSequence} inputMode="numeric" maxLength={5} onChange={(event) => setCounterForm({ ...counterForm, lastSequence: event.target.value.replace(/\D/g, "") })} className={field} />
            </label>
            <div className="flex items-end">
              <button type="submit" className={primary}
                disabled={busy || !counterForm.issuerCode || !counterForm.typeCode || !/^\d{4}(-\d{2})?$/.test(counterForm.periodKey) || !counterForm.lastSequence}>Simpan</button>
            </div>
          </form>
        </section>
      ) : null}
    </div>
  );
}

function GrantsTab({ canManage, onError, onNotice }: { canManage: boolean } & Feedback) {
  const [active, setActive] = useState(true);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<GrantRow[]>([]);
  const [paging, setPaging] = useState<Pagination>(EMPTY_PAGE);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [employeeQuery, setEmployeeQuery] = useState("");
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [chosen, setChosen] = useState<EmployeeOption | null>(null);
  const [issuerCode, setIssuerCode] = useState("");
  const [reason, setReason] = useState("");
  const [revoke, setRevoke] = useState<{ row: GrantRow; reason: string } | null>(null);

  const load = useCallback(async (page = 1, onlyActive = active) => {
    setLoading(true);
    try {
      const result = await getLetterGrants({ page, pageSize: 25, active: onlyActive, q: search.trim().length >= 2 ? search : undefined });
      setRows(result.items);
      setPaging(result.pagination);
    } catch (cause) {
      onError(message(cause, "Hak ambil nomor tidak dapat dimuat."));
    } finally {
      setLoading(false);
    }
  }, [active, search, onError]);
  useEffect(() => { void load(1); }, []);

  const findEmployees = async (q: string) => {
    setEmployeeQuery(q);
    setChosen(null);
    if (q.trim().length < 2) { setEmployees([]); return; }
    try {
      setEmployees(await searchLetterEmployees(q));
    } catch (cause) {
      onError(message(cause, "Pencarian pegawai tidak dapat dijalankan."));
    }
  };

  const grant = async () => {
    setBusy(true);
    onError(null);
    try {
      const issuer = await findIssuerByCode(issuerCode);
      if (!issuer) throw new Error("Kode penerbit tidak ditemukan.");
      await createLetterGrant({ employeeId: chosen!.id, issuerId: issuer.id, reason: reason.trim() });
      onNotice(`${chosen!.fullName} dapat mengambil nomor untuk ${issuer.code}.`);
      setChosen(null); setEmployeeQuery(""); setEmployees([]); setReason("");
      await load(1);
    } catch (cause) {
      onError(message(cause, "Hak ambil nomor belum dapat diberikan."));
    } finally {
      setBusy(false);
    }
  };

  const confirmRevoke = async () => {
    if (!revoke) return;
    setBusy(true);
    try {
      await revokeLetterGrant(revoke.row.id, revoke.reason.trim());
      onNotice(`Hak ambil nomor ${revoke.row.employeeName} untuk ${revoke.row.issuerCode} dicabut.`);
      setRevoke(null);
      await load(paging.page);
    } catch (cause) {
      onError(message(cause, "Hak ambil nomor belum dapat dicabut."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {canManage ? (
        <section className={panel}>
          <h2 className="text-sm font-bold text-brand-heading">Beri hak ambil nomor</h2>
          <form className="mt-3 grid gap-3 sm:grid-cols-3" onSubmit={(event) => { event.preventDefault(); void grant(); }}>
            <div>
              <label className="text-xs font-semibold text-brand-heading">Pegawai (ketik nama atau NIP)
                <input value={chosen ? `${chosen.fullName} (${chosen.employeeNumber})` : employeeQuery} onChange={(event) => void findEmployees(event.target.value)} className={field} />
              </label>
              {!chosen && employees.length ? (
                <ul className="mt-1 max-h-48 overflow-auto rounded-xl border border-border">
                  {employees.map((employee) => (
                    <li key={employee.id}><button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-surface"
                      onClick={() => { setChosen(employee); setEmployees([]); }}>{employee.fullName} · {employee.employeeNumber}{employee.unitName ? ` · ${employee.unitName}` : ""}</button></li>
                  ))}
                </ul>
              ) : null}
            </div>
            <label className="text-xs font-semibold text-brand-heading">Kode penerbit
              <input value={issuerCode} maxLength={16} onChange={(event) => setIssuerCode(event.target.value.toUpperCase())} className={field} />
            </label>
            <label className="text-xs font-semibold text-brand-heading">Alasan
              <input value={reason} maxLength={500} placeholder="mis. Sekretaris unit" onChange={(event) => setReason(event.target.value)} className={field} />
            </label>
            <button type="submit" className={`${primary} sm:col-span-3`} disabled={busy || !chosen || !issuerCode || reason.trim().length < 5}>Beri akses</button>
          </form>
        </section>
      ) : null}

      <section className={panel}>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void load(1); }}>
          <label className="min-w-0 flex-1 text-xs font-semibold text-brand-heading">Cari pegawai
            <input value={search} onChange={(event) => setSearch(event.target.value)} className={field} />
          </label>
          <label className="text-xs font-semibold text-brand-heading">Status
            <select value={active ? "true" : "false"} onChange={(event) => { const next = event.target.value === "true"; setActive(next); void load(1, next); }} className={field}>
              <option value="true">Aktif</option><option value="false">Dicabut</option>
            </select>
          </label>
          <button type="submit" className={button}>Cari</button>
        </form>
        {loading ? <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</p> : rows.length ? (
          <ul className="mt-3 divide-y divide-border/70">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>{row.employeeName} · {row.employeeNumber}
                  <span className="block text-xs text-muted-foreground">
                    {row.issuerCode} — {row.issuerName} · {row.reason} · sejak {formatLetterDate(row.grantedAt)}
                    {row.revokedAt ? ` · dicabut ${formatLetterDate(row.revokedAt)}: ${row.revokeReason ?? "-"}` : ""}
                  </span></span>
                {canManage && !row.revokedAt ? (
                  <button type="button" className={button} disabled={busy} onClick={() => setRevoke({ row, reason: "" })}>Cabut</button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : <p className="mt-4 text-sm text-muted-foreground">Belum ada hak ambil nomor{active ? " yang aktif" : " yang dicabut"}.</p>}
        <div className="mt-2 overflow-hidden rounded-2xl">
          <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total} onPageChange={(page) => void load(page)} />
        </div>
      </section>

      {revoke ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label="Cabut hak ambil nomor">
          <div className="w-full max-w-lg rounded-3xl bg-surface-raised p-5 shadow-xl">
            <h2 className="text-base font-bold text-brand-heading">Cabut akses {revoke.row.employeeName} ({revoke.row.issuerCode})</h2>
            <label className="mt-4 block text-sm font-semibold text-brand-heading">Alasan (5–500 karakter)
              <input value={revoke.reason} maxLength={500} onChange={(event) => setRevoke({ ...revoke, reason: event.target.value })} className={field} />
            </label>
            <p className="mt-1 text-xs text-muted-foreground">Nomor yang sudah diambil tetap tercatat atas nama pegawai ini.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={button} onClick={() => setRevoke(null)}>Tutup</button>
              <button type="button" className={primary} disabled={busy || revoke.reason.trim().length < 5} onClick={() => void confirmRevoke()}>Cabut akses</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
