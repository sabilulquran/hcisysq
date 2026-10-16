import { CalendarDays, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AdminShell } from "@/layouts/AdminShell";
import { AdminApiError } from "@/lib/adminEmployees";
import {
  deleteLeaveCalendarException,
  getLeaveCalendar,
  type LeaveCalendarConfiguration,
  updateLeaveWorkweek,
  upsertLeaveCalendarException,
} from "@/lib/adminLeaveCalendar";

const weekdays = [
  { value: 1, label: "Senin" },
  { value: 2, label: "Selasa" },
  { value: 3, label: "Rabu" },
  { value: 4, label: "Kamis" },
  { value: 5, label: "Jumat" },
  { value: 6, label: "Sabtu" },
  { value: 7, label: "Minggu" },
];

export function AdminLeaveCalendarPage() {
  const [data, setData] = useState<LeaveCalendarConfiguration | null>(null);
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [label, setLabel] = useState("");
  const [isWorkingDay, setIsWorkingDay] = useState(false);

  const load = async () => {
    try {
      const result = await getLeaveCalendar();
      setData(result);
      setSelectedWeekdays(result.workingWeekdays ?? []);
    } catch (cause) {
      setError(
        cause instanceof AdminApiError
          ? cause.message
          : "Kalender kerja tidak dapat dimuat.",
      );
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const yearLabel = useMemo(() => data?.year ?? new Date().getFullYear(), [data]);

  const toggleDay = (value: number) => {
    setSelectedWeekdays((current) =>
      current.includes(value)
        ? current.filter((day) => day !== value)
        : [...current, value].sort((a, b) => a - b),
    );
  };

  const saveWorkweek = async () => {
    setError(null);
    if (selectedWeekdays.length === 0) {
      setError("Pilih minimal satu hari kerja mingguan.");
      return;
    }
    setSaving(true);
    try {
      await updateLeaveWorkweek(selectedWeekdays);
      await load();
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : "Hari kerja tidak dapat disimpan.");
    } finally {
      setSaving(false);
    }
  };

  const addException = async () => {
    if (!date) {
      setError("Pilih tanggal pengecualian.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await upsertLeaveCalendarException({
        date,
        isWorkingDay,
        label: label || null,
      });
      setDate("");
      setLabel("");
      setIsWorkingDay(false);
      await load();
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : "Pengecualian kalender tidak dapat disimpan.");
    } finally {
      setSaving(false);
    }
  };

  const removeException = async (targetDate: string) => {
    setSaving(true);
    setError(null);
    try {
      await deleteLeaveCalendarException(targetDate);
      await load();
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : "Pengecualian kalender tidak dapat dihapus.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminShell
      active="leave-calendar"
      title="Kalender Kerja Cuti"
      description="Kalender ini dipakai backend untuk menghitung hari kerja. Tidak ada asumsi Senin-Jumat: hari kerja harus dikonfigurasi eksplisit."
    >
      {error ? (
        <div className="mb-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div>
      ) : null}

      <section className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
        <article className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
          <div className="flex items-center gap-3">
            <CalendarDays className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
            <div>
              <h2 className="text-base font-bold text-brand-heading">Hari kerja mingguan</h2>
              <p className="mt-1 text-xs text-muted-foreground">Timezone: {data?.timezone ?? "Asia/Jakarta"}</p>
            </div>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-2">
            {weekdays.map((day) => {
              const selected = selectedWeekdays.includes(day.value);
              return (
                <button
                  key={day.value}
                  type="button"
                  onClick={() => toggleDay(day.value)}
                  className={`rounded-xl border px-3 py-2.5 text-sm font-semibold ${
                    selected
                      ? "border-brand-primary/35 bg-brand-primary-pale text-brand-primary-deep"
                      : "border-border bg-surface-raised text-muted-foreground"
                  }`}
                >
                  {day.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={() => void saveWorkweek()}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
            Simpan hari kerja
          </button>
        </article>

        <article className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
          <h2 className="text-base font-bold text-brand-heading">Pengecualian {yearLabel}</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Gunakan untuk libur/collective leave yang jatuh pada hari kerja, atau hari kerja khusus yang jatuh pada hari non-kerja mingguan.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-[10rem_1fr_auto]">
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className="h-10 rounded-xl border border-border px-3 text-sm outline-none focus:border-brand-primary"
            />
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Keterangan, mis. libur nasional"
              className="h-10 rounded-xl border border-border px-3 text-sm outline-none focus:border-brand-primary"
            />
            <button
              type="button"
              disabled={saving}
              onClick={() => void addException()}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-border bg-surface-raised px-4 text-sm font-semibold"
            >
              <Plus className="h-4 w-4" aria-hidden="true" /> Tambah
            </button>
          </div>
          <label className="mt-3 inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            <input
              type="checkbox"
              checked={isWorkingDay}
              onChange={(event) => setIsWorkingDay(event.target.checked)}
            />
            Tandai sebagai hari kerja khusus (default pengecualian = hari tidak bekerja)
          </label>

          <div className="mt-5 divide-y divide-border/70 rounded-2xl border border-border/70">
            {(data?.exceptions ?? []).length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">Belum ada pengecualian kalender.</p>
            ) : (
              data?.exceptions.map((item) => (
                <div key={item.date} className="flex items-center justify-between gap-3 p-3.5">
                  <div>
                    <p className="text-sm font-semibold text-brand-heading">{item.date}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {item.label ?? (item.isWorkingDay ? "Hari kerja khusus" : "Hari tidak bekerja")}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-semibold">
                      {item.isWorkingDay ? "Kerja" : "Libur"}
                    </span>
                    <button
                      type="button"
                      aria-label={`Hapus ${item.date}`}
                      disabled={saving}
                      onClick={() => void removeException(item.date)}
                      className="flex h-9 w-9 items-center justify-center rounded-xl border border-border text-muted-foreground hover:text-danger-ink"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </article>
      </section>
    </AdminShell>
  );
}
