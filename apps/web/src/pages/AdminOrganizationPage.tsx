import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowRightLeft,
  BriefcaseBusiness,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleUserRound,
  Eye,
  GitBranchPlus,
  Info,
  LoaderCircle,
  Lock,
  Network,
  PanelRightClose,
  Plus,
  Rocket,
  ShieldCheck,
  Sparkles,
  UserCog,
  UsersRound,
  X,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";

import {
  OrganizationChart,
  type OrganizationSelection,
} from "@/components/organization/OrganizationChart";
import { AdminShell } from "@/layouts/AdminShell";
import { AdminApiError } from "@/lib/adminEmployees";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  createOrganizationAuthorityBinding,
  createOrganizationDraft,
  createOrganizationNode,
  createOrganizationPosition,
  getOrganizationDesignerView,
  getOrganizationImpact,
  getOrganizationRollout,
  listOrganizationEmployees,
  previewOrganizationResolution,
  publishOrganizationDraft,
  replaceOrganizationIncumbencies,
  replaceOrganizationMemberships,
  updateOrganizationNode,
  updateOrganizationPosition,
  validateOrganizationDraft,
  type OrganizationDesignerView,
  type OrganizationEmployeeOption,
  type OrganizationImpactPreview,
  type OrganizationNode,
  type OrganizationPosition,
  type OrganizationResolutionPreview,
  type OrganizationRolloutConfiguration,
  type OrganizationValidationReport,
  type OrganizationVacancyPolicy,
} from "@/lib/organizationDesigner";
import {
  organizationApiMessage,
  organizationDraftStatusLabel,
  organizationIssueSentence,
  organizationModeBanner,
  organizationNodeTypeLabel,
  organizationSeatEditability,
} from "@/lib/organizationLanguage";
import { cn } from "@/lib/utils";
import { selectableOrganizationParents } from "@/lib/organizationTree";
import type { AuthSession } from "@/types/hcis";

type EditorAction =
  | { type: "draft" }
  | { type: "node"; mode: "root" | "child" | "sibling" | "edit"; node?: OrganizationNode }
  | { type: "position"; mode: "create" | "edit"; nodeKey: string; parentPositionKey?: string | null; position?: OrganizationPosition }
  | { type: "incumbency"; position: OrganizationPosition; acting: boolean }
  | { type: "members"; node: OrganizationNode }
  | { type: "visual"; item: OrganizationNode | OrganizationPosition; kind: "node" | "position" }
  | { type: "authority"; item: OrganizationNode | OrganizationPosition; kind: "node" | "position" };

/** ORG-008-1 §4.8: every irreversible-looking action is confirmed with its effect spelled out. */
type ConfirmAction = {
  title: string;
  body: string;
  confirmLabel: string;
  run: () => Promise<unknown>;
  success: string;
};

const dateFormatter = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Jakarta",
});

function jakartaToday() {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Jakarta",
  }).format(new Date());
}

function initialDesignerState() {
  const params = new URLSearchParams(window.location.search);
  return {
    effectiveDate: params.get("effectiveDate") ?? jakartaToday(),
    draftId: params.get("draftId"),
  };
}

function updateDesignerUrl(effectiveDate: string, draftId: string | null) {
  const url = new URL(window.location.href);
  url.searchParams.set("effectiveDate", effectiveDate);
  if (draftId) url.searchParams.set("draftId", draftId);
  else url.searchParams.delete("draftId");
  window.history.replaceState(null, "", url);
}

function displayDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return dateFormatter.format(new Date(Date.UTC(year, month - 1, day)));
}

/** API messages stay English for logs; the screen always shows the operator sentence (ORG-008-J). */
function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof AdminApiError ? organizationApiMessage(cause.code, fallback) : fallback;
}

function Modal({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-brand-heading/30 p-0 backdrop-blur-[2px] sm:items-center sm:p-6">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="organization-dialog-title"
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-surface-raised shadow-2xl sm:max-w-xl sm:rounded-3xl"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border/70 bg-surface-raised px-5 py-4 sm:px-6">
          <div>
            <h2 id="organization-dialog-title" className="text-lg font-bold text-brand-heading">{title}</h2>
            {description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p> : null}
          </div>
          <button type="button" aria-label="Tutup dialog" onClick={onClose} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="p-5 sm:p-6">{children}</div>
      </section>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-bold text-brand-heading">{label}</span>
      {hint ? <span className="ml-1 text-[11px] text-muted-foreground">{hint}</span> : null}
      <span className="mt-1.5 block">{children}</span>
    </label>
  );
}

const inputClass = "h-11 w-full rounded-xl border border-border bg-surface-raised px-3 text-sm outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/10";

