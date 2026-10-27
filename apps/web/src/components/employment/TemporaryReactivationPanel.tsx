// EMP-005 S5A screen (spec §13.8): give a former employee read-only access to
// their own payslips, attendance history and leave history for a limited time.
// The API owns every rule — who may grant, the 30-day maximum, the allowlist —
// so this panel only collects a reason and a date and shows what comes back.

import { useEffect, useState, type FormEvent } from "react";

import { EmploymentApiError } from "@/lib/employment";
import {
  MAX_REACTIVATION_DAYS,
  grantTemporaryReactivation,
  listTemporaryReactivations,
  revokeTemporaryReactivation,
  type TemporaryReactivation,
} from "@/lib/temporary-reactivations";

const field =
  "h-9 w-full rounded-xl border border-border bg-surface px-3 text-xs outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/15";

function defaultExpiry(days = 7): string {
  const date = new Date(Date.now() + days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

function formatMoment(value: string): string {
  return new Date(value).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}

export function TemporaryReactivationPanel({ accountId }: { accountId: string }) {
  const [items, setItems] = useState<TemporaryReactivation[] | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState(defaultExpiry);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void listTemporaryReactivations(accountId)
      .then((result) => { if (mounted) setItems(result.items); })
      .catch(() => { if (mounted) setItems([]); });
    return () => {
      mounted = false;
    };
  }, [accountId]);

  const live = items?.find((item) => !item.revokedAt && new Date(item.expiresAt).getTime() > Date.now()) ?? null;

  async function reload() {
    setItems((await listTemporaryReactivations(accountId)).items);
  }

  function failure(cause: unknown): string {
    return cause instanceof EmploymentApiError ? cause.message : "Permintaan tidak dapat diproses.";
  }

  async function grant(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // End of the chosen day, so "sampai 3 Nov" includes 3 November.
      await grantTemporaryReactivation(accountId, { reason: reason.trim(), expiresAt: `${until}T23:59:00.000Z` });
      setNotice(`Akses sementara berlaku sampai ${formatMoment(`${until}T23:59:00.000Z`)}.`);
      setOpen(false);
      setReason("");
      await reload();
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(grantId: string) {
    setBusy(true);
    setError(null);
    try {
      await revokeTemporaryReactivation(accountId, grantId);
      setNotice("Akses sementara dihentikan dan sesi pegawai dicabut.");
      await reload();
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-border/70 bg-surface p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-bold text-foreground">Akses sementara pegawai yang sudah berakhir</p>
        {live ? (
          <button type="button" className="font-bold text-danger-ink disabled:opacity-50" disabled={busy} onClick={() => void revoke(live.id)}>
            Hentikan akses
          </button>
        ) : (
          <button type="button" className="font-bold text-brand-primary" onClick={() => setOpen((value) => !value)}>
            {open ? "Batal" : "Aktifkan sementara"}
          </button>
        )}
      </div>

      {live ? (
        <p className="mt-1 text-muted-foreground">
          Berlaku sampai {formatMoment(live.expiresAt)} · hanya slip gaji, riwayat kehadiran, dan riwayat cuti miliknya sendiri.
        </p>
      ) : (
        <p className="mt-1 text-muted-foreground">
          Tidak ada akses sementara yang berlaku. Maksimal {MAX_REACTIVATION_DAYS} hari, dengan alasan yang dicatat.
        </p>
      )}

      {error ? <p role="alert" className="mt-2 rounded-lg border border-danger-line bg-danger-soft p-2 text-danger-ink">{error}</p> : null}
      {notice ? <p role="status" className="mt-2 rounded-lg border border-success-line bg-success-soft p-2 text-success-ink">{notice}</p> : null}

      {open && !live ? (
        <form onSubmit={grant} className="mt-3 grid gap-2 sm:grid-cols-[2fr_1fr_auto]">
          <label className="block">
            <span className="sr-only">Alasan</span>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Alasan (minimal 10 karakter)"
              className={field}
            />
          </label>
          <label className="block">
            <span className="sr-only">Berlaku sampai</span>
            <input type="date" value={until} onChange={(event) => setUntil(event.target.value)} className={field} />
          </label>
          <button type="submit" disabled={busy} className="h-9 rounded-xl bg-brand-primary px-3 text-xs font-bold text-brand-foreground disabled:opacity-50">
            Berikan akses
          </button>
        </form>
      ) : null}

      {items && items.length > 0 ? (
        <ul className="mt-3 space-y-1 text-muted-foreground">
          {items.slice(0, 5).map((item) => (
            <li key={item.id}>
              {formatMoment(item.startsAt)} – {formatMoment(item.expiresAt)}
              {item.revokedAt ? ` · dihentikan ${formatMoment(item.revokedAt)}` : ""} · {item.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
