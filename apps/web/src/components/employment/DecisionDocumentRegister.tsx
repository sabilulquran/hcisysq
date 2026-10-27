// EMP-010 S4 screen "Perjanjian Kerja & SK" (spec §13.5). Presentational and
// stateful only: required fields, the lock after an action uses a document, and
// numbering are decided by the API, and every refusal is shown as it comes back.

import { FileSignature, Lock, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { EmploymentStateNotice } from "@/components/employment/EmploymentPanels";
import {
  type Draft,
  PK_CATEGORY_LABEL,
  PK_TYPE_LABEL,
  SK_TYPE_LABEL,
  correctDecisionDocument,
  createDecisionDocument,
  draftFrom,
  emptyDraft,
  getDecisionDocument,
  listDecisionDocuments,
  payloadOf,
  updateDecisionDocument,
  type DecisionDocumentDetail,
  type DecisionDocumentKind,
  type DecisionDocumentPage,
  type PkCategory,
  type PkType,
  type SkType,
} from "@/lib/decision-documents";
import { ACTION_LABEL, formatDate, viewFromError, type EmploymentView } from "@/lib/employment";

const card = "rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]";
const field = "h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/15";
const primaryButton = "h-10 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground hover:bg-brand-primary-deep disabled:opacity-60";
const quietButton = "h-10 rounded-xl border border-border px-4 text-sm font-semibold text-foreground hover:bg-surface";

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function LockedBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-warning-line bg-warning-soft px-2.5 py-1 text-xs font-bold text-warning-ink">
      <Lock className="mr-1 h-3 w-3" aria-hidden="true" />
      Terkunci
    </span>
  );
}

export interface DecisionDocumentRegisterProps {
  kind: DecisionDocumentKind;
  onKindChange: (kind: DecisionDocumentKind) => void;
  canManage: boolean;
  canCorrect: boolean;
  employeeHref: (employeeId: string) => string;
}

