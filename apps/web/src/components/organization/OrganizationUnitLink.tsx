// ORG-008-6b: the unit-link screen and the "Staf HC unit ini" panel (decision O-9, ATT-011 D-11).
//
// Overtime notification has to reach the staff who look after the employee's unit or the unit above
// it. The scopes that decide that point at the imported unit list, which is flat; the hierarchy
// lives in this structure. Linking the two is what lets "the unit above" be worked out at all.
//
// The panel is read-only about people: it shows who is already assigned, never who should be.
// Assignment stays in Akses, and this screen links units, nothing else.

import { AlertTriangle, Info, LoaderCircle, Users } from "lucide-react";

import type { OrganizationUnitSummary } from "@/lib/adminOrgAccess";
import type { OrganizationNode } from "@/lib/organizationDesigner";
import type { OrganizationUnitHcStaff } from "@/lib/organizationReadModel";

export function OrganizationUnitLink({
  node,
  units,
  unitsError,
  staff,
  staffLoading,
  staffError,
  canEdit,
  saving,
  onLink,
  onRetryStaff,
}: {
  node: OrganizationNode;
  units: OrganizationUnitSummary[];
  unitsError: string | null;
  staff: OrganizationUnitHcStaff | null;
  staffLoading: boolean;
  staffError: string | null;
  canEdit: boolean;
  saving: boolean;
  onLink: (legacyUnitId: string | null) => void;
  onRetryStaff: () => void;
}) {
  const linkedUnit = units.find((unit) => unit.id === node.legacyUnitId) ?? null;

  return (
    <div className="space-y-5">
      <section>
        <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">Unit lama yang diwakili</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Dipakai untuk menentukan staf Human Capital mana yang diberi tahu soal pengajuan lembur di
          unit ini dan unit di bawahnya. Tanpa tautan, pemberitahuan jatuh ke penerima tingkat
          yayasan, bukan ditebak.
        </p>

        {unitsError ? (
          <p role="alert" className="mt-3 rounded-xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink">
            {unitsError}
          </p>
        ) : null}

        {canEdit ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const value = String(new FormData(event.currentTarget).get("legacyUnitId") ?? "");
              onLink(value || null);
            }}
            className="mt-3 flex flex-col gap-2 sm:flex-row"
          >
            <select
              name="legacyUnitId"
              defaultValue={node.legacyUnitId ?? ""}
              aria-label="Unit lama"
              className="h-11 flex-1 rounded-xl border border-border bg-surface-raised px-3 text-sm"
            >
              <option value="">Belum ditautkan</option>
              {units.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.name} ({unit.activeCount} pegawai aktif)
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-60"
            >
              {saving ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null} Simpan tautan
            </button>
          </form>
        ) : (
          <p className="mt-3 rounded-xl border border-border/70 bg-surface p-3 text-sm">
            {linkedUnit ? `Tertaut ke unit lama "${linkedUnit.name}".` : "Belum ditautkan ke unit lama."}
          </p>
        )}
      </section>

      <section>
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-brand-primary-deep" aria-hidden="true" />
          <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">Staf HC unit ini</h3>
        </div>

        {staffError ? (
          <div role="alert" className="mt-2 flex flex-wrap items-center gap-3 rounded-xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">{staffError}</span>
            <button type="button" onClick={onRetryStaff} className="h-9 rounded-xl border border-danger-line px-3 text-xs font-bold">
              Coba lagi
            </button>
          </div>
        ) : staffLoading ? (
          <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> Mencari staf HC...
          </p>
        ) : staff?.fallback ? (
          <div className="mt-2 flex items-start gap-3 rounded-xl border border-info-line bg-info-soft p-3 text-sm text-info-ink">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              Unit ini dan unit di atasnya belum ditautkan ke unit lama, jadi pemberitahuan lembur
              memakai penerima tingkat yayasan. Tautkan unit di atas untuk mempersempitnya.
            </span>
          </div>
        ) : staff && staff.items.length === 0 ? (
          <p className="mt-2 rounded-xl border border-warning-line bg-warning-soft p-3 text-sm text-warning-ink">
            Tautannya sudah ada, tetapi belum ada staf HC yang diberi kewenangan atas unit itu.
            Penugasannya diatur di layar Akses.
          </p>
        ) : staff ? (
          <>
            <ul className="mt-2 space-y-2">
              {staff.items.map((person) => (
                <li key={`${person.employeeId}-${person.unitId}`} className="rounded-xl border border-border/70 bg-surface px-4 py-3 text-sm">
                  <span className="block font-semibold text-brand-heading">{person.fullName}</span>
                  <span className="text-[11px] text-muted-foreground">
                    Kewenangan atas unit {person.unitName}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Daftar ini hanya menampilkan penugasan yang sudah ada. Menambah atau mencabutnya dilakukan di layar Akses.
            </p>
          </>
        ) : null}
      </section>
    </div>
  );
}
