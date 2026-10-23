// ORG-008-2b: the read-only tabs of Struktur Organisasi — Kesiapan, Pegawai, Plt & jabatan kosong,
// and Cek persetujuan. All four present data the server computed with the ORG-004 resolver; none of
// them changes structure, publishes anything, or touches rollout.
//
// They are presentational on purpose: the page owns loading and state, so each tab can be rendered
// in a test without a network.

import { AlertTriangle, CheckCircle2, ChevronRight, Info, LoaderCircle, Search } from "lucide-react";
import type { ReactNode } from "react";

import type { OrganizationPosition } from "@/lib/organizationDesigner";
import {
  organizationComparisonLabel,
  organizationExplanationSentence,
  organizationIssueSentence,
  organizationSourceLabel,
  organizationVacancyPolicyLabel,
  organizationWarningSentence,
} from "@/lib/organizationLanguage";
import type {
  OrganizationApprovalPreview,
  OrganizationExplanation,
  OrganizationPeoplePage,
  OrganizationPerson,
  OrganizationPreviewWorkflow,
  OrganizationReadiness,
} from "@/lib/organizationReadModel";
import { cn } from "@/lib/utils";

const inputClass =
  "h-11 w-full rounded-xl border border-border bg-surface-raised px-3 text-sm outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/10";

function Panel({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
      <h2 className="text-base font-bold text-brand-heading">{title}</h2>
      {description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function LoadingRow({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> {label}
    </p>
  );
}

function ErrorRow({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex-1">{message}</span>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="h-9 rounded-xl border border-danger-line px-3 text-xs font-bold">
          Coba lagi
        </button>
      ) : null}
    </div>
  );
}

function IssueLine({
  tone,
  count,
  label,
  actionLabel,
  onAction,
}: {
  tone: "warning" | "info" | "success";
  count: number | null;
  label: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 text-sm",
        tone === "warning"
          ? "border-warning-line bg-warning-soft text-warning-ink"
          : tone === "success"
            ? "border-success-line bg-success-soft text-success-ink"
            : "border-info-line bg-info-soft text-info-ink",
      )}
    >
      {tone === "warning" ? <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        : tone === "success" ? <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          : <Info className="h-4 w-4 shrink-0" aria-hidden="true" />}
      <span className="flex-1">
        {count === null ? label : <><span className="font-bold">{count}</span> {label}</>}
      </span>
      {actionLabel && onAction ? (
        <button type="button" onClick={onAction} className="h-9 rounded-xl border border-current/30 px-3 text-xs font-bold">
          {actionLabel}
        </button>
      ) : null}
    </li>
  );
}

