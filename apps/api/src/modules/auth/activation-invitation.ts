// AUTH-002-INVITE (docs/domain/account-activation.md): "Kirim aktivasi" for an `invited` EMPLOYEE
// account in OIDC mode. SQ Hub prepares the Akun SQ and Keycloak e-mails the password link
// (HUB-IMPL-024); HCIS maps the exact identity SQ Hub returned for this employee and sends a
// WhatsApp notice without any secret. The account becomes `active` on its first Akun SQ sign-in.
import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import {
  maskWhatsAppNumber,
  normalizeWhatsAppNumber,
  type WhatsAppSender,
} from "../meetings/whatsapp.js";
import { maskActivationEmail } from "./account-activation.js";
import { OidcIdentityMappingError, OidcIdentityMappingService } from "./oidc-identity-mapping.js";
import { assertAccountManagementTarget } from "./role-assignment.js";
import { AuthError, type AuthPrincipal } from "./service.js";
import {
  StaffActivationRejectedError,
  StaffActivationUnavailableError,
  type StaffActivationInviter,
} from "./sq-hub-staff-activation.js";

/** DRAFT (AUTH-002-INVITE): at least 10 minutes between sends, at most 5 sends per 24 hours. */
export const INVITATION_COOLDOWN_MINUTES = 10;
export const INVITATION_DAILY_LIMIT = 5;
/** Keycloak execute-actions e-mail lifespan set by SQ Hub (HUB-IMPL-013): 43,200 s. */
export const INVITATION_EMAIL_LINK_HOURS = 12;
/** DRAFT (AUTH-002-INVITE): a first sign-in activates the account only within 14 days of the send. */
export const INVITATION_VALID_DAYS = 14;

export type InvitationEmailStatus = "sent" | "not_needed" | "failed";
export type InvitationWhatsAppStatus =
  | "pending" | "sent" | "dry_run" | "no_phone" | "not_allowlisted" | "failed" | "skipped";
export type InvitationHubAccess = "granted" | "already_active" | "revoked";

export interface InvitationResult {
  invitationId: string;
  emailStatus: InvitationEmailStatus;
  whatsappStatus: Exclude<InvitationWhatsAppStatus, "pending">;
  hubAccess: InvitationHubAccess;
  maskedEmail: string;
  maskedPhone: string | null;
  emailLinkHours: number;
}

export class ActivationInvitationError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ActivationInvitationError";
  }
}

export interface InvitationWhatsApp {
  sender: WhatsAppSender;
  /** null: every NIP may receive real WhatsApp (WHATSAPP_RECIPIENT_MODE=all). */
  allowlist: ReadonlySet<string> | null;
  device?: string | undefined;
  /** Public HCIS origin, e.g. https://hcis.sabilulquran.or.id. */
  origin: string | null;
}

interface AccountRow {
  id: string;
  principalType: "EMPLOYEE" | "FOUNDATION_BOARD" | "SUPER_ADMIN";
  status: "invited" | "active" | "suspended" | "inactive";
  employeeId: string | null;
  employeeNumber: string | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  employeeStatus: "active" | "inactive" | "resigned" | null;
}

const HUB_REFUSAL_MESSAGES: Record<string, string> = {
  HCIS_EMPLOYEE_NOT_FOUND: "SQ Hub tidak menemukan pegawai dengan NIP ini di HCIS.",
  HCIS_EMPLOYEE_NOT_ACTIVE: "SQ Hub membaca status pegawai ini tidak aktif.",
  HCIS_EMPLOYEE_INVALID_CONTACT: "Email pegawai belum terisi. Lengkapi email pegawai lalu kirim lagi.",
  EMPLOYEE_IDENTITY_CONFLICT:
    "Sudah ada Akun SQ dengan NIP ini tetapi milik data lain atau emailnya berbeda. Minta Admin Platform memeriksanya di SQ Hub.",
  DUPLICATE_USERNAME: "NIP ini sudah dipakai Akun SQ lain. Minta Admin Platform memeriksanya di SQ Hub.",
  DUPLICATE_EMAIL: "Email pegawai ini sudah dipakai Akun SQ lain. Periksa email pegawai atau minta Admin Platform memeriksanya.",
  STAFF_IDENTITY_DISABLED: "Akun SQ pegawai ini dinonaktifkan di SQ Hub. Admin Platform perlu mengaktifkannya kembali.",
  ORGAN_IDENTITY_LINK_REQUIRES_ADMIN:
    "Email pegawai ini dipakai Akun SQ Organ Yayasan. Menghubungkannya ke data pegawai dilakukan Admin Platform di SQ Hub.",
};

