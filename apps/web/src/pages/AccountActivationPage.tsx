import { CheckCircle2, KeyRound } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { AuthLayout } from "@/layouts/AuthLayout";
import {
  AccountActivationApiError,
  activateAccount,
  getActivationPreview,
} from "@/lib/accountActivation";

interface Preview {
  maskedEmail: string;
  principalType: "EMPLOYEE" | "FOUNDATION_BOARD";
  expiresAt: string;
}

function accessLabel(principalType: Preview["principalType"]) {
  return principalType === "FOUNDATION_BOARD" ? "Dashboard Organ Yayasan" : "Portal Pegawai";
}

export function AccountActivationPage() {
  const [token, setToken] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let mounted = true;
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const activationToken = fragment.get("token")?.trim() ?? "";

    if (window.location.hash) {
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }

    setToken(activationToken);
    if (!activationToken) {
      setError("Link aktivasi tidak lengkap. Minta link aktivasi baru kepada administrator.");
      setLoading(false);
      return () => {
        mounted = false;
      };
    }

    void getActivationPreview(activationToken)
      .then((result) => {
        if (mounted) setPreview(result);
      })
      .catch((cause: unknown) => {
        if (!mounted) return;
        setError(
          cause instanceof AccountActivationApiError
            ? cause.message
            : "Link aktivasi tidak dapat diperiksa.",
        );
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!token) {
      setError("Link aktivasi tidak lengkap. Minta link aktivasi baru kepada administrator.");
      return;
    }
    if (password.length < 12) {
      setError("Kata sandi minimal 12 karakter.");
      return;
    }
    if (password !== confirmation) {
      setError("Konfirmasi kata sandi belum sama.");
      return;
    }

    setBusy(true);
    try {
      await activateAccount(token, password);
      setPassword("");
      setConfirmation("");
      setToken("");
      setSuccess(true);
    } catch (cause) {
      setError(
        cause instanceof AccountActivationApiError
          ? cause.message
          : "Account tidak dapat diaktifkan.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <header className="mb-7 sm:mb-8">
        <span className="mb-4 block h-1 w-12 rounded-full bg-brand-yellow" aria-hidden="true" />
        <h2 className="font-display text-3xl font-bold leading-[1.08] tracking-[-0.018em] text-brand-heading sm:text-[2.15rem]">
          Aktifkan account
        </h2>
        <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
          Buat kata sandi untuk membuka layanan kepegawaian sesuai jenis account yang sudah ditetapkan administrator.
        </p>
      </header>

      {loading ? (
        <div className="rounded-2xl border border-border/70 bg-surface p-5 text-sm text-muted-foreground">
          Memeriksa link aktivasi...
        </div>
      ) : success ? (
        <div className="rounded-2xl border border-success-line bg-success-soft p-5">
          <CheckCircle2 className="h-6 w-6 text-success-ink" aria-hidden="true" />
          <h3 className="mt-3 text-base font-bold text-success-ink">Account sudah aktif</h3>
          <p className="mt-1 text-sm leading-6 text-success-ink/80">
            Silakan masuk menggunakan email dan kata sandi yang baru dibuat.
          </p>
          <a
            href="/"
            className="mt-4 inline-flex h-10 items-center rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground"
          >
            Ke halaman masuk
          </a>
        </div>
      ) : preview ? (
        <>
          <div className="mb-5 rounded-2xl border border-border/70 bg-surface p-4">
            <div className="flex items-start gap-3">
              <KeyRound className="mt-0.5 h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
              <div>
                <p className="text-sm font-bold text-foreground">{accessLabel(preview.principalType)}</p>
                <p className="mt-1 text-sm text-muted-foreground">{preview.maskedEmail}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Link berlaku sampai {new Date(preview.expiresAt).toLocaleString("id-ID")}.
                </p>
              </div>
            </div>
          </div>

          {error ? (
            <div className="mb-4 rounded-xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink">
              {error}
            </div>
          ) : null}

          <form onSubmit={submit} className="space-y-4">
            <label className="block text-sm font-semibold text-foreground">
              Kata sandi baru
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={12}
                maxLength={128}
                required
                className="mt-1.5 h-11 w-full rounded-xl border border-border bg-surface-raised px-3 text-sm outline-none focus:border-brand-primary"
              />
              <span className="mt-1.5 block text-xs font-normal text-muted-foreground">
                Minimal 12 karakter.
              </span>
            </label>

            <label className="block text-sm font-semibold text-foreground">
              Ulangi kata sandi
              <input
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                minLength={12}
                maxLength={128}
                required
                className="mt-1.5 h-11 w-full rounded-xl border border-border bg-surface-raised px-3 text-sm outline-none focus:border-brand-primary"
              />
            </label>

            <button
              type="submit"
              disabled={busy}
              className="h-11 w-full rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50"
            >
              {busy ? "Mengaktifkan..." : "Aktifkan account"}
            </button>
          </form>
        </>
      ) : (
        <div className="rounded-2xl border border-danger-line bg-danger-soft p-5">
          <h3 className="text-base font-bold text-danger-ink">Link aktivasi tidak tersedia</h3>
          <p className="mt-2 text-sm leading-6 text-danger-ink/80">
            {error ?? "Minta link aktivasi baru kepada administrator."}
          </p>
          <a href="/" className="mt-4 inline-flex text-sm font-bold text-brand-primary-deep">
            Kembali ke halaman masuk
          </a>
        </div>
      )}
    </AuthLayout>
  );
}
