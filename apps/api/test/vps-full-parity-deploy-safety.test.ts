import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const deployUrl = new URL("../../../scripts/deploy-vps.sh", import.meta.url);
const verifyUrl = new URL("../../../scripts/verify-vps.sh", import.meta.url);
const composeUrl = new URL("../../../infra/docker-compose.vps.yml", import.meta.url);
const productionWorkflowUrl = new URL("../../../.github/workflows/deploy-production.yml", import.meta.url);

describe("VPS full parity deployment safety", () => {
  it("keeps production deployment behind an explicit human dispatch", async () => {
    const source = await readFile(productionWorkflowUrl, "utf8");
    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("confirmation:");
    expect(source).toContain('description: "Type DEPLOY_PRODUCTION to continue"');
    expect(source).toContain("TARGET_SHA: ${{ inputs.target_sha }}");
    expect(source).toContain("CONFIRMATION: ${{ inputs.confirmation }}");
    expect(source).not.toContain("workflow_run:");
    expect(source).not.toContain("github.event.workflow_run");
  });

  it("prefers exact-SHA GHCR application images and never recreates postgres volume", async () => {
    const source = await readFile(deployUrl, "utf8");
    expect(source).toContain("ghcr.io/imadjinasi/hcisysq-api");
    expect(source).toContain("ghcr.io/imadjinasi/hcisysq-web");
    expect(source).toContain(":sha-$sha");
    expect(source).toContain('"${COMPOSE[@]}" pull api web');
    expect(source).toContain("COMPOSE_PARALLEL_LIMIT=1");
    expect(source).not.toContain("docker compose down -v");
    expect(source).not.toMatch(/\bdown\s+-v\b/);
  });

  it("compose accepts immutable runtime images while retaining explicit local build fallback", async () => {
    const source = await readFile(composeUrl, "utf8");
    expect(source).toContain("HCIS_API_IMAGE");
    expect(source).toContain("HCIS_WEB_IMAGE");
    expect(source).toContain("apps/api/Dockerfile");
    expect(source).toContain("apps/web/Dockerfile");
  });

  it("wires the accepted production OIDC and private Application Access contract", async () => {
    const source = await readFile(composeUrl, "utf8");
    for (const requiredName of [
      "AUTH_MODE",
      "OIDC_ISSUER",
      "OIDC_CLIENT_ID",
      "OIDC_CLIENT_SECRET",
      "OIDC_REDIRECT_URI",
      "OIDC_POST_LOGOUT_REDIRECT_URI",
      "SQ_HUB_APPLICATION_ACCESS_URL",
      "SQ_HUB_MACHINE_CLIENT_ID",
      "SQ_HUB_MACHINE_CLIENT_SECRET",
    ]) {
      expect(source).toContain(`${requiredName}: \${${requiredName}:?set ${requiredName}}`);
    }
    expect(source).toContain("sq_platform_production:");
    expect(source).toContain("name: ${SQ_PLATFORM_PRODUCTION_NETWORK:?set SQ_PLATFORM_PRODUCTION_NETWORK}");
    expect(source).toContain("hcis-api-production");
  });

  it("verifier checks full parity without requesting device commands", async () => {
    const source = await readFile(verifyUrl, "utf8");
    expect(source).toContain("physical_parity_table_count");
    expect(source).toContain("userinfo_guard_count");
    expect(source).toContain("biometric_global_collection=OFF");
    expect(source).toContain("verification_device_commands_requested=0");
    expect(source).toContain("COMMAND_COUNT_BEFORE");
    expect(source).toContain("COMMAND_COUNT_AFTER");
    expect(source).not.toMatch(/curl[^\n]+\/physical\//i);
    expect(source).not.toContain("docker compose down -v");
  });
});
