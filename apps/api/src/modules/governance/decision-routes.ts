import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import {
  getOidcRuntimeConfig,
  isGovernanceDecisionsEnabled,
  type ApiConfig,
} from "../../config/env.js";
import { spendActorAssertion, ActorAssertionError } from "../auth/actor-assertion.js";
import { SqHubApplicationAccessClient } from "../auth/application-access.js";
import {
  applyLeaveApprovalDecision,
  assertGovernanceApprovalCapability,
  mapKnownError,
} from "../leave/employee-routes.js";
import { readBearerToken } from "../organization-directory/machine-auth.js";
import {
  GovernanceAccountDenied,
  resolveGovernanceAccount,
  type ResolvedGovernanceAccount,
} from "./account.js";
import {
  createGovernanceTokenVerifier,
  GovernanceTokenError,
  type GovernanceIdentity,
  type VerifyGovernanceToken,
} from "./token-verifier.js";

/**
 * ORG-015 — deciding a leave approval step from the Portal Organ Yayasan.
 *
 * ADR-0012 D3 and D4: the portal shows the step and forwards the member's decision; every rule
 * about who may approve what stays here. The token that carries the decision is not the token that
 * reads the dashboard — it has its own audience, proves TOTP through the realm's Level of
 * Authentication, lives 60 seconds, and is spent once.
 *
 * `POST /leave/approvals/:stepId/decision` keeps refusing bearer tokens (ORG-013-3). This is the
 * one door a bearer may decide through, and it opens only when GOVERNANCE_DECISIONS_ENABLED is on.
 */

/** ADR-0012 D4: TOTP as a Level of Authentication. A trusted device never reaches it. */
const REQUIRED_ACR = "2";
/** ORG-015-2 step 4: a decision token older than this is refused even if it has not expired. */
const MAX_TOKEN_AGE_SECONDS = 60;
const NOTE_MAX_LENGTH = 1000;

export interface GovernanceDecisionDependencies {
  verifyToken: VerifyGovernanceToken;
  applicationAccess: Pick<SqHubApplicationAccessClient, "isAllowed">;
}

const MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: "Token akses tidak ditemukan.",
  INVALID_TOKEN: "Token akses tidak valid.",
  FORBIDDEN_AUDIENCE: "Token akses bukan untuk keputusan Organ Yayasan.",
  FORBIDDEN_CLIENT: "Token akses tidak berasal dari klien yang diizinkan.",
  STEP_UP_REQUIRED: "Keputusan membutuhkan verifikasi dua langkah yang baru.",
  TOKEN_TOO_OLD: "Token keputusan sudah kedaluwarsa. Coba lagi.",
  DECISION_TOKEN_SPENT: "Token keputusan sudah dipakai.",
  JWKS_UNAVAILABLE: "Kunci verifikasi belum dapat dimuat. Coba lagi.",
  OIDC_ACCOUNT_NOT_MAPPED: "Identitas SQ belum dipetakan ke akun HCIS.",
  ACCOUNT_INACTIVE: "Akun HCIS tidak aktif.",
  BOARD_ACCESS_REQUIRED: "Akun ini tidak memiliki akses Panel Organ Yayasan.",
  HCIS_ACCESS_DENIED: "Akses ke HCIS tidak diberikan.",
  APPLICATION_ACCESS_UNAVAILABLE: "Akses HCIS belum dapat diverifikasi. Coba lagi.",
  NOT_FOUNDATION_BOARD: "Keputusan lewat portal hanya untuk akun Organ Yayasan.",
};

const decisionBodySchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(NOTE_MAX_LENGTH).nullable().optional(),
  requestId: z.string().uuid(),
});

const stepParamSchema = z.object({ stepId: z.string().uuid() });

/** ORG-013-3: the history names the role a step belongs to, never the person who holds it. */
const SOURCE_LABELS: Record<string, string> = {
  DIRECT_MANAGER: "Atasan langsung",
  UNIT_APPROVER: "Penyetuju unit",
  GOVERNANCE_APPROVER: "Organ Yayasan",
};

function roleLabel(sources: readonly string[] | null): string | null {
  for (const source of sources ?? []) {
    const label = SOURCE_LABELS[source];
    if (label) return label;
  }
  return null;
}

