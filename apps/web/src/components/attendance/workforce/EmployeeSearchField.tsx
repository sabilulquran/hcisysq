import { Loader2, Search, X } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { listEmployees, type AdminEmployeeListItem } from "@/lib/adminEmployees";

export interface PickedEmployee {
  id: string;
  fullName: string;
  employeeNumber: string;
}

/**
 * ATT-011-1 (L-4): server-side search over all active employees by name or NIP, instead of a
 * dropdown holding only the first page. Needs employees.manage; the caller hides it otherwise.
 */
export function EmployeeSearchField({ value, onChange, label = "Pegawai" }: {
  value: PickedEmployee | null;
  onChange: (employee: PickedEmployee | null) => void;
  label?: string;
}) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AdminEmployeeListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const needle = query.trim();
    if (value || needle.length < 2) { setResults([]); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void listEmployees({ q: needle, status: "active", pageSize: 20 })
        .then((page) => { if (active) { setResults(page.items); setError(null); } })
        .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Pegawai tidak dapat dicari."); })
        .finally(() => { if (active) setLoading(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, value]);

  if (value) {
    return (
      <div className="text-xs font-semibold text-muted-foreground">
        {label}
        <div className="mt-1 flex h-11 items-center justify-between gap-2 rounded-xl border bg-surface px-3 text-sm text-foreground">
          <span className="truncate">{value.fullName} · {value.employeeNumber}</span>
          <button type="button" className="rounded-lg p-1 hover:bg-muted" aria-label="Ganti pegawai" onClick={() => { onChange(null); setQuery(""); }}>
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative text-xs font-semibold text-muted-foreground">
      <label htmlFor={inputId}>{label}</label>
      <div className="relative mt-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden="true" />
        <input id={inputId} className="h-11 w-full rounded-xl border pl-9 pr-9 text-sm text-foreground" placeholder="Cari nama atau NIP (min. 2 huruf)"
          value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" />
        {loading ? <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin" aria-hidden="true" /> : null}
      </div>
      {error ? <p className="mt-1 text-danger-ink">{error}</p> : null}
      {results.length > 0 ? (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border bg-surface-raised p-1 text-sm text-foreground shadow-[var(--shadow-soft)]" role="listbox">
          {results.map((item) => (
            <li key={item.id}>
              <button type="button" role="option" aria-selected="false" className="w-full rounded-lg px-3 py-2 text-left hover:bg-muted"
                onClick={() => onChange({ id: item.id, fullName: item.fullName, employeeNumber: item.employeeNumber })}>
                <span className="font-semibold">{item.fullName}</span>
                <span className="block text-xs text-muted-foreground">{item.employeeNumber}{item.unitName ? ` · ${item.unitName}` : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : query.trim().length >= 2 && !loading && !error ? <p className="mt-1 font-normal">Tidak ada pegawai aktif yang cocok.</p> : null}
    </div>
  );
}