export function OrganizationReadinessTab({
  readiness,
  loading,
  error,
  onRetry,
  onOpenIssue,
  onOpenActing,
}: {
  readiness: OrganizationReadiness | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpenIssue: (issue: string) => void;
  onOpenActing: () => void;
}) {
  if (error) return <Panel title="Kesiapan"><ErrorRow message={error} onRetry={onRetry} /></Panel>;
  if (loading || !readiness) return <Panel title="Kesiapan"><LoadingRow label="Menghitung kesiapan..." /></Panel>;

  const nothingToFix = readiness.withoutUnit === 0
    && readiness.unresolvedManager === 0
    && readiness.vacantRequiringActing === 0
    && readiness.ineligibleManagers === 0;

  return (
    <div className="space-y-5">
      <Panel
        title="Perlu dibereskan"
        description={`Dihitung untuk tanggal ${readiness.asOf} atas ${readiness.activeEmployees} pegawai aktif.`}
      >
        <ul className="space-y-2">
          {nothingToFix ? (
            <IssueLine tone="success" count={null} label="Tidak ada yang perlu dibereskan pada tanggal ini." />
          ) : null}
          {readiness.withoutUnit > 0 ? (
            <IssueLine
              tone="warning"
              count={readiness.withoutUnit}
              label="pegawai aktif belum punya unit"
              actionLabel="Lihat"
              onAction={() => onOpenIssue("NO_UNIT")}
            />
          ) : null}
          {readiness.unresolvedManager > 0 ? (
            <IssueLine
              tone="warning"
              count={readiness.unresolvedManager}
              label="pegawai atasannya belum bisa ditentukan"
              actionLabel="Lihat"
              onAction={() => onOpenIssue("UNRESOLVED_MANAGER")}
            />
          ) : null}
          {readiness.vacantRequiringActing > 0 ? (
            <IssueLine
              tone="warning"
              count={readiness.vacantRequiringActing}
              label="jabatan kosong yang mewajibkan Plt, tanpa Plt"
              actionLabel="Lihat"
              onAction={onOpenActing}
            />
          ) : null}
          {readiness.ineligibleManagers > 0 ? (
            <IssueLine
              tone="info"
              count={readiness.ineligibleManagers}
              label="atasan belum punya akun HCIS aktif atau izin menyetujui"
              actionLabel="Lihat"
              onAction={() => onOpenIssue("AUTHORITY_INELIGIBLE")}
            />
          ) : null}
          {readiness.actingEndingSoon.length > 0 ? (
            <IssueLine
              tone="info"
              count={readiness.actingEndingSoon.length}
              label="Plt berakhir dalam 14 hari"
              actionLabel="Lihat"
              onAction={onOpenActing}
            />
          ) : null}
        </ul>
      </Panel>

      {readiness.comparison ? (
        <Panel
          title="Dibanding data atasan lama"
          description="Perbandingan ini hanya membaca. Ia tidak mengubah mode persetujuan dan tidak menulis apa pun."
        >
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              { label: "sama", value: readiness.comparison.same },
              { label: "berbeda", value: readiness.comparison.different },
              { label: "belum bisa ditentukan", value: readiness.comparison.unresolved },
              { label: "data lama kosong", value: readiness.comparison.noLegacy },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border border-border/70 bg-surface px-3 py-3">
                <p className="text-xl font-bold text-brand-heading">{item.value}</p>
                <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{item.label}</p>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onOpenIssue("DIFFERENT_FROM_LEGACY")}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl border border-border px-3 text-xs font-bold hover:bg-muted"
          >
            Lihat yang berbeda
          </button>
        </Panel>
      ) : null}
    </div>
  );
}

function personIssueSentence(person: OrganizationPerson): string | null {
  const issue = person.issues[0];
  if (!issue) return null;
  return organizationIssueSentence({ code: issue.code, itemKey: null });
}

