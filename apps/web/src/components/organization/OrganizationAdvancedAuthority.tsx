// ORG-008-5: "Penyetuju khusus" and "Diberi tahu" written as sentences (gap W-2).
//
// The terms behind them are governance approver and oversight parent. An operator should not have to
// learn either: what they need to read is "Bila pejabat Direktur mengajukan cuti, yang menyetujui
// adalah Sekretaris Yayasan", and "Setelah disetujui, Ketua Yayasan diberi tahu".
//
// It also says the uncomfortable part out loud (gap W-3): a seat held by a Dewan account cannot act
// as an approver until the account mapping is decided, so a rule pointing at one is shown as not yet
// usable instead of looking configured.

import { Trash2 } from "lucide-react";

import type { OrganizationAuthorityBinding, OrganizationPosition } from "@/lib/organizationDesigner";
import { organizationSeatEditability } from "@/lib/organizationLanguage";

export type OrganizationAdvancedBindingType = "GOVERNANCE_APPROVER" | "OVERSIGHT_PARENT";

export function organizationAdvancedSentence(input: {
  bindingType: string;
  subjectTitle: string;
  targetTitle: string | null;
}): string {
  const target = input.targetTitle ?? "jabatan yang dipilih";
  if (input.bindingType === "GOVERNANCE_APPROVER") {
    return `Bila pejabat ${input.subjectTitle} mengajukan cuti, yang menyetujui adalah ${target}.`;
  }
  if (input.bindingType === "OVERSIGHT_PARENT") {
    return `Setelah pengajuan pejabat ${input.subjectTitle} disetujui, ${target} diberi tahu.`;
  }
  return `Aturan lain untuk ${input.subjectTitle}.`;
}

export function OrganizationAdvancedAuthority({
  position,
  bindings,
  positions,
  canManage,
  saving,
  onAdd,
  onRemove,
}: {
  position: OrganizationPosition;
  /** Every binding in the change set; this panel picks the ones about this position. */
  bindings: OrganizationAuthorityBinding[];
  positions: OrganizationPosition[];
  canManage: boolean;
  saving: boolean;
  onAdd: (bindingType: OrganizationAdvancedBindingType, targetPositionKey: string) => void;
  onRemove: (binding: OrganizationAuthorityBinding) => void;
}) {
  const own = bindings.filter(
    (binding) =>
      binding.sourceKey === position.stableKey
      && (binding.authorityType === "GOVERNANCE_APPROVER" || binding.authorityType === "OVERSIGHT_PARENT")
      && binding.effectiveTo === null,
  );
  const titleOf = (positionKey: string) =>
    positions.find((item) => item.stableKey === positionKey)?.title ?? null;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">Aturan yang berlaku</h3>
        {own.length === 0 ? (
          <p className="mt-2 rounded-xl border border-border/70 bg-surface p-3 text-sm text-muted-foreground">
            Belum ada aturan khusus untuk jabatan ini.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {own.map((binding) => {
              const target = positions.find((item) => item.stableKey === binding.targetPositionKey);
              const unusable = target ? !organizationSeatEditability(target).editable : false;
              return (
                <li key={binding.id} className="flex flex-wrap items-start gap-3 rounded-xl border border-border/70 bg-surface px-4 py-3 text-sm">
                  <span className="flex-1">
                    {organizationAdvancedSentence({
                      bindingType: binding.authorityType,
                      subjectTitle: position.title,
                      targetTitle: titleOf(binding.targetPositionKey),
                    })}
                    {unusable ? (
                      <span className="mt-1 block text-[11px] font-semibold text-warning-ink">
                        Belum bisa dipakai untuk persetujuan: jabatan itu dipegang akun Dewan, dan
                        pemetaan akun Dewan belum diputuskan.
                      </span>
                    ) : null}
                  </span>
                  {canManage ? (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => onRemove(binding)}
                      className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border bg-surface-raised px-2.5 text-[11px] font-bold hover:bg-muted disabled:opacity-60"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Hapus aturan
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {canManage ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const targetPositionKey = String(form.get("targetPositionKey") ?? "");
            if (!targetPositionKey) return;
            onAdd(String(form.get("bindingType")) as OrganizationAdvancedBindingType, targetPositionKey);
          }}
          className="space-y-3 rounded-xl border border-border/70 bg-surface p-4"
        >
          <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">Tambah aturan</h3>
          <label className="block">
            <span className="text-xs font-bold text-brand-heading">Aturan</span>
            <select name="bindingType" className="mt-1.5 h-11 w-full rounded-xl border border-border bg-surface-raised px-3 text-sm">
              <option value="GOVERNANCE_APPROVER">Bila pejabat ini mengajukan cuti, yang menyetujui adalah...</option>
              <option value="OVERSIGHT_PARENT">Setelah disetujui, yang diberi tahu adalah...</option>
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-bold text-brand-heading">Jabatan</span>
            <select name="targetPositionKey" required className="mt-1.5 h-11 w-full rounded-xl border border-border bg-surface-raised px-3 text-sm">
              <option value="">Pilih jabatan...</option>
              {positions
                .filter((item) => item.stableKey !== position.stableKey)
                .map((item) => <option key={item.stableKey} value={item.stableKey}>{item.title}</option>)}
            </select>
          </label>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex h-10 items-center rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-60"
          >
            Simpan aturan
          </button>
        </form>
      ) : (
        <p className="rounded-xl border border-border/70 bg-surface p-3 text-sm text-muted-foreground">
          Aturan ini diatur oleh pemegang izin persetujuan (Kepala HC atau owner).
        </p>
      )}
    </div>
  );
}
