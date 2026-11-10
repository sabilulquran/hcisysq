// ORG-008 follow-up (O-7): only one change set may be open at a time, so a stale one blocks every
// new change. These pieces name what is open and let HC open it or discard it (with a reason that
// goes into the audit event). Discarding never deletes rows; a published change set is refused by
// the API.

import { AlertTriangle, FolderOpen, History, LoaderCircle, RefreshCw, Trash2, X } from "lucide-react";
import type { FormEvent } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import {
  ORGANIZATION_OPEN_CHANGES_PAGE_SIZE,
  type OrganizationOpenChange,
} from "@/lib/organizationDesigner";
import { organizationDraftStatusLabel } from "@/lib/organizationLanguage";

const dateFormatter = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Jakarta",
});

const timeFormatter = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Jakarta",
});

function openChangeDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return dateFormatter.format(new Date(Date.UTC(year, month - 1, day)));
}

function openChangeTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : timeFormatter.format(parsed);
}

function statusLabel(change: OrganizationOpenChange) {
  return organizationDraftStatusLabel(change.status);
}

const secondaryButton = "inline-flex h-9 items-center gap-2 rounded-xl border border-border bg-surface-raised px-3 text-xs font-bold hover:bg-muted disabled:opacity-50";
const dangerButton = "inline-flex h-9 items-center gap-2 rounded-xl border border-danger-line bg-surface-raised px-3 text-xs font-bold text-danger-ink hover:bg-danger-soft disabled:opacity-50";

/** Shown in "Mulai perubahan struktur" when the API refused because another change is open. */
export function OrganizationOpenChangeConflict({
  change,
  busy,
  onOpen,
  onDiscard,
}: {
  change: OrganizationOpenChange;
  busy: boolean;
  onOpen: () => void;
  onDiscard: () => void;
}) {
  return (
    <div role="alert" className="rounded-2xl border border-warning-line bg-warning-soft p-4 text-sm text-warning-ink">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-bold">Masih ada perubahan yang terbuka</p>
          <p className="mt-1 leading-5">
            &quot;{change.name}&quot; · berlaku mulai {openChangeDate(change.effectiveOn)} · {statusLabel(change)}.
            Hanya satu perubahan struktur yang boleh disusun sekaligus. Lanjutkan perubahan itu, atau buang bila sudah tidak dipakai.
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button type="button" disabled={busy} onClick={onOpen} className={secondaryButton}>
          <FolderOpen className="h-4 w-4" aria-hidden="true" /> Buka perubahan itu
        </button>
        <button type="button" disabled={busy} onClick={onDiscard} className={dangerButton}>
          <Trash2 className="h-4 w-4" aria-hidden="true" /> Buang perubahan itu
        </button>
      </div>
    </div>
  );
}

