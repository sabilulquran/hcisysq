// LEAVE-010: the cancel action starts as one button and asks before anything is sent.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CancelLeaveRequest } from "@/components/leave/CancelLeaveRequest";

describe("LEAVE-010 cancel leave request", () => {
  it("offers the action without sending anything until confirmed", () => {
    const html = renderToStaticMarkup(
      <CancelLeaveRequest requestId="40000000-0000-4000-8000-000000000001" onDone={() => undefined} />,
    );
    expect(html).toContain("Batalkan pengajuan");
    expect(html).not.toContain("Ya, batalkan");
  });
});
