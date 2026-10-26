import { AlertTriangle, Loader2, Save } from "lucide-react";
import { useState, type FormEvent } from "react";

import { EmployeeSearchField, type PickedEmployee } from "@/components/attendance/workforce/EmployeeSearchField";
import { correctionTimestamps } from "@/lib/attendanceCorrection";
import { createCanonicalManualCorrection } from "@/lib/workforceAttendance";

function todayJakarta() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date()); }
function longDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

/**
 * "Input koreksi" (attendance.records.manage): one work date plus clock times, an explicit "+1 hari"
 * for a check-out after midnight, and a required reason. The correction is a new fact; scans from the
 * machine and HP are never changed. With `employee` set the employee is fixed (opened from a row).
 */
export function CorrectionEntryForm({ employee: fixedEmployee, initialDate, onSaved, onCancel }: {
  employee?: PickedEmployee | null;
  initialDate?: string;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const [picked, setPicked] = useState<PickedEmployee | null>(fixedEmployee ?? null);
  const [date, setDate] = useState(initialDate ?? todayJakarta());
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [checkOutNextDay, setCheckOutNextDay] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const employee = fixedEmployee ?? picked;
  const times = correctionTimestamps({ date, checkIn, checkOut, checkOutNextDay });
  const ready = Boolean(employee) && Boolean(date) && Boolean(checkIn || checkOut) && reason.trim().length >= 3 && !times.error;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!employee || !ready) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await createCanonicalManualCorrection({
        employeeId: employee.id, workDate: date, checkInAt: times.checkInAt, checkOutAt: times.checkOutAt, reason: reason.trim(),
      });
      setNotice("Koreksi tersimpan beserta alasannya. Data scan dari mesin dan HP tidak diubah.");
      setCheckIn(""); setCheckOut(""); setCheckOutNextDay(false); setReason("");
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Koreksi gagal disimpan.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="grid gap-3" onSubmit={submit}>
      {error ? <div className="flex gap-2 rounded-xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink" role="alert"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div> : null}
      {notice ? <div className="rounded-xl border border-success-line bg-success-soft p-3 text-sm text-success-ink">{notice}</div> : null}
      {fixedEmployee
        ? <p className="text-sm"><span className="text-muted-foreground">Pegawai: </span><span className="font-semibold">{fixedEmployee.fullName}</span> <span className="text-xs text-muted-foreground">{fixedEmployee.employeeNumber}</span></p>
        : <EmployeeSearchField value={picked} onChange={setPicked} />}
      <label className="text-xs font-semibold text-muted-foreground">Tanggal kerja
        <input className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" type="date" max={todayJakarta()} value={date} onChange={(event) => setDate(event.target.value)} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold text-muted-foreground">Jam masuk WIB
          <input className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" type="time" value={checkIn} onChange={(event) => setCheckIn(event.target.value)} />
        </label>
        <div>
          <label className="text-xs font-semibold text-muted-foreground">Jam pulang WIB
            <input className="mt-1 h-10 w-full rounded-xl border px-3 text-sm" type="time" value={checkOut} onChange={(event) => setCheckOut(event.target.value)} />
          </label>
          <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={checkOutNextDay} onChange={(event) => setCheckOutNextDay(event.target.checked)} />Pulang keesokan hari (+1 hari)
          </label>
        </div>
      </div>
      {date && (checkIn || checkOut) ? <p className="text-xs text-muted-foreground">Berlaku untuk tanggal kerja {longDate(date)}{checkOut && checkOutNextDay ? "; jam pulang dicatat pada hari berikutnya" : ""}.</p> : null}
      {times.error ? <p className="text-xs font-semibold text-danger-ink" role="alert">{times.error}</p> : null}
      <textarea className="min-h-20 rounded-xl border p-3 text-sm" placeholder="Alasan koreksi wajib (min. 3 karakter)" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} />
      <div className="flex flex-wrap gap-2">
        <button disabled={saving || !ready} className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-brand-foreground disabled:opacity-50">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Simpan koreksi
        </button>
        {onCancel ? <button type="button" onClick={onCancel} className="h-10 rounded-xl border px-4 text-xs font-bold">Tutup</button> : null}
      </div>
    </form>
  );
}
