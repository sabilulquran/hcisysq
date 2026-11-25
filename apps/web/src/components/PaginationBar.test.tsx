// ENG-LIST-001-I/M: one shared pager, and it must stay usable at the edges of a result set.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PaginationBar, paginationView } from "@/components/PaginationBar";

describe("ENG-LIST-001 pagination", () => {
  it("counts the window shown on each page", () => {
    expect(paginationView(1, 25, 68)).toMatchObject({ totalPages: 3, start: 1, end: 25, atFirst: true, atLast: false });
    expect(paginationView(3, 25, 68)).toMatchObject({ totalPages: 3, start: 51, end: 68, atFirst: false, atLast: true });
  });

  it("treats an empty result set as one page with nothing on it", () => {
    expect(paginationView(1, 25, 0)).toMatchObject({ totalPages: 1, start: 0, end: 0, atFirst: true, atLast: true, outOfRange: false });
  });

  it("pulls a page that no longer exists back to the last page that does", () => {
    // The last row on page 3 was deleted, so there are only two pages left.
    const view = paginationView(3, 25, 50);
    expect(view).toMatchObject({ totalPages: 2, safePage: 2, outOfRange: true, start: 26, end: 50 });
  });

  it("shows an out-of-range page as the last page that exists, and moves nothing itself", () => {
    // The caller owns its own page. The bar renders the clamped window and leaves the
    // controls pointing at real pages; it never calls onPageChange on its own.
    let moved = 0;
    const html = renderToStaticMarkup(
      <PaginationBar page={7} pageSize={25} total={50} onPageChange={() => { moved += 1; }} />,
    );
    expect(html).toContain("Menampilkan 26–50 dari 50");
    expect(html).toContain('aria-label="Halaman terakhir" disabled=""');
    expect(moved).toBe(0);
  });

  it("keeps page 1 when the result set still fits", () => {
    expect(paginationView(1, 100, 68)).toMatchObject({ totalPages: 1, outOfRange: false, end: 68 });
  });

  it("never divides by a zero page size", () => {
    expect(paginationView(1, 0, 10).totalPages).toBe(10);
  });

  it("shows the window, and disables the edges it is already on", () => {
    const first = renderToStaticMarkup(
      <PaginationBar page={1} pageSize={25} total={68} onPageChange={() => {}} />,
    );
    // `disabled=""` is the attribute; the class list also carries `disabled:` variants.
    expect(first).toContain("Menampilkan 1–25 dari 68");
    expect(first).toContain('aria-label="Halaman pertama" disabled=""');
    expect(first).not.toContain('aria-label="Halaman terakhir" disabled=""');

    const last = renderToStaticMarkup(
      <PaginationBar page={3} pageSize={25} total={68} onPageChange={() => {}} />,
    );
    expect(last).toContain("Menampilkan 51–68 dari 68");
    expect(last).toContain('aria-label="Halaman terakhir" disabled=""');
    expect(last).not.toContain('aria-label="Halaman pertama" disabled=""');
  });

  it("offers the page sizes of ENG-LIST-001-B only when the list can change them", () => {
    const withSizes = renderToStaticMarkup(
      <PaginationBar page={1} pageSize={25} total={68} onPageChange={() => {}} onPageSizeChange={() => {}} />,
    );
    for (const size of [10, 25, 50, 100]) expect(withSizes).toContain(`value="${size}"`);

    const withoutSizes = renderToStaticMarkup(
      <PaginationBar page={1} pageSize={25} total={68} onPageChange={() => {}} />,
    );
    expect(withoutSizes).not.toContain("Per halaman");
  });

  it("says the rows are still coming instead of showing a count about to change", () => {
    const html = renderToStaticMarkup(
      <PaginationBar page={2} pageSize={50} total={420} loading onPageChange={() => {}} />,
    );
    expect(html).toContain("Memuat…");
    expect(html).not.toContain("Menampilkan 51–100 dari 420");
  });

  it("says so plainly when there is no data", () => {
    const html = renderToStaticMarkup(
      <PaginationBar page={1} pageSize={25} total={0} onPageChange={() => {}} />,
    );
    expect(html).toContain("Tidak ada data");
  });
});
