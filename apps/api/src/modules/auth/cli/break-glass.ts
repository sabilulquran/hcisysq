import { z } from "zod";

import { loadConfig } from "../../../config/env.js";
import { createPool } from "../../../db/pool.js";
import {
  BreakGlassError,
  rotateBreakGlassCredential,
  setBreakGlassStatus,
  type AccountStatus,
} from "../break-glass.js";

const accountIdSchema = z.string().uuid();
const reasonSchema = z.string().trim().min(8).max(500);
const passwordSchema = z.string().min(14).max(256);
const statusSchema = z.enum(["active", "inactive"]);

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function printUsage(): void {
  console.log(`Usage:
  break-glass --set-status <active|inactive> --reason "<why>" [--account-id <uuid>] [--apply]
  break-glass --rotate-credential --reason "<why>" [--account-id <uuid>] [--apply]

AUTH-014 §3.2. Both commands act only on a SUPER_ADMIN account and never on any other principal.

Safety:
  - preview is the default; no database write occurs without --apply
  - set HCIS_ALLOW_BREAK_GLASS=1 for this operator command
  - --reason is required and is written to the audit trail, not just to the runbook
  - --rotate-credential reads the new password from HCIS_BREAK_GLASS_PASSWORD and rotates the
    password, the TOTP secret and the recovery codes together, then revokes live sessions
  - deactivating revokes live sessions; getSession already refuses a non-active account

Do not paste the printed TOTP secret or recovery codes into chat, and do not commit them.
`);
}

async function run(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) {
    printUsage();
    return;
  }

  if (process.env.HCIS_ALLOW_BREAK_GLASS !== "1") {
    throw new Error("Set HCIS_ALLOW_BREAK_GLASS=1 only for the explicit break-glass operator command.");
  }

  const setStatus = hasFlag("--set-status");
  const rotate = hasFlag("--rotate-credential");
  if (setStatus === rotate) {
    throw new Error("Choose exactly one of --set-status or --rotate-credential.");
  }

  const apply = hasFlag("--apply");
  const reason = reasonSchema.parse(readArgument("--reason"));
  const accountIdArgument = readArgument("--account-id");
  const accountId = accountIdArgument ? accountIdSchema.parse(accountIdArgument) : undefined;

  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    if (apply) {
      await client.query("BEGIN");
      transactionOpen = true;
    }

    if (setStatus) {
      const status = statusSchema.parse(readArgument("--set-status")) as AccountStatus;
      const result = await setBreakGlassStatus(client, { accountId, status, reason, apply });
      if (transactionOpen) {
        await client.query("COMMIT");
        transactionOpen = false;
      }
      console.log(JSON.stringify(result, null, 2));
      if (result.status === "would_change") {
        console.log("Preview only. Re-run with --apply after verifying the account and the reason.");
      }
      return;
    }

    if (!config.AUTH_ENCRYPTION_KEY) {
      throw new Error("AUTH_ENCRYPTION_KEY is required to rotate the break-glass credential.");
    }
    // Read only when applying, so a preview needs no secret in the environment at all.
    const password = apply ? passwordSchema.parse(process.env.HCIS_BREAK_GLASS_PASSWORD) : "";
    const result = await rotateBreakGlassCredential(client, {
      accountId,
      password,
      encryptionKey: config.AUTH_ENCRYPTION_KEY,
      reason,
      apply,
    });

    if (transactionOpen) {
      await client.query("COMMIT");
      transactionOpen = false;
    }

    const { secrets, ...summary } = result;
    console.log(JSON.stringify(summary, null, 2));
    if (!secrets) {
      console.log("Preview only. Set HCIS_BREAK_GLASS_PASSWORD and re-run with --apply.");
      return;
    }
    console.log("");
    console.log("Add this TOTP secret to an authenticator application:");
    console.log(secrets.totpSecret);
    console.log("");
    console.log("Authenticator URI:");
    console.log(secrets.totpUri);
    console.log("");
    console.log("Recovery codes (shown once; store them offline):");
    for (const code of secrets.recoveryCodes) console.log(code);
    console.log("");
    console.log("Do not paste the TOTP secret or recovery codes into chat or commit them.");
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK");
    }
    if (error instanceof BreakGlassError) {
      throw new Error(`${error.code}: ${error.message}`);
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
