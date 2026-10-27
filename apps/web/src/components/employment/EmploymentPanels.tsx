// EMP-005 / EMP-006 S3 read screens (spec §13.1, §13.2, §13.6). Presentational
// only: each panel renders one explicit view state, and every state, flag, and
// issue comes from the API. Action buttons arrive with S5/S6.

import { AlertTriangle, BriefcaseBusiness, FileText, History, Info, Lock } from "lucide-react";
import type { ReactNode } from "react";

import {
  ACTION_LABEL,
  CATEGORY_LABEL,
  END_REASON_LABEL,
  FIELD_LABEL,
  FLAG_LABEL,
  ISSUE_LABEL,
  STATE_LABEL,
  formatDate,
  serviceLength,
  type EmploymentConsistencyReport,
  type EmploymentSummary,
  type EmploymentTimelineItem,
  type EmploymentView,
  type Placement,
} from "@/lib/employment";

const card = "rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]";

function Notice({ tone, children }: { tone: "info" | "warning" | "danger"; children: ReactNode }) {
  const tones = {
    info: "border-border/70 bg-surface text-muted-foreground",
    warning: "border-warning-line bg-warning-soft text-warning-ink",
    danger: "border-danger-line bg-danger-soft text-danger-ink",
  } as const;
  return <div role={tone === "danger" ? "alert" : "status"} className={`rounded-2xl border p-4 text-sm leading-6 ${tones[tone]}`}>{children}</div>;
}

/**
 * EMP-005 S5B: the contract actions an operator may start from this tab. The
 * buttons appear only in AUTHORITATIVE and only for employment.manage; the API
 * refuses anything the rollout mode or the permission does not allow anyway.
 */
type ActionKey =
  | "HIRE"
  | "CONTRACT_EXTENSION"
  | "CATEGORY_CHANGE"
  | "TERMINATION"
  | "PLACEMENT"
  | "TRANSFER"
  | "PROMOTION"
  | "DEMOTION";

export interface EmploymentActionButtonsProps {
  mode: string;
  state: string;
  canManage: boolean;
  /** "contract" for the Kepegawaian tab, "career" for Penempatan & Karier. */
  group?: "contract" | "career";
  /** A career move needs a primary placement to move; a placement opens one. */
  hasPrimaryPlacement?: boolean;
  onStart: (actionType: ActionKey) => void;
}

export function EmploymentActionButtons({
  mode,
  state,
  canManage,
  group = "contract",
  hasPrimaryPlacement = false,
  onStart,
}: EmploymentActionButtonsProps) {
  if (!canManage || mode !== "AUTHORITATIVE") return null;
  const active = state === "AKTIF" || state === "AKAN_MULAI";
  let buttons: Array<{ key: ActionKey; label: string }>;
  if (group === "career") {
    // Without an employment there is nothing to place; without a primary
    // placement the career moves have nothing to move (the API says the same).
    if (!active) return null;
    buttons = hasPrimaryPlacement
      ? [
          { key: "PLACEMENT", label: "Penempatan" },
          { key: "TRANSFER", label: "Mutasi" },
          { key: "PROMOTION", label: "Promosi" },
          { key: "DEMOTION", label: "Demosi" },
        ]
      : [{ key: "PLACEMENT", label: "Penempatan" }];
  } else {
    buttons = active
      ? [
          { key: "CONTRACT_EXTENSION", label: "Perpanjang kontrak" },
          { key: "CATEGORY_CHANGE", label: "Ubah status kepegawaian" },
          { key: "TERMINATION", label: "Akhiri hubungan kerja" },
        ]
      : [{ key: "HIRE", label: "Mulai hubungan kerja baru" }];
  }
  return (
    <div className="flex flex-wrap gap-2">
      {buttons.map((button) => (
        <button
          key={button.key}
          type="button"
          onClick={() => onStart(button.key)}
          className="h-10 rounded-xl border border-border px-4 text-sm font-semibold text-foreground hover:bg-surface"
        >
          {button.label}
        </button>
      ))}
    </div>
  );
}

