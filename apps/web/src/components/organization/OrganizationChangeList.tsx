// ORG-008-4d: the "Yang berubah" list beside the chart, with per-line undo and the way out of a
// base another publication has replaced.
//
// Both actions preview first: the operator reads what would be kept and what no longer fits, then
// decides. Nothing is resolved on their behalf.

import { AlertTriangle, History, LoaderCircle, RefreshCw, Undo2 } from "lucide-react";
import type { ReactNode } from "react";

import {
  organizationCommandLabel,
  organizationIssueSentence,
  organizationJournalSentence,
} from "@/lib/organizationLanguage";
import type { OrganizationJournalEntry, OrganizationReplayReport } from "@/lib/organizationCommands";

export function OrganizationChangeList({
  entries,
  loading,
  error,
  staleBaseName,
  busy,
  preview,
  previewFor,
  onUndo,
  onConfirmPreview,
  onCancelPreview,
  onRebase,
  onRetry,
  total,
  footer,
}: {
  /** One page of the journal, newest step first. */
  entries: OrganizationJournalEntry[];
  /** Steps in the whole change set; defaults to the entries shown. */
  total?: number;
  /** Paging control under the list when the journal spans more than one page. */
  footer?: ReactNode;
  loading: boolean;
  error: string | null;
  /** Set when another publication has replaced the base this change set was built on. */
  staleBaseName: string | null;
  busy: boolean;
  preview: OrganizationReplayReport | null;
  /** The line the preview belongs to, or null when it is a rebuild of the whole change set. */
  previewFor: number | null;
  onUndo: (seq: number) => void;
  onConfirmPreview: () => void;
  onCancelPreview: () => void;
  onRebase: () => void;
  onRetry: () => void;
}) {
  return (
    <article className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
      <div className="flex items-center gap-2">
        <History className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
        <h2 className="text-base font-bold text-brand-heading">Yang berubah{(total ?? entries.length) > 0 ? ` (${total ?? entries.length})` : ""}</h2>
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Tindakan yang Anda lakukan pada perubahan ini, terbaru di atas. Belum berlaku sebelum diterbitkan.
      </p>

      {staleBaseName ? (
        <div role="alert" className="mt-4 rounded-xl border border-warning-line bg-warning-soft p-4 text-sm text-warning-ink">
          <p className="font-bold">Struktur sudah diubah oleh &ldquo;{staleBaseName}&rdquo;.</p>
          <p className="mt-1 leading-5">
            Perubahan ini masih disusun di atas struktur lama, jadi belum bisa diterbitkan. Perbarui dulu
            dari struktur terbaru; Anda akan melihat dulu apa yang bisa dipertahankan.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={onRebase}
            className="mt-3 inline-flex h-10 items-center gap-2 rounded-xl border border-warning-line bg-surface-raised px-3 text-xs font-bold text-warning-ink disabled:opacity-60"
          >
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
            Perbarui dari struktur terbaru
          </button>
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={onRetry} className="h-9 rounded-xl border border-danger-line px-3 text-xs font-bold">
            Coba lagi
          </button>
        </div>
      ) : null}

      {preview ? (
        <div className="mt-4 rounded-xl border border-info-line bg-info-soft p-4 text-sm text-info-ink">
          <p className="font-bold">
            {previewFor === null
              ? "Bila diperbarui dari struktur terbaru:"
              : "Bila baris ini dibatalkan:"}
          </p>
          <p className="mt-1 leading-5">
            {preview.kept.length} tindakan dipertahankan
            {preview.skipped.length > 0 ? `, ${preview.skipped.length} tidak bisa diterapkan lagi` : ""}.
          </p>
          {preview.skipped.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs">
              {preview.skipped.map((item) => (
                <li key={item.seq}>
                  &bull; <span className="font-semibold">{organizationCommandLabel(item.commandType)}</span>:{" "}
                  {organizationIssueSentence({ code: item.code, itemKey: null })}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-2 text-xs">Tindakan yang tidak bisa diterapkan lagi akan hilang dari daftar ini dan perlu Anda ulangi.</p>
          {(preview.blocked ?? []).length > 0 ? (
            <div className="mt-3 rounded-lg border border-warning-line bg-warning-soft p-3 text-xs text-warning-ink">
              <p className="font-bold">Belum bisa dilanjutkan</p>
              <p className="mt-1 leading-5">
                Baris berikut tidak bisa disusun ulang, sehingga akan hilang bila dilanjutkan. Batalkan baris itu
                dulu, atau ulangi perubahannya sendiri.
              </p>
              <ul className="mt-2 space-y-1">
                {(preview.blocked ?? []).map((item) => (
                  <li key={item.seq}>&bull; {organizationJournalSentence(item)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || (preview.blocked ?? []).length > 0}
              onClick={onConfirmPreview}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-3 text-xs font-bold text-brand-foreground disabled:opacity-60"
            >
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Lanjutkan
            </button>
            <button type="button" onClick={onCancelPreview} className="h-10 rounded-xl border border-border bg-surface-raised px-3 text-xs font-bold">
              Batal
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-4">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> Memuat daftar perubahan...
          </p>
        ) : entries.length === 0 ? (
          <p className="rounded-xl border border-border/70 bg-surface p-4 text-sm text-muted-foreground">
            Belum ada yang diubah pada perubahan ini.
          </p>
        ) : (
          <ol className="space-y-2">
            {entries.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-start gap-3 rounded-xl border border-border/70 bg-surface px-4 py-3 text-sm">
                <span className="flex-1">{organizationJournalSentence(entry)}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onUndo(entry.seq)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border bg-surface-raised px-2.5 text-[11px] font-bold hover:bg-muted disabled:opacity-60"
                >
                  <Undo2 className="h-3.5 w-3.5" aria-hidden="true" /> Batalkan
                </button>
              </li>
            ))}
          </ol>
        )}
        {footer}
      </div>
    </article>
  );
}