function refusal(code: string, message: string, statusCode = 409) {
  return new ActivationInvitationError(statusCode, code, message);
}

export function invitationMessage(input: {
  fullName: string;
  employeeNumber: string;
  maskedEmail: string;
  emailStatus: "sent" | "not_needed";
  origin: string | null;
}): string {
  const hcis = input.origin ?? "HCIS Yayasan Sabilul Qur'an";
  const greeting = `Assalamu'alaikum, ${input.fullName}.`;
  if (input.emailStatus === "not_needed") {
    return [
      greeting,
      "",
      "Akun HCIS Yayasan Sabilul Qur'an Anda sudah disiapkan.",
      `Silakan masuk ke HCIS di ${hcis} dengan Akun SQ Anda (NIP ${input.employeeNumber}).`,
      "",
      "Bila ada kendala, hubungi HC.",
    ].join("\n");
  }
  return [
    greeting,
    "",
    "Akun HCIS Yayasan Sabilul Qur'an Anda sudah disiapkan.",
    "",
    `1. Buka email dari Akun SQ yang dikirim ke ${input.maskedEmail}, lalu pilih tautan di dalamnya untuk membuat kata sandi. Tautan itu berlaku ${INVITATION_EMAIL_LINK_HOURS} jam.`,
    `2. Setelah itu masuk ke HCIS di ${hcis} dengan NIP ${input.employeeNumber} dan kata sandi baru Anda.`,
    "",
    "Email tidak masuk? Periksa folder Spam, atau minta HC mengirim ulang.",
  ].join("\n");
}

function assertInvitable(account: AccountRow) {
  if (account.principalType !== "EMPLOYEE") {
    throw refusal(
      "ACTIVATION_INVITE_EMPLOYEE_ONLY",
      "Kirim aktivasi hanya untuk account pegawai. Account Organ Yayasan memakai alur pemetaan Akun SQ.",
    );
  }
  if (account.status !== "invited") {
    throw refusal("ACCOUNT_NOT_INVITED", "Aktivasi hanya dapat dikirim untuk account yang masih berstatus Disiapkan.");
  }
  if (!account.employeeId || account.employeeStatus !== "active") {
    throw refusal("EMPLOYEE_NOT_ACTIVE", "Aktivasi hanya untuk pegawai yang masih aktif.");
  }
  if (!account.employeeNumber) {
    throw refusal("EMPLOYEE_NUMBER_MISSING", "NIP pegawai belum terisi. Akun SQ memakai NIP sebagai nama pengguna.");
  }
  if (!account.email) {
    throw refusal(
      "EMPLOYEE_EMAIL_MISSING",
      "Email pegawai belum terisi. Akun SQ membutuhkan email untuk membuat kata sandi; lengkapi email pegawai lalu kirim lagi.",
    );
  }
}

function failureCode(error: unknown): string {
  if (error instanceof ActivationInvitationError || error instanceof AuthError) return error.code;
  return "INTERNAL_ERROR";
}

export class ActivationInvitationService {
  constructor(
    private readonly pool: Pool,
    private readonly inviter: StaffActivationInviter | null,
    private readonly whatsapp: InvitationWhatsApp,
    private readonly configuredIssuer: string | undefined,
  ) {}