/** Shared non-ready states; returns null when the view is ready. */
export function EmploymentStateNotice({ view, subject }: { view: EmploymentView<unknown>; subject: string }) {
  switch (view.kind) {
    case "loading":
      return <Notice tone="info">Memuat {subject}...</Notice>;
    case "disabled":
      return (
        <Notice tone="info">
          Riwayat kepegawaian belum diaktifkan. Data awal akan dibuat oleh petugas HC saat fitur diaktifkan.
        </Notice>
      );
    case "forbidden":
      return (
        <Notice tone="warning">
          <Lock className="mr-1 inline h-4 w-4" aria-hidden="true" />
          Akun ini tidak memiliki izin melihat riwayat kepegawaian. Minta pengelola akses meninjau role akun ini.
        </Notice>
      );
    case "error":
      return <Notice tone="danger">{view.message}</Notice>;
    case "ready":
      return null;
  }
}

function ShadowBanner({ mode }: { mode: string }) {
  if (mode !== "SHADOW") return null;
  return (
    <Notice tone="info">
      <Info className="mr-1 inline h-4 w-4" aria-hidden="true" />
      Mode tinjauan: data hanya dapat dibaca. Tindakan kepegawaian (perpanjang kontrak, mutasi, promosi, dan lainnya) belum dapat dicatat.
    </Notice>
  );
}

