import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("ATT-012 approved ADMS operator experience", () => {
  it("uses the approved operator navigation and keeps diagnostics secondary", async () => {
    const shell = await source("./components/attendance/device-admin/DeviceDetailShell.tsx");
    const management = await source("./components/attendance/adms/AdmsManagementNav.tsx");

    for (const label of ["Ringkasan", "Pengguna", "Biometrik", "Data Mesin", "Transaksi", "Konfigurasi", "Maintenance"]) {
      expect(shell).toContain(`label: "${label}"`);
    }
    expect(shell).toContain("Diagnostik teknis");
    expect(management).toContain('label: "Sinkronisasi"');
    expect(management).not.toContain("Sinkronisasi & Perintah");
  });

  it("keeps engineering vocabulary out of ordinary operator page copy", async () => {
    const ordinary = [
      "./pages/AdminAdmsDeviceOverviewPage.tsx",
      "./pages/AdminAdmsDeviceUsersPage.tsx",
      "./pages/AdminAdmsDeviceBiometricsPage.tsx",
      "./pages/AdminAdmsDeviceDataPage.tsx",
      "./pages/AdminAdmsDeviceSettingsPage.tsx",
      "./pages/AdminAdmsDeviceMaintenancePage.tsx",
      "./pages/AdminAdmsJobsPage.tsx",
    ];
    const combined = (await Promise.all(ordinary.map(source))).join("\n");
    for (const term of [
      "physical parity",
      "physical canary",
      "capability key",
      "wire command",
      "raw command",
      "return code",
      "operation ID",
      "DATA UPDATE",
      "SET OPTION",
      "RELOAD OPTIONS",
    ]) {
      expect(combined.toLowerCase()).not.toContain(term.toLowerCase());
    }
    expect(combined).toContain("Perlu pengujian perangkat");
    expect(combined).toContain("Tidak didukung mesin ini");
  });

  it("keeps command numbers and protocol names out of transaction, recovery, mapping and health copy", async () => {
    const files = [
      "./pages/AdminAdmsDeviceTransactionsPage.tsx",
      "./components/attendance/device-admin/LongRangeRecoveryPanel.tsx",
      "./components/attendance/device-admin/MappingReviewPanel.tsx",
      "./pages/AdminAdmsHealthPage.tsx",
      "./pages/AdminAdmsBackOfficePage.tsx",
    ];
    const combined = (await Promise.all(files.map(source))).join("\n");
    for (const term of ["C:${", "tab Perintah", "DATA QUERY", "ATTLOG", "USERINFO", "Job terbaru", "exact-deduped", "Source IP"]) {
      expect(combined).not.toContain(term);
    }
    // Code identifiers may say "chunks"; visible copy must not.
    expect(combined).not.toMatch(/\s(?:chunk|Chunk)\b/);
    // Raw enums are translated before they are shown.
    const health = await source("./pages/AdminAdmsHealthPage.tsx");
    expect(health).not.toContain("{item.connectivityStatus} · {item.lifecycle}");
    expect(health).toContain("connectivityText(item.connectivityStatus)");
    expect(health).toContain("lifecycleText(item.lifecycle)");
  });

  it("answers how many active machines are online, offline or unknown on the dashboard", async () => {
    const dashboard = await source("./pages/AdminAdmsBackOfficePage.tsx");
    expect(dashboard).toContain("summary.connectivity.online");
    expect(dashboard).toContain("summary.connectivity.offline");
    expect(dashboard).toContain("summary.connectivity.unknown");
    expect(dashboard).toContain("Belum diketahui");
  });

  it("offers a date filter for one machine's transactions through the shared transaction view", async () => {
    const transactions = await source("./pages/AdminAdmsDeviceTransactionsPage.tsx");
    const global = await source("./pages/AdminAdmsGlobalTransactionsPage.tsx");
    expect(transactions).toContain("/admin/attendance/adms/transactions?deviceId=");
    expect(transactions).toContain("Ambil transaksi terbaru");
    expect(global).toContain('get("deviceId")');
    expect(global).toContain("UUID_PATTERN.test(value)");
  });

  it("provides fleet synchronization preview without machine-to-machine copy", async () => {
    const page = await source("./pages/AdminAdmsJobsPage.tsx");
    expect(page).toContain("Preview perubahan");
    expect(page).toContain("Sinkronkan yang belum sesuai");
    expect(page).toContain("Tidak ada penyalinan mesin-ke-mesin");
    expect(page).toContain("Hubungkan pegawai ke PIN mesin lebih dulu");
    expect(page).toContain('"execute"');
    expect(page).not.toContain("commandNumber");
    expect(page).not.toContain("returnCode");
  });

  it("keeps biometric collection activation out of ordinary UI", async () => {
    const page = await source("./pages/AdminAdmsDeviceBiometricsPage.tsx");
    expect(page).toContain("Pengelolaan biometrik belum diaktifkan");
    expect(page).toContain("Isi template biometrik dan data rahasia tidak pernah ditampilkan");
    expect(page).not.toContain("reencryptBiometricVault");
    expect(page).not.toContain("updateAdmsBiometricPolicy");
  });
});
