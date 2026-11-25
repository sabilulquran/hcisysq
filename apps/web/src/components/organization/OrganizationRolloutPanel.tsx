// ORG-004 D-R7 (2026-11-25): the rollout switch from a screen.
//
// `PATCH /admin/organization/rollout` and `POST /admin/organization/rollout/:id/end` existed with
// no caller anywhere in the app, so moving one unit onto the published chart — and the rollback
// that OPS-OPEN-001 §7.8 names as the pilot's way back — could only be done by writing SQL against
// production. A routing switch whose only operation is `psql` has no audit trail of who turned it
// on and no way for the person who owns the rollback to use it.
//
// One row on a node reaches that node's whole subtree at any depth, so the node chosen IS the
// scope: a row on the root moves the entire foundation. The panel says so where the node is
// picked, not in a document.

import { Loader2, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import { DetailDialog, useDialogParam } from "@/components/DetailDialog";
import {
  endOrganizationRollout,
  updateOrganizationRollout,
  type OrganizationNode,
  type OrganizationRolloutConfiguration,
  type OrganizationRolloutSetting,
} from "@/lib/organizationDesigner";
import {
  ROLLOUT_MODE_WORDING,
  ROLLOUT_WORKFLOW_KEYS,
  ROLLOUT_WORKFLOW_WORDING,
} from "@/lib/organizationLanguage";

const WHOLE_FOUNDATION = "Seluruh yayasan";
/** Scope that writes `node_key = NULL`. Never the initial value of the field: see `AddRolloutDialog`. */
const WHOLE_FOUNDATION_VALUE = "SELURUH_YAYASAN";

function workflowLabel(key: string) {
  return ROLLOUT_WORKFLOW_WORDING[key] ?? key;
}

function modeLabel(mode: string) {
  return ROLLOUT_MODE_WORDING[mode] ?? mode;
}

/** ISO date shifted by whole days, in UTC, so no timezone can move it onto another day. */
function shiftIsoDay(isoDate: string, days: number) {
  const base = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return isoDate;
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function nodeLabel(nodes: OrganizationNode[], key: string | null) {
  if (!key) return WHOLE_FOUNDATION;
  return nodes.find((node) => node.stableKey === key)?.name ?? key;
}

export function OrganizationRolloutPanel({
  rollout,
  nodes,
  today,
  canManage,
  onChanged,
}: {
  rollout: OrganizationRolloutConfiguration | null;
  /** Units of the chart being looked at; stable keys carry across change sets. */
  nodes: OrganizationNode[];
  today: string;
  /** `approvals.policy.manage`; the routes authorize again regardless of what this screen shows. */
  canManage: boolean;
  onChanged: () => void | Promise<void>;
}) {
  // SQ app-shell rule: a form opens as a pop-up named in the URL, so Back closes it and the state
  // is reachable without first clicking through the page.
  const [addParam, openAdd, closeAdd] = useDialogParam("mode-persetujuan");
  const [endParam, openEnd, closeEnd] = useDialogParam("akhiri-mode");

  const settings = rollout?.settings ?? [];
  const adding = canManage && addParam === "baru";
  const ending = canManage
    ? settings.find((setting) => setting.id && setting.id === endParam && !setting.effectiveTo) ?? null
    : null;

  return (
    <section className="mb-4 rounded-2xl border border-border/70 bg-surface-raised p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-brand-heading">Mode persetujuan per unit</h3>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
            Unit yang dipindahkan ke <b>struktur ini</b> mengambil atasan dan penyetujunya dari
            bagan, bukan dari kolom atasan di Detail Pegawai. Unit yang tidak terdaftar di sini
            tetap memakai data atasan lama. Pengajuan yang sudah dikirim tidak ikut berubah.
          </p>
        </div>
        {canManage ? (
          <button
            type="button"
            onClick={() => openAdd("baru")}
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> Pindahkan unit
          </button>
        ) : null}
      </div>

      {settings.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Belum ada unit yang dipindahkan. Seluruh persetujuan memakai data atasan lama.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border/70 text-sm">
          {settings.map((setting, index) => (
            <li
              key={setting.id ?? `${setting.workflowKey}:${setting.organizationalNodeKey ?? "root"}:${index}`}
              className="flex flex-wrap items-start justify-between gap-3 py-2"
            >
              <div className="min-w-0">
                <p className="font-semibold text-brand-heading">
                  {nodeLabel(nodes, setting.organizationalNodeKey)} · {workflowLabel(setting.workflowKey)}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Memakai {modeLabel(setting.mode)} · berlaku {setting.effectiveFrom}
                  {setting.effectiveTo ? ` sampai ${setting.effectiveTo}` : ""}
                  {setting.organizationalNodeKey ? " · termasuk seluruh bagian di bawahnya" : ""}
                </p>
                {setting.reason ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">{setting.reason}</p>
                ) : null}
              </div>
              {canManage && setting.id && !setting.effectiveTo ? (
                <button
                  type="button"
                  onClick={() => openEnd(setting.id!)}
                  className="h-9 shrink-0 rounded-xl border border-border bg-surface-raised px-3 text-xs font-bold text-brand-heading"
                >
                  Akhiri
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <AddRolloutDialog
          nodes={nodes}
          today={today}
          onClose={closeAdd}
          onDone={async () => { closeAdd(); await onChanged(); }}
        />
      ) : null}
      {ending ? (
        <EndRolloutDialog
          setting={ending}
          label={`${nodeLabel(nodes, ending.organizationalNodeKey)} · ${workflowLabel(ending.workflowKey)}`}
          today={today}
          onClose={closeEnd}
          onDone={async () => { closeEnd(); await onChanged(); }}
        />
      ) : null}
    </section>
  );
}

function AddRolloutDialog({
  nodes,
  today,
  onClose,
  onDone,
}: {
  nodes: OrganizationNode[];
  today: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [nodeKey, setNodeKey] = useState("");
  const [workflowKey, setWorkflowKey] = useState("leave.annual");
  const [mode, setMode] = useState<"STRUCTURE" | "SHADOW" | "LEGACY">("STRUCTURE");
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ENG-LIST-001: the list is filtered in the page because the whole chart is already loaded here;
  // nothing is cut off silently — the count below says how many of how many are shown.
  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const sorted = [...nodes].sort((a, b) => a.name.localeCompare(b.name, "id"));
    return needle ? sorted.filter((node) => node.name.toLowerCase().includes(needle)) : sorted;
  }, [nodes, search]);

  const submit = async () => {
    // The widest possible scope must be chosen on purpose. An empty field is not "the whole
    // foundation": a row with no node moves all ~97 employees at once, and that is not something
    // an operator should be able to do by leaving a select alone.
    if (!nodeKey) {
      setError("Pilih unit lebih dulu, atau pilih Seluruh yayasan dengan sengaja.");
      return;
    }
    if (!effectiveFrom) {
      setError("Isi tanggal mulai berlaku.");
      return;
    }
    if (!reason.trim()) {
      setError("Tulis alasan pemindahan; alasan ini tersimpan di jurnal organisasi.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateOrganizationRollout({
        mode,
        workflowKey,
        organizationalNodeKey: nodeKey === WHOLE_FOUNDATION_VALUE ? null : nodeKey,
        effectiveFrom,
        reason: reason.trim(),
      });
      await onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pengaturan tidak dapat disimpan.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <DetailDialog
      title="Pindahkan unit ke struktur"
      description="Berlaku untuk unit yang dipilih dan seluruh bagian di bawahnya."
      onClose={busy ? () => undefined : onClose}
    >
      <label className="block text-xs font-semibold text-brand-heading">
        Cari unit
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Ketik sebagian nama unit"
          className="mt-1 h-11 w-full rounded-xl border border-border bg-surface-raised px-3 text-sm font-normal"
        />
      </label>
      <label className="mt-2 block text-xs font-semibold text-brand-heading">
        Unit
        <select
          value={nodeKey}
          onChange={(event) => setNodeKey(event.target.value)}
          className="mt-1 h-11 w-full rounded-xl border border-border bg-surface-raised px-2 text-sm font-normal"
        >
          <option value="">— pilih unit —</option>
          {matches.map((node) => (
            <option key={node.stableKey} value={node.stableKey}>{node.name}</option>
          ))}
          <option value={WHOLE_FOUNDATION_VALUE}>{WHOLE_FOUNDATION} — seluruh pegawai sekaligus</option>
        </select>
      </label>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {matches.length} dari {nodes.length} unit ditampilkan.
        {nodeKey === WHOLE_FOUNDATION_VALUE
          ? " Pilihan ini memindahkan seluruh yayasan sekaligus, bukan satu unit."
          : " Unit yang dipilih berlaku beserta seluruh bagian di bawahnya."}
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="block text-xs font-semibold text-brand-heading">
          Jenis pengajuan
          <select
            value={workflowKey}
            onChange={(event) => setWorkflowKey(event.target.value)}
            className="mt-1 h-11 w-full rounded-xl border border-border bg-surface-raised px-2 text-sm font-normal"
          >
            {ROLLOUT_WORKFLOW_KEYS.map((key) => (
              <option key={key} value={key}>{workflowLabel(key)}</option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-semibold text-brand-heading">
          Sumber atasan
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as "STRUCTURE" | "SHADOW" | "LEGACY")}
            className="mt-1 h-11 w-full rounded-xl border border-border bg-surface-raised px-2 text-sm font-normal"
          >
            <option value="STRUCTURE">Struktur ini</option>
            <option value="SHADOW">Uji banding (data lama tetap dipakai)</option>
            <option value="LEGACY">Data atasan lama</option>
          </select>
        </label>
      </div>
      <label className="mt-2 block text-xs font-semibold text-brand-heading">
        Berlaku mulai
        <input
          type="date"
          value={effectiveFrom}
          onChange={(event) => setEffectiveFrom(event.target.value)}
          className="mt-1 h-11 w-full rounded-xl border border-border bg-surface-raised px-2 text-sm font-normal"
        />
      </label>
      <label className="mt-2 block text-xs font-semibold text-brand-heading">
        Alasan
        <textarea
          value={reason}
          rows={2}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Misalnya: pilot Cuti Tahunan Taman Tahfizh"
          className="mt-1 w-full rounded-xl border border-border bg-surface-raised px-3 py-2 text-sm font-normal"
        />
      </label>
      {error ? <p className="mt-2 text-xs font-semibold text-danger-ink" role="alert">{error}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-3 text-xs font-bold text-brand-foreground disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          Simpan pengaturan
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="min-h-11 rounded-xl border border-border bg-surface-raised px-3 text-xs font-bold text-brand-heading disabled:opacity-50"
        >
          Batal
        </button>
      </div>
    </DetailDialog>
  );
}

function EndRolloutDialog({
  setting,
  label,
  today,
  onClose,
  onDone,
}: {
  setting: OrganizationRolloutSetting;
  label: string;
  today: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  // Server rule (D-R4): the earliest last day is today, except for a setting that has not started
  // yet, which ends the day before it starts. Defaulting to today for a future-dated row would be
  // refused with `ORGANIZATION_ROLLOUT_END_TOO_EARLY` on a form the operator never touched.
  const earliest = [shiftIsoDay(setting.effectiveFrom, -1), today].sort().at(-1)!;
  const [reason, setReason] = useState("");
  const [lastDay, setLastDay] = useState(earliest);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (reason.trim().length < 3) {
      setError("Tulis alasan mengakhiri, minimal 3 karakter.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await endOrganizationRollout(setting.id!, { reason: reason.trim(), lastDay });
      await onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pengaturan tidak dapat diakhiri.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <DetailDialog
      title="Akhiri pengaturan"
      description={label}
      onClose={busy ? () => undefined : onClose}
    >
      <p className="text-sm text-muted-foreground">
        Setelah hari terakhir, unit ini kembali memakai data atasan lama. Pengajuan yang sudah
        dikirim memegang rantai penyetujunya sendiri dan tidak berubah.
      </p>
      <label className="mt-3 block text-xs font-semibold text-brand-heading">
        Hari terakhir berlaku
        <input
          type="date"
          value={lastDay}
          min={earliest}
          onChange={(event) => setLastDay(event.target.value)}
          className="mt-1 h-11 w-full rounded-xl border border-border bg-surface-raised px-2 text-sm font-normal"
        />
      </label>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Paling awal {earliest}
        {earliest === today
          ? ": pengaturan yang berlaku hari ini sudah menjelaskan setiap rantai yang diselesaikan hari ini."
          : `, yaitu sehari sebelum pengaturan ini mulai berlaku (${setting.effectiveFrom}), sehingga masa berlakunya kosong.`}
      </p>
      <label className="mt-2 block text-xs font-semibold text-brand-heading">
        Alasan
        <textarea
          value={reason}
          rows={2}
          maxLength={1000}
          onChange={(event) => setReason(event.target.value)}
          className="mt-1 w-full rounded-xl border border-border bg-surface-raised px-3 py-2 text-sm font-normal"
        />
      </label>
      {error ? <p className="mt-2 text-xs font-semibold text-danger-ink" role="alert">{error}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-danger-line bg-danger-soft px-3 text-xs font-bold text-danger-ink disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          Akhiri pengaturan
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="min-h-11 rounded-xl border border-border bg-surface-raised px-3 text-xs font-bold text-brand-heading disabled:opacity-50"
        >
          Batal
        </button>
      </div>
    </DetailDialog>
  );
}
