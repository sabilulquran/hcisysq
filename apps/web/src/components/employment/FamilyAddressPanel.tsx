// EMP-009 / EMP-003 P2-3 screen (spec §7.2). Family and addresses are dated
// records: a relationship that ends gets an end date, a house move opens a new
// address and the API closes the old one, and a mistake is voided with a
// reason. Nothing here deletes anything, and nothing here asks for a family
// identity number — the API refuses one until column encryption exists (§8).
//
// The lists and forms are exported on their own so the tests can render them
// with data; the panel below only fetches and wires them.

import { Home, Pencil, Phone, Plus, CircleSlash, Users } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { DetailDialog, useDialogParam } from "@/components/DetailDialog";

import { EmploymentApiError, formatDate, type EmploymentView } from "@/lib/employment";
import {
  ADDRESS_KIND_LABEL,
  ADDRESS_SOURCE_LABEL,
  FAMILY_RELATION_LABEL,
  GENDER_LABEL,
  amendAddress,
  amendFamilyMember,
  getAddresses,
  getFamily,
  recordAddress,
  recordFamilyMember,
  voidRelationRecord,
  type AddressInput,
  type AddressKind,
  type AddressList,
  type EmployeeAddress,
  type FamilyList,
  type FamilyMember,
  type FamilyMemberInput,
  type FamilyRelation,
  type Gender,
  type RelationRecordKind,
} from "@/lib/employeeRelations";

const card = "rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]";
const field = "w-full rounded-xl border border-border/70 bg-surface px-3 py-2 text-sm";
const primaryButton = "rounded-xl bg-brand-primary-deep px-4 py-2 text-sm font-bold text-white disabled:opacity-60";
const quietButton = "rounded-xl border border-border/70 px-3 py-1.5 text-xs font-bold text-muted-foreground";

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-bold text-brand-heading">{label}</span>
      {children}
    </label>
  );
}

function ViewStates({ view, children }: { view: EmploymentView<unknown>; children: ReactNode }) {
  if (view.kind === "loading") return <p className="text-sm text-muted-foreground">Memuat data…</p>;
  if (view.kind === "forbidden") {
    return <p className="text-sm text-muted-foreground">Akun ini tidak berhak melihat data keluarga dan alamat pegawai.</p>;
  }
  if (view.kind === "disabled") return <p className="text-sm text-muted-foreground">Bagian ini belum diaktifkan.</p>;
  if (view.kind === "error") return <p role="alert" className="text-sm text-danger-ink">{view.message}</p>;
  return <>{children}</>;
}

function period(row: { validFrom: string; validTo: string | null }): string {
  return row.validTo ? `${formatDate(row.validFrom)} – ${formatDate(row.validTo)}` : `Sejak ${formatDate(row.validFrom)}`;
}

export interface RelationActions {
  canManage: boolean;
  busy?: boolean;
  onEdit: (recordId: string) => void;
  onVoid: (recordId: string) => void;
}

function RowActions({ recordId, actions }: { recordId: string; actions: RelationActions }) {
  if (!actions.canManage) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className={quietButton} onClick={() => actions.onEdit(recordId)} disabled={actions.busy}>
        <Pencil className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />Ubah
      </button>
      <button type="button" className={quietButton} onClick={() => actions.onVoid(recordId)} disabled={actions.busy}>
        <CircleSlash className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />Batalkan
      </button>
    </div>
  );
}

