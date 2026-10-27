import { Loader2, Search } from "lucide-react";
import { useState } from "react";

import { PayrollApiError } from "@/lib/payroll";
import { searchPayrollEmployments, type PayrollEmployment } from "@/lib/payrollReference";

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof PayrollApiError ? cause.message : fallback;
}

function Banner({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
      <p>{text}</p>
    </div>
  );
}

/** ENG-LIST-001: employees are picked by searching, never from a dropdown of everyone. */
export function EmploymentPicker({
  label,
  picked,
  onPick,
}: {
  label: string;
  picked: PayrollEmployment | null;
  onPick: (employment: PayrollEmployment | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<PayrollEmployment[]>([]);
  const [total, setTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setSearching(true);
    setError(null);
    try {
      const outcome = await searchPayrollEmployments({ q: query, pageSize: 10 });
      setMatches(outcome.employments);
      setTotal(outcome.total);
    } catch (cause) {
      setError(errorMessage(cause, "Pencarian pegawai gagal."));
    } finally {
      setSearching(false);
    }
  }

  if (picked) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{label}:</span>
        <span className="font-medium">{picked.fullName} · {picked.employeeNumber}</span>
        <button
          type="button"
          onClick={() => {
            onPick(null);
            setMatches([]);
          }}
          className="rounded-md border px-2 py-1 text-xs"
        >
          Ganti
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {error ? <Banner text={error} /> : null}
      <div className="flex flex-wrap gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void search();
            }
          }}
          placeholder="Cari nama atau NIP"
          className="h-9 min-w-56 flex-1 rounded-md border bg-background px-3 text-sm"
        />
        <button
          type="button"
          onClick={() => void search()}
          disabled={searching}
          className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm disabled:opacity-50"
        >
          {searching ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Search className="h-4 w-4" aria-hidden />}
          Cari
        </button>
      </div>
      {matches.length > 0 ? (
        <>
          <ul className="divide-y rounded-md border text-sm">
            {matches.map((employment) => (
              <li key={employment.employmentId}>
                <button
                  type="button"
                  onClick={() => onPick(employment)}
                  className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/50"
                >
                  <span>
                    {employment.fullName} · {employment.employeeNumber}
                    <span className="block text-xs text-muted-foreground">
                      mulai {employment.startedOn}
                      {employment.endedOn ? ` · berakhir ${employment.endedOn}` : ""}
                      {` · ${employment.profileCount} profil`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {total > matches.length ? (
            <p className="text-xs text-muted-foreground">
              {total} pegawai cocok; {matches.length} teratas ditampilkan. Persempit pencarian bila yang dicari belum terlihat.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
