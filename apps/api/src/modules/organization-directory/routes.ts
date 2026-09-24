import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { assertIsoDate } from "../organization/jakarta-date.js";
import type { OrganizationDirectorySnapshot } from "./contract.js";
import {
  createOrganizationDirectoryMachineTokenVerifier,
  OrganizationDirectoryMachineAuthError,
  readBearerToken,
  type VerifyOrganizationDirectoryMachineToken,
} from "./machine-auth.js";
import {
  loadOrganizationDirectorySnapshot,
  OrganizationDirectoryContractError,
  OrganizationDirectoryUnavailableError,
} from "./producer.js";

const querySchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

export interface OrganizationDirectoryRouteOverrides {
  verifyMachineToken?: VerifyOrganizationDirectoryMachineToken;
  loadSnapshot?: (asOf: string) => Promise<OrganizationDirectorySnapshot>;
}

function configuredVerifier(config: ApiConfig): VerifyOrganizationDirectoryMachineToken {
  if (
    !config.ORG_DIRECTORY_TOKEN_ISSUER
    || !config.ORG_DIRECTORY_TOKEN_AUDIENCE
    || !config.ORG_DIRECTORY_ALLOWED_CLIENTS
  ) {
    throw new Error("Organization Directory machine authentication configuration is incomplete.");
  }
  const allowedClients = new Set(
    config.ORG_DIRECTORY_ALLOWED_CLIENTS.split(",").map((item) => item.trim()).filter(Boolean),
  );
  if (allowedClients.size === 0) {
    throw new Error("ORG_DIRECTORY_ALLOWED_CLIENTS must contain at least one client id.");
  }
  return createOrganizationDirectoryMachineTokenVerifier({
    issuer: config.ORG_DIRECTORY_TOKEN_ISSUER,
    audience: config.ORG_DIRECTORY_TOKEN_AUDIENCE,
    allowedClients,
    requiredScope: config.ORG_DIRECTORY_REQUIRED_SCOPE,
  });
}

async function authenticate(
  request: FastifyRequest,
  verifyMachineToken: VerifyOrganizationDirectoryMachineToken,
) {
  const token = readBearerToken(request.headers.authorization);
  if (!token) {
    throw new OrganizationDirectoryMachineAuthError("INVALID_TOKEN", "Bearer token is required.");
  }
  return verifyMachineToken(token);
}

export async function registerOrganizationDirectoryRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  overrides: OrganizationDirectoryRouteOverrides = {},
) {
  const exportEnabled = config.ORG_DIRECTORY_EXPORT_ENABLED === "1";
  const verifyMachineToken = exportEnabled
    ? overrides.verifyMachineToken ?? configuredVerifier(config)
    : null;
  const loadSnapshot = overrides.loadSnapshot
    ?? ((asOf: string) => loadOrganizationDirectorySnapshot(pool, asOf));

  app.get("/internal/v1/organization-directory/snapshot", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    if (!exportEnabled || !verifyMachineToken) {
      return reply.status(503).send({
        code: "ORGANIZATION_DIRECTORY_EXPORT_DISABLED",
        message: "Organization Directory export is not enabled.",
      });
    }

    let principal;
    try {
      principal = await authenticate(request, verifyMachineToken);
    } catch (error) {
      if (error instanceof OrganizationDirectoryMachineAuthError) {
        const forbidden = error.code === "FORBIDDEN_CLIENT" || error.code === "INSUFFICIENT_SCOPE";
        return reply.status(forbidden ? 403 : 401).send({
          code: error.code,
          message: forbidden ? "Machine identity is not authorized." : "Machine token is invalid.",
        });
      }
      throw error;
    }

    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        code: "INVALID_AS_OF",
        message: "asOf must be a valid YYYY-MM-DD business date.",
      });
    }
    try {
      assertIsoDate(parsed.data.asOf);
    } catch {
      return reply.status(400).send({
        code: "INVALID_AS_OF",
        message: "asOf must be a valid YYYY-MM-DD business date.",
      });
    }

    try {
      const snapshot = await loadSnapshot(parsed.data.asOf);
      request.log.info({
        clientId: principal.clientId,
        asOf: snapshot.asOf,
        sourceSnapshotId: snapshot.source.snapshotId,
        version: snapshot.version,
        counts: snapshot.counts,
      }, "organization directory snapshot exported");
      return reply.send(snapshot);
    } catch (error) {
      if (error instanceof OrganizationDirectoryUnavailableError) {
        request.log.warn({
          clientId: principal.clientId,
          asOf: parsed.data.asOf,
          category: "source_unavailable",
        }, "organization directory snapshot unavailable");
        return reply.status(503).send({
          code: "ORGANIZATION_DIRECTORY_UNAVAILABLE",
          message: "No effective published organization snapshot is available.",
        });
      }
      if (error instanceof OrganizationDirectoryContractError) {
        request.log.error({
          clientId: principal.clientId,
          asOf: parsed.data.asOf,
          category: "contract_validation",
        }, "organization directory snapshot generation failed validation");
        return reply.status(500).send({
          code: "ORGANIZATION_DIRECTORY_CONTRACT_ERROR",
          message: "Organization Directory snapshot could not be generated safely.",
        });
      }
      request.log.error({
        clientId: principal.clientId,
        asOf: parsed.data.asOf,
        category: "unexpected",
      }, "organization directory snapshot generation failed");
      return reply.status(500).send({
        code: "ORGANIZATION_DIRECTORY_INTERNAL_ERROR",
        message: "Organization Directory snapshot could not be generated safely.",
      });
    }
  });
}