export function FamilyRecords({ view, actions, onAdd }: {
  view: EmploymentView<FamilyList>;
  actions: RelationActions;
  onAdd: () => void;
}) {
  return (
    <article className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Users className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
          <h2 className="text-base font-bold text-brand-heading">Keluarga & tanggungan</h2>
        </div>
        {actions.canManage ? (
          <button type="button" className={primaryButton} onClick={onAdd}>
            <Plus className="mr-1 inline h-4 w-4" aria-hidden="true" />Tambah anggota keluarga
          </button>
        ) : null}
      </div>

      <ViewStates view={view}>
        {view.kind === "ready" ? (
          <>
            <p className="mt-3 text-sm text-muted-foreground">
              {view.data.dependents} tanggungan · {view.data.emergencyContacts} kontak darurat
            </p>
            {view.data.rows.length === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">Belum ada data keluarga.</p>
            ) : (
              <ul className="mt-4 grid gap-3">
                {view.data.rows.map((row) => (
                  <li key={row.id} className="rounded-xl border border-border/70 bg-surface p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm text-brand-heading">{row.fullName}</strong>
                      <span className="text-xs text-muted-foreground">{FAMILY_RELATION_LABEL[row.relation]}</span>
                      {row.isDependent ? (
                        <span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs font-bold">
                          Tanggungan{row.dependentOrder ? ` ke-${row.dependentOrder}` : ""}
                        </span>
                      ) : null}
                      {row.isEmergencyContact ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-surface-raised px-2 py-0.5 text-xs font-bold">
                          <Phone className="h-3 w-3" aria-hidden="true" />
                          Kontak darurat {row.emergencyPriority}
                        </span>
                      ) : null}
                      {row.validTo ? (
                        <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-muted-foreground">Sudah berakhir</span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {period(row)}
                      {row.birthDate ? ` · Lahir ${formatDate(row.birthDate)}` : ""}
                      {row.gender ? ` · ${GENDER_LABEL[row.gender]}` : ""}
                      {row.emergencyPhone ? ` · ${row.emergencyPhone}` : ""}
                    </p>
                    <RowActions recordId={row.id} actions={actions} />
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </ViewStates>
    </article>
  );
}

export function AddressRecords({ view, actions, onAdd }: {
  view: EmploymentView<AddressList>;
  actions: RelationActions;
  onAdd: () => void;
}) {
  return (
    <article className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Home className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
          <h2 className="text-base font-bold text-brand-heading">Alamat</h2>
        </div>
        {actions.canManage ? (
          <button type="button" className={primaryButton} onClick={onAdd}>
            <Plus className="mr-1 inline h-4 w-4" aria-hidden="true" />Catat alamat baru
          </button>
        ) : null}
      </div>

      <ViewStates view={view}>
        {view.kind === "ready" ? (
          view.data.rows.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">Belum ada alamat yang dicatat.</p>
          ) : (
            <ul className="mt-4 grid gap-3">
              {view.data.rows.map((row) => {
                const inForce = view.data.current[row.kind] === row.id;
                return (
                  <li key={row.id} className="rounded-xl border border-border/70 bg-surface p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm text-brand-heading">{ADDRESS_KIND_LABEL[row.kind]}</strong>
                      {inForce ? (
                        <span className="rounded-full bg-success-soft px-2 py-0.5 text-xs font-bold text-success-ink">
                          Berlaku sekarang
                        </span>
                      ) : (
                        <span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-muted-foreground">Riwayat</span>
                      )}
                      <span className="text-xs text-muted-foreground">{ADDRESS_SOURCE_LABEL[row.source]}</span>
                    </div>
                    <p className="mt-1 text-sm">{row.addressLine}</p>
                    <p className="text-xs text-muted-foreground">
                      {[row.village, row.district, row.city, row.province].filter(Boolean).join(", ")}
                      {row.postalCode ? ` ${row.postalCode}` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">{period(row)}</p>
                    <RowActions recordId={row.id} actions={actions} />
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
      </ViewStates>
    </article>
  );
}

export const EMPTY_FAMILY: FamilyMemberInput = {
  relation: "ANAK",
  fullName: "",
  birthDate: "",
  gender: null,
  isDependent: false,
  dependentOrder: null,
  isEmergencyContact: false,
  emergencyPhone: "",
  emergencyPriority: null,
  validFrom: "",
  validTo: "",
  notes: "",
};

export const EMPTY_ADDRESS: AddressInput = {
  kind: "DOMISILI",
  addressLine: "",
  village: "",
  district: "",
  city: "",
  province: "",
  postalCode: "",
  validFrom: "",
  validTo: "",
  source: "HC",
  notes: "",
};

export function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length ? trimmed : null;
}

function orderOrNull(value: string, previous: number | null): number | null {
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  return /^\d{1,2}$/.test(trimmed) ? Number(trimmed) : previous;
}

/** What the API is sent: blanks become null, and flags clear their own fields. */
export function familyPayload(draft: FamilyMemberInput): FamilyMemberInput {
  const isDependent = draft.isDependent === true;
  const isEmergencyContact = draft.isEmergencyContact === true;
  return {
    relation: draft.relation,
    fullName: draft.fullName.trim(),
    birthDate: blankToNull(draft.birthDate),
    gender: draft.gender ?? null,
    isDependent,
    dependentOrder: isDependent ? draft.dependentOrder ?? null : null,
    isEmergencyContact,
    emergencyPhone: isEmergencyContact ? blankToNull(draft.emergencyPhone) : null,
    emergencyPriority: isEmergencyContact ? draft.emergencyPriority ?? null : null,
    validFrom: draft.validFrom,
    validTo: blankToNull(draft.validTo),
    notes: blankToNull(draft.notes),
  };
}

export function addressPayload(draft: AddressInput): AddressInput {
  return {
    ...draft,
    addressLine: draft.addressLine.trim(),
    city: draft.city.trim(),
    village: blankToNull(draft.village),
    district: blankToNull(draft.district),
    province: blankToNull(draft.province),
    postalCode: blankToNull(draft.postalCode),
    validTo: blankToNull(draft.validTo),
    notes: blankToNull(draft.notes),
  };
}

export function FamilyForm({ draft, editing, busy, onChange, onSubmit, onCancel, bare = false }: {
  /** Inside a pop-up: no card, and the pop-up carries the heading. */
  bare?: boolean;
  draft: FamilyMemberInput;
  editing: boolean;
  busy: boolean;
  onChange: (next: FamilyMemberInput) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  const isDependent = draft.isDependent === true;
  const isEmergencyContact = draft.isEmergencyContact === true;
  return (
    <form onSubmit={onSubmit} className={bare ? "grid gap-3 sm:grid-cols-2" : "grid gap-3 rounded-2xl border border-border/70 bg-surface p-4 sm:grid-cols-2"}>
      {bare ? null : (
        <h3 className="sm:col-span-2 text-sm font-bold text-brand-heading">
          {editing ? "Ubah data anggota keluarga" : "Anggota keluarga baru"}
        </h3>
      )}
      <Labelled label="Hubungan">
        <select className={field} value={draft.relation} onChange={(event) => onChange({ ...draft, relation: event.target.value as FamilyRelation })}>
          {Object.entries(FAMILY_RELATION_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Labelled>
      <Labelled label="Nama">
        <input className={field} required value={draft.fullName} onChange={(event) => onChange({ ...draft, fullName: event.target.value })} />
      </Labelled>
      <Labelled label={isDependent ? "Tanggal lahir (wajib untuk tanggungan)" : "Tanggal lahir"}>
        <input
          className={field}
          type="date"
          required={isDependent}
          value={draft.birthDate ?? ""}
          onChange={(event) => onChange({ ...draft, birthDate: event.target.value })}
        />
      </Labelled>
      <Labelled label="Jenis kelamin">
        <select className={field} value={draft.gender ?? ""} onChange={(event) => onChange({ ...draft, gender: (event.target.value || null) as Gender | null })}>
          <option value="">Tidak dicatat</option>
          {Object.entries(GENDER_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Labelled>
      <Labelled label="Berlaku sejak">
        <input className={field} type="date" required value={draft.validFrom} onChange={(event) => onChange({ ...draft, validFrom: event.target.value })} />
      </Labelled>
      <Labelled label="Berakhir pada">
        <input className={field} type="date" value={draft.validTo ?? ""} onChange={(event) => onChange({ ...draft, validTo: event.target.value })} />
      </Labelled>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isDependent} onChange={(event) => onChange({ ...draft, isDependent: event.target.checked })} />
        <span className="font-bold text-brand-heading">Tanggungan</span>
      </label>
      {isDependent ? (
        <Labelled label="Urutan tanggungan">
          <input
            className={field}
            inputMode="numeric"
            value={draft.dependentOrder ?? ""}
            onChange={(event) => onChange({ ...draft, dependentOrder: orderOrNull(event.target.value, draft.dependentOrder ?? null) })}
          />
        </Labelled>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isEmergencyContact} onChange={(event) => onChange({ ...draft, isEmergencyContact: event.target.checked })} />
        <span className="font-bold text-brand-heading">Kontak darurat</span>
      </label>
      {isEmergencyContact ? (
        <>
          <Labelled label="Nomor telepon (wajib)">
            <input className={field} required value={draft.emergencyPhone ?? ""} onChange={(event) => onChange({ ...draft, emergencyPhone: event.target.value })} />
          </Labelled>
          <Labelled label="Urutan dihubungi (wajib)">
            <input
              className={field}
              inputMode="numeric"
              required
              value={draft.emergencyPriority ?? ""}
              onChange={(event) => onChange({ ...draft, emergencyPriority: orderOrNull(event.target.value, draft.emergencyPriority ?? null) })}
            />
          </Labelled>
        </>
      ) : null}
      <div className="sm:col-span-2 flex gap-2">
        <button type="submit" className={primaryButton} disabled={busy}>Simpan</button>
        <button type="button" className={quietButton} onClick={onCancel}>Batal</button>
      </div>
    </form>
  );
}

export function AddressForm({ draft, editing, busy, onChange, onSubmit, onCancel, bare = false }: {
  /** Inside a pop-up: no card, and the pop-up carries the heading. */
  bare?: boolean;
  draft: AddressInput;
  editing: boolean;
  busy: boolean;
  onChange: (next: AddressInput) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  return (
    <form onSubmit={onSubmit} className={bare ? "grid gap-3 sm:grid-cols-2" : "grid gap-3 rounded-2xl border border-border/70 bg-surface p-4 sm:grid-cols-2"}>
      {bare ? null : (
        <h3 className="sm:col-span-2 text-sm font-bold text-brand-heading">
          {editing ? "Ubah alamat" : "Alamat baru"}
        </h3>
      )}
      {!editing ? (
        <p className="sm:col-span-2 text-xs text-muted-foreground">
          Alamat yang berlaku untuk jenis ini akan ditutup sehari sebelum tanggal berlakunya alamat baru. Tidak ada
          alamat yang dihapus.
        </p>
      ) : null}
      <Labelled label="Jenis">
        <select className={field} value={draft.kind} onChange={(event) => onChange({ ...draft, kind: event.target.value as AddressKind })}>
          {Object.entries(ADDRESS_KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Labelled>
      <Labelled label="Berlaku sejak">
        <input className={field} type="date" required value={draft.validFrom} onChange={(event) => onChange({ ...draft, validFrom: event.target.value })} />
      </Labelled>
      <label className="sm:col-span-2 block text-sm">
        <span className="mb-1 block font-bold text-brand-heading">Alamat</span>
        <textarea className={field} rows={2} required value={draft.addressLine} onChange={(event) => onChange({ ...draft, addressLine: event.target.value })} />
      </label>
      <Labelled label="Desa/kelurahan">
        <input className={field} value={draft.village ?? ""} onChange={(event) => onChange({ ...draft, village: event.target.value })} />
      </Labelled>
      <Labelled label="Kecamatan">
        <input className={field} value={draft.district ?? ""} onChange={(event) => onChange({ ...draft, district: event.target.value })} />
      </Labelled>
      <Labelled label="Kota/kabupaten">
        <input className={field} required value={draft.city} onChange={(event) => onChange({ ...draft, city: event.target.value })} />
      </Labelled>
      <Labelled label="Provinsi">
        <input className={field} value={draft.province ?? ""} onChange={(event) => onChange({ ...draft, province: event.target.value })} />
      </Labelled>
      <Labelled label="Kode pos">
        <input className={field} inputMode="numeric" value={draft.postalCode ?? ""} onChange={(event) => onChange({ ...draft, postalCode: event.target.value })} />
      </Labelled>
      <div className="sm:col-span-2 flex gap-2">
        <button type="submit" className={primaryButton} disabled={busy}>Simpan</button>
        <button type="button" className={quietButton} onClick={onCancel}>Batal</button>
      </div>
    </form>
  );
}

export function viewFromRelationError(cause: unknown): EmploymentView<never> {
  if (cause instanceof EmploymentApiError) {
    if (cause.status === 403) return { kind: "forbidden" };
    return { kind: "error", message: cause.message };
  }
  return { kind: "error", message: "Data keluarga dan alamat tidak dapat dimuat. Periksa koneksi lalu coba lagi." };
}

function draftFromFamily(row: FamilyMember): FamilyMemberInput {
  return {
    relation: row.relation,
    fullName: row.fullName,
    birthDate: row.birthDate ?? "",
    gender: row.gender,
    isDependent: row.isDependent,
    dependentOrder: row.dependentOrder,
    isEmergencyContact: row.isEmergencyContact,
    emergencyPhone: row.emergencyPhone ?? "",
    emergencyPriority: row.emergencyPriority,
    validFrom: row.validFrom,
    validTo: row.validTo ?? "",
    notes: row.notes ?? "",
  };
}

function draftFromAddress(row: EmployeeAddress): AddressInput {
  return {
    kind: row.kind,
    addressLine: row.addressLine,
    village: row.village ?? "",
    district: row.district ?? "",
    city: row.city,
    province: row.province ?? "",
    postalCode: row.postalCode ?? "",
    validFrom: row.validFrom,
    validTo: row.validTo ?? "",
    source: row.source,
    notes: row.notes ?? "",
  };
}

export interface FamilyAddressPanelProps {
  employeeId: string;
  canManage: boolean;
  /** Overridden in tests; the browser prompt is how HC gives the reason. */
  askReason?: (question: string) => string | null;
}

export function FamilyAddressPanel({ employeeId, canManage, askReason }: FamilyAddressPanelProps) {
  const [familyView, setFamilyView] = useState<EmploymentView<FamilyList>>({ kind: "loading" });
  const [addressView, setAddressView] = useState<EmploymentView<AddressList>>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [familyDraft, setFamilyDraft] = useState<FamilyMemberInput | null>(null);
  const [addressDraft, setAddressDraft] = useState<AddressInput | null>(null);
  // The add/edit forms open as pop-ups kept in the URL: `?keluarga=baru|<id>` and `?alamat=baru|<id>`.
  const [familyParam, openFamily, closeFamily] = useDialogParam("keluarga");
  const [addressParam, openAddress, closeAddress] = useDialogParam("alamat");
  const familyEditing = familyParam && familyParam !== "baru" ? familyParam : null;
  const addressEditing = addressParam && addressParam !== "baru" ? addressParam : null;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setFamilyView({ kind: "loading" });
    setAddressView({ kind: "loading" });
    void getFamily(employeeId)
      .then((data) => { if (mounted) setFamilyView({ kind: "ready", data }); })
      .catch((cause: unknown) => { if (mounted) setFamilyView(viewFromRelationError(cause)); });
    void getAddresses(employeeId)
      .then((data) => { if (mounted) setAddressView({ kind: "ready", data }); })
      .catch((cause: unknown) => { if (mounted) setAddressView(viewFromRelationError(cause)); });
    return () => { mounted = false; };
  }, [employeeId, reloadToken]);

  // The form starts from an empty draft (`baru`) or from the saved record once the list has loaded.
  useEffect(() => {
    if (!familyParam) { setFamilyDraft(null); return; }
    if (familyParam === "baru") { setFamilyDraft({ ...EMPTY_FAMILY }); return; }
    const row = familyView.kind === "ready" ? familyView.data.rows.find((item) => item.id === familyParam) : undefined;
    setFamilyDraft(row ? draftFromFamily(row) : null);
  }, [familyParam, familyView]);

  // The form starts from an empty draft (`baru`) or from the saved record once the list has loaded.
  useEffect(() => {
    if (!addressParam) { setAddressDraft(null); return; }
    if (addressParam === "baru") { setAddressDraft({ ...EMPTY_ADDRESS }); return; }
    const row = addressView.kind === "ready" ? addressView.data.rows.find((item) => item.id === addressParam) : undefined;
    setAddressDraft(row ? draftFromAddress(row) : null);
  }, [addressParam, addressView]);

  const refresh = (message: string) => {
    setNotice(message);
    setError(null);
    if (familyParam) closeFamily();
    if (addressParam) closeAddress();
    setReloadToken((token) => token + 1);
  };

  async function run(work: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof EmploymentApiError ? cause.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  const ask = askReason ?? ((question: string) => window.prompt(question));

  const submitFamily = (event: FormEvent) => {
    event.preventDefault();
    if (!familyDraft) return;
    const payload = familyPayload(familyDraft);
    void run(async () => {
      if (familyEditing) {
        await amendFamilyMember(familyEditing, payload);
        refresh("Data anggota keluarga diperbarui.");
      } else {
        await recordFamilyMember(employeeId, payload);
        refresh("Anggota keluarga ditambahkan.");
      }
    }, "Data keluarga tidak dapat disimpan.");
  };

  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    if (!addressDraft) return;
    const payload = addressPayload(addressDraft);
    void run(async () => {
      if (addressEditing) {
        await amendAddress(addressEditing, payload);
        refresh("Alamat diperbarui.");
      } else {
        const saved = await recordAddress(employeeId, payload);
        refresh(saved.closedAddressId
          ? "Alamat baru dicatat; alamat sebelumnya ditutup sehari sebelumnya."
          : "Alamat dicatat.");
      }
    }, "Alamat tidak dapat disimpan.");
  };

  function actionsFor(kind: RelationRecordKind, startEdit: (recordId: string) => void): RelationActions {
    return {
      canManage,
      busy,
      onEdit: startEdit,
      onVoid: (recordId) => {
        const reason = ask("Alasan pembatalan catatan (minimal 5 huruf):")?.trim() ?? "";
        if (reason.length < 5) return;
        void run(async () => {
          await voidRelationRecord(kind, recordId, reason);
          refresh("Catatan dibatalkan; riwayatnya tetap tersimpan.");
        }, "Catatan tidak dapat dibatalkan.");
      },
    };
  }

  return (
    <section className="grid gap-5">
      {notice ? <p role="status" className="rounded-2xl border border-border/70 bg-surface p-4 text-sm">{notice}</p> : null}
      {error ? <p role="alert" className="rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</p> : null}

      <FamilyRecords
        view={familyView}
        onAdd={() => openFamily("baru")}
        actions={actionsFor("family", openFamily)}
      />
      {canManage && familyParam ? (
        <DetailDialog title={familyEditing ? "Ubah data anggota keluarga" : "Anggota keluarga baru"} onClose={closeFamily}>
          {error ? <p role="alert" className="mb-4 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</p> : null}
          {familyDraft ? (
            <FamilyForm
              bare
              draft={familyDraft}
              editing={familyEditing !== null}
              busy={busy}
              onChange={setFamilyDraft}
              onSubmit={submitFamily}
              onCancel={closeFamily}
            />
          ) : familyView.kind === "loading" ? (
            <p className="text-sm text-muted-foreground">Memuat…</p>
          ) : (
            <p className="text-sm text-muted-foreground">Anggota keluarga ini tidak ada di daftar yang ditampilkan.</p>
          )}
        </DetailDialog>
      ) : null}

      <AddressRecords
        view={addressView}
        onAdd={() => openAddress("baru")}
        actions={actionsFor("address", openAddress)}
      />
      {canManage && addressParam ? (
        <DetailDialog title={addressEditing ? "Ubah alamat" : "Alamat baru"} onClose={closeAddress}>
          {error ? <p role="alert" className="mb-4 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</p> : null}
          {addressDraft ? (
            <AddressForm
              bare
              draft={addressDraft}
              editing={addressEditing !== null}
              busy={busy}
              onChange={setAddressDraft}
              onSubmit={submitAddress}
              onCancel={closeAddress}
            />
          ) : addressView.kind === "loading" ? (
            <p className="text-sm text-muted-foreground">Memuat…</p>
          ) : (
            <p className="text-sm text-muted-foreground">Alamat ini tidak ada di daftar yang ditampilkan.</p>
          )}
        </DetailDialog>
      ) : null}
    </section>
  );
}
