import { useCallback, useEffect, useRef, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { AdminShell } from "@/layouts/AdminShell";
import { AdminApiError } from "@/lib/adminEmployees";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  amendJobClassification,
  amendJobGrade,
  createJobClassification,
  createJobGrade,
  deactivateJobClassification,
  deactivateJobGrade,
  jobFamilies,
  jobFamilyLabels,
  listJobClassifications,
  listJobGrades,
  type JobClassification,
  type JobFamily,
  type JobGrade,
} from "@/lib/jobClassifications";
import type { AuthSession } from "@/types/hcis";

/** The catalog is effective-dated, so every list is read as of a day. */
function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

export type JobCatalogTab = "classifications" | "grades";
type Tab = JobCatalogTab;

/**
 * 0 is a valid display order, so `Number(value) || 0` would store a typo as a real ordering.
 * Returns null when the text is not a whole number the API would accept.
 */
export function parseRankOrder(value: string): number | null {
  const parsed = Number(value.trim());
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/** What the create form sends: the code is stored upper-case, and a blank grade is absent. */
export function classificationPayload(form: {
  code: string; name: string; family: JobFamily; gradeCode: string; effectiveFrom: string;
}) {
  return {
    code: form.code.trim().toUpperCase(),
    name: form.name.trim(),
    family: form.family,
    gradeCode: form.gradeCode.trim() ? form.gradeCode.trim().toUpperCase() : null,
    effectiveFrom: form.effectiveFrom,
  };
}

export function emptyCatalogMessage(tab: Tab, includeHistory: boolean): string {
  const noun = tab === "classifications" ? "klasifikasi" : "golongan";
  // In history mode the API ignores the date entirely, so naming one would be untrue.
  return includeHistory
    ? `Belum ada ${noun} yang pernah dibuat.`
    : `Belum ada ${noun} yang berlaku pada tanggal ini.`;
}

/** Row actions. Both tabs get the same two, because the API supports both for either. */
export function JobCatalogRowActions({ code, name, canManage, busy, onRename, onClose }: {
  code: string;
  name: string;
  canManage: boolean;
  busy: boolean;
  onRename: (code: string, name: string) => void;
  onClose: (code: string) => void;
}) {
  if (!canManage) return null;
  return (
    <td className="py-2">
      <button type="button" disabled={busy} className="mr-3 text-xs font-bold text-brand-heading disabled:opacity-40" onClick={() => onRename(code, name)}>
        Ubah nama
      </button>
      <button type="button" disabled={busy} className="text-xs font-bold text-danger-ink disabled:opacity-40" onClick={() => onClose(code)}>
        Tutup
      </button>
    </td>
  );
}

interface FormState {
  code: string;
  name: string;
  family: JobFamily;
  gradeCode: string;
  rankOrder: string;
  effectiveFrom: string;
}

function emptyForm(): FormState {
  return { code: "", name: "", family: "FUNCTIONAL", gradeCode: "", rankOrder: "0", effectiveFrom: today() };
}

/** ORG-011: katalog klasifikasi jabatan dan golongan (spec §3, §5). */
export function AdminJobClassificationsPage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [tab, setTab] = useState<Tab>("classifications");
  const [onDate, setOnDate] = useState(today);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [classifications, setClassifications] = useState<JobClassification[]>([]);
  const [grades, setGrades] = useState<JobGrade[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  // Switching tab or date starts a new request without cancelling the old one; without this
  // an older response can land last and leave the count describing a list nobody is looking at.
  const requestId = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);

  const canManage = hasPermission(session, "job_classifications.manage");

  useEffect(() => {
    let mounted = true;
    void getCurrentSession().then((current) => { if (mounted) setSession(current); });
    return () => { mounted = false; };
  }, []);

  const reload = useCallback(async () => {
    const ticket = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      if (tab === "classifications") {
        const result = await listJobClassifications({ page, pageSize, onDate, includeHistory });
        if (ticket !== requestId.current) return;
        setClassifications(result.classifications);
        setTotal(result.pagination.total);
        setPageSize(result.pagination.pageSize);
      } else {
        const result = await listJobGrades({ page, pageSize, onDate, includeHistory });
        if (ticket !== requestId.current) return;
        setGrades(result.grades);
        setTotal(result.pagination.total);
        setPageSize(result.pagination.pageSize);
      }
    } catch (cause) {
      if (ticket !== requestId.current) return;
      setError(cause instanceof AdminApiError ? cause.message : "Daftar gagal dimuat.");
    } finally {
      if (ticket === requestId.current) setLoading(false);
    }
  }, [tab, page, pageSize, onDate, includeHistory]);

  useEffect(() => { void reload(); }, [reload]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      if (tab === "classifications") {
        await createJobClassification(classificationPayload(form));
      } else {
        const rankOrder = parseRankOrder(form.rankOrder);
        if (rankOrder === null) {
          setError("Urutan tampilan harus bilangan bulat 0 atau lebih.");
          return;
        }
        await createJobGrade({
          code: form.code.trim().toUpperCase(),
          name: form.name.trim(),
          rankOrder,
          effectiveFrom: form.effectiveFrom,
        });
      }
      setNotice("Tersimpan.");
      setForm(emptyForm());
      await reload();
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : "Penyimpanan gagal.");
    } finally {
      setSaving(false);
    }
  }

  const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

  async function rename(code: string, current: string) {
    if (busy) return;
    const name = window.prompt(`Nama baru untuk ${code}:`, current);
    if (!name || name.trim() === current) return;
    const effectiveFrom = window.prompt("Berlaku mulai (YYYY-MM-DD):", today());
    if (!effectiveFrom) return;
    // Checked here so the operator is told which field is wrong; the server answers with one
    // generic message for the whole body.
    if (!isDate(effectiveFrom)) {
      setError("Tanggal berlaku harus berformat YYYY-MM-DD.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (tab === "classifications") {
        await amendJobClassification(code, { effectiveFrom, name: name.trim() });
      } else {
        await amendJobGrade(code, { effectiveFrom, name: name.trim() });
      }
      setNotice(`${code} diperbarui mulai ${effectiveFrom}. Versi lama tetap tersimpan.`);
      await reload();
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : "Perubahan gagal.");
    } finally {
      setBusy(false);
    }
  }

  async function close(code: string) {
    if (busy) return;
    const endOn = window.prompt(`Tutup ${code} pada tanggal (YYYY-MM-DD):`, today());
    if (!endOn) return;
    if (!isDate(endOn)) {
      setError("Tanggal penutupan harus berformat YYYY-MM-DD.");
      return;
    }
    const reason = window.prompt("Alasan penutupan (minimal 5 huruf):", "");
    if (!reason) return;
    if (reason.trim().length < 5) {
      setError("Alasan penutupan minimal 5 huruf.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (tab === "classifications") {
        await deactivateJobClassification(code, { endOn, reason: reason.trim() });
      } else {
        await deactivateJobGrade(code, { endOn, reason: reason.trim() });
      }
      setNotice(`${code} ditutup pada ${endOn}. Riwayatnya tetap bisa dibaca.`);
      await reload();
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : "Penutupan gagal.");
    } finally {
      setBusy(false);
    }
  }

  const rows = tab === "classifications" ? classifications : grades;

  return (
    <AdminShell
      active="job-classifications"
      title="Klasifikasi Jabatan & Golongan"
      description="Kelas pekerjaan yang menjadi acuan tabel tunjangan payroll. Daftar ini tidak memuat nominal dan tidak memberi kewenangan persetujuan."
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          {(["classifications", "grades"] as Tab[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => { setTab(value); setPage(1); setForm(emptyForm()); setNotice(null); }}
              className={`rounded-full px-4 py-2 text-xs font-bold ${
                tab === value ? "bg-brand-soft text-brand-heading" : "bg-muted text-muted-foreground"
              }`}
            >
              {value === "classifications" ? "Klasifikasi jabatan" : "Golongan"}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-semibold text-muted-foreground">
            Berlaku pada
            <input
              type="date"
              value={onDate}
              onChange={(event) => { setOnDate(event.target.value); setPage(1); setNotice(null); }}
              disabled={includeHistory}
              className="mt-1 block rounded-md border px-3 py-2 text-sm"
            />
          </label>
          <label className="flex items-center gap-2 pb-2 text-xs font-semibold text-muted-foreground">
            <input
              type="checkbox"
              checked={includeHistory}
              onChange={(event) => { setIncludeHistory(event.target.checked); setPage(1); setNotice(null); }}
            />
            Tampilkan seluruh versi
          </label>
        </div>

        {error ? <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">{error}</p> : null}
        {notice ? <p role="status" className="rounded-md bg-info-soft px-3 py-2 text-sm text-info-ink">{notice}</p> : null}

        {loading ? <p className="text-sm text-muted-foreground">Memuat…</p> : null}
        {!loading && rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {emptyCatalogMessage(tab, includeHistory)}
          </p>
        ) : null}

        {!loading && rows.length > 0 ? (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-2">Kode</th>
                <th className="py-2">Nama</th>
                <th className="py-2">{tab === "classifications" ? "Rumpun" : "Urutan"}</th>
                <th className="py-2">Berlaku</th>
                {canManage ? <th className="py-2">Tindakan</th> : null}
              </tr>
            </thead>
            <tbody>
              {tab === "classifications"
                ? classifications.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="py-2 font-mono text-xs">{row.code}</td>
                    <td className="py-2">{row.name}</td>
                    <td className="py-2">{jobFamilyLabels[row.family]}</td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {row.effectiveFrom} – {row.effectiveTo ?? "seterusnya"}
                    </td>
                    <JobCatalogRowActions code={row.code} name={row.name} canManage={canManage}
                      busy={busy} onRename={(code, name) => void rename(code, name)}
                      onClose={(code) => void close(code)} />
                  </tr>
                ))
                : grades.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="py-2 font-mono text-xs">{row.code}</td>
                    <td className="py-2">{row.name}</td>
                    <td className="py-2">{row.rankOrder}</td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {row.effectiveFrom} – {row.effectiveTo ?? "seterusnya"}
                    </td>
                    <JobCatalogRowActions code={row.code} name={row.name} canManage={canManage}
                      busy={busy} onRename={(code, name) => void rename(code, name)}
                      onClose={(code) => void close(code)} />
                  </tr>
                ))}
            </tbody>
          </table>
        ) : null}

        <PaginationBar
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={(next) => { setPage(next); setNotice(null); }}
          onPageSizeChange={(next) => { setPageSize(next); setPage(1); setNotice(null); }}
        />

        {canManage ? (
          <form onSubmit={(event) => void submit(event)} className="space-y-3 rounded-lg border p-4">
            <h2 className="text-sm font-bold text-brand-heading">
              Tambah {tab === "classifications" ? "klasifikasi" : "golongan"}
            </h2>
            <p className="text-xs text-muted-foreground">
              Kode bersifat tetap: kebijakan payroll menyimpannya apa adanya dan periode lampau membacanya kembali.
              Kode yang salah ditutup dan diganti kode baru, bukan diubah.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold">
                Kode
                <input required value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })}
                  placeholder={tab === "classifications" ? "FUNC_GURU" : "G3"}
                  className="mt-1 block w-full rounded-md border px-3 py-2 font-mono text-sm" />
              </label>
              <label className="text-xs font-semibold">
                Nama
                <input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })}
                  className="mt-1 block w-full rounded-md border px-3 py-2 text-sm" />
              </label>
              {tab === "classifications" ? (
                <>
                  <label className="text-xs font-semibold">
                    Rumpun
                    <select value={form.family} onChange={(event) => setForm({ ...form, family: event.target.value as JobFamily })}
                      className="mt-1 block w-full rounded-md border px-3 py-2 text-sm">
                      {jobFamilies.map((value) => (
                        <option key={value} value={value}>{jobFamilyLabels[value]}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs font-semibold">
                    Golongan (opsional)
                    <input value={form.gradeCode} onChange={(event) => setForm({ ...form, gradeCode: event.target.value })}
                      className="mt-1 block w-full rounded-md border px-3 py-2 font-mono text-sm" />
                  </label>
                </>
              ) : (
                <label className="text-xs font-semibold">
                  Urutan tampilan
                  <input type="number" min={0} value={form.rankOrder}
                    onChange={(event) => setForm({ ...form, rankOrder: event.target.value })}
                    className="mt-1 block w-full rounded-md border px-3 py-2 text-sm" />
                </label>
              )}
              <label className="text-xs font-semibold">
                Berlaku mulai
                <input type="date" required value={form.effectiveFrom}
                  onChange={(event) => setForm({ ...form, effectiveFrom: event.target.value })}
                  className="mt-1 block w-full rounded-md border px-3 py-2 text-sm" />
              </label>
            </div>
            <button type="submit" disabled={saving} className="rounded-md bg-brand px-4 py-2 text-sm font-bold text-brand-ink disabled:opacity-50">
              {saving ? "Menyimpan…" : "Simpan"}
            </button>
          </form>
        ) : (
          <p className="text-xs text-muted-foreground">
            Anda dapat membaca katalog ini. Perubahan dilakukan Human Capital Administrator atau Kepala Human Capital.
          </p>
        )}
      </div>
    </AdminShell>
  );
}
