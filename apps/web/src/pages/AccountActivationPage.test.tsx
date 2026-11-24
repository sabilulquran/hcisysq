import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AkunSqActivationNotice } from "@/pages/AccountActivationPage";

// AUTH-002: a local activation link opened in Akun SQ mode points to Akun SQ instead of a password form.
describe("AUTH-002 activation page in Akun SQ mode", () => {
  it("sends the visitor to Akun SQ and names the forgotten-password path", () => {
    const html = renderToStaticMarkup(<AkunSqActivationNotice />);
    expect(html).toContain("Aktivasi memakai Akun SQ");
    expect(html).toContain("Lupa kata sandi?");
    // Audit kesiapan 2026-11-24: tautannya dulu `/login`, rute yang tidak ada di SPA ini, sehingga
    // satu-satunya tombol pada halaman ini menjawab "404 Halaman tidak tersedia".
    expect(html).toContain('href="/"');
    expect(html).not.toContain('href="/login"');
    expect(html).not.toContain('type="password"');
  });
});
