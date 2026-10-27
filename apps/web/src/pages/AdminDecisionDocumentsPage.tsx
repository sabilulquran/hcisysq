import { useEffect, useState } from "react";

import { DecisionDocumentRegister } from "@/components/employment/DecisionDocumentRegister";
import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import type { DecisionDocumentKind } from "@/lib/decision-documents";
import type { AuthSession } from "@/types/hcis";

function readKind(): DecisionDocumentKind {
  return new URLSearchParams(window.location.search).get("kind") === "SURAT_KEPUTUSAN"
    ? "SURAT_KEPUTUSAN"
    : "PERJANJIAN_KERJA";
}

/** EMP-010 S4: menu "Perjanjian Kerja & SK" (spec §13.5). */
export function AdminDecisionDocumentsPage() {
  const [kind, setKind] = useState<DecisionDocumentKind>(readKind);
  const [session, setSession] = useState<AuthSession | null>(null);

  useEffect(() => {
    let mounted = true;
    void getCurrentSession().then((current) => { if (mounted) setSession(current); });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <AdminShell
      active="decision-documents"
      title="Perjanjian Kerja & SK"
      description="Daftar dokumen dasar kepegawaian. Dokumen yang sudah dipakai pada tindakan hanya dapat diubah melalui koreksi."
    >
      <DecisionDocumentRegister
        kind={kind}
        onKindChange={(next) => {
          setKind(next);
          const url = new URL(window.location.href);
          url.searchParams.set("kind", next);
          window.history.replaceState(null, "", url.toString());
        }}
        canManage={hasPermission(session, "employment.manage")}
        canCorrect={hasPermission(session, "employment.correct")}
        employeeHref={(employeeId) => `/admin/employees/${employeeId}`}
      />
    </AdminShell>
  );
}
