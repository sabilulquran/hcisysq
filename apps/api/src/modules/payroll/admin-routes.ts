// PAY-003 reference data routes: versioned policy, compensation profiles, loans.
//
// Every write opens a new effective-dated row rather than editing one, so a past
// period stays recomputable. Nobody may manage their own compensation profile,
// and loans are locked once a period has left the collecting phase
// (specification sections 2 and 3).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie } from "../auth/service.js";
import {
  createLoan,
  listCompensationProfiles,
  listLoans,
  listPayrollEmployments,
  listPolicyVersions,
  openCompensationProfile,
  openPolicyVersion,
  setLoanDeductions,
} from "./admin-store.js";
import { ownEmploymentIds } from "./inputs-store.js";
import { POLICY_KEYS, validatePolicyPayload } from "./policy.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal harus berformat YYYY-MM-DD");

const policyBody = z.object({
  policyKey: z.enum([...POLICY_KEYS, "VARIANCE_THRESHOLD", "PPH21_TER"] as [string, ...string[]]),
  effectiveFrom: isoDate,
  payload: z.record(z.string(), z.unknown()),
  source: z.string().trim().min(3).max(500),
  note: z.string().trim().max(500).optional(),
  // Opening a version that reaches back into a period already calculated needs
  // to be said out loud, with a reason that goes into the note.
  backdateReason: z.string().trim().min(10).max(500).optional(),
});

const policyQuery = z.object({ policyKey: z.string().max(64).optional() });

const employmentParams = z.object({ employmentId: z.string().uuid() });

const profileBody = z.object({
  effectiveFrom: isoDate,
  backdateReason: z.string().trim().min(10).max(500).optional(),
  education: z.enum(["SD", "SMP", "SLTA", "D1_D2", "D3_D4", "S1", "S2_S3"]).nullable().optional(),
  workPattern: z.enum(["FULL", "HALF_DAY", "HALF_DAY_II"]).nullable().optional(),
  unitRef: z.string().uuid().nullable().optional(),
  functionalPositionRef: z.string().uuid().nullable().optional(),
  structuralPositionRef: z.string().uuid().nullable().optional(),
  teachingHoursPerWeek: z.number().min(0).max(168).nullable().optional(),
  spouseCount: z.number().int().min(0).max(4).optional(),
  childCount: z.number().int().min(0).max(20).optional(),
  registeredDependants: z.number().int().min(0).max(24).optional(),
  specialQualificationTarget: z.number().int().min(0).nullable().optional(),
  annualPerformanceRate: z.number().min(0).max(2).nullable().optional(),
  monthlyPerformanceRate: z.number().min(0).max(2).nullable().optional(),
  bpjsSegment: z.enum(["PPU_YAYASAN", "PBI", "MANDIRI", "BELUM_TERDAFTAR"]).optional(),
  bpjsActiveFrom: isoDate.nullable().optional(),
  bpjsExtraFamilyOverride: z.number().int().min(0).max(20).nullable().optional(),
  bpjsExtraFamilyOverrideReason: z.string().trim().max(500).nullable().optional(),
  bpjsDecisionReference: z.string().trim().max(200).nullable().optional(),
  ptkpStatus: z.string().trim().max(16).nullable().optional(),
  pjMediaRatePerContent: z.number().int().min(0).nullable().optional(),
  // The transfer list prints the bank beside the account, so the profile has
  // to be able to carry one; before this it could only ever be empty there.
  bankName: z.string().trim().max(120).nullable().optional(),
  bankAccountNumber: z.string().trim().max(64).nullable().optional(),
  bankAccountName: z.string().trim().max(200).nullable().optional(),
});

const loanBody = z.object({
  employeeId: z.string().uuid(),
  grantedOn: isoDate,
  principal: z.number().int().positive(),
  instalment: z.number().int().positive().nullable().optional(),
  note: z.string().trim().max(500).optional(),
});

