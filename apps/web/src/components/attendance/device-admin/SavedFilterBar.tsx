import { Bookmark, Loader2, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  deleteAdmsFilter,
  listAdmsSavedFilters,
  saveAdmsFilter,
  type AdmsSavedFilter,
} from "@/lib/admsOperations";

export function SavedFilterBar({
  deviceId,
  viewKey,
  criteria,
  onApply,
  canManage = true,
}: {
  deviceId: string;
  viewKey: "transactions" | "commands" | "logs";
  criteria: Record<string, unknown>;
  onApply: (criteria: Record<string, unknown>) => void;
  canManage?: boolean;
}) {
  const [items, setItems] = useState<AdmsSavedFilter[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await listAdmsSavedFilters({ deviceId, viewKey });
    setItems(result.items);
  }, [deviceId, viewKey]);

  useEffect(() => {
    void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Filter tersimpan tidak dapat dimuat."));
  }, [load]);

  const selected = items.find((item) => item.id === selectedId) ?? null;

  const save = useCallback(async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const result = await saveAdmsFilter({ deviceId, viewKey, name: name.trim(), criteria });
      setName("");
      setSelectedId(result.item.id);
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Filter tidak dapat disimpan.");
    } finally {
      setBusy(false);
    }
  }, [criteria, deviceId, load, name, viewKey]);

  const remove = useCallback(async () => {
    if (!selected) return;
    if (!window.confirm(`Hapus filter tersimpan "${selected.name}"?`)) return;
    setBusy(true);
    try {
      await deleteAdmsFilter(selected.id);
      setSelectedId("");
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Filter tidak dapat dihapus.");
    } finally {
      setBusy(false);
    }
  }, [load, selected]);

  return (
    <div className="mt-3 rounded-xl border border-border/70 bg-surface/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[11px] font-bold text-brand-heading"><Bookmark className="h-3.5 w-3.5" /> Filter tersimpan</span>
        <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} className="h-8 min-w-44 rounded-lg border border-border bg-white px-2 text-xs">
          <option value="">Pilih filter…</option>
          {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button type="button" disabled={!selected || busy} onClick={() => selected && onApply(selected.criteria)} className="h-8 rounded-lg border border-border bg-white px-2 text-[11px] font-semibold disabled:opacity-50">Terapkan</button>
        {canManage ? (
          <>
            <button type="button" disabled={!selected || busy} onClick={() => void remove()} className="inline-flex h-8 items-center gap-1 rounded-lg border border-red-200 bg-white px-2 text-[11px] font-semibold text-red-700 disabled:opacity-50"><Trash2 className="h-3 w-3" /> Hapus</button>
            <div className="ml-auto flex min-w-64 flex-1 justify-end gap-2">
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="Nama filter saat ini" className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-white px-2 text-xs" />
              <button type="button" disabled={!name.trim() || busy} onClick={() => void save()} className="inline-flex h-8 items-center gap-1 rounded-lg bg-brand-primary px-2 text-[11px] font-semibold text-white disabled:opacity-50">{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} Simpan</button>
            </div>
          </>
        ) : (
          <span className="ml-auto text-[11px] font-semibold text-muted-foreground">Mode baca saja</span>
        )}
      </div>
      {error ? <div className="mt-2 text-[11px] text-red-700">{error}</div> : null}
    </div>
  );
}