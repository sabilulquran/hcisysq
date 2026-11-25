import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from "lucide-react";

const controlClass =
  "inline-flex min-h-10 items-center justify-center gap-1 rounded-lg border border-border bg-surface-raised px-2.5 font-medium text-brand-heading transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * What the pager shows for one (page, pageSize, total). Pure, so the arithmetic that
 * decides "Menampilkan 51–68 dari 68" and which page is reachable can be tested on its own.
 */
export function paginationView(page: number, pageSize: number, total: number) {
  const size = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(Math.max(0, total) / size));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  return {
    totalPages,
    safePage,
    /** The page prop points outside the result set; the bar shows the last page that exists. */
    outOfRange: page !== safePage,
    start: total === 0 ? 0 : (safePage - 1) * size + 1,
    end: Math.min(total, safePage * size),
    atFirst: safePage <= 1,
    atLast: safePage >= totalPages,
  };
}

/**
 * ENG-LIST-001-I: the one pager for every paginated list. Inline pagers are not allowed.
 *
 * ENG-LIST-001-M: the bar stays reachable at 375px (it wraps, and every control is 40px tall),
 * and a page that has fallen out of range — the last row of the last page was deleted, or a
 * filter shrank the result — is shown as the last page that does exist, with the controls
 * pointing at real pages, instead of a page number that no longer means anything.
 *
 * The bar never moves the list by itself. Most callers unmount it while their request is in
 * flight, so an effect here could not tell "already asked" from "asked again after a remount",
 * and a backend that echoed a page it had not honoured would turn that into a request loop.
 * Moving the list stays with the caller, which knows when its own rows went away.
 */
export function PaginationBar({
  page,
  pageSize,
  total,
  loading = false,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  /**
   * ENG-LIST-001-M: a list whose rows are still on their way says so here, where the count
   * that is about to change would otherwise read as settled.
   */
  loading?: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
}) {
  const { totalPages, safePage, start, end, atFirst, atLast } =
    paginationView(page, pageSize, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-border/70 bg-surface/50 px-4 py-3 text-xs text-muted-foreground">
      <p aria-live="polite" className="sq-nums">
        {loading
          ? "Memuat…"
          : total === 0
            ? "Tidak ada data"
            : `Menampilkan ${start}–${end} dari ${total}`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {onPageSizeChange ? (
          <label className="flex items-center gap-2">
            <span>Per halaman</span>
            <select
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              className="sq-nums min-h-10 rounded-lg border border-border bg-surface-raised px-2 text-xs text-brand-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          aria-label="Halaman pertama"
          disabled={atFirst}
          onClick={() => onPageChange(1)}
          className={controlClass}
        >
          <ChevronFirst className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          disabled={atFirst}
          onClick={() => onPageChange(safePage - 1)}
          className={controlClass}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Sebelumnya
        </button>
        <span className="sq-nums min-w-16 text-center font-medium text-brand-heading">
          {safePage} / {totalPages}
        </span>
        <button
          type="button"
          disabled={atLast}
          onClick={() => onPageChange(safePage + 1)}
          className={controlClass}
        >
          Berikutnya <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Halaman terakhir"
          disabled={atLast}
          onClick={() => onPageChange(totalPages)}
          className={controlClass}
        >
          <ChevronLast className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
