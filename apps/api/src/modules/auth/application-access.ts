import * as oidc from "openid-client";
import { z } from "zod";

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
  ) {
    this.issuer = issuer.replace(/\/$/, "");
  }

  async isAllowed(identity: OidcIdentity): Promise<boolean> {
    try {
      const configuration = await this.getConfiguration();
      const machineTokens = await oidc.clientCredentialsGrant(configuration);
      const accessToken = machineTokens.access_token;
      if (!accessToken) {
        throw new ApplicationAccessError("machine token response has no access token");
      }

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
