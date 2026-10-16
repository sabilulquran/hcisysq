import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, SearchCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { useDeviceAdmin } from "@/components/attendance/device-admin/DeviceAdminContext";
import { getAdmsMappingAssistant, type AdmsMappingAssistantItem } from "@/lib/admsAdmin";
import { summarizeAdmsMappingReview } from "@/lib/admsMappingReview";

function candidateLabel(item: AdmsMappingAssistantItem) {
  const candidate = item.candidates[0];
  if (!candidate) return null;
  if (candidate.matchKind === "exact_name") return "Nama sama";
  if (candidate.matchKind === "close_name") return "Nama mirip";
  return "Kemungkinan nama";
}

export function MappingReviewPanel() {
  const { deviceId } = useDeviceAdmin();
  const [items, setItems] = useState<AdmsMappingAssistantItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const load = useCallback(async (initial = false) => {
    if (!initial) setRefreshing(true);
    try {
      const result = await getAdmsMappingAssistant(deviceId);
      setItems(result.items);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Antrian review mapping tidak dapat dimuat.");
    } finally {
      if (!initial) setRefreshing(false);
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void load(true);
  }, [load]);

  const summary = useMemo(() => summarizeAdmsMappingReview(items), [items]);
  const totalPages = Math.max(1, Math.ceil(summary.priorityItems.length / pageSize));

  useEffect(() => {
    setPage(1);
  }, [deviceId, pageSize]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pageItems = useMemo(
    () => summary.priorityItems.slice((page - 1) * pageSize, page * pageSize),
    [page, pageSize, summary.priorityItems],
  );

  return (
    <section className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <SearchCheck className="h-4 w-4 text-brand-primary-deep" aria-hidden="true" />
            <h2 className="text-base font-bold text-brand-heading">Antrian review mapping</h2>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            Prioritaskan PIN yang belum terhubung menggunakan fakta punch dan metadata aman yang sudah teramati. Rekomendasi hanya berdasarkan kemiripan nama dan tidak pernah membuat mapping otomatis.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing || loading}
          className="inline-flex h-9 items-center gap-2 rounded-xl border border-border px-3 text-xs font-semibold hover:bg-surface disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Muat ulang
        </button>
      </div>

      {loading ? (
        <div className="mt-4 flex items-center gap-2 rounded-xl bg-surface p-4 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Memuat backlog mapping…
        </div>
      ) : error ? (
        <div className="mt-4 rounded-xl border border-danger-line bg-danger-soft p-3 text-xs text-danger-ink">{error}</div>
      ) : (
        <>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl bg-surface p-3">
              <div className="text-[11px] font-semibold text-muted-foreground">Belum terhubung</div>
              <div className="mt-1 text-xl font-bold text-brand-heading">{summary.totalUnmapped}</div>
            </div>
            <div className="rounded-xl bg-success-soft p-3">
              <div className="text-[11px] font-semibold text-success-ink">Rekomendasi nama sama</div>
              <div className="mt-1 text-xl font-bold text-success-ink">{summary.exactNameRecommendations}</div>
            </div>
            <div className="rounded-xl bg-info-soft p-3">
              <div className="text-[11px] font-semibold text-info-ink">Rekomendasi nama mirip</div>
              <div className="mt-1 text-xl font-bold text-info-ink">{summary.fuzzyNameRecommendations}</div>
            </div>
            <div className="rounded-xl bg-warning-soft p-3">
              <div className="text-[11px] font-semibold text-warning-ink">Tanpa rekomendasi nama</div>
              <div className="mt-1 text-xl font-bold text-warning-ink">{summary.withoutRecommendation}</div>
            </div>
          </div>

          {summary.totalUnmapped === 0 ? (
            <div className="mt-4 flex items-center gap-2 rounded-xl border border-success-line bg-success-soft p-3 text-xs text-success-ink">
              <CheckCircle2 className="h-4 w-4" /> Semua PIN yang teramati sudah mempunyai mapping aktif.
            </div>
          ) : (
            <div className="mt-4 overflow-hidden rounded-xl border border-border/70">
              <div className="border-b border-border/70 bg-surface/70 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
                Prioritas review
              </div>
              <div className="divide-y divide-border/60">
                {pageItems.map((item) => {
                  const candidate = item.candidates[0];
                  return (
                    <div key={item.pin} className="grid gap-2 px-3 py-3 text-xs md:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1.2fr)_auto] md:items-center">
                      <div className="font-mono font-bold text-brand-heading">PIN {item.pin}</div>
                      <div>
                        <div className="font-semibold text-brand-heading">{item.rosterDisplayName?.trim() || "Nama mesin belum teramati"}</div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">{item.eventCount} fakta punch tersimpan</div>
                      </div>
                      <div>
                        {candidate ? (
                          <>
                            <div className="font-semibold text-brand-heading">{candidate.fullName}</div>
                            <div className="mt-0.5 text-[11px] text-muted-foreground">
                              {candidateLabel(item)} · similarity {candidate.similarity}/100 · {candidate.employeeNumber}
                            </div>
                          </>
                        ) : (
                          <div className="flex items-center gap-1.5 text-warning-ink">
                            <AlertTriangle className="h-3.5 w-3.5" /> Rekomendasi nama belum tersedia
                          </div>
                        )}
                      </div>
                      <a
                        href="#device-user-list"
                        className="text-[11px] font-bold text-brand-primary-deep hover:underline"
                      >
                        Tinjau di daftar
                      </a>
                    </div>
                  );
                })}
              </div>
              <PaginationBar
                page={page}
                pageSize={pageSize}
                total={summary.priorityItems.length}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
              />
            </div>
          )}

          <div className="mt-3 text-[11px] leading-5 text-muted-foreground">
            Similarity adalah alat urut untuk manusia, bukan confidence/probability. Card, NIP, unit, PIN, dan external ID tidak dipakai untuk membuat identitas otomatis. Active USERINFO read tetap dipensiunkan.
          </div>
        </>
      )}
    </section>
  );
}
