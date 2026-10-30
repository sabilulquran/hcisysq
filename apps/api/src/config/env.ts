import { z } from "zod";

import { deriveLauncherUrl } from "../modules/auth/launcher.js";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    DATABASE_URL: z.string().min(1),
    ADMS_INGRESS_HOST: z.string().trim().min(1).optional(),
    AUTH_MODE: z.enum(["local", "oidc"]).default("local"),
    AUTH_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
    AUTH_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(8),
    BIOMETRIC_COLLECTION_ENABLED: z.enum(["0", "1"]).optional(),
    MOBILE_ATTENDANCE_ENABLED: z.enum(["0", "1"]).optional(),
    BIOMETRIC_ACTIVE_KEY_ID: z.preprocess(
      (value) => value === "" ? undefined : value,
      z.string().trim().regex(/^[A-Za-z0-9._-]{1,80}$/).optional(),
    ),
    BIOMETRIC_ENCRYPTION_KEYS: z.preprocess(
      (value) => value === "" ? undefined : value,
      z.string().min(1).optional(),
    ),
    OIDC_ISSUER: z.string().url().optional(),
    OIDC_CLIENT_ID: z.string().trim().min(1).optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    OIDC_REDIRECT_URI: z.string().url().optional(),
    OIDC_POST_LOGOUT_REDIRECT_URI: z.string().url().optional(),
    SQ_HUB_APPLICATION_ACCESS_URL: z.string().url().optional(),
    // AUTH-013: optional; by default derived from SQ_HUB_APPLICATION_ACCESS_URL (.../check -> .../launcher).
    SQ_HUB_APPLICATION_LAUNCHER_URL: z.preprocess(
      (value) => value === "" ? undefined : value,
      z.string().url().optional(),
    ),
    SQ_HUB_MACHINE_CLIENT_ID: z.string().trim().min(1).optional(),
    SQ_HUB_MACHINE_CLIENT_SECRET: z.string().min(1).optional(),
    ORG_DIRECTORY_EXPORT_ENABLED: z.enum(["0", "1"]).default("0"),
    ORG_DIRECTORY_TOKEN_ISSUER: z.preprocess(
      (value) => value === "" ? undefined : value,
      z.string().url().optional(),
    ),
    ORG_DIRECTORY_TOKEN_AUDIENCE: z.preprocess(
      (value) => value === "" ? undefined : value,
      z.string().trim().min(1).optional(),
    ),
    ORG_DIRECTORY_ALLOWED_CLIENTS: z.preprocess(
      (value) => value === "" ? undefined : value,
      z.string().trim().min(1).optional(),
    ),
    ORG_DIRECTORY_REQUIRED_SCOPE: z.string().trim().min(1).default("organization-directory.read"),
    // AUTH-014 F4 (§2.2): the SQ Hub role-administration channel. Ships switched off; F5 turns it
    // on only after SQ Hub and Keycloak are ready. The machine client is deliberately NOT the one
    // that holds manage-users, so one leaked secret does not open both.
    HCIS_ROLE_ADMIN_ENABLED: z.enum(["0", "1"]).default("0"),
    HCIS_ROLE_ADMIN_TOKEN_ISSUER: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
    HCIS_ROLE_ADMIN_TOKEN_AUDIENCE: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).optional()),
    HCIS_ROLE_ADMIN_ALLOWED_CLIENTS: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).optional()),
    HCIS_ROLE_ADMIN_ACTOR_AUDIENCE: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).optional()),
    // §2.2: one click in the Hub. Short, because the assertion is a bearer: anyone who captures
    // one can act in that person name until it ages out (see the gap recorded in §2.11).
    HCIS_ROLE_ADMIN_ACTOR_MAX_AGE_SECONDS: z.coerce.number().int().min(30).max(300).default(60),
    STAFF_IDENTITY_VERIFY_ENABLED: z.enum(["0", "1"]).default("0"),
    STAFF_IDENTITY_TOKEN_ISSUER: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
    STAFF_IDENTITY_TOKEN_AUDIENCE: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).optional()),
    STAFF_IDENTITY_ALLOWED_CLIENTS: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).optional()),
    // ORG-010 §9: off by default; enabling it in production needs owner approval.
    GOVERNANCE_SUMMARY_ENABLED: z.enum(["true", "false", "1", "0"]).default("false"),
    GOVERNANCE_SUMMARY_AUDIENCE: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).optional()),
    GOVERNANCE_SUMMARY_ALLOWED_CLIENTS: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).optional()),
    GOVERNANCE_SUMMARY_APPLICATION_KEY: z.preprocess(
      (value) => value === "" ? undefined : value,
      z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
    ),
  })
  .superRefine((value, ctx) => {
    const biometricKeyringRequested =
      value.BIOMETRIC_COLLECTION_ENABLED === "1" ||
      value.MOBILE_ATTENDANCE_ENABLED === "1" ||
      Boolean(value.BIOMETRIC_ACTIVE_KEY_ID) ||
      Boolean(value.BIOMETRIC_ENCRYPTION_KEYS);

    if (biometricKeyringRequested) {
      if (!value.BIOMETRIC_ACTIVE_KEY_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["BIOMETRIC_ACTIVE_KEY_ID"],
          message: "BIOMETRIC_ACTIVE_KEY_ID is required when biometric keyring maintenance or collection is configured",
        });
      }
      if (!value.BIOMETRIC_ENCRYPTION_KEYS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["BIOMETRIC_ENCRYPTION_KEYS"],
          message: "BIOMETRIC_ENCRYPTION_KEYS is required when biometric keyring maintenance or collection is configured",
        });
      } else {
        try {
          const parsed = JSON.parse(value.BIOMETRIC_ENCRYPTION_KEYS) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not-object");
          const entries = Object.entries(parsed as Record<string, unknown>);
          if (entries.length === 0) throw new Error("empty");
          for (const [keyId, keyHex] of entries) {
            if (!/^[A-Za-z0-9._-]{1,80}$/.test(keyId)) throw new Error("key-id");
            if (typeof keyHex !== "string" || !/^[a-fA-F0-9]{64}$/.test(keyHex)) throw new Error("key-value");
          }
          if (value.BIOMETRIC_ACTIVE_KEY_ID && !(value.BIOMETRIC_ACTIVE_KEY_ID in parsed)) {
            throw new Error("active-key-missing");
          }
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["BIOMETRIC_ENCRYPTION_KEYS"],
            message: "BIOMETRIC_ENCRYPTION_KEYS must be a non-empty JSON keyring containing the active 32-byte hex key",
          });
        }
      }
    }

    if (value.ORG_DIRECTORY_EXPORT_ENABLED === "1") {
      const directoryRequired = [
        "ORG_DIRECTORY_TOKEN_ISSUER",
        "ORG_DIRECTORY_TOKEN_AUDIENCE",
        "ORG_DIRECTORY_ALLOWED_CLIENTS",
      ] as const;
      for (const key of directoryRequired) {
        if (value[key]) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when ORG_DIRECTORY_EXPORT_ENABLED=1`,
        });
      }
    }

    if (value.HCIS_ROLE_ADMIN_ENABLED === "1") {
      for (const key of [
        "HCIS_ROLE_ADMIN_TOKEN_ISSUER", "HCIS_ROLE_ADMIN_TOKEN_AUDIENCE",
        "HCIS_ROLE_ADMIN_ALLOWED_CLIENTS", "HCIS_ROLE_ADMIN_ACTOR_AUDIENCE",
      ] as const) {
        if (value[key]) continue;
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required when HCIS_ROLE_ADMIN_ENABLED=1` });
      }
      // ADR-0006 R-1 point 1: role granting and Keycloak user management live on different machine
      // accounts on purpose. Naming the same client for both would undo that separation silently.
      const clients = (value.HCIS_ROLE_ADMIN_ALLOWED_CLIENTS ?? "").split(",").map((item) => item.trim());
      if (clients.includes("sq-hub-identity-management")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["HCIS_ROLE_ADMIN_ALLOWED_CLIENTS"],
          message: "sq-hub-identity-management holds manage-users and must not also grant roles (AUTH-014 §2.2)",
        });
      }
      // §2.4 step 4b re-checks SQ Hub Application Access, which needs the OIDC machine client.
      // Without it the channel would crash on first use instead of refusing to start.
      if (value.AUTH_MODE !== "oidc") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["HCIS_ROLE_ADMIN_ENABLED"],
          message: "HCIS_ROLE_ADMIN_ENABLED=1 requires AUTH_MODE=oidc (the channel re-checks SQ Hub Application Access)",
        });
      }
      for (const key of ["SQ_HUB_APPLICATION_ACCESS_URL", "SQ_HUB_MACHINE_CLIENT_ID", "SQ_HUB_MACHINE_CLIENT_SECRET"] as const) {
        if (value[key]) continue;
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required when HCIS_ROLE_ADMIN_ENABLED=1` });
      }
      // The actor assertion must be a different audience from the machine token, or a machine token
      // would verify as an actor assertion.
      if (value.HCIS_ROLE_ADMIN_ACTOR_AUDIENCE
        && value.HCIS_ROLE_ADMIN_ACTOR_AUDIENCE === value.HCIS_ROLE_ADMIN_TOKEN_AUDIENCE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["HCIS_ROLE_ADMIN_ACTOR_AUDIENCE"],
          message: "HCIS_ROLE_ADMIN_ACTOR_AUDIENCE must differ from HCIS_ROLE_ADMIN_TOKEN_AUDIENCE",
        });
      }
    }

    if (value.STAFF_IDENTITY_VERIFY_ENABLED === "1") {
      for (const key of ["STAFF_IDENTITY_TOKEN_ISSUER", "STAFF_IDENTITY_TOKEN_AUDIENCE", "STAFF_IDENTITY_ALLOWED_CLIENTS"] as const) {
        if (value[key]) continue;
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required when STAFF_IDENTITY_VERIFY_ENABLED=1` });
      }
    }

    // ORG-010 §3.4: the governance audience must never equal a machine-token audience.
    if (value.GOVERNANCE_SUMMARY_AUDIENCE) {
      for (const key of ["ORG_DIRECTORY_TOKEN_AUDIENCE", "STAFF_IDENTITY_TOKEN_AUDIENCE"] as const) {
        if (value[key] !== value.GOVERNANCE_SUMMARY_AUDIENCE) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["GOVERNANCE_SUMMARY_AUDIENCE"],
          message: `GOVERNANCE_SUMMARY_AUDIENCE must differ from ${key}`,
        });
      }
    }

    if (isGovernanceSummaryEnabled(value)) {
      for (const key of [
        "GOVERNANCE_SUMMARY_AUDIENCE",
        "GOVERNANCE_SUMMARY_ALLOWED_CLIENTS",
        "GOVERNANCE_SUMMARY_APPLICATION_KEY",
      ] as const) {
        if (value[key]) continue;
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required when GOVERNANCE_SUMMARY_ENABLED=true` });
      }
      // Issuer, identity mapping, Application Access (D3) and the public origin come from the OIDC login config.
      if (value.AUTH_MODE !== "oidc") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["GOVERNANCE_SUMMARY_ENABLED"],
          message: "GOVERNANCE_SUMMARY_ENABLED=true requires AUTH_MODE=oidc",
        });
      }
    }

    if (value.AUTH_MODE !== "oidc") return;

    if (value.AUTH_SESSION_TTL_HOURS > 12) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_SESSION_TTL_HOURS"],
        message: "OIDC HCIS session lifetime must not exceed the 12-hour SSO maximum",
      });
    }

    const required = [
      "OIDC_ISSUER",
      "OIDC_CLIENT_ID",
      "OIDC_CLIENT_SECRET",
      "OIDC_REDIRECT_URI",
      "OIDC_POST_LOGOUT_REDIRECT_URI",
      "SQ_HUB_APPLICATION_ACCESS_URL",
      "SQ_HUB_MACHINE_CLIENT_ID",
      "SQ_HUB_MACHINE_CLIENT_SECRET",
    ] as const;

    for (const key of required) {
      if (value[key]) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required when AUTH_MODE=oidc`,
      });
    }
  });

