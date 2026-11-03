// WhatsApp port for HCIS (CAL-001 §9.2, SQ Hub ADR-0011). HCIS never talks to a WhatsApp
// engine: the `kirim` adapter calls Kirim SQ on SQ Hub, the `log` adapter sends nothing and
// reports a dry run. The `kirim` adapter authenticates with the machine client HCIS already uses
// for SQ Hub (SQ Hub KIRIM-IMPL-003 §6), so no Kirim credential lives in final.env.

import { createHash } from "node:crypto";

import { kirimSettings, type ApiConfig } from "../../config/env.js";

export interface WhatsAppMessage {
  /** Omitted: Kirim SQ uses the number on the HCIS card. */
  device?: string | undefined;
  /** E.164, e.g. +6281234567890 */
  to: string;
  text: string;
  /** ISO 8601; Kirim SQ drops the message when it cannot be sent before this. */
  expiresAt: string;
  /** Business reference without personal data, e.g. `cal:<meetingId>:invited`. */
  ref: string;
  idempotencyKey: string;
}

export interface WhatsAppResult {
  id: string;
  dryRun: boolean;
}

export interface WhatsAppSender {
  readonly name: "log" | "kirim";
  send(message: WhatsAppMessage): Promise<WhatsAppResult>;
}

/** Kirim SQ refused the message (a non-retryable 4xx). Never retried. */
export class WhatsAppRejectedError extends Error {
  constructor(readonly code: string) {
    super(`WhatsApp message rejected: ${code}`);
    this.name = "WhatsAppRejectedError";
  }
}

/** Temporary failure (5xx, timeout, network). Retried later with the same idempotency key. */
export class WhatsAppRetryableError extends Error {
  constructor(readonly code: string) {
    super(`WhatsApp send failed temporarily: ${code}`);
    this.name = "WhatsAppRetryableError";
  }
}

/** Normalizes an Indonesian mobile number to E.164 (+62…); null when it is not one. */
export function normalizeWhatsAppNumber(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/[\s.\-()]/g, "").replace(/^\+/, "");
  if (!/^\d+$/.test(digits)) return null;
  let national: string;
  if (digits.startsWith("62")) national = digits.slice(2);
  else if (digits.startsWith("0")) national = digits.slice(1);
  else if (digits.startsWith("8")) national = digits;
  else return null;
  return /^8\d{8,11}$/.test(national) ? `+62${national}` : null;
}

/** "+6281234567890" -> "+62812•••••890", for logs. */
export function maskWhatsAppNumber(e164: string): string {
  if (e164.length <= 9) return "•••";
  return `${e164.slice(0, 6)}${"•".repeat(e164.length - 9)}${e164.slice(-3)}`;
}

export interface LogEntry {
  device: string | undefined;
  to: string;
  ref: string;
  idempotencyKey: string;
  length: number;
}

/** Default adapter: opens no connection; logs the masked number and the reference only. */
export class LogWhatsAppSender implements WhatsAppSender {
  readonly name = "log" as const;

  constructor(private readonly log: (entry: LogEntry) => void = () => {}) {}

  async send(message: WhatsAppMessage): Promise<WhatsAppResult> {
    this.log({
      device: message.device,
      to: maskWhatsAppNumber(message.to),
      ref: message.ref,
      idempotencyKey: message.idempotencyKey,
      length: message.text.length,
    });
    return { id: `log_${createHash("sha256").update(message.idempotencyKey).digest("hex").slice(0, 20)}`, dryRun: true };
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TokenProvider {
  getToken(): Promise<string>;
  invalidate(): void;
}

/** Client credentials token for Kirim SQ (realm sq-staff, audience sq-hub-kirim), cached until near expiry. */
export class ClientCredentialsTokenProvider implements TokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: { tokenUrl: string; clientId: string; clientSecret: string; audience: string },
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 30_000 > this.now()) return this.cached.token;
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          audience: this.config.audience,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new WhatsAppRetryableError("token_unreachable");
    }
    if (!response.ok) throw new WhatsAppRetryableError(`token_http_${response.status}`);
    const json = await response.json() as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new WhatsAppRetryableError("token_invalid_response");
    this.cached = { token: json.access_token, expiresAt: this.now() + (json.expires_in ?? 60) * 1000 };
    return json.access_token;
  }

  invalidate(): void {
    this.cached = null;
  }
}

