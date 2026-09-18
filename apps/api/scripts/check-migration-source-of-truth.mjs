import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "../migrations");
const manifestPath = join(migrationsDir, "production-history-manifest.json");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sameStrings(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert(manifest.version === 1, "Unsupported migration production-history manifest version");
assert(manifest.identity === "full-filename", "Migration identity must remain the full filename");
assert(Array.isArray(manifest.protectedMigrations), "protectedMigrations must be an array");
assert(Array.isArray(manifest.historicalDuplicatePrefixes), "historicalDuplicatePrefixes must be an array");

const files = (await readdir(migrationsDir))
  .filter((name) => name.endsWith(".sql"))
  .sort();

assert(new Set(files).size === files.length, "Migration filenames must be unique");

const protectedNames = manifest.protectedMigrations.map((item) => item.filename);
assert(
  new Set(protectedNames).size === protectedNames.length,
  "Protected migration filenames must be unique in the manifest",
);

for (const item of manifest.protectedMigrations) {
  assert(item.deploymentStatus === "deployed-production", `Protected migration ${item.filename} must remain marked deployed-production`);
  assert(files.includes(item.filename), `Protected deployed migration is missing or renamed: ${item.filename}`);
  assert(typeof item.sha256 === "string" && /^[0-9a-f]{64}$/.test(item.sha256), `Invalid SHA-256 for ${item.filename}`);
  assert(typeof item.gitBlobSha === "string" && /^[0-9a-f]{40}$/.test(item.gitBlobSha), `Invalid Git blob SHA for ${item.filename}`);
  assert(typeof item.sourceCommit === "string" && /^[0-9a-f]{40}$/.test(item.sourceCommit), `Invalid source commit for ${item.filename}`);

  const content = await readFile(join(migrationsDir, item.filename));
  const sha256 = createHash("sha256").update(content).digest("hex");
  const gitBlobSha = createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest("hex");

  assert(
    sha256 === item.sha256,
    `Protected deployed migration content changed: ${item.filename}; expected SHA-256 ${item.sha256}, got ${sha256}`,
  );
  assert(
    gitBlobSha === item.gitBlobSha,
    `Protected deployed migration no longer matches accepted Git blob: ${item.filename}; expected ${item.gitBlobSha}, got ${gitBlobSha}`,
  );
}

const byPrefix = new Map();
for (const file of files) {
  const match = /^(\d{4})_.+\.sql$/.exec(file);
  assert(match, `Migration filename must start with a four-digit prefix: ${file}`);
  const prefix = match[1];
  const group = byPrefix.get(prefix) ?? [];
  group.push(file);
  byPrefix.set(prefix, group);
}

const allowedByPrefix = new Map();
for (const item of manifest.historicalDuplicatePrefixes) {
  assert(/^\d{4}$/.test(item.prefix), `Invalid duplicate-prefix allowlist key: ${item.prefix}`);
  assert(typeof item.reason === "string" && item.reason.trim().length > 0, `Duplicate-prefix allowlist ${item.prefix} needs a reason`);
  assert(Array.isArray(item.filenames) && item.filenames.length > 1, `Duplicate-prefix allowlist ${item.prefix} must name every colliding migration`);
  const sorted = [...item.filenames].sort();
  assert(new Set(sorted).size === sorted.length, `Duplicate-prefix allowlist ${item.prefix} contains duplicate filenames`);
  assert(!allowedByPrefix.has(item.prefix), `Duplicate-prefix allowlist repeats prefix ${item.prefix}`);
  allowedByPrefix.set(item.prefix, sorted);
}

for (const [prefix, group] of byPrefix) {
  if (group.length <= 1) continue;
  const actual = [...group].sort();
  const allowed = allowedByPrefix.get(prefix);
  assert(
    allowed,
    `Migration prefix collision ${prefix} is not an accepted historical collision: ${actual.join(", ")}`,
  );
  assert(
    sameStrings(actual, allowed),
    `Migration prefix collision ${prefix} does not match the historical allowlist; actual=${actual.join(", ")} allowed=${allowed.join(", ")}`,
  );
}

for (const [prefix, allowed] of allowedByPrefix) {
  const actual = [...(byPrefix.get(prefix) ?? [])].sort();
  assert(
    sameStrings(actual, allowed),
    `Historical duplicate-prefix manifest is out of sync for ${prefix}; actual=${actual.join(", ")} allowed=${allowed.join(", ")}`,
  );
}

process.stdout.write(
  `Migration source-of-truth guard passed: ${files.length} SQL files, ${manifest.protectedMigrations.length} protected deployed migrations, ${allowedByPrefix.size} historical duplicate prefixes.\n`,
);
