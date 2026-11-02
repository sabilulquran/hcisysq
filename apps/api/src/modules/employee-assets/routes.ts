// ASSET-001 §4–§6: Asset Saya and the Termination asset warning, read live from Aset SQ.
// No asset data is stored in HCIS. Aset SQ trouble never becomes a 5xx here: the screen still
// links to Aset SQ, and the Termination dialog keeps working (§9).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import {
  AsetSqPersonCustodyClient,
  PersonCustodyUnavailableError,
  type PersonCustody,
  type PersonCustodyReader,
} from "./aset-sq-client.js";

export const DEFAULT_ASET_SQ_SELF_SERVICE_URL = "https://aset.sabilulquran.or.id/my-assets";

export type AssetHoldings =
  | { status: "NOT_CONFIGURED" | "UNAVAILABLE"; selfServiceUrl: string }
  | ({ status: "AVAILABLE" } & PersonCustody);

const employeeParams = z.object({ employeeId: z.string().uuid() });

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

/** The adapter when all three settings are present; config validation refuses a partial set. */
export function createPersonCustodyReader(config: ApiConfig): PersonCustodyReader | null {
  if (
    !config.OIDC_ISSUER ||
    !config.ASET_SQ_PERSON_CUSTODY_URL ||
    !config.ASET_SQ_MACHINE_CLIENT_ID ||
    !config.ASET_SQ_MACHINE_CLIENT_SECRET
  ) {
    return null;
  }
  return new AsetSqPersonCustodyClient(
    config.OIDC_ISSUER,
    config.ASET_SQ_MACHINE_CLIENT_ID,
    config.ASET_SQ_MACHINE_CLIENT_SECRET,
    config.ASET_SQ_PERSON_CUSTODY_URL,
  );
}

export async function loadAssetHoldings(
  reader: PersonCustodyReader | null,
  employeeId: string,
  fallbackUrl: string,
  log: { warn: (object: object, message: string) => void },
): Promise<AssetHoldings> {
  if (!reader) return { status: "NOT_CONFIGURED", selfServiceUrl: fallbackUrl };
  try {
    const custody = await reader.read(employeeId);
    // The link leaves HCIS; only one on the configured Aset SQ origin is passed on.
    const sameOrigin = new URL(custody.selfServiceUrl).origin === new URL(fallbackUrl).origin;
    return { status: "AVAILABLE", ...custody, selfServiceUrl: sameOrigin ? custody.selfServiceUrl : fallbackUrl };
  } catch (error) {
    // Short code only: no person reference, token, or response body in the log.
    const failure = error instanceof PersonCustodyUnavailableError ? error.failure : "UNEXPECTED";
    const httpStatus = error instanceof PersonCustodyUnavailableError ? error.httpStatus : null;
    log.warn({ code: `ASSET_CUSTODY_${failure}`, httpStatus }, "Aset SQ person custody could not be read");
    return { status: "UNAVAILABLE", selfServiceUrl: fallbackUrl };
  }
}

export async function registerEmployeeAssetRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  dependencies: {
    reader?: PersonCustodyReader | null;
    auth?: Pick<AuthService, "getSession" | "getAuthorizationContext">;
  } = {},
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for employee asset routes");
  const auth = dependencies.auth ?? new AuthService(
    pool, config.AUTH_ENCRYPTION_KEY, config.AUTH_SESSION_TTL_HOURS, config.NODE_ENV === "production",
  );
  const reader = dependencies.reader !== undefined ? dependencies.reader : createPersonCustodyReader(config);
  const fallbackUrl = config.ASET_SQ_SELF_SERVICE_URL ?? DEFAULT_ASET_SQ_SELF_SERVICE_URL;

  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    return session.principal;
  }

  /** §4: own assets only. The employee comes from the session, never from the request. */
  app.get("/assets/me", async (request, reply) => {
    const principal = await authenticate(request, reply);
    if (!principal) return;
    // Same answer as the other self-service routes: a non-employee principal is refused.
    if (principal.principalType !== "EMPLOYEE") {
      return send(reply, 403, { code: "FORBIDDEN", message: "Asset Saya hanya tersedia untuk pegawai." });
    }
    const linked = await pool.query<{ employeeId: string }>(
        `SELECT account.employee_id AS "employeeId"
           FROM accounts account
           JOIN employees employee ON employee.id = account.employee_id
          WHERE account.id = $1
            AND account.principal_type = 'EMPLOYEE'
            AND account.status = 'active'
            AND employee.removed_at IS NULL
          LIMIT 1`,
        [principal.id],
      );
    const employeeId = linked.rows[0]?.employeeId;
    if (!employeeId) {
      return send(reply, 404, { code: "EMPLOYEE_NOT_LINKED", message: "Akun ini tidak tertaut ke data pegawai." });
    }
    return send(reply, 200, await loadAssetHoldings(reader, employeeId, fallbackUrl, request.log));
  });

  /** §5: the Termination warning, for whoever may record a termination. */
  app.get("/admin/employees/:employeeId/assets", async (request, reply) => {
    const principal = await authenticate(request, reply);
    if (!principal) return;
    const context = await auth.getAuthorizationContext(principal);
    if (!context.organizationPermissions.includes("employment.manage")) {
      return send(reply, 403, { code: "EMPLOYMENT_FORBIDDEN", message: "Anda tidak memiliki akses untuk tindakan ini." });
    }
    const params = employeeParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_EMPLOYEE", message: "Pegawai tidak valid." });
    const employee = await pool.query<{ id: string }>(
      "SELECT id FROM employees WHERE id = $1 AND removed_at IS NULL",
      [params.data.employeeId],
    );
    const employeeId = employee.rows[0]?.id;
    if (!employeeId) return send(reply, 404, { code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
    // The stored id, not the request's spelling: Aset SQ matches lowercase person refs exactly.
    return send(reply, 200, await loadAssetHoldings(reader, employeeId, fallbackUrl, request.log));
  });
}
