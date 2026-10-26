// ORG-005-1 (DRAFT D-5-2, D-5-3): which work location a unit works at. Units below inherit it, so a
// school names its campus once instead of every class doing it again. Nothing is guessed from a name.

import { LoaderCircle, MapPin } from "lucide-react";

import type { OrganizationNode } from "@/lib/organizationDesigner";

export interface WorkLocationOption {
  id: string;
  name: string;
  active: boolean;
}

export function OrganizationWorkLocation({
  node,
  locations,
  locationsError,
  canEdit,
  saving,
  onSave,
}: {
  node: OrganizationNode;
  locations: WorkLocationOption[];
  locationsError: string | null;
  canEdit: boolean;
  saving: boolean;
  onSave: (workLocationId: string | null) => void;
}) {
  const current = node.workLocationName ?? locations.find((item) => item.id === node.workLocationId)?.name ?? null;
  // Only active locations can be chosen; the current one stays listed even if it was switched off since.
  const choices = locations.filter((item) => item.active || item.id === node.workLocationId);

  return (
    <section>
      <div className="flex items-center gap-2">
        <MapPin className="h-4 w-4 text-brand-primary-deep" aria-hidden="true" />
        <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">Lokasi kerja</h3>
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Unit di bawahnya ikut memakai lokasi ini selama tidak memilih lokasinya sendiri.
      </p>

      {locationsError ? (
        <p role="alert" className="mt-3 rounded-xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink">
          {locationsError}
        </p>
      ) : null}

      {canEdit && !locationsError ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const value = String(new FormData(event.currentTarget).get("workLocationId") ?? "");
            onSave(value || null);
          }}
          className="mt-3 flex flex-col gap-2 sm:flex-row"
        >
          <select
            name="workLocationId"
            defaultValue={node.workLocationId ?? ""}
            aria-label="Lokasi kerja"
            className="h-11 flex-1 rounded-xl border border-border bg-surface-raised px-3 text-sm"
          >
            <option value="">Ikuti unit di atasnya</option>
            {choices.map((item) => (
              <option key={item.id} value={item.id}>{item.name}{item.active ? "" : " (nonaktif)"}</option>
            ))}
          </select>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-60"
          >
            {saving ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null} Simpan lokasi
          </button>
        </form>
      ) : (
        <p className="mt-3 rounded-xl border border-border/70 bg-surface p-3 text-sm">
          {current ? `Bekerja di ${current}.` : "Belum memilih lokasi sendiri; mengikuti unit di atasnya."}
        </p>
      )}
    </section>
  );
}
