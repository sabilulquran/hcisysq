import { ChevronLeft, ChevronRight } from "lucide-react";

export function PaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const end = Math.min(total, safePage * pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 bg-surface/50 px-4 py-3 text-[11px] text-muted-foreground">
      <div>{total === 0 ? "Tidak ada data" : `Menampilkan ${start}–${end} dari ${total}`}</div>
      <div className="flex items-center gap-2">
        {onPageSizeChange ? (
          <label className="flex items-center gap-2">
            <span>Per halaman</span>
            <select
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              className="h-8 rounded-lg border border-border bg-surface-raised px-2 text-xs text-brand-heading"
              aria-label="Jumlah data per halaman"
            >
              {[10, 25, 50, 100].map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          disabled={safePage <= 1}
          onClick={() => onPageChange(safePage - 1)}
          className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-surface-raised px-2 font-semibold text-brand-heading disabled:opacity-40"
        >
          <ChevronLeft className="h-3.5 w-3.5" /> Sebelumnya
        </button>
        <span className="min-w-20 text-center font-semibold text-brand-heading">{safePage} / {totalPages}</span>
        <button
          type="button"
          disabled={safePage >= totalPages}
          onClick={() => onPageChange(safePage + 1)}
          className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-surface-raised px-2 font-semibold text-brand-heading disabled:opacity-40"
        >
          Berikutnya <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
