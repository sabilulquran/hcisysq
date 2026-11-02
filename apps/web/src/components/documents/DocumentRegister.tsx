// DOC-001 / DOC-002-F register of issued letters and the revoke dialog.
// Spec: docs/domain/hr-documents.md §12, ENG-LIST-001.
//
// The API authorizes every call. `canRevoke` only hides Batalkan from an account without
// documents.correct; it decides nothing else.

import { Loader2 } from "lucide-react";
import { useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import {
  REVOKE_REASON_MAX,
  revokeReasonProblem,
  type RegisterEntry,
  type RegisterFilter,
  type RegisterKind,
} from "@/lib/hrDocuments";

export type RegisterView =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: RegisterEntry[]; total: number };

const KIND_TABS: Array<{ kind: RegisterKind; label: string }> = [
  { kind: "CERTIFICATE", label: "Surat keterangan" },
  { kind: "DISCIPLINARY", label: "Surat peringatan" },
];

function formatDate(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

export function emptyRegisterMessage(filter: RegisterFilter): string {
  const subject = filter.kind === "DISCIPLINARY" ? "surat peringatan" : "surat keterangan";
  if (filter.status === "REVOKED") return `Tidak ada ${subject} yang dibatalkan.`;
  if (filter.status === "ISSUED") return `Tidak ada ${subject} berstatus terbit.`;
  return `Belum ada ${subject} yang terbit.`;
}

export function RegisterRow({
  entry,
  canRevoke,
  busy,
  onRevoke,
}: {
  entry: RegisterEntry;
  canRevoke: boolean;
  busy: boolean;
  onRevoke: (entry: RegisterEntry) => void;
}) {
  const revoked = entry.status === "REVOKED";
  return (
    <li className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 font-semibold text-brand-heading">
          <span className="break-all">{entry.documentNumber}</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
              revoked ? "bg-danger-soft text-danger-ink" : "bg-surface text-muted-foreground"
            }`}
          >
            {revoked ? "Dibatalkan" : "Terbit"}
          </span>
        </p>
        <p className="text-sm text-muted-foreground">
          {entry.documentKind === "DISCIPLINARY"
            ? `${entry.documentCode} · terbit ${formatDate(entry.issuedAt)}`
            : `${entry.employeeName ?? "-"} (${entry.employeeNumber ?? "-"}) · terbit ${formatDate(entry.issuedAt)}`}
        </p>
        {revoked ? (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Dibatalkan {formatDate(entry.revokedAt)}
            {entry.revokeReason ? <> · Alasan: <span className="break-words">{entry.revokeReason}</span></> : null}
          </p>
        ) : null}
      </div>
      {!revoked && canRevoke ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onRevoke(entry)}
          className="min-h-11 shrink-0 rounded-xl border border-danger-line px-3 text-sm font-bold text-danger-ink disabled:opacity-50"
        >
          Batalkan
        </button>
      ) : null}
    </li>
  );
}

export function DocumentRegisterSection({
  filter,
  view,
  canRevoke,
  busy,
  onFilterChange,
  onRevoke,
  onRetry,
}: {
  filter: RegisterFilter;
  view: RegisterView;
  canRevoke: boolean;
  busy: boolean;
  onFilterChange: (filter: RegisterFilter) => void;
  onRevoke: (entry: RegisterEntry) => void;
  onRetry: () => void;
}) {
  // ENG-LIST-001-J: a new tab or status filter starts again at page 1.
  const change = (patch: Partial<RegisterFilter>) => onFilterChange({ ...filter, page: 1, ...patch });
  const outOfRange = view.kind === "ready" && view.items.length === 0 && view.total > 0;

  return (
    <section className="rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
      <div className="p-5">
        <h2 className="text-sm font-bold text-brand-heading">Register surat terbit</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Jenis surat" className="flex flex-wrap gap-2">
            {KIND_TABS.map((tab) => (
              <button
                key={tab.kind}
                type="button"
                role="tab"
                aria-selected={tab.kind === filter.kind}
                onClick={() => change({ kind: tab.kind })}
                className={`min-h-11 rounded-xl px-3 text-sm font-bold ${
                  tab.kind === filter.kind
                    ? "bg-brand-primary-deep text-white"
                    : "border border-border/70 text-muted-foreground"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Status
            <select
              value={filter.status ?? ""}
              onChange={(event) => change({ status: (event.target.value || null) as RegisterFilter["status"] })}
              className="min-h-11 rounded-xl border border-border bg-surface px-3 text-sm text-brand-heading"
            >
              <option value="">Semua</option>
              <option value="ISSUED">Terbit</option>
              <option value="REVOKED">Dibatalkan</option>
            </select>
          </label>
        </div>
        {filter.kind === "DISCIPLINARY" ? (
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            Register hanya memuat nomor, tingkat, dan status surat peringatan. Nama pegawai dan isi surat tidak
            ditampilkan di sini; cocokkan surat dari nomornya.
          </p>
        ) : null}

        {view.kind === "loading" ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />Memuat register...
          </p>
        ) : null}
        {view.kind === "forbidden" ? (
          <p className="mt-4 text-sm text-muted-foreground">Akun ini tidak berhak melihat register surat.</p>
        ) : null}
        {view.kind === "error" ? (
          <div role="alert" className="mt-4 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">
            {view.message}{" "}
            <button type="button" onClick={onRetry} className="font-bold underline">Coba lagi</button>
          </div>
        ) : null}
        {view.kind === "ready" && view.items.length ? (
          <ul className="mt-3 divide-y divide-border/70">
            {view.items.map((entry) => (
              <RegisterRow key={entry.id} entry={entry} canRevoke={canRevoke} busy={busy} onRevoke={onRevoke} />
            ))}
          </ul>
        ) : null}
        {view.kind === "ready" && !view.items.length ? (
          <p className="mt-4 text-sm text-muted-foreground">
            {outOfRange ? (
              <>
                Halaman ini kosong.{" "}
                <button type="button" onClick={() => onFilterChange({ ...filter, page: 1 })} className="font-bold underline">
                  Kembali ke halaman 1
                </button>
              </>
            ) : emptyRegisterMessage(filter)}
          </p>
        ) : null}
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          Nomor surat tidak pernah dipakai ulang. Surat yang dibatalkan tetap memegang nomornya.
        </p>
      </div>
      {view.kind === "ready" && view.total > 0 ? (
        <div className="overflow-hidden rounded-b-3xl">
          <PaginationBar
            page={filter.page}
            pageSize={filter.pageSize}
            total={view.total}
            onPageChange={(page) => onFilterChange({ ...filter, page })}
            onPageSizeChange={(pageSize) => onFilterChange({ ...filter, page: 1, pageSize })}
          />
        </div>
      ) : null}
    </section>
  );
}

