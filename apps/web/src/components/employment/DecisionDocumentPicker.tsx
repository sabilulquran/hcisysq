// EMP-010-A: pick a Perjanjian Kerja or SK from the register by typing its number
// or subject (ENG-LIST-001: the register grows without bound, so no full dropdown).
// The API filters and pages; this component only shows what it returns.

import { useEffect, useState } from "react";

import { listDecisionDocuments, type DecisionDocument, type DecisionDocumentKind, type SkType } from "@/lib/decision-documents";

const field = "h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm";

function formatDate(value: string): string {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

export function documentLabel(document: Pick<DecisionDocument, "documentNumber" | "signedOn" | "subject">): string {
  return `${document.documentNumber} · ${formatDate(document.signedOn)}${document.subject ? ` · ${document.subject}` : ""}`;
}

export interface DecisionDocumentPickerProps {
  kind: DecisionDocumentKind;
  skType?: SkType | undefined;
  /** A Perjanjian Kerja belongs to one employee; only that employee's PK is offered. */
  employeeId?: string | undefined;
  value: DecisionDocument | null;
  onChange: (document: DecisionDocument | null) => void;
  label: string;
}

export function DecisionDocumentPicker({ kind, skType, employeeId, value, onChange, label }: DecisionDocumentPickerProps) {
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<DecisionDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    if (value) return;
    let mounted = true;
    setState("loading");
    const timer = window.setTimeout(() => {
      void listDecisionDocuments({
        kind,
        pageSize: 10,
        ...(search.trim() ? { search: search.trim() } : {}),
        ...(skType ? { skType } : {}),
        ...(kind === "PERJANJIAN_KERJA" && employeeId ? { employeeId } : {}),
      })
        .then((page) => {
          if (!mounted) return;
          setRows(page.rows);
          setTotal(page.total);
          setState("ready");
        })
        .catch(() => {
          if (mounted) setState("error");
        });
    }, 250);
    return () => {
      mounted = false;
      window.clearTimeout(timer);
    };
  }, [kind, skType, employeeId, search, value]);

  if (value) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm">
        <span className="min-w-0 flex-1 break-words">{documentLabel(value)}</span>
        <button type="button" onClick={() => onChange(null)} className="text-xs font-bold text-brand-primary">
          Ganti
        </button>
      </div>
    );
  }

  return (
    <div>
      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={kind === "PERJANJIAN_KERJA" ? "Ketik nomor Perjanjian Kerja" : "Ketik nomor atau perihal SK"}
        aria-label={label}
        className={field}
      />
      {state === "loading" ? <p className="mt-1 text-xs text-muted-foreground">Mencari dokumen…</p> : null}
      {state === "error" ? <p className="mt-1 text-xs text-danger-ink">Daftar dokumen tidak dapat dimuat.</p> : null}
      {state === "ready" && rows.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Tidak ada dokumen yang cocok. Dokumen dicatat di menu Pegawai → Perjanjian Kerja &amp; SK.
        </p>
      ) : null}
      {state === "ready" && rows.length > 0 ? (
        <ul className="mt-1 max-h-56 overflow-y-auto rounded-xl border border-border bg-surface-raised">
          {rows.map((document) => (
            <li key={document.id}>
              <button
                type="button"
                onClick={() => onChange(document)}
                className="w-full px-3 py-2 text-left text-sm hover:bg-surface"
              >
                {documentLabel(document)}
              </button>
            </li>
          ))}
          {total > rows.length ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              {total - rows.length} dokumen lain cocok; ketik nomor yang lebih lengkap.
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