export function DecisionDocumentRegister({
  kind,
  onKindChange,
  canManage,
  canCorrect,
  employeeHref,
}: DecisionDocumentRegisterProps) {
  const [view, setView] = useState<EmploymentView<DecisionDocumentPage>>({ kind: "loading" });
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [year, setYear] = useState("");
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<DecisionDocumentDetail | null>(null);
  const [form, setForm] = useState<{ mode: "create" | "edit" | "correction"; draft: Draft } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setView({ kind: "loading" });
    void listDecisionDocuments({
      kind,
      page,
      ...(appliedSearch ? { search: appliedSearch } : {}),
      ...(year ? { year: Number(year) } : {}),
      ...(type && kind === "PERJANJIAN_KERJA" ? { pkType: type as PkType } : {}),
      ...(type && kind === "SURAT_KEPUTUSAN" ? { skType: type as SkType } : {}),
    })
      .then((data) => setView({ kind: "ready", data }))
      .catch((cause: unknown) => setView(viewFromError(cause)));
  }, [kind, page, appliedSearch, year, type]);

  useEffect(load, [load]);

  const typeOptions = useMemo(
    () =>
      kind === "PERJANJIAN_KERJA"
        ? Object.entries(PK_TYPE_LABEL)
        : Object.entries(SK_TYPE_LABEL),
    [kind],
  );

  function switchKind(next: DecisionDocumentKind) {
    if (next === kind) return;
    setSelected(null);
    setForm(null);
    setType("");
    setPage(1);
    onKindChange(next);
  }

  async function openDetail(documentId: string) {
    setForm(null);
    setNotice(null);
    try {
      setSelected(await getDecisionDocument(documentId));
    } catch (cause) {
      const failed = viewFromError(cause);
      setNotice(failed.kind === "error" ? failed.message : "Detail dokumen tidak dapat dimuat.");
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    setFormError(null);
    try {
      const payload = payloadOf(form.draft);
      if (form.mode === "create") {
        const created = await createDecisionDocument(payload);
        setNotice(`Dokumen ${created.documentNumber} tercatat.`);
        await openDetail(created.id);
      } else if (form.mode === "edit" && selected) {
        await updateDecisionDocument(selected.id, { ...payload, expectedUpdatedAt: selected.updatedAt });
        setNotice("Dokumen diperbarui.");
        await openDetail(selected.id);
      } else if (form.mode === "correction" && selected) {
        await correctDecisionDocument(selected.id, {
          ...payload,
          reason: form.draft.reason,
          expectedUpdatedAt: selected.updatedAt,
        });
        setNotice("Koreksi tercatat; nilai sebelumnya disimpan.");
        await openDetail(selected.id);
      }
      setForm(null);
      load();
    } catch (cause) {
      const failed = viewFromError(cause);
      setFormError(failed.kind === "error" ? failed.message : "Dokumen tidak dapat disimpan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Jenis dokumen" className="flex gap-2">
        {(["PERJANJIAN_KERJA", "SURAT_KEPUTUSAN"] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={option === kind}
            onClick={() => switchKind(option)}
            className={`h-10 rounded-xl border px-4 text-sm font-semibold ${
              option === kind
                ? "border-brand-primary bg-brand-primary text-brand-foreground"
                : "border-border bg-surface text-foreground hover:bg-surface-raised"
            }`}
          >
            {option === "PERJANJIAN_KERJA" ? "Perjanjian Kerja" : "Surat Keputusan"}
          </button>
        ))}
      </div>

      {notice ? (
        <p role="status" className="rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink">{notice}</p>
      ) : null}

      <section className={card}>
        <form
          className="grid gap-3 lg:grid-cols-[minmax(12rem,1.4fr)_repeat(2,minmax(8rem,0.6fr))_auto_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setAppliedSearch(search.trim());
          }}
        >
          <label className="relative block">
            <span className="sr-only">Cari dokumen</span>
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={kind === "PERJANJIAN_KERJA" ? "Cari nomor PK atau nama pegawai" : "Cari nomor SK atau perihal"}
              className={`${field} pl-9`}
            />
          </label>
          <label className="block">
            <span className="sr-only">Tahun tanda tangan</span>
            <input
              value={year}
              inputMode="numeric"
              onChange={(event) => {
                setYear(event.target.value.replace(/\D/g, "").slice(0, 4));
                setPage(1);
              }}
              placeholder="Tahun"
              className={field}
            />
          </label>
          <label className="block">
            <span className="sr-only">Jenis dokumen</span>
            <select
              value={type}
              onChange={(event) => {
                setType(event.target.value);
                setPage(1);
              }}
              className={field}
            >
              <option value="">Semua jenis</option>
              {typeOptions.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <button type="submit" className={primaryButton}>Cari</button>
          {canManage ? (
            <button
              type="button"
              className={quietButton}
              onClick={() => {
                setSelected(null);
                setFormError(null);
                setNotice(null);
                setForm({ mode: "create", draft: emptyDraft(kind) });
              }}
            >
              <Plus className="mr-1 inline h-4 w-4" aria-hidden="true" />
              {kind === "PERJANJIAN_KERJA" ? "Catat Perjanjian Kerja" : "Catat SK"}
            </button>
          ) : null}
        </form>
      </section>

      {form ? (
        <DocumentForm
          mode={form.mode}
          draft={form.draft}
          busy={busy}
          error={formError}
          onChange={(draft) => setForm({ mode: form.mode, draft })}
          onCancel={() => setForm(null)}
          onSubmit={submit}
        />
      ) : null}

      <EmploymentStateNotice view={view} subject="daftar dokumen" />

      {view.kind === "ready" ? (
        view.data.rows.length === 0 ? (
          <p className={`${card} text-sm text-muted-foreground`}>
            Belum ada dokumen yang cocok dengan pencarian ini.
          </p>
        ) : (
          <section className="overflow-hidden rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="bg-surface text-xs font-semibold uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Nomor</th>
                  <th className="px-4 py-3">Jenis</th>
                  <th className="px-4 py-3">{kind === "PERJANJIAN_KERJA" ? "Pegawai" : "Perihal"}</th>
                  <th className="px-4 py-3">{kind === "PERJANJIAN_KERJA" ? "Masa kontrak" : "Berlaku"}</th>
                  <th className="px-4 py-3">Ditandatangani</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {view.data.rows.map((row) => (
                  <tr key={row.id} className="border-t border-border/60">
                    <td className="px-4 py-3 font-semibold text-foreground">
                      {row.documentNumber} {row.locked ? <LockedBadge /> : null}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {row.pkType ? PK_TYPE_LABEL[row.pkType] : row.skType ? SK_TYPE_LABEL[row.skType] : "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {kind === "PERJANJIAN_KERJA"
                        ? `${row.employeeName ?? "—"}${row.category ? ` · ${PK_CATEGORY_LABEL[row.category]}` : ""}`
                        : row.subject ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {kind === "PERJANJIAN_KERJA"
                        ? `${formatDate(row.contractFrom)} – ${formatDate(row.contractTo)}`
                        : `${formatDate(row.effectiveOn)}${row.effectiveTo ? ` – ${formatDate(row.effectiveTo)}` : ""}`}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(row.signedOn)}</td>
                    <td className="px-4 py-3 text-right">
                      <button type="button" className="text-sm font-semibold text-brand-primary" onClick={() => void openDetail(row.id)}>
                        Detail
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {view.data.total > view.data.pageSize ? (
              <PaginationBar page={view.data.page} pageSize={view.data.pageSize} total={view.data.total} onPageChange={setPage} />
            ) : null}
          </section>
        )
      ) : null}

      {selected ? (
        <DocumentDetail
          document={selected}
          canManage={canManage}
          canCorrect={canCorrect}
          employeeHref={employeeHref}
          onClose={() => setSelected(null)}
          onEdit={() => {
            setFormError(null);
            setForm({ mode: selected.locked ? "correction" : "edit", draft: draftFrom(selected) });
          }}
        />
      ) : null}
    </div>
  );
}

export function DocumentForm({
  mode,
  draft,
  busy,
  error,
  onChange,
  onCancel,
  onSubmit,
}: {
  mode: "create" | "edit" | "correction";
  draft: Draft;
  busy: boolean;
  error: string | null;
  onChange: (draft: Draft) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const isPk = draft.documentKind === "PERJANJIAN_KERJA";
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const title =
    mode === "create"
      ? isPk ? "Catat Perjanjian Kerja" : "Catat Surat Keputusan"
      : mode === "edit"
        ? "Ubah dokumen"
        : "Koreksi dokumen terkunci";

  return (
    <form onSubmit={onSubmit} className={card}>
      <h2 className="text-base font-bold text-brand-heading">{title}</h2>
      {mode === "correction" ? (
        <p className="mt-1 text-sm text-muted-foreground">
          Dokumen sudah dipakai pada tindakan kepegawaian. Nilai sebelumnya disimpan bersama alasan koreksi.
        </p>
      ) : null}
      {error ? <p role="alert" className="mt-3 rounded-xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink">{error}</p> : null}

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Labelled label="Nomor dokumen">
          <input value={draft.documentNumber} onChange={(event) => set({ documentNumber: event.target.value })} className={field} />
        </Labelled>
        <Labelled label="Tanggal tanda tangan">
          <input type="date" value={draft.signedOn} onChange={(event) => set({ signedOn: event.target.value })} className={field} />
        </Labelled>

        {isPk ? (
          <>
            <Labelled label="Jenis Perjanjian Kerja">
              <select value={draft.pkType ?? ""} onChange={(event) => set({ pkType: event.target.value as PkType })} className={field}>
                {Object.entries(PK_TYPE_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </Labelled>
            <Labelled label="Status kepegawaian">
              <select value={draft.category ?? ""} onChange={(event) => set({ category: event.target.value as PkCategory })} className={field}>
                {Object.entries(PK_CATEGORY_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </Labelled>
            <Labelled label="ID pegawai">
              <input
                value={draft.employeeId ?? ""}
                onChange={(event) => set({ employeeId: event.target.value || null })}
                placeholder="Salin dari detail pegawai"
                className={field}
                readOnly={mode !== "create"}
              />
            </Labelled>
            <Labelled label="Penanda tangan pemberi kerja">
              <input value={draft.signatoryEmployerLabel ?? ""} onChange={(event) => set({ signatoryEmployerLabel: event.target.value })} className={field} />
            </Labelled>
            <Labelled label="Kontrak mulai">
              <input type="date" value={draft.contractFrom ?? ""} onChange={(event) => set({ contractFrom: event.target.value })} className={field} />
            </Labelled>
            <Labelled label="Kontrak selesai">
              <input type="date" value={draft.contractTo ?? ""} onChange={(event) => set({ contractTo: event.target.value })} className={field} />
            </Labelled>
          </>
        ) : (
          <>
            <Labelled label="Jenis SK">
              <select value={draft.skType ?? ""} onChange={(event) => set({ skType: event.target.value as SkType })} className={field}>
                {Object.entries(SK_TYPE_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </Labelled>
            <Labelled label="Pejabat penerbit">
              <input value={draft.issuingAuthorityLabel ?? ""} onChange={(event) => set({ issuingAuthorityLabel: event.target.value })} className={field} />
            </Labelled>
            <Labelled label="Perihal">
              <input value={draft.subject ?? ""} onChange={(event) => set({ subject: event.target.value })} className={field} />
            </Labelled>
            <Labelled label="Berlaku mulai">
              <input type="date" value={draft.effectiveOn ?? ""} onChange={(event) => set({ effectiveOn: event.target.value })} className={field} />
            </Labelled>
            <Labelled label="Berlaku sampai (opsional)">
              <input type="date" value={draft.effectiveTo ?? ""} onChange={(event) => set({ effectiveTo: event.target.value })} className={field} />
            </Labelled>
          </>
        )}

        <Labelled label="Lokasi arsip (opsional)">
          <input value={draft.externalReference ?? ""} onChange={(event) => set({ externalReference: event.target.value })} className={field} />
        </Labelled>
        <Labelled label="Catatan (opsional)">
          <input value={draft.notes ?? ""} onChange={(event) => set({ notes: event.target.value })} className={field} />
        </Labelled>

        {mode === "correction" ? (
          <div className="md:col-span-2">
            <Labelled label="Alasan koreksi (minimal 10 karakter)">
              <input value={draft.reason} onChange={(event) => set({ reason: event.target.value })} className={field} />
            </Labelled>
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex gap-2">
        <button type="submit" className={primaryButton} disabled={busy}>{busy ? "Menyimpan..." : "Simpan"}</button>
        <button type="button" className={quietButton} onClick={onCancel}>Batal</button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Paket ini menyimpan metadata dokumen; berkas hasil pindai belum dapat diunggah.
      </p>
    </form>
  );
}

export function DocumentDetail({
  document,
  canManage,
  canCorrect,
  employeeHref,
  onClose,
  onEdit,
}: {
  document: DecisionDocumentDetail;
  canManage: boolean;
  canCorrect: boolean;
  employeeHref: (employeeId: string) => string;
  onClose: () => void;
  onEdit: () => void;
}) {
  const isPk = document.documentKind === "PERJANJIAN_KERJA";
  const mayWrite = document.locked ? canCorrect : canManage;
  return (
    <section className={card} aria-label={`Detail dokumen ${document.documentNumber}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-brand-heading">
            <FileSignature className="mr-1 inline h-4 w-4" aria-hidden="true" />
            {document.documentNumber} {document.locked ? <LockedBadge /> : null}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {isPk
              ? `${document.pkType ? PK_TYPE_LABEL[document.pkType] : "—"} · ${document.employeeName ?? "—"}`
              : `${document.skType ? SK_TYPE_LABEL[document.skType] : "—"} · ${document.subject ?? "—"}`}
          </p>
        </div>
        <div className="flex gap-2">
          {mayWrite ? (
            <button type="button" className={quietButton} onClick={onEdit}>
              {document.locked ? "Koreksi" : "Ubah"}
            </button>
          ) : null}
          <button type="button" className={quietButton} onClick={onClose}>Tutup</button>
        </div>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Detail label="Ditandatangani" value={formatDate(document.signedOn)} />
        {isPk ? (
          <>
            <Detail label="Masa kontrak" value={`${formatDate(document.contractFrom)} – ${formatDate(document.contractTo)}`} />
            <Detail label="Status kepegawaian" value={document.category ? PK_CATEGORY_LABEL[document.category] : "—"} />
            <Detail label="Penanda tangan" value={document.signatoryEmployerLabel ?? "—"} />
            <Detail label="PK sebelumnya" value={document.previousPkNumber ?? "—"} />
            <Detail
              label="Pegawai"
              value={
                document.employeeId ? (
                  <a className="font-semibold text-brand-primary" href={employeeHref(document.employeeId)}>
                    {document.employeeName ?? document.employeeNumber ?? "Lihat pegawai"}
                  </a>
                ) : (
                  "—"
                )
              }
            />
          </>
        ) : (
          <>
            <Detail
              label="Berlaku"
              value={`${formatDate(document.effectiveOn)}${document.effectiveTo ? ` – ${formatDate(document.effectiveTo)}` : ""}`}
            />
            <Detail label="Pejabat penerbit" value={document.issuingAuthorityLabel ?? "—"} />
          </>
        )}
        <Detail label="Lokasi arsip" value={document.externalReference ?? "—"} />
        <Detail label="Catatan" value={document.notes ?? "—"} />
      </dl>

      <h3 className="mt-5 text-sm font-bold text-brand-heading">Dipakai pada tindakan</h3>
      {document.links.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">Belum dipakai pada tindakan kepegawaian mana pun.</p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
          {document.links.map((link) => (
            <li key={link.actionId}>
              {ACTION_LABEL[link.actionType] ?? link.actionType} · {formatDate(link.effectiveOn)} ·{" "}
              <a className="font-semibold text-brand-primary" href={employeeHref(link.employeeId)}>
                {link.employeeName ?? link.employeeNumber ?? "Pegawai"}
              </a>
              {link.state === "REVERSED" ? " · dibatalkan" : ""}
            </li>
          ))}
        </ul>
      )}

      {document.corrections.length ? (
        <>
          <h3 className="mt-5 text-sm font-bold text-brand-heading">Riwayat koreksi</h3>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {document.corrections.map((correction) => (
              <li key={correction.id}>
                {new Date(correction.correctedAt).toLocaleDateString("id-ID")} · {correction.reason}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-semibold text-foreground">{value}</dd>
    </div>
  );
}