function SubmitRow({ saving, onCancel, label }: { saving: boolean; onCancel: () => void; label: string }) {
  return (
    <div className="mt-6 flex justify-end gap-2 border-t border-border/70 pt-4">
      <button type="button" onClick={onCancel} className="h-10 rounded-xl border border-border px-4 text-sm font-semibold hover:bg-muted">Batal</button>
      <button type="submit" disabled={saving} className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground hover:bg-brand-primary-deep disabled:opacity-60">
        {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
        {saving ? "Menyimpan..." : label}
      </button>
    </div>
  );
}

function statusCopy(mode: OrganizationDesignerView["mode"]) {
  if (mode === "HISTORICAL") return { label: "Riwayat", className: "bg-muted text-foreground" };
  if (mode === "FUTURE") return { label: "Terjadwal berlaku", className: "bg-info-soft text-info-ink" };
  if (mode === "DRAFT") return { label: "Sedang disusun", className: "bg-warning-soft text-warning-ink" };
  return { label: "Berlaku", className: "bg-success-soft text-success-ink" };
}

function ImpactCard({ label, count, tone = "default" }: { label: string; count: number; tone?: "default" | "warning" | "visual" }) {
  return (
    <div className={cn("rounded-xl border px-3 py-3", tone === "warning" ? "border-warning-line bg-warning-soft" : tone === "visual" ? "border-info-line bg-info-soft" : "border-border/70 bg-surface")}>
      <p className="text-xl font-bold text-brand-heading">{count}</p>
      <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{label}</p>
    </div>
  );
}

function ActionButton({ onClick, icon, children }: { onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return <button type="button" onClick={onClick} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border bg-surface-raised px-2.5 text-[11px] font-bold hover:border-brand-primary/40 hover:bg-brand-primary-pale/30 [&_svg]:h-3.5 [&_svg]:w-3.5">{icon}{children}</button>;
}

/** Codes and stable keys belong here only, never on the main screen (acceptance ORG-008-J). */
function TechnicalDetails({ children }: { children: ReactNode }) {
  return (
    <details className="mt-3 rounded-xl border border-border/70 bg-surface px-3 py-2">
      <summary className="cursor-pointer text-[11px] font-bold text-muted-foreground">Detail teknis</summary>
      <div className="mt-2 text-[11px] leading-5 text-muted-foreground">{children}</div>
    </details>
  );
}

function employeeMatches(employee: OrganizationEmployeeOption, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${employee.fullName} ${employee.employeeNumber} ${employee.unitName ?? ""} ${employee.positionName ?? ""}`
    .toLowerCase()
    .includes(needle);
}

function isActiveEmployee(employee: OrganizationEmployeeOption) {
  return (employee.status ?? "active") === "active";
}

/**
 * ORG-008-1 (gap P-1, P-4): search instead of scrolling hundreds of names, and offer active employees
 * only. The employee already recorded on the seat stays selectable so an existing value is never
 * dropped silently just because the person is no longer active.
 */
function EmployeePicker({
  name,
  employees,
  defaultValue,
  required,
}: {
  name: string;
  employees: OrganizationEmployeeOption[];
  defaultValue?: string;
  required?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [value, setValue] = useState(defaultValue ?? "");
  const options = useMemo(() => {
    const eligible = employees.filter((employee) => isActiveEmployee(employee) || employee.id === value);
    return eligible.filter((employee) => employee.id === value || employeeMatches(employee, query));
  }, [employees, query, value]);

  return (
    <div className="space-y-2">
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Cari nama, NIP, atau unit..."
        aria-label="Cari pegawai"
        className={inputClass}
      />
      <select
        name={name}
        required={required}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className={inputClass}
      >
        <option value="">Pilih pegawai...</option>
        {options.map((employee) => (
          <option key={employee.id} value={employee.id}>
            {employee.fullName} — {employee.employeeNumber}
            {isActiveEmployee(employee) ? "" : " (sudah tidak aktif)"}
          </option>
        ))}
      </select>
      {options.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">Tidak ada pegawai aktif yang cocok dengan pencarian.</p>
      ) : null}
    </div>
  );
}

export function OrganizationDesignerWorkspace({
  session,
  view,
  rollout,
  rolloutFailed,
  employees,
  employeesFailed,
  loading,
  effectiveDate,
  onEffectiveDateChange,
  onDraftIdChange,
  onReload,
  onRetryEmployees,
}: {
  session: AuthSession | null;
  view: OrganizationDesignerView | null;
  rollout: OrganizationRolloutConfiguration | null;
  rolloutFailed: boolean;
  employees: OrganizationEmployeeOption[];
  employeesFailed: boolean;
  loading: boolean;
  effectiveDate: string;
  onEffectiveDateChange: (value: string) => void;
  onDraftIdChange: (value: string | null) => void;
  onReload: () => Promise<void>;
  onRetryEmployees: () => void;
}) {
  const [selection, setSelection] = useState<OrganizationSelection>(null);
  const [action, setAction] = useState<EditorAction | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmAction | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [validation, setValidation] = useState<OrganizationValidationReport | null>(null);
  const [impact, setImpact] = useState<OrganizationImpactPreview | null>(null);
  const [preview, setPreview] = useState<OrganizationResolutionPreview | null>(null);
  const [previewEmployeeId, setPreviewEmployeeId] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);

  const data = view;
  const today = jakartaToday();
  const banner = organizationModeBanner(rollout, {
    loadFailed: rolloutFailed,
    pending: !rollout && !rolloutFailed,
  });

  // UI eligibility only; every endpoint authorizes independently. ORG-008-8 will move composing
  // incumbents, Plt, and authority to organization.manage; publishing stays with approvals.policy.manage.
  const canCompose = hasPermission(session, "organization.manage");
  const canAssignIncumbents = hasPermission(session, "approvals.policy.manage");
  const canPublish = hasPermission(session, "approvals.policy.manage");

  const selectedNode = useMemo(
    () => selection?.kind === "node" ? data?.nodes.find((node) => node.stableKey === selection.key) ?? null : null,
    [data?.nodes, selection],
  );
  const selectedPosition = useMemo(
    () => selection?.kind === "position" ? data?.positions.find((position) => position.stableKey === selection.key) ?? null : null,
    [data?.positions, selection],
  );
  const selectedSeat = selectedPosition ? organizationSeatEditability(selectedPosition) : null;
  const canEdit = data?.draft?.status === "DRAFT";
  const hasActiveDraft = data?.draft?.status === "DRAFT" || data?.draft?.status === "VALIDATED";
  const status = statusCopy(data?.mode ?? "CURRENT");

  /** Names for issue sentences; an unknown key keeps the sentence generic instead of inventing one. */
  const nameByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of data?.nodes ?? []) {
      map.set(node.stableKey, node.name);
      map.set(node.id, node.name);
    }
    for (const position of data?.positions ?? []) {
      map.set(position.stableKey, position.title);
      map.set(position.id, position.title);
    }
    for (const membership of data?.memberships ?? []) {
      if (membership.employeeName) map.set(membership.employeeId, membership.employeeName);
    }
    for (const employee of employees) map.set(employee.id, employee.fullName);
    return map;
  }, [data?.nodes, data?.positions, data?.memberships, employees]);

  const mutate = async (operation: () => Promise<unknown>, success: string) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
      setAction(null);
      setConfirmation(null);
      setValidation(null);
      setImpact(null);
      setNotice(success);
      await onReload();
    } catch (cause) {
      setError(errorMessage(cause, "Perubahan struktur tidak dapat disimpan."));
    } finally {
      setSaving(false);
    }
  };

  const startFromEmpty = () => canEdit ? setAction({ type: "node", mode: "root" }) : setAction({ type: "draft" });

  const handleDraft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setError(null);
    void createOrganizationDraft({ name: String(form.get("name")), effectiveOn: String(form.get("effectiveOn")) })
      .then((draft) => {
        onDraftIdChange(draft.id);
        onEffectiveDateChange(draft.effectiveOn);
        setAction(null);
        setNotice("Perubahan struktur siap disusun.");
      })
      .catch((cause: unknown) => setError(errorMessage(cause, "Perubahan struktur tidak dapat dibuat.")))
      .finally(() => setSaving(false));
  };

  const handleNode = (event: FormEvent<HTMLFormElement>, editor: Extract<EditorAction, { type: "node" }>) => {
    event.preventDefault();
    if (!data?.draft) return;
    const form = new FormData(event.currentTarget);
    const input = {
      name: String(form.get("name")),
      nodeType: String(form.get("nodeType")),
      parentNodeKey: String(form.get("parentNodeKey")) || null,
      visualRankOffset: Number(form.get("visualRankOffset")),
      integrationCode: String(form.get("integrationCode")) || null,
    };
    void mutate(
      () => editor.mode === "edit" && editor.node ? updateOrganizationNode(data.draft!.id, editor.node.id, input) : createOrganizationNode(data.draft!.id, input),
      editor.mode === "edit" ? "Unit diperbarui." : "Unit ditambahkan ke perubahan ini.",
    );
  };

  const handlePosition = (event: FormEvent<HTMLFormElement>, editor: Extract<EditorAction, { type: "position" }>) => {
    event.preventDefault();
    if (!data?.draft) return;
    const form = new FormData(event.currentTarget);
    const input = {
      nodeKey: String(form.get("nodeKey")),
      title: String(form.get("title")),
      parentPositionKey: String(form.get("parentPositionKey")) || null,
      vacancyPolicy: String(form.get("vacancyPolicy")) as OrganizationVacancyPolicy,
      singleIncumbent: true,
      visualRankOffset: Number(form.get("visualRankOffset")),
    };
    void mutate(
      () => editor.mode === "edit" && editor.position ? updateOrganizationPosition(data.draft!.id, editor.position.id, input) : createOrganizationPosition(data.draft!.id, input),
      editor.mode === "edit" ? "Jabatan diperbarui." : "Jabatan ditambahkan.",
    );
  };

  const handleIncumbency = (event: FormEvent<HTMLFormElement>, editor: Extract<EditorAction, { type: "incumbency" }>) => {
    event.preventDefault();
    if (!data?.draft) return;
    const form = new FormData(event.currentTarget);
    void mutate(
      () => replaceOrganizationIncumbencies(data.draft!.id, {
        positionKey: editor.position.stableKey,
        primaryEmployeeId: editor.acting ? editor.position.primaryIncumbent?.employeeId ?? null : String(form.get("employeeId")) || null,
        actingEmployeeId: editor.acting ? String(form.get("employeeId")) || null : editor.position.actingIncumbent?.employeeId ?? null,
        actingFrom: editor.acting ? String(form.get("actingFrom")) : editor.position.actingIncumbent?.effectiveFrom ?? null,
        actingTo: editor.acting ? String(form.get("actingTo")) : editor.position.actingIncumbent?.effectiveTo ?? null,
        effectiveFrom: String(form.get("effectiveFrom") || data.draft!.effectiveOn),
      }),
      editor.acting ? "Plt diperbarui." : "Pejabat diperbarui.",
    );
  };

  const askMarkVacant = (position: OrganizationPosition) => {
    if (!data?.draft) return;
    const holder = position.primaryIncumbent?.employeeName;
    setConfirmation({
      title: `Kosongkan jabatan ${position.title}?`,
      body: holder
        ? `${holder} tidak lagi tercatat sebagai pejabat ${position.title} dalam perubahan ini. Pegawai yang atasannya berasal dari jabatan ini akan mengikuti aturan "bila kosong" jabatan tersebut. Perubahan baru berlaku setelah diterbitkan.`
        : `Jabatan ${position.title} ditandai kosong dalam perubahan ini. Pegawai yang atasannya berasal dari jabatan ini akan mengikuti aturan "bila kosong" jabatan tersebut. Perubahan baru berlaku setelah diterbitkan.`,
      confirmLabel: "Kosongkan jabatan",
      success: "Jabatan ditandai kosong.",
      run: () => replaceOrganizationIncumbencies(data.draft!.id, {
        positionKey: position.stableKey,
        primaryEmployeeId: null,
        actingEmployeeId: position.actingIncumbent?.employeeId ?? null,
        actingFrom: position.actingIncumbent?.effectiveFrom ?? null,
        actingTo: position.actingIncumbent?.effectiveTo ?? null,
        effectiveFrom: data.draft!.effectiveOn,
      }),
    });
  };

  const askClearActing = (position: OrganizationPosition) => {
    if (!data?.draft) return;
    const acting = position.actingIncumbent?.employeeName;
    setConfirmation({
      title: `Hapus Plt jabatan ${position.title}?`,
      body: acting
        ? `${acting} tidak lagi tercatat sebagai Plt ${position.title}. Bila jabatan ini kosong, pengajuan mengikuti aturan "bila kosong" jabatan tersebut. Perubahan baru berlaku setelah diterbitkan.`
        : `Penunjukan Plt pada ${position.title} dihapus dari perubahan ini. Perubahan baru berlaku setelah diterbitkan.`,
      confirmLabel: "Hapus Plt",
      success: "Penunjukan Plt dihapus.",
      run: () => replaceOrganizationIncumbencies(data.draft!.id, {
        positionKey: position.stableKey,
        primaryEmployeeId: position.primaryIncumbent?.employeeId ?? null,
        actingEmployeeId: null,
        effectiveFrom: data.draft!.effectiveOn,
      }),
    });
  };

  const handleMembers = (event: FormEvent<HTMLFormElement>, editor: Extract<EditorAction, { type: "members" }>) => {
    event.preventDefault();
    if (!data?.draft) return;
    const form = new FormData(event.currentTarget);
    void mutate(
      () => replaceOrganizationMemberships(data.draft!.id, { nodeKey: editor.node.stableKey, employeeIds: form.getAll("employeeIds").map(String), effectiveFrom: data.draft!.effectiveOn }),
      "Anggota unit diperbarui.",
    );
  };

  const handleVisual = (event: FormEvent<HTMLFormElement>, editor: Extract<EditorAction, { type: "visual" }>) => {
    event.preventDefault();
    if (!data?.draft) return;
    const offset = Number(new FormData(event.currentTarget).get("visualRankOffset"));
    void mutate(
      () => editor.kind === "node" ? updateOrganizationNode(data.draft!.id, editor.item.id, { visualRankOffset: offset }) : updateOrganizationPosition(data.draft!.id, editor.item.id, { visualRankOffset: offset }),
      "Tampilan kotak diperbarui; persetujuan tidak berubah.",
    );
  };

  const handleAuthority = (event: FormEvent<HTMLFormElement>, editor: Extract<EditorAction, { type: "authority" }>) => {
    event.preventDefault();
    if (!data?.draft) return;
    const form = new FormData(event.currentTarget);
    void mutate(
      () => createOrganizationAuthorityBinding(data.draft!.id, {
        sourceType: editor.kind === "node" ? "NODE" : "POSITION",
        sourceKey: editor.item.stableKey,
        authorityType: String(form.get("authorityType")) as "SUPERVISORY_PARENT" | "LEADER" | "UNIT_APPROVER" | "GOVERNANCE_APPROVER" | "OVERSIGHT_PARENT",
        targetPositionKey: String(form.get("targetPositionKey")),
        vacancyPolicy: String(form.get("vacancyPolicy")) as OrganizationVacancyPolicy,
        effectiveFrom: data.draft!.effectiveOn,
        effectiveTo: null,
      }),
      "Kewenangan disimpan.",
    );
  };

  const runValidation = async () => {
    if (!data?.draft) return;
    setSaving(true);
    setError(null);
    try {
      const report = await validateOrganizationDraft(data.draft.id);
      setValidation(report);
      setNotice(report.valid ? "Tidak ada masalah struktur. Perubahan ini siap diterbitkan." : null);
      await onReload();
    } catch (cause) {
      setError(errorMessage(cause, "Pemeriksaan perubahan tidak dapat dijalankan."));
    } finally { setSaving(false); }
  };

  const runImpact = async () => {
    if (!data?.draft) return;
    setSaving(true);
    setError(null);
    try { setImpact(await getOrganizationImpact(data.draft.id)); }
    catch (cause) { setError(errorMessage(cause, "Dampak perubahan tidak dapat dimuat.")); }
    finally { setSaving(false); }
  };

  const askPublish = () => {
    if (!data?.draft) return;
    const draft = data.draft;
    setConfirmation({
      title: `Terbitkan "${draft.name}"?`,
      body: `Struktur ini akan berlaku mulai ${displayDate(draft.effectiveOn)}. Pengajuan yang sudah dikirim tidak berubah.${banner.certain ? " Persetujuan tetap memakai data atasan lama; menerbitkan struktur tidak mengubah itu." : ""}`,
      confirmLabel: "Terbitkan",
      success: `Struktur terbit, berlaku ${displayDate(draft.effectiveOn)}.${banner.certain ? " Persetujuan masih memakai data atasan lama." : ""}`,
      run: async () => {
        await publishOrganizationDraft(draft.id);
        onDraftIdChange(null);
        setSelection(null);
      },
    });
  };

  const runConfirmation = async () => {
    if (!confirmation) return;
    await mutate(confirmation.run, confirmation.success);
  };

  const runResolutionPreview = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!data?.draft || !previewEmployeeId) return;
    setPreviewLoading(true);
    setError(null);
    try { setPreview(await previewOrganizationResolution(data.draft.id, { employeeId: previewEmployeeId, workflowKey: "LEAVE", effectiveDate: data.draft.effectiveOn })); }
    catch (cause) { setError(errorMessage(cause, "Jalur persetujuan tidak dapat ditampilkan.")); }
    finally { setPreviewLoading(false); }
  };

  if (session && !canCompose) {
    return (
      <div role="alert" className="rounded-2xl border border-border/70 bg-surface-raised p-6 text-sm text-muted-foreground">
        <h2 className="text-base font-bold text-brand-heading">Anda tidak punya akses ke Struktur Organisasi</h2>
        <p className="mt-2 leading-6">Hubungi Human Capital bila Anda memang perlu menyusun struktur organisasi.</p>
      </div>
    );
  }

  return (
    <>
      <div
        role="status"
        className={cn(
          "mb-4 flex items-start gap-3 rounded-2xl border p-4 text-sm",
          banner.tone === "info" ? "border-info-line bg-info-soft text-info-ink" : "border-warning-line bg-warning-soft text-warning-ink",
        )}
      >
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          <span className="block font-bold">{banner.title}</span>
          <span className="mt-0.5 block leading-5">{banner.detail}</span>
        </span>
      </div>

      {error ? <div role="alert" className="mb-4 flex items-start gap-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div> : null}
      {notice ? <div className="mb-4 flex items-start gap-3 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>{notice}</span></div> : null}
      {employeesFailed ? (
        <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">Daftar pegawai tidak dapat dimuat, jadi pencarian pegawai belum bisa dipakai.</span>
          <button type="button" onClick={onRetryEmployees} className="h-9 rounded-xl border border-danger-line px-3 text-xs font-bold">Coba lagi</button>
        </div>
      ) : null}

      <section className={cn("overflow-hidden rounded-3xl border bg-surface-raised shadow-[var(--shadow-soft)]", canEdit ? "border-warning-line ring-4 ring-warning-soft/60" : "border-border/70")}>
        <div className={cn("flex flex-col gap-4 border-b px-5 py-4 lg:flex-row lg:items-end lg:justify-between", canEdit ? "border-warning-line bg-warning-soft/60" : "border-border/70")}>
          <div className="flex flex-wrap items-center gap-3">
            {/* ORG-008-1 (gap D-1): while a change is open the date picker is replaced, so switching
                dates can no longer close the change the operator is working on. */}
            {hasActiveDraft && data?.draft ? (
              <div className="mb-0.5 self-end">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Perubahan yang sedang dibuka</p>
                <p className="mt-0.5 text-sm font-bold text-brand-heading">{data.draft.name}</p>
                <p className="text-[11px] text-muted-foreground">
                  Berlaku mulai {displayDate(data.draft.effectiveOn)} · {organizationDraftStatusLabel(data.draft.status, { effectiveOn: data.draft.effectiveOn, today, formatDate: displayDate })}
                </p>
              </div>
            ) : (
              <Field label="Lihat struktur pada tanggal">
                <span className="relative block">
                  <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input type="date" value={effectiveDate} onChange={(event) => { onEffectiveDateChange(event.target.value); setSelection(null); }} className={`${inputClass} w-48 pl-9`} />
                </span>
              </Field>
            )}
            <span className={cn("mb-0.5 self-end rounded-full px-3 py-2 text-xs font-bold", status.className)}>{status.label}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {!hasActiveDraft ? (
              <button type="button" onClick={() => setAction({ type: "draft" })} className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-surface-raised px-3 text-xs font-bold hover:bg-muted"><CalendarClock className="h-4 w-4" /> Mulai perubahan struktur</button>
            ) : (
              <>
                <button type="button" onClick={() => { onDraftIdChange(null); setSelection(null); }} className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-surface-raised px-3 text-xs font-bold hover:bg-muted"><X className="h-4 w-4" /> Tutup perubahan</button>
                {canEdit ? <button type="button" disabled={saving} onClick={() => void runValidation()} className="inline-flex h-10 items-center gap-2 rounded-xl border border-warning-line bg-surface-raised px-3 text-xs font-bold text-warning-ink hover:bg-warning-soft disabled:opacity-60"><ShieldCheck className="h-4 w-4" /> Periksa</button> : null}
                <button type="button" disabled={saving} onClick={() => void runImpact()} className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-surface-raised px-3 text-xs font-bold hover:bg-muted disabled:opacity-60"><Eye className="h-4 w-4" /> Lihat dampak</button>
                {canPublish ? (
                  <button type="button" disabled={saving || data?.draft?.status !== "VALIDATED"} onClick={askPublish} className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-3 text-xs font-bold text-brand-foreground hover:bg-brand-primary-deep disabled:opacity-50"><Rocket className="h-4 w-4" /> Terbitkan</button>
                ) : (
                  <span className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-muted px-3 text-xs font-bold text-muted-foreground"><Lock className="h-4 w-4" /> Terbitkan: menunggu Kepala HC</span>
                )}
              </>
            )}
          </div>
        </div>

        {canEdit && (selectedNode || selectedPosition) ? <div className="flex flex-col gap-3 border-b border-warning-line bg-surface-raised px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Dipilih</p>
            <p className="mt-0.5 text-sm font-bold text-brand-heading">{selectedNode?.name ?? selectedPosition?.title}</p>
            {selectedSeat?.reason ? <p className="mt-1 max-w-xl text-[11px] leading-4 text-muted-foreground">{selectedSeat.reason}</p> : null}
            {!canAssignIncumbents ? <p className="mt-1 max-w-xl text-[11px] leading-4 text-muted-foreground">Pejabat, Plt, dan kewenangan diisi oleh pemegang izin persetujuan (Kepala HC atau owner).</p> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {selectedNode ? <>
              <ActionButton onClick={() => setAction({ type: "node", mode: "child", node: selectedNode })} icon={<GitBranchPlus />}>Tambah unit di bawah</ActionButton>
              <ActionButton onClick={() => setAction({ type: "node", mode: "sibling", node: selectedNode })} icon={<Plus />}>Tambah unit sejajar</ActionButton>
              <ActionButton onClick={() => setAction({ type: "position", mode: "create", nodeKey: selectedNode.stableKey })} icon={<BriefcaseBusiness />}>Tambah jabatan</ActionButton>
              <ActionButton onClick={() => setAction({ type: "node", mode: "edit", node: selectedNode })} icon={<ArrowRightLeft />}>Ganti nama / pindah induk</ActionButton>
              <ActionButton onClick={() => setAction({ type: "members", node: selectedNode })} icon={<UsersRound />}>Anggota unit</ActionButton>
              <ActionButton onClick={() => setAction({ type: "visual", item: selectedNode, kind: "node" })} icon={<ArrowDownToLine />}>Tampilan</ActionButton>
              {canAssignIncumbents ? <ActionButton onClick={() => setAction({ type: "authority", item: selectedNode, kind: "node" })} icon={<Network />}>Pemimpin &amp; penyetuju</ActionButton> : null}
            </> : selectedPosition ? <>
              <ActionButton onClick={() => setAction({ type: "position", mode: "create", nodeKey: selectedPosition.nodeKey, parentPositionKey: selectedPosition.stableKey })} icon={<GitBranchPlus />}>Jabatan di bawah</ActionButton>
              <ActionButton onClick={() => setAction({ type: "position", mode: "create", nodeKey: selectedPosition.nodeKey, parentPositionKey: selectedPosition.parentPositionKey })} icon={<Plus />}>Jabatan sejajar</ActionButton>
              {canAssignIncumbents && selectedSeat?.editable ? <>
                <ActionButton onClick={() => setAction({ type: "incumbency", position: selectedPosition, acting: false })} icon={<CircleUserRound />}>Tetapkan pejabat</ActionButton>
                <ActionButton onClick={() => setAction({ type: "incumbency", position: selectedPosition, acting: true })} icon={<UserCog />}>Tunjuk Plt</ActionButton>
                {selectedPosition.actingIncumbent ? <ActionButton onClick={() => askClearActing(selectedPosition)} icon={<X />}>Hapus Plt</ActionButton> : null}
                <ActionButton onClick={() => askMarkVacant(selectedPosition)} icon={<PanelRightClose />}>Kosongkan</ActionButton>
              </> : null}
              <ActionButton onClick={() => setAction({ type: "position", mode: "edit", nodeKey: selectedPosition.nodeKey, position: selectedPosition })} icon={<ArrowRightLeft />}>Ubah jabatan</ActionButton>
              <ActionButton onClick={() => setAction({ type: "visual", item: selectedPosition, kind: "position" })} icon={<ArrowDownToLine />}>Tampilan</ActionButton>
              {canAssignIncumbents ? <ActionButton onClick={() => setAction({ type: "authority", item: selectedPosition, kind: "position" })} icon={<Network />}>Melapor ke &amp; kewenangan</ActionButton> : null}
            </> : null}
          </div>
        </div> : null}

        <div className="relative min-h-[34rem] overflow-auto bg-surface">
          {loading ? <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface-raised/70 text-sm font-semibold text-muted-foreground"><LoaderCircle className="mr-2 h-5 w-5 animate-spin" /> Memuat struktur...</div> : null}
          <OrganizationChart nodes={data?.nodes ?? []} positions={data?.positions ?? []} selection={selection} onSelect={setSelection} canEdit={Boolean(canEdit)} onStart={startFromEmpty} />
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border/70 bg-surface-raised px-5 py-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm border border-brand-primary bg-brand-primary-pale" /> Jabatan terisi</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm border border-dashed border-warning-line bg-warning-soft" /> Jabatan kosong</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-px w-5 bg-brand-primary/40" /> Hubungan unit dan jabatan</span>
          <span className="inline-flex items-center gap-1.5"><ArrowDownToLine className="h-3.5 w-3.5 text-info-ink" /> Tampilan tidak memengaruhi persetujuan</span>
        </div>
      </section>

      {validation ? <section className={cn("mt-5 rounded-2xl border p-5", validation.valid ? "border-success-line bg-success-soft" : "border-danger-line bg-danger-soft")}>
        <div className="flex items-center gap-2">{validation.valid ? <CheckCircle2 className="h-5 w-5 text-success-ink" /> : <AlertTriangle className="h-5 w-5 text-danger-ink" />}<h2 className="text-base font-bold text-brand-heading">{validation.valid ? "Tidak ada masalah struktur" : "Perubahan ini perlu dibereskan"}</h2></div>
        {validation.issues.length > 0 ? <>
          <ul className="mt-3 space-y-2 text-sm">
            {validation.issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>{organizationIssueSentence(issue, (key) => nameByKey.get(key) ?? null)}</li>
            ))}
          </ul>
          <TechnicalDetails>
            <ul className="space-y-1">
              {validation.issues.map((issue, index) => (
                <li key={`technical-${issue.code}-${index}`}>{issue.code}{issue.itemKey ? ` · ${issue.itemKey}` : ""} — {issue.message}</li>
              ))}
            </ul>
          </TechnicalDetails>
        </> : <p className="mt-2 text-sm text-success-ink">Tidak ada hubungan berputar, pejabat ganda, atau kewenangan yang bertabrakan.</p>}
      </section> : null}

      {impact ? <section className="mt-5 rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <div className="flex items-start justify-between gap-4"><div><h2 className="text-base font-bold text-brand-heading">Dampak perubahan</h2><p className="mt-1 text-xs text-muted-foreground">Dihitung server untuk tanggal berlaku perubahan ini. Pengajuan yang sudah dikirim tidak berubah.</p></div>{impact.noApprovalRoutingImpact ? <span className="rounded-full bg-info-soft px-3 py-1.5 text-xs font-bold text-info-ink">Tidak mengubah jalur persetujuan</span> : <span className="rounded-full bg-warning-soft px-3 py-1.5 text-xs font-bold text-warning-ink">Jalur persetujuan perlu ditinjau</span>}</div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6"><ImpactCard label="Atasan langsung berubah" count={impact.directManagerChanges.length} /><ImpactCard label="Penyetuju cuti unit berubah" count={impact.unitApproverChanges.length} /><ImpactCard label="Jalur kewenangan terpengaruh" count={impact.authorityPathsAffected.length} /><ImpactCard label="Jabatan kosong" count={impact.vacantAuthorities.length} tone="warning" /><ImpactCard label="Atasan belum bisa ditentukan" count={impact.unresolvedEmployees.length} tone="warning" /><ImpactCard label="Hanya tampilan" count={impact.visualOnlyChanges.length} tone="visual" /></div>
      </section> : null}

      {hasActiveDraft ? <section className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.7fr)]">
        <article className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
          <div className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-brand-primary-deep" /><h2 className="text-base font-bold text-brand-heading">Cek persetujuan cuti</h2></div>
          <p className="mt-1 text-xs text-muted-foreground">Server yang menentukan siapa menyetujui, termasuk Plt dan jabatan kosong. Layar ini tidak menebak atasan.</p>
          <form onSubmit={(event) => void runResolutionPreview(event)} className="mt-4 flex flex-col gap-2 sm:flex-row">
            <select required value={previewEmployeeId} onChange={(event) => setPreviewEmployeeId(event.target.value)} className={`${inputClass} min-w-0 flex-1`}>
              <option value="">Pilih pegawai...</option>
              {employees.filter(isActiveEmployee).map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName} — {employee.employeeNumber}</option>)}
            </select>
            <button type="submit" disabled={previewLoading || !previewEmployeeId} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">{previewLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Lihat</button>
          </form>
          {preview ? <div className="mt-4 rounded-xl bg-surface p-4"><p className="text-xs font-bold text-brand-heading">{preview.employee.fullName}</p><div className="mt-3 flex flex-wrap items-center gap-2">{preview.steps.map((step, index) => <div key={`${step.employeeId}-${index}`} className="contents"><span className="rounded-xl border border-border bg-surface-raised px-3 py-2 text-xs"><span className="font-bold">{step.employeeName}</span>{step.positionTitle ? <span className="block text-[10px] text-muted-foreground">{step.positionTitle}</span> : null}</span>{index < preview.steps.length - 1 ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : null}</div>)}{preview.steps.length === 0 ? <span className="text-xs text-muted-foreground">Atasan belum bisa ditentukan untuk pegawai ini.</span> : null}</div>{preview.oversight ? <p className="mt-3 text-xs text-muted-foreground">Setelah disetujui, yang diberi tahu: <span className="font-bold text-brand-heading">{preview.oversight.employeeName}</span></p> : null}<p className="mt-3 text-[11px] text-muted-foreground">Pengajuan yang sudah dikirim tidak berubah bila struktur diubah.</p></div> : null}
        </article>
        <article className="rounded-2xl border border-info-line bg-info-soft p-5"><h2 className="text-sm font-bold text-info-ink">Pengajuan yang sudah dikirim aman</h2><p className="mt-2 text-xs leading-5 text-info-ink">Menerbitkan struktur hanya memengaruhi pengajuan baru pada tanggal berlakunya. Penyetuju pada pengajuan yang sudah dikirim tidak dihitung ulang.</p></article>
      </section> : null}

      {confirmation ? <Modal title={confirmation.title} onClose={() => setConfirmation(null)}>
        <p className="text-sm leading-6 text-foreground">{confirmation.body}</p>
        <div className="mt-6 flex justify-end gap-2 border-t border-border/70 pt-4">
          <button type="button" onClick={() => setConfirmation(null)} className="h-10 rounded-xl border border-border px-4 text-sm font-semibold hover:bg-muted">Batal</button>
          <button type="button" disabled={saving} onClick={() => void runConfirmation()} className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground hover:bg-brand-primary-deep disabled:opacity-60">
            {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
            {saving ? "Menyimpan..." : confirmation.confirmLabel}
          </button>
        </div>
      </Modal> : null}

      {action?.type === "draft" ? <Modal title="Mulai perubahan struktur" description="Perubahan disusun terpisah. Struktur yang sudah terbit dan riwayatnya tidak pernah ditimpa." onClose={() => setAction(null)}><form onSubmit={handleDraft} className="space-y-4"><Field label="Nama perubahan"><input name="name" required defaultValue={`Perubahan struktur ${effectiveDate}`} className={inputClass} /></Field><Field label="Berlaku mulai" hint="Asia/Jakarta"><input name="effectiveOn" type="date" required min={jakartaToday()} defaultValue={effectiveDate < jakartaToday() ? jakartaToday() : effectiveDate} className={inputClass} /></Field><SubmitRow saving={saving} onCancel={() => setAction(null)} label="Mulai perubahan" /></form></Modal> : null}

      {action?.type === "node" ? <Modal title={action.mode === "edit" ? "Ganti nama atau pindahkan unit" : action.mode === "sibling" ? "Tambah unit sejajar" : action.mode === "child" ? "Tambah unit di bawah" : "Tambah unit pertama"} description="Unit adalah wadah organisasi. Jabatan ditambahkan terpisah." onClose={() => setAction(null)}><form onSubmit={(event) => handleNode(event, action)} className="space-y-4"><Field label="Nama unit"><input name="name" required defaultValue={action.mode === "edit" ? action.node?.name : ""} placeholder="Contoh: Bidang Pendidikan" className={inputClass} /></Field><Field label="Jenis unit"><select name="nodeType" defaultValue={action.node?.nodeType ?? "UNIT"} className={inputClass}>{["FOUNDATION", "DIRECTORATE", "UNIT", "DIVISION", "DEPARTMENT", "TEAM"].map((value) => <option key={value} value={value}>{organizationNodeTypeLabel(value)}</option>)}</select></Field><Field label="Berada di bawah unit"><select name="parentNodeKey" defaultValue={action.mode === "child" ? action.node?.stableKey ?? "" : action.mode === "sibling" ? action.node?.parentNodeKey ?? "" : action.node?.parentNodeKey ?? ""} className={inputClass}><option value="">Tidak ada — paling atas</option>{selectableOrganizationParents(data?.nodes ?? [], action.mode, action.node?.stableKey).map((node) => <option key={node.stableKey} value={node.stableKey}>{node.name}</option>)}</select></Field><Field label="Tampilan" hint="tidak memengaruhi persetujuan"><select name="visualRankOffset" defaultValue={action.node?.visualRankOffset ?? 0} className={inputClass}><option value="0">Sejajar dengan tingkat sebenarnya</option><option value="1">Turunkan 1 tingkat</option><option value="2">Turunkan 2 tingkat</option></select></Field><Field label="Kode integrasi" hint="opsional"><input name="integrationCode" defaultValue={action.node?.integrationCode ?? ""} className={inputClass} /></Field><SubmitRow saving={saving} onCancel={() => setAction(null)} label={action.mode === "edit" ? "Simpan perubahan" : "Tambah unit"} /></form></Modal> : null}

      {action?.type === "position" ? <Modal title={action.mode === "edit" ? "Ubah atau pindahkan jabatan" : "Tambah jabatan"} description="Judul jabatan hanya tampilan; kewenangan selalu dari pilihan yang Anda tetapkan." onClose={() => setAction(null)}><form onSubmit={(event) => handlePosition(event, action)} className="space-y-4"><Field label="Nama jabatan"><input name="title" required defaultValue={action.position?.title ?? ""} placeholder="Contoh: Kepala Bidang Pendidikan" className={inputClass} /></Field><Field label="Berada di unit"><select name="nodeKey" required defaultValue={action.position?.nodeKey ?? action.nodeKey} className={inputClass}>{data?.nodes.map((node) => <option key={node.stableKey} value={node.stableKey}>{node.name}</option>)}</select></Field><Field label="Melapor ke"><select name="parentPositionKey" defaultValue={action.position?.parentPositionKey ?? action.parentPositionKey ?? ""} className={inputClass}><option value="">Mengikuti pemimpin unit</option>{data?.positions.filter((position) => position.stableKey !== action.position?.stableKey).map((position) => <option key={position.stableKey} value={position.stableKey}>{position.title}</option>)}</select></Field><Field label="Bila jabatan ini kosong"><select name="vacancyPolicy" defaultValue={action.position?.vacancyPolicy ?? "CLIMB_TO_PARENT"} className={inputClass}><option value="CLIMB_TO_PARENT">Naik ke atasan berikutnya</option><option value="REQUIRE_ACTING_OR_BLOCK">Wajib ada Plt, kalau tidak pengajuan ditahan</option><option value="BLOCK">Pengajuan ditahan</option></select></Field><input type="hidden" name="visualRankOffset" value={action.position?.visualRankOffset ?? 0} /><SubmitRow saving={saving} onCancel={() => setAction(null)} label={action.mode === "edit" ? "Simpan perubahan" : "Tambah jabatan"} /></form></Modal> : null}

      {action?.type === "incumbency" ? <Modal title={action.acting ? "Tunjuk Plt" : "Tetapkan pejabat"} description={action.acting ? "Plt selalu ditunjuk eksplisit dan berbatas tanggal; sistem tidak menyimpulkannya dari absensi." : "Menetapkan pejabat tidak memberikan role atau izin aplikasi apa pun."} onClose={() => setAction(null)}><form onSubmit={(event) => handleIncumbency(event, action)} className="space-y-4"><div className="rounded-xl bg-surface p-3 text-sm font-bold text-brand-heading">{action.position.title}</div><Field label="Pegawai"><EmployeePicker name="employeeId" required employees={employees} defaultValue={action.acting ? action.position.actingIncumbent?.employeeId ?? "" : action.position.primaryIncumbent?.employeeId ?? ""} /></Field>{action.acting ? <><Field label="Mulai"><input type="date" name="actingFrom" required defaultValue={action.position.actingIncumbent?.effectiveFrom ?? data?.draft?.effectiveOn} className={inputClass} /></Field><Field label="Sampai"><input type="date" name="actingTo" required defaultValue={action.position.actingIncumbent?.effectiveTo ?? ""} className={inputClass} /></Field></> : <Field label="Mulai menjabat"><input type="date" name="effectiveFrom" required defaultValue={action.position.primaryIncumbent?.effectiveFrom ?? data?.draft?.effectiveOn} className={inputClass} /></Field>}<SubmitRow saving={saving} onCancel={() => setAction(null)} label="Simpan" /></form></Modal> : null}

      {action?.type === "members" ? <MembersModal node={action.node} employees={employees} memberships={data?.memberships ?? []} saving={saving} onClose={() => setAction(null)} onSubmit={(event) => handleMembers(event, action)} /> : null}

      {action?.type === "visual" ? <Modal title="Atur tampilan kotak" description="Pengaturan ini hanya memindahkan kotak pada bagan. Atasan langsung, penyetuju cuti, dan kewenangan lain tidak berubah." onClose={() => setAction(null)}><form onSubmit={(event) => handleVisual(event, action)}><div className="rounded-xl border border-info-line bg-info-soft p-4 text-sm font-bold text-info-ink">{"name" in action.item ? action.item.name : action.item.title}</div><div className="mt-4 space-y-2">{[0, 1, 2].map((offset) => <label key={offset} className="flex cursor-pointer gap-3 rounded-xl border border-border p-3 hover:bg-muted"><input type="radio" name="visualRankOffset" value={offset} defaultChecked={action.item.visualRankOffset === offset} className="mt-0.5 accent-[var(--color-brand-primary)]" /><span><span className="block text-sm font-bold text-brand-heading">{offset === 0 ? "Sejajar dengan tingkat sebenarnya" : `Turunkan ${offset} tingkat`}</span><span className="mt-0.5 block text-[11px] text-muted-foreground">{offset === 0 ? "Ikuti kedalaman hubungan induk." : "Garis penghubung tetap menunjuk ke unit induk yang sebenarnya."}</span></span></label>)}</div><SubmitRow saving={saving} onCancel={() => setAction(null)} label="Simpan tampilan" /></form></Modal> : null}

      {action?.type === "authority" ? <Modal title="Atur pemimpin, penyetuju, dan atasan" description="Pilih peran dan jabatan yang memegangnya. Judul jabatan tidak pernah dipakai sebagai aturan." onClose={() => setAction(null)}><form onSubmit={(event) => handleAuthority(event, action)} className="space-y-4"><Field label="Peran"><select name="authorityType" className={inputClass}>{action.kind === "position" ? <><option value="SUPERVISORY_PARENT">Melapor ke</option><option value="GOVERNANCE_APPROVER">Penyetuju khusus untuk jabatan ini</option><option value="OVERSIGHT_PARENT">Diberi tahu setelah disetujui</option></> : <><option value="LEADER">Pemimpin unit (atasan langsung anggota unit)</option><option value="UNIT_APPROVER">Penyetuju cuti unit</option></>}</select></Field><Field label="Dipegang jabatan"><select name="targetPositionKey" required className={inputClass}><option value="">Pilih jabatan...</option>{data?.positions.map((position) => <option key={position.stableKey} value={position.stableKey}>{position.title}</option>)}</select></Field><Field label="Bila jabatan itu kosong"><select name="vacancyPolicy" defaultValue="CLIMB_TO_PARENT" className={inputClass}><option value="CLIMB_TO_PARENT">Naik ke atasan berikutnya</option><option value="REQUIRE_ACTING_OR_BLOCK">Wajib ada Plt, kalau tidak pengajuan ditahan</option><option value="BLOCK">Pengajuan ditahan</option></select></Field><SubmitRow saving={saving} onCancel={() => setAction(null)} label="Simpan" /></form></Modal> : null}
    </>
  );
}

/**
 * ORG-008-1 (gap P-1): search over the member list. Rows that do not match stay in the DOM but
 * hidden, because `PUT /memberships` replaces the whole member list — dropping a checked row from the
 * form would silently remove that member. Inactive employees are hidden the same way unless they are
 * already a member of this unit.
 */
function MembersModal({
  node,
  employees,
  memberships,
  saving,
  onClose,
  onSubmit,
}: {
  node: OrganizationNode;
  employees: OrganizationEmployeeOption[];
  memberships: OrganizationDesignerView["memberships"];
  saving: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [query, setQuery] = useState("");
  const memberIds = useMemo(
    () => new Set(memberships.filter((item) => item.nodeKey === node.stableKey).map((item) => item.employeeId)),
    [memberships, node.stableKey],
  );
  const visibleCount = employees.filter(
    (employee) => (isActiveEmployee(employee) || memberIds.has(employee.id)) && employeeMatches(employee, query),
  ).length;

  return (
    <Modal title={`Anggota unit · ${node.name}`} description="Anggota ditampilkan sebagai jumlah pada bagan agar struktur besar tetap mudah dibaca." onClose={onClose}>
      <form onSubmit={onSubmit}>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Cari nama, NIP, atau unit lama..."
          aria-label="Cari pegawai"
          className={`${inputClass} mb-3`}
        />
        <div className="max-h-[24rem] space-y-1 overflow-y-auto rounded-xl border border-border p-2">
          {employees.map((employee) => {
            const isMember = memberIds.has(employee.id);
            const visible = (isActiveEmployee(employee) || isMember) && employeeMatches(employee, query);
            return (
              <label key={employee.id} className={cn("flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-muted", visible ? "" : "hidden")}>
                <input type="checkbox" name="employeeIds" value={employee.id} defaultChecked={isMember} className="mt-1 h-4 w-4 accent-[var(--color-brand-primary)]" />
                <span>
                  <span className="block text-sm font-semibold text-brand-heading">{employee.fullName}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {employee.employeeNumber} · {employee.unitName ?? "Tanpa unit"}
                    {isActiveEmployee(employee) ? "" : " · sudah tidak aktif"}
                  </span>
                </span>
              </label>
            );
          })}
          {employees.length === 0 ? <p className="p-4 text-center text-sm text-muted-foreground">Daftar pegawai belum dapat ditampilkan.</p> : null}
          {employees.length > 0 && visibleCount === 0 ? <p className="p-4 text-center text-sm text-muted-foreground">Tidak ada pegawai aktif yang cocok dengan pencarian.</p> : null}
        </div>
        <SubmitRow saving={saving} onCancel={onClose} label="Simpan anggota" />
      </form>
    </Modal>
  );
}

export function AdminOrganizationPage() {
  const [initialState] = useState(initialDesignerState);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [effectiveDate, setEffectiveDate] = useState(initialState.effectiveDate);
  const [draftId, setDraftId] = useState<string | null>(initialState.draftId);
  const [data, setData] = useState<OrganizationDesignerView | null>(null);
  const [employees, setEmployees] = useState<OrganizationEmployeeOption[]>([]);
  const [employeesFailed, setEmployeesFailed] = useState(false);
  const [rollout, setRollout] = useState<OrganizationRolloutConfiguration | null>(null);
  const [rolloutFailed, setRolloutFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setData(await getOrganizationDesignerView({ effectiveDate, draftId }));
    } catch (cause) {
      setLoadError(errorMessage(cause, "Struktur organisasi tidak dapat dimuat."));
    } finally {
      setLoading(false);
    }
  };

  const loadEmployees = () => {
    setEmployeesFailed(false);
    void listOrganizationEmployees()
      .then(setEmployees)
      .catch(() => { setEmployees([]); setEmployeesFailed(true); });
  };

  useEffect(() => {
    updateDesignerUrl(effectiveDate, draftId);
    void reload();
  }, [effectiveDate, draftId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let mounted = true;
    void getCurrentSession().then((current) => { if (mounted) setSession(current); });
    void getOrganizationRollout()
      .then((value) => { if (mounted) setRollout(value); })
      .catch(() => { if (mounted) { setRollout(null); setRolloutFailed(true); } });
    loadEmployees();
    return () => { mounted = false; };
  }, []);

  return (
    <AdminShell
      active="organization"
      title="Struktur Organisasi"
      description="Lihat dan susun unit, jabatan, dan pejabat berdasarkan tanggal berlaku. Siapa menyetujui siapa tetap dihitung dan diperiksa oleh server."
    >
      {loadError ? <div role="alert" className="mb-4 flex items-start gap-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{loadError}</span></div> : null}
      <OrganizationDesignerWorkspace
        session={session}
        view={data}
        rollout={rollout}
        rolloutFailed={rolloutFailed}
        employees={employees}
        employeesFailed={employeesFailed}
        loading={loading}
        effectiveDate={effectiveDate}
        onEffectiveDateChange={setEffectiveDate}
        onDraftIdChange={setDraftId}
        onReload={reload}
        onRetryEmployees={loadEmployees}
      />
    </AdminShell>
  );
}