// ENG-LIST-001: the register grows with every kasbon, so it is read a page at
// a time with the total beside it.
const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

const loanQuery = z.object({ employeeId: z.string().uuid().optional(), ...pageQuery });

const employmentQuery = z.object({ q: z.string().trim().max(120).optional(), ...pageQuery });

const loanDeductionsBody = z.object({
  // An amount of 0 removes this period's instalment for that loan, so finance
  // can take one back while the period is still being collected.
  deductions: z
    .array(z.object({ loanId: z.string().uuid(), amount: z.number().int().min(0) }))
    .min(1)
    .max(500)
    .superRefine((deductions, ctx) => {
      const seen = new Set<string>();
      for (const [index, deduction] of deductions.entries()) {
        if (seen.has(deduction.loanId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, "loanId"],
            message: "Satu kasbon hanya boleh muncul sekali dalam satu permintaan.",
          });
        }
        seen.add(deduction.loanId);
      }
    }),
});

const periodParams = z.object({ periodId: z.string().uuid() });

/**
 * A period that has been calculated rests on the reference data as it stood then.
 * Opening a version or a profile that reaches back before such a period would
 * change what a recalculation produces for a month already being paid, so it is
 * refused unless the caller says so explicitly and gives a reason
 * (specification section 3, "perubahan tidak menimpa histori").
 */
async function settledPeriodConflict(
  pool: Pool,
  effectiveFrom: string,
): Promise<{ periodMonth: string } | null> {
  const { rows } = await pool.query<{ periodMonth: string }>(
    `SELECT to_char(period_month, 'YYYY-MM') AS "periodMonth"
     FROM payroll_periods
     WHERE state = ANY($2::text[]) AND pay_date >= $1::date
     ORDER BY period_month
     LIMIT 1`,
    [effectiveFrom, SETTLED_STATES],
  );
  return rows[0] ?? null;
}

const SETTLED_STATES = [
  "CALCULATED",
  "SUBMITTED",
  "APPROVED",
  "PAYMENT_CONFIRMED",
  "PUBLISHED",
  "REOPEN_REQUESTED",
];

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

