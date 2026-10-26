// ORG-008-9: on the Akses screen, does the Kepala HC role sit with whoever holds the Kepala HC seat?
//
// Granting stays manual and Super Admin only (AUTH-011: a position never grants admin permission).
// This panel only makes a difference visible; it offers no "grant to match" shortcut on purpose.

import { AlertTriangle, CheckCircle2, LoaderCircle, Search } from "lucide-react";
import { useState, type FormEvent } from "react";

import type { RoleSeatCheck } from "@/lib/adminOrgAccess";
import {
  roleSeatLabel,
  roleSeatMismatchSentence,
  roleSeatName,
  roleSeatStatusSentence,
} from "@/lib/roleSeatLanguage";

export function RoleSeatPanel({
  checks,
  error,
  canSetSeat,
  busy,
  onSetSeat,
  onSearchPositions,
}: {
  checks: RoleSeatCheck[] | null;
  error: string | null;
  /** Super Admin only, like granting the role itself. */
  canSetSeat: boolean;
  busy: boolean;
  onSetSeat: (roleKey: string, positionKey: string | null, reason: string) => void;
  onSearchPositions: (query: string) => Promise<Array<{ stableKey: string; title: string; unitPath: string[] }>>;
}) {
  if (error) {
    return (
      <section className="mt-5 rounded-2xl border border-border/70 bg-surface-raised p-5 text-sm text-muted-foreground shadow-[var(--shadow-soft)]">
        {error}
      </section>
    );
  }
  if (!checks) return null;
  return (
    <>
      {checks.map((check) => (
        <RoleSeatCard key={check.roleKey} check={check} canSetSeat={canSetSeat} busy={busy}
          onSetSeat={onSetSeat} onSearchPositions={onSearchPositions} />
      ))}
    </>
  );
}

function RoleSeatCard({
  check, canSetSeat, busy, onSetSeat, onSearchPositions,
}: {
  check: RoleSeatCheck;
  canSetSeat: boolean;
  busy: boolean;
  onSetSeat: (roleKey: string, positionKey: string | null, reason: string) => void;
  onSearchPositions: (query: string) => Promise<Array<{ stableKey: string; title: string; unitPath: string[] }>>;
}) {
  const role = roleSeatLabel(check.roleKey);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ stableKey: string; title: string; unitPath: string[] }> | null>(null);
  const [searching, setSearching] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const statusSentence = roleSeatStatusSentence(check);
  const matched = check.status === "CHECKED" && check.mismatches.length === 0;

  const search = (event: FormEvent) => {
    event.preventDefault();
    setSearching(true);
    void onSearchPositions(query.trim())
      .then(setResults)
      .catch(() => setResults([]))
      .finally(() => setSearching(false));
  };

  return (
    <section className="mt-5 rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
      <h2 className="text-base font-bold text-brand-heading">Peran {role} dan jabatannya</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Peran {role} tetap diberikan manual oleh Super Admin. Bagian ini hanya menunjukkan bila pemegang peran
        berbeda dengan pemegang jabatan {role} di struktur; Plt dihitung sebagai pemegang jabatan.
      </p>
      <p className="mt-3 text-sm">
        <span className="font-semibold">Jabatan acuan:</span>{" "}
        {roleSeatName(check) ?? (check.seat ? "jabatan yang ditetapkan tidak ada di struktur berlaku" : "belum ditetapkan")}
      </p>

      {statusSentence ? (
        <p className="mt-3 rounded-xl border border-warning-line bg-warning-soft p-3 text-sm text-warning-ink">{statusSentence}</p>
      ) : null}

      {check.mismatches.length > 0 ? (
        <div role="alert" className="mt-3 rounded-xl border border-warning-line bg-warning-soft p-3 text-sm text-warning-ink">
          <p className="flex items-center gap-2 font-bold">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            Pemegang peran dan pemegang jabatan berbeda
          </p>
          <ul className="mt-2 space-y-1">
            {check.mismatches.map((mismatch) => (
              <li key={`${mismatch.kind}-${mismatch.kind === "HOLDER_NOT_SEATED" ? mismatch.accountId : mismatch.employeeId}`}>
                &bull; {roleSeatMismatchSentence(check, mismatch)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {matched ? (
        <p className="mt-3 flex items-center gap-2 rounded-xl border border-success-line bg-success-soft p-3 text-sm text-success-ink">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          Pemegang peran {role} sama dengan pemegang jabatannya.
        </p>
      ) : null}

      {canSetSeat ? (
        editing ? (
          <div className="mt-4 space-y-3 rounded-xl border border-border/70 bg-surface p-4">
            <form onSubmit={search} className="flex flex-col gap-2 sm:flex-row">
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari jabatan atau unit"
                aria-label="Cari jabatan acuan" className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-surface-raised px-3 text-sm" />
              <button type="submit" disabled={searching} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-border px-3 text-sm font-bold disabled:opacity-50">
                {searching ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Search className="h-4 w-4" aria-hidden="true" />}
                Cari
              </button>
            </form>
            {results ? (
              results.length === 0 ? (
                <p className="text-xs text-muted-foreground">Tidak ada jabatan yang cocok di struktur yang berlaku.</p>
              ) : (
                <ul className="max-h-56 space-y-1 overflow-auto">
                  {results.map((item) => (
                    <li key={item.stableKey}>
                      <label className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1 text-sm hover:bg-muted">
                        <input type="radio" name={`seat-${check.roleKey}`} checked={chosen === item.stableKey}
                          onChange={() => setChosen(item.stableKey)} className="mt-1" />
                        <span>
                          <span className="font-semibold">{item.title}</span>
                          <span className="block text-xs text-muted-foreground">{item.unitPath.join(" › ")}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
            <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Alasan / dasar penetapan (wajib)"
              aria-label="Alasan jabatan acuan" className="h-10 w-full rounded-xl border border-border bg-surface-raised px-3 text-sm" />
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy || !chosen || !reason.trim()}
                onClick={() => { onSetSeat(check.roleKey, chosen, reason.trim()); setEditing(false); }}
                className="h-10 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">
                Simpan jabatan acuan
              </button>
              {check.seat ? (
                <button type="button" disabled={busy || !reason.trim()}
                  onClick={() => { onSetSeat(check.roleKey, null, reason.trim()); setEditing(false); }}
                  className="h-10 rounded-xl border border-danger-line px-4 text-sm font-bold text-danger-ink disabled:opacity-50">
                  Lepas jabatan acuan
                </button>
              ) : null}
              <button type="button" onClick={() => setEditing(false)} className="h-10 rounded-xl border border-border px-4 text-sm font-bold">
                Batal
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setEditing(true)} disabled={busy}
            className="mt-4 h-10 rounded-xl border border-border px-4 text-sm font-bold disabled:opacity-50">
            {check.seat ? "Ubah jabatan acuan" : "Tetapkan jabatan acuan"}
          </button>
        )
      ) : null}
    </section>
  );
}
