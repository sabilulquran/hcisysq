// LEAVE-001/APR-001: "Tolak" collects its reason on the page, not in `window.prompt`.
//
// What this guards: a browser prompt is invisible to assistive technology and Android Chrome lets
// the viewer suppress further dialogs, after which the Tolak button silently does nothing. Static
// render; synthetic data only.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RejectLeaveApproval } from "@/components/leave/RejectLeaveApproval";

const STEP = "30000000-0000-4000-8000-000000000001";

function render(search: string) {
  vi.stubGlobal("window", { location: { search } });
  return renderToStaticMarkup(
    <RejectLeaveApproval
      stepId={STEP}
      requesterName="Rosaliana"
      range="1 Des 2026 – 2 Des 2026"
      onConfirm={async () => null}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LEAVE-001 tolak pengajuan cuti", () => {
  it("shows only the button until the pop-up is named in the URL", () => {
    const html = render("");
    expect(html).toContain("Tolak");
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("Alasan penolakan");
  });

  it("opens the reason form on the page, naming the request being refused", () => {
    const html = render(`?tolak-cuti=${STEP}`);
    expect(html).toMatch(/role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Tolak pengajuan cuti"/);
    expect(html).toContain("Rosaliana");
    expect(html).toContain("1 Des 2026 – 2 Des 2026");
    expect(html).toContain("Alasan penolakan");
    expect(html).toContain("Tolak pengajuan");
  });

  it("does not open for another card's step id", () => {
    expect(render("?tolak-cuti=40000000-0000-4000-8000-000000000009"))
      .not.toContain('role="dialog"');
  });
});