  async send(accountId: string, actor: AuthPrincipal): Promise<InvitationResult> {
    if (!this.inviter || !this.configuredIssuer) {
      throw refusal(
        "ACTIVATION_INVITE_UNAVAILABLE",
        "Kirim aktivasi hanya tersedia ketika HCIS memakai Akun SQ.",
      );
    }

    // Phase 1: check and record the attempt. Committed before SQ Hub is called, so no transaction
    // or row lock is held across the network call (SQ Hub calls back into HCIS-ID-001), and every
    // attempt that reaches SQ Hub counts for the rate limit even when a later step fails.
    let account: AccountRow;
    let attemptId: string;
    try {
      ({ account, attemptId } = await this.withTransaction(async (client) => {
        const row = await this.lockAccount(client, accountId);
        await assertAccountManagementTarget(client, actor, row.id);
        assertInvitable(row);
        await this.assertRateLimit(client, row.id);
        const id = randomUUID();
        await client.query(
          `INSERT INTO account_activation_invitations (id, account_id, issued_by_account_id, state)
           VALUES ($1, $2, $3, 'pending')`,
          [id, row.id, actor.id],
        );
        return { account: row, attemptId: id };
      }));
    } catch (error) {
      if (error instanceof ActivationInvitationError && error.code === "ACCOUNT_NOT_FOUND") throw error;
      await this.auditFailure(actor, accountId, failureCode(error));
      throw error;
    }

    let invitation: { emailStatus: InvitationEmailStatus; whatsappStatus: InvitationWhatsAppStatus; hubAccess: InvitationHubAccess };
    try {
      // Phase 2: SQ Hub prepares the Akun SQ (HUB-IMPL-024), with no HCIS transaction open.
      let hub;
      try {
        hub = await this.inviter.invite({ employeeNumber: account.employeeNumber!, accountId: account.id });
      } catch (error) {
        if (error instanceof StaffActivationRejectedError) {
          throw refusal(
            error.code in HUB_REFUSAL_MESSAGES ? error.code : "SQ_HUB_REFUSED",
            HUB_REFUSAL_MESSAGES[error.code] ?? "SQ Hub menolak permintaan aktivasi. Coba lagi atau hubungi Admin Platform.",
            error.status === 404 ? 404 : 409,
          );
        }
        if (error instanceof StaffActivationUnavailableError) {
          throw refusal("SQ_HUB_UNAVAILABLE", "SQ Hub sedang tidak dapat dihubungi. Coba lagi beberapa saat.", 503);
        }
        throw error;
      }

      // The identity must come from this realm and be linked to this exact employee.
      if (hub.identity.issuer.replace(/\/$/, "") !== this.configuredIssuer.replace(/\/$/, "")) {
        throw refusal("SQ_HUB_ISSUER_MISMATCH", "Jawaban SQ Hub memakai issuer lain. Aktivasi dibatalkan.", 502);
      }
      if (hub.employeeId.toLowerCase() !== `hcis:employee:${account.employeeId}`.toLowerCase()) {
        throw refusal("SQ_HUB_EMPLOYEE_MISMATCH", "Jawaban SQ Hub untuk pegawai lain. Aktivasi dibatalkan.", 502);
      }

      // Phase 3: re-check the account under lock (it may have changed meanwhile), map, finalize.
      invitation = await this.withTransaction(async (client) => {
        const current = await this.lockAccount(client, account.id);
        assertInvitable(current);
        if (current.employeeId !== account.employeeId || current.employeeNumber !== account.employeeNumber) {
          throw refusal("EMPLOYEE_CHANGED", "Data pegawai berubah saat aktivasi dikirim. Muat ulang lalu kirim lagi.");
        }
        try {
          await new OidcIdentityMappingService(client).map({
            accountId: current.id,
            issuer: hub.identity.issuer,
            subject: hub.identity.subject,
            apply: true,
            replace: false,
          });
        } catch (error) {
          if (error instanceof OidcIdentityMappingError) {
            throw refusal(
              error.code === "IDENTITY_ALREADY_ASSIGNED" ? "AKUN_SQ_ALREADY_MAPPED" : "ACCOUNT_MAPPED_TO_OTHER_AKUN_SQ",
              error.code === "IDENTITY_ALREADY_ASSIGNED"
                ? "Akun SQ pegawai ini sudah terhubung ke account HCIS lain."
                : "Account ini sudah terhubung ke Akun SQ lain. Pemetaan perlu diperiksa operator.",
            );
          }
          throw error;
        }

        const emailStatus: InvitationEmailStatus = hub.credentialInitialization === "sent"
          ? "sent"
          : hub.credentialInitialization === "already_complete" ? "not_needed" : "failed";
        const whatsappStatus = this.initialWhatsAppStatus(emailStatus, hub.applicationAccess, current);
        await client.query(
          `UPDATE account_activation_invitations
              SET state = 'issued', identity_issuer = $2, identity_subject = $3,
                  email_status = $4, whatsapp_status = $5, hub_access = $6
            WHERE id = $1`,
          [attemptId, hub.identity.issuer, hub.identity.subject, emailStatus, whatsappStatus, hub.applicationAccess],
        );
        await client.query(
          `INSERT INTO access_audit_events (id, actor_account_id, action, entity_type, entity_id, payload)
           VALUES ($1, $2, 'account.activation.invitation.issued', 'account', $3, $4::jsonb)`,
          [randomUUID(), actor.id, current.id, JSON.stringify({ invitationId: attemptId, emailStatus, whatsappStatus, hubAccess: hub.applicationAccess })],
        );
        account = current;
        return { emailStatus, whatsappStatus, hubAccess: hub.applicationAccess };
      });
    } catch (error) {
      const code = failureCode(error);
      await this.pool.query(
        `UPDATE account_activation_invitations SET state = 'failed', failure_code = $2 WHERE id = $1 AND state = 'pending'`,
        [attemptId, code],
      ).catch(() => undefined);
      await this.auditFailure(actor, account.id, code);
      throw error;
    }

    const maskedEmail = maskActivationEmail(account.email!);
    const phone = normalizeWhatsAppNumber(account.phone);
    let finalWhatsApp = invitation.whatsappStatus;
    if (finalWhatsApp === "pending") {
      finalWhatsApp = await this.sendWhatsApp(attemptId, phone!, {
        fullName: account.fullName ?? "Bapak/Ibu",
        employeeNumber: account.employeeNumber!,
        maskedEmail,
        emailStatus: invitation.emailStatus === "sent" ? "sent" : "not_needed",
        origin: this.whatsapp.origin,
      });
      await this.pool.query(
        `UPDATE account_activation_invitations
            SET whatsapp_status = $2, whatsapp_updated_at = now()
          WHERE id = $1`,
        [attemptId, finalWhatsApp],
      );
      await this.pool.query(
        `INSERT INTO access_audit_events (id, actor_account_id, action, entity_type, entity_id, payload)
         VALUES ($1, $2, 'account.activation.invitation.whatsapp', 'account', $3, $4::jsonb)`,
        [randomUUID(), actor.id, account.id, JSON.stringify({ invitationId: attemptId, whatsappStatus: finalWhatsApp })],
      );
    }

    return {
      invitationId: attemptId,
      emailStatus: invitation.emailStatus,
      whatsappStatus: finalWhatsApp as InvitationResult["whatsappStatus"],
      hubAccess: invitation.hubAccess,
      maskedEmail,
      maskedPhone: phone ? maskWhatsAppNumber(phone) : null,
      emailLinkHours: INVITATION_EMAIL_LINK_HOURS,
    };
  }

