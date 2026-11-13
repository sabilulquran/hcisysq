// NOTIF-003 rule catalog (docs/domain/reminders.md §4). Each rule reads the state it is about and
// returns candidates; the engine makes them idempotent, writes in-app notifications and queues
// WhatsApp. Thresholds and hours are DRAFT defaults.

import type { Pool, PoolClient } from "pg";

import { DOCUMENT_TYPE_RULES, type DocumentType } from "../employee-documents/domain.js";
import { getRolloutMode } from "../employment/infrastructure/postgres-employment-store.js";
import { daysBetween, dueLabel, formatJakartaDate, thresholdReached } from "./domain.js";

type Db = Pool | PoolClient;

export interface ReminderCandidate {
  occurrenceKey: string;
  accountId: string;
  /** Present when the recipient is an employee who can receive WhatsApp. */
  employeeId: string | null;
  title: string;
  body: string;
  href: string;
  /** D-07: no other employee's name, no amounts, no document content. */
  whatsappText: string;
}

export interface ReminderRule {
  key: string;
  label: string;
  description: string;
  defaultWhatsApp: boolean;
  /** WIB hour at or after which the rule runs once per day (D-05). */
  fireHour: number;
  /** Jakarta weekdays (0 = Sunday); omitted means every day. */
  weekdays?: readonly number[];
  generate(db: Db, context: { today: string }): Promise<ReminderCandidate[]>;
}

const MONDAY_TO_SATURDAY = [1, 2, 3, 4, 5, 6] as const;

/** D-13: active employee accounts holding a permission at organization scope today. */
export async function accountsWithPermission(db: Db, permissionKeys: readonly string[], today: string) {
  const result = await db.query<{ accountId: string; employeeId: string }>(
    `SELECT account.id AS "accountId", account.employee_id AS "employeeId"
       FROM accounts account
       JOIN employees employee ON employee.id = account.employee_id
      WHERE account.principal_type = 'EMPLOYEE' AND account.status = 'active'
        AND employee.status = 'active' AND employee.removed_at IS NULL
        AND (
          EXISTS (
            SELECT 1 FROM account_role_assignments assignment
              JOIN role_permissions role_permission ON role_permission.role_id = assignment.role_id
             WHERE assignment.account_id = account.id
               AND role_permission.permission_key = ANY($1::text[])
               AND assignment.scope_type = 'organization' AND assignment.organizational_unit_id IS NULL
               AND (assignment.starts_on IS NULL OR assignment.starts_on <= $2::date)
               AND (assignment.ends_on IS NULL OR assignment.ends_on >= $2::date)
          )
          OR EXISTS (
            SELECT 1 FROM hcis_seat_permissions($2::date, account.id) seat
             WHERE seat.permission_key = ANY($1::text[])
          )
        )
      ORDER BY account.id`,
    [permissionKeys, today],
  );
  return result.rows;
}

/** D-14: the active account of an active employee, as NOTIF-004 resolves it. */
const EMPLOYEE_ACCOUNT_JOIN = `
  JOIN employees recipient ON recipient.id = %EMPLOYEE% AND recipient.status = 'active' AND recipient.removed_at IS NULL
  JOIN LATERAL (
    SELECT account.id FROM accounts account
     WHERE account.employee_id = recipient.id AND account.principal_type = 'EMPLOYEE' AND account.status = 'active'
     ORDER BY account.id LIMIT 1
  ) recipient_account ON true`;

function employeeAccountJoin(employeeColumn: string) {
  return EMPLOYEE_ACCOUNT_JOIN.replace("%EMPLOYEE%", employeeColumn);
}

/** Digest rules: one reminder per holder per day, only when the queue is not empty. */
function digestToHolders(
  holders: Array<{ accountId: string; employeeId: string }>,
  input: { today: string; title: string; body: string; href: string; whatsappText: string },
): ReminderCandidate[] {
  return holders.map((holder) => ({
    occurrenceKey: input.today,
    accountId: holder.accountId,
    employeeId: holder.employeeId,
    title: input.title,
    body: input.body,
    href: input.href,
    whatsappText: input.whatsappText,
  }));
}

const TERM_LABEL: Record<string, string> = {
  KONTRAK: "Kontrak",
  KONTRAK_HONORER: "Kontrak honorer",
  MAGANG: "Masa magang",
  PERCOBAAN: "Masa percobaan",
  LEPAS: "Kontrak lepas",
};

