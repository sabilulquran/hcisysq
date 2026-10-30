import { useCallback, useEffect, useState } from "react";

import { AdminShell } from "@/layouts/AdminShell";
import { AdminApiError } from "@/lib/adminEmployees";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  amendJobClassification,
  createJobClassification,
  createJobGrade,
  deactivateJobClassification,
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

type Tab = "classifications" | "grades";

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);

  const canManage = hasPermission(session, "job_classifications.manage");

  useEffect(() => {
    let mounted = true;
    void getCurrentSession().then((current) => { if (mounted) setSession(current); });
    return () => { mounted = false; };
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (tab === "classifications") {
        const result = await listJobClassifications({ page, pageSize: 25, onDate, includeHistory });
        setClassifications(result.classifications);
        setTotal(result.pagination.total);
      } else {
        const result = await listJobGrades({ page, pageSize: 25, onDate, includeHistory });
        setGrades(result.grades);
        setTotal(result.pagination.total);
      }
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : "Daftar gagal dimuat.");
    } finally {
      setLoading(false);
    }
  }, [tab, page, onDate, includeHistory]);

  useEffect(() => { void reload(); }, [reload]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      if (tab === "classifications") {
        await createJobClassification({
          code: form.code.trim().toUpperCase(),
          name: form.name.trim(),
          family: form.family,
          gradeCode: form.gradeCode.trim() ? form.gradeCode.trim().toUpperCase() : null,
          effectiveFrom: form.effectiveFrom,
        });
      } else {
        await createJobGrade({
          code: form.code.trim().toUpperCase(),
          name: form.name.trim(),
          rankOrder: Number(form.rankOrder) || 0,
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

  async function rename(code: string, current: string) {
    const name = window.prompt(`Nama baru untuk ${code}:`, current);
    if (!name || name.trim() === current) return;
    const effectiveFrom = window.prompt("Berlaku mulai (YYYY-MM-DD):", today());
    if (!effectiveFrom) return;
    setError(null);
    setNotice(null);
    try {
      await amendJobClassification(code, { effectiveFrom, name: name.trim() });
      setNotice(`${code} diperbarui mulai ${effectiveFrom}. Versi lama tetap tersimpan.`);
      await reload();
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : "Perubahan gagal.");
    }
  }

  async function close(code: string) {
    const endOn = window.prompt(`Tutup ${code} pada tanggal (YYYY-MM-DD):`, today());
    if (!endOn) return;
    const reason = window.prompt("Alasan penutupan (minimal 5 huruf):", "");
    if (!reason) return;
    setError(null);
    setNotice(null);
    try {
      await deactivateJobClassification(code, { endOn, reason });
      setNotice(`${code} ditutup pada ${endOn}. Riwayatnya tetap bisa dibaca.`);
      await reload();
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : "Penutupan gagal.");
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
              onClick={() => { setTab(value); setPage(1); setForm(emptyForm()); }}
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
              onChange={(event) => { setOnDate(event.target.value); setPage(1); }}
              disabled={includeHistory}
              className="mt-1 block rounded-md border px-3 py-2 text-sm"
            />
          </label>
          <label className="flex items-center gap-2 pb-2 text-xs font-semibold text-muted-foreground">
            <input
              type="checkbox"
              checked={includeHistory}
              onChange={(event) => { setIncludeHistory(event.target.checked); setPage(1); }}
            />
            Tampilkan seluruh versi
          </label>
        </div>

        {error ? <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">{error}</p> : null}
        {notice ? <p role="status" className="rounded-md bg-info-soft px-3 py-2 text-sm text-info-ink">{notice}</p> : null}

        {loading ? <p className="text-sm text-muted-foreground">Memuat…</p> : null}
        {!loading && rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Belum ada {tab === "classifications" ? "klasifikasi" : "golongan"} yang berlaku pada tanggal ini.
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
                    {canManage ? (
                      <td className="py-2">
                        <button type="button" className="mr-3 text-xs font-bold text-brand-heading" onClick={() => void rename(row.code, row.name)}>
                          Ubah nama
                        </button>
                        <button type="button" className="text-xs font-bold text-danger-ink" onClick={() => void close(row.code)}>
                          Tutup
                        </button>
                      </td>
                    ) : null}
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
                    {canManage ? <td className="py-2 text-xs text-muted-foreground">—</td> : null}
                  </tr>
                ))}
            </tbody>
          </table>
        ) : null}

        {total > 25 ? (
          <div className="flex items-center gap-3 text-xs">
            <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} className="font-bold disabled:opacity-40">
              Sebelumnya
            </button>
            <span className="text-muted-foreground">Halaman {page} dari {Math.max(1, Math.ceil(total / 25))}</span>
            <button type="button" disabled={page >= Math.ceil(total / 25)} onClick={() => setPage((value) => value + 1)} className="font-bold disabled:opacity-40">
              Berikutnya
            </button>
          </div>
        ) : null}

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
            Anda dapat membaca katalog ini. Perubahan dilakukan Staf Human Capital atau Kepala HC.
          </p>
        )}
      </div>
    </AdminShell>
  );
}
