// AUTH-015 (ADR-0007, owner decision 2026-11-04): on the Akses screen, the roles that follow a
// seat in the organization structure. Whoever holds a linked seat today (primary or Plt) holds the
// role, decided by the API on every request; when the seat changes hands the role moves with it.
//
// Linking or unlinking is a role grant to whoever sits there, so only Super Admin (break-glass)
// may do it, with a reason. Roles that administer access can never be linked; the API offers only
// the roles it accepts.

import { AlertTriangle, LoaderCircle, Search } from "lucide-react";
import { useState, type FormEvent } from "react";

import type { RoleSeatCheck, RoleSeatChecksResponse } from "@/lib/adminOrgAccess";
import {
  notEffectiveSentence,
  roleSeatMismatchSentence,
  roleSeatName,
  roleSeatStatusSentence,
} from "@/lib/roleSeatLanguage";

type PositionHit = { stableKey: string; title: string; unitPath: string[] };

export function RoleSeatPanel({
  data,
  error,
  canManage,
  busy,
  onAdd,
  onRemove,
  onSearchPositions,
}: {
  data: RoleSeatChecksResponse | null;
  error: string | null;
  /** Super Admin only, like granting a role. */
  canManage: boolean;
  busy: boolean;
  /** Resolve true when saved, so a form keeps its input after a refusal. */
  onAdd: (roleKey: string, positionKey: string, reason: string) => Promise<boolean>;
  onRemove: (roleKey: string, positionKey: string, reason: string) => Promise<boolean>;
  onSearchPositions: (query: string) => Promise<PositionHit[]>;
}) {
  if (error) {
    return (
      <section className="mt-5 rounded-2xl border border-border/70 bg-surface-raised p-5 text-sm text-muted-foreground shadow-[var(--shadow-soft)]">
        {error}
      </section>
    );
  }
  if (!data) return null;
  return (
    <section className="mt-5 rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
      <h2 className="text-base font-bold text-brand-heading">Peran yang mengikuti jabatan</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Pemegang jabatan di struktur yang berlaku hari ini, termasuk Plt, otomatis memegang peran yang ditautkan ke
        jabatannya. Bila jabatan berganti pemegang, peran ikut pindah tanpa langkah tambahan. Peran pengelola akses
        tidak pernah mengikuti jabatan.
      </p>
      {data.items.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">Belum ada peran yang mengikuti jabatan.</p>
      ) : (
        data.items.map((check) => (
          <RoleSeatCard key={check.roleKey} check={check} canManage={canManage} busy={busy} onRemove={onRemove} />
        ))
      )}
      {canManage && data.linkableRoles.length > 0 ? (
        <AddLinkForm roles={data.linkableRoles} busy={busy} onAdd={onAdd} onSearchPositions={onSearchPositions} />
      ) : null}
    </section>
  );
}

