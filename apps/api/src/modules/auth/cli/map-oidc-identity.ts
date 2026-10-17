import { z } from "zod";

import { loadConfig } from "../../../config/env.js";
import { createPool } from "../../../db/pool.js";
import {
  OidcIdentityMappingError,
  OidcIdentityMappingService,
} from "../oidc-identity-mapping.js";

const accountIdSchema = z.string().uuid();
const issuerSchema = z.string().url().max(2048);
const subjectSchema = z.string().min(1).max(512);

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
  map-oidc-identity --account-id <uuid> --issuer <issuer> --subject <sub> [--apply] [--replace]
  map-oidc-identity --account-id <uuid> --clear [--apply]
  map-oidc-identity --hand-over --from-account-id <uuid> --to-account-id <uuid> [--apply]

Safety:
  - preview is the default; no database write occurs without --apply
  - replacing an existing different mapping requires --replace --apply
  - set HCIS_ALLOW_OIDC_IDENTITY_MAPPING=1 for this operator command
  - use the exact OIDC issuer and subject returned by the staging identity provider
  - --hand-over (ORG-010 §5) moves the identity held by --from-account-id to the active
    --to-account-id of the other kind (FOUNDATION_BOARD <-> EMPLOYEE), deactivates the old
    account and ends its sessions in one transaction; it never grants a role
`);
}

async function run() {
  if (hasFlag("--help") || hasFlag("-h")) {
    printUsage();
    return;
  }

  if (process.env.HCIS_ALLOW_OIDC_IDENTITY_MAPPING !== "1") {
    throw new Error(
      "Set HCIS_ALLOW_OIDC_IDENTITY_MAPPING=1 only for the explicit staging identity-mapping command.",
    );
  }

  if (hasFlag("--hand-over")) {
    await runHandOver();
    return;
  }

  const accountId = accountIdSchema.parse(readArgument("--account-id"));
  const clear = hasFlag("--clear");
  const apply = hasFlag("--apply");
  const replace = hasFlag("--replace");
  const issuerArg = readArgument("--issuer");
  const subjectArg = readArgument("--subject");

  if (clear && (issuerArg || subjectArg || replace)) {
    throw new Error("--clear cannot be combined with --issuer, --subject, or --replace.");
  }
  if (!clear && (!issuerArg || !subjectArg)) {
    throw new Error("Mapping requires both --issuer and --subject.");
  }
  if (replace && !apply) {
    throw new Error("--replace is only meaningful with --apply. Preview the replacement first without --replace.");
  }

  const config = loadConfig();
  const issuer = clear ? undefined : issuerSchema.parse(issuerArg);
  const subject = clear ? undefined : subjectSchema.parse(subjectArg);
  if (issuer && config.OIDC_ISSUER && issuer !== config.OIDC_ISSUER.replace(/\/$/, "")) {
    throw new Error(
      `Issuer does not match configured OIDC_ISSUER (${config.OIDC_ISSUER.replace(/\/$/, "")}).`,
    );
  }

  const pool = createPool(config.DATABASE_URL);
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    if (apply) {
      await client.query("BEGIN");
      transactionOpen = true;
    }

    const mapping = new OidcIdentityMappingService(client);
    const result = clear
      ? await mapping.clear({ accountId, apply })
      : await mapping.map({
          accountId,
          issuer: issuer as string,
          subject: subject as string,
          apply,
          replace,
        });

    if (transactionOpen) {
      await client.query("COMMIT");
      transactionOpen = false;
    }

    console.log(JSON.stringify(result, null, 2));
    if (!apply && result.status.startsWith("would_")) {
      console.log("Preview only. Re-run with --apply after verifying account ID, issuer, and subject.");
    }
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK");
    }
    if (error instanceof OidcIdentityMappingError) {
      throw new Error(`${error.code}: ${error.message}`);
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function runHandOver() {
  for (const flag of ["--account-id", "--issuer", "--subject", "--clear", "--replace"]) {
    if (hasFlag(flag)) throw new Error(`--hand-over cannot be combined with ${flag}.`);
  }
  const fromAccountId = accountIdSchema.parse(readArgument("--from-account-id"));
  const toAccountId = accountIdSchema.parse(readArgument("--to-account-id"));
  const apply = hasFlag("--apply");

  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    if (apply) {
      await client.query("BEGIN");
      transactionOpen = true;
    }

    const result = await new OidcIdentityMappingService(client).handOver({ fromAccountId, toAccountId, apply });

    if (transactionOpen) {
      await client.query("COMMIT");
      transactionOpen = false;
    }

    console.log(JSON.stringify(result, null, 2));
    if (!apply) {
      console.log("Preview only. Re-run with --apply after verifying both account IDs. A Super Admin grants any role separately.");
    }
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK");
    }
    if (error instanceof OidcIdentityMappingError) {
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
