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
