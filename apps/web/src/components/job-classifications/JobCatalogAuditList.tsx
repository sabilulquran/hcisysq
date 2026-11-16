// ORG-011 Package 4: the catalog's change history, read from the audit trail (server-paged).

import { useEffect, useRef, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { AdminApiError } from "@/lib/adminEmployees";
import {
  catalogAuditActionLabels,
  listJobCatalogAuditEvents,
  type CatalogAuditEvent,
} from "@/lib/jobClassifications";

/** One readable line per event; the payload keys are the service's own, nothing is inferred. */
export function auditEventDetail(event: CatalogAuditEvent): string {
  const payload = event.payload;
  const parts: string[] = [];
  if (typeof payload.name === "string") parts.push(`nama "${payload.name}"`);
  if (typeof payload.family === "string") parts.push(`rumpun ${payload.family}`);
  if (typeof payload.effectiveFrom === "string") parts.push(`berlaku ${payload.effectiveFrom}`);
  if (typeof payload.endOn === "string") parts.push(`ditutup ${payload.endOn}`);
  if (typeof payload.reason === "string") parts.push(`alasan: ${payload.reason}`);
  if (event.action.endsWith(".imported")) {
    parts.push(`${String(payload.create ?? 0)} baru, ${String(payload.amend ?? 0)} versi baru dari ${String(payload.fileName ?? "berkas")}`);
  } else if (typeof payload.importId === "string") {
    parts.push("lewat impor");
  }
  return parts.join(" · ");
}

function formatInstant(value: string): string {
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" })
    .format(new Date(value));
}

export function JobCatalogAuditList() {
  const [events, setEvents] = useState<CatalogAuditEvent[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [code, setCode] = useState("");
  // The filter is typed one letter at a time; ask the server once the operator pauses.
  const [filter, setFilter] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setFilter(code.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [code]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);

  useEffect(() => {
    const current = ++ticket.current;
    setLoading(true);
    setError(null);
    listJobCatalogAuditEvents({ page, pageSize, entityCode: filter || undefined })
      .then((result) => {
        if (current !== ticket.current) return;
        setEvents(result.events);
        setTotal(result.pagination.total);
      })
      .catch((cause: unknown) => {
        if (current !== ticket.current) return;
        setError(cause instanceof AdminApiError ? cause.message : "Riwayat perubahan gagal dimuat.");
      })
      .finally(() => { if (current === ticket.current) setLoading(false); });
  }, [page, pageSize, filter]);

  return (
    <div className="space-y-3">
      <label className="block text-xs font-semibold text-muted-foreground">
        Saring kode
        <input value={code} onChange={(event) => { setCode(event.target.value.toUpperCase()); setPage(1); }}
          placeholder="FUNC_GURU" className="mt-1 block rounded-md border px-3 py-2 font-mono text-sm" />
      </label>
      {error ? <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">{error}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">Memuat…</p> : null}
      {!loading && !error && events.length === 0 ? (
        <p className="text-sm text-muted-foreground">Belum ada perubahan katalog yang tercatat.</p>
      ) : null}
      {!loading && events.length > 0 ? (
        <ul className="space-y-2">
          {events.map((event) => (
            <li key={event.id} className="rounded-md border px-3 py-2 text-sm">
              <p className="font-semibold">
                {catalogAuditActionLabels[event.action] ?? event.action}
                {event.entityCode ? <span className="ml-2 font-mono text-xs">{event.entityCode}</span> : null}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatInstant(event.occurredAt)} · {event.actorName ?? "sistem"}
                {auditEventDetail(event) ? ` · ${auditEventDetail(event)}` : ""}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      <PaginationBar page={page} pageSize={pageSize} total={total}
        onPageChange={setPage} onPageSizeChange={(next) => { setPageSize(next); setPage(1); }} />
    </div>
  );
}