  private async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockAccount(client: PoolClient, accountId: string): Promise<AccountRow> {
    const row = (await client.query<AccountRow>(
      `SELECT a.id, a.principal_type AS "principalType", a.status,
              e.id AS "employeeId", e.employee_number AS "employeeNumber", e.full_name AS "fullName",
              e.email, e.phone, e.status AS "employeeStatus"
         FROM accounts a
         LEFT JOIN employees e ON e.id = a.employee_id
        WHERE a.id = $1
        FOR UPDATE OF a`,
      [accountId],
    )).rows[0];
    if (!row) throw refusal("ACCOUNT_NOT_FOUND", "Account tidak ditemukan.", 404);
    return row;
  }

  private initialWhatsAppStatus(
    emailStatus: InvitationEmailStatus,
    hubAccess: InvitationHubAccess,
    account: AccountRow,
  ): InvitationWhatsAppStatus {
    // Without the Keycloak e-mail, or with HCIS access revoked at SQ Hub, the notice would point at
    // something the employee cannot use.
    if (emailStatus === "failed" || hubAccess === "revoked") return "skipped";
    if (!normalizeWhatsAppNumber(account.phone)) return "no_phone";
    if (
      this.whatsapp.sender.name === "kirim"
      && this.whatsapp.allowlist
      && !(account.employeeNumber && this.whatsapp.allowlist.has(account.employeeNumber))
    ) {
      return "not_allowlisted";
    }
    return "pending";
  }

  private async sendWhatsApp(
    invitationId: string,
    to: string,
    message: Parameters<typeof invitationMessage>[0],
  ): Promise<"sent" | "dry_run" | "failed"> {
    try {
      const result = await this.whatsapp.sender.send({
        ...(this.whatsapp.device ? { device: this.whatsapp.device } : {}),
        to,
        text: invitationMessage(message),
        expiresAt: new Date(Date.now() + INVITATION_EMAIL_LINK_HOURS * 60 * 60 * 1000).toISOString(),
        ref: `auth:activation-invitation:${invitationId}`,
        idempotencyKey: `hcis-activation-invitation:${invitationId}`,
      });
      return result.dryRun ? "dry_run" : "sent";
    } catch {
      // Rejected, temporary or unexpected: HC sees "failed" and may send again after the cooldown.
      return "failed";
    }
  }

