// NOTIF-002 employee surface: read announcements and confirm the important ones.
// Spec: docs/domain/announcements-and-reminders.md.

import { Loader2, Megaphone, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { DetailDialog, useDialogParam } from "@/components/DetailDialog";
import { DialogLoading, DialogMessages } from "@/components/DetailDialogParts";
import { AppShell } from "@/layouts/AppShell";
import { employeeShellUser } from "@/lib/employeeIdentity";
import { getEmployeeLeaveSummary, type EmployeeLeaveSummary } from "@/lib/employeeLeave";
import {
  acknowledgeAnnouncement,
  getMyAnnouncements,
  markAnnouncementRead,
  type EmployeeAnnouncement,
} from "@/lib/announcements";

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

export function EmployeeAnnouncementsPage() {
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [items, setItems] = useState<EmployeeAnnouncement[]>([]);
  const [pending, setPending] = useState(0);
  // The open announcement shows as a pop-up named in the URL (?pengumuman=<id>).
  const [openId, showAnnouncement, closeAnnouncement] = useDialogParam("pengumuman");
  const markedRead = useRef(new Set<string>());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const user = useMemo(() => employeeShellUser(employee), [employee]);
  const active = useMemo(() => items.filter((item) => item.visibility === "PUBLISHED"), [items]);
  const archived = useMemo(() => items.filter((item) => item.visibility !== "PUBLISHED"), [items]);

  const load = async () => {
    setLoading(true);
    try {
      const [summary, announcements] = await Promise.allSettled([
        getEmployeeLeaveSummary(),
        getMyAnnouncements(),
      ]);
      if (summary.status === "fulfilled") setEmployee(summary.value.employee);
      if (announcements.status === "rejected") throw announcements.reason;
      setItems(announcements.value.items);
      setPending(announcements.value.pendingAcknowledgement);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pengumuman tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const opened = items.find((item) => item.id === openId) ?? null;

  // Opening an unread announcement, from the list or from a link, marks it read once.
  useEffect(() => {
    if (!opened || opened.readAt || markedRead.current.has(opened.id)) return;
    const id = opened.id;
    markedRead.current.add(id);
    void markAnnouncementRead(id)
      .then(() => setItems((current) => current.map((row) => (
        row.id === id ? { ...row, readAt: new Date().toISOString() } : row
      ))))
      .catch(() => {
        // Reading is a convenience signal; a failure here must not hide the announcement.
      });
  }, [opened]);

  const confirm = async (item: EmployeeAnnouncement) => {
    setBusy(true);
    try {
      await acknowledgeAnnouncement(item.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Konfirmasi belum dapat disimpan.");
    } finally {
      setBusy(false);
    }
  };

  const card = (item: EmployeeAnnouncement) => (
    <li key={item.id} className="py-4">
      <button
        type="button"
        onClick={() => showAnnouncement(item.id)}
        className="w-full text-left"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-bold text-brand-heading">{item.title}</span>
          {item.level === "PENTING" ? (
            <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[10px] font-bold text-danger-ink">Penting</span>
          ) : null}
          {!item.readAt ? (
            <span className="rounded-full bg-brand-primary-pale px-2 py-0.5 text-[10px] font-bold text-brand-primary-deep">Baru</span>
          ) : null}
        </span>
        <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">
          {formatDate(item.publishedAt)}
          {item.visibility === "SUPERSEDED" ? " · sudah diralat" : ""}
          {item.visibility === "ARCHIVED" ? " · arsip" : ""}
        </span>
      </button>
    </li>
  );

  return (
    <AppShell user={user} activeItem="Pengumuman">
      <section className="mx-auto max-w-3xl">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-primary-deep">Informasi</p>
        <h1 className="mt-1 text-2xl font-bold text-brand-heading sm:text-3xl">Pengumuman</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Pengumuman resmi yang ditujukan kepada Anda. Pengumuman lama tetap dapat dibaca di arsip.
        </p>

        {pending > 0 ? (
          <div className="mt-5 flex items-start gap-2 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{pending} pengumuman penting menunggu konfirmasi Anda.</span>
          </div>
        ) : null}
        {error && !openId ? <div className="mt-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}

        {loading ? (
          <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat pengumuman...</div>
        ) : items.length ? (
          <>
            <section className="mt-5 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
              <h2 className="text-sm font-bold text-brand-heading">Berlaku</h2>
              {active.length ? (
                <ul className="divide-y divide-border/70">{active.map(card)}</ul>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">Tidak ada pengumuman yang sedang berlaku.</p>
              )}
            </section>
            {archived.length ? (
              <section className="mt-5 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
                <h2 className="text-sm font-bold text-brand-heading">Arsip</h2>
                <ul className="divide-y divide-border/70">{archived.map(card)}</ul>
              </section>
            ) : null}
          </>
        ) : (
          <div className="mt-6 rounded-3xl border border-border/75 bg-surface-raised p-10 text-center shadow-[var(--shadow-soft)]">
            <Megaphone className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="mt-3 font-bold text-brand-heading">Belum ada pengumuman</p>
            <p className="mt-1 text-sm text-muted-foreground">Pengumuman untuk Anda akan muncul di sini.</p>
          </div>
        )}

        {openId ? (
          <DetailDialog
            title={opened ? opened.title : "Pengumuman"}
            description={opened ? (
              <>
                {formatDate(opened.publishedAt)}
                {opened.level === "PENTING" ? " · Penting" : ""}
                {opened.visibility === "SUPERSEDED" ? " · sudah diralat" : ""}
                {opened.visibility === "ARCHIVED" ? " · arsip" : ""}
              </>
            ) : undefined}
            onClose={closeAnnouncement}
          >
            <DialogMessages error={error} />
            {opened ? (
              <>
                {/* N-09: plain text with paragraphs, rendered as text. */}
                {opened.body.split(/\n{2,}/).map((paragraph, index) => (
                  <p key={index} className="mt-2 whitespace-pre-line text-sm leading-6 text-brand-heading first:mt-0">
                    {paragraph}
                  </p>
                ))}
                {opened.level === "PENTING" ? (
                  opened.acknowledgedAt ? (
                    <p className="mt-4 text-[11px] font-semibold text-muted-foreground">
                      Dikonfirmasi {formatDate(opened.acknowledgedAt)}
                    </p>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void confirm(opened)}
                      className="mt-4 min-h-11 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50"
                    >
                      Saya sudah membaca
                    </button>
                  )
                ) : null}
              </>
            ) : loading ? <DialogLoading /> : error ? null : (
              <p className="text-sm text-muted-foreground">Pengumuman ini tidak ditemukan atau tidak ditujukan kepada Anda.</p>
            )}
          </DetailDialog>
        ) : null}
      </section>
    </AppShell>
  );
}
