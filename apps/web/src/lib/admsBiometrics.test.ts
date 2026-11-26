// ATT-005: the device biometrics screen must report the machine, not only the HCIS vault.

import { describe, expect, it } from "vitest";

import {
  biometricAttentionCount,
  biometricReplicaLabel,
  biometricTemplateRows,
  type BiometricCredentialItem,
  type BiometricReplicaItem,
} from "@/lib/admsBiometrics";

function credential(overrides: Partial<BiometricCredentialItem> = {}): BiometricCredentialItem {
  return {
    id: "cred-1",
    employeeId: "emp-1",
    employeeNumber: "201000",
    employeeName: "Ahmad Firdaus",
    employeeStatus: "active",
    modality: "fingerprint",
    slotIndex: 0,
    vendorFormat: "zkteco-v10",
    vendorVersion: "10.0",
    originDeviceId: null,
    originDeviceSerial: null,
    capturedAt: null,
    importedAt: "2026-11-01T00:00:00.000Z",
    lifecycle: "active",
    ...overrides,
  } as BiometricCredentialItem;
}

function replica(overrides: Partial<BiometricReplicaItem> = {}): BiometricReplicaItem {
  return {
    credentialId: "cred-1",
    state: "present",
    deviceVendorFormat: "zkteco-v10",
    observedAt: null,
    lastSyncedAt: null,
    lastErrorCode: null,
    employeeId: "emp-1",
    employeeNumber: "201000",
    employeeName: "Ahmad Firdaus",
    modality: "fingerprint",
    slotIndex: 0,
    vaultVendorFormat: "zkteco-v10",
    vaultVendorVersion: null,
    credentialLifecycle: "active",
    ...overrides,
  } as BiometricReplicaItem;
}

describe("device biometrics view", () => {
  it("never calls a template stored on the machine when the machine says it is missing", () => {
    // The screen used to read the vault side only, so a credential HCIS holds read "Tersimpan"
    // even while the machine reported it missing, and the operator had nothing to act on.
    const rows = biometricTemplateRows([credential()], [replica({ state: "missing" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vault: "Tersimpan di HCIS", machine: "missing" });
    expect(biometricReplicaLabel(rows[0]!.machine!)).toBe("Belum ada di mesin");
  });

  it("says the machine has not spoken rather than guessing", () => {
    const rows = biometricTemplateRows([credential()], []);
    expect(rows[0]!.machine).toBeNull();
  });

  it("keeps a template the machine holds but HCIS no longer does", () => {
    const rows = biometricTemplateRows([], [replica({ credentialId: "cred-9", state: "conflict" })]);
    expect(rows[0]).toMatchObject({ vault: "Tidak ada di HCIS", machine: "conflict" });
  });

  it("marks a retired credential as inactive in HCIS, with its own machine state", () => {
    const rows = biometricTemplateRows([credential({ lifecycle: "retired" })], [replica({ state: "stale" })]);
    expect(rows[0]).toMatchObject({ vault: "Tidak aktif di HCIS", machine: "stale" });
  });

  it("counts only the templates an operator has to act on", () => {
    const replicas = [
      replica({ credentialId: "a", state: "present" }),
      replica({ credentialId: "b", state: "succeeded" }),
      replica({ credentialId: "c", state: "missing" }),
      replica({ credentialId: "d", state: "failed" }),
      replica({ credentialId: "e", state: "pending" }),
    ];
    expect(biometricAttentionCount(replicas)).toBe(3);
  });
});
