import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";

import { HcisDivider } from "@/components/hcis/HcisDivider";
import { HcisFormField } from "@/components/hcis/HcisFormField";
import { HcisPasswordInput } from "@/components/hcis/HcisPasswordInput";
import { GoogleIcon } from "@/components/hcis/icons/GoogleIcon";
import { AuthApiError, landingPath, login } from "@/lib/auth";
import type { LoginCredentials } from "@/types/hcis";

type FormErrors = Partial<Record<keyof LoginCredentials, string>>;

function validate(data: LoginCredentials, mfaRequired: boolean): FormErrors {
  const errors: FormErrors = {};
  if (!data.email.trim()) errors.email = "Email wajib diisi.";
  if (!data.password) errors.password = "Kata sandi wajib diisi.";
  if (mfaRequired && !data.mfaCode?.trim()) {
    errors.mfaCode = "Kode autentikator wajib diisi.";
  }
  return errors;
}

export function LoginForm() {
  const navigate = useNavigate();
  const [form, setForm] = useState<LoginCredentials>({
    email: "",
    password: "",
    mfaCode: "",
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [googleNotice, setGoogleNotice] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validate(form, mfaRequired);
    setErrors(nextErrors);
    setSubmitError(null);
    if (Object.keys(nextErrors).length > 0) return;

    setIsLoading(true);
    try {
      const session = await login({
        email: form.email,
        password: form.password,
        ...(mfaRequired && form.mfaCode ? { mfaCode: form.mfaCode } : {}),
      });
      await navigate({ to: landingPath(session) });
    } catch (error) {
      if (error instanceof AuthApiError && error.code === "MFA_REQUIRED") {
        setMfaRequired(true);
        setForm((previous) => ({ ...previous, mfaCode: "" }));
        return;
      }

      if (error instanceof AuthApiError) {
        setSubmitError(error.message);
      } else {
        setSubmitError("HCIS belum dapat menghubungi layanan autentikasi. Coba lagi.");
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      <HcisFormField
        id="email"
        label="Email"
        type="email"
        name="email"
        autoComplete="email"
        placeholder="nama@yayasan.sq"
        value={form.email}
        onChange={(event) => setForm((previous) => ({ ...previous, email: event.target.value }))}
        error={errors.email}
      />

      <div className="space-y-1.5">
        <HcisPasswordInput
          id="password"
          label="Kata sandi"
          name="password"
          autoComplete="current-password"
          placeholder="Masukkan kata sandi"
          value={form.password}
          onChange={(event) => setForm((previous) => ({ ...previous, password: event.target.value }))}
          error={errors.password}
        />
        <div className="flex justify-end">
          <button
            type="button"
            className="rounded-md px-1 py-0.5 text-xs font-semibold text-brand-primary-deep hover:text-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/30"
            onClick={() => setSubmitError("Pemulihan kata sandi belum diaktifkan. Hubungi administrator HCIS.")}
          >
            Lupa kata sandi?
          </button>
        </div>
      </div>

      {mfaRequired && (
        <div className="rounded-xl border border-brand-primary/15 bg-brand-primary-pale/45 p-4">
          <HcisFormField
            id="mfa-code"
            label="Kode autentikator"
            type="text"
            name="mfaCode"
            autoComplete="one-time-code"
            placeholder="6 digit atau recovery code"
            value={form.mfaCode ?? ""}
            onChange={(event) =>
              setForm((previous) => ({ ...previous, mfaCode: event.target.value }))
            }
            error={errors.mfaCode}
          />
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Masukkan kode dari aplikasi autentikator. Recovery code sekali pakai juga dapat digunakan.
          </p>
        </div>
      )}

      {submitError && (
        <p
          className="rounded-xl border border-destructive/15 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {submitError}
        </p>
      )}

      <button
        type="submit"
        disabled={isLoading}
        aria-busy={isLoading}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-primary text-sm font-bold text-white shadow-[var(--shadow-button)] transition-[transform,box-shadow,background-color] hover:-translate-y-0.5 hover:bg-brand-primary-deep hover:shadow-[var(--shadow-raised)] active:translate-y-0 active:shadow-[var(--shadow-pressed)] disabled:cursor-not-allowed disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/35"
      >
        {isLoading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Memverifikasi...
          </>
        ) : mfaRequired ? (
          "Verifikasi & masuk"
        ) : (
          "Masuk"
        )}
      </button>

      <HcisDivider text="atau" />

      <button
        type="button"
        className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-white/80 bg-surface-raised text-sm font-semibold text-foreground shadow-[var(--shadow-input)] transition-[transform,box-shadow,background-color,border-color] hover:-translate-y-0.5 hover:border-brand-primary/25 hover:bg-white hover:shadow-[var(--shadow-raised)] active:translate-y-0 active:shadow-[var(--shadow-pressed)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/30"
        onClick={() => setGoogleNotice(true)}
      >
        <GoogleIcon className="h-4 w-4" />
        Masuk dengan Google
      </button>

      {googleNotice && (
        <p
          className="rounded-lg bg-brand-primary-pale/60 px-3 py-2 text-center text-xs text-brand-primary-deep"
          role="status"
        >
          Masuk dengan Google belum diaktifkan. Gunakan akun HCIS yang telah diundang.
        </p>
      )}
    </form>
  );
}