/** Perubahan tab: every change set that blocks a new one, newest first. */
export function OrganizationOpenChangeList({
  items,
  total,
  page,
  loading,
  error,
  busy,
  currentDraftId,
  onOpen,
  onDiscard,
  onPageChange,
  onRetry,
}: {
  items: OrganizationOpenChange[];
  total: number;
  page: number;
  loading: boolean;
  error: string | null;
  busy: boolean;
  /** The change open in the designer right now; it is marked instead of offered again. */
  currentDraftId: string | null;
  onOpen: (change: OrganizationOpenChange) => void;
  onDiscard: (change: OrganizationOpenChange) => void;
  onPageChange: (page: number) => void;
  onRetry: () => void;
}) {
  return (
    <article className="mb-4 overflow-hidden rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
        <div>
          <div className="flex items-center gap-2">
            <History className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
            <h2 className="text-base font-bold text-brand-heading">Perubahan terbuka{total > 0 ? ` (${total})` : ""}</h2>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Perubahan yang belum diterbitkan. Selama masih ada yang terbuka, perubahan baru tidak bisa dimulai.
            Membuang tidak menghapus riwayat; catatan dan alasannya tetap tersimpan.
          </p>
        </div>
      </div>

      {loading ? (
        <p className="flex items-center gap-2 px-5 py-4 text-sm text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> Memuat perubahan terbuka...</p>
      ) : error ? (
        <div role="alert" className="mx-5 my-4 flex flex-wrap items-center gap-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={onRetry} className="inline-flex h-9 items-center gap-2 rounded-xl border border-danger-line px-3 text-xs font-bold"><RefreshCw className="h-4 w-4" aria-hidden="true" /> Coba lagi</button>
        </div>
      ) : items.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">Tidak ada perubahan yang terbuka. Perubahan baru bisa dimulai.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border/70 border-t border-border/70">
          {items.map((change) => {
            const current = change.id === currentDraftId;
            return (
              <li key={change.id} className="flex flex-col gap-3 px-5 py-3 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-brand-heading">{change.name}</p>
                  <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                    Berlaku mulai {openChangeDate(change.effectiveOn)} · {statusLabel(change)} · Disusun oleh {change.createdByName ?? "—"} · Terakhir diubah {openChangeTime(change.updatedAt ?? change.createdAt)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {current ? (
                    <span className="inline-flex h-9 items-center rounded-xl bg-warning-soft px-3 text-xs font-bold text-warning-ink">Sedang dibuka</span>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => onOpen(change)} className={secondaryButton} aria-label={`Buka ${change.name}`}>
                      <FolderOpen className="h-4 w-4" aria-hidden="true" /> Buka
                    </button>
                  )}
                  <button type="button" disabled={busy} onClick={() => onDiscard(change)} className={dangerButton} aria-label={`Buang ${change.name}`}>
                    <Trash2 className="h-4 w-4" aria-hidden="true" /> Buang
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && !error && total > ORGANIZATION_OPEN_CHANGES_PAGE_SIZE ? (
        <PaginationBar page={page} pageSize={ORGANIZATION_OPEN_CHANGES_PAGE_SIZE} total={total} onPageChange={onPageChange} />
      ) : null}
    </article>
  );
}

/** Confirm with a required reason; the reason is stored in the audit event, never shown elsewhere. */
export function OrganizationDiscardDialog({
  change,
  saving,
  error,
  onCancel,
  onConfirm,
}: {
  change: OrganizationOpenChange;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    if (reason.length > 0) onConfirm(reason);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-brand-heading/30 p-0 backdrop-blur-[2px] sm:items-center sm:p-6">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="organization-discard-title"
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-surface-raised shadow-2xl sm:max-w-xl sm:rounded-3xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border/70 px-5 py-4 sm:px-6">
          <h2 id="organization-discard-title" className="text-lg font-bold text-brand-heading">Buang &quot;{change.name}&quot;?</h2>
          <button type="button" aria-label="Tutup dialog" onClick={onCancel} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-4 p-5 sm:p-6">
          <p className="text-sm leading-6 text-foreground">
            Perubahan berlaku mulai {openChangeDate(change.effectiveOn)} ({statusLabel(change)}) akan ditandai Dibuang dan tidak bisa
            diterbitkan atau disusun lagi. Struktur yang sudah terbit tidak berubah. Catatan dan riwayatnya tetap tersimpan.
          </p>
          {error ? <div role="alert" className="flex items-start gap-3 rounded-2xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>{error}</span></div> : null}
          <label className="block">
            <span className="mb-1.5 block text-xs font-bold text-brand-heading">Alasan membuang</span>
            <textarea
              name="reason"
              required
              minLength={1}
              maxLength={500}
              rows={3}
              placeholder="Contoh: sudah digantikan struktur yang terbit 27 Agustus 2026"
              className="w-full rounded-xl border border-border bg-surface-raised px-3 py-2 text-sm text-brand-heading outline-none focus:border-brand-primary"
            />
            <span className="mt-1 block text-[11px] text-muted-foreground">Wajib diisi. Tersimpan di catatan audit.</span>
          </label>
          <div className="flex justify-end gap-2 border-t border-border/70 pt-4">
            <button type="button" disabled={saving} onClick={onCancel} className="h-10 rounded-xl border border-border px-4 text-sm font-semibold hover:bg-muted disabled:opacity-60">Batal</button>
            <button type="submit" disabled={saving} className="inline-flex h-10 items-center gap-2 rounded-xl bg-danger-ink px-4 text-sm font-bold text-white hover:opacity-90 disabled:opacity-60">
              {saving ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}
              {saving ? "Membuang..." : "Buang perubahan"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