export function RevokeDocumentDialog({
  entry,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  entry: RegisterEntry;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const problem = revokeReasonProblem(reason);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/35 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="revoke-document-title"
      onKeyDown={(event) => { if (event.key === "Escape" && !busy) onCancel(); }}
    >
      <form
        className="w-full max-w-lg rounded-3xl bg-surface-raised p-5 shadow-[var(--shadow-soft)]"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (!problem && !busy) onConfirm(reason.trim());
        }}
      >
        <h2 id="revoke-document-title" className="text-base font-bold text-brand-heading">
          Batalkan surat {entry.documentNumber}?
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Surat akan berstatus dibatalkan. Nomornya tetap terpakai dan tidak diberikan ke surat lain, isi surat tidak
          diubah, dan alasan Anda tercatat di jejak audit. Pembatalan tidak dapat diurungkan.
        </p>
        <label className="mt-4 block text-sm font-semibold text-brand-heading">
          Alasan pembatalan
          <textarea
            autoFocus
            required
            rows={4}
            maxLength={REVOKE_REASON_MAX}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={touched && problem ? true : undefined}
            aria-describedby="revoke-reason-help"
            className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm font-normal text-brand-heading"
          />
        </label>
        <p id="revoke-reason-help" className={`mt-1 text-xs ${touched && problem ? "text-danger-ink" : "text-muted-foreground"}`}>
          {touched && problem ? problem : `Minimal 10 karakter. ${reason.trim().length}/${REVOKE_REASON_MAX}`}
        </p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Alasan tampil di register bagi semua pembaca register. Jangan menuliskan nama pegawai atau isi surat.
        </p>
        {error ? (
          <p role="alert" className="mt-3 rounded-2xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink">{error}</p>
        ) : null}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="min-h-11 rounded-xl border border-border px-4 text-sm font-bold text-brand-heading disabled:opacity-50"
          >
            Kembali
          </button>
          <button
            type="submit"
            disabled={busy || Boolean(problem)}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-danger-ink px-4 text-sm font-bold text-white disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Batalkan surat
          </button>
        </div>
      </form>
    </div>
  );
}
