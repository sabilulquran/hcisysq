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
  LoaderCircle,
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
import {
  createOrganizationAuthorityBinding,
  createOrganizationDraft,
  createOrganizationNode,
  createOrganizationPosition,
  getOrganizationDesignerView,
  getOrganizationImpact,
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
  type OrganizationValidationReport,
  type OrganizationVacancyPolicy,
} from "@/lib/organizationDesigner";
import { cn } from "@/lib/utils";
import { selectableOrganizationParents } from "@/lib/organizationTree";

type EditorAction =
  | { type: "draft" }
  | { type: "node"; mode: "root" | "child" | "sibling" | "edit"; node?: OrganizationNode }
  | { type: "position"; mode: "create" | "edit"; nodeKey: string; parentPositionKey?: string | null; position?: OrganizationPosition }
  | { type: "incumbency"; position: OrganizationPosition; acting: boolean }
  | { type: "members"; node: OrganizationNode }
  | { type: "visual"; item: OrganizationNode | OrganizationPosition; kind: "node" | "position" }
  | { type: "authority"; item: OrganizationNode | OrganizationPosition; kind: "node" | "position" };

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

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof AdminApiError ? cause.message : fallback;
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
  if (mode === "HISTORICAL") return { label: "Historis", className: "bg-muted text-foreground" };
  if (mode === "FUTURE") return { label: "Terjadwal", className: "bg-info-soft text-info-ink" };
  if (mode === "DRAFT") return { label: "Draft", className: "bg-warning-soft text-warning-ink" };
  return { label: "Saat ini", className: "bg-success-soft text-success-ink" };
}

function ImpactCard({ label, count, tone = "default" }: { label: string; count: number; tone?: "default" | "warning" | "visual" }) {
  return (
    <div className={cn("rounded-xl border px-3 py-3", tone === "warning" ? "border-warning-line bg-warning-soft" : tone === "visual" ? "border-info-line bg-info-soft" : "border-border/70 bg-surface")}>
      <p className="text-xl font-bold text-brand-heading">{count}</p>
      <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{label}</p>
    </div>
  );
}

