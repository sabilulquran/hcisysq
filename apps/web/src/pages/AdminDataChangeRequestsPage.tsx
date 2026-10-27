// EMP-003 P2-4, HC side (spec §7.4): the queue of proposals waiting for a
// decision, longest waiting first. Accepting writes the change; the API says
// whether it still can.

import { useEffect, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { DataChangeWorklistView } from "@/components/employment/DataChangePanels";
import { AdminShell } from "@/layouts/AdminShell";
import { EmploymentApiError, type EmploymentView } from "@/lib/employment";
import {
  STATE_LABEL,
  acceptDataChange,
  getDataChangeWorklist,
  rejectDataChange,
  type DataChangeState,
  type DataChangeWorklist,
} from "@/lib/employeeDataChanges";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";

const STATES: DataChangeState[] = ["DIAJUKAN", "DITERIMA", "DITOLAK", "DIBATALKAN"];

function readQuery(): { state: DataChangeState; page: number } {
  const params = new URLSearchParams(window.location.search);
  const state = params.get("state") as DataChangeState | null;
  const page = Number(params.get("page") ?? "1");
  return {
    state: state && STATES.includes(state) ? state : "DIAJUKAN",
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

function hrefFor(state: DataChangeState, page = 1): string {
  const params = new URLSearchParams({ state });
  if (page > 1) params.set("page", String(page));
  return `/admin/employees/data-changes?${params.toString()}`;
}

function viewFrom(cause: unknown): EmploymentView<never> {
  if (cause instanceof EmploymentApiError) {
    if (cause.status === 403) return { kind: "forbidden" };
    return { kind: "error", message: cause.message };
  }
  return { kind: "error", message: "Daftar usulan tidak dapat dimuat. Periksa koneksi lalu coba lagi." };
}

export function AdminDataChangeRequestsPage({ askReason }: { askReason?: (question: string) => string | null } = {}) {
  const [{ state, page }] = useState(readQuery);
  const [view, setView] = useState<EmploymentView<DataChangeWorklist>>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [canDecide, setCanDecide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void getCurrentSession().then((session) => {
      if (mounted) setCanDecide(hasPermission(session, "employees.manage"));
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let mounted = true;
    setView({ kind: "loading" });
    void getDataChangeWorklist({ state, page })
      .then((data) => { if (mounted) setView({ kind: "ready", data }); })
      .catch((cause: unknown) => { if (mounted) setView(viewFrom(cause)); });
    return () => { mounted = false; };
  }, [state, page, reloadToken]);

  const ask = askReason ?? ((question: string) => window.prompt(question));

  async function run(work: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof EmploymentApiError ? cause.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminShell
      active="data-changes"
      title="Usulan Perubahan Data"
      description="Usulan pegawai atas datanya sendiri, menunggu keputusan Human Capital."
    >
      <div className="mb-4 flex flex-wrap gap-2">
        {STATES.map((option) => (
          <a
            key={option}
            href={hrefFor(option)}
            aria-current={option === state ? "page" : undefined}
            className={`rounded-xl px-3 py-1.5 text-sm font-bold ${
              option === state ? "bg-brand-primary-deep text-white" : "border border-border/70 text-muted-foreground"
            }`}
          >
            {STATE_LABEL[option]}
          </a>
        ))}
      </div>

      {notice ? <p role="status" className="mb-4 rounded-2xl border border-border/70 bg-surface p-4 text-sm">{notice}</p> : null}
      {error ? <p role="alert" className="mb-4 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</p> : null}

      {/* An empty page past the end is not an empty queue. */}
      {view.kind === "ready" && view.data.rows.length === 0 && view.data.total > 0 ? (
        <div className="mb-4 rounded-2xl border border-border/70 p-4">
          <p className="text-sm text-muted-foreground">
            Halaman {view.data.page} kosong. Ada {view.data.total} usulan pada status ini.
          </p>
          <a className="mt-2 inline-block text-sm font-bold text-brand-primary-deep" href={hrefFor(state)}>
            Kembali ke halaman pertama
          </a>
        </div>
      ) : null}

      <DataChangeWorklistView
        view={view.kind === "ready"
          ? { kind: "ready", data: { rows: view.data.rows, total: view.data.total, state: view.data.state } }
          : view}
        employeeHref={(employeeId) => `/admin/employees/${employeeId}`}
        actions={{
          canDecide,
          busy,
          onAccept: (requestId) => void run(async () => {
            await acceptDataChange(requestId);
            setNotice("Usulan diterima dan perubahannya dicatat.");
            setReloadToken((token) => token + 1);
          }, "Usulan tidak dapat diterima."),
          onReject: (requestId) => {
            const reason = ask("Alasan penolakan (minimal 5 huruf):")?.trim() ?? "";
            if (reason.length < 5) return;
            void run(async () => {
              await rejectDataChange(requestId, reason);
              setNotice("Usulan ditolak beserta alasannya.");
              setReloadToken((token) => token + 1);
            }, "Usulan tidak dapat ditolak.");
          },
        }}
      />

      {view.kind === "ready" && view.data.total > view.data.pageSize ? (
        <div className="mt-4 overflow-hidden rounded-2xl border border-border/70">
          <PaginationBar
            page={view.data.page}
            pageSize={view.data.pageSize}
            total={view.data.total}
            onPageChange={(next) => window.location.assign(hrefFor(state, next))}
          />
        </div>
      ) : null}
    </AdminShell>
  );
}