function Badge({ tone, children }: { tone: "neutral" | "warning" | "success" | "danger"; children: ReactNode }) {
  const tones = {
    neutral: "bg-surface text-muted-foreground border-border/70",
    warning: "bg-warning-soft text-warning-ink border-warning-line",
    success: "bg-success-soft text-success-ink border-success-line",
    danger: "bg-danger-soft text-danger-ink border-danger-line",
  } as const;
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-bold ${tones[tone]}`}>{children}</span>;
}

function stateTone(state: EmploymentSummary["state"]) {
  return state === "AKTIF" ? "success" : state === "BERAKHIR" ? "danger" : "neutral";
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-semibold text-foreground">{value}</dd>
    </div>
  );
}

/** Tab "Kepegawaian & Kontrak" (spec §13.1). */
export function EmploymentContractPanel({
  view,
  actions,
}: {
  view: EmploymentView<EmploymentSummary>;
  /** S5B action buttons; omitted on screens that only read. */
  actions?: ReactNode;
}) {
  if (view.kind !== "ready") return <EmploymentStateNotice view={view} subject="data kepegawaian" />;
  const data = view.data;
  if (data.state === "TANPA_DATA") {
    return (
      <div className="space-y-4">
        <ShadowBanner mode={data.mode} />
        <Notice tone="info">Belum ada data kepegawaian. Data awal akan dibuat oleh petugas HC saat fitur diaktifkan.</Notice>
        {actions}
      </div>
    );
  }
  const { employment, term } = data.current;
  const latest = data.employments[0];
  const showTerm = term ?? latest?.terms[0] ?? null;
  const tenure = serviceLength(employment?.serviceStartOn ?? latest?.serviceStartOn ?? null, data.date);

  return (
    <div className="space-y-4">
      <ShadowBanner mode={data.mode} />
      <article className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <BriefcaseBusiness className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
            <h2 className="text-base font-bold text-brand-heading">Kepegawaian & Kontrak</h2>
          </div>
          <Badge tone={stateTone(data.state)}>{STATE_LABEL[data.state]}</Badge>
        </div>
        {actions ? <div className="mt-4">{actions}</div> : null}
        {data.flags.length ? (
          <ul className="mt-4 flex flex-wrap gap-2" aria-label="Peringatan kepegawaian">
            {data.flags.map((flag) => (
              <li key={flag}>
                <Badge tone="warning">
                  <AlertTriangle className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  {FLAG_LABEL[flag] ?? flag}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
        <dl className="mt-5 grid gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            label="Status kepegawaian"
            value={showTerm ? `${CATEGORY_LABEL[showTerm.category]}${showTerm.sequence > 1 ? ` (ke-${showTerm.sequence})` : ""}` : "—"}
          />
          <Field
            label="Masa kontrak"
            value={showTerm ? `${formatDate(showTerm.effectiveFrom, "Belum diketahui")} – ${formatDate(showTerm.effectiveTo, showTerm.category === "TETAP" ? "tanpa batas" : "belum diketahui")}` : "—"}
          />
          <Field label="TMT" value={formatDate(latest?.startedOn, "Belum diketahui")} />
          <Field label="Masa kerja" value={tenure ?? "—"} />
          <Field label="Jenis kepegawaian" value={latest?.staffType === "PENDIDIK" ? "Tenaga Pendidik" : latest?.staffType === "KEPENDIDIKAN" ? "Tenaga Kependidikan" : "—"} />
          {latest?.endBasis ? (
            <Field
              label="Berakhir"
              value={`${latest.endBasis === "UNKNOWN" ? "Tanggal belum diketahui" : formatDate(latest.endedOn)}${latest.endPrecision === "MONTH" ? " (bulan)" : ""} · ${END_REASON_LABEL[latest.endReason ?? ""] ?? latest.endReason ?? "—"}`}
            />
          ) : null}
        </dl>
      </article>

      <article className={card}>
        <div className="flex items-center gap-3">
          <FileText className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
          <h3 className="text-sm font-bold text-brand-heading">Riwayat kontrak</h3>
        </div>
        <div className="mt-4 space-y-2">
          {data.employments.flatMap((item) => item.terms.map((entry) => ({ entry, employment: item }))).map(({ entry, employment: owner }) => (
            <div key={entry.id} className="grid gap-2 rounded-xl border border-border/70 bg-surface p-3 text-sm sm:grid-cols-[3rem_1fr_1fr_1fr_1fr] sm:items-center">
              <span className="text-xs font-bold text-muted-foreground">Ke-{entry.sequence}</span>
              <span className="font-semibold">{CATEGORY_LABEL[entry.category]}</span>
              <span><span className="text-xs text-muted-foreground sm:hidden">Mulai </span>{formatDate(entry.effectiveFrom, "Belum diketahui")}</span>
              <span><span className="text-xs text-muted-foreground sm:hidden">Selesai </span>{formatDate(entry.effectiveTo, entry.category === "TETAP" ? "—" : owner.endBasis ? "—" : "Belum diketahui")}</span>
              <span className="text-xs text-muted-foreground">{entry.contractReference ?? "No. perjanjian belum dicatat"}</span>
            </div>
          ))}
        </div>
      </article>
    </div>
  );
}

function placementLine(placement: Placement): string {
  const where = [placement.unitName, placement.positionName && placement.positionName !== placement.jobTitleLabel ? placement.positionName : null]
    .filter(Boolean)
    .join(" · ");
  return where ? `${placement.jobTitleLabel} — ${where}` : placement.jobTitleLabel;
}

function sinceLabel(placement: Placement): string {
  return placement.effectiveFromBasis === "BASELINE_ASSUMED" ? "sejak data awal" : `sejak ${formatDate(placement.effectiveFrom)}`;
}

function snapshotTitle(snapshot: Record<string, unknown>): string | null {
  const placement = snapshot.placement as { jobTitleLabel?: string } | null | undefined;
  return placement?.jobTitleLabel ?? null;
}

function timelineSentence(item: EmploymentTimelineItem): string {
  if (item.actionType === "BASELINE") {
    const title = snapshotTitle(item.newSnapshot);
    return `Data awal dari master pegawai${title ? ` · ${title}` : ""}. Riwayat sebelum data awal tidak tercatat.`;
  }
  const from = snapshotTitle(item.previousSnapshot);
  const to = snapshotTitle(item.newSnapshot);
  if (from || to) return `${from ?? "—"} → ${to ?? "—"}`;
  const category = item.newSnapshot.category as keyof typeof CATEGORY_LABEL | undefined;
  return category ? CATEGORY_LABEL[category] ?? category : "";
}

/** Tab "Penempatan & Karier" (spec §13.2). */
export function PlacementCareerPanel({
  view,
  timeline,
  actions,
  onEndAdditional,
}: {
  view: EmploymentView<EmploymentSummary>;
  timeline: EmploymentView<EmploymentTimelineItem[]>;
  /** S6 career buttons; omitted on screens that only read. */
  actions?: ReactNode;
  /** S6: end one additional duty; omitted where the operator may not record. */
  onEndAdditional?: (placementId: string) => void;
}) {
  if (view.kind !== "ready") return <EmploymentStateNotice view={view} subject="data penempatan" />;
  const data = view.data;
  const primary = data.current.primaryPlacement;
  const history = data.employments.flatMap((employment) => employment.placements);

  return (
    <div className="space-y-4">
      <ShadowBanner mode={data.mode} />
      <article className={card}>
        <div className="flex items-center gap-3">
          <BriefcaseBusiness className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
          <h2 className="text-base font-bold text-brand-heading">Penempatan saat ini</h2>
        </div>
        {actions ? <div className="mt-4">{actions}</div> : null}
        {primary ? (
          <dl className="mt-5 grid gap-x-5 gap-y-4 sm:grid-cols-3">
            <Field label="Unit" value={primary.unitName ?? "—"} />
            <Field label="Jabatan" value={primary.jobTitleLabel} />
            <Field label="Berlaku" value={sinceLabel(primary)} />
          </dl>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            {data.state === "AKTIF" ? "Belum ada penempatan utama." : "Tidak ada penempatan yang berlaku pada tanggal ini."}
          </p>
        )}
        {data.current.additionalPlacements.length ? (
          <div className="mt-5">
            <p className="text-xs font-semibold text-muted-foreground">Tugas tambahan</p>
            <ul className="mt-2 space-y-1 text-sm">
              {data.current.additionalPlacements.map((placement) => (
                <li key={placement.id} className="flex flex-wrap items-center gap-2">
                  <span>{placementLine(placement)} · {sinceLabel(placement)}</span>
                  {onEndAdditional ? (
                    <button
                      type="button"
                      onClick={() => onEndAdditional(placement.id)}
                      className="text-xs font-bold text-brand-primary"
                    >
                      Akhiri tugas tambahan
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </article>

      <article className={card}>
        <div className="flex items-center gap-3">
          <History className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
          <h3 className="text-sm font-bold text-brand-heading">Riwayat jabatan</h3>
        </div>
        {timeline.kind !== "ready" ? (
          <div className="mt-4"><EmploymentStateNotice view={timeline} subject="riwayat jabatan" /></div>
        ) : timeline.data.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">Belum ada tindakan kepegawaian yang tercatat.</p>
        ) : (
          <ol className="mt-4 space-y-3 border-l-2 border-border/70 pl-4">
            {timeline.data.map((item) => {
              const reversed = item.state === "REVERSED";
              const future = item.effectiveOn !== null && item.effectiveOn > data.date;
              return (
                <li key={item.id} className="relative">
                  <span className="absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full bg-brand-primary" aria-hidden="true" />
                  <p className={`text-sm font-bold ${reversed ? "line-through text-muted-foreground" : "text-foreground"}`}>
                    {ACTION_LABEL[item.actionType] ?? item.actionType}
                    {item.effectiveOn ? ` · ${formatDate(item.effectiveOn)}` : ""}
                    {future ? <span className="ml-2"><Badge tone="neutral">Terjadwal</Badge></span> : null}
                  </p>
                  <p className={`mt-0.5 text-sm ${reversed ? "line-through text-muted-foreground" : "text-foreground"}`}>{timelineSentence(item)}</p>
                  {item.documents.length ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Dasar: {item.documents.map((document) => `${document.kind === "PERJANJIAN_KERJA" ? "Perjanjian Kerja" : "SK"} No. ${document.number}`).join(", ")}
                    </p>
                  ) : null}
                  {reversed ? <p className="mt-0.5 text-xs text-muted-foreground">Dibatalkan</p> : null}
                </li>
              );
            })}
          </ol>
        )}
      </article>

      {history.length > 1 ? (
        <article className={card}>
          <h3 className="text-sm font-bold text-brand-heading">Semua penempatan</h3>
          <ul className="mt-3 space-y-2 text-sm">
            {history.map((placement) => (
              <li key={placement.id} className="rounded-xl border border-border/70 bg-surface p-3">
                <span className="font-semibold">{placementLine(placement)}</span>
                <span className="block text-xs text-muted-foreground">
                  {placement.kind === "ADDITIONAL" ? "Tugas tambahan · " : ""}
                  {sinceLabel(placement)}{placement.effectiveTo ? ` s.d. ${formatDate(placement.effectiveTo)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </article>
      ) : null}
    </div>
  );
}

