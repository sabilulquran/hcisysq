// ORG-012 detail shared by the employee and Human Capital screens: the activity, the line-up and
// the printable SK panitia. Every action is passed in; this component decides nothing.

import { Printer } from "lucide-react";
import type { ReactNode } from "react";

import {
  CATEGORY_LABELS,
  decreeLineUp,
  formatDate,
  formatPeriod,
  ROLE_LABELS,
  STATUS_LABELS,
  type CommitteeDetail,
  type CommitteeMember,
} from "@/lib/committees";

function DecreePaper({ detail }: { detail: CommitteeDetail }) {
  const snapshot = detail.decreeSnapshot;
  const lineUp = decreeLineUp(detail);
  return (
    <article className="committee-decree-paper sq-paper rounded-2xl border border-border bg-white p-6 text-sm text-slate-900">
      <p className="text-center text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">Yayasan Sabilul Qur&apos;an</p>
      <h3 className="mt-2 text-center text-lg font-bold">SURAT KEPUTUSAN</h3>
      <p className="text-center text-xs">Nomor: {detail.decreeNumber ?? "-"}</p>
      <p className="mt-1 text-center font-semibold">tentang Susunan {snapshot?.name ?? detail.name}</p>
      {detail.decreeStatus === "REVOKED" ? (
        <p className="mt-3 rounded-lg border border-red-300 bg-red-50 p-2 text-center text-xs font-bold text-red-700">DICABUT — surat ini tidak berlaku</p>
      ) : null}
      <p className="mt-5">
        Menetapkan susunan panitia {snapshot?.name ?? detail.name}
        {(snapshot?.organizer ?? detail.organizer) ? ` yang diselenggarakan ${snapshot?.organizer ?? detail.organizer}` : ""}
        {" "}untuk periode {formatPeriod(snapshot?.startOn ?? detail.startOn, snapshot?.endOn ?? detail.endOn)} sebagai berikut:
      </p>
      <table className="mt-3 w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-slate-300">
            <th className="py-1 pr-2">No</th>
            <th className="py-1 pr-2">Nama</th>
            <th className="py-1 pr-2">Unit</th>
            <th className="py-1">Jabatan dalam panitia</th>
          </tr>
        </thead>
        <tbody>
          {lineUp.map((member, index) => (
            <tr key={`${member.fullName}-${index}`} className="border-b border-slate-200 align-top">
              <td className="py-1 pr-2">{index + 1}</td>
              <td className="py-1 pr-2 font-medium">{member.fullName}</td>
              <td className="py-1 pr-2">{member.unitName ?? "-"}</td>
              <td className="py-1">{ROLE_LABELS[member.role]}{member.section ? ` (${member.section})` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-4">Keputusan ini berlaku sejak tanggal ditetapkan sampai berakhirnya kegiatan.</p>
      <div className="mt-8 ml-auto w-56 text-center">
        <p>Ditetapkan {formatDate(detail.decreeDate, true)}</p>
        <p className="mt-1">{detail.decreeSigner?.title ?? ""}</p>
        <p className="mt-14 font-bold underline">{detail.decreeSigner?.name ?? "-"}</p>
      </div>
      {snapshot?.carbonCopies?.length ? (
        <div className="mt-6 text-xs">
          <p>Tembusan:</p>
          <ol className="list-decimal pl-5">
            {snapshot.carbonCopies.map((recipient) => <li key={recipient}>{recipient}</li>)}
          </ol>
        </div>
      ) : null}
    </article>
  );
}

function MemberRow({ member, highlight, actions }: { member: CommitteeMember; highlight: boolean; actions?: ReactNode }) {
  const ended = member.leftOn !== null;
  return (
    <li className={`flex flex-wrap items-start justify-between gap-2 px-3 py-2.5 text-sm ${highlight ? "bg-brand-primary-pale/60" : ""}`}>
      <div className="min-w-0">
        <p className={`font-semibold ${ended ? "text-muted-foreground line-through" : "text-brand-heading"}`}>
          {member.fullName}
          {member.employeeNumber ? <span className="ml-1 text-xs font-normal text-muted-foreground">{member.employeeNumber}</span> : null}
        </p>
        <p className="text-xs text-muted-foreground">
          {ROLE_LABELS[member.role]}{member.section ? ` · ${member.section}` : ""} · {member.unitName ?? "Tanpa unit"}
        </p>
        <p className="text-[11px] text-muted-foreground">
          Bergabung {formatDate(member.joinedOn)}
          {ended ? ` · berakhir ${formatDate(member.leftOn)}` : ""}
          {member.endReason ? ` · ${member.endReason}` : ""}
          {member.employeeStatus && member.employeeStatus !== "active" ? " · bukan pegawai aktif" : ""}
        </p>
      </div>
      {actions ? <div className="flex flex-wrap gap-1.5">{actions}</div> : null}
    </li>
  );
}

export function CommitteeDetailPanel({
  detail,
  actions,
  memberActions,
  children,
}: {
  detail: CommitteeDetail;
  actions?: ReactNode;
  memberActions?: (member: CommitteeMember) => ReactNode;
  children?: ReactNode;
}) {
  const current = detail.members.filter((member) => member.leftOn === null);
  const past = detail.members.filter((member) => member.leftOn !== null);
  const mine = new Set(detail.myMemberIds ?? []);
  const printable = detail.decreeMode === "ISSUED" || detail.decreeMode === "EXTERNAL";
  return (
    <div className="space-y-5">
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 18mm; }
          body * { visibility: hidden !important; }
          .committee-decree-paper, .committee-decree-paper * { visibility: visible !important; }
          .committee-decree-paper { position: absolute !important; inset: 0 auto auto 0 !important; width: 100% !important; border: 0 !important; }
        }
      `}</style>
      <div>
        <p className="text-xs font-semibold text-muted-foreground">{STATUS_LABELS[detail.status]} · {CATEGORY_LABELS[detail.category]}</p>
        <h3 className="mt-1 text-lg font-bold text-brand-heading">{detail.name}</h3>
        <p className="mt-1 text-sm text-foreground">
          {formatPeriod(detail.startOn, detail.endOn)}{detail.organizer ? ` · ${detail.organizer}` : ""}
        </p>
        {detail.description ? <p className="mt-2 whitespace-pre-line text-sm leading-6 text-muted-foreground">{detail.description}</p> : null}
        {detail.cancelReason ? <p className="mt-2 text-sm text-danger-ink">Alasan pembatalan: {detail.cancelReason}</p> : null}
      </div>

      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      {children}

      <section>
        <h4 className="text-sm font-bold text-brand-heading">Susunan panitia ({current.length})</h4>
        {current.length === 0 ? (
          <p className="mt-2 rounded-xl border border-dashed border-border p-3 text-sm text-muted-foreground">Belum ada anggota.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border/70 rounded-xl border border-border/70 bg-surface">
            {current.map((member) => (
              <MemberRow key={member.id} member={member} highlight={mine.has(member.id)} actions={memberActions?.(member)} />
            ))}
          </ul>
        )}
        {past.length > 0 ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">Riwayat anggota ({past.length})</summary>
            <ul className="mt-2 divide-y divide-border/70 rounded-xl border border-border/70 bg-surface">
              {past.map((member) => <MemberRow key={member.id} member={member} highlight={mine.has(member.id)} />)}
            </ul>
          </details>
        ) : null}
      </section>

      {printable ? (
        <section>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 className="text-sm font-bold text-brand-heading">SK panitia</h4>
              <p className="text-xs text-muted-foreground">
                {detail.decreeNumber} · {formatDate(detail.decreeDate)}
                {detail.decreeMode === "EXTERNAL" ? " · SK di luar HCIS" : ""}
                {detail.decreeStatus === "REVOKED" ? " · dicabut" : ""}
              </p>
            </div>
            {detail.decreeMode === "ISSUED" && detail.decreeStatus === "ISSUED" ? (
              <button type="button" onClick={() => window.print()}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading">
                <Printer className="h-4 w-4" aria-hidden="true" /> Cetak SK
              </button>
            ) : null}
          </div>
          {detail.decreeMode === "ISSUED" ? (
            <div className="mt-2 overflow-x-auto">
              <DecreePaper detail={detail} />
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">SK ditandatangani di luar HCIS; arsip aslinya ada pada penerbit.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
