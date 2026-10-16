import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const releasePath = join(root, "scripts/mi8/release-mi8.sh");
const buildPath = join(root, "scripts/mi8/build-release.sh");
const workflowPath = join(root, ".github/workflows/build-mi8-release.yml");

describe("OPS-MI8-REL-001 Mi8VPS release tooling", () => {
  it.skipIf(process.platform === "win32")("has valid Bash syntax", () => {
    expect(() => execFileSync("bash", ["-n", releasePath], { stdio: "pipe" })).not.toThrow();
    expect(() => execFileSync("bash", ["-n", buildPath], { stdio: "pipe" })).not.toThrow();
  });

  it("is dry-run by default and needs a per-release confirmation to mutate production", () => {
    const source = readFileSync(releasePath, "utf8");
    expect(source).toContain("APPLY=0");
    expect(source).toContain('[[ "$CONFIRM" == "RELEASE_$SHA8" ]]');
    // Every mutating remote step goes through remote_rw, which only prints in dry run.
    for (const phase of ["phase_upload", "phase_backup", "phase_migrate", "phase_candidate", "phase_cutover", "phase_rollback"]) {
      const body = source.slice(source.indexOf(`${phase}() {`), source.indexOf("\n}\n", source.indexOf(`${phase}() {`)));
      expect(body).toContain("remote_rw");
    }
    expect(source.slice(source.indexOf("phase_verify() {"), source.indexOf("phase_rollback() {"))).not.toContain("remote_rw");
  });

  it("keeps the release safety boundaries", () => {
    const source = readFileSync(releasePath, "utf8");
    expect(source).toContain("pg_dump -U postgres -Fc");
    expect(source).toContain("pg_restore --list");
    expect(source).toContain("no pre-release backup marker");
    expect(source).toContain("BIOMETRIC_COLLECTION_ENABLED=0");
    expect(source).toContain("is not current origin/main");
    expect(source).toContain('refs "$S/sq-core-launch.sh" "$cur")" = 4');
    expect(source).toContain('refs "$S/sq-core-worker.sh" "$cur")" = 2');
    expect(source).toContain("restart_worker");
    // OPS-MI8-SUP-001: TERM to the worker stops every service in its process group.
    const restartWorker = source.slice(source.indexOf("restart_worker() {"), source.indexOf("wait_release() {"));
    expect(restartWorker).toContain('kill -KILL "$wp"');
    expect(restartWorker).not.toContain("-TERM");
    expect(source).toContain("database NOT rolled back");
    expect(source).not.toMatch(/rm -rf[^\n]*\$REL\/\$PREV/);
    expect(source).not.toContain("final.env >");
    expect(source).not.toMatch(/cat [^\n]*final\.env/);
  });

  it("builds arm64 from an exact clean SHA and rejects native addons", () => {
    const source = readFileSync(buildPath, "utf8");
    expect(source).toContain("--platform linux/arm64");
    expect(source).toContain('"$(git rev-parse HEAD)" != "$EXPECTED_SHA"');
    expect(source).toContain("npm ci --omit=dev");
    expect(source).toContain("-name '*.node'");
    expect(source).toContain('"platform": "linux/arm64"');
  });

  it("builds in CI without any production access", () => {
    const source = readFileSync(workflowPath, "utf8");
    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("scripts/mi8/build-release.sh");
    expect(source).not.toContain("secrets.");
    expect(source).not.toContain("ssh ");
    expect(source).not.toContain("push:");
  });
});
