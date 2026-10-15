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
    expect(page).toContain("Kode kegiatan");
    expect(page).toContain("Pesan perangkat");
    expect(page).toContain("Device command: 0");
    expect(page).toContain("<PaginationBar");
    expect(page).not.toContain("HCIS memang tidak mempunyai wire command");
    expect(combined).not.toContain("DATA QUERY USERINFO");
    expect(combined).not.toContain("DATA UPDATE USERINFO");
    expect(combined).not.toContain("DATA DELETE USERINFO");
    expect(combined).not.toMatch(/fetch\([^\n]*(reboot|firmware|clear-all|clear-attendance|biometric-delete|time-sync)/i);
  });

  it("keeps the operator Data Mesin tab in user language and technical tooling behind diagnostics (ATT-012)", async () => {
    const page = await source("./pages/AdminAdmsDeviceOperationsPage.tsx");
    const devicePage = await source("./pages/AdminAdmsDevicePage.tsx");
    const shell = await source("./components/attendance/device-admin/DeviceDetailShell.tsx");

    expect(devicePage).toContain('<AdminAdmsDeviceOperationsPage mode="data" />');
    expect(page).toContain("{technical ? (");
    expect(page).not.toContain("Desired:");
    expect(page).not.toContain("HCIS only");
    expect(shell).toContain('label: "Data Mesin"');
    expect(shell).toContain('label: "Maintenance"');
    expect(shell).not.toContain('suffix: "/commands"');
  });

  it("keeps raw ADMS command protocol payloads out of browser admin surfaces", async () => {
    const commands = await source("./pages/AdminAdmsDeviceCommandsPage.tsx");
    const users = await source("./pages/AdminAdmsDeviceUsersPage.tsx");
    const client = await source("./lib/admsAdmin.ts");
    const combined = `${commands}\n${users}\n${client}`;

    expect(combined).not.toContain("wireCommand");
    expect(combined).not.toContain("resultCommand");
    expect(combined).not.toContain("DATA QUERY USERINFO");
    expect(combined).not.toContain("DATA UPDATE USERINFO");
    expect(commands).toContain("Payload protokol mentah tidak diekspos ke browser");
  });

  it("supports saved filters on transaction and command workspaces", async () => {
    const transactions = await source("./pages/AdminAdmsDeviceTransactionsPage.tsx");
    const commands = await source("./pages/AdminAdmsDeviceCommandsPage.tsx");
    const filters = await source("./components/attendance/device-admin/SavedFilterBar.tsx");

    expect(transactions).toContain('viewKey="transactions"');
    expect(commands).toContain('viewKey="commands"');
    expect(filters).toContain("listAdmsSavedFilters");
    expect(filters).toContain("saveAdmsFilter");
    expect(filters).toContain("deleteAdmsFilter");
  });
});
