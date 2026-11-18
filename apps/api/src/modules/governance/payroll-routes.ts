import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import {
  getOidcRuntimeConfig,
  isGovernancePayrollReadEnabled,
  isGovernanceSummaryEnabled,
  type ApiConfig,
} from "../../config/env.js";
import { SqHubApplicationAccessClient } from "../auth/application-access.js";
import { readBearerToken } from "../organization-directory/machine-auth.js";
import { writeAudit } from "../payroll/store.js";
import {
  GovernanceAccountDenied,
  resolveGovernanceAccount,
  type ResolvedGovernanceAccount,
} from "./account.js";
import {
  assertGovernancePayrollReadCapability,
  GovernancePayrollDenied,
  listGovernancePayrollPeriods,
  loadGovernancePayrollResults,
} from "./payroll-read.js";
import {
  createGovernanceTokenVerifier,
  GovernanceTokenError,
  type GovernanceIdentity,
  type VerifyGovernanceToken,
} from "./token-verifier.js";

/**
 * ADR-0008 — Pengurus Yayasan membaca gaji per orang.
 *
 * Why here and not under /admin: `FOUNDATION_BOARD` is refused at /app and /admin (ORG-013
 * §Ruang lingkup), and since the ORG-010 amendment of 2026-11-13 an organ account reads in the
 * Portal Organ Yayasan while /board keeps only its leave approvals. So the only surface an organ
 * principal can actually reach is this one, beside /governance/summary and /governance/employees.
 *
 * These are reads, so they take the summary-class token and the summary gates (identity mapping,
 * active account, board access, SQ Hub Application Access) — no step-up and no token spending,
 * which ORG-015 requires of the one door that mutates. On top of those gates the caller must be an
 * organ account holding `payroll.governance.results.read`: board access alone opens nothing here.
 *
 * Every read is written to the payroll audit, the same `payroll.report.read` action HC reads
 * write, which is the condition the owner attached to the decision.
 */

export interface GovernancePayrollDependencies {
  verifyToken: VerifyGovernanceToken;
  applicationAccess: Pick<SqHubApplicationAccessClient, "isAllowed">;
  /** `azp` values allowed here (the portal client only, by default). */
  allowedClients?: ReadonlySet<string>;
}

const MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: "Token akses tidak ditemukan.",
  INVALID_TOKEN: "Token akses tidak valid.",
  FORBIDDEN_AUDIENCE: "Token akses bukan untuk HCIS.",
  FORBIDDEN_CLIENT: "Token akses tidak berasal dari klien yang diizinkan.",
  JWKS_UNAVAILABLE: "Kunci verifikasi belum dapat dimuat. Coba lagi.",
  OIDC_ACCOUNT_NOT_MAPPED: "Identitas SQ belum dipetakan ke akun HCIS.",
  ACCOUNT_INACTIVE: "Akun HCIS tidak aktif.",
  BOARD_ACCESS_REQUIRED: "Akun ini tidak memiliki akses Panel Organ Yayasan.",
  HCIS_ACCESS_DENIED: "Akses ke HCIS tidak diberikan.",
  APPLICATION_ACCESS_UNAVAILABLE: "Akses HCIS belum dapat diverifikasi. Coba lagi.",
  NOT_FOUNDATION_BOARD: "Pembacaan gaji lewat portal hanya untuk akun Organ Yayasan.",
  PAYROLL_READ_FORBIDDEN: "Akun ini tidak memiliki izin membaca gaji per orang.",
  PAYROLL_PERIOD_NOT_FOUND: "Periode tidak ditemukan atau belum disahkan.",
};

const periodParams = z.object({ periodId: z.string().uuid() });

function productionDependencies(config: ApiConfig): GovernancePayrollDependencies {
  const oidc = getOidcRuntimeConfig(config);
  return {
    verifyToken: createGovernanceTokenVerifier({
      issuer: oidc.issuer,
      audience: config.GOVERNANCE_SUMMARY_AUDIENCE!,
      allowedClients: new Set(
        (config.GOVERNANCE_SUMMARY_ALLOWED_CLIENTS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
      ),
    }),
    applicationAccess: new SqHubApplicationAccessClient(
      oidc.issuer, oidc.machineClientId, oidc.machineClientSecret, oidc.applicationAccessUrl,
    ),
    allowedClients: new Set(
      (config.GOVERNANCE_PAYROLL_ALLOWED_CLIENTS ?? "sq-organ").split(",").map((value) => value.trim()).filter(Boolean),
    ),
  };
}

function authorizationHeaderCount(request: FastifyRequest): number {
  let count = 0;
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === "authorization") count += 1;
  }
  return count;
}

