import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  activateInvitedAccountOnSignIn,
  ActivationInvitationService,
  invitationMessage,
  closeOpenInvitations,
  type InvitationWhatsApp,
} from "../src/modules/auth/activation-invitation.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import {
  StaffActivationRejectedError,
  StaffActivationUnavailableError,
  type StaffActivationInviteResult,
  type StaffActivationInviter,
} from "../src/modules/auth/sq-hub-staff-activation.js";
import type { WhatsAppMessage, WhatsAppSender } from "../src/modules/meetings/whatsapp.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

const ISSUER = "https://login.example.test/realms/sq-staff";

// AUTH-002-INVITE against the real schema. Synthetic rows only; every row this file creates is
// removed after each test (the service opens its own transactions, so no outer rollback).
describe.skipIf(!allowed)("AUTH-002-INVITE activation invitation (PostgreSQL)", () => {
  let pool: Pool;
  let actor: AuthPrincipal;
  let accountId: string;
  let employeeId: string;
  let employeeNumber: string;
  const created = { accounts: [] as string[], employees: [] as string[] };

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 4 }); });
  afterAll(async () => { await pool?.end(); });

  async function insertEmployee(input: { phone?: string | null; email?: string | null; status?: string } = {}) {
    const id = randomUUID();
    const number = `INV${id.slice(0, 8)}`;
    await pool.query(
      `INSERT INTO employees (id, employee_number, full_name, status, email, phone)
       VALUES ($1, $2, 'Pegawai Sintetis', $3, $4, $5)`,
      [id, number, input.status ?? "active", input.email === undefined ? `${number.toLowerCase()}@example.test` : input.email,
        input.phone === undefined ? "0812-3456-7890" : input.phone],
    );
    created.employees.push(id);
    return { id, number };
  }

  async function insertAccount(employee: string | null, principalType = "EMPLOYEE", status = "invited") {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO accounts (id, employee_id, email, principal_type, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, employee, `acc-${id}@example.test`, principalType, status],
    );
    created.accounts.push(id);
    return id;
  }

  beforeEach(async () => {
    const adminId = randomUUID();
    await pool.query(
      `INSERT INTO accounts (
         id, email, principal_type, status, password_hash, password_changed_at,
         mfa_secret_ciphertext, mfa_secret_iv, mfa_secret_tag, mfa_enabled_at
       ) VALUES ($1, $2, 'SUPER_ADMIN', 'active', 'synthetic-hash', now(),
                 'synthetic-ciphertext', 'synthetic-iv', 'synthetic-tag', now())`,
      [adminId, `invite-admin-${adminId}@example.test`],
    );
    created.accounts.push(adminId);
    actor = { id: adminId, email: `invite-admin-${adminId}@example.test`, principalType: "SUPER_ADMIN" };
    const employee = await insertEmployee();
    employeeId = employee.id;
    employeeNumber = employee.number;
    accountId = await insertAccount(employeeId);
  });

  afterEach(async () => {
    const ids = created.accounts.splice(0);
    await pool.query("DELETE FROM access_audit_events WHERE actor_account_id = ANY($1::uuid[]) OR entity_id = ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM auth_audit_events WHERE account_id = ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM account_activation_invitations WHERE account_id = ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM employees WHERE id = ANY($1::uuid[])", [created.employees.splice(0)]);
  });

  function inviter(result?: Partial<StaffActivationInviteResult> | Error, during?: () => Promise<void>) {
    const calls: Array<{ employeeNumber: string; accountId: string }> = [];
    const value: StaffActivationInviter = {
      invite: async (input) => {
        calls.push(input);
        // No HCIS transaction may be open on this account while SQ Hub works.
        const lock = await pool.query("SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE NOWAIT", [input.accountId]);
        expect(lock.rowCount).toBe(1);
        if (during) await during();
        if (result instanceof Error) throw result;
        return {
          identity: { issuer: ISSUER, subject: `kc-${input.accountId}` },
          employeeId: `hcis:employee:${employeeId}`,
          credentialInitialization: "sent",
          applicationAccess: "granted",
          ...result,
        };
      },
    };
    return { value, calls };
  }

  function whatsapp(options: { name?: "log" | "kirim"; allowlist?: ReadonlySet<string> | null; fail?: boolean } = {}) {
    const sent: WhatsAppMessage[] = [];
    const sender: WhatsAppSender = {
      name: options.name ?? "kirim",
      send: async (message) => {
        if (options.fail) throw new Error("unexpected");
        sent.push(message);
        return { id: "kirim-1", dryRun: options.name === "log" };
      },
    };
    const config: InvitationWhatsApp = {
      sender,
      allowlist: options.allowlist === undefined ? null : options.allowlist,
      origin: "https://hcis.example.test",
    };
    return { config, sent };
  }

  async function account() {
    return (await pool.query<{ status: string; identityIssuer: string | null; identitySubject: string | null }>(
      `SELECT status, identity_issuer AS "identityIssuer", identity_subject AS "identitySubject" FROM accounts WHERE id = $1`,
      [accountId],
    )).rows[0]!;
  }

  async function audits(action: string) {
    return (await pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM access_audit_events WHERE entity_id = $1 AND action = $2",
      [accountId, action],
    )).rows.map((row) => row.payload);
  }

  it("maps the exact identity, records the send, and sends a WhatsApp notice without secrets", async () => {
    const hub = inviter();
    const wa = whatsapp();
    const result = await new ActivationInvitationService(pool, hub.value, wa.config, ISSUER).send(accountId, actor);

    expect(hub.calls).toEqual([{ employeeNumber, accountId }]);
    expect(result).toMatchObject({ emailStatus: "sent", whatsappStatus: "sent", hubAccess: "granted", emailLinkHours: 12 });
    expect(result.maskedEmail).toMatch(/^in\*+@example\.test$/);
    expect(result.maskedPhone).toBe("+62812•••••890");
    expect(await account()).toEqual({ status: "invited", identityIssuer: ISSUER, identitySubject: `kc-${accountId}` });

    expect(wa.sent).toHaveLength(1);
    expect(wa.sent[0]!.to).toBe("+6281234567890");
    expect(wa.sent[0]!.ref).toBe(`auth:activation-invitation:${result.invitationId}`);
    expect(wa.sent[0]!.text).toContain("https://hcis.example.test");
    expect(wa.sent[0]!.text).toContain(result.maskedEmail);
    expect(wa.sent[0]!.text).not.toContain(`${employeeNumber.toLowerCase()}@example.test`);
    expect(wa.sent[0]!.text).not.toMatch(/token|action-token|key=/i);

    const issued = await audits("account.activation.invitation.issued");
    expect(issued).toHaveLength(1);
    expect(JSON.stringify(issued)).not.toMatch(/@|kc-|0812|INV/);
    expect((await audits("account.activation.invitation.whatsapp"))[0]).toMatchObject({ whatsappStatus: "sent" });
  });

  it("honours the WhatsApp allowlist and reports a missing phone", async () => {
    const blocked = whatsapp({ allowlist: new Set(["SOMEONE-ELSE"]) });
    const first = await new ActivationInvitationService(pool, inviter().value, blocked.config, ISSUER).send(accountId, actor);
    expect(first.whatsappStatus).toBe("not_allowlisted");
    expect(blocked.sent).toEqual([]);

    const noPhone = await insertEmployee({ phone: null });
    employeeId = noPhone.id;
    accountId = await insertAccount(noPhone.id);
    const wa = whatsapp();
    const second = await new ActivationInvitationService(pool, inviter().value, wa.config, ISSUER).send(accountId, actor);
    expect(second).toMatchObject({ emailStatus: "sent", whatsappStatus: "no_phone", maskedPhone: null });
    expect(wa.sent).toEqual([]);
  });

  it("reports dry runs from the log adapter and skips WhatsApp when the e-mail failed", async () => {
    const log = whatsapp({ name: "log" });
    const dry = await new ActivationInvitationService(pool, inviter().value, log.config, ISSUER).send(accountId, actor);
    expect(dry.whatsappStatus).toBe("dry_run");

    const other = await insertEmployee();
    employeeId = other.id;
    accountId = await insertAccount(other.id);
    const wa = whatsapp();
    const failed = await new ActivationInvitationService(
      pool, inviter({ credentialInitialization: "required_action_pending" }).value, wa.config, ISSUER,
    ).send(accountId, actor);
    expect(failed).toMatchObject({ emailStatus: "failed", whatsappStatus: "skipped" });
    expect(wa.sent).toEqual([]);
  });

  it("tells an existing Akun SQ holder to sign in instead of opening an e-mail", async () => {
    const wa = whatsapp();
    const result = await new ActivationInvitationService(
      pool, inviter({ credentialInitialization: "already_complete", applicationAccess: "already_active" }).value, wa.config, ISSUER,
    ).send(accountId, actor);
    expect(result).toMatchObject({ emailStatus: "not_needed", whatsappStatus: "sent", hubAccess: "already_active" });
    expect(wa.sent[0]!.text).toContain("Akun SQ Anda");
    expect(wa.sent[0]!.text).not.toContain("Buka email");
  });

  it("refuses before SQ Hub when preconditions fail", async () => {
    const hub = inviter();
    const service = new ActivationInvitationService(pool, hub.value, whatsapp().config, ISSUER);

    const noEmail = await insertEmployee({ email: null });
    const noEmailAccount = await insertAccount(noEmail.id);
    await expect(service.send(noEmailAccount, actor)).rejects.toMatchObject({ code: "EMPLOYEE_EMAIL_MISSING", statusCode: 409 });

    const activeAccount = await insertAccount((await insertEmployee()).id, "EMPLOYEE", "active");
    await expect(service.send(activeAccount, actor)).rejects.toMatchObject({ code: "ACCOUNT_NOT_INVITED" });

    const resigned = await insertEmployee({ status: "resigned" });
    await expect(service.send(await insertAccount(resigned.id), actor)).rejects.toMatchObject({ code: "EMPLOYEE_NOT_ACTIVE" });

    const board = await insertAccount(null, "FOUNDATION_BOARD");
    await expect(service.send(board, actor)).rejects.toMatchObject({ code: "ACTIVATION_INVITE_EMPLOYEE_ONLY" });

    await expect(service.send(actor.id, actor)).rejects.toMatchObject({ statusCode: 403 });
    expect(hub.calls).toEqual([]);

    const unavailable = new ActivationInvitationService(pool, null, whatsapp().config, undefined);
    await expect(unavailable.send(accountId, actor)).rejects.toMatchObject({ code: "ACTIVATION_INVITE_UNAVAILABLE" });
  });

  it("rate-limits resends per account", async () => {
    const service = new ActivationInvitationService(pool, inviter().value, whatsapp().config, ISSUER);
    await service.send(accountId, actor);
    await expect(service.send(accountId, actor)).rejects.toMatchObject({ code: "ACTIVATION_INVITE_RATE_LIMITED", statusCode: 429 });

    await pool.query("UPDATE account_activation_invitations SET created_at = now() - interval '11 minutes' WHERE account_id = $1", [accountId]);
    await service.send(accountId, actor);
    await pool.query(
      `INSERT INTO account_activation_invitations
         (id, account_id, state, created_at)
       SELECT gen_random_uuid(), $1, 'failed', now() - interval '20 minutes'
         FROM generate_series(1, 3)`,
      [accountId],
    );
    await pool.query("UPDATE account_activation_invitations SET created_at = now() - interval '11 minutes' WHERE account_id = $1 AND created_at > now() - interval '1 minute'", [accountId]);
    await expect(service.send(accountId, actor)).rejects.toMatchObject({ code: "ACTIVATION_INVITE_RATE_LIMITED" });
  });

  it("rejects an answer for another realm or another employee, writing nothing", async () => {
    const wrongIssuer = new ActivationInvitationService(
      pool, inviter({ identity: { issuer: "https://evil.example.test/realms/x", subject: "s" } }).value, whatsapp().config, ISSUER,
    );
    await expect(wrongIssuer.send(accountId, actor)).rejects.toMatchObject({ code: "SQ_HUB_ISSUER_MISMATCH" });
    // A failed attempt that reached SQ Hub still counts for the resend limit.
    await expect(wrongIssuer.send(accountId, actor)).rejects.toMatchObject({ code: "ACTIVATION_INVITE_RATE_LIMITED" });
    await pool.query("UPDATE account_activation_invitations SET created_at = now() - interval '11 minutes' WHERE account_id = $1", [accountId]);
    const wrongEmployee = new ActivationInvitationService(
      pool, inviter({ employeeId: `hcis:employee:${randomUUID()}` }).value, whatsapp().config, ISSUER,
    );
    await expect(wrongEmployee.send(accountId, actor)).rejects.toMatchObject({ code: "SQ_HUB_EMPLOYEE_MISMATCH" });
    expect(await account()).toMatchObject({ identityIssuer: null, identitySubject: null });
    const attempts = await pool.query<{ state: string; failureCode: string }>(
      `SELECT state, failure_code AS "failureCode" FROM account_activation_invitations WHERE account_id = $1 ORDER BY failure_code`,
      [accountId],
    );
    expect(attempts.rows).toEqual([
      { state: "failed", failureCode: "SQ_HUB_EMPLOYEE_MISMATCH" },
      { state: "failed", failureCode: "SQ_HUB_ISSUER_MISMATCH" },
    ]);
    expect((await audits("account.activation.invitation.failed")).map((payload) => payload.code).sort()).toEqual([
      "ACTIVATION_INVITE_RATE_LIMITED", "SQ_HUB_EMPLOYEE_MISMATCH", "SQ_HUB_ISSUER_MISMATCH",
    ]);
  });

  it("refuses an identity already mapped to another account", async () => {
    const other = await insertAccount((await insertEmployee()).id);
    await pool.query("UPDATE accounts SET identity_issuer = $2, identity_subject = $3 WHERE id = $1", [other, ISSUER, `kc-${accountId}`]);
    const wa = whatsapp();
    await expect(new ActivationInvitationService(pool, inviter().value, wa.config, ISSUER).send(accountId, actor))
      .rejects.toMatchObject({ code: "AKUN_SQ_ALREADY_MAPPED" });
    expect(wa.sent).toEqual([]);
  });

  it("maps SQ Hub refusals and outages to HC-readable codes", async () => {
    const refused = new ActivationInvitationService(
      pool, inviter(new StaffActivationRejectedError(409, "STAFF_IDENTITY_DISABLED")).value, whatsapp().config, ISSUER,
    );
    await expect(refused.send(accountId, actor)).rejects.toMatchObject({ code: "STAFF_IDENTITY_DISABLED", statusCode: 409 });
    await pool.query("UPDATE account_activation_invitations SET created_at = now() - interval '11 minutes' WHERE account_id = $1", [accountId]);
    const down = new ActivationInvitationService(
      pool, inviter(new StaffActivationUnavailableError("network")).value, whatsapp().config, ISSUER,
    );
    await expect(down.send(accountId, actor)).rejects.toMatchObject({ code: "SQ_HUB_UNAVAILABLE", statusCode: 503 });
  });

  it("activates on the first sign-in of the invited identity only", async () => {
    await new ActivationInvitationService(pool, inviter().value, whatsapp().config, ISSUER).send(accountId, actor);
    const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };

    expect(await activateInvitedAccountOnSignIn(pool, { accountId, issuer: ISSUER, subject: "someone-else", ...context })).toBe(false);
    expect((await account()).status).toBe("invited");

    expect(await activateInvitedAccountOnSignIn(pool, { accountId, issuer: ISSUER, subject: `kc-${accountId}`, ...context })).toBe(true);
    expect((await account()).status).toBe("active");
    const open = await pool.query("SELECT 1 FROM account_activation_invitations WHERE account_id = $1 AND completed_at IS NULL", [accountId]);
    expect(open.rowCount).toBe(0);
    const audit = await pool.query("SELECT 1 FROM auth_audit_events WHERE account_id = $1 AND event_type = 'auth.activation.invitation_completed'", [accountId]);
    expect(audit.rowCount).toBe(1);
    // A second call finds nothing to activate.
    expect(await activateInvitedAccountOnSignIn(pool, { accountId, issuer: ISSUER, subject: `kc-${accountId}`, ...context })).toBe(false);
  });

  it("does not activate after the invitation is revoked or the employee left", async () => {
    await new ActivationInvitationService(pool, inviter().value, whatsapp().config, ISSUER).send(accountId, actor);
    const context = { ipAddress: null, userAgent: null };
    expect(await closeOpenInvitations(pool, accountId, "suspended")).toBe(1);
    expect(await activateInvitedAccountOnSignIn(pool, { accountId, issuer: ISSUER, subject: `kc-${accountId}`, ...context })).toBe(false);

    await pool.query("UPDATE account_activation_invitations SET revoked_at = NULL WHERE account_id = $1", [accountId]);
    await pool.query("UPDATE account_activation_invitations SET created_at = now() - interval '15 days' WHERE account_id = $1", [accountId]);
    expect(await activateInvitedAccountOnSignIn(pool, { accountId, issuer: ISSUER, subject: `kc-${accountId}`, ...context })).toBe(false);
    await pool.query("UPDATE account_activation_invitations SET created_at = now() WHERE account_id = $1", [accountId]);
    await pool.query("UPDATE employees SET status = 'resigned' WHERE id = $1", [employeeId]);
    expect(await activateInvitedAccountOnSignIn(pool, { accountId, issuer: ISSUER, subject: `kc-${accountId}`, ...context })).toBe(false);
    expect((await account()).status).toBe("invited");
  });

  it("skips WhatsApp when HCIS access is revoked at SQ Hub", async () => {
    const wa = whatsapp();
    const result = await new ActivationInvitationService(
      pool, inviter({ applicationAccess: "revoked" }).value, wa.config, ISSUER,
    ).send(accountId, actor);
    expect(result).toMatchObject({ hubAccess: "revoked", whatsappStatus: "skipped" });
    expect(wa.sent).toEqual([]);
  });

  it("re-checks the account after SQ Hub answers", async () => {
    const wa = whatsapp();
    const hub = inviter(undefined, async () => {
      await pool.query("UPDATE accounts SET status = 'suspended' WHERE id = $1", [accountId]);
    });
    await expect(new ActivationInvitationService(pool, hub.value, wa.config, ISSUER).send(accountId, actor))
      .rejects.toMatchObject({ code: "ACCOUNT_NOT_INVITED" });
    expect(await account()).toMatchObject({ status: "suspended", identityIssuer: null });
    expect(wa.sent).toEqual([]);
  });

  it("closes open invitations on a status change", async () => {
    await new ActivationInvitationService(pool, inviter().value, whatsapp().config, ISSUER).send(accountId, actor);
    expect(await closeOpenInvitations(pool, accountId, "active")).toBe(1);
    const row = (await pool.query<{ completed: boolean; revoked: boolean }>(
      `SELECT completed_at IS NOT NULL AS completed, revoked_at IS NOT NULL AS revoked
         FROM account_activation_invitations WHERE account_id = $1`, [accountId],
    )).rows[0];
    expect(row).toEqual({ completed: true, revoked: false });
  });
});

describe("AUTH-002-INVITE WhatsApp text", () => {
  it("carries no link other than the HCIS address", () => {
    const text = invitationMessage({
      fullName: "Pegawai Sintetis",
      employeeNumber: "INV-1",
      maskedEmail: "pe***@example.test",
      emailStatus: "sent",
      origin: "https://hcis.example.test",
    });
    expect(text.match(/https?:\/\/\S+/g)).toEqual(["https://hcis.example.test"]);
    expect(text).toContain("12 jam");
  });
});