export type ApiConfig = z.infer<typeof envSchema>;

export function isGovernanceSummaryEnabled(config: { GOVERNANCE_SUMMARY_ENABLED?: string | undefined }): boolean {
  return config.GOVERNANCE_SUMMARY_ENABLED === "true" || config.GOVERNANCE_SUMMARY_ENABLED === "1";
}

export interface OidcRuntimeConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  applicationAccessUrl: string;
  /** AUTH-013 launcher endpoint; null when it cannot be derived and no override is set. */
  applicationLauncherUrl: string | null;
  machineClientId: string;
  machineClientSecret: string;
}

export function getOidcRuntimeConfig(config: ApiConfig): OidcRuntimeConfig {
  if (
    config.AUTH_MODE !== "oidc" ||
    !config.OIDC_ISSUER ||
    !config.OIDC_CLIENT_ID ||
    !config.OIDC_CLIENT_SECRET ||
    !config.OIDC_REDIRECT_URI ||
    !config.OIDC_POST_LOGOUT_REDIRECT_URI ||
    !config.SQ_HUB_APPLICATION_ACCESS_URL ||
    !config.SQ_HUB_MACHINE_CLIENT_ID ||
    !config.SQ_HUB_MACHINE_CLIENT_SECRET
  ) {
    throw new Error("OIDC runtime configuration is incomplete");
  }

  return {
    issuer: config.OIDC_ISSUER.replace(/\/$/, ""),
    clientId: config.OIDC_CLIENT_ID,
    clientSecret: config.OIDC_CLIENT_SECRET,
    redirectUri: config.OIDC_REDIRECT_URI,
    postLogoutRedirectUri: config.OIDC_POST_LOGOUT_REDIRECT_URI,
    applicationAccessUrl: config.SQ_HUB_APPLICATION_ACCESS_URL,
    applicationLauncherUrl: deriveLauncherUrl(
      config.SQ_HUB_APPLICATION_ACCESS_URL,
      config.SQ_HUB_APPLICATION_LAUNCHER_URL,
    ),
    machineClientId: config.SQ_HUB_MACHINE_CLIENT_ID,
    machineClientSecret: config.SQ_HUB_MACHINE_CLIENT_SECRET,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  // SEC-15: the code default is local login; production must state its mode instead of inheriting it.
  if (env.NODE_ENV === "production" && !env.AUTH_MODE) {
    throw new Error("AUTH_MODE must be set explicitly when NODE_ENV=production");
  }
  return envSchema.parse(env);
}
