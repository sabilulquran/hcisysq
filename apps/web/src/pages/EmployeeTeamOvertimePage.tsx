import { AlertTriangle, CheckCircle2, Loader2, Plus, Send, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { requestStatusLabel } from "@/lib/attendanceLabels";
import { AppShell } from "@/layouts/AppShell";
import {
  cancelTeamOvertimeOrder,
  decideTeamOvertime,
  getMyWorkforceAttendance,
  listOvertimeSubordinates,
  listTeamOvertime,
  orderTeamOvertime,
  type TeamOvertimeItem,
  type TeamOvertimeTab,
} from "@/lib/workforceAttendance";

// ATT-011-6b-2 §7.4 Lembur Tim (mobile-first cards): the supervisor approves or rejects their direct
// reports' requests and orders overtime, which each employee then agrees to. The API decides who may act.

const TABS: Array<{ value: TeamOvertimeTab; label: string }> = [
  { value: "pending", label: "Perlu persetujuan" },
  { value: "orders", label: "Perintah lembur" },
  { value: "history", label: "Riwayat" },
];

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("") || "P";
}
function todayJakarta() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date()); }

export function orderStatusLabel(item: Pick<TeamOvertimeItem, "status" | "initiatedBy">) {
  if (item.initiatedBy !== "supervisor") return requestStatusLabel(item.status);
  if (item.status === "submitted") return "Menunggu persetujuan pegawai";
  if (item.status === "approved") return "Disetujui pegawai";
  if (item.status === "rejected") return "Ditolak pegawai";
  return "Dibatalkan";
}

