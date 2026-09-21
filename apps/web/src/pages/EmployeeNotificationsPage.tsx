import { BellRing, CheckCheck, Circle, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/layouts/AppShell";
import { employeeShellUser } from "@/lib/employeeIdentity";
import { getEmployeeLeaveSummary, type EmployeeLeaveSummary } from "@/lib/employeeLeave";
import {
  getMyNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type InAppNotification,
} from "@/lib/notifications";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

function categoryLabel(category: InAppNotification["category"]) {
  if (category === "attendance") return "Kehadiran";
  if (category === "payslip") return "Slip Gaji";
  return "Sistem";
}

export function EmployeeNotificationsPage() {
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [state, setState] = useState<"all" | "unread">("all");
  const [items, setItems] = useState<InAppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const user = useMemo(() => employeeShellUser(employee), [employee]);

  const load = async (filter = state) => {
    setLoading(true);
    try {
      const [summary, notifications] = await Promise.all([
        getEmployeeLeaveSummary(),
        getMyNotifications(filter),
      ]);
      setEmployee(summary.employee);
      setItems(notifications.items);
      setUnreadCount(notifications.unreadCount);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Notifikasi tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(state);
  }, [state]);

  const open = async (item: InAppNotification) => {
    try {
      if (!item.readAt) await markNotificationRead(item.id);
    } finally {
      if (item.href) window.location.href = item.href;
      else await load(state);
    }
  };

  const markAll = async () => {
    setBusy(true);
    try {
      await markAllNotificationsRead();
      await load(state);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Notifikasi belum dapat ditandai dibaca.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell user={user} activeItem="Notifikasi">
      <section className="mx-auto max-w-4xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-primary-deep">Informasi</p>
            <h1 className="mt-1 text-2xl font-bold text-brand-heading sm:text-3xl">Notifikasi</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Pemberitahuan transaksi HCIS yang ditujukan khusus untuk akun Anda. Membaca notifikasi tidak menjalankan persetujuan apa pun.
            </p>
          </div>
          <button
            type="button"
            disabled={busy || unreadCount === 0}
            onClick={() => void markAll()}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-white px-4 text-sm font-bold text-brand-heading disabled:opacity-50"
          >
            <CheckCheck className="h-4 w-4" /> Tandai semua dibaca
          </button>
        </div>

        <div className="mt-5 flex gap-2">
          <button type="button" onClick={() => setState("all")}
            className={state === "all" ? "rounded-full bg-brand-primary px-3 py-1.5 text-xs font-bold text-white" : "rounded-full bg-muted px-3 py-1.5 text-xs font-bold text-muted-foreground"}>
            Semua
          </button>
          <button type="button" onClick={() => setState("unread")}
            className={state === "unread" ? "rounded-full bg-brand-primary px-3 py-1.5 text-xs font-bold text-white" : "rounded-full bg-muted px-3 py-1.5 text-xs font-bold text-muted-foreground"}>
            Belum dibaca ({unreadCount})
          </button>
        </div>

        {error ? <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div> : null}

        <section className="mt-5 overflow-hidden rounded-3xl border border-border/75 bg-white shadow-[var(--shadow-soft)]">
          {loading ? (
            <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat notifikasi...</div>
          ) : items.length ? (
            <div className="divide-y divide-border/70">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void open(item)}
                  className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-3 px-5 py-4 text-left transition hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className={item.readAt ? "mt-1 flex h-9 w-9 items-center justify-center rounded-full bg-muted text-muted-foreground" : "mt-1 flex h-9 w-9 items-center justify-center rounded-full bg-brand-primary-pale text-brand-primary-deep"}>
                    {item.readAt ? <BellRing className="h-4 w-4" /> : <Circle className="h-3 w-3 fill-current" />}
                  </span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-bold text-brand-heading">{item.title}</span>
                      <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-bold text-muted-foreground">{categoryLabel(item.category)}</span>
                      {!item.readAt ? <span className="rounded-full bg-brand-primary-pale px-2 py-0.5 text-[10px] font-bold text-brand-primary-deep">Baru</span> : null}
                    </span>
                    <span className="mt-1 block text-sm leading-6 text-muted-foreground">{item.body}</span>
                    <span className="mt-2 block text-[11px] font-semibold text-muted-foreground">{formatDate(item.createdAt)}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="p-10 text-center">
              <BellRing className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 font-bold text-brand-heading">{state === "unread" ? "Tidak ada notifikasi baru" : "Belum ada notifikasi"}</p>
              <p className="mt-1 text-sm text-muted-foreground">Notifikasi workflow baru akan muncul di sini.</p>
            </div>
          )}
        </section>

        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          Pengingat jadwal, email, WhatsApp, browser push, dan pengumuman masih terpisah dari pusat notifikasi ini dan belum diaktifkan oleh rilis ini.
        </p>
      </section>
    </AppShell>
  );
}
