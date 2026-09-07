import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  AccountActivationService,
  assertActivationPassword,
  maskActivationEmail,
} from "../src/modules/auth/account-activation.js";

describe("account activation policy", () => {
  it("requires a password of at least 12 characters", () => {
    expect(() => assertActivationPassword("short-pass")).toThrowError(
      expect.objectContaining({ code: "ACTIVATION_PASSWORD_TOO_SHORT" }),
    );
    expect(() => assertActivationPassword("long-enough-password")).not.toThrow();
  });

  it("masks the account email shown by the public activation preview", () => {
    expect(maskActivationEmail("pegawai@example.org")).toBe("pe*****@example.org");
  });
});

describe("AccountActivationService", () => {
  it("stores only a SHA-256 token hash when issuing an activation link", async () => {
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      void params;
      if (sql.includes("FROM accounts account")) {
        return {
          rows: [
            {
              id: "10000000-0000-4000-8000-000000000001",
              principalType: "EMPLOYEE",
              status: "invited",
              employeeStatus: "active",
              passwordHash: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes(`SELECT principal_type AS "principalType" FROM accounts`)) {
        return { rows: [{ principalType: "EMPLOYEE" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const service = new AccountActivationService(pool);

    const result = await service.issue(
      "10000000-0000-4000-8000-000000000001",
      { id: "20000000-0000-4000-8000-000000000001", email: "admin@example.invalid", principalType: "SUPER_ADMIN" },
    );

    const insertCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO account_activation_tokens"),
    );
    expect(insertCall).toBeTruthy();
    const tokenHash = String(insertCall?.[1]?.[2] ?? "");
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenHash).not.toBe(result.token);
    expect(result.token.length).toBeGreaterThanOrEqual(40);
  });

  it("does not turn invitation activation into a password reset flow", async () => {
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      void params;
      if (sql.includes("FROM accounts account")) {
        return {
          rows: [
            {
              id: "10000000-0000-4000-8000-000000000002",
              principalType: "EMPLOYEE",
              status: "invited",
              employeeStatus: "active",
              passwordHash: "existing-password-hash",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes(`SELECT principal_type AS "principalType" FROM accounts`)) {
        return { rows: [{ principalType: "EMPLOYEE" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const service = new AccountActivationService(pool);

    await expect(
      service.issue(
        "10000000-0000-4000-8000-000000000002",
        { id: "20000000-0000-4000-8000-000000000001", email: "admin@example.invalid", principalType: "SUPER_ADMIN" },
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_ALREADY_ACTIVATED", statusCode: 409 });

    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO account_activation_tokens")),
    ).toBe(false);
  });

  it("activates an invited board account and consumes the token", async () => {
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      void params;
      if (sql.includes("FROM account_activation_tokens activation")) {
        return {
          rows: [
            {
              tokenId: "30000000-0000-4000-8000-000000000001",
              accountId: "40000000-0000-4000-8000-000000000001",
              email: "board@example.org",
              principalType: "FOUNDATION_BOARD",
              accountStatus: "invited",
              employeeStatus: null,
              expiresAt: new Date(Date.now() + 60_000),
              consumedAt: null,
              revokedAt: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const service = new AccountActivationService(pool);

    await expect(
      service.activate("opaque-activation-token", "long-enough-password", {
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
      }),
    ).resolves.toEqual({ principalType: "FOUNDATION_BOARD" });

    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("status = 'active'") && String(sql).includes("password_hash"),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("SET consumed_at = now()")),
    ).toBe(true);
  });
});