export function EmployeeTeamOvertimePage() {
  const [user, setUser] = useState({ name: "Pegawai", initials: "P", position: "Pegawai", unit: "Yayasan Sabilul Qur'an" });
  const [tab, setTab] = useState<TeamOvertimeTab>("pending");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Awaited<ReturnType<typeof listTeamOvertime>> | null>(null);
  const [minutes, setMinutes] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ordering, setOrdering] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await listTeamOvertime(tab, page));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Lembur tim tidak dapat dimuat.");
    }
  }, [tab, page]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void getMyWorkforceAttendance()
      .then((snapshot) => setUser({ name: snapshot.employee.fullName, initials: initials(snapshot.employee.fullName), position: "Pegawai", unit: "Yayasan Sabilul Qur'an" }))
      .catch(() => undefined);
  }, []);

  const run = async (key: string, action: () => Promise<unknown>, message: string) => {
    setBusy(key); setError(null); setNotice(null);
    try { await action(); setNotice(message); setSelected(new Set()); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Lembur gagal disimpan."); }
    finally { setBusy(null); }
  };
  const approveSelected = () => run("bulk", async () => {
    for (const id of selected) await decideTeamOvertime(id, { decision: "approve" });
  }, `${selected.size} pengajuan disetujui sesuai pengajuan.`);

  return (
    <AppShell user={user} activeItem="Lembur Tim">
      <section>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Waktu & Kehadiran</p>
        <h1 className="mt-1 text-2xl font-bold text-brand-heading">Lembur Tim</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">Setujui atau tolak lembur bawahan langsung Anda, dan perintahkan lembur yang perlu disetujui pegawainya. Persetujuan di HCIS berlaku sebagai persetujuan tertulis.</p>
      </section>
      {error ? <div role="alert" className="mt-4 flex gap-2 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div> : null}
      {notice ? <div role="status" className="mt-4 flex gap-2 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink"><CheckCircle2 className="h-4 w-4 shrink-0" />{notice}</div> : null}

      <nav className="mt-5 flex flex-wrap gap-2" role="tablist" aria-label="Lembur tim">
        {TABS.map((item) => (
          <button key={item.value} type="button" role="tab" aria-selected={tab === item.value} onClick={() => { setTab(item.value); setPage(1); setSelected(new Set()); }}
            className={`min-h-11 rounded-full border px-4 text-sm font-semibold ${tab === item.value ? "border-brand-primary/40 bg-brand-primary-pale text-brand-primary-deep" : "text-muted-foreground"}`}>{item.label}</button>
        ))}
        {data?.isSupervisor ? (
          <button type="button" onClick={() => setOrdering(!ordering)} className="ml-auto inline-flex min-h-11 items-center gap-1 rounded-full bg-brand-primary px-4 text-sm font-semibold text-brand-foreground"><Plus className="h-4 w-4" /> Perintahkan lembur</button>
        ) : null}
      </nav>

      {ordering ? <OrderForm busy={busy !== null} onCancel={() => setOrdering(false)} onSubmit={(input) => void run("order", async () => {
        await orderTeamOvertime(input);
        setOrdering(false);
        setTab("orders");
      }, `Perintah lembur dikirim ke ${input.employeeIds.length} pegawai. Menunggu persetujuan pegawai.`)} /> : null}

      {tab === "pending" && selected.size > 0 ? (
        <div className="mt-4 flex items-center justify-between rounded-2xl border bg-surface-raised p-3 text-sm">
          <span>{selected.size} dipilih</span>
          <button type="button" disabled={busy !== null} onClick={() => void approveSelected()} className="rounded-xl bg-brand-primary px-3 py-2 font-semibold text-brand-foreground disabled:opacity-50">Setujui sesuai pengajuan</button>
        </div>
      ) : null}

      <ul className="mt-4 grid gap-3">
        {data?.items.map((item) => (
          <li key={item.id} className="rounded-2xl border bg-surface-raised p-4 text-sm shadow-[var(--shadow-soft)]">
            <div className="flex items-start justify-between gap-3">
              <div className="flex gap-3">
                {tab === "pending" ? <input type="checkbox" className="mt-1 h-5 w-5" aria-label={`Pilih ${item.employeeName}`} checked={selected.has(item.id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })} /> : null}
                <div>
                  <p className="font-semibold">{item.employeeName}</p>
                  <p className="text-xs text-muted-foreground">{item.workDate} · {item.requestedMinutes} mnt{item.approvedMinutes != null ? ` · disetujui ${item.approvedMinutes} mnt` : ""}</p>
                  {item.note ? <p className="mt-1 text-xs">{item.note}</p> : null}
                  {item.decisionNote ? <p className="mt-1 text-xs text-muted-foreground">Catatan: {item.decisionNote}</p> : null}
                </div>
              </div>
              <span className="shrink-0 rounded-full bg-surface px-2.5 py-1 text-xs font-bold">{orderStatusLabel(item)}</span>
            </div>
            {tab === "pending" ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-[110px_1fr_auto_auto]">
                <label className="text-xs text-muted-foreground">Menit disetujui<input className="mt-1 h-10 w-full rounded-xl border px-2 text-sm" type="number" min={1} max={item.requestedMinutes} value={minutes[item.id] ?? String(item.requestedMinutes)} onChange={(event) => setMinutes({ ...minutes, [item.id]: event.target.value })} /></label>
                <label className="text-xs text-muted-foreground">Catatan (wajib bila menolak)<input className="mt-1 h-10 w-full rounded-xl border px-2 text-sm" value={notes[item.id] ?? ""} onChange={(event) => setNotes({ ...notes, [item.id]: event.target.value })} /></label>
                <button type="button" disabled={busy !== null} onClick={() => void run(item.id, () => decideTeamOvertime(item.id, { decision: "approve", approvedMinutes: Number(minutes[item.id] ?? item.requestedMinutes), note: notes[item.id] || null }), "Lembur disetujui.")}
                  className="min-h-10 self-end rounded-xl bg-brand-primary px-4 text-sm font-semibold text-brand-foreground disabled:opacity-50">Setujui</button>
                <button type="button" disabled={busy !== null || !(notes[item.id] ?? "").trim()} onClick={() => void run(item.id, () => decideTeamOvertime(item.id, { decision: "reject", note: notes[item.id] }), "Lembur ditolak.")}
                  className="min-h-10 self-end rounded-xl border px-4 text-sm font-semibold disabled:opacity-50">Tolak</button>
              </div>
            ) : null}
            {tab === "orders" && item.status === "submitted" ? (
              <button type="button" disabled={busy !== null} onClick={() => void run(item.id, () => cancelTeamOvertimeOrder(item.id), "Perintah lembur dibatalkan.")} className="mt-3 min-h-10 rounded-xl border px-4 text-sm font-semibold disabled:opacity-50">Batalkan perintah</button>
            ) : null}
          </li>
        ))}
        {data && data.items.length === 0 ? (
          <li className="rounded-2xl border p-8 text-center text-sm text-muted-foreground">
            {tab === "pending" ? "Tidak ada yang perlu disetujui." : tab === "orders" ? "Belum ada perintah lembur." : "Belum ada riwayat."}
          </li>
        ) : null}
        {!data && !error ? <li className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Memuat…</li> : null}
      </ul>
      {data && data.total > data.pageSize ? (
        <div className="mt-3 flex justify-end gap-2 text-sm">
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="min-h-10 rounded-xl border px-3 disabled:opacity-50">Sebelumnya</button>
          <button type="button" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)} className="min-h-10 rounded-xl border px-3 disabled:opacity-50">Berikutnya</button>
        </div>
      ) : null}
    </AppShell>
  );
}

