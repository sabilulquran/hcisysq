// EMP-010-A: link a PK/SK that arrived after the action was recorded (spec §4.5.3).
// The API decides which kind an action may take and answers with a message when the
// pick does not fit; the form only offers the register.

import { useState, type FormEvent } from "react";

import { DecisionDocumentPicker } from "@/components/employment/DecisionDocumentPicker";
import { linkDecisionDocuments, type DecisionDocument, type DecisionDocumentKind } from "@/lib/decision-documents";
import { EmploymentApiError } from "@/lib/employment";

export interface LinkDocumentFormProps {
  employeeId: string;
  actionId: string;
  actionLabel: string;
  onClose: () => void;
  onLinked: (message: string) => void;
}

export function LinkDocumentForm({ employeeId, actionId, actionLabel, onClose, onLinked }: LinkDocumentFormProps) {
  const [kind, setKind] = useState<DecisionDocumentKind>("SURAT_KEPUTUSAN");
  const [document, setDocument] = useState<DecisionDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!document) {
      setError("Pilih dokumen dasar terlebih dahulu.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await linkDecisionDocuments(actionId, [document.id]);
      onLinked(
        result.linkedDocumentIds.length > 0
          ? `Dokumen ${document.documentNumber} ditautkan ke ${actionLabel}.`
          : `Dokumen ${document.documentNumber} sudah tertaut ke ${actionLabel}.`,
      );
    } catch (cause) {
      setError(cause instanceof EmploymentApiError ? cause.message : "Dokumen tidak dapat ditautkan.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-2xl border border-border/70 bg-surface p-4">
      <p className="text-sm font-bold text-brand-heading">Tautkan dokumen dasar · {actionLabel}</p>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Jenis dokumen">
        {(["SURAT_KEPUTUSAN", "PERJANJIAN_KERJA"] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={kind === option}
            onClick={() => {
              setKind(option);
              setDocument(null);
            }}
            className={`h-9 rounded-xl border px-3 text-xs font-bold ${kind === option ? "border-brand-primary bg-brand-primary/10 text-brand-primary-deep" : "border-border text-foreground"}`}
          >
            {option === "SURAT_KEPUTUSAN" ? "Surat Keputusan" : "Perjanjian Kerja"}
          </button>
        ))}
      </div>
      <DecisionDocumentPicker
        kind={kind}
        employeeId={employeeId}
        value={document}
        onChange={setDocument}
        label={kind === "PERJANJIAN_KERJA" ? "Cari Perjanjian Kerja" : "Cari Surat Keputusan"}
      />
      <p className="text-xs text-muted-foreground">
        Setelah ditautkan, nomor dan isi dokumen hanya dapat diubah lewat koreksi yang tercatat.
      </p>
      {error ? <p role="alert" className="text-sm text-danger-ink">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy || !document}
          className="h-10 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50"
        >
          {busy ? "Menautkan…" : "Tautkan"}
        </button>
        <button type="button" onClick={onClose} className="h-10 rounded-xl border border-border px-4 text-sm font-semibold">
          Batal
        </button>
      </div>
    </form>
  );
}
