import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import { getOidcRuntimeConfig, type ApiConfig } from "../../config/env.js";
import { ApplicationAccessError, SqHubApplicationAccessClient } from "./application-access.js";
import {
  createOrganizationDirectoryMachineTokenVerifier,
  OrganizationDirectoryMachineAuthError,
  readBearerToken,
} from "../organization-directory/machine-auth.js";
import type { VerifyOrganizationDirectoryMachineToken } from "../organization-directory/machine-auth.js";
import {
  ActorAssertionError,
  createActorAssertionVerifier,
  resolveAssertedActor,
  spendActorAssertion,
  type ActorAssertionClaims,
  type VerifyActorAssertion,
} from "./actor-assertion.js";
import {
  allowedScopes, canDelegateRole, createRoleAssignment, removeRoleAssignment,
} from "./role-assignment.js";
import { AuthError, type AuthPrincipal } from "./service.js";

/**
 * AUTH-014 §2 — the channel through which the Platform Administrator in SQ Hub grants HCIS roles.
 *
 * Registered but inert until `HCIS_ROLE_ADMIN_ENABLED=1` (phase F4 ships it switched off, F5 turns
 * it on). Two separate proofs are required on every mutating call, and neither substitutes for the
 * other: a machine token saying the request came from SQ Hub, and an actor assertion saying which
 * human is acting. See §2.2 for why the actor cannot simply be stated in the body.
 *
 * What HCIS does NOT check here, stated plainly because the first draft claimed otherwise (§2.5):
 * whether that human is authorised to grant. SQ Hub checks that. HCIS checks that the human is
 * real and currently active, is not granting to themselves, is not replaying an old request, and is
 * asking for a role inside the limits HCIS sets for itself.
 */

const SCOPE = "role-administration.manage";

const assignmentBodySchema = z.object({
  requestId: z.string().uuid(),
  roleId: z.string().uuid(),
  scopeType: z.enum(["own", "unit", "organization"]),
  organizationalUnitId: z.string().uuid().nullish(),
  startsOn: z.string().date().nullish(),
  endsOn: z.string().date().nullish(),
  reason: z.string().trim().max(1000).nullish(),
  // §2.2: identity never travels in the body. A caller still sending it is working from the
  // superseded design, and silently ignoring the field would hide that.
  actor: z.undefined({ message: "actor must come from the signed assertion, not the body" }),
}).strict();

const removalBodySchema = z.object({ requestId: z.string().uuid() }).strict();
const assignmentIdSchema = z.object({ assignmentId: z.string().uuid() });
const accountIdSchema = z.object({ accountId: z.string().uuid() });