function OrderForm({ busy, onCancel, onSubmit }: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: { employeeIds: string[]; workDate: string; requestedMinutes: number; note: string }) => void;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Array<{ id: string; fullName: string; employeeNumber: string }>>([]);
  const [picked, setPicked] = useState<Array<{ id: string; fullName: string }>>([]);
  const [workDate, setWorkDate] = useState(todayJakarta());
  const [requestedMinutes, setRequestedMinutes] = useState("60");
  const [note, setNote] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => { void listOvertimeSubordinates(query).then((result) => setOptions(result.items)).catch(() => setOptions([])); }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const ready = picked.length > 0 && workDate && Number(requestedMinutes) > 0 && note.trim().length >= 3;
  return (
    <section aria-label="Perintahkan lembur" className="mt-4 rounded-2xl border bg-surface-raised p-4 text-sm">
      <div className="flex items-center justify-between"><h2 className="font-semibold">Perintahkan lembur</h2><button type="button" aria-label="Tutup" onClick={onCancel}><X className="h-4 w-4" /></button></div>
      <label className="mt-3 block text-xs text-muted-foreground">Bawahan langsung<input className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" placeholder="Cari nama atau NIP" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <ul className="mt-2 max-h-40 overflow-y-auto">
        {options.filter((option) => !picked.some((item) => item.id === option.id)).map((option) => (
          <li key={option.id}><button type="button" className="min-h-10 w-full rounded-lg px-2 text-left hover:bg-surface" onClick={() => setPicked([...picked, { id: option.id, fullName: option.fullName }])}>{option.fullName} <span className="text-muted-foreground">· {option.employeeNumber}</span></button></li>
        ))}
        {options.length === 0 ? <li className="p-2 text-xs text-muted-foreground">Tidak ada bawahan langsung yang cocok.</li> : null}
      </ul>
      {picked.length ? <div className="mt-2 flex flex-wrap gap-2">{picked.map((item) => <span key={item.id} className="inline-flex items-center gap-1 rounded-full bg-brand-primary-pale px-3 py-1 text-xs">{item.fullName}<button type="button" aria-label={`Hapus ${item.fullName}`} onClick={() => setPicked(picked.filter((entry) => entry.id !== item.id))}><X className="h-3 w-3" /></button></span>)}</div> : null}
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-muted-foreground">Tanggal<input type="date" className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" value={workDate} onChange={(event) => setWorkDate(event.target.value)} /></label>
        <label className="text-xs text-muted-foreground">Durasi (menit)<input type="number" min={1} max={1440} className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" value={requestedMinutes} onChange={(event) => setRequestedMinutes(event.target.value)} /></label>
        <label className="text-xs text-muted-foreground">Keterangan<input className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" placeholder="Mis. persiapan wisuda" value={note} onChange={(event) => setNote(event.target.value)} /></label>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="min-h-10 rounded-xl border px-4">Batal</button>
        <button type="button" disabled={busy || !ready} onClick={() => onSubmit({ employeeIds: picked.map((item) => item.id), workDate, requestedMinutes: Number(requestedMinutes), note: note.trim() })}
          className="inline-flex min-h-10 items-center gap-1 rounded-xl bg-brand-primary px-4 font-semibold text-brand-foreground disabled:opacity-50"><Send className="h-4 w-4" /> Kirim</button>
      </div>
    </section>
  );
}
