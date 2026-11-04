import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("ATT-005 Wave 3 web safety", () => {
  it("renders an integrated operations workspace without hidden hardware execution", async () => {
    const page = await source("./pages/AdminAdmsDeviceOperationsPage.tsx");
    const client = await source("./lib/admsOperations.ts");
    const combined = `${page}\n${client}`;

    expect(page).toContain("Operasional WDMS");
    expect(page).toContain("Capability matrix");
    expect(page).toContain("physical capability evidence per mesin");
    expect(page).toContain("Import ATTLOG offline");
    expect(page).toContain("Work Code");
    expect(page).toContain("Pesan perangkat");
    expect(page).toContain("Device command: 0");
    expect(page).toContain("<PaginationBar");
    expect(page).not.toContain("HCIS memang tidak mempunyai wire command");
    expect(combined).not.toContain("DATA QUERY USERINFO");
    expect(combined).not.toContain("DATA UPDATE USERINFO");
    expect(combined).not.toContain("DATA DELETE USERINFO");
    expect(combined).not.toMatch(/fetch\([^\n]*(reboot|firmware|clear-all|clear-attendance|biometric-delete|time-sync)/i);
  });

  it("keeps raw ADMS command protocol payloads out of browser admin surfaces", async () => {
    // The commands route renders the maintenance workspace (AdminAdmsDevicePage), which lists
    // management jobs by status only.
    const shell = await source("./pages/AdminAdmsDevicePage.tsx");
    expect(shell).toContain('if (section === "commands") return <AdminAdmsDeviceMaintenancePage />;');
    const commands = await source("./pages/AdminAdmsDeviceMaintenancePage.tsx");
    const users = await source("./pages/AdminAdmsDeviceUsersPage.tsx");
    const client = await source("./lib/admsAdmin.ts");
    const combined = `${commands}\n${users}\n${client}`;

    expect(combined).not.toContain("wireCommand");
    expect(combined).not.toContain("resultCommand");
    expect(combined).not.toContain("DATA QUERY USERINFO");
    expect(combined).not.toContain("DATA UPDATE USERINFO");
  });

  it("supports saved filters on the transaction workspace", async () => {
    const transactions = await source("./pages/AdminAdmsDeviceTransactionsPage.tsx");
    const filters = await source("./components/attendance/device-admin/SavedFilterBar.tsx");

    expect(transactions).toContain('viewKey="transactions"');
    expect(filters).toContain("listAdmsSavedFilters");
    expect(filters).toContain("saveAdmsFilter");
    expect(filters).toContain("deleteAdmsFilter");
  });
});
