import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("ATT-005 biometric control-plane web safety", () => {
  it("does not expose physical biometric device actions", async () => {
    const page = await source("./pages/AdminAdmsDeviceBiometricsPage.tsx");
    const client = await source("./lib/admsBiometrics.ts");
    const combined = `${page}\n${client}`;

    expect(combined).toContain("Protokol fisik belum dibuktikan aman");
    expect(combined).toContain("rawPayloadExposed");
    expect(combined).not.toContain("DATA QUERY USERINFO");
    expect(combined).not.toMatch(/fetch\([^\n]*(template|enroll|restore|distribut|device-delete)/i);
    expect(combined).not.toContain("payloadCiphertext");
    expect(combined).not.toContain("payloadSha256");
    expect(combined).not.toContain("payloadIv");
    expect(combined).not.toContain("payloadAuthTag");
    expect(combined).not.toContain("encryptionKeyId");
  });

  it("uses pagination across the device-admin backlog and histories", async () => {
    const review = await source("./components/attendance/device-admin/MappingReviewPanel.tsx");
    const users = await source("./pages/AdminAdmsDeviceUsersPage.tsx");
    const transactions = await source("./pages/AdminAdmsDeviceTransactionsPage.tsx");

    expect(review).toContain("<PaginationBar");
    expect(review).not.toContain("priorityItems.slice(0, 8)");
    expect(users).toContain("<PaginationBar");
    expect(users).toContain("pagedRows.map");
    expect(transactions).toContain("<PaginationBar");
  });
});