import * as oidc from "openid-client";

export interface OidcProviderOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
}

export interface OidcAuthorizationTransaction {
  state: string;
  codeVerifier: string;
  nonce: string;
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  /** Raw ID token, kept only so RP-initiated logout can send it as id_token_hint. */
  idToken?: string;
}

export class OidcProvider {
  private configurationPromise: Promise<oidc.Configuration> | null = null;
  private readonly issuer: string;

  constructor(private readonly options: OidcProviderOptions) {
    this.issuer = options.issuer.replace(/\/$/, "");
  }

  async createAuthorizationRequest(): Promise<{
    url: URL;
    transaction: OidcAuthorizationTransaction;
  }> {
    const configuration = await this.getConfiguration();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();

    const url = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: this.options.redirectUri,
      scope: "openid",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });

    return {
      url,
      transaction: { state, codeVerifier, nonce },
    };
  }

  async completeAuthorization(
    currentUrl: URL,
    transaction: OidcAuthorizationTransaction,
  ): Promise<OidcIdentity> {
    const configuration = await this.getConfiguration();
    const tokens = await oidc.authorizationCodeGrant(configuration, currentUrl, {
      pkceCodeVerifier: transaction.codeVerifier,
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();

    if (!claims || claims.iss !== this.issuer || typeof claims.sub !== "string" || !claims.sub) {
      throw new Error("OIDC identity claims are invalid");
    }

    return {
      issuer: this.issuer,
      subject: claims.sub,
      ...(typeof tokens.id_token === "string" && tokens.id_token ? { idToken: tokens.id_token } : {}),
    };
  }

  /**
   * Akun SQ (Keycloak) skips its own "Keluar dari Akun SQ?" confirmation only when
   * id_token_hint is present. That confirmation page expires after a few minutes and a
   * resubmitted stale confirmation ends in a Keycloak internal server error, so the
   * hint is sent whenever HCIS still holds the ID token of the session.
   */
  async buildLogoutUrl(idTokenHint?: string | null): Promise<URL> {
    const configuration = await this.getConfiguration();
    return oidc.buildEndSessionUrl(configuration, {
      post_logout_redirect_uri: this.options.postLogoutRedirectUri,
      ...(idTokenHint ? { id_token_hint: idTokenHint } : {}),
    });
  }

  private async getConfiguration(): Promise<oidc.Configuration> {
    if (!this.configurationPromise) {
      this.configurationPromise = oidc
        .discovery(new URL(this.issuer), this.options.clientId, this.options.clientSecret)
        .catch((error: unknown) => {
          this.configurationPromise = null;
          throw error;
        });
    }
    return this.configurationPromise;
  }
}
