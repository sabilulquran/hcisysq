import { AlertTriangle, CalendarPlus, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import type { AttendanceCalculationScope } from "@/lib/attendanceCalculation";
import {
  groupByPosition,
  unattributedStatusLabel,
  unscheduledReason,
  type AttendanceUnscheduled,
  type UnscheduledEmployee,
} from "@/lib/attendanceUnscheduled";
import { createAttendanceScheduleAssignment, listAttendanceSchedules } from "@/lib/workforceAttendance";

const WEEKDAYS = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];

function shortDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}
function stamp(value: string) {
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

/**
 * "Pasang ke shift yang ada" (attendance.schedule.manage): one schedule pattern per selected employee,
 * through the existing schedule-assignment API. HC chooses the shift, days and start date; nothing is
 * inferred from scan times (I-4).
 */
function AssignToShift({ employees, defaultFrom, onDone, onCancel }: {
  employees: UnscheduledEmployee[];
  defaultFrom: string;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [shifts, setShifts] = useState<Array<{ id: string; name: string; startTime: string; endTime: string }>>([]);
  const [shiftId, setShiftId] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [from, setFrom] = useState(defaultFrom);
  const [selected, setSelected] = useState<string[]>(employees.map((item) => item.employeeId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listAttendanceSchedules()
      .then((result) => setShifts(result.items.filter((item) => item.active)))
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Daftar shift tidak dapat dimuat."));
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    let done = 0;
    try {
      for (const employeeId of selected) {
        await createAttendanceScheduleAssignment({ employeeId, scheduleTemplateId: shiftId, weekdays, effectiveFrom: from, effectiveTo: null });
        done += 1;
      }
      const shift = shifts.find((item) => item.id === shiftId);
      onDone(`${done} pegawai dipasang ke ${shift?.name ?? "shift"} mulai ${shortDate(from)}. Jalankan Kalkulasi untuk menghitung ulang.`);
    } catch (cause) {
      setError(`${done} dari ${selected.length} berhasil. ${cause instanceof Error ? cause.message : "Pemasangan gagal."}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 grid gap-3 rounded-xl border bg-surface-raised p-3 text-sm">
      {error ? <p className="flex gap-2 text-xs font-semibold text-danger-ink" role="alert"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</p> : null}
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
        <label className="text-xs font-semibold text-muted-foreground">Shift
          <select className="mt-1 h-9 w-full rounded-xl border px-3 text-sm" value={shiftId} onChange={(event) => setShiftId(event.target.value)}>
            <option value="">Pilih shift…</option>
            {shifts.map((shift) => <option key={shift.id} value={shift.id}>{shift.name} ({shift.startTime.slice(0, 5)}–{shift.endTime.slice(0, 5)})</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-muted-foreground">Mulai berlaku
          <input type="date" className="mt-1 h-9 rounded-xl border px-3 text-sm" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
      </div>
      <fieldset className="flex flex-wrap gap-2 text-xs">
        <legend className="mb-1 font-semibold text-muted-foreground">Hari kerja</legend>
        {WEEKDAYS.map((label, index) => (
          <label key={label} className="flex items-center gap-1 rounded-lg border px-2 py-1">
            <input type="checkbox" checked={weekdays.includes(index + 1)} onChange={(event) => setWeekdays(event.target.checked ? [...weekdays, index + 1].sort() : weekdays.filter((day) => day !== index + 1))} />{label}
          </label>
        ))}
      </fieldset>
      {employees.length > 1 ? (
        <fieldset className="grid gap-1 text-xs">
          <legend className="mb-1 font-semibold text-muted-foreground">Pegawai</legend>
          {employees.map((employee) => (
            <label key={employee.employeeId} className="flex items-center gap-2">
              <input type="checkbox" checked={selected.includes(employee.employeeId)} onChange={(event) => setSelected(event.target.checked ? [...selected, employee.employeeId] : selected.filter((id) => id !== employee.employeeId))} />
              {employee.employeeName} <span className="text-muted-foreground">{employee.employeeNumber}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <p className="text-xs text-muted-foreground">{selected.length} pegawai, mulai {from ? shortDate(from) : "—"}, hari {weekdays.map((day) => WEEKDAYS[day - 1]).join(", ") || "—"}.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={saving || !shiftId || !from || !selected.length || !weekdays.length} onClick={() => void save()} className="inline-flex h-9 items-center gap-1 rounded-xl bg-brand-primary px-3 text-xs font-bold text-brand-foreground disabled:opacity-50">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarPlus className="h-4 w-4" />} Pasang
        </button>
        <button type="button" onClick={onCancel} className="h-9 rounded-xl border px-3 text-xs font-bold">Batal</button>
      </div>
    </div>
  );
}

/**
 * ATT-014 §20.3 Tanpa Jadwal. Part A: employees who scan on dates without a schedule, grouped by
 * position with shortcuts to assign an existing shift or create one. Part B: machine scans that cannot
 * be attributed yet (shown only when the API returns them, i.e. with attendance.devices.read).
 */
export function UnscheduledTab({ data, scope, canManageSchedules, canMapPins, loading, onPage, onPinPage, onChanged }: {
  data: AttendanceUnscheduled | null;
  scope: AttendanceCalculationScope;
  canManageSchedules: boolean;
  canMapPins: boolean;
  loading: boolean;
  onPage: (page: number) => void;
  onPinPage: (page: number) => void;
  onChanged: () => void;
}) {
  const [assigning, setAssigning] = useState<{ key: string; employees: UnscheduledEmployee[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (!data) return <p className="p-4 text-sm text-muted-foreground">{loading ? "Memuat…" : "Data tanpa jadwal belum dimuat."}</p>;
  const groups = groupByPosition(data.employees.items);

  return (
    <div className="grid gap-4 p-3">
      {notice ? <p className="flex gap-2 rounded-xl border border-success-line bg-success-soft p-3 text-sm text-success-ink"><CheckCircle2 className="h-4 w-4 shrink-0" />{notice}</p> : null}
      <section>
        <h3 className="text-sm font-bold text-brand-heading">Pegawai yang scan tetapi belum punya jadwal ({data.employees.total})</h3>
        <p className="mt-1 text-xs text-muted-foreground">Hari tanpa jadwal tidak dinilai hadir atau tidak hadir. Biasanya satu kelompok jabatan belum punya shift yang cocok. Jam scan di bawah hanya keterangan, bukan usulan jam shift.</p>
        {groups.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">Semua pegawai yang scan pada rentang ini sudah punya jadwal.</p> : null}
        {groups.map((group) => (
          <article key={group.position} className="mt-3 rounded-xl border">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-surface p-3">
              <div>
                <p className="font-semibold">{group.position} <span className="text-xs font-normal text-muted-foreground">· {group.employees.length} pegawai</span></p>
                <p className="text-xs text-muted-foreground">Scan terakhir per hari: {group.lastScanRange}</p>
              </div>
              {canManageSchedules ? (
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setAssigning({ key: group.position, employees: group.employees })} className="h-8 rounded-lg border px-3 text-xs font-bold">Pasang ke shift yang ada</button>
                  <a href="/admin/attendance/shifts" className="inline-flex h-8 items-center gap-1 rounded-lg border px-3 text-xs font-bold"><Plus className="h-3.5 w-3.5" /> Buat shift baru</a>
                </div>
              ) : null}
            </header>
            {assigning?.key === group.position ? (
              <div className="px-3 pb-3">
                <AssignToShift employees={assigning.employees} defaultFrom={scope.from} onCancel={() => setAssigning(null)}
                  onDone={(message) => { setAssigning(null); setNotice(message); onChanged(); }} />
              </div>
            ) : null}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr><th className="p-2">Pegawai</th><th className="p-2">Unit</th><th className="p-2">Hari ber-scan tanpa jadwal</th><th className="p-2">Rentang</th><th className="p-2">Keterangan</th><th className="p-2" /></tr>
                </thead>
                <tbody className="divide-y">
                  {group.employees.map((employee) => (
                    <tr key={employee.employeeId}>
                      <td className="p-2"><p className="font-semibold">{employee.employeeName}</p><p className="text-xs text-muted-foreground">{employee.employeeNumber}</p></td>
                      <td className="p-2">{employee.unitName ?? "—"}</td>
                      <td className="p-2 tabular-nums">{employee.days} hari</td>
                      <td className="p-2 tabular-nums">{shortDate(employee.firstDate)} – {shortDate(employee.lastDate)}</td>
                      <td className="p-2 text-xs">{unscheduledReason(employee)}</td>
                      <td className="p-2">
                        {canManageSchedules ? <button type="button" onClick={() => setAssigning({ key: group.position, employees: [employee] })} className="h-8 rounded-lg border px-2 text-xs font-bold">Pasang jadwal</button> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        ))}
        {data.employees.totalPages > 1 ? (
          <div className="mt-2 flex items-center justify-end gap-2 text-xs text-muted-foreground">
            <span>Halaman {data.employees.page} dari {data.employees.totalPages}</span>
            <button type="button" aria-label="Halaman sebelumnya" disabled={data.employees.page <= 1} onClick={() => onPage(data.employees.page - 1)} className="rounded-lg border p-1.5 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
            <button type="button" aria-label="Halaman berikutnya" disabled={data.employees.page >= data.employees.totalPages} onClick={() => onPage(data.employees.page + 1)} className="rounded-lg border p-1.5 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
          </div>
        ) : null}
      </section>

      {data.pins ? (
        <section>
          <h3 className="text-sm font-bold text-brand-heading">Scan mesin yang belum bisa dikaitkan ke pegawai ({data.pins.total})</h3>
          <p className="mt-1 text-xs text-muted-foreground">Scan ini tersimpan di HCIS tetapi belum menjadi milik pegawai mana pun, sehingga tidak ikut dihitung.</p>
          <div className="mt-2 overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="bg-surface text-xs text-muted-foreground">
                <tr><th className="p-2">Mesin</th><th className="p-2">PIN</th><th className="p-2">Scan</th><th className="p-2">Rentang scan</th><th className="p-2">Keadaan</th><th className="p-2" /></tr>
              </thead>
              <tbody className="divide-y">
                {data.pins.items.map((pin) => (
                  <tr key={`${pin.deviceId}:${pin.pin}`}>
                    <td className="p-2">{pin.deviceName}</td>
                    <td className="p-2 font-mono">{pin.pin}</td>
                    <td className="p-2 tabular-nums">{pin.scans}</td>
                    <td className="p-2 tabular-nums text-xs">{shortDate(pin.firstScanAt)} – {shortDate(pin.lastScanAt)}</td>
                    <td className="p-2 text-xs">
                      <p className="font-semibold">{unattributedStatusLabel(pin.status)}</p>
                      {pin.mappedEmployeeName ? (
                        <p className="text-muted-foreground">
                          Kini dipetakan ke {pin.mappedEmployeeName}{pin.mappingEffectiveFrom ? `, berlaku ${stamp(pin.mappingEffectiveFrom)}` : ""}{pin.mappedEmployeeStartedOn ? `; TMT ${shortDate(pin.mappedEmployeeStartedOn)}` : ""}
                        </p>
                      ) : null}
                    </td>
                    <td className="p-2">
                      {canMapPins && pin.status === "unmapped" ? <a href={`/admin/attendance/devices/${pin.deviceId}/users`} className="inline-flex h-8 items-center rounded-lg border px-2 text-xs font-bold">Petakan PIN</a> : null}
                    </td>
                  </tr>
                ))}
                {data.pins.items.length === 0 ? <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">Semua scan mesin pada rentang ini sudah terkait ke pegawai.</td></tr> : null}
              </tbody>
            </table>
          </div>
          {data.pins.totalPages > 1 ? (
            <div className="mt-2 flex items-center justify-end gap-2 text-xs text-muted-foreground">
              <span>Halaman {data.pins.page} dari {data.pins.totalPages}</span>
              <button type="button" aria-label="Halaman PIN sebelumnya" disabled={data.pins.page <= 1} onClick={() => onPinPage(data.pins!.page - 1)} className="rounded-lg border p-1.5 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
              <button type="button" aria-label="Halaman PIN berikutnya" disabled={data.pins.page >= data.pins.totalPages} onClick={() => onPinPage(data.pins!.page + 1)} className="rounded-lg border p-1.5 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
            </div>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">Menyesuaikan awal pemetaan ke TMT pegawai tersedia di paket berikutnya (§20.5).</p>
        </section>
      ) : null}
    </div>
  );
}
