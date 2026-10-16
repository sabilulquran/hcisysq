import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandLockup } from "@/components/BrandLockup";

describe("BrandLockup", () => {
  it("shows the star mark, the app name and the gold foundation wordmark in the masthead", () => {
    const html = renderToStaticMarkup(<BrandLockup compact />);

    expect(html).toContain("h-9 w-9");
    expect(html).toContain(">HCIS</p>");
    expect(html).toContain("sq-wordmark-gold");
    expect(html).toContain('alt="Yayasan Sabilul Qur&#x27;an"');
    expect(html).not.toContain("Human Capital Information System");
  });

  it("uses the larger proportion in the sidebar", () => {
    const html = renderToStaticMarkup(<BrandLockup />);

    expect(html).toContain("h-11 w-11");
    expect(html).toContain("text-base font-extrabold");
    expect(html).toContain("h-4 w-auto");
  });
});
