// EMP-012 HC surface: photos, issuing, reissuing, revoking and printing employee cards.
// Spec: docs/domain/employee-id-card.md §10.

import { AlertTriangle, ImageUp, Loader2, Printer, RotateCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { EmployeeIdCardFront } from "@/components/employee-card/EmployeeIdCard";
import { AdminShell } from "@/layouts/AdminShell";
import {
  adminSignatureUrl,
  cardPhotoUrl,
  employeePhotoUrl,
  filterLabel,
  formatDate,
  formatInstant,
  getCardSettings,
  getEmployeeCardDetail,
  invalidReasonLabel,
  issueEmployeeCard,
  issueReasonLabel,
  listCardAuditEvents,
  listEmployeeCards,
  preparePhoto,
  printHref,
  readSignature,
  revokeEmployeeCard,
  saveCardSettings,
  uploadEmployeePhoto,
  uploadSignature,
  type CardAuditEvent,
  type CardFilter,
  type CardListItem,
  type CardSettings,
  type EmployeeCardDetail,
  type IssueReason,
  type Pagination,
} from "@/lib/employeeCards";
import { cn } from "@/lib/utils";

type Tab = "employees" | "settings" | "history";
const MAX_BATCH = 50;

const statusLabel = { ACTIVE: "Aktif", REPLACED: "Diganti", REPORTED_LOST: "Dilaporkan hilang", REVOKED: "Dicabut" } as const;

const eventLabel: Record<string, string> = {
  "employee_card.photo.uploaded": "Foto diunggah",
  "employee_card.issued": "Kartu diterbitkan",
  "employee_card.replaced": "Kartu diganti",
  "employee_card.reported_lost": "Dilaporkan hilang oleh pegawai",
  "employee_card.revoked": "Kartu dicabut",
  "employee_card.printed": "Kartu dicetak",
  "employee_card.settings.updated": "Pengaturan diubah",
  "employee_card.signature.uploaded": "Tanda tangan diunggah",
};

function message(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

function openPrint(cardIds: string[]) {
  window.open(printHref(cardIds), "hcis-cetak-kartu", "width=900,height=900");
}

/** One-line state of a row's latest card, never by colour alone. */
function CardState({ item }: { item: CardListItem }) {
  if (!item.card) return <span className="text-muted-foreground">Belum punya kartu</span>;
  const { card } = item;
  return (
    <span>
      <span className={cn("font-semibold", card.invalidReason ? "text-orange-800" : "text-emerald-800")}>
        {card.invalidReason ? invalidReasonLabel[card.invalidReason] : "Aktif"}
      </span>
      <span className="block text-[11px] text-muted-foreground">
        {card.cardNumber} · ke-{card.edition} · s.d. {formatDate(card.validUntil)}
        {card.dataChanged ? " · data berubah" : ""}
      </span>
    </span>
  );
}

function EmployeePanel({ employeeId, onChanged }: { employeeId: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<EmployeeCardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState<IssueReason>("NEW");
  const [note, setNote] = useState("");
  const [revoking, setRevoking] = useState(false);
  const [revokeReason, setRevokeReason] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setDetail(null);
    setError(null);
    getEmployeeCardDetail(employeeId)
      .then((result) => {
        if (!active) return;
        setDetail(result);
        setReason(result.cards.length ? (result.cards[0]!.dataChanged ? "DATA_CHANGED" : "LOST") : "NEW");
      })
      .catch((cause: unknown) => { if (active) setError(message(cause, "Data pegawai tidak dapat dimuat.")); });
    return () => { active = false; };
  }, [employeeId, attempt]);

  async function run(label: string, work: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
      setAttempt((value) => value + 1);
      onChanged();
      return true;
    } catch (cause) {
      setError(message(cause, "Tindakan gagal."));
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (!detail) {
    return (
      <div className="p-5 text-sm text-muted-foreground" role={error ? "alert" : "status"}>
        {error ?? <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Memuat…</span>}
      </div>
    );
  }

  const { employee, photo, cards } = detail;
  const current = cards.find((card) => card.status === "ACTIVE") ?? null;
  const latest = cards[0] ?? null;
  const reasons: IssueReason[] = cards.length ? ["LOST", "DAMAGED", "DATA_CHANGED", "EXPIRED"] : ["NEW"];
  const canIssue = employee.active && photo !== null;

  return (
    <div className="grid gap-5 p-5">
      <div>
        <p className="text-base font-bold text-brand-heading">{employee.fullName}</p>
        <p className="text-xs text-muted-foreground">
          NIP {employee.employeeNumber} · {employee.positionTitle ?? "Jabatan belum tercatat"} · {employee.unitName ?? "Unit belum tercatat"}
          {employee.active ? "" : " · bukan pegawai aktif"}
        </p>
      </div>

      {notice ? <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900" role="status">{notice}</p> : null}
      {error ? <p className="rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-800" role="alert">{error}</p> : null}

      <section className="flex flex-wrap items-start gap-4">
        <div className="h-32 w-24 shrink-0 overflow-hidden rounded-xl border border-border bg-surface">
          {photo
            ? <img src={employeePhotoUrl(employee.id, photo.id)} alt={`Foto ${employee.fullName}`} className="h-full w-full object-cover" />
            : <div className="flex h-full items-center justify-center p-2 text-center text-[11px] text-muted-foreground">Belum ada foto</div>}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-brand-heading">Pas foto</p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {photo ? `Diunggah ${formatInstant(photo.uploadedAt)}. ` : ""}
            Latar polos, wajah menghadap depan. Foto dipotong 3:4 otomatis. Kartu yang sudah terbit tetap memakai fotonya sendiri.
          </p>
          <label className="mt-2 inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-border bg-surface-raised px-4 text-sm font-bold text-brand-primary-deep">
            {busy === "photo" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ImageUp className="h-4 w-4" aria-hidden="true" />}
            {photo ? "Ganti foto" : "Unggah foto"}
            <input type="file" accept="image/jpeg,image/png" className="sr-only" disabled={busy !== null}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void run("photo", async () => uploadEmployeePhoto(employee.id, await preparePhoto(file)), "Foto tersimpan.");
              }} />
          </label>
        </div>
      </section>

      {latest ? (
        <section className="flex flex-wrap items-start gap-4">
          <EmployeeIdCardFront card={latest} photoUrl={cardPhotoUrl(latest.id)} scale={3} className="shrink-0 border border-border" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-bold text-brand-heading">{current ? "Kartu aktif" : "Kartu terakhir"}</p>
            <p className="mt-1">
              {latest.cardNumber} · cetakan ke-{latest.edition}<br />
              Status: {latest.invalidReason ? invalidReasonLabel[latest.invalidReason] : "Aktif"}<br />
              Berlaku s.d. {formatDate(latest.validUntil)} · dicetak {latest.printCount}×
            </p>
            {latest.dataChanged ? (
              <p className="mt-2 flex items-start gap-1.5 text-xs font-semibold text-orange-800">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Nama, NIP, jabatan, atau unit sudah berubah sejak kartu terbit. Terbitkan ulang dengan alasan Data berubah.
              </p>
            ) : null}
            {current ? (
              <button type="button" onClick={() => openPrint([current.id])}
                className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-surface-raised px-4 text-sm font-bold text-brand-primary-deep">
                <Printer className="h-4 w-4" aria-hidden="true" /> Cetak kartu ini
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-border/75 p-4">
        <p className="text-sm font-bold text-brand-heading">{cards.length ? "Terbitkan ulang" : "Terbitkan kartu"}</p>
        {!canIssue ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {employee.active ? "Unggah pas foto dulu." : "Kartu hanya untuk pegawai aktif."}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs font-semibold text-brand-heading">
            Alasan
            <select value={reason} onChange={(event) => setReason(event.target.value as IssueReason)} disabled={!canIssue}
              className="min-h-11 rounded-xl border border-border bg-surface-raised px-3 text-sm">
              {reasons.map((value) => <option key={value} value={value}>{issueReasonLabel[value]}</option>)}
            </select>
          </label>
          <label className="grid min-w-48 flex-1 gap-1 text-xs font-semibold text-brand-heading">
            Catatan (opsional)
            <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={300} disabled={!canIssue}
              className="min-h-11 rounded-xl border border-border bg-surface-raised px-3 text-sm" />
          </label>
          <button type="button" disabled={!canIssue || busy !== null}
            onClick={() => void run("issue", () => issueEmployeeCard(employee.id, { reason, note: note.trim() || undefined }),
              current ? "Kartu baru terbit; kartu lama tidak berlaku lagi." : "Kartu terbit.")}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">
            {busy === "issue" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null} Terbitkan
          </button>
        </div>
        {current ? <p className="mt-2 text-xs text-muted-foreground">Kartu {current.cardNumber} otomatis menjadi “Diganti” dan tidak berlaku saat dipindai.</p> : null}
      </section>

      {latest && (latest.status === "ACTIVE" || latest.status === "REPORTED_LOST") ? (
        revoking ? (
          <section className="rounded-2xl border border-red-200 bg-red-50 p-4">
            <label className="grid gap-1 text-xs font-semibold text-red-900">
              Alasan pencabutan (5–300 karakter)
              <input value={revokeReason} onChange={(event) => setRevokeReason(event.target.value)} maxLength={300}
                className="min-h-11 rounded-xl border border-red-200 bg-white px-3 text-sm text-brand-heading" />
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" disabled={revokeReason.trim().length < 5 || busy !== null}
                onClick={() => void run("revoke", () => revokeEmployeeCard(latest.id, revokeReason.trim()), "Kartu dicabut.").then((ok) => {
                  if (!ok) return;
                  setRevoking(false);
                  setRevokeReason("");
                })}
                className="min-h-11 rounded-xl bg-red-700 px-4 text-sm font-bold text-white disabled:opacity-50">Cabut kartu</button>
              <button type="button" onClick={() => setRevoking(false)}
                className="min-h-11 rounded-xl border border-border bg-white px-4 text-sm font-bold text-brand-heading">Batal</button>
            </div>
          </section>
        ) : (
          <button type="button" onClick={() => setRevoking(true)}
            className="min-h-11 justify-self-start rounded-xl border border-red-200 bg-surface-raised px-4 text-sm font-bold text-red-800">
            Cabut kartu {latest.cardNumber}
          </button>
        )
      ) : null}

      {cards.length ? (
        <section>
          <p className="text-sm font-bold text-brand-heading">Riwayat kartu</p>
          <div className="mt-2 overflow-x-auto rounded-xl border border-border/75">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead className="bg-surface text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-semibold">No. kartu</th>
                  <th className="px-3 py-2 font-semibold">Cetakan</th>
                  <th className="px-3 py-2 font-semibold">Terbit</th>
                  <th className="px-3 py-2 font-semibold">Alasan</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">Cetak</th>
                </tr>
              </thead>
              <tbody>
                {cards.map((card) => (
                  <tr key={card.id} className="border-t border-border/60">
                    <td className="px-3 py-2 font-semibold">{card.cardNumber}</td>
                    <td className="px-3 py-2">ke-{card.edition}</td>
                    <td className="px-3 py-2">{formatInstant(card.issuedAt)}</td>
                    <td className="px-3 py-2">{issueReasonLabel[card.issueReason]}</td>
                    <td className="px-3 py-2">
                      {card.invalidReason && card.status === "ACTIVE" ? invalidReasonLabel[card.invalidReason] : statusLabel[card.status]}
                      {card.endReason ? <span className="block text-[11px] text-muted-foreground">{card.endReason}</span> : null}
                    </td>
                    <td className="px-3 py-2">{card.printCount}×</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function EmployeesTab() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CardFilter | "">("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [items, setItems] = useState<CardListItem[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selectedEmployee, setSelectedEmployee] = useState<string | null>(null);
  const [printSelection, setPrintSelection] = useState<Set<string>>(new Set());

  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(search.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    listEmployeeCards({ page, pageSize, q: query.length >= 2 ? query : undefined, filter })
      .then((result) => { if (active) { setItems(result.items); setPagination(result.pagination); setError(null); } })
      .catch((cause: unknown) => { if (active) setError(message(cause, "Daftar pegawai tidak dapat dimuat.")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, pageSize, query, filter, attempt]);

  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  // Kept across pages and filters, so HC can gather one batch from several searches.
  const togglePrint = (cardId: string) => setPrintSelection((previous) => {
    const next = new Set(previous);
    if (next.has(cardId)) next.delete(cardId);
    else next.add(cardId);
    return next;
  });
  const overLimit = printSelection.size > MAX_BATCH;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="min-w-0 overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
        <div className="flex flex-wrap items-end gap-2 p-4">
          <label className="relative min-w-48 flex-1">
            <span className="sr-only">Cari nama atau NIP</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cari nama atau NIP"
              className="min-h-11 w-full rounded-xl border border-border bg-surface-raised pl-9 pr-3 text-sm" />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-brand-heading">
            <span className="sr-only">Saring status kartu</span>
            <select value={filter} onChange={(event) => { setFilter(event.target.value as CardFilter | ""); setPage(1); }}
              className="min-h-11 rounded-xl border border-border bg-surface-raised px-3 text-sm">
              <option value="">Semua pegawai</option>
              {(Object.keys(filterLabel) as CardFilter[]).map((key) => <option key={key} value={key}>{filterLabel[key]}</option>)}
            </select>
          </label>
        </div>
        {printSelection.size ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border/70 bg-surface px-4 py-2 text-sm">
            <span className={cn("font-semibold", overLimit ? "text-red-800" : "text-brand-heading")}>
              {printSelection.size} kartu dipilih{overLimit ? ` (maks ${MAX_BATCH} sekali cetak)` : ""}
            </span>
            <button type="button" disabled={overLimit} onClick={() => openPrint([...printSelection])}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">
              <Printer className="h-4 w-4" aria-hidden="true" /> Cetak
            </button>
            <button type="button" onClick={() => setPrintSelection(new Set())}
              className="min-h-11 rounded-xl px-3 text-sm font-semibold text-brand-primary-deep">Kosongkan</button>
          </div>
        ) : null}
        {error ? (
          <div className="border-t border-border/70 p-4 text-sm" role="alert">
            {error}
            <button type="button" onClick={refresh} className="ml-2 inline-flex min-h-11 items-center gap-1 font-bold text-brand-primary-deep">
              <RotateCw className="h-4 w-4" aria-hidden="true" /> Coba lagi
            </button>
          </div>
        ) : null}
        <div className="overflow-x-auto border-t border-border/70">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-surface text-xs text-muted-foreground">
              <tr>
                <th className="w-12 px-3 py-2 font-semibold"><span className="sr-only">Pilih untuk cetak</span></th>
                <th className="px-3 py-2 font-semibold">Pegawai</th>
                <th className="px-3 py-2 font-semibold">Foto</th>
                <th className="px-3 py-2 font-semibold">Kartu</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const printable = item.card && !item.card.invalidReason ? item.card : null;
                return (
                  <tr key={item.employeeId} className={cn("border-t border-border/60", selectedEmployee === item.employeeId && "bg-brand-primary/5")}>
                    <td className="px-3 py-2">
                      {printable ? (
                        <input type="checkbox" className="h-5 w-5" checked={printSelection.has(printable.id)}
                          aria-label={`Pilih kartu ${item.fullName} untuk dicetak`}
                          onChange={() => togglePrint(printable.id)} />
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => setSelectedEmployee(item.employeeId)}
                        className="min-h-11 text-left font-semibold text-brand-heading underline-offset-2 hover:underline">
                        {item.fullName}
                        <span className="block text-[11px] font-normal text-muted-foreground">
                          {item.employeeNumber} · {item.unitName ?? "Unit belum tercatat"}
                        </span>
                      </button>
                    </td>
                    <td className="px-3 py-2 text-xs">{item.hasPhoto ? "Ada" : <span className="text-orange-800">Belum ada</span>}</td>
                    <td className="px-3 py-2 text-xs"><CardState item={item} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!loading && !error && items.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">Tidak ada pegawai yang cocok.</p>
          ) : null}
          {loading ? (
            <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Memuat…
            </p>
          ) : null}
        </div>
        {pagination ? (
          <PaginationBar page={pagination.page} pageSize={pagination.pageSize} total={pagination.total} onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} />
        ) : null}
      </section>
      <section className="min-w-0 rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
        {selectedEmployee
          ? <EmployeePanel key={selectedEmployee} employeeId={selectedEmployee} onChanged={refresh} />
          : <p className="p-5 text-sm text-muted-foreground">Pilih pegawai untuk mengunggah foto, menerbitkan, atau mencetak kartu.</p>}
      </section>
    </div>
  );
}

function SettingsTab() {
  const [settings, setSettings] = useState<CardSettings | null>(null);
  const [form, setForm] = useState({ signerTitle: "", signerName: "", validityMonths: 24 });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getCardSettings()
      .then((result) => {
        setSettings(result);
        setForm({ signerTitle: result.signerTitle, signerName: result.signerName ?? "", validityMonths: result.validityMonths });
      })
      .catch((cause: unknown) => setError(message(cause, "Pengaturan tidak dapat dimuat.")));
  }, []);
  useEffect(load, [load]);

  async function save(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
      load();
    } catch (cause) {
      setError(message(cause, "Pengaturan gagal disimpan."));
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return <p className="text-sm text-muted-foreground" role={error ? "alert" : "status"}>{error ?? "Memuat pengaturan…"}</p>;
  }

  return (
    <section className="max-w-2xl rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
      {notice ? <p className="mb-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900" role="status">{notice}</p> : null}
      {error ? <p className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-800" role="alert">{error}</p> : null}
      <form className="grid gap-3" onSubmit={(event) => {
        event.preventDefault();
        void save(() => saveCardSettings({ ...form, signerTitle: form.signerTitle.trim(), signerName: form.signerName.trim() }), "Pengaturan tersimpan.");
      }}>
        <label className="grid gap-1 text-xs font-semibold text-brand-heading">
          Jabatan penanda tangan
          <input required maxLength={120} value={form.signerTitle} onChange={(event) => setForm({ ...form, signerTitle: event.target.value })}
            className="min-h-11 rounded-xl border border-border bg-surface-raised px-3 text-sm" />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-brand-heading">
          Nama penanda tangan
          <input required maxLength={120} value={form.signerName} onChange={(event) => setForm({ ...form, signerName: event.target.value })}
            className="min-h-11 rounded-xl border border-border bg-surface-raised px-3 text-sm" />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-brand-heading">
          Masa berlaku kartu baru (bulan, 12–60)
          <input required type="number" min={12} max={60} value={form.validityMonths}
            onChange={(event) => setForm({ ...form, validityMonths: Number(event.target.value) })}
            className="min-h-11 w-32 rounded-xl border border-border bg-surface-raised px-3 text-sm" />
        </label>
        <p className="text-xs leading-5 text-muted-foreground">
          Nama penanda tangan dan masa berlaku dicatat pada kartu saat terbit; kartu yang sudah terbit tidak berubah.
        </p>
        <button type="submit" disabled={busy}
          className="min-h-11 justify-self-start rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">Simpan</button>
      </form>

      <div className="mt-6 border-t border-border/70 pt-5">
        <p className="text-sm font-bold text-brand-heading">Gambar tanda tangan</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">PNG berlatar transparan, maks 512 KB. Dicetak di sisi belakang semua kartu.</p>
        {settings.hasSignature ? (
          <img src={adminSignatureUrl(settings.updatedAt)} alt="Tanda tangan saat ini" className="mt-3 h-16 rounded-lg border border-border bg-white object-contain p-1" />
        ) : <p className="mt-2 text-xs font-semibold text-orange-800">Belum diunggah: kartu dicetak dengan garis tanda tangan kosong.</p>}
        <label className="mt-3 inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-border bg-surface-raised px-4 text-sm font-bold text-brand-primary-deep">
          <ImageUp className="h-4 w-4" aria-hidden="true" /> {settings.hasSignature ? "Ganti tanda tangan" : "Unggah tanda tangan"}
          <input type="file" accept="image/png" className="sr-only" disabled={busy} onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void save(async () => uploadSignature(await readSignature(file)), "Tanda tangan tersimpan.");
          }} />
        </label>
      </div>
    </section>
  );
}

function HistoryTab() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [items, setItems] = useState<CardAuditEvent[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listCardAuditEvents(page, pageSize)
      .then((result) => { if (active) { setItems(result.items); setPagination(result.pagination); setError(null); } })
      .catch((cause: unknown) => { if (active) setError(message(cause, "Riwayat tidak dapat dimuat.")); });
    return () => { active = false; };
  }, [page, pageSize]);

  return (
    <section className="overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
      {error ? <p className="p-5 text-sm" role="alert">{error}</p> : null}
      {items.length ? (
        <ul className="divide-y divide-border/60">
          {items.map((event) => (
            <li key={event.id} className="px-5 py-3">
              <p className="text-sm font-semibold text-brand-heading">
                {eventLabel[event.eventType] ?? event.eventType}
                {event.employeeName ? ` · ${event.employeeName}` : ""}
                {typeof event.metadata.cardNumber === "string" ? ` · ${event.metadata.cardNumber}` : ""}
              </p>
              <p className="mt-0.5 text-[11px] font-semibold text-muted-foreground">
                {formatInstant(event.occurredAt)} · {event.actorName ?? "Sistem"}{event.reason ? ` · ${event.reason}` : ""}
              </p>
            </li>
          ))}
        </ul>
      ) : pagination ? <p className="p-5 text-sm text-muted-foreground">Belum ada riwayat.</p> : null}
      {pagination ? (
        <PaginationBar page={pagination.page} pageSize={pagination.pageSize} total={pagination.total} onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} />
      ) : null}
    </section>
  );
}

export function AdminEmployeeCardsPage() {
  const [tab, setTab] = useState<Tab>("employees");
  const tabs = useMemo<Array<{ key: Tab; label: string }>>(() => [
    { key: "employees", label: "Pegawai" },
    { key: "settings", label: "Pengaturan" },
    { key: "history", label: "Riwayat" },
  ], []);
  return (
    <AdminShell active="services" title="Kartu Pegawai" description="Pas foto, penerbitan, cetak, dan penggantian kartu identitas pegawai.">
      <div className="mb-5 flex gap-2 overflow-x-auto" role="group" aria-label="Bagian Kartu Pegawai">
        {tabs.map((entry) => (
          <button key={entry.key} type="button" aria-pressed={tab === entry.key} onClick={() => setTab(entry.key)}
            className={cn(
              "min-h-11 whitespace-nowrap rounded-xl border px-4 text-sm font-bold",
              tab === entry.key ? "border-brand-primary bg-brand-primary text-brand-foreground" : "border-border bg-surface-raised text-brand-heading",
            )}>
            {entry.label}
          </button>
        ))}
      </div>
      {tab === "employees" ? <EmployeesTab /> : tab === "settings" ? <SettingsTab /> : <HistoryTab />}
    </AdminShell>
  );
}