/** `POST {KIRIM_BASE_URL}/internal/kirim/messages` (KIRIM-IMPL-001 §5.1, §6.1). */
export class KirimWhatsAppSender implements WhatsAppSender {
  readonly name = "kirim" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly tokens: TokenProvider,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(message: WhatsAppMessage): Promise<WhatsAppResult> {
    const response = await this.post(message, false);
    if (response.status === 401) {
      // The token may have been rotated or revoked: one retry with a fresh token.
      this.tokens.invalidate();
      return this.interpret(await this.post(message, true));
    }
    return this.interpret(response);
  }

  private async post(message: WhatsAppMessage, isRetry: boolean): Promise<Response> {
    const token = await this.tokens.getToken();
    try {
      return await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/internal/kirim/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": message.idempotencyKey,
        },
        body: JSON.stringify({
          ...(message.device ? { device: message.device } : {}),
          jenis: "notifikasi",
          to: message.to,
          text: message.text,
          prioritas: "normal",
          kedaluwarsa: message.expiresAt,
          ref: message.ref,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new WhatsAppRetryableError(timedOut ? "timeout" : isRetry ? "network_after_reauth" : "network");
    }
  }

  private async interpret(response: Response): Promise<WhatsAppResult> {
    if (response.status === 202 || response.status === 200) {
      const json = await response.json().catch(() => ({})) as { id?: string };
      if (!json.id) throw new WhatsAppRetryableError("invalid_response");
      return { id: json.id, dryRun: false };
    }
    if (response.status >= 500 || response.status === 429 || response.status === 408) {
      throw new WhatsAppRetryableError(`http_${response.status}`);
    }
    // 400/401-after-reauth/403/404/409/422 are configuration or content problems, not transient.
    const json = await response.json().catch(() => null) as { error?: { code?: string }; code?: string } | null;
    throw new WhatsAppRejectedError(json?.error?.code ?? json?.code ?? `http_${response.status}`);
  }
}

export function createWhatsAppSender(
  config: Pick<
    ApiConfig,
    "WHATSAPP_ADAPTER" | "KIRIM_BASE_URL" | "KIRIM_TOKEN_URL" | "KIRIM_CLIENT_ID" | "KIRIM_CLIENT_SECRET" | "KIRIM_AUDIENCE"
    | "OIDC_ISSUER" | "SQ_HUB_APPLICATION_ACCESS_URL" | "SQ_HUB_MACHINE_CLIENT_ID" | "SQ_HUB_MACHINE_CLIENT_SECRET"
  >,
  deps: { fetch?: FetchLike; log?: (entry: LogEntry) => void } = {},
): WhatsAppSender {
  if (config.WHATSAPP_ADAPTER !== "kirim") return new LogWhatsAppSender(deps.log);
  // loadConfig refuses `kirim` when any of these cannot be resolved, so the assertions only document that.
  const settings = kirimSettings(config);
  const tokens = new ClientCredentialsTokenProvider(
    {
      tokenUrl: settings.tokenUrl!,
      clientId: settings.clientId!,
      clientSecret: settings.clientSecret!,
      audience: config.KIRIM_AUDIENCE,
    },
    deps.fetch,
  );
  return new KirimWhatsAppSender(settings.baseUrl!, tokens, deps.fetch);
}

/**
 * CAL-001 K-17: null when every recipient may receive real WhatsApp (`WHATSAPP_RECIPIENT_MODE=all`),
 * otherwise the allowed E.164 numbers. An empty set allows nobody.
 */
export function whatsappAllowlist(config: Pick<ApiConfig, "WHATSAPP_RECIPIENT_MODE" | "WHATSAPP_ALLOWLIST">): ReadonlySet<string> | null {
  return config.WHATSAPP_RECIPIENT_MODE === "all" ? null : new Set(config.WHATSAPP_ALLOWLIST);
}