export async function registerPayrollAdminRoutes(app: FastifyInstance, pool: Pool, config: ApiConfig) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for payroll admin routes");
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  async function requireAny(
    request: FastifyRequest,
    reply: FastifyReply,
    permissions: readonly string[],
  ): Promise<{ accountId: string; permissions: readonly string[] } | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    const context = await auth.getAuthorizationContext(session.principal);
    if (!permissions.some((permission) => context.organizationPermissions.includes(permission))) {
      await send(reply, 403, { code: "PAYROLL_FORBIDDEN", message: "Anda tidak memiliki akses untuk tindakan ini." });
      return null;
    }
    return { accountId: session.principal.id, permissions: context.organizationPermissions };
  }

  app.get("/payroll/policies", async (request, reply) => {
    const actor = await requireAny(request, reply, ["payroll.policies.manage"]);
    if (!actor) return;
    const query = policyQuery.safeParse(request.query ?? {});
    if (!query.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_QUERY", message: "Parameter tidak valid." });
    }
    return send(reply, 200, { policies: await listPolicyVersions(pool, query.data.policyKey) });
  });

  app.post("/payroll/policies", async (request, reply) => {
    const actor = await requireAny(request, reply, ["payroll.policies.manage"]);
    if (!actor) return;
    const body = policyBody.safeParse(request.body ?? {});
    if (!body.success) {
      return send(reply, 400, {
        code: "PAYROLL_INVALID_POLICY",
        message: body.error.issues[0]?.message ?? "Kebijakan tidak valid.",
      });
    }
    const payloadCheck = validatePolicyPayload(body.data.policyKey, body.data.payload);
    if (!payloadCheck.ok) {
      return send(reply, 400, {
        code: "PAYROLL_INVALID_POLICY",
        message: `Isi kebijakan ${body.data.policyKey} tidak sesuai bentuk yang dibutuhkan: ${payloadCheck.message}.`,
      });
    }

    const settled = await settledPeriodConflict(pool, body.data.effectiveFrom);
    if (settled && !body.data.backdateReason) {
      return send(reply, 409, {
        code: "PAYROLL_BACKDATES_SETTLED_PERIOD",
        message: `Periode ${settled.periodMonth} sudah dihitung dengan kebijakan yang berlaku saat itu; sertakan backdateReason bila perubahan ini memang harus berlaku mundur.`,
      });
    }

    try {
      const policy = await openPolicyVersion(
        pool,
        {
          ...body.data,
          note: body.data.backdateReason
            ? `${body.data.note ?? ""} [berlaku mundur: ${body.data.backdateReason}]`.trim()
            : body.data.note,
        },
        actor.accountId,
      );
      return send(reply, 201, { policy });
    } catch (error) {
      // Two versions covering the same day are refused by an exclusion
      // constraint; that is a request the caller has to fix, not a server fault.
      if ((error as { code?: string }).code === "23P01") {
        return send(reply, 409, {
          code: "PAYROLL_POLICY_OVERLAP",
          message: "Sudah ada versi kebijakan yang berlaku pada tanggal tersebut.",
        });
      }
      throw error;
    }
  });

  // The picker behind both reference screens: a compensation profile is opened
  // against an employment, and a kasbon is recorded against the employee behind
  // one. It names people, so it asks for a permission that already reaches
  // names, and it searches rather than listing everyone (ENG-LIST-001).
  app.get("/payroll/employments", async (request, reply) => {
    const actor = await requireAny(request, reply, [
      "payroll.profiles.manage",
      "payroll.calculate",
      "payroll.loans.manage",
    ]);
    if (!actor) return;
    const query = employmentQuery.safeParse(request.query ?? {});
    if (!query.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_QUERY", message: "Parameter tidak valid." });
    }
    const { employments, total } = await listPayrollEmployments(pool, {
      q: query.data.q ?? null,
      page: query.data.page,
      pageSize: query.data.pageSize,
    });
    return send(reply, 200, { employments, total, page: query.data.page, pageSize: query.data.pageSize });
  });

  app.get("/payroll/employments/:employmentId/compensation-profiles", async (request, reply) => {
    const actor = await requireAny(request, reply, ["payroll.profiles.manage", "payroll.calculate"]);
    if (!actor) return;
    const params = employmentParams.safeParse(request.params);
    if (!params.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_QUERY", message: "Identifier employment tidak valid." });
    }
    return send(reply, 200, { profiles: await listCompensationProfiles(pool, params.data.employmentId) });
  });

  app.post("/payroll/employments/:employmentId/compensation-profiles", async (request, reply) => {
    const actor = await requireAny(request, reply, ["payroll.profiles.manage"]);
    if (!actor) return;

    const params = employmentParams.safeParse(request.params);
    const body = profileBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return send(reply, 400, {
        code: "PAYROLL_INVALID_PROFILE",
        message: body.success ? "Identifier employment tidak valid." : (body.error.issues[0]?.message ?? "Profil tidak valid."),
      });
    }

    const own = await ownEmploymentIds(pool, actor.accountId);
    if (own.has(params.data.employmentId)) {
      return send(reply, 403, {
        code: "PAYROLL_OWN_RECORD",
        message: "Anda tidak dapat mengubah profil kompensasi untuk diri sendiri.",
      });
    }

    const settled = await settledPeriodConflict(pool, body.data.effectiveFrom);
    if (settled && !body.data.backdateReason) {
      return send(reply, 409, {
        code: "PAYROLL_BACKDATES_SETTLED_PERIOD",
        message: `Periode ${settled.periodMonth} sudah dihitung dengan profil yang berlaku saat itu; sertakan backdateReason bila perubahan ini memang harus berlaku mundur.`,
      });
    }

    try {
      const profile = await openCompensationProfile(
        pool,
        { ...body.data, employmentId: params.data.employmentId },
        actor.accountId,
      );
      return send(reply, 201, { profile });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "23P01") {
        return send(reply, 409, {
          code: "PAYROLL_PROFILE_OVERLAP",
          message: "Sudah ada profil yang berlaku pada tanggal tersebut.",
        });
      }
      if (code === "23514") {
        return send(reply, 400, {
          code: "PAYROLL_INVALID_PROFILE",
          message: "Profil ditolak oleh aturan basis data; periksa alasan override dan segmen BPJS.",
        });
      }
      if (code === "23503") {
        return send(reply, 404, { code: "PAYROLL_EMPLOYMENT_NOT_FOUND", message: "Employment tidak ditemukan." });
      }
      throw error;
    }
  });

  // Section 3.4: the loan register belongs to finance. The calculation reads the
  // balances inside its own transaction, so human capital needs no way in here.
  app.get("/payroll/loans", async (request, reply) => {
    const actor = await requireAny(request, reply, ["payroll.loans.manage"]);
    if (!actor) return;
    const query = loanQuery.safeParse(request.query ?? {});
    if (!query.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_QUERY", message: "Parameter tidak valid." });
    }
    const { loans, total } = await listLoans(pool, {
      employeeId: query.data.employeeId ?? null,
      page: query.data.page,
      pageSize: query.data.pageSize,
    });
    return send(reply, 200, { loans, total, page: query.data.page, pageSize: query.data.pageSize });
  });

  app.post("/payroll/loans", async (request, reply) => {
    const actor = await requireAny(request, reply, ["payroll.loans.manage"]);
    if (!actor) return;
    const body = loanBody.safeParse(request.body ?? {});
    if (!body.success) {
      return send(reply, 400, {
        code: "PAYROLL_INVALID_LOAN",
        message: body.error.issues[0]?.message ?? "Kasbon tidak valid.",
      });
    }
    try {
      const loan = await createLoan(pool, body.data, actor.accountId);
      return send(reply, 201, { loan });
    } catch (error) {
      if ((error as { code?: string }).code === "23503") {
        return send(reply, 404, { code: "PAYROLL_EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
      }
      throw error;
    }
  });

  app.put("/payroll/periods/:periodId/loan-deductions", async (request, reply) => {
    const actor = await requireAny(request, reply, ["payroll.loans.manage"]);
    if (!actor) return;

    const params = periodParams.safeParse(request.params);
    const body = loanDeductionsBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_LOAN", message: "Potongan kasbon tidak valid." });
    }

    const outcome = await setLoanDeductions(pool, params.data.periodId, body.data.deductions, actor.accountId);
    if (outcome.ok) {
      return send(reply, 200, { written: outcome.written, removed: outcome.removed });
    }
    if (outcome.code === "PAYROLL_PERIOD_NOT_FOUND") {
      return send(reply, 404, { code: outcome.code, message: "Periode tidak ditemukan." });
    }
    if (outcome.code === "PAYROLL_LOAN_NOT_FOUND") {
      return send(reply, 404, { code: outcome.code, message: "Kasbon tidak ditemukan." });
    }
    if (outcome.code === "PAYROLL_LOAN_CLOSED") {
      return send(reply, 409, { code: outcome.code, message: "Kasbon sudah ditutup." });
    }
    if (outcome.code === "PAYROLL_LOAN_LOCKED") {
      return send(reply, 409, {
        code: outcome.code,
        message: "Kasbon terkunci setelah periode dihitung; kembalikan periode ke COLLECTING lebih dulu.",
      });
    }
    return send(reply, 409, {
      code: outcome.code,
      message: "Potongan kasbon melebihi sisa pinjaman.",
    });
  });
}
