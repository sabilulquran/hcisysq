// ASSET-001 §3 / §7: the adapter to Aset SQ ASQ-004. Aset SQ owns asset and custody facts;
// HCIS reads one employee's outstanding custody on demand and stores nothing. The machine
// client is dedicated to this call (`hcis-aset-custody`), never the SQ Hub one.

import * as oidc from "openid-client";
import { z } from "zod";

const REQUEST_TIMEOUT_MS = 5_000;
/** Refresh the machine token this long before Keycloak says it expires. */
const TOKEN_EARLY_REFRESH_MS = 30_000;
const DEFAULT_TOKEN_LIFETIME_MS = 60_000;

const httpUrl = z
  .string()
  .url()
  .max(512)
  .refine((value) => ["https:", "http:"].includes(new URL(value).protocol));

const assignmentSchema = z
  .object({
    assignmentId: z.string().uuid(),
    assetTag: z.string().min(1).max(200),
    assetLabel: z.string().min(1).max(400),
    custodyState: z.enum(["ACTIVE", "PENDING_ACCEPTANCE"]),
    checkoutAt: z.string().datetime(),
    expectedReturnOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    overdue: z.boolean(),
  })
  .strict();

/** ASQ-004 contract v1, validated strictly: anything else is "unavailable", never shown. */
const personCustodySchema = z
  .object({
    personRef: z.string(),
    generatedAt: z.string().datetime(),
    clearance: z.enum(["CLEAR", "OUTSTANDING"]),
    counts: z
      .object({
        outstanding: z.number().int().nonnegative(),
        pendingAcceptance: z.number().int().nonnegative(),
        overdue: z.number().int().nonnegative(),
      })
      .strict(),
    assignments: z.array(assignmentSchema).max(200),
    truncated: z.boolean(),
    selfServiceUrl: httpUrl,
  })
  .strict();

export type PersonCustody = Omit<z.infer<typeof personCustodySchema>, "personRef">;

/** Why a read failed; logged as a short code, never with the person or the response body. */
export type PersonCustodyFailure = "TOKEN_FAILED" | "HTTP_ERROR" | "UNREACHABLE" | "INVALID_RESPONSE";

export class PersonCustodyUnavailableError extends Error {
  constructor(readonly failure: PersonCustodyFailure, readonly httpStatus: number | null = null) {
    super(`Aset SQ person custody unavailable: ${failure}${httpStatus ? ` (HTTP ${httpStatus})` : ""}`);
    this.name = "PersonCustodyUnavailableError";
  }
}

export interface PersonCustodyReader {
  /** Outstanding custody of one HCIS employee; throws PersonCustodyUnavailableError. */
  read(employeeId: string): Promise<PersonCustody>;
}

export function personRefFor(employeeId: string): string {
  return `hcis:employee:${employeeId}`;
}

export class AsetSqPersonCustodyClient implements PersonCustodyReader {
  private configurationPromise: Promise<oidc.Configuration> | null = null;
  private cachedToken: { value: string; expiresAt: number } | null = null;
  private readonly issuer: string;
  private readonly baseUrl: string;

  constructor(
    issuer: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    baseUrl: string,
    private readonly now: () => number = Date.now,
  ) {
    this.issuer = issuer.replace(/\/$/, "");
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async read(employeeId: string): Promise<PersonCustody> {
    const personRef = personRefFor(employeeId);
    const token = await this.getToken();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/internal/v1/person-custody/${encodeURIComponent(personRef)}`, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new PersonCustodyUnavailableError("UNREACHABLE");
    }

    if (!response.ok) {
      // A rejected token may be a rotated secret or a changed mapper: fetch a fresh one next time.
      if (response.status === 401) this.cachedToken = null;
      throw new PersonCustodyUnavailableError("HTTP_ERROR", response.status);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new PersonCustodyUnavailableError("INVALID_RESPONSE");
    }
    const parsed = personCustodySchema.safeParse(body);
    // An answer about someone else is as wrong as a malformed one.
    if (!parsed.success || parsed.data.personRef !== personRef) {
      throw new PersonCustodyUnavailableError("INVALID_RESPONSE");
    }
    return {
      generatedAt: parsed.data.generatedAt,
      clearance: parsed.data.clearance,
      counts: parsed.data.counts,
      assignments: parsed.data.assignments,
      truncated: parsed.data.truncated,
      selfServiceUrl: parsed.data.selfServiceUrl,
    };
  }

  private async getToken(): Promise<string> {
    const cached = this.cachedToken;
    if (cached && this.now() < cached.expiresAt - TOKEN_EARLY_REFRESH_MS) return cached.value;
    try {
      const configuration = await this.getConfiguration();
      const tokens = await oidc.clientCredentialsGrant(configuration);
      if (!tokens.access_token) throw new Error("no access token");
      const lifetimeMs = typeof tokens.expires_in === "number" ? tokens.expires_in * 1_000 : DEFAULT_TOKEN_LIFETIME_MS;
      this.cachedToken = { value: tokens.access_token, expiresAt: this.now() + lifetimeMs };
      return tokens.access_token;
    } catch {
      this.cachedToken = null;
      throw new PersonCustodyUnavailableError("TOKEN_FAILED");
    }
  }

  private async getConfiguration(): Promise<oidc.Configuration> {
    if (!this.configurationPromise) {
      this.configurationPromise = oidc
        .discovery(new URL(this.issuer), this.clientId, this.clientSecret)
        .catch((error: unknown) => {
          this.configurationPromise = null;
          throw error;
        });
    }
    return this.configurationPromise;
  }
}
