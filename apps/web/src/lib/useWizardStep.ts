import { useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

/**
 * UX-FLOW-001: menyimpan langkah wizard pada query `?langkah=` sehingga
 * setiap langkah tampil sebagai layar sendiri, tombol Kembali browser/Android
 * kembali ke langkah sebelumnya, dan langkah baru selalu dibuka dari atas.
 */
export function useWizardStep<S extends string>(steps: readonly S[]) {
  const navigate = useNavigate();
  const location = useLocation();
  const raw = (location.search as Record<string, unknown>).langkah;
  const first = steps[0] as S;
  const step: S =
    typeof raw === "string" && (steps as readonly string[]).includes(raw)
      ? (raw as S)
      : first;

  const goTo = useCallback(
    (next: S, options: { replace?: boolean } = {}) => {
      void navigate({
        to: location.pathname,
        search: (next === first ? {} : { langkah: next }) as never,
        replace: options.replace ?? false,
      });
    },
    [navigate, location.pathname, first],
  );

  useEffect(() => {
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  }, [step]);

  return { step, index: steps.indexOf(step), goTo };
}
