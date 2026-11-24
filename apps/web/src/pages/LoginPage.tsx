import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { LoginForm } from "@/components/hcis/LoginForm";
import { AuthLayout } from "@/layouts/AuthLayout";
import {
  claimOidcRetry,
  getAuthMode,
  isOidcRetryCandidate,
  loginSearch,
  oidcLoginFailureMessage,
  oidcStartHref,
  sessionRetryStorage,
  shouldStartOidcAutomatically,
  type AuthMode,
  type LoginSearch,
} from "@/lib/auth";

function currentLoginSearch(): LoginSearch {
  return loginSearch(Object.fromEntries(new URLSearchParams(window.location.search)));
}

export function LoginPage() {
  const [mode, setMode] = useState<AuthMode | null>(null);
  const [modeError, setModeError] = useState(false);
  const [search] = useState(currentLoginSearch);

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

  const autoStart = shouldStartOidcAutomatically(mode, search);
  useEffect(() => {
    // replace(): Back from Akun SQ must not land on this hand-off page again.
    if (autoStart) window.location.replace(oidcStartHref(search.returnTo));
  }, [autoStart, search.returnTo]);

  // AUTH-012 Rev 2: one automatic retry after a generic callback failure, then the button.
  const retryCandidate = isOidcRetryCandidate(search);
  const [retryDeclined, setRetryDeclined] = useState(false);
  const retryClaimed = useRef(false);
  useEffect(() => {
    if (!retryCandidate || retryDeclined || retryClaimed.current || mode === null) return;
    if (mode === "oidc" && claimOidcRetry(sessionRetryStorage(), Date.now())) {
      retryClaimed.current = true;
      window.location.replace(oidcStartHref(search.returnTo));
      return;
    }
    setRetryDeclined(true);
  }, [mode, retryCandidate, retryDeclined, search.returnTo]);
  const retrying = retryCandidate && !retryDeclined && !modeError && mode !== "local";

  return <LoginPageView mode={mode} modeError={modeError} search={search} retrying={retrying} />;
}

export function LoginPageView({
  mode,
  modeError,
  search,
  retrying = false,
}: {
  mode: AuthMode | null;
  modeError: boolean;
  search: LoginSearch;
  /** AUTH-012 Rev 2: an automatic retry after `oidc_failed` is pending or under way. */
  retrying?: boolean;
}) {
  // Without a callback failure the visitor is most likely on the way to Akun SQ, so the
  // full login page is held back until the mode says otherwise. This avoids a hero flash.
  // The same holds while the one automatic retry after a callback failure is decided or runs.
  if (!modeError && mode !== "local" && (search.authError === undefined || retrying)) {
    return <LoginHandOff label={mode === "oidc" ? "Membuka Akun SQ…" : "Memeriksa metode masuk..."} />;
  }

  const authError = oidcLoginFailureMessage(search.authError ?? null);

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
            href={oidcStartHref(search.returnTo)}
            className="flex h-12 w-full items-center justify-center rounded-xl bg-brand-primary text-sm font-bold text-brand-foreground shadow-[var(--shadow-button)] transition-[transform,box-shadow,background-color] hover:-translate-y-0.5 hover:bg-brand-primary-deep hover:shadow-[var(--shadow-raised)] active:translate-y-0 active:shadow-[var(--shadow-pressed)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/35"
          >
            Masuk dengan Akun SQ
          </a>
          <p className="text-center text-xs leading-5 text-muted-foreground">
            Gunakan Akun SQ yang sama untuk semua aplikasi SQ Suite, termasuk HCIS dan Aset SQ.
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

function LoginHandOff({ label }: { label: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-5 py-10">
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        {label}
      </div>
    </main>
  );
}
