import * as oidc from "openid-client";
import { z } from "zod";

import { deriveLauncherUrl } from "./launcher.js";
import type { OidcIdentity } from "./oidc-provider.js";

const accessDecisionSchema = z
  .object({
    allowed: z.boolean(),
    applicationKey: z.literal("hcis"),
    decision: z.enum([
      "active_grant",
      "NO_GRANT",
      "GRANT_REVOKED",
      "APPLICATION_INACTIVE",
      "UNKNOWN_APPLICATION",
    ]),
  })
  .strict();

// AUTH-013: SQ Hub POST /internal/v1/application-access/launcher. Unknown fields are dropped;
// only https/http links are kept so a bad row can never become a script link in the launcher.
const launcherApplicationSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(120),
  canonicalUrl: z
    .string()
    .url()
    .max(512)
    .refine((value) => ["https:", "http:"].includes(new URL(value).protocol)),
});

const launcherResponseSchema = z.object({
  applications: z.array(launcherApplicationSchema).max(200),
});

export type LauncherApplication = z.infer<typeof launcherApplicationSchema>;

export class ApplicationAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplicationAccessError";
  }
}

export class SqHubApplicationAccessClient {
  private configurationPromise: Promise<oidc.Configuration> | null = null;
  private readonly issuer: string;

  constructor(
    issuer: string,
    private readonly machineClientId: string,
    private readonly machineClientSecret: string,
    private readonly accessCheckUrl: string,
    private readonly launcherUrl: string | null = deriveLauncherUrl(accessCheckUrl),
  ) {
    this.issuer = issuer.replace(/\/$/, "");
  }

  async isAllowed(identity: OidcIdentity): Promise<boolean> {
    try {
      const accessToken = await this.getMachineAccessToken();

      const response = await fetch(this.accessCheckUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        // SQ Hub accepts only { issuer, subject } (strict schema). Never forward
        // the rest of the identity, such as the raw ID token kept for logout.
        body: JSON.stringify({
          identity: { issuer: identity.issuer, subject: identity.subject },
          applicationKey: "hcis",
        }),
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        throw new ApplicationAccessError(`SQ Hub access check returned HTTP ${response.status}`);
      }

      const parsed = accessDecisionSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new ApplicationAccessError("SQ Hub access check returned an invalid response");
      }

      return parsed.data.allowed;
    } catch (error) {
      if (error instanceof ApplicationAccessError) throw error;
      throw new ApplicationAccessError("SQ Hub application access could not be verified");
    }
  }

  /**
   * AUTH-013: the SQ Hub applications this identity may open (SQ Hub itself excluded), with the
   * same machine client as the access check. Any failure is an ApplicationAccessError.
   */
  async listLauncherApplications(identity: Pick<OidcIdentity, "issuer" | "subject">): Promise<LauncherApplication[]> {
    if (!this.launcherUrl) {
      throw new ApplicationAccessError("SQ Hub launcher URL is not configured");
    }
    try {
      const accessToken = await this.getMachineAccessToken();
      const response = await fetch(this.launcherUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        // Strict body on SQ Hub: issuer and subject only.
        body: JSON.stringify({ identity: { issuer: identity.issuer, subject: identity.subject } }),
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        throw new ApplicationAccessError(`SQ Hub launcher returned HTTP ${response.status}`);
      }

      const parsed = launcherResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new ApplicationAccessError("SQ Hub launcher returned an invalid response");
      }
      return parsed.data.applications;
    } catch (error) {
      if (error instanceof ApplicationAccessError) throw error;
      throw new ApplicationAccessError("SQ Hub launcher could not be read");
    }
  }

  private async getMachineAccessToken(): Promise<string> {
    const configuration = await this.getConfiguration();
    const machineTokens = await oidc.clientCredentialsGrant(configuration);
    const accessToken = machineTokens.access_token;
    if (!accessToken) {
      throw new ApplicationAccessError("machine token response has no access token");
    }
    return accessToken;
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