export function registerGovernancePayrollRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injected?: GovernancePayrollDependencies,
) {
  // Registered either way, as the summary and decision routes are, so the AUTH-011 manifest covers
  // them; while the flag is off they answer 404 and nothing behind them is ever reached.
  const enabled = isGovernancePayrollReadEnabled(config) && isGovernanceSummaryEnabled(config);
  const dependencies = enabled ? (injected ?? productionDependencies(config)) : null;

  async function audit(request: FastifyRequest, eventType: string, accountId: string | null, reasonCode: string | null) {
    try {
      await pool.query(
        `INSERT INTO auth_audit_events (id, account_id, event_type, ip_address, user_agent, reason_code)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), accountId, eventType, request.ip ?? null, request.headers["user-agent"] ?? null, reasonCode],
      );
    } catch (error) {
      // An audit row must never change the answer; a failed insert would turn a clean 403 into 500.
      request.log.error({ errorName: (error as Error)?.name }, "governance payroll audit failed");
    }
  }

  /**
   * The read itself, in the payroll audit, beside the HC reads of the same figures. Written before
   * the figures are sent, and not swallowed: ADR-0008 D-5 makes the log the condition of the
   * access, so a read that cannot be recorded does not happen.
   */
  async function recordPayrollRead(accountId: string, periodId: string, scope: string, rowCount: number) {
    const client = await pool.connect();
    try {
      await writeAudit(client, {
        actorAccountId: accountId,
        action: "payroll.report.read",
        periodId,
        payload: { scope, row_count: rowCount, actor: "organ" },
      });
    } finally {
      client.release();
    }
  }

  async function deny(
    request: FastifyRequest, reply: FastifyReply, statusCode: number, code: string, accountId: string | null,
  ) {
    await audit(request, "governance.payroll.denied", accountId, code);
    reply.header("Cache-Control", "private, no-store");
    return reply.status(statusCode).send({ code, message: MESSAGES[code] ?? "Permintaan ditolak." });
  }

  /**
   * Verify the token, resolve the account, then require an organ account holding the ADR-0008
   * capability. A salaried member of the Pengurus is an HCIS employee and reads nothing here; the
   * separation ORG-015 draws for decisions holds for figures too.
   */
  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<ResolvedGovernanceAccount | null> {
    // A cookie never authenticates these routes; exactly one bearer token is required.
    const token = authorizationHeaderCount(request) === 1 ? readBearerToken(request.headers.authorization) : null;
    if (!token) {
      await deny(request, reply, 401, "UNAUTHENTICATED", null);
      return null;
    }

    let identity: GovernanceIdentity;
    try {
      identity = await dependencies!.verifyToken(token);
    } catch (error) {
      if (!(error instanceof GovernanceTokenError)) throw error;
      await deny(request, reply, error.statusCode, error.code, null);
      return null;
    }

    // Least privilege: pay figures go to the Portal Organ client, not to every summary client.
    if (!(dependencies!.allowedClients ?? new Set(["sq-organ"])).has(identity.client)) {
      await deny(request, reply, 403, "FORBIDDEN_CLIENT", null);
      return null;
    }

    let account: ResolvedGovernanceAccount;
    try {
      account = await resolveGovernanceAccount(pool, dependencies!.applicationAccess, identity);
    } catch (error) {
      if (!(error instanceof GovernanceAccountDenied)) throw error;
      await deny(request, reply, error.statusCode, error.code, error.accountId);
      return null;
    }

    if (account.principalType !== "FOUNDATION_BOARD" || account.employeeId) {
      await deny(request, reply, 403, "NOT_FOUNDATION_BOARD", account.id);
      return null;
    }

    try {
      await assertGovernancePayrollReadCapability(pool, account.id);
    } catch (error) {
      if (!(error instanceof GovernancePayrollDenied)) throw error;
      await deny(request, reply, error.statusCode, error.code, account.id);
      return null;
    }
    return account;
  }

  function failed(request: FastifyRequest, reply: FastifyReply, error: unknown) {
    request.log.error(
      { errorName: (error as Error)?.name, errorCode: (error as { code?: string })?.code },
      "governance payroll read failed",
    );
    return reply.status(500).send({ code: "INTERNAL_ERROR", message: "Terjadi kesalahan." });
  }

  /** The periods that may be opened: APPROVED or later. No figures, so no payroll audit row. */
  app.get("/governance/payroll/periods", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!dependencies) return reply.status(404).send({ code: "NOT_FOUND", message: "Tidak ditemukan." });
    try {
      const account = await authenticate(request, reply);
      if (!account) return;
      const periods = await listGovernancePayrollPeriods(pool);
      await audit(request, "governance.payroll.periods.listed", account.id, null);
      return reply.status(200).send({ periods });
    } catch (error) {
      return failed(request, reply, error);
    }
  });

  /**
   * One period's per-person figures and payslip lines. A period that is not APPROVED or later is
   * answered 404, exactly as an unknown id is: which periods exist before approval is not
   * something this surface tells the portal.
   */
  app.get("/governance/payroll/periods/:periodId/results", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!dependencies) return reply.status(404).send({ code: "NOT_FOUND", message: "Tidak ditemukan." });
    try {
      const params = periodParams.safeParse(request.params);
      const account = await authenticate(request, reply);
      if (!account) return;
      if (!params.success) {
        return await deny(request, reply, 404, "PAYROLL_PERIOD_NOT_FOUND", account.id);
      }

      const periods = await listGovernancePayrollPeriods(pool);
      const period = periods.find((candidate) => candidate.id === params.data.periodId);
      if (!period) {
        return await deny(request, reply, 404, "PAYROLL_PERIOD_NOT_FOUND", account.id);
      }

      const people = await loadGovernancePayrollResults(pool, period.id);
      await recordPayrollRead(account.id, period.id, "governance_period_results", people.length);
      await audit(request, "governance.payroll.results.read", account.id, null);
      return reply.status(200).send({ period, people });
    } catch (error) {
      return failed(request, reply, error);
    }
  });
}
