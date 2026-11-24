// SVC-001: keadaan layanan pegawai dibaca dari server, bukan dituliskan katalog layar.
//
// Audit kesiapan 2026-11-24 menemukan Uang Muka Dinas berlabel "Tersedia" di katalog Semua Layanan
// sementara server menjawab `409 TRIP_PER_DIEM_NOT_ACTIVE` untuk setiap perkiraan dan pengajuan.
// Uji ini menjaga satu hal: label datang dari gerbang yang sama dengan yang menolak permintaannya.

import { describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import {
  employeeServiceStatuses,
  type EmployeeServiceStatus,
} from "../src/modules/services/employee-service-routes.js";

/** Satu-satunya kueri yang dipakai: baris penyalaan uang saku dinas (TRIP-002 D-22). */
function dbWithPerDiem(state: "ACTIVE" | "INACTIVE" | "NONE") {
  const rows = state === "NONE"
    ? []
    : [{ state, changedAt: "2026-11-24T03:00:00.000Z", changedByName: "HC Uji", reason: null }];
  return { query: async () => ({ rows }) } as never;
}

const BARE = {
  TRAINING_ONLINE_ENABLED: "0",
} as unknown as ApiConfig;

const CONNECTED = {
  TRAINING_ONLINE_ENABLED: "1",
  OIDC_ISSUER: "https://login.example.invalid/realms/sq-staff",
  ASET_SQ_PERSON_CUSTODY_URL: "https://aset.example.invalid/internal/v1/custody",
  ASET_SQ_MACHINE_CLIENT_ID: "hcis-aset-custody",
  ASET_SQ_MACHINE_CLIENT_SECRET: "rahasia-uji",
  QURAN_SCOREBOARD_URL: "https://quran.example.invalid/internal/v1/scoreboard",
  QURAN_MACHINE_CLIENT_ID: "hcis-quran-scoreboard",
  QURAN_MACHINE_CLIENT_SECRET: "rahasia-uji",
} as unknown as ApiConfig;

const byKey = (statuses: EmployeeServiceStatus[], key: string) =>
  statuses.find((status) => status.key === key);

describe("SVC-001 keadaan layanan pegawai", () => {
  it("menyebut Uang Muka Dinas terkunci selama HC belum menyalakannya, dengan kode yang sama seperti rutenya", async () => {
    const statuses = await employeeServiceStatuses(dbWithPerDiem("NONE"), CONNECTED);
    const tripAdvances = byKey(statuses, "trip-advances");
    expect(tripAdvances).toBeDefined();
    expect(tripAdvances!.state).toBe("LOCKED");
    expect(tripAdvances!.code).toBe("TRIP_PER_DIEM_NOT_ACTIVE");
    // Kalimatnya untuk pegawai, syaratnya untuk HC; keduanya wajib ada, bukan salah satu.
    expect(tripAdvances!.message).toContain("belum dibuka");
    expect(tripAdvances!.requirement).toContain("Human Capital");
  });

  it("berhenti menyebutnya begitu HC menyalakannya", async () => {
    const statuses = await employeeServiceStatuses(dbWithPerDiem("ACTIVE"), CONNECTED);
    expect(byKey(statuses, "trip-advances")).toBeUndefined();
  });

  it("baris penyalaan yang dimatikan kembali mengunci layanannya lagi", async () => {
    const statuses = await employeeServiceStatuses(dbWithPerDiem("INACTIVE"), CONNECTED);
    expect(byKey(statuses, "trip-advances")?.state).toBe("LOCKED");
  });

  it("menyebut layanan yang sumbernya belum tersambung, dan membedakan terkunci dari sebagian dibuka", async () => {
    const statuses = await employeeServiceStatuses(dbWithPerDiem("ACTIVE"), BARE);
    expect(byKey(statuses, "assets")?.state).toBe("LOCKED");
    // Pelatihan dan penghargaan tetap dapat dibuka; yang mati hanya satu bagiannya.
    expect(byKey(statuses, "training")?.state).toBe("LIMITED");
    expect(byKey(statuses, "rewards")?.state).toBe("LIMITED");
  });

  it("tidak menyebut layanan yang memang terbuka, sehingga katalog layar tidak terkunci keliru", async () => {
    const statuses = await employeeServiceStatuses(dbWithPerDiem("ACTIVE"), CONNECTED);
    expect(statuses).toHaveLength(0);
    for (const key of ["leave", "payslips", "attendance", "approvals", "reimbursement", "loan"]) {
      expect(byKey(statuses, key)).toBeUndefined();
    }
  });

  it("setiap baris membawa kode, kalimat, dan syarat — tidak ada yang kosong", async () => {
    const statuses = await employeeServiceStatuses(dbWithPerDiem("NONE"), BARE);
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) {
      expect(status.key).toMatch(/^[a-z-]+$/);
      expect(status.code).toMatch(/^[A-Z_]+$/);
      expect(status.message.length).toBeGreaterThan(20);
      expect(status.requirement.length).toBeGreaterThan(20);
    }
  });
});
