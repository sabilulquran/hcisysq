import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { AdminShell } from "@/layouts/AdminShell";
import {
  AdminApiError,
  listEmployeeImports,
  type EmployeeImportHistoryItem,
} from "@/lib/adminEmployees";

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusClass(status: EmployeeImportHistoryItem["status"]) {
  if (status === "committed") return "bg-success-soft text-success-ink";
  if (status === "failed") return "bg-danger-soft text-danger-ink";
  return "bg-warning-soft text-warning-ink";
}

export function AdminEmployeeImportHistoryPage() {
  const [items, setItems] = useState<EmployeeImportHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    void listEmployeeImports()
      .then((result) => {
        if (mounted) setItems(result.items);
      })
      .catch((cause: unknown) => {
        if (!mounted) return;
        setError(
          cause instanceof AdminApiError
            ? cause.message
            : "Riwayat import tidak dapat dimuat.",
        );
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [refreshKey]);

  return (
    <AdminShell
      active="history"
      title="Riwayat Impor Pegawai"
      description="Audit ringkas 50 proses import terbaru beserta checksum, counts, waktu, dan akun yang melakukan preview/commit."
    >
      <div className="mb-4 flex justify-end">
        <button
          type="button"
          onClick={() => setRefreshKey((current) => current + 1)}
          disabled={loading}
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-surface-raised px-4 text-sm font-semibold hover:bg-muted/60 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          Muat ulang
        </button>
      </div>

      <section className="overflow-hidden rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        {error ? (
          <div className="p-6 text-sm text-destructive">{error}</div>
        ) : loading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Memuat riwayat import...</div>
        ) : items.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1050px] text-left text-sm">
              <thead className="bg-surface text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-semibold">Waktu</th>
                  <th className="px-4 py-3 font-semibold">File</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Baris</th>
                  <th className="px-4 py-3 font-semibold">Insert / Update</th>
                  <th className="px-4 py-3 font-semibold">Warning / Error</th>
                  <th className="px-4 py-3 font-semibold">Actor</th>
                  <th className="px-4 py-3 font-semibold">Checksum</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {items.map((item) => (
                  <tr key={item.importId} className="align-top hover:bg-surface/60">
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                      <p>{formatDate(item.createdAt)}</p>
                      {item.committedAt ? <p className="mt-1">Commit: {formatDate(item.committedAt)}</p> : null}
                    </td>
                    <td className="max-w-64 px-4 py-3">
                      <p className="truncate font-semibold text-foreground">{item.sourceFilename}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">{item.importId}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${statusClass(item.status)}`}>{item.status}</span>
                    </td>
                    <td className="px-4 py-3 font-semibold">{item.rowCount}</td>
                    <td className="px-4 py-3 text-muted-foreground">{item.insertCount} / {item.updateCount}</td>
                    <td className="px-4 py-3 text-muted-foreground">{item.warningCount} / {item.errorCount}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      <p>Preview: {item.createdByEmail ?? "—"}</p>
                      <p className="mt-1">Commit: {item.committedByEmail ?? "—"}</p>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">{item.checksumSha256.slice(0, 16)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-10 text-center">
            <p className="text-sm font-semibold text-foreground">Belum ada riwayat import.</p>
            <p className="mt-1 text-sm text-muted-foreground">Preview pertama akan muncul di sini meskipun belum di-commit.</p>
          </div>
        )}
      </section>
    </AdminShell>
  );
}
