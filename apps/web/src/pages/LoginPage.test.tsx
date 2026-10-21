import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LoginPageView } from "@/pages/LoginPage";

const render = (props: Parameters<typeof LoginPageView>[0]) => renderToStaticMarkup(<LoginPageView {...props} />);

describe("AUTH-012 login entry hand-off to Akun SQ", () => {
  it("shows only a neutral hand-off state while it opens Akun SQ", () => {
    const html = render({ mode: "oidc", modeError: false, search: { returnTo: "/app/leave" } });
    expect(html).toContain("Membuka Akun SQ…");
    expect(html).not.toContain("Selamat datang kembali");
    expect(html).not.toContain("Masuk dengan Akun SQ");
  });

  it("does not flash the login page while the mode is still loading", () => {
    const html = render({ mode: null, modeError: false, search: {} });
    expect(html).toContain("Memeriksa metode masuk");
    expect(html).not.toContain("Selamat datang kembali");
  });

  it("keeps the error and a retry button after a failed callback instead of restarting sign-in", () => {
    const html = render({ mode: "oidc", modeError: false, search: { authError: "oidc_failed", returnTo: "/app/leave" } });
    expect(html).toContain("Masuk dengan Akun SQ belum berhasil. Silakan coba lagi.");
    expect(html).toContain('href="/api/auth/oidc/start?returnTo=%2Fapp%2Fleave"');
    expect(html).toContain("Masuk dengan Akun SQ");
    expect(html).not.toContain("Membuka Akun SQ");
  });

  it("still offers the retry button for an unknown authError value without showing it", () => {
    const html = render({ mode: "oidc", modeError: false, search: { authError: "token=secret" } });
    expect(html).toContain('href="/api/auth/oidc/start"');
    expect(html).not.toContain("token=secret");
  });

  it("never offers a kata sandi field in Akun SQ mode", () => {
    const html = render({ mode: "oidc", modeError: false, search: { authError: "access_denied" } });
    expect(html).not.toContain('type="password"');
  });

  it("shows the configuration error instead of a hand-off when the mode cannot load", () => {
    const html = render({ mode: null, modeError: true, search: {} });
    expect(html).toContain("belum dapat memuat konfigurasi autentikasi");
    expect(html).not.toContain("Membuka Akun SQ");
  });
});