  private async assertRateLimit(client: PoolClient, accountId: string) {
    const recent = (await client.query<{ lastAt: Date | null; dayCount: number }>(
      `SELECT max(created_at) AS "lastAt",
              count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS "dayCount"
         FROM account_activation_invitations
        WHERE account_id = $1`,
      [accountId],
    )).rows[0];
    const cooldownMs = INVITATION_COOLDOWN_MINUTES * 60 * 1000;
    if (recent?.lastAt && Date.now() - recent.lastAt.getTime() < cooldownMs) {
      throw refusal(
        "ACTIVATION_INVITE_RATE_LIMITED",
        `Aktivasi untuk account ini baru saja dikirim. Tunggu ${INVITATION_COOLDOWN_MINUTES} menit sebelum mengirim ulang.`,
        429,
      );
    }
    if ((recent?.dayCount ?? 0) >= INVITATION_DAILY_LIMIT) {
      throw refusal(
        "ACTIVATION_INVITE_RATE_LIMITED",
        `Aktivasi untuk account ini sudah dikirim ${INVITATION_DAILY_LIMIT} kali dalam 24 jam. Coba lagi besok.`,
        429,
      );
    }
  }

  private async auditFailure(actor: AuthPrincipal, accountId: string, code: string) {
    await this.pool.query(
      `INSERT INTO access_audit_events (id, actor_account_id, action, entity_type, entity_id, payload)
       VALUES ($1, $2, 'account.activation.invitation.failed', 'account', $3, $4::jsonb)`,
      [randomUUID(), actor.id, accountId, JSON.stringify({ code })],
    ).catch(() => undefined);
  }
}

/**
 * AUTH-002-INVITE §5: on the first Akun SQ sign-in, an `invited` EMPLOYEE account with an open
 * invitation for this exact identity becomes `active`. Returns false when nothing qualifies.
 */
export async function activateInvitedAccountOnSignIn(
  pool: Pool,
  input: { accountId: string; issuer: string; subject: string; ipAddress: string | null; userAgent: string | null },
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const activated = await client.query<{ id: string; email: string }>(
      `UPDATE accounts a
          SET status = 'active', updated_at = now()
        WHERE a.id = $1
          AND a.status = 'invited'
          AND a.principal_type = 'EMPLOYEE'
          AND a.identity_issuer = $2
          AND a.identity_subject = $3
          AND EXISTS (SELECT 1 FROM employees e WHERE e.id = a.employee_id AND e.status = 'active')
          AND EXISTS (
            SELECT 1 FROM account_activation_invitations i
             WHERE i.account_id = a.id
               AND i.identity_issuer = $2
               AND i.identity_subject = $3
               AND i.state = 'issued'
               AND i.completed_at IS NULL
               AND i.revoked_at IS NULL
               AND i.created_at > now() - make_interval(days => $4)
          )
        RETURNING a.id, a.email`,
      [input.accountId, input.issuer, input.subject, INVITATION_VALID_DAYS],
    );
    const row = activated.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `UPDATE account_activation_invitations
          SET completed_at = now()
        WHERE account_id = $1 AND completed_at IS NULL AND revoked_at IS NULL`,
      [row.id],
    );
    await client.query(
      `INSERT INTO auth_audit_events (id, account_id, event_type, email, ip_address, user_agent)
       VALUES ($1, $2, 'auth.activation.invitation_completed', $3, $4, $5)`,
      [randomUUID(), row.id, row.email, input.ipAddress, input.userAgent],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * AUTH-002-INVITE: any status change closes open invitations, so a later sign-in can never
 * activate an account HC moved away from `invited` (completed when HC activated it by hand).
 */
export async function closeOpenInvitations(
  db: Pick<PoolClient, "query">,
  accountId: string,
  newStatus: "invited" | "active" | "suspended" | "inactive",
): Promise<number> {
  const result = await db.query(
    `UPDATE account_activation_invitations
        SET completed_at = CASE WHEN $2 = 'active' THEN now() ELSE NULL END,
            revoked_at = CASE WHEN $2 = 'active' THEN NULL ELSE now() END
      WHERE account_id = $1 AND completed_at IS NULL AND revoked_at IS NULL`,
    [accountId, newStatus],
  );
  return result.rowCount ?? 0;
}