function productionDependencies(config: ApiConfig): GovernanceDecisionDependencies {
  const oidc = getOidcRuntimeConfig(config);
  return {
    verifyToken: createGovernanceTokenVerifier({
      issuer: oidc.issuer,
      audience: config.GOVERNANCE_DECISION_AUDIENCE!,
      allowedClients: new Set(
        (config.GOVERNANCE_DECISION_ALLOWED_CLIENTS ?? "sq-organ").split(",").map((value) => value.trim()).filter(Boolean),
      ),
      stepUp: { acr: REQUIRED_ACR, maxAgeSeconds: MAX_TOKEN_AGE_SECONDS },
    }),
    applicationAccess: new SqHubApplicationAccessClient(
      oidc.issuer, oidc.machineClientId, oidc.machineClientSecret, oidc.applicationAccessUrl,
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

interface DecisionRow {
  stepId: string;
  requestId: string;
  policyKey: string;
  requesterName: string;
  requesterPosition: string | null;
  requesterUnit: string | null;
  startOn: string;
  endOn: string;
  workingDays: number;
  reason: string | null;
  submittedAt: Date;
}

interface HistoryRow {
  requestId: string;
  order: number;
  status: string;
  decidedAt: Date | null;
  sources: string[] | null;
}

export function registerGovernanceDecisionRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injected?: GovernanceDecisionDependencies,
) {
  // Off by default (ORG-015-1). The routes are registered either way, as the summary routes are,
  // so the AUTH-011 manifest covers them; while the flag is off they answer 404 and nothing behind
  // them is ever reached.
  const enabled = isGovernanceDecisionsEnabled(config);
  const dependencies = enabled ? (injected ?? productionDependencies(config)) : null;

  async function audit(request: FastifyRequest, eventType: string, accountId: string | null, reasonCode: string | null) {
    await pool.query(
      `INSERT INTO auth_audit_events (id, account_id, event_type, ip_address, user_agent, reason_code)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), accountId, eventType, request.ip ?? null, request.headers["user-agent"] ?? null, reasonCode],
    );
  }

  async function deny(
    request: FastifyRequest, reply: FastifyReply, statusCode: number, code: string, accountId: string | null,
  ) {
    await audit(request, "governance.decision.denied", accountId, code);
    reply.header("Cache-Control", "private, no-store");
    return reply.status(statusCode).send({ code, message: MESSAGES[code] ?? "Permintaan ditolak." });
  }

  /**
   * Verify the token, then resolve the account. The caller must be an organ account: a salaried
   * Pengurus is an HCIS employee and decides with a cookie session in /app, as ORGAN-IMPL-001 §4.2
   * keeps it.
   */
  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ identity: GovernanceIdentity; account: ResolvedGovernanceAccount } | null> {
    // A cookie never authenticates this route; exactly one bearer token is required.
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
    return { identity, account };
  }

  /**
   * ORG-015-3: the caller's own pending steps, with the data ORG-013-3 allows — what is being asked,
   * by whom, for when, and why. Other approvers' notes, attachments and names stay in HCIS.
   */
  app.get("/governance/decisions", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!dependencies) return reply.status(404).send({ code: "NOT_FOUND", message: "Tidak ditemukan." });
    try {
      const authenticated = await authenticate(request, reply);
      if (!authenticated) return;
      const { account } = authenticated;

      try {
        await assertGovernanceApprovalCapability(pool, account.id);
      } catch (error) {
        const known = mapKnownError(error);
        if (!known) throw error;
        return await deny(request, reply, known.statusCode, known.code, account.id);
      }

      const steps = await pool.query<DecisionRow>(
        `SELECT
          s.id AS "stepId",
          r.id AS "requestId",
          r.policy_key AS "policyKey",
          e.full_name AS "requesterName",
          COALESCE(NULLIF(btrim(e.structural_position), ''), NULLIF(btrim(e.functional_position), ''), p.name) AS "requesterPosition",
          u.name AS "requesterUnit",
          r.start_on::text AS "startOn",
          r.end_on::text AS "endOn",
          r.working_days AS "workingDays",
          r.reason,
          r.submitted_at AS "submittedAt"
        FROM leave_request_approval_steps s
        JOIN leave_requests r ON r.id = s.leave_request_id
        JOIN employees e ON e.id = r.employee_id
        LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
        LEFT JOIN positions p ON p.id = e.position_id
        WHERE s.approver_account_id = $1
          AND s.status = 'pending'
          AND r.status = 'in_review'
        ORDER BY r.submitted_at ASC`,
        [account.id],
      );

      const requestIds = steps.rows.map((row) => row.requestId);
      const history = requestIds.length === 0
        ? { rows: [] as HistoryRow[] }
        : await pool.query<HistoryRow>(
          `SELECT leave_request_id AS "requestId", step_order AS "order", status,
                  acted_at AS "decidedAt", sources
           FROM leave_request_approval_steps
           WHERE leave_request_id = ANY($1::uuid[])
           ORDER BY step_order ASC`,
          [requestIds],
        );

      await audit(request, "governance.decision.listed", account.id, null);
      return reply.status(200).send({
        items: steps.rows.map((row) => ({
          stepId: row.stepId,
          requestId: row.requestId,
          kind: row.policyKey,
          requester: {
            name: row.requesterName,
            positionLabel: row.requesterPosition,
            unitName: row.requesterUnit,
          },
          period: { startOn: row.startOn, endOn: row.endOn, workingDays: row.workingDays },
          reason: row.reason,
          submittedAt: row.submittedAt.toISOString(),
          history: history.rows
            .filter((step) => step.requestId === row.requestId)
            .map((step) => ({
              order: step.order,
              status: step.status,
              decidedAt: step.decidedAt ? step.decidedAt.toISOString() : null,
              approverRole: roleLabel(step.sources),
            })),
        })),
      });
    } catch (error) {
      request.log.error(
        { errorName: (error as Error)?.name, errorCode: (error as { code?: string })?.code },
        "governance decision list failed",
      );
      return reply.status(500).send({ code: "INTERNAL_ERROR", message: "Terjadi kesalahan." });
    }
  });

  /**
   * ORG-015-3: forward one decision. The token is spent before the step is read, and outside the
   * decision transaction, so one token is one attempt whatever the step turns out to be — a token
   * captured in flight cannot be tried against a second step after the first is refused.
   */
  app.post("/governance/decisions/:stepId", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!dependencies) return reply.status(404).send({ code: "NOT_FOUND", message: "Tidak ditemukan." });
    try {
      const params = stepParamSchema.safeParse(request.params);
      const body = decisionBodySchema.safeParse(request.body);
      const authenticated = await authenticate(request, reply);
      if (!authenticated) return;
      const { identity, account } = authenticated;

      if (!params.success || !body.success) {
        return await deny(request, reply, 400, "INVALID_APPROVAL_DECISION", account.id);
      }

      try {
        await spendActorAssertion(
          pool,
          {
            issuer: identity.issuer,
            subject: identity.subject,
            authorizedParty: identity.client,
            jti: identity.jti!,
            expiresAt: identity.expiresAt!,
          },
          {
            method: "POST",
            path: `/governance/decisions/${params.data.stepId}`,
            actorAccountId: account.id,
          },
        );
      } catch (error) {
        if (!(error instanceof ActorAssertionError)) throw error;
        return await deny(request, reply, 409, "DECISION_TOKEN_SPENT", account.id);
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { payload, replayed } = await applyLeaveApprovalDecision(client, {
          principal: { id: account.id, principalType: "FOUNDATION_BOARD" },
          stepId: params.data.stepId,
          decision: body.data.decision,
          note: body.data.note ?? null,
          decisionRequestId: body.data.requestId,
        });
        await client.query("COMMIT");
        await audit(request, "governance.decision.served", account.id, replayed ? "REPLAY" : null);
        return reply.status(200).send(payload);
      } catch (error) {
        await client.query("ROLLBACK");
        const known = mapKnownError(error);
        if (!known) throw error;
        await audit(request, "governance.decision.denied", account.id, known.code);
        return reply.status(known.statusCode).send({ code: known.code, message: known.message });
      } finally {
        client.release();
      }
    } catch (error) {
      request.log.error(
        { errorName: (error as Error)?.name, errorCode: (error as { code?: string })?.code },
        "governance decision failed",
      );
      return reply.status(500).send({ code: "INTERNAL_ERROR", message: "Terjadi kesalahan." });
    }
  });
}
