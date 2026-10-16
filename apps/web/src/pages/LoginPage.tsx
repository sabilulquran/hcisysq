import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { LoginForm } from "@/components/hcis/LoginForm";
import { AuthLayout } from "@/layouts/AuthLayout";
import { getAuthMode, oidcLoginFailureMessage, type AuthMode } from "@/lib/auth";

export function LoginPage() {
  const [mode, setMode] = useState<AuthMode | null>(null);
  const [modeError, setModeError] = useState(false);

  useEffect(() => {
    let active = true;
    getAuthMode()
      .then((nextMode) => {
        if (active) setMode(nextMode);
      })
      .catch(() => {
        if (active) setModeError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const authError = oidcLoginFailureMessage(
    new URLSearchParams(window.location.search).get("authError"),
  );

  return (
    <AuthLayout>
      <header className="mb-7 sm:mb-8">
        <span className="mb-4 block h-1 w-12 rounded-full bg-brand-yellow" aria-hidden="true" />
        <h2 className="font-display text-3xl font-bold leading-[1.08] tracking-[-0.018em] text-brand-heading sm:text-[2.15rem]">
          Selamat datang kembali
        </h2>
        <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
          Masuk untuk membuka layanan kepegawaian sesuai kewenangan akun Anda.
        </p>
      </header>

      {mode === "local" && <LoginForm />}

      {mode === "oidc" && (
        <div className="space-y-4">
          {authError ? (
            <p
              className="rounded-xl border border-destructive/15 bg-destructive/5 px-4 py-3 text-sm leading-6 text-destructive"
              role="alert"
            >
              {authError}
            </p>
          ) : null}
          <a
            href="/api/auth/oidc/start"
            className="flex h-12 w-full items-center justify-center rounded-xl bg-brand-primary text-sm font-bold text-brand-foreground shadow-[var(--shadow-button)] transition-[transform,box-shadow,background-color] hover:-translate-y-0.5 hover:bg-brand-primary-deep hover:shadow-[var(--shadow-raised)] active:translate-y-0 active:shadow-[var(--shadow-pressed)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/35"
          >
            Masuk dengan SQ Identity
          </a>
          <p className="text-center text-xs leading-5 text-muted-foreground">
            Gunakan identitas Staff Sabilul Qur&apos;an yang telah diaktifkan.
          </p>
        </div>
      )}

      {!mode && !modeError && (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Memeriksa metode masuk...
        </div>
      )}

      {modeError && (
        <p
          className="rounded-xl border border-destructive/15 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          HCIS belum dapat memuat konfigurasi autentikasi. Muat ulang halaman untuk mencoba lagi.
        </p>
      )}
    </AuthLayout>
  );
}