export function AdminOrganizationPage() {
  const [initialState] = useState(initialDesignerState);
  const [effectiveDate, setEffectiveDate] = useState(initialState.effectiveDate);
  const [draftId, setDraftId] = useState<string | null>(initialState.draftId);
  const [data, setData] = useState<OrganizationDesignerView | null>(null);
  const [employees, setEmployees] = useState<OrganizationEmployeeOption[]>([]);
  const [selection, setSelection] = useState<OrganizationSelection>(null);
  const [action, setAction] = useState<EditorAction | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [validation, setValidation] = useState<OrganizationValidationReport | null>(null);
  const [impact, setImpact] = useState<OrganizationImpactPreview | null>(null);
  const [preview, setPreview] = useState<OrganizationResolutionPreview | null>(null);
  const [previewEmployeeId, setPreviewEmployeeId] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getOrganizationDesignerView({ effectiveDate, draftId }));
    } catch (cause) {
      setError(errorMessage(cause, "Struktur organisasi tidak dapat dimuat."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    updateDesignerUrl(effectiveDate, draftId);
    void reload();
  }, [effectiveDate, draftId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void listOrganizationEmployees().then(setEmployees).catch(() => setEmployees([])); }, []);

  const selectedNode = useMemo(
    () => selection?.kind === "node" ? data?.nodes.find((node) => node.stableKey === selection.key) ?? null : null,
    [data?.nodes, selection],
  );
  const selectedPosition = useMemo(
    () => selection?.kind === "position" ? data?.positions.find((position) => position.stableKey === selection.key) ?? null : null,
    [data?.positions, selection],
  );
  const canEdit = data?.draft?.status === "DRAFT";
  const hasActiveDraft = data?.draft?.status === "DRAFT" || data?.draft?.status === "VALIDATED";
  const status = statusCopy(data?.mode ?? "CURRENT");

  const mutate = async (operation: () => Promise<unknown>, success: string) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
      setAction(null);
      setValidation(null);
      setImpact(null);
      setNotice(success);
      await reload();
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
        setDraftId(draft.id);
        setEffectiveDate(draft.effectiveOn);
        setAction(null);
        setNotice("Draft restrukturisasi siap diedit.");
      })
      .catch((cause: unknown) => setError(errorMessage(cause, "Draft tidak dapat dibuat.")))
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
      editor.mode === "edit" ? "Kelompok diperbarui." : "Kelompok ditambahkan ke chart.",
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
      editor.mode === "edit" ? "Posisi diperbarui." : "Posisi ditambahkan.",
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
      editor.acting ? "Pelaksana tugas diperbarui." : "Pejabat utama diperbarui.",
    );
  };

  const markVacant = (position: OrganizationPosition) => {
    if (!data?.draft) return;
    void mutate(
      () => replaceOrganizationIncumbencies(data.draft!.id, {
        positionKey: position.stableKey,
        primaryEmployeeId: null,
        actingEmployeeId: position.actingIncumbent?.employeeId ?? null,
        actingFrom: position.actingIncumbent?.effectiveFrom ?? null,
        actingTo: position.actingIncumbent?.effectiveTo ?? null,
        effectiveFrom: data.draft!.effectiveOn,
      }),
      "Posisi ditandai vacant. Kebijakan vacancy tetap diproses oleh resolver server.",
    );
  };

  const clearActing = (position: OrganizationPosition) => {
    if (!data?.draft) return;
    void mutate(
      () => replaceOrganizationIncumbencies(data.draft!.id, {
        positionKey: position.stableKey,
        primaryEmployeeId: position.primaryIncumbent?.employeeId ?? null,
        actingEmployeeId: null,
        effectiveFrom: data.draft!.effectiveOn,
      }),
      "Penugasan pelaksana tugas dihapus.",
    );
  };

  const handleMembers = (event: FormEvent<HTMLFormElement>, editor: Extract<EditorAction, { type: "members" }>) => {
    event.preventDefault();
    if (!data?.draft) return;
    const form = new FormData(event.currentTarget);
    void mutate(
      () => replaceOrganizationMemberships(data.draft!.id, { nodeKey: editor.node.stableKey, employeeIds: form.getAll("employeeIds").map(String), effectiveFrom: data.draft!.effectiveOn }),
      "Keanggotaan kelompok diperbarui.",
    );
  };

  const handleVisual = (event: FormEvent<HTMLFormElement>, editor: Extract<EditorAction, { type: "visual" }>) => {
    event.preventDefault();
    if (!data?.draft) return;
    const offset = Number(new FormData(event.currentTarget).get("visualRankOffset"));
    void mutate(
      () => editor.kind === "node" ? updateOrganizationNode(data.draft!.id, editor.item.id, { visualRankOffset: offset }) : updateOrganizationPosition(data.draft!.id, editor.item.id, { visualRankOffset: offset }),
      "Rank visual diperbarui tanpa mengubah hubungan struktural.",
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
      "Hubungan kewenangan disimpan.",
    );
  };

  const runValidation = async () => {
    if (!data?.draft) return;
    setSaving(true);
    setError(null);
    try {
      const report = await validateOrganizationDraft(data.draft.id);
      setValidation(report);
      setNotice(report.valid ? "Draft valid dan siap ditinjau dampaknya." : null);
      await reload();
    } catch (cause) {
      setError(errorMessage(cause, "Validasi draft gagal dijalankan."));
    } finally { setSaving(false); }
  };

  const runImpact = async () => {
    if (!data?.draft) return;
    setSaving(true);
    setError(null);
    try { setImpact(await getOrganizationImpact(data.draft.id)); }
    catch (cause) { setError(errorMessage(cause, "Preview dampak tidak dapat dimuat.")); }
    finally { setSaving(false); }
  };

  const runPublish = async () => {
    if (!data?.draft || !window.confirm(`Publikasikan struktur efektif ${displayDate(data.draft.effectiveOn)}?`)) return;
    setSaving(true);
    setError(null);
    try {
      await publishOrganizationDraft(data.draft.id);
      setDraftId(null);
      setSelection(null);
      setValidation(null);
      setImpact(null);
      setNotice("Struktur dipublikasikan. Struktur masa depan tidak aktif sebelum tanggal efektifnya.");
    } catch (cause) { setError(errorMessage(cause, "Draft tidak dapat dipublikasikan.")); }
    finally { setSaving(false); }
  };

  const runResolutionPreview = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!data?.draft || !previewEmployeeId) return;
    setPreviewLoading(true);
    setError(null);
    try { setPreview(await previewOrganizationResolution(data.draft.id, { employeeId: previewEmployeeId, workflowKey: "LEAVE", effectiveDate: data.draft.effectiveOn })); }
    catch (cause) { setError(errorMessage(cause, "Preview rantai approval tidak dapat dimuat.")); }
    finally { setPreviewLoading(false); }
  };

  return (
    <AdminShell active="organization" title="Organization Designer" description="Gambar struktur, posisi, dan kewenangan berdasarkan tanggal efektif. Hubungan approval tetap dihitung dan divalidasi oleh server.">
      {error ? <div role="alert" className="mb-4 flex items-start gap-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div> : null}
      {notice ? <div className="mb-4 flex items-start gap-3 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>{notice}</span></div> : null}

      <section className={cn("overflow-hidden rounded-3xl border bg-surface-raised shadow-[var(--shadow-soft)]", canEdit ? "border-warning-line ring-4 ring-warning-soft/60" : "border-border/70")}>
        <div className={cn("flex flex-col gap-4 border-b px-5 py-4 lg:flex-row lg:items-end lg:justify-between", canEdit ? "border-warning-line bg-warning-soft/60" : "border-border/70")}>
          <div className="flex flex-wrap items-center gap-3">
            <Field label="Lihat struktur pada tanggal"><span className="relative block"><CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><input type="date" value={effectiveDate} onChange={(event) => { setDraftId(null); setEffectiveDate(event.target.value); setSelection(null); }} className={`${inputClass} w-48 pl-9`} /></span></Field>
            <span className={cn("mb-0.5 self-end rounded-full px-3 py-2 text-xs font-bold", status.className)}>{status.label}</span>
            {data?.draft ? <div className="mb-0.5 self-end"><p className="text-xs font-bold text-warning-ink">{data.draft.name}</p><p className="text-[11px] text-warning-ink">Efektif {displayDate(data.draft.effectiveOn)} · {data.draft.status}</p></div> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {!hasActiveDraft ? <button type="button" onClick={() => setAction({ type: "draft" })} className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-surface-raised px-3 text-xs font-bold hover:bg-muted"><CalendarClock className="h-4 w-4" /> Jadwalkan perubahan</button> : <>
              {canEdit ? <button type="button" disabled={saving} onClick={() => void runValidation()} className="inline-flex h-10 items-center gap-2 rounded-xl border border-warning-line bg-surface-raised px-3 text-xs font-bold text-warning-ink hover:bg-warning-soft disabled:opacity-60"><ShieldCheck className="h-4 w-4" /> Validasi</button> : null}
              <button type="button" disabled={saving} onClick={() => void runImpact()} className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-surface-raised px-3 text-xs font-bold hover:bg-muted disabled:opacity-60"><Eye className="h-4 w-4" /> Preview dampak</button>
              <button type="button" disabled={saving || data?.draft?.status !== "VALIDATED"} onClick={() => void runPublish()} className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-3 text-xs font-bold text-brand-foreground hover:bg-brand-primary-deep disabled:opacity-50"><Rocket className="h-4 w-4" /> Publikasikan</button>
            </>}
          </div>
        </div>

        {canEdit && (selectedNode || selectedPosition) ? <div className="flex flex-col gap-3 border-b border-warning-line bg-surface-raised px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Dipilih</p><p className="mt-0.5 text-sm font-bold text-brand-heading">{selectedNode?.name ?? selectedPosition?.title}</p></div>
          <div className="flex flex-wrap gap-2">
            {selectedNode ? <>
              <ActionButton onClick={() => setAction({ type: "node", mode: "child", node: selectedNode })} icon={<GitBranchPlus />}>Tambah di bawah</ActionButton>
              <ActionButton onClick={() => setAction({ type: "node", mode: "sibling", node: selectedNode })} icon={<Plus />}>Tambah sejajar</ActionButton>
              <ActionButton onClick={() => setAction({ type: "position", mode: "create", nodeKey: selectedNode.stableKey })} icon={<BriefcaseBusiness />}>Tambah posisi</ActionButton>
              <ActionButton onClick={() => setAction({ type: "node", mode: "edit", node: selectedNode })} icon={<ArrowRightLeft />}>Edit / pindah</ActionButton>
              <ActionButton onClick={() => setAction({ type: "members", node: selectedNode })} icon={<UsersRound />}>Anggota</ActionButton>
              <ActionButton onClick={() => setAction({ type: "visual", item: selectedNode, kind: "node" })} icon={<ArrowDownToLine />}>Rank visual</ActionButton>
              <ActionButton onClick={() => setAction({ type: "authority", item: selectedNode, kind: "node" })} icon={<Network />}>Kewenangan</ActionButton>
            </> : selectedPosition ? <>
              <ActionButton onClick={() => setAction({ type: "position", mode: "create", nodeKey: selectedPosition.nodeKey, parentPositionKey: selectedPosition.stableKey })} icon={<GitBranchPlus />}>Posisi di bawah</ActionButton>
              <ActionButton onClick={() => setAction({ type: "position", mode: "create", nodeKey: selectedPosition.nodeKey, parentPositionKey: selectedPosition.parentPositionKey })} icon={<Plus />}>Posisi sejajar</ActionButton>
              <ActionButton onClick={() => setAction({ type: "incumbency", position: selectedPosition, acting: false })} icon={<CircleUserRound />}>Tetapkan pejabat</ActionButton>
              <ActionButton onClick={() => setAction({ type: "incumbency", position: selectedPosition, acting: true })} icon={<UserCog />}>Pelaksana tugas</ActionButton>
              {selectedPosition.actingIncumbent ? <ActionButton onClick={() => clearActing(selectedPosition)} icon={<X />}>Hapus acting</ActionButton> : null}
              <ActionButton onClick={() => markVacant(selectedPosition)} icon={<PanelRightClose />}>Tandai vacant</ActionButton>
              <ActionButton onClick={() => setAction({ type: "position", mode: "edit", nodeKey: selectedPosition.nodeKey, position: selectedPosition })} icon={<ArrowRightLeft />}>Edit / pindah</ActionButton>
              <ActionButton onClick={() => setAction({ type: "visual", item: selectedPosition, kind: "position" })} icon={<ArrowDownToLine />}>Rank visual</ActionButton>
              <ActionButton onClick={() => setAction({ type: "authority", item: selectedPosition, kind: "position" })} icon={<Network />}>Kewenangan</ActionButton>
            </> : null}
          </div>
        </div> : null}

        <div className="relative min-h-[34rem] overflow-auto bg-surface">
          {loading ? <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface-raised/70 text-sm font-semibold text-muted-foreground"><LoaderCircle className="mr-2 h-5 w-5 animate-spin" /> Memuat chart...</div> : null}
          <OrganizationChart nodes={data?.nodes ?? []} positions={data?.positions ?? []} selection={selection} onSelect={setSelection} canEdit={Boolean(canEdit)} onStart={startFromEmpty} />
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border/70 bg-surface-raised px-5 py-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm border border-brand-primary bg-brand-primary-pale" /> Posisi terisi</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm border border-dashed border-warning-line bg-warning-soft" /> Posisi vacant nyata</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-px w-5 bg-brand-primary/40" /> Hubungan struktural</span>
          <span className="inline-flex items-center gap-1.5"><ArrowDownToLine className="h-3.5 w-3.5 text-info-ink" /> Rank visual tidak mengubah reporting / approval</span>
        </div>
      </section>

      {validation ? <section className={cn("mt-5 rounded-2xl border p-5", validation.valid ? "border-success-line bg-success-soft" : "border-danger-line bg-danger-soft")}>
        <div className="flex items-center gap-2">{validation.valid ? <CheckCircle2 className="h-5 w-5 text-success-ink" /> : <AlertTriangle className="h-5 w-5 text-danger-ink" />}<h2 className="text-base font-bold text-brand-heading">{validation.valid ? "Draft valid" : "Draft perlu diperbaiki"}</h2></div>
        {validation.issues.length > 0 ? <ul className="mt-3 space-y-2 text-sm">{validation.issues.map((issue, index) => <li key={`${issue.code}-${index}`}><span className="font-bold">{issue.code}</span> — {issue.message}</li>)}</ul> : <p className="mt-2 text-sm text-success-ink">Tidak ada cycle, overlap, atau authority configuration error yang ditemukan server.</p>}
      </section> : null}

      {impact ? <section className="mt-5 rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <div className="flex items-start justify-between gap-4"><div><h2 className="text-base font-bold text-brand-heading">Dampak restrukturisasi</h2><p className="mt-1 text-xs text-muted-foreground">Hasil perbandingan dari server untuk tanggal efektif draft.</p></div>{impact.noApprovalRoutingImpact ? <span className="rounded-full bg-info-soft px-3 py-1.5 text-xs font-bold text-info-ink">Tidak ada dampak routing approval</span> : <span className="rounded-full bg-warning-soft px-3 py-1.5 text-xs font-bold text-warning-ink">Routing perlu ditinjau</span>}</div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6"><ImpactCard label="Atasan langsung berubah" count={impact.directManagerChanges.length} /><ImpactCard label="Unit approver berubah" count={impact.unitApproverChanges.length} /><ImpactCard label="Jalur kewenangan" count={impact.authorityPathsAffected.length} /><ImpactCard label="Kewenangan vacant" count={impact.vacantAuthorities.length} tone="warning" /><ImpactCard label="Pegawai unresolved" count={impact.unresolvedEmployees.length} tone="warning" /><ImpactCard label="Perubahan visual saja" count={impact.visualOnlyChanges.length} tone="visual" /></div>
      </section> : null}

      {hasActiveDraft ? <section className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.7fr)]">
        <article className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
          <div className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-brand-primary-deep" /><h2 className="text-base font-bold text-brand-heading">Preview rantai approval</h2></div>
          <p className="mt-1 text-xs text-muted-foreground">Server menyelesaikan kewenangan, vacancy, acting, capability, dan deduplikasi. Chart tidak menebak approver.</p>
          <form onSubmit={(event) => void runResolutionPreview(event)} className="mt-4 flex flex-col gap-2 sm:flex-row"><select required value={previewEmployeeId} onChange={(event) => setPreviewEmployeeId(event.target.value)} className={`${inputClass} min-w-0 flex-1`}><option value="">Pilih pegawai...</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName} — {employee.employeeNumber}</option>)}</select><button type="submit" disabled={previewLoading || !previewEmployeeId} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">{previewLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Preview</button></form>
          {preview ? <div className="mt-4 rounded-xl bg-surface p-4"><p className="text-xs font-bold text-brand-heading">{preview.employee.fullName}</p><div className="mt-3 flex flex-wrap items-center gap-2">{preview.steps.map((step, index) => <div key={`${step.employeeId}-${index}`} className="contents"><span className="rounded-xl border border-border bg-surface-raised px-3 py-2 text-xs"><span className="font-bold">{step.employeeName}</span>{step.authorityType ? <span className="block text-[10px] text-muted-foreground">{step.authorityType}</span> : null}</span>{index < preview.steps.length - 1 ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : null}</div>)}{preview.steps.length === 0 ? <span className="text-xs text-muted-foreground">Tidak ada approver yang terselesaikan.</span> : null}</div>{preview.oversight ? <p className="mt-3 text-xs text-muted-foreground">Setelah final approved, notifikasi oversight: <span className="font-bold text-brand-heading">{preview.oversight.employeeName}</span></p> : null}</div> : null}
        </article>
        <article className="rounded-2xl border border-info-line bg-info-soft p-5"><h2 className="text-sm font-bold text-info-ink">Snapshot approval tetap aman</h2><p className="mt-2 text-xs leading-5 text-info-ink">Publikasi struktur hanya memengaruhi transaksi baru pada tanggal efektif. Approver konkret pada permintaan yang sudah disubmit tidak dihitung ulang.</p></article>
      </section> : null}

      {action?.type === "draft" ? <Modal title="Jadwalkan perubahan struktur" description="Buat draft terpisah agar struktur terpublikasi dan riwayat sebelumnya tidak tertimpa." onClose={() => setAction(null)}><form onSubmit={handleDraft} className="space-y-4"><Field label="Nama draft"><input name="name" required defaultValue={`Restrukturisasi ${effectiveDate}`} className={inputClass} /></Field><Field label="Tanggal efektif" hint="Asia/Jakarta"><input name="effectiveOn" type="date" required min={jakartaToday()} defaultValue={effectiveDate < jakartaToday() ? jakartaToday() : effectiveDate} className={inputClass} /></Field><SubmitRow saving={saving} onCancel={() => setAction(null)} label="Buat draft" /></form></Modal> : null}

      {action?.type === "node" ? <Modal title={action.mode === "edit" ? "Edit atau pindahkan kelompok" : action.mode === "sibling" ? "Tambah kelompok sejajar" : action.mode === "child" ? "Tambah kelompok di bawah" : "Tambah kelompok pertama"} description="Kelompok adalah container organisasi. Posisi kewenangan ditambahkan secara terpisah." onClose={() => setAction(null)}><form onSubmit={(event) => handleNode(event, action)} className="space-y-4"><Field label="Nama kelompok / unit"><input name="name" required defaultValue={action.mode === "edit" ? action.node?.name : ""} placeholder="Contoh: Education Affairs" className={inputClass} /></Field><Field label="Jenis kelompok"><select name="nodeType" defaultValue={action.node?.nodeType ?? "UNIT"} className={inputClass}><option value="FOUNDATION">Foundation</option><option value="DIRECTORATE">Direktorat / bidang</option><option value="UNIT">Unit</option><option value="DIVISION">Divisi</option><option value="DEPARTMENT">Departemen</option><option value="TEAM">Tim</option></select></Field><Field label="Induk struktural"><select name="parentNodeKey" defaultValue={action.mode === "child" ? action.node?.stableKey ?? "" : action.mode === "sibling" ? action.node?.parentNodeKey ?? "" : action.node?.parentNodeKey ?? ""} className={inputClass}><option value="">Tidak ada — paling atas</option>{selectableOrganizationParents(data?.nodes ?? [], action.mode, action.node?.stableKey).map((node) => <option key={node.stableKey} value={node.stableKey}>{node.name}</option>)}</select></Field><Field label="Rank tampilan" hint="hanya presentasi chart"><select name="visualRankOffset" defaultValue={action.node?.visualRankOffset ?? 0} className={inputClass}><option value="0">Tingkat struktural normal</option><option value="1">Tampilkan 1 tingkat lebih rendah</option><option value="2">Tampilkan 2 tingkat lebih rendah</option></select></Field><Field label="Kode integrasi" hint="opsional"><input name="integrationCode" defaultValue={action.node?.integrationCode ?? ""} className={inputClass} /></Field><SubmitRow saving={saving} onCancel={() => setAction(null)} label={action.mode === "edit" ? "Simpan perubahan" : "Tambah kelompok"} /></form></Modal> : null}

      {action?.type === "position" ? <Modal title={action.mode === "edit" ? "Edit atau pindahkan posisi" : "Tambah posisi"} description="Judul posisi adalah data tampilan; resolver memakai hubungan kewenangan yang dikonfigurasi." onClose={() => setAction(null)}><form onSubmit={(event) => handlePosition(event, action)} className="space-y-4"><Field label="Judul posisi"><input name="title" required defaultValue={action.position?.title ?? ""} placeholder="Contoh: Head of Education Affairs" className={inputClass} /></Field><Field label="Berada di kelompok"><select name="nodeKey" required defaultValue={action.position?.nodeKey ?? action.nodeKey} className={inputClass}>{data?.nodes.map((node) => <option key={node.stableKey} value={node.stableKey}>{node.name}</option>)}</select></Field><Field label="Posisi atasan struktural"><select name="parentPositionKey" defaultValue={action.position?.parentPositionKey ?? action.parentPositionKey ?? ""} className={inputClass}><option value="">Tidak ada / mengikuti leader kelompok</option>{data?.positions.filter((position) => position.stableKey !== action.position?.stableKey).map((position) => <option key={position.stableKey} value={position.stableKey}>{position.title}</option>)}</select></Field><Field label="Ketika posisi vacant"><select name="vacancyPolicy" defaultValue={action.position?.vacancyPolicy ?? "CLIMB_TO_PARENT"} className={inputClass}><option value="CLIMB_TO_PARENT">Naik ke kewenangan struktural di atas</option><option value="REQUIRE_ACTING_OR_BLOCK">Wajib pelaksana tugas atau blokir</option><option value="BLOCK">Blokir jika vacant</option></select></Field><input type="hidden" name="visualRankOffset" value={action.position?.visualRankOffset ?? 0} /><SubmitRow saving={saving} onCancel={() => setAction(null)} label={action.mode === "edit" ? "Simpan perubahan" : "Tambah posisi"} /></form></Modal> : null}

      {action?.type === "incumbency" ? <Modal title={action.acting ? "Tetapkan pelaksana tugas" : "Tetapkan pejabat utama"} description={action.acting ? "Acting authority selalu eksplisit dan berbatas tanggal; sistem tidak menginferensikannya dari absensi." : "Penetapan ini tidak otomatis memberikan role atau permission aplikasi."} onClose={() => setAction(null)}><form onSubmit={(event) => handleIncumbency(event, action)} className="space-y-4"><div className="rounded-xl bg-surface p-3 text-sm font-bold text-brand-heading">{action.position.title}</div><Field label="Pegawai"><select name="employeeId" required defaultValue={action.acting ? action.position.actingIncumbent?.employeeId ?? "" : action.position.primaryIncumbent?.employeeId ?? ""} className={inputClass}><option value="">Pilih pegawai...</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName} — {employee.employeeNumber}</option>)}</select></Field>{action.acting ? <><Field label="Mulai acting"><input type="date" name="actingFrom" required defaultValue={action.position.actingIncumbent?.effectiveFrom ?? data?.draft?.effectiveOn} className={inputClass} /></Field><Field label="Berakhir acting"><input type="date" name="actingTo" required defaultValue={action.position.actingIncumbent?.effectiveTo ?? ""} className={inputClass} /></Field></> : <Field label="Mulai menjabat"><input type="date" name="effectiveFrom" required defaultValue={action.position.primaryIncumbent?.effectiveFrom ?? data?.draft?.effectiveOn} className={inputClass} /></Field>}<SubmitRow saving={saving} onCancel={() => setAction(null)} label="Simpan penetapan" /></form></Modal> : null}

      {action?.type === "members" ? <Modal title={`Kelola anggota · ${action.node.name}`} description="Anggota biasa diringkas sebagai jumlah pada chart agar struktur besar tetap mudah dibaca." onClose={() => setAction(null)}><form onSubmit={(event) => handleMembers(event, action)}><div className="max-h-[24rem] space-y-1 overflow-y-auto rounded-xl border border-border p-2">{employees.map((employee) => { const checked = data?.memberships.some((membership) => membership.nodeKey === action.node.stableKey && membership.employeeId === employee.id); return <label key={employee.id} className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-muted"><input type="checkbox" name="employeeIds" value={employee.id} defaultChecked={checked} className="mt-1 h-4 w-4 accent-[var(--color-brand-primary)]" /><span><span className="block text-sm font-semibold text-brand-heading">{employee.fullName}</span><span className="text-[11px] text-muted-foreground">{employee.employeeNumber} · {employee.unitName ?? "Tanpa unit"}</span></span></label>; })}{employees.length === 0 ? <p className="p-4 text-center text-sm text-muted-foreground">Daftar pegawai aktif belum tersedia.</p> : null}</div><SubmitRow saving={saving} onCancel={() => setAction(null)} label="Simpan anggota" /></form></Modal> : null}

      {action?.type === "visual" ? <Modal title="Atur rank visual" description="Pengaturan ini hanya mengubah posisi kotak pada chart. Reporting, Direct Manager, Unit Approver, dan kewenangan lain tidak berubah." onClose={() => setAction(null)}><form onSubmit={(event) => handleVisual(event, action)}><div className="rounded-xl border border-info-line bg-info-soft p-4 text-sm font-bold text-info-ink">{"name" in action.item ? action.item.name : action.item.title}</div><div className="mt-4 space-y-2">{[0, 1, 2].map((offset) => <label key={offset} className="flex cursor-pointer gap-3 rounded-xl border border-border p-3 hover:bg-muted"><input type="radio" name="visualRankOffset" value={offset} defaultChecked={action.item.visualRankOffset === offset} className="mt-0.5 accent-[var(--color-brand-primary)]" /><span><span className="block text-sm font-bold text-brand-heading">{offset === 0 ? "Tingkat struktural normal" : `Tampilkan ${offset} tingkat lebih rendah`}</span><span className="mt-0.5 block text-[11px] text-muted-foreground">{offset === 0 ? "Ikuti kedalaman hubungan induk." : "Garis konektor tetap menunjuk ke induk struktural sebenarnya."}</span></span></label>)}</div><SubmitRow saving={saving} onCancel={() => setAction(null)} label="Simpan rank visual" /></form></Modal> : null}

      {action?.type === "authority" ? <Modal title="Konfigurasi kewenangan" description="Pilih hubungan semantik dan posisi target. Nama jabatan tidak dipakai sebagai business rule." onClose={() => setAction(null)}><form onSubmit={(event) => handleAuthority(event, action)} className="space-y-4"><Field label="Jenis kewenangan"><select name="authorityType" className={inputClass}>{action.kind === "position" ? <><option value="SUPERVISORY_PARENT">Atasan struktural</option><option value="GOVERNANCE_APPROVER">Governance approver</option><option value="OVERSIGHT_PARENT">Oversight di atas approver</option></> : <><option value="LEADER">Leader kelompok</option><option value="UNIT_APPROVER">Unit approver</option></>}</select></Field><Field label="Posisi target"><select name="targetPositionKey" required className={inputClass}><option value="">Pilih posisi...</option>{data?.positions.map((position) => <option key={position.stableKey} value={position.stableKey}>{position.title}</option>)}</select></Field><Field label="Jika posisi target vacant"><select name="vacancyPolicy" defaultValue="CLIMB_TO_PARENT" className={inputClass}><option value="CLIMB_TO_PARENT">Naik ke atas</option><option value="REQUIRE_ACTING_OR_BLOCK">Wajib acting atau blokir</option><option value="BLOCK">Blokir</option></select></Field><SubmitRow saving={saving} onCancel={() => setAction(null)} label="Simpan kewenangan" /></form></Modal> : null}
    </AdminShell>
  );
}

function ActionButton({ onClick, icon, children }: { onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return <button type="button" onClick={onClick} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border bg-surface-raised px-2.5 text-[11px] font-bold hover:border-brand-primary/40 hover:bg-brand-primary-pale/30 [&_svg]:h-3.5 [&_svg]:w-3.5">{icon}{children}</button>;
}
