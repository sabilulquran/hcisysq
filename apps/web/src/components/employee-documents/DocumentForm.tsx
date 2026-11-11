// EMP-011: one form for the HC upload, the employee proposal and the HC metadata edit.
// It shows the type catalog the API sent; the API validates everything again (§5.2).

import { useState, type FormEvent } from "react";

import {
  ACCEPT_ATTRIBUTE,
  EmployeeDocumentApiError,
  emptyDraft,
  readDocumentFile,
  type DocumentDraft,
  type DocumentTypeRule,
  type EmployeeDocument,
  type UploadFile,
} from "@/lib/employeeDocuments";

const field = "h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/15";
const primaryButton = "min-h-10 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground hover:bg-brand-primary-deep disabled:opacity-60";
const quietButton = "min-h-10 rounded-xl border border-border px-4 text-sm font-semibold text-foreground hover:bg-surface";

export type DocumentFormMode = "hc-upload" | "self-upload" | "hc-edit";

export function DocumentForm({
  mode,
  types,
  replaceable,
  initial,
  onSubmit,
  onCancel,
}: {
  mode: DocumentFormMode;
  types: DocumentTypeRule[];
  /** VERIFIED documents the new one may replace (D-14). */
  replaceable: EmployeeDocument[];
  initial?: EmployeeDocument;
  onSubmit: (draft: DocumentDraft, file: UploadFile | null, clearNumber: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<DocumentDraft>(() => initial ? {
    ...emptyDraft(initial.documentType),
    title: initial.title ?? "",
    issuer: initial.issuer ?? "",
    issuedOn: initial.issuedOn ?? "",
    expiresOn: initial.expiresOn ?? "",
    notes: initial.notes ?? "",
  } : emptyDraft(types[0]?.code ?? "KTP"));
  const [picked, setPicked] = useState<File | null>(null);
  const [clearNumber, setClearNumber] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = mode === "hc-edit";
  const rule = types.find((type) => type.code === draft.documentType);
  const candidates = replaceable.filter((document) => document.documentType === draft.documentType && document.status === "VERIFIED");
  const set = (patch: Partial<DocumentDraft>) => setDraft((current) => ({ ...current, ...patch }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!editing && !picked) {
      setError("Pilih berkas PDF, JPG, atau PNG.");
      return;
    }
    setBusy(true);
    try {
      const file = picked ? await readDocumentFile(picked) : null;
      await onSubmit(draft, file, clearNumber);
    } catch (cause) {
      setError(cause instanceof EmployeeDocumentApiError || cause instanceof Error ? cause.message : "Dokumen tidak dapat disimpan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-2xl border border-border/70 bg-surface p-4 sm:grid-cols-2" aria-label="Formulir dokumen">
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-semibold text-muted-foreground">Jenis dokumen</span>
        <select
          className={field}
          value={draft.documentType}
          disabled={editing}
          onChange={(event) => set({ documentType: event.target.value as DocumentDraft["documentType"], replacesDocumentId: "" })}
        >
          {types.map((type) => <option key={type.code} value={type.code}>{type.label}</option>)}
        </select>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-semibold text-muted-foreground">
          Judul{rule?.titleRequired ? " (wajib)" : " (opsional)"}
        </span>
        <input className={field} maxLength={200} value={draft.title} onChange={(event) => set({ title: event.target.value })} placeholder="mis. Ijazah S1 Pendidikan" />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-semibold text-muted-foreground">Nomor dokumen (opsional)</span>
        <input
          className={field}
          maxLength={60}
          autoComplete="off"
          value={draft.documentNumber}
          disabled={clearNumber}
          onChange={(event) => set({ documentNumber: event.target.value })}
          placeholder={editing && initial?.numberMasked ? `Tersimpan ${initial.numberMasked}; kosongkan bila tetap` : ""}
        />
        {editing && initial?.numberMasked ? (
          <span className="mt-1 flex items-center gap-2 text-xs">
            <input id="clear-number" type="checkbox" checked={clearNumber} onChange={(event) => setClearNumber(event.target.checked)} />
            <label htmlFor="clear-number">Hapus nomor yang tersimpan</label>
          </span>
        ) : null}
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-semibold text-muted-foreground">Penerbit (opsional)</span>
        <input className={field} maxLength={200} value={draft.issuer} onChange={(event) => set({ issuer: event.target.value })} />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-semibold text-muted-foreground">Tanggal terbit (opsional)</span>
        <input className={field} type="date" value={draft.issuedOn} onChange={(event) => set({ issuedOn: event.target.value })} />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-semibold text-muted-foreground">
          Berlaku sampai{rule?.expiry === "REQUIRED" ? " (wajib)" : " (kosongkan bila seumur hidup)"}
        </span>
        <input className={field} type="date" value={draft.expiresOn} onChange={(event) => set({ expiresOn: event.target.value })} />
      </label>
      {mode !== "self-upload" ? (
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block text-xs font-semibold text-muted-foreground">Catatan HC (opsional, tidak terlihat pegawai)</span>
          <input className={field} maxLength={500} value={draft.notes} onChange={(event) => set({ notes: event.target.value })} />
        </label>
      ) : null}
      {!editing && candidates.length ? (
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block text-xs font-semibold text-muted-foreground">Menggantikan dokumen</span>
          <select className={field} value={draft.replacesDocumentId} onChange={(event) => set({ replacesDocumentId: event.target.value })}>
            <option value="">Tidak — dokumen tambahan</option>
            {candidates.map((document) => (
              <option key={document.id} value={document.id}>
                {document.title ?? document.typeLabel}{document.expiresOn ? ` · s.d. ${document.expiresOn}` : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {!editing ? (
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block text-xs font-semibold text-muted-foreground">Berkas (PDF, JPG, atau PNG; maks 4 MB)</span>
          <input
            className="block w-full text-sm"
            type="file"
            accept={ACCEPT_ATTRIBUTE}
            onChange={(event) => setPicked(event.target.files?.[0] ?? null)}
          />
        </label>
      ) : null}
      {error ? <p role="alert" className="text-sm text-danger-ink sm:col-span-2">{error}</p> : null}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button type="submit" className={primaryButton} disabled={busy}>
          {busy ? "Menyimpan…" : mode === "self-upload" ? "Kirim ke HC" : editing ? "Simpan perubahan" : "Unggah"}
        </button>
        <button type="button" className={quietButton} onClick={onCancel} disabled={busy}>Batal</button>
      </div>
    </form>
  );
}
