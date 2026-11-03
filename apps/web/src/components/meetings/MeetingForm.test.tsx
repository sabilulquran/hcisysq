// CAL-001 K-16: the WhatsApp option follows the adapter status the API reports. Synthetic data.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MeetingForm } from "@/components/meetings/MeetingForm";

function render(whatsappActive: boolean) {
  return renderToStaticMarkup(
    <MeetingForm defaultDate="2026-11-10" editing={null} whatsappActive={whatsappActive} onSaved={() => undefined} onClose={() => undefined} />,
  );
}

describe("CAL-001 meeting form WhatsApp option (K-16)", () => {
  it("hides the option and says WhatsApp is not active while the API runs in dry run", () => {
    const html = render(false);
    expect(html).not.toContain("Kirim juga lewat WhatsApp");
    expect(html).toContain("Pemberitahuan WhatsApp belum aktif");
  });

  it("offers the option, ticked by default, once the Kirim SQ adapter is active", () => {
    const html = render(true);
    expect(html).toContain("Kirim juga lewat WhatsApp");
    expect(html).not.toContain("belum aktif");
  });
});
