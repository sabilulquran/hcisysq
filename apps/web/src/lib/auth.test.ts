import { describe, expect, it } from "vitest";

import { oidcLoginFailureMessage } from "@/lib/auth";

describe("OIDC login failure copy", () => {
  it("distinguishes application access outcomes from technical identity failure", () => {
    expect(oidcLoginFailureMessage("access_denied")).toContain("belum memiliki akses ke HCIS");
    expect(oidcLoginFailureMessage("access_unavailable")).toContain("belum dapat memverifikasi hak akses");
    expect(oidcLoginFailureMessage("account_inactive")).toContain("sedang tidak aktif");
    expect(oidcLoginFailureMessage("oidc_failed")).toBe(
      "Masuk dengan Akun SQ belum berhasil. Silakan coba lagi.",
    );
  });

  it("does not render arbitrary query-string values as login errors", () => {
    expect(oidcLoginFailureMessage("OIDC_ACCOUNT_NOT_MAPPED")).toBeNull();
    expect(oidcLoginFailureMessage("token=secret")).toBeNull();
    expect(oidcLoginFailureMessage(null)).toBeNull();
  });
});