function RoleSeatCard({
  check, canManage, busy, onRemove,
}: {
  check: RoleSeatCheck;
  canManage: boolean;
  busy: boolean;
  onRemove: (roleKey: string, positionKey: string, reason: string) => Promise<boolean>;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  return (
    <article className="mt-4 rounded-xl border border-border/70 bg-surface p-4">
      <h3 className="text-sm font-bold text-brand-heading">{check.roleName}</h3>
      <ul className="mt-2 space-y-3">
        {check.seats.map((seat) => {
          const status = roleSeatStatusSentence(seat);
          return (
            <li key={seat.positionKey} className="text-sm">
              <p>
                <span className="font-semibold">{roleSeatName(seat) ?? "Jabatan tidak ada di struktur berlaku"}</span>
                <span className="block text-xs text-muted-foreground">Dasar: {seat.reason}</span>
              </p>
              {status ? <p className="mt-1 text-xs text-warning-ink">{status}</p> : null}
              {seat.incumbents.length > 0 ? (
                <ul className="mt-1 space-y-0.5 text-xs">
                  {seat.incumbents.map((incumbent) => (
                    <li key={incumbent.employeeId}>
                      &bull; {incumbent.kind === "ACTING" ? "Plt " : ""}{incumbent.name}:{" "}
                      {incumbent.roleEffective
                        ? <span className="font-semibold text-success-ink">peran berlaku</span>
                        : <span className="font-semibold text-warning-ink">belum berlaku, {notEffectiveSentence(incumbent.notEffectiveReason!)}</span>}
                    </li>
                  ))}
                </ul>
              ) : null}
              {canManage ? (
                removing === seat.positionKey ? (
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Alasan melepas (wajib)"
                      aria-label="Alasan melepas tautan" className="h-9 min-w-0 flex-1 rounded-xl border border-border bg-surface-raised px-3 text-xs" />
                    <button type="button" disabled={busy || !reason.trim()}
                      onClick={() => void onRemove(check.roleKey, seat.positionKey, reason.trim()).then((done) => {
                        if (done) { setRemoving(null); setReason(""); }
                      })}
                      className="h-9 rounded-xl border border-danger-line px-3 text-xs font-bold text-danger-ink disabled:opacity-50">
                      Lepas tautan
                    </button>
                    <button type="button" onClick={() => setRemoving(null)} className="h-9 rounded-xl border border-border px-3 text-xs font-bold">
                      Batal
                    </button>
                  </div>
                ) : (
                  <button type="button" disabled={busy} onClick={() => { setRemoving(seat.positionKey); setReason(""); }}
                    className="mt-2 text-xs font-bold text-danger-ink disabled:opacity-50">
                    Lepas tautan
                  </button>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
      {check.mismatches.length > 0 ? (
        <div role="alert" className="mt-3 rounded-xl border border-warning-line bg-warning-soft p-3 text-xs text-warning-ink">
          <p className="flex items-center gap-2 font-bold">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            Perlu diperhatikan
          </p>
          <ul className="mt-1 space-y-1">
            {check.mismatches.map((mismatch) => (
              <li key={`${mismatch.kind}-${mismatch.kind === "DIRECT_HOLDER_NOT_SEATED" ? mismatch.accountId : `${mismatch.positionKey}-${mismatch.employeeId}`}`}>
                &bull; {roleSeatMismatchSentence(check, mismatch)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

function AddLinkForm({
  roles, busy, onAdd, onSearchPositions,
}: {
  roles: RoleSeatChecksResponse["linkableRoles"];
  busy: boolean;
  onAdd: (roleKey: string, positionKey: string, reason: string) => Promise<boolean>;
  onSearchPositions: (query: string) => Promise<PositionHit[]>;
}) {
  const [open, setOpen] = useState(false);
  const [roleKey, setRoleKey] = useState(roles[0]?.roleKey ?? "");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PositionHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const search = (event: FormEvent) => {
    event.preventDefault();
    setSearching(true);
    void onSearchPositions(query.trim())
      .then(setResults)
      .catch(() => setResults([]))
      .finally(() => setSearching(false));
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} disabled={busy}
        className="mt-4 h-10 rounded-xl border border-border px-4 text-sm font-bold disabled:opacity-50">
        Tautkan peran ke jabatan
      </button>
    );
  }
  return (
    <div className="mt-4 space-y-3 rounded-xl border border-border/70 bg-surface p-4">
      <label className="block text-xs font-semibold">
        Peran
        <select value={roleKey} onChange={(event) => setRoleKey(event.target.value)}
          className="mt-1 h-10 w-full rounded-xl border border-border bg-surface-raised px-3 text-sm">
          {roles.map((role) => <option key={role.roleKey} value={role.roleKey}>{role.roleName}</option>)}
        </select>
      </label>
      <form onSubmit={search} className="flex flex-col gap-2 sm:flex-row">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari jabatan atau unit"
          aria-label="Cari jabatan" className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-surface-raised px-3 text-sm" />
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
                  <input type="radio" name="role-seat-position" checked={chosen === item.stableKey}
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
        aria-label="Alasan tautan" className="h-10 w-full rounded-xl border border-border bg-surface-raised px-3 text-sm" />
      <p className="text-xs text-muted-foreground">
        Menyimpan tautan langsung memberi peran ini kepada pemegang jabatan tersebut, sekarang dan berikutnya.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || !roleKey || !chosen || !reason.trim()}
          onClick={() => void onAdd(roleKey, chosen!, reason.trim()).then((saved) => {
            if (saved) { setOpen(false); setChosen(null); setReason(""); setResults(null); setQuery(""); }
          })}
          className="h-10 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">
          Simpan tautan
        </button>
        <button type="button" onClick={() => setOpen(false)} className="h-10 rounded-xl border border-border px-4 text-sm font-bold">
          Batal
        </button>
      </div>
    </div>
  );
}
