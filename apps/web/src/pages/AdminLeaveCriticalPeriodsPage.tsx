// LEAVE-009 HC Admin surface: critical periods (masa kritis) such as exam weeks and PPDB.
// Spec: docs/domain/leave-critical-periods.md §9. A period never blocks leave; it adds an HC
// review to leave submitted for those dates. Edits never change requests already submitted.

import { AlertTriangle, Loader2, Pencil, Plus, Power, Save, X } from "lucide-react";
import { useEffect, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { AdminShell } from "@/layouts/AdminShell";
import {
  CriticalPeriodApiError,
  createCriticalPeriod,
  criticalPeriodRange,
  getCriticalPeriods,
  updateCriticalPeriod,
  type CriticalPeriod,
  type CriticalPeriodInput,
  type Pagination,
} from "@/lib/leaveCriticalPeriods";

type StatusFilter = "active" | "inactive" | "all";

const STATUS_LABELS: Record<StatusFilter, string> = {
  active: "Aktif",
  inactive: "Nonaktif",
  all: "Semua",
};

const emptyForm = (): CriticalPeriodInput => ({
  label: "",
  description: null,
  startOn: "",
  endOn: "",
  unitId: null,
});

export function AdminLeaveCriticalPeriodsPage() {
  const [items, setItems] = useState<CriticalPeriod[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [units, setUnits] = useState<Array<{ id: string; name: string }>>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [status, setStatus] = useState<StatusFilter>("active");
  const [form, setForm] = useState<CriticalPeriodInput>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const result = await getCriticalPeriods({ page, pageSize, status });
      setItems(result.items);
      setPaging(result.pagination);
      setUnits(result.unitOptions);
      setError(null);
    } catch (cause) {
      if (cause instanceof CriticalPeriodApiError && cause.status === 403) setForbidden(true);
      setError(cause instanceof Error ? cause.message : "Masa kritis tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, status]);

  const resetForm = () => {
    setForm(emptyForm());
    setEditingId(null);
  };

  const startEdit = (period: CriticalPeriod) => {
    setEditingId(period.id);
    setForm({
      label: period.label,
      description: period.description,
      startOn: period.startOn,
      endOn: period.endOn,
      unitId: period.unitId,
    });
    setNotice(null);
    setError(null);
  };

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Perubahan belum dapat disimpan.");
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!form.label.trim() || !form.startOn || !form.endOn) {
      setError("Isi nama, tanggal mulai, dan tanggal selesai masa kritis.");
      return;
    }
    const input = { ...form, label: form.label.trim(), description: form.description?.trim() || null };
    void run(async () => {
      if (editingId) {
        await updateCriticalPeriod(editingId, input);
        resetForm();
        return "Masa kritis diperbarui. Pengajuan yang sudah dikirim tidak berubah.";
      }
      await createCriticalPeriod(input);
      resetForm();
      return "Masa kritis ditambahkan.";
    });
  };

  const toggleActive = (period: CriticalPeriod) =>
    void run(async () => {
      await updateCriticalPeriod(period.id, { isActive: !period.isActive });
      return period.isActive
        ? `${period.label} dinonaktifkan. Pengajuan baru tidak lagi ditinjau karena masa ini.`
        : `${period.label} diaktifkan kembali.`;
    });

  return (
    <AdminShell
      active="leave-critical-periods"
      title="Masa Kritis Cuti"
      description="Tetapkan pekan ujian, PPDB, pembagian rapor, dan masa sibuk lain. Cuti yang jatuh di masa ini tetap bisa diajukan, tetapi ditinjau Human Capital setelah atasan menyetujui."
    >
      {error ? (
        <div role="alert" className="mb-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div>
      ) : null}
      {notice ? (
        <div role="status" className="mb-5 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink">{notice}</div>
      ) : null}

      {forbidden ? null : (
        <section className="grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
          <article className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-bold text-brand-heading">
                {editingId ? "Ubah masa kritis" : "Tambah masa kritis"}
              </h2>
              {editingId ? (
                <button
                  type="button"
                  onClick={resetForm}
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-2 text-xs font-semibold text-muted-foreground"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" /> Batal
                </button>
              ) : null}
            </div>
            <div className="mt-4 grid gap-3">
              <label className="text-xs font-semibold text-muted-foreground">
                Nama
                <input
                  value={form.label}
                  maxLength={120}
                  onChange={(event) => setForm({ ...form, label: event.target.value })}
                  placeholder="Mis. Ujian Akhir Semester Ganjil"
                  className="mt-1.5 h-10 w-full rounded-xl border border-border px-3 text-sm font-normal text-foreground outline-none focus:border-brand-primary"
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs font-semibold text-muted-foreground">
                  Mulai
                  <input
                    type="date"
                    value={form.startOn}
                    onChange={(event) => setForm({ ...form, startOn: event.target.value })}
                    className="mt-1.5 h-10 w-full rounded-xl border border-border px-3 text-sm font-normal text-foreground outline-none focus:border-brand-primary"
                  />
                </label>
                <label className="text-xs font-semibold text-muted-foreground">
                  Selesai
                  <input
                    type="date"
                    value={form.endOn}
                    min={form.startOn || undefined}
                    onChange={(event) => setForm({ ...form, endOn: event.target.value })}
                    className="mt-1.5 h-10 w-full rounded-xl border border-border px-3 text-sm font-normal text-foreground outline-none focus:border-brand-primary"
                  />
                </label>
              </div>
              <label className="text-xs font-semibold text-muted-foreground">
                Berlaku untuk
                <select
                  value={form.unitId ?? ""}
                  onChange={(event) => setForm({ ...form, unitId: event.target.value || null })}
                  className="mt-1.5 h-10 w-full rounded-xl border border-border bg-surface-raised px-3 text-sm font-normal text-foreground outline-none focus:border-brand-primary"
                >
                  <option value="">Seluruh yayasan</option>
                  {units.map((unit) => (
                    <option key={unit.id} value={unit.id}>{unit.name}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold text-muted-foreground">
                Keterangan (opsional)
                <textarea
                  value={form.description ?? ""}
                  maxLength={500}
                  rows={2}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                  className="mt-1.5 w-full rounded-xl border border-border px-3 py-2 text-sm font-normal text-foreground outline-none focus:border-brand-primary"
                />
              </label>
              <p className="text-xs leading-5 text-muted-foreground">Paling panjang 120 hari per masa kritis.</p>
              <button
                type="button"
                disabled={busy}
                onClick={save}
                className="inline-flex h-10 w-fit items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-60"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : editingId ? (
                  <Save className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Plus className="h-4 w-4" aria-hidden="true" />
                )}
                {editingId ? "Simpan perubahan" : "Tambah"}
              </button>
            </div>
          </article>

          <article className="overflow-hidden rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-4">
              <h2 className="text-base font-bold text-brand-heading">Daftar masa kritis</h2>
              <div className="flex gap-1" role="group" aria-label="Saring status">
                {(Object.keys(STATUS_LABELS) as StatusFilter[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={status === key}
                    onClick={() => { setStatus(key); setPage(1); }}
                    className={`h-8 rounded-lg px-3 text-xs font-semibold ${
                      status === key
                        ? "bg-brand-primary-pale text-brand-primary-deep"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {STATUS_LABELS[key]}
                  </button>
                ))}
              </div>
            </div>
            {loading ? (
              <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Memuat masa kritis...
              </div>
            ) : items.length === 0 ? (
              <p className="px-5 py-8 text-sm text-muted-foreground">
                {status === "active" ? "Belum ada masa kritis aktif." : "Tidak ada masa kritis pada filter ini."}
              </p>
            ) : (
              <ul className="divide-y divide-border/70">
                {items.map((period) => (
                  <li key={period.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-bold text-brand-heading">
                        <AlertTriangle className="h-4 w-4 shrink-0 text-warning-ink" aria-hidden="true" />
                        <span className="truncate">{period.label}</span>
                        {!period.isActive ? (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">Nonaktif</span>
                        ) : null}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {criticalPeriodRange(period)} · {period.unitName ?? "Seluruh yayasan"}
                      </p>
                      {period.description ? (
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{period.description}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => startEdit(period)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border px-3 text-xs font-semibold"
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Ubah
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => toggleActive(period)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border px-3 text-xs font-semibold"
                      >
                        <Power className="h-3.5 w-3.5" aria-hidden="true" />
                        {period.isActive ? "Nonaktifkan" : "Aktifkan"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {paging ? (
              <PaginationBar
                page={paging.page}
                pageSize={paging.pageSize}
                total={paging.total}
                onPageChange={setPage}
                onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
              />
            ) : null}
          </article>
        </section>
      )}
    </AdminShell>
  );
}