export function OrganizationPeopleTab({
  page,
  loading,
  error,
  onRetry,
  query,
  issue,
  onQueryChange,
  onIssueChange,
  onPageChange,
  selectedEmployeeId,
  explanation,
  explanationLoading,
  onSelect,
  onCloseExplanation,
}: {
  page: OrganizationPeoplePage | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  query: string;
  issue: string;
  onQueryChange: (value: string) => void;
  onIssueChange: (value: string) => void;
  onPageChange: (value: number) => void;
  selectedEmployeeId: string | null;
  explanation: OrganizationExplanation | null;
  explanationLoading: boolean;
  onSelect: (employeeId: string) => void;
  onCloseExplanation: () => void;
}) {
  const totalPages = page ? Math.max(1, Math.ceil(page.total / page.pageSize)) : 1;

  return (
    <div className="space-y-5">
      <Panel
        title="Pegawai"
        description="Atasan langsung dihitung server dengan aturan yang sama seperti persetujuan. Klik satu baris untuk melihat alasannya."
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <span className="relative block flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Cari nama atau NIP..."
              aria-label="Cari pegawai"
              className={`${inputClass} pl-9`}
            />
          </span>
          <select value={issue} onChange={(event) => onIssueChange(event.target.value)} aria-label="Saring masalah" className={`${inputClass} sm:w-72`}>
            <option value="">Semua pegawai</option>
            <option value="ANY">Hanya yang bermasalah</option>
            <option value="NO_UNIT">Belum punya unit</option>
            <option value="UNRESOLVED_MANAGER">Atasan belum bisa ditentukan</option>
            <option value="DIFFERENT_FROM_LEGACY">Berbeda dari data atasan lama</option>
          </select>
        </div>

        <div className="mt-4">
          {error ? <ErrorRow message={error} onRetry={onRetry} /> : null}
          {!error && loading ? <LoadingRow label="Memuat daftar pegawai..." /> : null}
          {!error && !loading && page ? (
            page.items.length === 0 ? (
              <p className="rounded-xl border border-border/70 bg-surface p-4 text-sm text-muted-foreground">
                Tidak ada pegawai yang cocok dengan saringan ini.
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[46rem] border-collapse text-left text-sm">
                    <thead>
                      <tr className="border-b border-border/70 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                        <th className="py-2 pr-3 font-bold">Pegawai</th>
                        <th className="py-2 pr-3 font-bold">Unit</th>
                        <th className="py-2 pr-3 font-bold">Jabatan</th>
                        <th className="py-2 pr-3 font-bold">Atasan langsung</th>
                        <th className="py-2 font-bold">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {page.items.map((person) => (
                        <tr
                          key={person.employeeId}
                          onClick={() => onSelect(person.employeeId)}
                          className={cn(
                            "cursor-pointer border-b border-border/50 align-top hover:bg-muted",
                            selectedEmployeeId === person.employeeId ? "bg-brand-primary-pale/40" : "",
                          )}
                        >
                          <td className="py-2.5 pr-3">
                            <span className="block font-semibold text-brand-heading">{person.fullName}</span>
                            <span className="text-[11px] text-muted-foreground">{person.employeeNumber}</span>
                          </td>
                          <td className="py-2.5 pr-3 text-muted-foreground">
                            {person.unit ? person.unit.path.join(" › ") : "—"}
                          </td>
                          <td className="py-2.5 pr-3 text-muted-foreground">{person.position?.title ?? "—"}</td>
                          <td className="py-2.5 pr-3">
                            {person.directManager ? (
                              <>
                                <span className="block font-semibold text-brand-heading">{person.directManager.employeeName}</span>
                                <span className="text-[11px] text-muted-foreground">
                                  {person.directManager.positionTitle ?? ""} · {organizationSourceLabel(person.source)}
                                </span>
                              </>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="py-2.5">
                            {person.issues.length === 0 ? (
                              <span className="inline-flex rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-semibold text-success-ink">Beres</span>
                            ) : (
                              <span className="inline-flex rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning-ink">
                                Perlu dibereskan
                              </span>
                            )}
                            {person.legacy && person.legacy.comparison !== "NO_LEGACY" ? (
                              <span className="mt-1 block text-[11px] text-muted-foreground">
                                data lama: {organizationComparisonLabel(person.legacy.comparison)}
                              </span>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>
                    {page.total} pegawai · halaman {page.page} dari {totalPages}
                  </span>
                  <span className="flex gap-2">
                    <button type="button" disabled={page.page <= 1} onClick={() => onPageChange(page.page - 1)} className="h-9 rounded-xl border border-border px-3 font-bold disabled:opacity-50">
                      Sebelumnya
                    </button>
                    <button type="button" disabled={page.page >= totalPages} onClick={() => onPageChange(page.page + 1)} className="h-9 rounded-xl border border-border px-3 font-bold disabled:opacity-50">
                      Berikutnya
                    </button>
                  </span>
                </div>
              </>
            )
          ) : null}
        </div>
      </Panel>

      {selectedEmployeeId ? (
        <Panel title="Kenapa atasannya ini?">
          {explanationLoading ? <LoadingRow label="Menyusun penjelasan..." /> : null}
          {!explanationLoading && explanation ? (
            <>
              <ol className="space-y-2 text-sm leading-6">
                {explanation.steps
                  .map((step) => organizationExplanationSentence(step))
                  .filter((sentence): sentence is string => sentence !== null)
                  .map((sentence, index) => (
                    <li key={`${index}-${sentence}`} className="flex gap-2">
                      <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span>{sentence}</span>
                    </li>
                  ))}
              </ol>
              {personIssueSentence(explanation.person) ? (
                <p className="mt-3 rounded-xl border border-warning-line bg-warning-soft p-3 text-sm text-warning-ink">
                  {personIssueSentence(explanation.person)}
                </p>
              ) : null}
            </>
          ) : null}
          <button type="button" onClick={onCloseExplanation} className="mt-4 h-9 rounded-xl border border-border px-3 text-xs font-bold hover:bg-muted">
            Tutup
          </button>
        </Panel>
      ) : null}
    </div>
  );
}

export function OrganizationActingTab({
  readiness,
  positions,
  loading,
  error,
  onRetry,
}: {
  readiness: OrganizationReadiness | null;
  positions: OrganizationPosition[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (error) return <Panel title="Plt & jabatan kosong"><ErrorRow message={error} onRetry={onRetry} /></Panel>;
  if (loading || !readiness) return <Panel title="Plt & jabatan kosong"><LoadingRow label="Memuat daftar..." /></Panel>;

  const acting = positions.filter((position) => position.actingIncumbent !== null);
  const vacant = positions.filter((position) => !position.primaryIncumbent && !position.actingIncumbent);
  const endsOnByPosition = new Map(readiness.actingEndingSoon.map((item) => [item.positionKey, item.endsOn]));

  return (
    <div className="space-y-5">
      <Panel title="Plt" description="Penunjukan Plt selalu berbatas tanggal. Yang berakhir dalam 14 hari ditandai.">
        {acting.length === 0 ? (
          <p className="text-sm text-muted-foreground">Tidak ada Plt yang tercatat pada tanggal ini.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {acting.map((position) => (
              <li key={position.stableKey} className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-surface px-4 py-3">
                <span className="font-semibold text-brand-heading">{position.title}</span>
                <span className="text-muted-foreground">· Plt {position.actingIncumbent?.employeeName}</span>
                {position.actingIncumbent?.effectiveTo ? (
                  <span className="text-muted-foreground">· sampai {position.actingIncumbent.effectiveTo}</span>
                ) : null}
                {endsOnByPosition.has(position.stableKey) ? (
                  <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning-ink">
                    berakhir dalam 14 hari
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Jabatan kosong" description="Yang terjadi saat jabatan kosong mengikuti aturan jabatan itu sendiri.">
        {vacant.length === 0 ? (
          <p className="text-sm text-muted-foreground">Tidak ada jabatan kosong pada tanggal ini.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {vacant.map((position) => (
              <li key={position.stableKey} className="rounded-xl border border-border/70 bg-surface px-4 py-3">
                <span className="block font-semibold text-brand-heading">{position.title}</span>
                <span className="text-[11px] text-muted-foreground">
                  {organizationVacancyPolicyLabel(position.vacancyPolicy)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

const WORKFLOW_LABELS: Array<{ value: OrganizationPreviewWorkflow; label: string }> = [
  { value: "LEAVE_ANNUAL", label: "Cuti tahunan" },
  { value: "LEAVE_UNPAID", label: "Cuti tanpa upah" },
  { value: "OVERTIME", label: "Lembur" },
];

export function OrganizationApprovalCheckTab({
  employees,
  employeeId,
  workflow,
  date,
  onEmployeeChange,
  onWorkflowChange,
  onDateChange,
  onSubmit,
  loading,
  error,
  result,
  legacyPerson,
}: {
  employees: Array<{ id: string; fullName: string; employeeNumber: string }>;
  employeeId: string;
  workflow: OrganizationPreviewWorkflow;
  date: string;
  onEmployeeChange: (value: string) => void;
  onWorkflowChange: (value: OrganizationPreviewWorkflow) => void;
  onDateChange: (value: string) => void;
  onSubmit: () => void;
  loading: boolean;
  error: string | null;
  result: OrganizationApprovalPreview | null;
  legacyPerson: OrganizationPerson | null;
}) {
  return (
    <div className="space-y-5">
      <Panel
        title="Cek persetujuan"
        description="Server yang menentukan siapa menyetujui, termasuk Plt dan jabatan kosong. Layar ini tidak menebak."
      >
        <form
          onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
          className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_minmax(0,10rem)_auto]"
        >
          <select required value={employeeId} onChange={(event) => onEmployeeChange(event.target.value)} aria-label="Pegawai" className={inputClass}>
            <option value="">Pilih pegawai...</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>{employee.fullName} — {employee.employeeNumber}</option>
            ))}
          </select>
          <select value={workflow} onChange={(event) => onWorkflowChange(event.target.value as OrganizationPreviewWorkflow)} aria-label="Jenis pengajuan" className={inputClass}>
            {WORKFLOW_LABELS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          <input type="date" value={date} onChange={(event) => onDateChange(event.target.value)} aria-label="Tanggal" className={inputClass} />
          <button type="submit" disabled={loading || !employeeId} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">
            {loading ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null} Lihat
          </button>
        </form>

        {error ? <div className="mt-4"><ErrorRow message={error} /></div> : null}

        {result ? (
          <div className="mt-4 rounded-xl bg-surface p-4">
            {result.preview ? (
              <p className="mb-3 rounded-lg border border-warning-line bg-warning-soft px-3 py-2 text-xs text-warning-ink">
                {organizationWarningSentence("OVERTIME_CAPABILITY_PENDING")}
              </p>
            ) : null}
            <p className="text-sm font-bold text-brand-heading">
              {result.employee.fullName} mengajukan {WORKFLOW_LABELS.find((item) => item.value === result.workflow)?.label.toLowerCase()} pada {result.effectiveDate}
            </p>
            <ol className="mt-3 space-y-2 text-sm">
              {result.steps.map((step, index) => (
                <li key={`${step.employeeId}-${index}`} className="flex gap-2">
                  <span className="font-bold text-muted-foreground">{index + 1}.</span>
                  <span>
                    <span className="font-semibold text-brand-heading">{step.employeeName}</span>
                    {step.positionTitle ? <span className="text-muted-foreground"> — {step.positionTitle}</span> : null}
                  </span>
                </li>
              ))}
              {result.steps.length === 0 ? <li className="text-muted-foreground">Atasan belum bisa ditentukan untuk pegawai ini.</li> : null}
            </ol>
            {result.oversight ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Setelah disetujui, yang diberi tahu: <span className="font-bold text-brand-heading">{result.oversight.employeeName}</span>
                {" "}(berlaku hanya bila persetujuan sudah memakai struktur ini).
              </p>
            ) : null}
            {result.warnings
              .filter((warning) => warning.code !== "OVERTIME_CAPABILITY_PENDING")
              .map((warning) => (
                <p key={warning.code} className="mt-2 text-xs text-warning-ink">{organizationWarningSentence(warning.code)}</p>
              ))}
            <p className="mt-3 text-[11px] text-muted-foreground">
              Pengajuan yang sudah dikirim tidak berubah bila struktur diubah.
            </p>
            {legacyPerson?.legacy ? (
              <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                Dengan data atasan lama: {legacyPerson.legacy.directManagerName ?? "belum diisi"} ·{" "}
                <span className="font-semibold">{organizationComparisonLabel(legacyPerson.legacy.comparison)}</span>
              </p>
            ) : null}
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
