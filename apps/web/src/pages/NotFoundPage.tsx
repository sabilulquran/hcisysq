import { FileQuestion } from "lucide-react";

export function NotFoundPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-5 py-10">
      <section className="w-full max-w-lg rounded-3xl border border-border/70 bg-surface-raised p-7 text-center shadow-[var(--shadow-soft)] sm:p-9">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-primary-pale text-brand-primary-deep">
          <FileQuestion className="h-6 w-6" aria-hidden="true" />
        </span>
        <p className="mt-5 text-xs font-bold uppercase tracking-[0.18em] text-brand-primary-deep">404</p>
        <h1 className="mt-2 font-display text-2xl font-bold text-brand-heading">Halaman tidak tersedia</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Alamat ini tidak tersedia untuk account Anda atau halaman yang dituju tidak ditemukan.
        </p>
        <a
          href="/"
          className="mt-6 inline-flex h-10 items-center rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground"
        >
          Kembali
        </a>
      </section>
    </main>
  );
}