export function registerRoleAdministrationRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  overrides?: {
    verifyMachineToken?: VerifyOrganizationDirectoryMachineToken;
    verifyActorAssertion?: VerifyActorAssertion;
    applicationAccess?: Pick<SqHubApplicationAccessClient, "isAllowed">;
  },
) {
  const enabled = config.HCIS_ROLE_ADMIN_ENABLED === "1";

  const verifyMachineToken = enabled
    ? overrides?.verifyMachineToken ?? createOrganizationDirectoryMachineTokenVerifier({
      issuer: config.HCIS_ROLE_ADMIN_TOKEN_ISSUER!,
      audience: config.HCIS_ROLE_ADMIN_TOKEN_AUDIENCE!,
      allowedClients: new Set(
        config.HCIS_ROLE_ADMIN_ALLOWED_CLIENTS!.split(",").map((value) => value.trim()).filter(Boolean),
      ),
      requiredScope: SCOPE,
    })
    : null;

  const verifyActorAssertion = enabled
    ? overrides?.verifyActorAssertion ?? createActorAssertionVerifier({
      issuer: config.HCIS_ROLE_ADMIN_TOKEN_ISSUER!,
      audience: config.HCIS_ROLE_ADMIN_ACTOR_AUDIENCE!,
      maxAgeSeconds: Number(config.HCIS_ROLE_ADMIN_ACTOR_MAX_AGE_SECONDS),
      // Every machine client this deployment knows about, not just the one that calls this
      // channel: a token issued to any of them is a service talking, never a person.
      machineClients: new Set([
        ...(config.HCIS_ROLE_ADMIN_ALLOWED_CLIENTS ?? "").split(","),
        ...(config.STAFF_IDENTITY_ALLOWED_CLIENTS ?? "").split(","),
        ...(config.ORG_DIRECTORY_ALLOWED_CLIENTS ?? "").split(","),
      ].map((value) => value.trim()).filter(Boolean)),
    })
    : null;

  /**
   * §2.4 step 4b: the same SQ Hub Application Access check HCIS performs at OIDC login, re-run for
   * the asserted actor. The governance summary route does this on the same kind of identity, and
   * skipping it here would mean an employee whose HCIS access was revoked in the Hub stays a valid
   * grantor as long as their HCIS account row is still active. Unavailable means denied.
   */
  const applicationAccess = enabled
    ? overrides?.applicationAccess ?? (() => {
      const oidc = getOidcRuntimeConfig(config);
      return new SqHubApplicationAccessClient(
        oidc.issuer, oidc.machineClientId, oidc.machineClientSecret, oidc.applicationAccessUrl,
      );
    })()
    : null;

  /**
   * §2.4 steps 1–4, in order, before the body is read. The assertion lives in a header precisely so
   * that identity is settled before any input is parsed.
   */
  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");

    // Credentials are demanded before the feature switch is consulted. An anonymous caller gets
    // 401 whatever the switch says, which is what every other guarded route in this API does and
    // what the persona test asserts; it also means configuration state is not readable by someone
    // who has presented nothing.
    const token = readBearerToken(request.headers.authorization);
    const assertionHeader = request.headers["x-sq-actor-assertion"];
    const assertion = typeof assertionHeader === "string" ? assertionHeader.trim() : "";
    if (!token || !assertion) {
      await reply.status(401).send({ code: "UNAUTHENTICATED" });
      return null;
    }

    if (!verifyMachineToken || !verifyActorAssertion) {
      await reply.status(503).send({ code: "ROLE_ADMIN_CHANNEL_DISABLED" });
      return null;
    }

    try {
      await verifyMachineToken(token);
    } catch (error) {
      if (error instanceof OrganizationDirectoryMachineAuthError) {
        const forbidden = error.code === "FORBIDDEN_CLIENT" || error.code === "INSUFFICIENT_SCOPE";
        await reply.status(forbidden ? 403 : 401)
          .send({ code: forbidden ? "FORBIDDEN_CLIENT" : "UNAUTHENTICATED" });
        return null;
      }
      throw error;
    }

    try {
      const claims = await verifyActorAssertion(assertion);
      const actor = await resolveAssertedActor(pool, claims);
      let allowed: boolean;
      try {
        allowed = await applicationAccess!.isAllowed({ issuer: claims.issuer, subject: claims.subject });
      } catch (error) {
        if (!(error instanceof ApplicationAccessError)) throw error;
        await reply.status(503).send({ code: "APPLICATION_ACCESS_UNAVAILABLE" });
        return null;
      }
      if (!allowed) {
        await reply.status(403).send({ code: "HCIS_ACCESS_DENIED" });
        return null;
      }
      return { actor, claims };
    } catch (error) {
      if (error instanceof ActorAssertionError) {
        // Three outcomes, kept apart because they mean different things to whoever is debugging:
        // a bad assertion is the caller's problem (401); an already-spent one is a replay or a
        // retry (409); an unresolved actor means HCIS has no account for a person SQ Hub considers
        // real (403) — usually the Keycloak subject not matching what HCIS stored.
        const status = error.code === "ACTOR_UNRESOLVED" ? 403
          : error.code === "ACTOR_ASSERTION_SPENT" ? 409 : 401;
        const code = error.code === "ACTOR_UNRESOLVED" ? "ROLE_ADMIN_ACTOR_UNRESOLVED"
          : error.code === "ACTOR_ASSERTION_SPENT" ? "ROLE_ADMIN_ACTOR_ASSERTION_SPENT"
            : "ROLE_ADMIN_ACTOR_ASSERTION_INVALID";
        await reply.status(status).send({ code });
        return null;
      }
      throw error;
    }
  }

  /**
   * §2.11 gap 1. The binding records the real target, not the route template: `request.url` carries
   * the account or assignment id, so a grant nobody recognises can be traced to one presentation
   * without first joining the audit table.
   */
  async function spend(
    request: FastifyRequest,
    session: { actor: AuthPrincipal; claims: ActorAssertionClaims },
    hubRequestId: string,
  ): Promise<void> {
    await spendActorAssertion(pool, session.claims, {
      method: request.method,
      path: request.url,
      hubRequestId,
      actorAccountId: session.actor.id,
    });
  }

  async function sendAssertionError(reply: FastifyReply, error: unknown): Promise<boolean> {
    if (!(error instanceof ActorAssertionError)) return false;
    await reply.status(409).send({ code: "ROLE_ADMIN_ACTOR_ASSERTION_SPENT" });
    return true;
  }

  /**
   * The unique index on (hub_request_id, action) is the real guard; this turns the resulting
   * constraint violation into an answer the caller can act on instead of a 500.
   */
  async function sendDomainError(reply: FastifyReply, error: unknown): Promise<boolean> {
    if (error instanceof AuthError) {
      await reply.status(error.statusCode).send({ code: error.code, message: error.message });
      return true;
    }
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23505"
      && String((error as { constraint?: string }).constraint ?? "").includes("hub_request")) {
      await reply.status(409).send({ code: "ROLE_ADMIN_REQUEST_REPLAYED" });
      return true;
    }
    return false;
  }

  app.post("/internal/v1/role-administration/accounts/:accountId/role-assignments", async (request, reply) => {
    const session = await authenticate(request, reply);
    if (!session) return;

    const params = accountIdSchema.safeParse(request.params);
    const body = assignmentBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_REQUEST" });
    }

    const { requestId, ...input } = body.data;
    try {
      // §2.11 gap 1: spend the assertion here — once the request is known to be well formed and
      // the Hub has answered, so a malformed body or a Hub outage does not cost a token exchange
      // from a service that may be the one that is down. After this point it is spent whatever
      // happens: one assertion is one attempt at this grant.
      await spend(request, session, requestId);
      const id = await createRoleAssignment(pool, session.actor, params.data.accountId, input,
        { channel: "sq_hub", hubRequestId: requestId });
      return reply.status(201).send({ assignmentId: id, requestId });
    } catch (error) {
      if (await sendAssertionError(reply, error)) return;
      if (await sendDomainError(reply, error)) return;
      throw error;
    }
  });

  app.delete("/internal/v1/role-administration/role-assignments/:assignmentId", async (request, reply) => {
    const session = await authenticate(request, reply);
    if (!session) return;

    const params = assignmentIdSchema.safeParse(request.params);
    const body = removalBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_REQUEST" });
    }

    try {
      await spend(request, session, body.data.requestId);
      await removeRoleAssignment(pool, session.actor, params.data.assignmentId,
        { channel: "sq_hub", hubRequestId: body.data.requestId });
      return reply.status(204).send();
    } catch (error) {
      if (await sendAssertionError(reply, error)) return;
      if (await sendDomainError(reply, error)) return;
      throw error;
    }
  });

  /**
   * §2.1: SQ Hub builds its screen from this, so the list of HCIS roles stays owned by HCIS. The
   * alternative — copying role keys into the Hub's code — guarantees the two drift apart.
   */
  app.get("/internal/v1/role-administration/catalog", async (request, reply) => {
    // Deliberately does NOT spend the assertion. SQ Hub's grant screen reads this catalog and then
    // posts the grant; burning the token on the read would answer the grant itself with 409, and
    // would also let an attacker pre-burn a captured assertion with a harmless-looking read.
    const session = await authenticate(request, reply);
    if (!session) return;

    const roles = await pool.query<{ roleId: string; roleKey: string; name: string; description: string | null; permissions: string[] }>(
      `SELECT role.id AS "roleId", role.role_key AS "roleKey", role.name, role.description,
              coalesce(array_agg(permission.permission_key)
                FILTER (WHERE permission.permission_key IS NOT NULL), ARRAY[]::text[]) AS permissions
         FROM roles role LEFT JOIN role_permissions permission ON permission.role_id = role.id
        GROUP BY role.id ORDER BY role.name`,
    );

    return reply.send({
      roles: roles.rows
        .filter((role) => canDelegateRole(role, false, "sq_hub"))
        .map((role) => ({
          roleId: role.roleId,
          roleKey: role.roleKey,
          name: role.name,
          description: role.description,
          permissions: role.permissions,
          allowedScopes: allowedScopes(role.roleKey),
          mandateRequired: MANDATE_REQUIRED.has(role.roleKey),
        })),
    });
  });
}

/** Roles whose grant needs organization scope and a stated mandate (§2.4 step 7). */
const MANDATE_REQUIRED = new Set([
  "human_capital_admin", "human_capital_lead", "foundation_board_viewer", "hcis_module_admin",
]);
