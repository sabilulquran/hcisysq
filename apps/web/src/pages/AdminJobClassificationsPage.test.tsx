// ORG-011 catalog screen: the pure pieces and a static render, as this repo tests pages.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  JobCatalogRowActions,
  classificationPayload,
  emptyCatalogMessage,
  parseRankOrder,
} from "@/pages/AdminJobClassificationsPage";

function actions(canManage: boolean, busy = false) {
  return renderToStaticMarkup(
    <table><tbody><tr>
      <JobCatalogRowActions code="G3" name="Golongan III" canManage={canManage} busy={busy}
        onRename={() => {}} onClose={() => {}} />
    </tr></tbody></table>,
  );
}

describe("ORG-011 catalog row actions", () => {
  it("offers both actions to a manager, on either tab", () => {
    // The grade tab used to render an action column whose every cell was a dash, telling the
    // operator a control existed where none did. Both tabs now share this component.
    const markup = actions(true);
    expect(markup).toContain("Ubah nama");
    expect(markup).toContain("Tutup");
  });

  it("renders nothing at all for a reader", () => {
    expect(actions(false)).not.toContain("Ubah nama");
    expect(actions(false)).not.toContain("Tutup");
  });

  it("locks both buttons while a change is in flight", () => {
    // Without this a double click sends two amendments and the second comes back as a
    // version conflict the operator has no way to explain.
    expect(actions(true, true)).toContain("disabled");
  });
});

describe("ORG-011 display order", () => {
  it("accepts a whole number, including nought", () => {
    expect(parseRankOrder("0")).toBe(0);
    expect(parseRankOrder(" 3 ")).toBe(3);
  });

  it("refuses anything that is not one, instead of storing nought", () => {
    // 0 is a valid order, so coercing a typo into it would write a wrong catalog version.
    for (const value of ["", "abc", "-1", "2.5", "1e3x"]) {
      expect(parseRankOrder(value)).toBeNull();
    }
  });
});

describe("ORG-011 create payload", () => {
  it("upper-cases the code and sends a blank grade as null", () => {
    expect(classificationPayload({
      code: " func_baru ", name: " Guru Baru ", family: "FUNCTIONAL",
      gradeCode: "  ", effectiveFrom: "2026-11-01",
    })).toEqual({
      code: "FUNC_BARU", name: "Guru Baru", family: "FUNCTIONAL",
      gradeCode: null, effectiveFrom: "2026-11-01",
    });
  });

  it("upper-cases a grade that was given", () => {
    expect(classificationPayload({
      code: "STRUCT_X", name: "Kepala", family: "STRUCTURAL",
      gradeCode: " g3 ", effectiveFrom: "2026-11-01",
    }).gradeCode).toBe("G3");
  });
});

describe("ORG-011 empty state", () => {
  it("names a date only when the list is read as of one", () => {
    // With includeHistory the API ignores the date entirely, so naming one would be untrue.
    expect(emptyCatalogMessage("classifications", false)).toContain("berlaku pada tanggal ini");
    expect(emptyCatalogMessage("classifications", true)).toContain("pernah dibuat");
    expect(emptyCatalogMessage("grades", true)).toContain("golongan");
  });
});
