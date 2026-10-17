import { useEffect, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { ConsistencyReportView } from "@/components/employment/EmploymentPanels";
import { AdminShell } from "@/layouts/AdminShell";
import {
  getEmploymentConsistency,
  viewFromError,
  type EmploymentConsistencyReport,
  type EmploymentView,
} from "@/lib/employment";

function readQuery(): { code: string | null; page: number } {
  const params = new URLSearchParams(window.location.search);
  const page = Number(params.get("page") ?? "1");
  return { code: params.get("code"), page: Number.isInteger(page) && page > 0 ? page : 1 };
}

function hrefFor(code: string | null, page = 1): string {
  const params = new URLSearchParams();
  if (code) params.set("code", code);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return `/admin/employment/consistency${query ? `?${query}` : ""}`;
}

/** EMP-005 S3: "Periksa kecocokan data" for the SHADOW review (spec §13.6). */
export function AdminEmploymentConsistencyPage() {
  const [{ code, page }] = useState(readQuery);
  const [view, setView] = useState<EmploymentView<EmploymentConsistencyReport>>({ kind: "loading" });

  useEffect(() => {
    let mounted = true;
    void getEmploymentConsistency({ ...(code ? { code } : {}), page })
      .then((data) => { if (mounted) setView({ kind: "ready", data }); })
      .catch((cause: unknown) => { if (mounted) setView(viewFromError(cause)); });
    return () => {
      mounted = false;
    };
  }, [code, page]);

  return (
    <AdminShell
      active="employment-consistency"
      title="Periksa Kecocokan Data"
      description="Tinjau data awal kepegawaian dari master pegawai sebelum riwayat kepegawaian dipakai."
    >
      <ConsistencyReportView
        view={view}
        selectedCode={code}
        codeHref={(selected) => hrefFor(selected)}
        employeeHref={(employeeId) => `/admin/employees/${employeeId}`}
      />
      {view.kind === "ready" && view.data.total > view.data.pageSize ? (
        <div className="mt-4 overflow-hidden rounded-2xl border border-border/70">
          <PaginationBar
            page={view.data.page}
            pageSize={view.data.pageSize}
            total={view.data.total}
            onPageChange={(next) => window.location.assign(hrefFor(code, next))}
          />
        </div>
      ) : null}
    </AdminShell>
  );
}