/** Menu "Periksa kecocokan data" (spec §13.6). */
export function ConsistencyReportView({
  view,
  selectedCode,
  codeHref,
  employeeHref,
}: {
  view: EmploymentView<EmploymentConsistencyReport>;
  selectedCode: string | null;
  codeHref: (code: string | null) => string;
  employeeHref: (employeeId: string) => string;
}) {
  if (view.kind !== "ready") return <EmploymentStateNotice view={view} subject="laporan kecocokan data" />;
  const report = view.data;
  return (
    <div className="space-y-4">
      <ShadowBanner mode={report.mode} />
      <section className={card} aria-label="Ringkasan masalah">
        <p className="text-sm text-muted-foreground">
          {report.employeeCount} pegawai diperiksa per {formatDate(report.date)}. Pilih kelompok untuk melihat pegawainya.
        </p>
        {report.groups.length === 0 ? (
          <p className="mt-4 text-sm font-semibold text-success-ink">Tidak ada masalah ditemukan.</p>
        ) : (
          <ul className="mt-4 flex flex-wrap gap-2">
            <li>
              <a href={codeHref(null)} aria-current={selectedCode === null ? "true" : undefined}
                className={`inline-flex rounded-full border px-3 py-1.5 text-xs font-bold ${selectedCode === null ? "border-brand-primary bg-brand-primary-pale text-brand-primary-deep" : "border-border/70 bg-surface"}`}>
                Semua masalah
              </a>
            </li>
            {report.groups.map((group) => (
              <li key={group.code}>
                <a href={codeHref(group.code)} aria-current={selectedCode === group.code ? "true" : undefined}
                  className={`inline-flex rounded-full border px-3 py-1.5 text-xs font-bold ${selectedCode === group.code ? "border-brand-primary bg-brand-primary-pale text-brand-primary-deep" : "border-border/70 bg-surface"}`}>
                  {ISSUE_LABEL[group.code] ?? group.code} · {group.count}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {report.groups.length ? (
        <section className={card} aria-label="Daftar pegawai">
          {report.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tidak ada pegawai pada kelompok ini.</p>
          ) : (
            <ul className="space-y-2">
              {report.rows.map((row) => (
                <li key={row.employeeId} className="grid gap-2 rounded-xl border border-border/70 bg-surface p-3 text-sm md:grid-cols-[10rem_1fr_2fr] md:items-start">
                  <span className="font-mono text-xs text-muted-foreground">{row.employeeNumber ?? "—"}</span>
                  <a href={employeeHref(row.employeeId)} className="font-semibold text-brand-primary-deep">{row.fullName ?? "Pegawai"}</a>
                  <span className="flex flex-wrap gap-1.5">
                    {row.codes.map((code) => <Badge key={code} tone="warning">{ISSUE_LABEL[code] ?? code}</Badge>)}
                    {row.differingFields.length ? (
                      <span className="w-full text-xs text-muted-foreground">
                        Berbeda: {row.differingFields.map((field) => FIELD_LABEL[field] ?? field).join(", ")}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
