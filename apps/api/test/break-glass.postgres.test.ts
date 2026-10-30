import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  BreakGlassError,
  rotateBreakGlassCredential,
  setBreakGlassStatus,
} from "../src/modules/auth/break-glass.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

// A 32-byte hex key; synthetic, used only to exercise encryptSecret inside the transaction.
const ENCRYPTION_KEY = "0".repeat(64);

// AUTH-014 F1 (§3.2): the break-glass account's own tooling, against the real schema.
// Synthetic rows only, inside one transaction that is always rolled back.
describe.skipIf(!allowed)("AUTH-014 break-glass account operations (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;
  let superAdminId: string;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  async function insertSuperAdmin(status = "active"): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO accounts (id, email, principal_type, status, password_hash, password_changed_at)
       VALUES ($1, $2, 'SUPER_ADMIN', $3, 'synthetic-hash', now())`,
      [id, `break-glass-${id}@example.test`, status],
    );
    return id;
  }

  async function statusOf(accountId: string): Promise<string> {
    const result = await client.query<{ status: string }>(
      "SELECT status FROM accounts WHERE id = $1", [accountId],
    );
    return result.rows[0]!.status;
  }

  async function auditCount(accountId: string, eventType: string): Promise<number> {
    const result = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM auth_audit_events WHERE account_id = $1 AND event_type = $2",
      [accountId, eventType],
    );
    return Number(result.rows[0]!.count);
  }

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    // Existing SUPER_ADMIN rows would make resolution ambiguous, so this transaction works with
    // exactly one. The rollback puts the real rows back.
    await client.query("DELETE FROM accounts WHERE principal_type = 'SUPER_ADMIN'");
    superAdminId = await insertSuperAdmin();
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  it("previews a deactivation without writing", async () => {
    const result = await setBreakGlassStatus(client, {
      status: "inactive", reason: "latihan break-glass", apply: false,
    });

    expect(result.status).toBe("would_change");
    expect(result.previousStatus).toBe("active");
    expect(await statusOf(superAdminId)).toBe("active");
    expect(await auditCount(superAdminId, "auth.break_glass.status_changed")).toBe(0);
  });

  it("deactivates, revokes live sessions and writes one audit event", async () => {
    const sessionId = randomUUID();
    await client.query(
      `INSERT INTO auth_sessions (id, account_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 day')`,
      [sessionId, superAdminId, "a".repeat(64)],
    );

    const result = await setBreakGlassStatus(client, {
      status: "inactive", reason: "SQ Hub tidak tersedia", apply: true,
    });

    expect(result.status).toBe("changed");
    expect(result.sessionsRevoked).toBe(1);
    expect(await statusOf(superAdminId)).toBe("inactive");
    expect(await auditCount(superAdminId, "auth.break_glass.status_changed")).toBe(1);

    const revoked = await client.query<{ revokedAt: string | null }>(
      `SELECT revoked_at AS "revokedAt" FROM auth_sessions WHERE id = $1`, [sessionId],
    );
    expect(revoked.rows[0]!.revokedAt).not.toBeNull();
  });

  it("reports an unchanged status without writing an audit event", async () => {
    const result = await setBreakGlassStatus(client, {
      status: "active", reason: "memastikan keadaan", apply: true,
    });

    expect(result.status).toBe("unchanged");
    expect(await auditCount(superAdminId, "auth.break_glass.status_changed")).toBe(0);
  });

  it("refuses an account that is not SUPER_ADMIN", async () => {
    const employeeAccount = await client.query<{ id: string }>(
      "SELECT id FROM accounts WHERE principal_type = 'EMPLOYEE' LIMIT 1",
    );
    const targetId = employeeAccount.rows[0]?.id ?? randomUUID();

    await expect(setBreakGlassStatus(client, {
      accountId: targetId, status: "inactive", reason: "percobaan salah sasaran", apply: true,
    })).rejects.toMatchObject({ code: "BREAK_GLASS_ACCOUNT_NOT_FOUND" });
  });

  it("refuses to guess when more than one SUPER_ADMIN exists", async () => {
    await insertSuperAdmin();

    await expect(setBreakGlassStatus(client, {
      status: "inactive", reason: "dua akun istimewa", apply: false,
    })).rejects.toBeInstanceOf(BreakGlassError);
    await expect(setBreakGlassStatus(client, {
      status: "inactive", reason: "dua akun istimewa", apply: false,
    })).rejects.toMatchObject({ code: "BREAK_GLASS_ACCOUNT_AMBIGUOUS" });
  });

  it("previews a credential rotation without touching the password or the codes", async () => {
    const before = await client.query<{ hash: string }>(
      `SELECT password_hash AS hash FROM accounts WHERE id = $1`, [superAdminId],
    );

    const result = await rotateBreakGlassCredential(client, {
      password: "", encryptionKey: ENCRYPTION_KEY, reason: "pratinjau rotasi", apply: false,
    });

    expect(result.status).toBe("would_rotate");
    expect(result.secrets).toBeUndefined();
    const after = await client.query<{ hash: string }>(
      `SELECT password_hash AS hash FROM accounts WHERE id = $1`, [superAdminId],
    );
    expect(after.rows[0]!.hash).toBe(before.rows[0]!.hash);
    expect(await auditCount(superAdminId, "auth.break_glass.credential_rotated")).toBe(0);
  });

  it("rotates password, TOTP and recovery codes together and revokes sessions", async () => {
    await client.query(
      `INSERT INTO auth_recovery_codes (id, account_id, code_hash) VALUES ($1, $2, $3)`,
      [randomUUID(), superAdminId, "stale-code-hash"],
    );
    await client.query(
      `INSERT INTO auth_sessions (id, account_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 day')`,
      [randomUUID(), superAdminId, "b".repeat(64)],
    );

    const result = await rotateBreakGlassCredential(client, {
      password: "kata-sandi-uji-yang-panjang",
      encryptionKey: ENCRYPTION_KEY,
      reason: "rotasi setelah pemakaian",
      apply: true,
    });

    expect(result.status).toBe("rotated");
    expect(result.sessionsRevoked).toBe(1);
    expect(result.secrets?.recoveryCodes.length).toBeGreaterThan(0);

    const account = await client.query<{ hash: string; ciphertext: string | null }>(
      `SELECT password_hash AS hash, mfa_secret_ciphertext AS ciphertext FROM accounts WHERE id = $1`,
      [superAdminId],
    );
    expect(account.rows[0]!.hash).not.toBe("synthetic-hash");
    expect(account.rows[0]!.ciphertext).not.toBeNull();

    const codes = await client.query<{ hash: string }>(
      `SELECT code_hash AS hash FROM auth_recovery_codes WHERE account_id = $1`, [superAdminId],
    );
    expect(codes.rows.map((row) => row.hash)).not.toContain("stale-code-hash");
    expect(codes.rowCount).toBe(result.secrets!.recoveryCodes.length);

    expect(await auditCount(superAdminId, "auth.break_glass.credential_rotated")).toBe(1);
  });
});
