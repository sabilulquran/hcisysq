import * as oidc from "openid-client";
import { z } from "zod";

// AUTH-002-INVITE / SQ Hub HUB-IMPL-024: HCIS asks SQ Hub to prepare an employee's Akun SQ.
// Only the NIP and the asking HCIS account id are sent; SQ Hub reads name and e-mail from HCIS.

const inviteResponseSchema = z.object({
  identity: z.object({
    issuer: z.string().url().max(2048),
    subject: z.string().min(1).max(512),
  }),
  employeeId: z.string().regex(/^hcis:employee:[0-9a-f-]{36}$/i),
  credentialInitialization: z.enum(["sent", "already_complete", "required_action_pending"]),
  applicationAccess: z.enum(["granted", "already_active", "revoked"]),
});

export type StaffActivationInviteResult = z.infer<typeof inviteResponseSchema>;

/** SQ Hub answered with a stable refusal (4xx); `code` is SQ Hub's `error` value. */
export class StaffActivationRejectedError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`SQ Hub refused the staff activation invite: ${code}`);
    this.name = "StaffActivationRejectedError";
  }
}

/** SQ Hub could not be reached or gave no usable answer; safe to retry later. */
export class StaffActivationUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`SQ Hub staff activation unavailable: ${reason}`);
    this.name = "StaffActivationUnavailableError";
  }
}

export interface StaffActivationInviter {
  invite(input: { employeeNumber: string; accountId: string }): Promise<StaffActivationInviteResult>;
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export class SqHubStaffActivationClient implements StaffActivationInviter {
  private configurationPromise: Promise<oidc.Configuration> | null = null;
  private readonly issuer: string;

  constructor(
    issuer: string,
    private readonly machineClientId: string,
    private readonly machineClientSecret: string,
    private readonly inviteUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.issuer = issuer.replace(/\/$/, "");
  }

  async invite(input: { employeeNumber: string; accountId: string }): Promise<StaffActivationInviteResult> {
    let accessToken: string;
    try {
      const configuration = await this.getConfiguration();
      const tokens = await oidc.clientCredentialsGrant(configuration);
      if (!tokens.access_token) throw new Error("no access token");
      accessToken = tokens.access_token;
    } catch {
      throw new StaffActivationUnavailableError("machine_token");
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.inviteUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ employeeNumber: input.employeeNumber, requestedBy: { accountId: input.accountId } }),
        redirect: "error",
        // SQ Hub calls HCIS and Keycloak (and Keycloak sends mail) before answering.
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new StaffActivationUnavailableError("network");
    }

    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const code = typeof body?.error === "string" && ERROR_CODE.test(body.error) ? body.error : `HTTP_${response.status}`;
      throw new StaffActivationRejectedError(response.status, code);
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const code = typeof body?.error === "string" && ERROR_CODE.test(body.error) ? body.error : `http_${response.status}`;
      throw new StaffActivationUnavailableError(code);
    }
    const parsed = inviteResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new StaffActivationUnavailableError("invalid_response");
    return parsed.data;
  }

  private async getConfiguration(): Promise<oidc.Configuration> {
    if (!this.configurationPromise) {
      this.configurationPromise = oidc
        .discovery(new URL(this.issuer), this.machineClientId, this.machineClientSecret)
        .catch((error: unknown) => {
          this.configurationPromise = null;
          throw error;
        });
    }
    return this.configurationPromise;
  }
}

/** SQ Hub serves /internal/v1/* at its origin, like the application-access check. */
export function staffActivationInviteUrl(config: {
  SQ_HUB_APPLICATION_ACCESS_URL?: string | undefined;
  SQ_HUB_STAFF_ACTIVATION_URL?: string | undefined;
}): string | null {
  if (config.SQ_HUB_STAFF_ACTIVATION_URL) return config.SQ_HUB_STAFF_ACTIVATION_URL;
  if (!config.SQ_HUB_APPLICATION_ACCESS_URL) return null;
  return new URL("/internal/v1/staff-activation/invite", new URL(config.SQ_HUB_APPLICATION_ACCESS_URL).origin).toString();
}