export const REMINDER_RULES: readonly ReminderRule[] = [
  {
    key: "approval.pending_digest",
    label: "Persetujuan menunggu",
    description: "Ringkasan pagi bila ada pengajuan cuti, dinas, pinjaman, reimbursement, atau tugas luar/WFH yang menunggu persetujuan Anda.",
    defaultWhatsApp: true,
    fireHour: 7,
    weekdays: MONDAY_TO_SATURDAY,
    async generate(db, { today }) {
      // The same steps the approval inboxes list: pending, on a request still in review.
      const steps = `
        SELECT step.approver_employee_id, step.approver_account_id
          FROM leave_request_approval_steps step JOIN leave_requests request ON request.id = step.leave_request_id
         WHERE step.status = 'pending' AND request.status = 'in_review'
        UNION ALL
        SELECT step.approver_employee_id, NULL::uuid
          FROM business_trip_approval_steps step JOIN business_trip_requests request ON request.id = step.request_id
         WHERE step.status = 'pending' AND request.status = 'IN_REVIEW'
        UNION ALL
        SELECT step.approver_employee_id, NULL::uuid
          FROM employee_loan_approval_steps step JOIN employee_loans request ON request.id = step.loan_id
         WHERE step.status = 'pending' AND request.status = 'IN_REVIEW'
        UNION ALL
        SELECT step.approver_employee_id, NULL::uuid
          FROM reimbursement_approval_steps step JOIN reimbursement_claims request ON request.id = step.claim_id
         WHERE step.status = 'pending' AND request.status = 'IN_REVIEW'
        UNION ALL
        SELECT step.approver_employee_id, NULL::uuid
          FROM attendance_work_arrangement_approval_steps step
          JOIN attendance_work_arrangement_requests request ON request.id = step.request_id
         WHERE step.status = 'pending' AND request.status = 'IN_REVIEW'`;
      const result = await db.query<{ accountId: string; employeeId: string | null; pending: number }>(
        `WITH steps AS (${steps}), by_employee AS (
           SELECT approver_employee_id, count(*)::int AS pending FROM steps
            WHERE approver_employee_id IS NOT NULL GROUP BY approver_employee_id
         ), by_account AS (
           SELECT approver_account_id, count(*)::int AS pending FROM steps
            WHERE approver_account_id IS NOT NULL GROUP BY approver_account_id
         )
         SELECT recipient_account.id AS "accountId", recipient.id AS "employeeId", by_employee.pending
           FROM by_employee
           ${employeeAccountJoin("by_employee.approver_employee_id")}
         UNION ALL
         -- APR-001 leave steps held by an account (Organ Yayasan): in-app only, it has no employee number.
         SELECT account.id, NULL::uuid, by_account.pending
           FROM by_account JOIN accounts account ON account.id = by_account.approver_account_id AND account.status = 'active'
         ORDER BY 1`,
      );
      return result.rows.map((row) => ({
        occurrenceKey: today,
        accountId: row.accountId,
        employeeId: row.employeeId,
        title: `${row.pending} persetujuan menunggu Anda`,
        body: "Pengajuan cuti, perjalanan dinas, pinjaman, reimbursement, atau tugas luar/WFH menunggu keputusan Anda.",
        href: "/app/approvals",
        whatsappText: `HCIS: ${row.pending} pengajuan menunggu persetujuan Anda. Buka menu Persetujuan di HCIS.`,
      }));
    },
  },
  {
    key: "leave.hc_queue_digest",
    label: "Antrean validasi cuti HC",
    description: "Ringkasan pagi bila ada cuti yang menunggu validasi atau persetujuan Human Capital.",
    defaultWhatsApp: true,
    fireHour: 7,
    weekdays: MONDAY_TO_SATURDAY,
    async generate(db, { today }) {
      const count = await db.query<{ pending: number }>(
        `SELECT count(*)::int AS pending FROM leave_request_hc_tasks WHERE status = 'pending'`,
      );
      const pending = count.rows[0]?.pending ?? 0;
      if (!pending) return [];
      return digestToHolders(await accountsWithPermission(db, ["leave.validate"], today), {
        today,
        title: `${pending} cuti menunggu tindakan HC`,
        body: "Cuti khusus atau cuti masa kritis menunggu validasi atau persetujuan Human Capital.",
        href: "/app/hc/leave",
        whatsappText: `HCIS: ${pending} cuti menunggu tindakan Human Capital. Buka menu Validasi Cuti di HCIS.`,
      });
    },
  },
  {
    key: "documents.request_queue_digest",
    label: "Permintaan surat menunggu",
    description: "Ringkasan pagi bila ada permintaan surat keterangan yang sudah menunggu dua hari atau lebih.",
    defaultWhatsApp: true,
    fireHour: 7,
    weekdays: MONDAY_TO_SATURDAY,
    async generate(db, { today }) {
      const count = await db.query<{ pending: number }>(
        `SELECT count(*)::int AS pending FROM hr_document_requests
          WHERE status = 'SUBMITTED' AND (created_at AT TIME ZONE 'Asia/Jakarta')::date <= $1::date - 2`,
        [today],
      );
      const pending = count.rows[0]?.pending ?? 0;
      if (!pending) return [];
      return digestToHolders(await accountsWithPermission(db, ["documents.manage"], today), {
        today,
        title: `${pending} permintaan surat menunggu keputusan`,
        body: "Permintaan surat keterangan sudah menunggu dua hari atau lebih.",
        href: "/admin/documents",
        whatsappText: `HCIS: ${pending} permintaan surat keterangan menunggu keputusan Human Capital.`,
      });
    },
  },
  {
    key: "reimbursement.finance_queue_digest",
    label: "Reimbursement menunggu Keuangan",
    description: "Ringkasan pagi bila ada klaim reimbursement yang menunggu verifikasi atau pembayaran Keuangan.",
    defaultWhatsApp: true,
    fireHour: 7,
    weekdays: MONDAY_TO_SATURDAY,
    async generate(db, { today }) {
      // REIMB-001 §8: counts only, never a name or an amount (D-07, REIMB-001 D-14).
      const count = await db.query<{ toVerify: number; toPay: number }>(
        `SELECT count(*) FILTER (WHERE status = 'APPROVED')::int AS "toVerify",
                count(*) FILTER (WHERE status = 'VERIFIED')::int AS "toPay"
           FROM reimbursement_claims WHERE status IN ('APPROVED', 'VERIFIED')`,
      );
      const toVerify = count.rows[0]?.toVerify ?? 0;
      const toPay = count.rows[0]?.toPay ?? 0;
      if (!toVerify && !toPay) return [];
      return digestToHolders(await accountsWithPermission(db, ["reimbursements.manage"], today), {
        today,
        title: `${toVerify + toPay} reimbursement menunggu Keuangan`,
        body: `${toVerify} klaim menunggu verifikasi dan ${toPay} klaim menunggu pembayaran.`,
        href: "/admin/reimbursements",
        whatsappText: `HCIS: ${toVerify} klaim reimbursement menunggu verifikasi dan ${toPay} menunggu pembayaran Keuangan.`,
      });
    },
  },
  {
    key: "employment.term_ending",
    label: "Kontrak akan berakhir",
    description: "Pengingat H-60, H-30, dan H-7 sebelum kontrak, masa percobaan, magang, atau kontrak lepas pegawai berakhir.",
    defaultWhatsApp: false,
    fireHour: 7,
    async generate(db, { today }) {
      if ((await getRolloutMode(db)).mode === "OFF") return [];
      // The current term per employee, as the "Kontrak akan berakhir" worklist (EMP-005 §13.4) reads it.
      const terms = await db.query<{ termId: string; employeeId: string; fullName: string; category: string; endsOn: string }>(
        `SELECT DISTINCT ON (employment.employee_id)
                term.id AS "termId", employment.employee_id AS "employeeId", employee.full_name AS "fullName",
                term.category, to_char(term.effective_to, 'YYYY-MM-DD') AS "endsOn"
           FROM employments employment
           JOIN employment_terms term ON term.employment_id = employment.id AND term.voided_by_action_id IS NULL
           JOIN employees employee ON employee.id = employment.employee_id
                                  AND employee.status = 'active' AND employee.removed_at IS NULL
          WHERE employment.voided_by_action_id IS NULL AND employment.ended_on IS NULL
            AND (term.effective_from IS NULL OR term.effective_from <= $1::date)
          ORDER BY employment.employee_id, term.effective_from DESC NULLS LAST, term.sequence DESC`,
        [today],
      );
      const due = terms.rows
        .filter((term) => term.endsOn && TERM_LABEL[term.category])
        .map((term) => ({ term, daysLeft: daysBetween(today, term.endsOn), threshold: thresholdReached(daysBetween(today, term.endsOn), [60, 30, 7]) }))
        .filter((item) => item.threshold !== null);
      if (!due.length) return [];
      const holders = await accountsWithPermission(db, ["employment.manage"], today);
      return due.flatMap(({ term, daysLeft, threshold }) => holders.map((holder) => ({
        occurrenceKey: `${term.termId}:${term.endsOn}:${threshold}`,
        accountId: holder.accountId,
        employeeId: holder.employeeId,
        title: `${TERM_LABEL[term.category]} ${term.fullName} berakhir ${dueLabel(daysLeft)}`,
        body: `${TERM_LABEL[term.category]} berakhir ${formatJakartaDate(term.endsOn)}. Tentukan perpanjangan, perubahan status, atau pengakhiran.`,
        href: `/admin/employees/${term.employeeId}`,
        whatsappText: `HCIS: ada ${TERM_LABEL[term.category]!.toLowerCase()} pegawai yang berakhir ${dueLabel(daysLeft)}. Rinciannya di Notifikasi HCIS.`,
      })));
    },
  },
  {
    key: "employee.document_expiring",
    label: "Dokumen pribadi Anda akan berakhir",
    description: "Pengingat H-30 dan H-7 sebelum dokumen di Data Saya → Dokumen Pribadi (SIM, paspor, SKCK, surat sehat, dan lainnya) berakhir.",
    defaultWhatsApp: true,
    fireHour: 7,
    async generate(db, { today }) {
      // EMP-011 D-15: the documents the HC worklist shows, i.e. verified documents of active
      // employees HCIS manages. A replaced document is no longer VERIFIED, so it stops reminding.
      const result = await db.query<{
        id: string; documentType: DocumentType; title: string | null; expiresOn: string; accountId: string; employeeId: string;
      }>(
        `SELECT doc.id, doc.document_type AS "documentType", doc.title, to_char(doc.expires_on, 'YYYY-MM-DD') AS "expiresOn",
                recipient_account.id AS "accountId", recipient.id AS "employeeId"
           FROM employee_documents doc
           ${employeeAccountJoin("doc.employee_id")}
          WHERE doc.status = 'VERIFIED' AND doc.expires_on IS NOT NULL
            AND doc.expires_on BETWEEN $1::date AND $1::date + 30
            AND recipient.management_scope = 'MANAGED'
          ORDER BY doc.id`,
        [today],
      );
      return result.rows.flatMap((row) => {
        const daysLeft = daysBetween(today, row.expiresOn);
        const threshold = thresholdReached(daysLeft, [30, 7]);
        if (threshold === null) return [];
        const label = DOCUMENT_TYPE_RULES[row.documentType]?.label ?? "Dokumen";
        return [{
          occurrenceKey: `${row.id}:${row.expiresOn}:${threshold}`,
          accountId: row.accountId,
          employeeId: row.employeeId,
          title: `${label}${row.title ? ` ${row.title}` : ""} berakhir ${dueLabel(daysLeft)}`,
          body: `Masa berlaku berakhir ${formatJakartaDate(row.expiresOn)}. Perpanjang lalu unggah dokumen barunya lewat Data Saya → Dokumen Pribadi.`,
          href: "/app/my-data",
          // D-07: the document kind stays in the in-app reminder only.
          whatsappText: `HCIS: salah satu dokumen pribadi Anda berakhir ${dueLabel(daysLeft)}. Rinciannya di Notifikasi HCIS.`,
        }];
      });
    },
  },
  {
    key: "employee.certificate_expiring",
    label: "Sertifikat Anda akan berakhir",
    description: "Pengingat H-30 dan H-7 sebelum sertifikat yang tercatat di Data Saya berakhir.",
    defaultWhatsApp: true,
    fireHour: 7,
    async generate(db, { today }) {
      const result = await db.query<{ id: string; name: string; expiresOn: string; accountId: string; employeeId: string }>(
        `SELECT skill.id, skill.name, to_char(skill.expires_on, 'YYYY-MM-DD') AS "expiresOn",
                recipient_account.id AS "accountId", recipient.id AS "employeeId"
           FROM employee_skills skill
           ${employeeAccountJoin("skill.employee_id")}
          WHERE skill.kind = 'SERTIFIKAT' AND skill.voided_at IS NULL AND skill.expires_on IS NOT NULL
            AND skill.expires_on BETWEEN $1::date AND $1::date + 30
          ORDER BY skill.id`,
        [today],
      );
      return result.rows.flatMap((row) => {
        const daysLeft = daysBetween(today, row.expiresOn);
        const threshold = thresholdReached(daysLeft, [30, 7]);
        if (threshold === null) return [];
        return [{
          occurrenceKey: `${row.id}:${row.expiresOn}:${threshold}`,
          accountId: row.accountId,
          employeeId: row.employeeId,
          title: `Sertifikat ${row.name} berakhir ${dueLabel(daysLeft)}`,
          body: `Sertifikat berakhir ${formatJakartaDate(row.expiresOn)}. Perpanjang lalu kirim data barunya lewat Data Saya.`,
          href: "/app/my-data",
          whatsappText: `HCIS: salah satu sertifikat Anda berakhir ${dueLabel(daysLeft)}. Rinciannya di Notifikasi HCIS.`,
        }];
      });
    },
  },
  {
    key: "performance.self_due",
    label: "Penilaian diri jatuh tempo",
    description: "Pengingat H-3 dan pada hari tenggat penilaian diri bila belum Anda kirim.",
    defaultWhatsApp: true,
    fireHour: 7,
    async generate(db, { today }) {
      const result = await db.query<{ reviewId: string; cycleName: string; dueOn: string; accountId: string; employeeId: string }>(
        `SELECT review.id AS "reviewId", cycle.name AS "cycleName", to_char(cycle.self_due_on, 'YYYY-MM-DD') AS "dueOn",
                recipient_account.id AS "accountId", recipient.id AS "employeeId"
           FROM performance_reviews review
           JOIN performance_cycles cycle ON cycle.id = review.cycle_id AND cycle.status = 'OPEN'
           ${employeeAccountJoin("review.employee_id")}
          WHERE review.status = 'SELF_ASSESSMENT' AND review.self_submitted_at IS NULL
            AND cycle.self_due_on BETWEEN $1::date AND $1::date + 3
          ORDER BY review.id`,
        [today],
      );
      return result.rows.flatMap((row) => {
        const daysLeft = daysBetween(today, row.dueOn);
        const threshold = thresholdReached(daysLeft, [3, 0]);
        if (threshold === null) return [];
        return [{
          occurrenceKey: `${row.reviewId}:${threshold}`,
          accountId: row.accountId,
          employeeId: row.employeeId,
          title: `Penilaian diri ${row.cycleName} jatuh tempo ${dueLabel(daysLeft)}`,
          body: `Tenggat penilaian diri ${formatJakartaDate(row.dueOn)}. Isi dan kirim lewat menu Kinerja.`,
          href: "/app/performance",
          whatsappText: `HCIS: penilaian diri Anda jatuh tempo ${dueLabel(daysLeft)}. Isi lewat menu Kinerja di HCIS.`,
        }];
      });
    },
  },
  {
    key: "performance.review_due",
    label: "Penilaian bawahan jatuh tempo",
    description: "Pengingat H-3 dan pada hari tenggat bila masih ada penilaian bawahan yang belum Anda isi.",
    defaultWhatsApp: true,
    fireHour: 7,
    async generate(db, { today }) {
      const result = await db.query<{
        cycleId: string; cycleName: string; dueOn: string; accountId: string; employeeId: string; pending: number;
      }>(
        `SELECT cycle.id AS "cycleId", cycle.name AS "cycleName", to_char(cycle.review_due_on, 'YYYY-MM-DD') AS "dueOn",
                recipient_account.id AS "accountId", recipient.id AS "employeeId", count(*)::int AS pending
           FROM performance_reviews review
           JOIN performance_cycles cycle ON cycle.id = review.cycle_id AND cycle.status = 'OPEN'
           ${employeeAccountJoin("review.rater_employee_id")}
          WHERE review.status = 'MANAGER_REVIEW' AND cycle.review_due_on BETWEEN $1::date AND $1::date + 3
          GROUP BY cycle.id, cycle.name, cycle.review_due_on, recipient_account.id, recipient.id
          ORDER BY cycle.id, recipient.id`,
        [today],
      );
      return result.rows.flatMap((row) => {
        const daysLeft = daysBetween(today, row.dueOn);
        const threshold = thresholdReached(daysLeft, [3, 0]);
        if (threshold === null) return [];
        return [{
          occurrenceKey: `${row.cycleId}:${row.employeeId}:${threshold}`,
          accountId: row.accountId,
          employeeId: row.employeeId,
          title: `${row.pending} penilaian ${row.cycleName} jatuh tempo ${dueLabel(daysLeft)}`,
          body: `Tenggat penilaian atasan ${formatJakartaDate(row.dueOn)}. Isi lewat menu Kinerja.`,
          href: "/app/performance",
          whatsappText: `HCIS: ${row.pending} penilaian kinerja bawahan jatuh tempo ${dueLabel(daysLeft)}. Isi lewat menu Kinerja di HCIS.`,
        }];
      });
    },
  },
  {
    key: "payroll.cutoff_due",
    label: "Tenggat input payroll",
    description: "Pengingat H-3 dan pada hari tenggat input (cutoff) periode payroll yang masih dikumpulkan.",
    defaultWhatsApp: true,
    fireHour: 8,
    async generate(db, { today }) {
      const periods = await db.query<{ id: string; month: string; cutoffEnd: string }>(
        `SELECT id, to_char(period_month, 'YYYY-MM') AS month, to_char(cutoff_end, 'YYYY-MM-DD') AS "cutoffEnd"
           FROM payroll_periods
          WHERE state IN ('DRAFT', 'COLLECTING') AND cutoff_end BETWEEN $1::date AND $1::date + 3
          ORDER BY id`,
        [today],
      );
      const due = periods.rows.flatMap((period) => {
        const daysLeft = daysBetween(today, period.cutoffEnd);
        const threshold = thresholdReached(daysLeft, [3, 0]);
        return threshold === null ? [] : [{ period, daysLeft, threshold }];
      });
      if (!due.length) return [];
      const holders = await accountsWithPermission(db, ["payroll.inputs.manage"], today);
      return due.flatMap(({ period, daysLeft, threshold }) => holders.map((holder) => ({
        occurrenceKey: `${period.id}:${threshold}`,
        accountId: holder.accountId,
        employeeId: holder.employeeId,
        title: `Tenggat input payroll ${period.month} ${dueLabel(daysLeft)}`,
        body: `Input lembur dan kehadiran kontrak periode ${period.month} ditutup ${formatJakartaDate(period.cutoffEnd)}.`,
        href: `/admin/payroll/${period.id}`,
        whatsappText: `HCIS: tenggat input payroll ${period.month} ${dueLabel(daysLeft)}.`,
      })));
    },
  },
  {
    key: "payroll.pay_date_due",
    label: "Tanggal bayar payroll mendekat",
    description: "Pengingat H-3 dan H-1 sebelum tanggal bayar bila periode payroll belum disetujui.",
    defaultWhatsApp: true,
    fireHour: 8,
    async generate(db, { today }) {
      const periods = await db.query<{ id: string; month: string; payDate: string }>(
        `SELECT id, to_char(period_month, 'YYYY-MM') AS month, to_char(pay_date, 'YYYY-MM-DD') AS "payDate"
           FROM payroll_periods
          WHERE state IN ('DRAFT', 'COLLECTING', 'CALCULATED', 'SUBMITTED') AND pay_date BETWEEN $1::date + 1 AND $1::date + 3
          ORDER BY id`,
        [today],
      );
      const due = periods.rows.flatMap((period) => {
        const daysLeft = daysBetween(today, period.payDate);
        const threshold = thresholdReached(daysLeft, [3, 1]);
        return threshold === null ? [] : [{ period, daysLeft, threshold }];
      });
      if (!due.length) return [];
      const holders = await accountsWithPermission(db, ["payroll.submit", "payroll.approve"], today);
      return due.flatMap(({ period, daysLeft, threshold }) => holders.map((holder) => ({
        occurrenceKey: `${period.id}:${threshold}`,
        accountId: holder.accountId,
        employeeId: holder.employeeId,
        title: `Payroll ${period.month} belum disetujui, tanggal bayar ${dueLabel(daysLeft)}`,
        body: `Tanggal bayar ${formatJakartaDate(period.payDate)}. Periode masih menunggu perhitungan, pengajuan, atau persetujuan.`,
        href: `/admin/payroll/${period.id}`,
        whatsappText: `HCIS: payroll ${period.month} belum disetujui dan tanggal bayarnya ${dueLabel(daysLeft)}.`,
      })));
    },
  },
];

export function findReminderRule(key: string) {
  return REMINDER_RULES.find((rule) => rule.key === key) ?? null;
}
