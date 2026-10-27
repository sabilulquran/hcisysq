// NOTIF-002 Human Capital surface: compose, publish, archive, and see reach.
// Spec: docs/domain/announcements-and-reminders.md.

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { AdminShell } from "@/layouts/AdminShell";
import { listEmployees, type ReferenceOption } from "@/lib/adminEmployees";
import {
  announcementStatusLabel,
  archiveAnnouncement,
  createAnnouncement,
  getAnnouncements,
  publishAnnouncement,
  type AdminAnnouncement,
  type AnnouncementAudience,
} from "@/lib/announcements";

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

export function AdminAnnouncementsPage() {
  const [items, setItems] = useState<AdminAnnouncement[]>([]);
  const [total, setTotal] = useState(0);
  const [units, setUnits] = useState<ReferenceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: "", body: "", level: "NORMAL" as AdminAnnouncement["level"],
    unitId: "", displayUntil: "",
  });

  const load = async () => {
    setLoading(true);
    try {
      // The unit list comes from the employee list's own filter facets; one row is enough,
      // and an account without employees.read.all simply gets "Seluruh pegawai" only.
      const [page, unitList] = await Promise.allSettled([getAnnouncements(), listEmployees({ pageSize: 1 })]);
      if (page.status === "rejected") throw page.reason;
      setItems(page.value.items);
      setTotal(page.value.pagination.total);
      if (unitList.status === "fulfilled") setUnits(unitList.value.filters.units);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pengumuman tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tindakan belum dapat diselesaikan.");
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const audiences: AnnouncementAudience[] = form.unitId
      ? [{ kind: "UNIT", organizationalUnitId: form.unitId }]
      : [{ kind: "ALL_EMPLOYEES" }];
    void run(async () => {
      await createAnnouncement({
        title: form.title,
        body: form.body,
        level: form.level,
        audiences,
        ...(form.displayUntil ? { displayUntil: form.displayUntil } : {}),
      });
      setForm({ ...form, title: "", body: "" });
    }, "Draf pengumuman tersimpan. Terbitkan bila sudah siap.");
  };

  const archive = (id: string) => {
    const reason = window.prompt("Alasan pengarsipan (boleh kosong)") ?? undefined;
    void run(() => archiveAnnouncement(id, reason || undefined), "Pengumuman diarsipkan.");
  };

  return (
    <AdminShell active="services" title="Pengumuman" description="Pengumuman organisasi untuk pegawai.">
      {error ? <div className="mb-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
      {notice ? <div className="mb-5 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat pengumuman...</div>
      ) : (
        <div className="grid gap-6">
          <form onSubmit={submit} className="rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
            <h2 className="text-sm font-bold text-brand-heading">Susun pengumuman</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-semibold text-brand-heading sm:col-span-2">
                Judul
                <input required minLength={5} maxLength={200} value={form.title}
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                  className="mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading" />
              </label>
              <label className="text-sm font-semibold text-brand-heading sm:col-span-2">
                Isi
                <textarea required minLength={10} rows={6} value={form.body}
                  onChange={(event) => setForm({ ...form, body: event.target.value })}
                  placeholder="Teks biasa. Pisahkan paragraf dengan baris kosong."
                  className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm font-normal text-brand-heading" />
              </label>
              <label className="text-sm font-semibold text-brand-heading">
                Tingkat
                <select value={form.level}
                  onChange={(event) => setForm({ ...form, level: event.target.value as AdminAnnouncement["level"] })}
                  className="mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading">
                  <option value="NORMAL">Biasa</option>
                  <option value="PENTING">Penting (meminta konfirmasi baca)</option>
                </select>
              </label>
              <label className="text-sm font-semibold text-brand-heading">
                Sasaran
                <select value={form.unitId}
                  onChange={(event) => setForm({ ...form, unitId: event.target.value })}
                  className="mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading">
                  <option value="">Seluruh pegawai</option>
                  {units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
                </select>
              </label>
              <label className="text-sm font-semibold text-brand-heading">
                Tampil sampai (opsional)
                <input type="date" value={form.displayUntil}
                  onChange={(event) => setForm({ ...form, displayUntil: event.target.value })}
                  className="mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading" />
              </label>
            </div>
            <button type="submit" disabled={busy}
              className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">
              Simpan draf
            </button>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              Daftar penerima dibekukan saat pengumuman diterbitkan, jadi perubahan unit sesudahnya tidak mengubah jangkauannya.
              Pengumuman yang sudah terbit tidak dapat diedit; yang tersedia adalah ralat, dan ralat dikirim ke penerima yang sama.
              Jangan menulis gaji, nomor identitas, atau data pribadi pegawai lain di dalam pengumuman.
            </p>
          </form>

          <section className="rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
            <h2 className="text-sm font-bold text-brand-heading">Daftar pengumuman</h2>
            {items.length ? (
              <ul className="mt-3 divide-y divide-border/70">
                {items.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-brand-heading">
                        {item.title}
                        {item.level === "PENTING" ? " · penting" : ""}
                      </p>
                      <p className="mt-1 text-[11px] font-semibold text-muted-foreground">
                        {announcementStatusLabel(item)}
                        {item.publishedAt ? ` · ${formatDate(item.publishedAt)}` : ""}
                        {item.reach ? ` · ${item.readCount}/${item.reach} dibaca` : ""}
                        {item.level === "PENTING" && item.reach ? ` · ${item.acknowledgedCount} konfirmasi` : ""}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      {item.status === "DRAFT" || item.status === "SCHEDULED" ? (
                        <button type="button" disabled={busy}
                          onClick={() => void run(() => publishAnnouncement(item.id), "Pengumuman terbit.")}
                          className="min-h-11 rounded-xl bg-brand-primary px-3 text-sm font-bold text-brand-foreground disabled:opacity-50">
                          Terbitkan
                        </button>
                      ) : null}
                      {item.status === "PUBLISHED" ? (
                        <button type="button" disabled={busy} onClick={() => archive(item.id)}
                          className="min-h-11 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50">
                          Arsipkan
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">Belum ada pengumuman.</p>
            )}
            {total > items.length ? (
              <p className="mt-3 text-xs text-muted-foreground">Menampilkan {items.length} terbaru dari {total}.</p>
            ) : null}
          </section>
        </div>
      )}
    </AdminShell>
  );
}
