// ORG-011 Package 4: read-only view of the classifications in force for one employee.
// Shows exactly what the resolver contracted to PAY-003 returns, plus any blocker as a warning,
// so Human Capital can fix a placement before a payroll period trips over it. It never carries
// money and never implies approval authority (ADR-0004).

import { Tags } from "lucide-react";
import { useEffect, useState } from "react";

import { AdminApiError } from "@/lib/adminEmployees";
import {
  getEmployeeJobClassifications,
  jobFamilyLabels,
  type EmployeeClassificationEmployment,
  type ResolvedClassification,
} from "@/lib/jobClassifications";

const SOURCE_LABEL = { PLACEMENT: "dari penempatan", POSITION: "dari kursi jabatan" } as const;

function slotText(slot: ResolvedClassification | null): string {
  if (!slot) return "Tidak ada";
  return `${slot.name} (${slot.code}${slot.gradeCode ? `, golongan ${slot.gradeCode}` : ""}) · ${SOURCE_LABEL[slot.source]}`;
}

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; onDate: string; employments: EmployeeClassificationEmployment[] };

export function EmployeeJobClassificationCard({ employeeId }: { employeeId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let mounted = true;
    setState({ kind: "loading" });
    getEmployeeJobClassifications(employeeId)
      .then((result) => { if (mounted) setState({ kind: "ready", onDate: result.onDate, employments: result.employments }); })
      .catch((cause: unknown) => {
        if (mounted) setState({ kind: "error", message: cause instanceof AdminApiError ? cause.message : "Klasifikasi jabatan gagal dimuat." });
      });
    return () => { mounted = false; };
  }, [employeeId]);

  return (
    <article className="rounded-2xl border border-border/70 bg-surface p-5" aria-label="Klasifikasi jabatan">
      <div className="flex items-center gap-3">
        <Tags className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
        <h3 className="text-sm font-bold text-brand-heading">Klasifikasi jabatan</h3>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Acuan tabel tunjangan payroll. Tidak memuat nominal dan tidak memberi kewenangan persetujuan.</p>
      {state.kind === "loading" ? <p className="mt-3 text-sm text-muted-foreground">Memuat…</p> : null}
      {state.kind === "error" ? <p role="alert" className="mt-3 text-sm text-danger-ink">{state.message}</p> : null}
      {state.kind === "ready" && state.employments.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">Tidak ada hubungan kerja yang berlaku pada tanggal ini.</p>
      ) : null}
      {state.kind === "ready" ? state.employments.map((employment) => (
        <div key={employment.employmentId} className="mt-3 space-y-2 text-sm">
          {employment.error ? (
            <p role="alert" className="rounded-md bg-warning-soft px-3 py-2 text-xs font-semibold text-warning-ink">
              {employment.error.message} Payroll akan memblokir periode ini sampai penempatannya diperbaiki.
            </p>
          ) : null}
          {employment.slots ? (
            <dl className="grid gap-x-5 gap-y-2 sm:grid-cols-2">
              <div><dt className="text-xs font-semibold text-muted-foreground">Fungsional</dt><dd>{slotText(employment.slots.functional)}</dd></div>
              <div><dt className="text-xs font-semibold text-muted-foreground">Struktural</dt><dd>{slotText(employment.slots.structural)}</dd></div>
            </dl>
          ) : null}
          {employment.bindings.length === 0 ? (
            <p className="text-xs text-muted-foreground">Belum ada klasifikasi yang ditetapkan pada penempatan maupun kursi jabatannya.</p>
          ) : (
            <ul className="text-xs text-muted-foreground">
              {employment.bindings.map((binding, index) => (
                <li key={`${binding.code}-${index}`}>
                  <span className="font-mono">{binding.code}</span>
                  {binding.family ? ` · ${jobFamilyLabels[binding.family]}` : " · tidak berlaku pada tanggal ini"}
                  {` · ${SOURCE_LABEL[binding.source]}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      )) : null}
    </article>
  );
}
