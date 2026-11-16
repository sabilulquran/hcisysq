// REWARD-001 §4.1 / §12: the port to the Al-Qur'an monthly scoreboard snapshot (SQ Hub
// QURAN-001 §11.3) and its HTTP adapter. The contract HCIS expects is written down in
// docs/domain/rewards.md §12 ("Kontrak snapshot v1") so SQ Hub can build it.
//
// Same shape as the Aset SQ adapter (employee-assets/aset-sq-client.ts): a dedicated machine
// client, strict validation, and a status instead of a 5xx. Anything that does not match the
// contract is UNAVAILABLE, never shown and never turned into candidates.

import * as oidc from "openid-client";
import { z } from "zod";

const REQUEST_TIMEOUT_MS = 10_000;
const OIDC_TIMEOUT_SECONDS = 5;
const TOKEN_EARLY_REFRESH_MS = 30_000;
const DEFAULT_TOKEN_LIFETIME_MS = 60_000;
export const QURAN_SCOREBOARD_SCOPE = "quran.scoreboard.read";
export const MAX_SCOPE_ENTRIES = 5_000;
export const MAX_UNIT_SCOPES = 200;

const monthText = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const personRef = z.string().regex(/^hcis:employee:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const unitRef = z.string().regex(/^hcis:org-node:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const entrySchema = z
  .object({
    personId: personRef,
    unitId: unitRef.nullable(),
    rank: z.number().int().min(1),
    pages: z.number().min(0).max(999_999).refine((value) => Math.abs(Math.round(value * 10) - value * 10) < 1e-6),
    activeDays: z.number().int().min(0).max(31),
    khatam: z.number().int().min(0).max(1000),
    labels: z.array(z.enum(["AUTO", "SELF_REPORTED"])).max(2),
  })
  .strict();

const scopeSchema = z
  .object({
    scope: z.enum(["FOUNDATION", "UNIT"]),
    unitId: unitRef.nullable(),
    entries: z.array(entrySchema).max(MAX_SCOPE_ENTRIES),
  })
  .strict()
  .refine((value) => (value.scope === "FOUNDATION") === (value.unitId === null))
  // Ranked in order, each person once: a shuffled or duplicated board is not a board.
  .refine((value) => value.entries.every((entry, index) => index === 0 || entry.rank >= value.entries[index - 1]!.rank))
  .refine((value) => new Set(value.entries.map((entry) => entry.personId)).size === value.entries.length);

export const monthlySnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    month: monthText,
    snapshotVersion: z.string().min(1).max(200),
    finalizedAt: z.string().datetime(),
    directory: z
      .object({ version: z.string().min(1).max(200), asOf: z.string().datetime(), stale: z.boolean() })
      .strict(),
    scopes: z.array(scopeSchema).min(1).max(MAX_UNIT_SCOPES + 1),
  })
  .strict()
  .refine((value) => value.scopes.filter((scope) => scope.scope === "FOUNDATION").length === 1)
  .refine((value) => {
    const units = value.scopes.filter((scope) => scope.scope === "UNIT").map((scope) => scope.unitId);
    return new Set(units).size === units.length;
  });

export type MonthlySnapshot = z.infer<typeof monthlySnapshotSchema>;
export type SnapshotEntry = z.infer<typeof entrySchema>;

export type ScoreboardFailure = "TOKEN_FAILED" | "HTTP_ERROR" | "UNREACHABLE" | "INVALID_RESPONSE";

/** What the port answers. Never throws for an expected failure. */
export type ScoreboardRead =
  | { status: "NOT_CONFIGURED" }
  | { status: "UNAVAILABLE"; failure: ScoreboardFailure; httpStatus: number | null }
  | { status: "NOT_FINAL" }
  | { status: "AVAILABLE"; snapshot: MonthlySnapshot };

export interface MonthlyScoreboardReader {
  read(month: string): Promise<ScoreboardRead>;
}

/** Used when the QURAN_* settings are absent: the screen says "sumber belum tersedia". */
export const notConfiguredReader: MonthlyScoreboardReader = {
  async read() {
    return { status: "NOT_CONFIGURED" };
  },
};

export class QuranMonthlyScoreboardClient implements MonthlyScoreboardReader {
  private configurationPromise: Promise<oidc.Configuration> | null = null;
  private cachedToken: { value: string; expiresAt: number } | null = null;
  private pendingToken: Promise<string> | null = null;
  private readonly issuer: string;
  private readonly baseUrl: string;

  constructor(
    issuer: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    baseUrl: string,
    private readonly audience: string,
    private readonly now: () => number = Date.now,
  ) {
    this.issuer = issuer.replace(/\/$/, "");
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async read(month: string): Promise<ScoreboardRead> {
    let token: string;
    try {
      token = await this.getToken();
    } catch {
      return { status: "UNAVAILABLE", failure: "TOKEN_FAILED", httpStatus: null };
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/internal/quran/v1/scoreboards/monthly?month=${encodeURIComponent(month)}`, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { status: "UNAVAILABLE", failure: "UNREACHABLE", httpStatus: null };
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      if (response.status === 401) this.cachedToken = null;
      // §4.1: a month that is not final yet is waited for, not a failure.
      if (response.status === 409 && (body as { code?: unknown } | null)?.code === "period_not_final") {
        return { status: "NOT_FINAL" };
      }
      return { status: "UNAVAILABLE", failure: "HTTP_ERROR", httpStatus: response.status };
    }

    const parsed = monthlySnapshotSchema.safeParse(body);
    // An answer about another month is as wrong as a malformed one.
    if (!parsed.success || parsed.data.month !== month) {
      return { status: "UNAVAILABLE", failure: "INVALID_RESPONSE", httpStatus: null };
    }
    return { status: "AVAILABLE", snapshot: parsed.data };
  }

  private async getToken(): Promise<string> {
    const cached = this.cachedToken;
    if (cached && this.now() < cached.expiresAt - TOKEN_EARLY_REFRESH_MS) return cached.value;
    this.pendingToken ??= this.fetchToken().finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  private async fetchToken(): Promise<string> {
    try {
      const configuration = await this.getConfiguration();
      const tokens = await oidc.clientCredentialsGrant(configuration, {
        scope: QURAN_SCOREBOARD_SCOPE,
        audience: this.audience,
      });
      if (!tokens.access_token) throw new Error("no access token");
      const lifetimeMs = typeof tokens.expires_in === "number" ? tokens.expires_in * 1_000 : DEFAULT_TOKEN_LIFETIME_MS;
      this.cachedToken = { value: tokens.access_token, expiresAt: this.now() + lifetimeMs };
      return tokens.access_token;
    } catch (error) {
      this.cachedToken = null;
      throw error;
    }
  }

  private async getConfiguration(): Promise<oidc.Configuration> {
    if (!this.configurationPromise) {
      this.configurationPromise = oidc
        .discovery(new URL(this.issuer), this.clientId, this.clientSecret, undefined, { timeout: OIDC_TIMEOUT_SECONDS })
        .then((configuration) => {
          configuration.timeout = OIDC_TIMEOUT_SECONDS;
          return configuration;
        })
        .catch((error: unknown) => {
          this.configurationPromise = null;
          throw error;
        });
    }
    return this.configurationPromise;
  }
}
