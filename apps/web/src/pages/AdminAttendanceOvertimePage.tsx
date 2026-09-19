import { AlertTriangle, CheckCircle2, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import { listEmployees, type AdminEmployeeListItem } from "@/lib/adminEmployees";
import {
  createAttendanceOvertimeForEmployee,
  decideAttendanceOvertime,
  listAttendanceOvertime,
  type AttendanceOvertimeItem,
} from "@/lib/workforceAttendance";

export function AdminAttendanceOvertimePage() {
  const [items, setItems] = useState<AttendanceOvertimeItem[]>([]);
  const [employees, setEmployees] = useState<AdminEmployeeListItem[]>([]);
  const [status, setStatus] = useState<"all" | "submitted" | "approved" | "rejected" | "cancelled">("submitted");
  const [form, setForm] = useState({ employeeId: "", workDate: "", requestedMinutes: "60", note: "" });
  const [approvedMinutes, setApprovedMinutes] = useState<Record<string, string>>({});
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    const [overtime, employeePage] = await Promise.all([
      listAttendanceOvertime(status),
      listEmployees({ page: 1, pageSize: 100, status: "active" }),
    ]);
    setItems(overtime.items);
    setEmployees(employeePage.items);
    setForm((current) => ({ ...current, employeeId: current.employeeId || employeePage.items[0]?.id || "" }));
  };
  useEffect(() => {
    void Promise.all([
      listAttendanceOvertime(status),
      listEmployees({ page: 1, pageSize: 100, status: "active" }),
    ]).then(([overtimeResult, employeePage]) => {
      setItems(overtimeResult.items);
      setEmployees(employeePage.items);
      setForm((current) => ({ ...current, employeeId: current.employeeId || employeePage.items[0]?.id || "" }));
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Data lembur tidak dapat dimuat."));
  }, [status]);

  const run = async (key: string, action: () => Promise<unknown>, message: string) => {
    setBusy(key); setError(null); setNotice(null);
    try { await action(); await load(); setNotice(message); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Operasi lembur gagal."); }
    finally { setBusy(null); }
  };

  return (
    <AttendanceWorkforceShell section="overtime" title="Lembur" description="Lembur hanya berasal dari menit yang disetujui; checkout terlambat tidak otomatis dihitung lembur.">
      {error ? <div className="mb-4 flex gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><AlertTriangle className="h-4 w-4" />{error}</div> : null}
      {notice ? <div className="mb-4 flex gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" />{notice}</div> : null}

      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <h2 className="font-bold text-brand-heading">Tambah pengajuan</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <select className="h-11 rounded-xl border px-3 text-sm" value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
            {employees.map((item) => <option key={item.id} value={item.id}>{item.fullName} · {item.employeeNumber}</option>)}
          </select>
          <input className="h-11 rounded-xl border px-3 text-sm" type="date" value={form.workDate} onChange={(e) => setForm({ ...form, workDate: e.target.value })} />
          <input className="h-11 rounded-xl border px-3 text-sm" type="number" min="1" max="1440" value={form.requestedMinutes} onChange={(e) => setForm({ ...form, requestedMinutes: e.target.value })} placeholder="Menit" />
          <input className="h-11 rounded-xl border px-3 text-sm" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Catatan (opsional)" />
        </div>
        <button disabled={busy !== null || !form.employeeId || !form.workDate} className="mt-3 inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-white disabled:opacity-50" onClick={() => void run("create", async () => {
          await createAttendanceOvertimeForEmployee({ employeeId: form.employeeId, workDate: form.workDate, requestedMinutes: Number(form.requestedMinutes), note: form.note || null });
          setForm((current) => ({ ...current, workDate: "", requestedMinutes: "60", note: "" }));
        }, "Pengajuan lembur dibuat.")}><Plus className="h-4 w-4" /> Tambah pengajuan</button>
      </section>

      <section className="mt-5 overflow-hidden rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <header className="flex items-center justify-between gap-3 border-b p-4">
          <div><h2 className="font-bold text-brand-heading">Pengajuan lembur</h2><p className="mt-1 text-xs text-muted-foreground">Persetujuan dapat menurunkan durasi, tetapi tidak melebihi durasi yang diajukan.</p></div>
          <select className="h-10 rounded-xl border px-3 text-sm" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="submitted">Menunggu</option><option value="approved">Disetujui</option><option value="rejected">Ditolak</option><option value="cancelled">Dibatalkan</option><option value="all">Semua</option>
          </select>
        </header>
        <div className="overflow-x-auto"><table className="min-w-[1100px] w-full text-left text-sm"><thead className="bg-surface text-xs text-muted-foreground"><tr><th className="p-3">Pegawai</th><th className="p-3">Tanggal</th><th className="p-3">Diajukan</th><th className="p-3">Disetujui</th><th className="p-3">Status</th><th className="p-3">Catatan</th><th className="p-3">Keputusan</th></tr></thead>
        <tbody className="divide-y">{items.map((item) => <tr key={item.id}><td className="p-3"><p className="font-semibold">{item.employeeName ?? "Pegawai"}</p><p className="text-xs text-muted-foreground">{item.employeeNumber ?? ""} {item.unitName ? "· "+item.unitName : ""}</p></td><td className="p-3">{item.workDate}</td><td className="p-3">{item.requestedMinutes} mnt</td><td className="p-3">{item.approvedMinutes == null ? "—" : item.approvedMinutes+" mnt"}</td><td className="p-3">{item.status}</td><td className="p-3">{item.decisionNote ?? item.note ?? "—"}</td><td className="p-3">{item.status === "submitted" ? <div className="grid min-w-[300px] grid-cols-[90px_1fr_auto_auto] gap-2"><input className="h-9 rounded-lg border px-2" type="number" min="0" max={item.requestedMinutes} value={approvedMinutes[item.id] ?? String(item.requestedMinutes)} onChange={(e) => setApprovedMinutes({ ...approvedMinutes, [item.id]: e.target.value })}/><input className="h-9 rounded-lg border px-2" placeholder="Catatan" value={decisionNotes[item.id] ?? ""} onChange={(e) => setDecisionNotes({ ...decisionNotes, [item.id]: e.target.value })}/><button disabled={busy !== null} className="rounded-lg bg-brand-primary px-3 text-xs font-bold text-white" onClick={() => void run(item.id, () => decideAttendanceOvertime(item.id, { decision: "approve", approvedMinutes: Number(approvedMinutes[item.id] ?? item.requestedMinutes), note: decisionNotes[item.id] || null }), "Lembur disetujui.")}>Setujui</button><button disabled={busy !== null} className="rounded-lg border px-3 text-xs font-bold" onClick={() => void run(item.id, () => decideAttendanceOvertime(item.id, { decision: "reject", note: decisionNotes[item.id] || null }), "Lembur ditolak.")}>Tolak</button></div> : "—"}</td></tr>)}
        {items.length === 0 ? <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">Tidak ada pengajuan pada filter ini.</td></tr> : null}</tbody></table></div>
      </section>
    </AttendanceWorkforceShell>
  );
}
