import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import { getOidcRuntimeConfig, isGovernanceSummaryEnabled, type ApiConfig } from "../../config/env.js";
import { ApplicationAccessError, SqHubApplicationAccessClient } from "../auth/application-access.js";
import { hasBoardAccess } from "../auth/permissions.js";
import { readBearerToken } from "../organization-directory/machine-auth.js";
import { loadBoardAggregates } from "../board/aggregates.js";
import {
  buildGovernanceSummary,
  type EmploymentRolloutMode,
  type EmploymentSpan,
} from "./summary.js";
import {
  createGovernanceTokenVerifier,
  GovernanceTokenError,
  type GovernanceIdentity,
  type VerifyGovernanceToken,
} from "./token-verifier.js";

// ORG-010 §3: GET /governance/summary. Bearer-only, disabled by default. The exchanged token is
// read here and nowhere else; no session or cookie is created. The token, its claims and the
// response body are never logged or stored.

export interface GovernanceSummaryDependencies {
  verifyToken: VerifyGovernanceToken;
  applicationAccess: Pick<SqHubApplicationAccessClient, "isAllowed">;
  applicationKey: string;
  publicOrigin: string;
  now?: () => Date;
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
};

class SummaryDenied extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, public readonly accountId: string | null) {
    super(code);
  }
}

function productionDependencies(config: ApiConfig): GovernanceSummaryDependencies {
  const oidc = getOidcRuntimeConfig(config);
  const allowedClients = new Set(
    (config.GOVERNANCE_SUMMARY_ALLOWED_CLIENTS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  );
  return {
    verifyToken: createGovernanceTokenVerifier({
      issuer: oidc.issuer,
      audience: config.GOVERNANCE_SUMMARY_AUDIENCE!,
      allowedClients,
    }),
    applicationAccess: new SqHubApplicationAccessClient(
      oidc.issuer, oidc.machineClientId, oidc.machineClientSecret, oidc.applicationAccessUrl,
    ),
    applicationKey: config.GOVERNANCE_SUMMARY_APPLICATION_KEY!,
    // detailUrl and attention links live on the HCIS public origin, the one users sign in on.
    publicOrigin: new URL(oidc.redirectUri).origin,
  };
}

function authorizationHeaderCount(request: FastifyRequest): number {
  let count = 0;
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === "authorization") count += 1;
  }
  return count;
}

export function registerGovernanceSummaryRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injected?: GovernanceSummaryDependencies,
) {
  const enabled = isGovernanceSummaryEnabled(config);
  const dependencies = enabled ? (injected ?? productionDependencies(config)) : null;

  async function audit(request: FastifyRequest, eventType: string, accountId: string | null, reasonCode: string | null) {
    await pool.query(
      `INSERT INTO auth_audit_events (id, account_id, event_type, ip_address, user_agent, reason_code)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), accountId, eventType, request.ip ?? null, request.headers["user-agent"] ?? null, reasonCode],
    );
  }

  async function resolveAccount(identity: GovernanceIdentity): Promise<string> {
    const mapped = await pool.query<{ id: string; principalType: string; status: string }>(
      `SELECT id, principal_type AS "principalType", status
       FROM accounts WHERE identity_issuer = $1 AND identity_subject = $2 LIMIT 2`,
      [identity.issuer, identity.subject],
    );
    const account = mapped.rows.length === 1 ? mapped.rows[0] : undefined;
    if (!account) throw new SummaryDenied(403, "OIDC_ACCOUNT_NOT_MAPPED", null);
    if (account.status !== "active") throw new SummaryDenied(403, "ACCOUNT_INACTIVE", account.id);
    if (!(await hasBoardAccess(pool, account))) throw new SummaryDenied(403, "BOARD_ACCESS_REQUIRED", account.id);
    // D3: re-check SQ Hub Application Access with the same client and rules as OIDC login.
    let allowed: boolean;
    try {
      allowed = await dependencies!.applicationAccess.isAllowed(identity);
    } catch (error) {
      if (!(error instanceof ApplicationAccessError)) throw error;
      throw new SummaryDenied(503, "APPLICATION_ACCESS_UNAVAILABLE", account.id);
    }
    if (!allowed) throw new SummaryDenied(403, "HCIS_ACCESS_DENIED", account.id);
    return account.id;
  }

  async function loadEmploymentHistory(): Promise<{ mode: EmploymentRolloutMode | null; spans: EmploymentSpan[] }> {
    const mode = await pool.query<{ mode: EmploymentRolloutMode }>("SELECT mode FROM employment_rollout_settings WHERE id = 1");
    const current = mode.rows[0]?.mode ?? null;
    if (current !== "AUTHORITATIVE") return { mode: current, spans: [] };
    const spans = await pool.query<EmploymentSpan>(
      `SELECT to_char(started_on, 'YYYY-MM-DD') AS "startedOn", to_char(ended_on, 'YYYY-MM-DD') AS "endedOn",
              end_basis AS "endBasis", source IN ('BASELINE_FROM_MASTER', 'BASELINE_FROM_IMPORT') AS baseline
       FROM employments WHERE voided_by_action_id IS NULL`,
    );
    return { mode: current, spans: spans.rows };
  }

  async function deny(request: FastifyRequest, reply: FastifyReply, statusCode: number, code: string, accountId: string | null) {
    await audit(request, "governance.summary.denied", accountId, code);
    return reply.status(statusCode).send({ code, message: MESSAGES[code] ?? "Permintaan ditolak." });
  }

  app.get("/governance/summary", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!dependencies) return reply.status(404).send({ code: "NOT_FOUND", message: "Tidak ditemukan." });

    try {
      // A cookie never authenticates this route; exactly one bearer token is required.
      const token = authorizationHeaderCount(request) === 1 ? readBearerToken(request.headers.authorization) : null;
      if (!token) return await deny(request, reply, 401, "UNAUTHENTICATED", null);

      let identity: GovernanceIdentity;
      try {
        identity = await dependencies.verifyToken(token);
      } catch (error) {
        if (!(error instanceof GovernanceTokenError)) throw error;
        return await deny(request, reply, error.statusCode, error.code, null);
      }

      let accountId: string;
      try {
        accountId = await resolveAccount(identity);
      } catch (error) {
        if (!(error instanceof SummaryDenied)) throw error;
        return await deny(request, reply, error.statusCode, error.code, error.accountId);
      }

      const [aggregates, history] = await Promise.all([loadBoardAggregates(pool), loadEmploymentHistory()]);
      const summary = buildGovernanceSummary({
        aggregates,
        employmentMode: history.mode,
        employmentSpans: history.spans,
        applicationKey: dependencies.applicationKey,
        publicOrigin: dependencies.publicOrigin,
        now: dependencies.now?.() ?? new Date(),
      });
      await audit(request, "governance.summary.served", accountId, null);
      reply.header("Cache-Control", "private, no-store");
      return reply.status(200).send(summary);
    } catch (error) {
      // §7: a database or unexpected error returns 500 without detail. Only the error class/code is
      // logged, never the request headers, claims or summary.
      request.log.error({ errorName: (error as Error)?.name, errorCode: (error as { code?: string })?.code }, "governance summary failed");
      return reply.status(500).send({ code: "INTERNAL_ERROR", message: "Terjadi kesalahan." });
    }
  });
}
