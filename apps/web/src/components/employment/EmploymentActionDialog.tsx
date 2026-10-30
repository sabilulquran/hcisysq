// EMP-005 S5B: one dialog for every contract action (spec §13.3). Four steps —
// fill in, pick the basis document, check "dari → menjadi", save. The API
// decides what is required and what is refused; this component shows the
// answer it gives and never predicts it.

import { AlertTriangle, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { AdminApiError } from "@/lib/adminEmployees";
import { jobFamilyLabels, listJobClassifications, type JobClassification } from "@/lib/jobClassifications";

import {
  ACTION_DONE_MESSAGE,
  ACTION_TITLE,
  CAREER_REASON_LABEL,
  TERMINATION_REASON_LABEL,
  WARNING_LABEL,
  newIdempotencyKey,
  previewEmploymentAction,
  recordEmploymentAction,
  requiredDocumentKind,
  type ActionCategory,
  type CareerReasonCode,
  type EmploymentActionPreview,
  type EmploymentActionRequest,
  type EmploymentActionType,
  type TerminationReason,
} from "@/lib/employment-actions";
import { CATEGORY_LABEL, EmploymentApiError, formatDate } from "@/lib/employment";
import { listEmployees } from "@/lib/adminEmployees";
import { listDecisionDocuments, type DecisionDocument } from "@/lib/decision-documents";

const field =
  "h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/15";
const primaryButton =
  "h-10 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground hover:bg-brand-primary-deep disabled:opacity-60";
const quietButton = "h-10 rounded-xl border border-border px-4 text-sm font-semibold text-foreground hover:bg-surface";

const CONTRACT_CATEGORIES: ActionCategory[] = ["KONTRAK", "KONTRAK_HONORER", "MAGANG", "PERCOBAAN", "LEPAS", "TETAP"];

export interface EmploymentActionDialogProps {
  employeeId: string;
  employeeName: string;
  actionType: EmploymentActionType | "PLACEMENT_END";
  /** The additional duty to end; only PLACEMENT_END uses it. */
  placementId?: string;
  onClose: () => void;
  onRecorded: (message: string) => void;
}

export interface DraftState {
  effectiveOn: string;
  lastDayOn: string;
  category: ActionCategory;
  termEndOn: string;
  staffType: "" | "PENDIDIK" | "KEPENDIDIKAN";
  contractReference: string;
  reasonCode: TerminationReason;
  careerReasonCode: CareerReasonCode | "";
  reasonNote: string;
  unitId: string;
  positionId: string;
  jobTitleLabel: string;
  /** ORG-011: empty means the seat's own classification applies. */
  jobClassificationCode: string;
  additionalDuty: boolean;
  documentId: string;
}

export function emptyDraft(): DraftState {
  return {
    effectiveOn: "",
    lastDayOn: "",
    category: "KONTRAK",
    termEndOn: "",
    staffType: "",
    contractReference: "",
    reasonCode: "KONTRAK_BERAKHIR",
    careerReasonCode: "",
    reasonNote: "",
    unitId: "",
    positionId: "",
    jobTitleLabel: "",
    jobClassificationCode: "",
    additionalDuty: false,
    documentId: "",
  };
}

export function buildRequest(
  actionType: EmploymentActionType | "PLACEMENT_END",
  draft: DraftState,
  acknowledged: boolean,
  warnings: EmploymentActionPreview["warnings"],
  placementId?: string,
): EmploymentActionRequest {
  const documentIds = draft.documentId ? [draft.documentId] : [];
  const shared = {
    reasonNote: draft.reasonNote.trim() ? draft.reasonNote.trim() : null,
    documentIds,
    acknowledgedWarnings: acknowledged ? warnings : [],
  };
  if (actionType === "PLACEMENT_END") {
    return {
      ...shared,
      actionType: "PLACEMENT_END",
      effectiveOn: draft.effectiveOn,
      placementId: placementId ?? "",
    };
  }
  switch (actionType) {
    case "HIRE":
      return {
        ...shared,
        actionType: "HIRE",
        effectiveOn: draft.effectiveOn,
        category: draft.category,
        termEndOn: draft.termEndOn || null,
        staffType: draft.staffType || null,
        contractReference: draft.contractReference.trim() || null,
        placement: {
          unitId: draft.unitId,
          jobTitleLabel: draft.jobTitleLabel.trim(),
          ...(draft.jobClassificationCode ? { jobClassificationCode: draft.jobClassificationCode } : {}),
        },
      };
    case "CONTRACT_EXTENSION":
      return {
        ...shared,
        actionType: "CONTRACT_EXTENSION",
        effectiveOn: draft.effectiveOn,
        termEndOn: draft.termEndOn,
        contractReference: draft.contractReference.trim() || null,
      };
    case "CATEGORY_CHANGE":
      return {
        ...shared,
        actionType: "CATEGORY_CHANGE",
        effectiveOn: draft.effectiveOn,
        category: draft.category,
        termEndOn: draft.termEndOn || null,
        contractReference: draft.contractReference.trim() || null,
      };
    case "TERMINATION":
      return { ...shared, actionType: "TERMINATION", lastDayOn: draft.lastDayOn, reasonCode: draft.reasonCode };
    case "PLACEMENT":
      return {
        ...shared,
        actionType: "PLACEMENT",
        effectiveOn: draft.effectiveOn,
        placement: {
          unitId: draft.unitId,
          jobTitleLabel: draft.jobTitleLabel.trim(),
          ...(draft.jobClassificationCode ? { jobClassificationCode: draft.jobClassificationCode } : {}),
          kind: draft.additionalDuty ? "ADDITIONAL" : "PRIMARY",
        },
      };
    case "TRANSFER":
    case "PROMOTION":
    case "DEMOTION":
      return {
        ...shared,
        actionType,
        effectiveOn: draft.effectiveOn,
        placement: {
          unitId: draft.unitId,
          positionId: draft.positionId || null,
          jobTitleLabel: draft.jobTitleLabel.trim(),
          ...(draft.jobClassificationCode ? { jobClassificationCode: draft.jobClassificationCode } : {}),
        },
        reasonCode: draft.careerReasonCode || null,
      };
  }
}

/** Career moves and a new employment all need a destination unit. */
const PLACEMENT_ACTIONS: readonly EmploymentActionType[] = ["HIRE", "PLACEMENT", "TRANSFER", "PROMOTION", "DEMOTION"];

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function summaryLine(snapshot: Record<string, unknown>): string {
  const category = typeof snapshot.category === "string" ? CATEGORY_LABEL[snapshot.category as never] ?? snapshot.category : null;
  const from = typeof snapshot.termFrom === "string" ? formatDate(snapshot.termFrom) : null;
  const to = typeof snapshot.termTo === "string" ? formatDate(snapshot.termTo) : null;
  const ended = typeof snapshot.endedOn === "string" ? `berakhir ${formatDate(snapshot.endedOn)}` : null;
  const placement =
    snapshot.placement && typeof snapshot.placement === "object"
      ? (snapshot.placement as { jobTitleLabel?: string }).jobTitleLabel ?? null
      : null;
  const parts = [category, from || to ? `${from ?? "—"} – ${to ?? "—"}` : null, placement, ended].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}

export function EmploymentActionDialog({
  employeeId,
  employeeName,
  actionType,
  placementId,
  onClose,
  onRecorded,
}: EmploymentActionDialogProps) {
  const [units, setUnits] = useState<Array<{ id: string; name: string }>>([]);
  const [positions, setPositions] = useState<Array<{ id: string; name: string }>>([]);
  // ORG-011: empty when this account cannot read the catalog, which is ordinary —
  // employment.manage does not carry job_classifications.read. The field is then not offered
  // and the placement simply inherits the seat's own classification.
  const [classifications, setClassifications] = useState<JobClassification[]>([]);
  const [classificationsTruncated, setClassificationsTruncated] = useState(false);
  const [classificationsFailed, setClassificationsFailed] = useState(false);
  const [draft, setDraft] = useState<DraftState>(emptyDraft);
  const [documents, setDocuments] = useState<DecisionDocument[]>([]);
  const [preview, setPreview] = useState<EmploymentActionPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(newIdempotencyKey);

  // ORG-011: read as of the day this action takes effect, because that is the date the API
  // validates the code against.
  useEffect(() => {
    if (actionType === "PLACEMENT_END" || !PLACEMENT_ACTIONS.includes(actionType)) return;
    if (!draft.effectiveOn) return;
    let mounted = true;
    void listJobClassifications({ onDate: draft.effectiveOn, pageSize: 100 })
      .then((result) => {
        if (!mounted) return;
        setClassifications(result.classifications);
        setClassificationsTruncated(result.pagination.total > result.classifications.length);
        setClassificationsFailed(false);
        // A code chosen for an earlier date may not be in force on the new one. Clearing it is
        // the honest move: the select would show "ikut kursi" while the draft still carried
        // the old code, and the save would fail with a 400 nobody could explain.
        setDraft((current) => (current.jobClassificationCode
          && !result.classifications.some((item) => item.code === current.jobClassificationCode)
          ? { ...current, jobClassificationCode: "" }
          : current));
      })
      .catch((cause: unknown) => {
        if (!mounted) return;
        setClassifications([]);
        setClassificationsTruncated(false);
        // 403 is ordinary: employment.manage does not carry job_classifications.read, so the
        // field is simply not offered. Anything else is a real failure worth naming.
        setClassificationsFailed(!(cause instanceof AdminApiError && cause.status === 403));
      });
    return () => { mounted = false; };
  }, [actionType, draft.effectiveOn]);

  // Every action that opens a placement needs a unit to point at.
  useEffect(() => {
    if (actionType === "PLACEMENT_END" || !PLACEMENT_ACTIONS.includes(actionType)) return;
    let mounted = true;
    void listEmployees({ pageSize: 1 })
      .then((page) => {
        if (!mounted) return;
        setUnits(page.filters.units);
        setPositions(page.filters.positions);
      })
      .catch(() => {
        if (!mounted) return;
        setUnits([]);
        setPositions([]);
      });
    return () => {
      mounted = false;
    };
  }, [actionType]);

  const requirement = useMemo(
    () =>
      actionType === "PLACEMENT_END"
        ? null
        : requiredDocumentKind(actionType, actionType === "TERMINATION" ? null : draft.category, draft.reasonCode),
    [actionType, draft.category, draft.reasonCode],
  );

  useEffect(() => {
    if (!requirement) {
      setDocuments([]);
      return;
    }
    let mounted = true;
    void listDecisionDocuments({
      kind: requirement.kind,
      pageSize: 50,
      ...(requirement.skType ? { skType: requirement.skType as never } : {}),
    })
      .then((page) => { if (mounted) setDocuments(page.rows); })
      .catch(() => { if (mounted) setDocuments([]); });
    return () => {
      mounted = false;
    };
  }, [requirement?.kind, requirement?.skType]);

  const set = (patch: Partial<DraftState>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setPreview(null);
    setAcknowledged(false);
  };

  function failureMessage(cause: unknown): string {
    if (cause instanceof EmploymentApiError) return cause.message;
    return "Tindakan tidak dapat diproses. Periksa koneksi lalu coba lagi.";
  }

  async function check(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setPreview(await previewEmploymentAction(employeeId, buildRequest(actionType, draft, false, [], placementId)));
    } catch (cause) {
      setPreview(null);
      setError(failureMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await recordEmploymentAction(
        employeeId,
        buildRequest(actionType, draft, acknowledged, preview.warnings, placementId),
        idempotencyKey,
      );
      const when = preview.effectiveOn ? ` dan berlaku mulai ${formatDate(preview.effectiveOn)}` : "";
      const what = actionType === "PLACEMENT_END" ? "Tugas tambahan diakhiri" : ACTION_DONE_MESSAGE[actionType];
      onRecorded(`${what}${when}.`);
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const needsAcknowledgement = (preview?.warnings.length ?? 0) > 0;
  const title = actionType === "PLACEMENT_END" ? "Akhiri tugas tambahan" : ACTION_TITLE[actionType];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${title} — ${employeeName}`}
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)] sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-brand-heading">{title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{employeeName}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Tutup" className="rounded-xl border border-border p-2 hover:bg-surface">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {error ? (
          <p role="alert" className="mt-4 rounded-xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink">{error}</p>
        ) : null}

        <form onSubmit={check} className="mt-4 grid gap-3 sm:grid-cols-2">
          {actionType === "PLACEMENT_END" ? (
            <Labelled label="Berlaku mulai">
              <input type="date" value={draft.effectiveOn} onChange={(event) => set({ effectiveOn: event.target.value })} className={field} />
            </Labelled>
          ) : actionType === "TERMINATION" ? (
            <>
              <Labelled label="Tanggal terakhir bekerja">
                <input type="date" value={draft.lastDayOn} onChange={(event) => set({ lastDayOn: event.target.value })} className={field} />
              </Labelled>
              <Labelled label="Alasan">
                <select
                  value={draft.reasonCode}
                  onChange={(event) => set({ reasonCode: event.target.value as TerminationReason })}
                  className={field}
                >
                  {Object.entries(TERMINATION_REASON_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </Labelled>
            </>
          ) : (
            <Labelled label="Tanggal berlaku">
              <input type="date" value={draft.effectiveOn} onChange={(event) => set({ effectiveOn: event.target.value })} className={field} />
            </Labelled>
          )}

          {actionType !== "PLACEMENT_END" && (actionType === "HIRE" || actionType === "CATEGORY_CHANGE") ? (
            <Labelled label="Status kepegawaian">
              <select value={draft.category} onChange={(event) => set({ category: event.target.value as ActionCategory })} className={field}>
                {CONTRACT_CATEGORIES.map((category) => (
                  <option key={category} value={category}>{CATEGORY_LABEL[category]}</option>
                ))}
              </select>
            </Labelled>
          ) : null}

          {actionType !== "TERMINATION" && actionType !== "PLACEMENT_END" && actionType !== "PLACEMENT"
            && actionType !== "TRANSFER" && actionType !== "PROMOTION" && actionType !== "DEMOTION"
            && draft.category !== "TETAP" ? (
            <Labelled label="Kontrak selesai">
              <input type="date" value={draft.termEndOn} onChange={(event) => set({ termEndOn: event.target.value })} className={field} />
            </Labelled>
          ) : null}

          {actionType !== "PLACEMENT_END" && PLACEMENT_ACTIONS.includes(actionType) ? (
            <>
              <Labelled label={actionType === "HIRE" || actionType === "PLACEMENT" ? "Unit penempatan" : "Unit tujuan"}>
                <select value={draft.unitId} onChange={(event) => set({ unitId: event.target.value })} className={field}>
                  <option value="">Pilih unit</option>
                  {units.map((unit) => (
                    <option key={unit.id} value={unit.id}>{unit.name}</option>
                  ))}
                </select>
              </Labelled>
              <Labelled label="Jabatan">
                <select value={draft.positionId} onChange={(event) => set({ positionId: event.target.value })} className={field}>
                  <option value="">Tanpa jabatan terdaftar</option>
                  {positions.map((position) => (
                    <option key={position.id} value={position.id}>{position.name}</option>
                  ))}
                </select>
              </Labelled>
              <Labelled label="Label jabatan">
                <input value={draft.jobTitleLabel} onChange={(event) => set({ jobTitleLabel: event.target.value })} className={field} />
              </Labelled>
              {classifications.length > 0 ? (
                <Labelled label="Klasifikasi jabatan">
                  <select value={draft.jobClassificationCode} onChange={(event) => set({ jobClassificationCode: event.target.value })} className={field}>
                    <option value="">Ikut klasifikasi kursi jabatan</option>
                    {classifications.map((item) => (
                      <option key={item.code} value={item.code}>{item.name} ({jobFamilyLabels[item.family]})</option>
                    ))}
                  </select>
                  {classificationsTruncated ? (
                    <p className="mt-1 text-[11px] text-warning-ink">Daftar dipotong pada 100 klasifikasi pertama. Buka Klasifikasi Jabatan bila kode yang dicari tidak ada.</p>
                  ) : null}
                </Labelled>
              ) : null}
              {classificationsFailed ? (
                <p className="text-[11px] font-bold text-warning-ink">Daftar klasifikasi jabatan tidak dapat dimuat. Tindakan tetap bisa direkam; penempatan akan mengikuti klasifikasi kursi jabatan.</p>
              ) : null}
            </>
          ) : null}

          {actionType === "PLACEMENT" ? (
            <label className="flex items-center gap-2 self-end text-sm font-semibold text-foreground">
              <input
                type="checkbox"
                checked={draft.additionalDuty}
                onChange={(event) => set({ additionalDuty: event.target.checked })}
              />
              Tugas tambahan (penempatan utama tetap)
            </label>
          ) : null}

          {actionType === "TRANSFER" || actionType === "PROMOTION" || actionType === "DEMOTION" ? (
            <Labelled label={actionType === "DEMOTION" ? "Alasan (wajib)" : "Alasan"}>
              <select
                value={draft.careerReasonCode}
                onChange={(event) => set({ careerReasonCode: event.target.value as CareerReasonCode })}
                className={field}
              >
                <option value="">Pilih alasan</option>
                {Object.entries(CAREER_REASON_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </Labelled>
          ) : null}

          {actionType === "HIRE" ? (
            <>
              <Labelled label="Jenis kepegawaian">
                <select
                  value={draft.staffType}
                  onChange={(event) => set({ staffType: event.target.value as DraftState["staffType"] })}
                  className={field}
                >
                  <option value="">Belum ditentukan</option>
                  <option value="PENDIDIK">Tenaga Pendidik</option>
                  <option value="KEPENDIDIKAN">Tenaga Kependidikan</option>
                </select>
              </Labelled>
            </>
          ) : null}

          {requirement ? (
            <div className="sm:col-span-2">
              <Labelled label={requirement.kind === "PERJANJIAN_KERJA" ? "Perjanjian Kerja" : "Surat Keputusan"}>
                <select value={draft.documentId} onChange={(event) => set({ documentId: event.target.value })} className={field}>
                  <option value="">Pilih dokumen dasar</option>
                  {documents.map((document) => (
                    <option key={document.id} value={document.id}>
                      {document.documentNumber} · {formatDate(document.signedOn)}
                      {document.subject ? ` · ${document.subject}` : ""}
                    </option>
                  ))}
                </select>
              </Labelled>
              <p className="mt-1 text-xs text-muted-foreground">
                {requirement.hint} Dokumen dicatat di menu Pegawai → Perjanjian Kerja &amp; SK.
              </p>
            </div>
          ) : null}

          <div className="sm:col-span-2">
            <Labelled label="Catatan (opsional; wajib untuk tindakan yang berlaku mundur)">
              <input value={draft.reasonNote} onChange={(event) => set({ reasonNote: event.target.value })} className={field} />
            </Labelled>
          </div>

          <div className="sm:col-span-2 flex flex-wrap gap-2">
            <button type="submit" className={quietButton} disabled={busy}>
              {busy && !preview ? <Loader2 className="mr-1 inline h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Periksa
            </button>
            <button type="button" className={quietButton} onClick={onClose}>Batal</button>
          </div>
        </form>

        {preview ? (
          <section className="mt-5 rounded-2xl border border-border/70 bg-surface p-4" aria-label="Ringkasan tindakan">
            <h3 className="text-sm font-bold text-brand-heading">Dari → Menjadi</h3>
            <dl className="mt-2 grid gap-2 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-semibold text-muted-foreground">Dari</dt>
                <dd className="text-sm font-semibold text-foreground">{summaryLine(preview.previous)}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold text-muted-foreground">Menjadi</dt>
                <dd className="text-sm font-semibold text-foreground">{summaryLine(preview.next)}</dd>
              </div>
            </dl>

            {preview.structureNote ? (
              <p className="mt-3 rounded-xl border border-border/70 bg-surface-raised p-3 text-sm text-muted-foreground">
                {preview.structureNote}
              </p>
            ) : null}

            {preview.accountDeactivation.willDeactivate ? (
              <p className="mt-3 rounded-xl border border-warning-line bg-warning-soft p-3 text-sm text-warning-ink">
                Akun login HCIS pegawai ini akan dinonaktifkan otomatis mulai {formatDate(preview.accountDeactivation.onDate)}.
                Akses sementara hanya dapat diberikan oleh admin dengan batas waktu.
              </p>
            ) : null}

            {needsAcknowledgement ? (
              <div className="mt-3 rounded-xl border border-warning-line bg-warning-soft p-3 text-sm text-warning-ink">
                <ul className="list-disc space-y-1 pl-5">
                  {preview.warnings.map((warning) => (
                    <li key={warning}>
                      <AlertTriangle className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                      {WARNING_LABEL[warning] ?? warning}
                    </li>
                  ))}
                </ul>
                <label className="mt-2 flex items-center gap-2 font-semibold">
                  <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                  Saya sudah memeriksa
                </label>
              </div>
            ) : null}

            <button
              type="button"
              className={`${primaryButton} mt-4`}
              disabled={busy || (needsAcknowledgement && !acknowledged)}
              onClick={() => void save()}
            >
              {busy ? <Loader2 className="mr-1 inline h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Simpan
            </button>
          </section>
        ) : null}
      </div>
    </div>
  );
}
