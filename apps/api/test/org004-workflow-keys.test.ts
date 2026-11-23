// ORG-004 (DRAFT D-R1): kunci workflow rollout adalah himpunan tertutup, dan himpunan itu dijaga
// di tiga tempat — daftar kanonik, route admin, dan constraint database. Berkas ini menjaga dua
// yang pertama; penolakan oleh database diuji terhadap skema sungguhan di
// `org004-rollout-switch.postgres.test.ts`, karena hanya di sana constraint itu benar-benar ada.
//
// Di sini juga dijaga tabel requirement (D-R3): tiap kunci menyebut rantai yang diminta runtime,
// karena default `LINE_AND_UNIT` pada resolver membuat pemanggil yang lupa mendapat rantai lain
// — bukan galat.
//
// Yang dicegah: baris rollout dengan kunci yang tidak dicari runtime mana pun tersimpan tanpa
// keluhan, lalu `resolveRolloutSetting` jatuh diam-diam ke `LEGACY`. Operator mengira satu unit
// sudah pindah ke `STRUCTURE` padahal tidak, dan tidak ada apa pun di layar yang mengatakannya.

import { readdir, readFile } from "node:fs/promises";

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerOrganizationAdminRoutes } from "../src/modules/organization/admin-routes.js";
import {
  authorityRequirementOf,
  ORGANIZATION_WORKFLOW_AUTHORITY_REQUIREMENTS,
  ORGANIZATION_WORKFLOW_KEYS,
} from "../src/modules/organization/workflow-keys.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://org004-workflow-keys-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

/** Super Admin dengan `approvals.policy.manage`; izin yang dituntut saklar rollout. */
function createPool() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) {
      return { rows: [{ permissionKey: "approvals.policy.manage" }], rowCount: 1 };
    }
    if (sql.includes("FROM auth_sessions s")) {
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000001",
          accountId: "00000000-0000-4000-8000-000000000002",
          email: "synthetic@example.invalid",
          principalType: "SUPER_ADMIN",
          expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected organization admin SQL: ${sql}`);
  });

  /** Setiap tulisan ke tabel rollout, agar yang ditolak terbukti tidak pernah tersimpan. */
  const written: Array<{ workflowKey: unknown; mode: unknown }> = [];
  const transactionQuery = vi.fn(async (sql: string, values?: unknown[]) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql.trim().toUpperCase())) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO organization_rollout_settings")) {
      written.push({ workflowKey: values?.[1], mode: values?.[3] });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO organization_audit_events")) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected rollout transaction SQL: ${sql}`);
  });
  const connect = vi.fn(async () => ({ query: transactionQuery, release: () => undefined }));
  return { pool: { query, connect } as unknown as Pool, written };
}

async function patchRollout(payload: Record<string, unknown>) {
  const { pool, written } = createPool();
  const app = Fastify({ logger: false });
  await registerOrganizationAdminRoutes(app, pool, config);
  const response = await app.inject({
    method: "PATCH",
    url: "/admin/organization/rollout",
    headers: { cookie: "hcis_session=synthetic" },
    payload,
  });
  await app.close();
  return { response, written };
}

describe("ORG-004 kunci workflow rollout", () => {
  it("menolak kunci workflow asing dan tidak menyimpan apa pun", async () => {
    // `"LEAVE"` persis kunci yang dulu menjadi default route ini. Runtime cuti tidak pernah
    // mencarinya — ia mencari `leave.annual` dan seterusnya — jadi barisnya tidak berpengaruh.
    for (const workflowKey of ["LEAVE", "leave", "leave.annual ", "CUTI", "leave.sick", ""]) {
      const { response, written } = await patchRollout({ mode: "STRUCTURE", workflowKey });
      expect(response.statusCode, `kunci ${JSON.stringify(workflowKey)}`).toBe(400);
      expect(response.json()).toMatchObject({ code: "INVALID_ORGANIZATION_ROLLOUT" });
      expect(written).toEqual([]);
    }
  });

  it("menolak baris rollout tanpa kunci workflow, karena tidak ada lagi default", async () => {
    // Default `"LEAVE"` yang lama membuat baris tanpa kunci tetap tersimpan — dan tidak pernah
    // cocok dengan apa pun. Lebih baik ditolak daripada diterima menjadi baris yang mati.
    const { response, written } = await patchRollout({ mode: "STRUCTURE" });
    expect(response.statusCode).toBe(400);
    expect(written).toEqual([]);
  });

  it("menyimpan setiap kunci pada daftar kanonik apa adanya", async () => {
    for (const workflowKey of ORGANIZATION_WORKFLOW_KEYS) {
      const { response, written } = await patchRollout({ mode: "LEGACY", workflowKey });
      expect(response.statusCode, `kunci ${workflowKey}`).toBe(200);
      expect(written).toEqual([{ workflowKey, mode: "LEGACY" }]);
    }
  });

  it("menjaga daftar kanonik sama persis dengan constraint pada migrasi terakhir yang mendefinisikannya", async () => {
    // Daftar yang dibaca route dan daftar yang dipaksakan database harus satu benda. Kalau
    // berbeda, salah satu jalur penulisan menerima kunci yang jalur lain tolak — dan yang
    // diterima diam-diam itulah yang berbahaya.
    //
    // Uji ini sengaja TIDAK menyebut 0182. Menambah kunci workflow berarti menambah satu entri
    // konstanta dan satu migrasi baru, sementara migrasi yang sudah dirilis masuk manifest
    // terlindungi dan tidak boleh diedit lagi. Memaku uji ini ke 0182 akan membuat kedua penjaga
    // itu saling meniadakan pada kunci berikutnya: mengedit 0182 melanggar manifest, dan tidak
    // mengeditnya menggagalkan uji ini. Jadi yang dibaca adalah migrasi bernomor tertinggi yang
    // mendefinisikan constraint itu — yang terakhir dijalankan, karena migrasi berjalan terurut.
    const migrations = new URL("../migrations/", import.meta.url);
    const defining: Array<{ name: string; keys: string[] }> = [];
    for (const name of (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort()) {
      const sql = await readFile(new URL(name, migrations), "utf8");
      if (!sql.includes("organization_rollout_settings_workflow_key_known")) continue;
      const checkBody = /CHECK \(\s*workflow_key IN \(([\s\S]*?)\)\s*\)/.exec(sql)?.[1];
      if (!checkBody) continue;
      defining.push({ name, keys: [...checkBody.matchAll(/'([^']+)'/g)].map((match) => match[1]!) });
    }
    expect(defining.length, "satu migrasi pun harus mendefinisikan constraint kunci workflow")
      .toBeGreaterThan(0);
    const latest = defining.at(-1)!;
    expect(latest.keys, `migrasi ${latest.name}`).toEqual([...ORGANIZATION_WORKFLOW_KEYS]);
  });
});

describe("ORG-004 rantai yang diminta tiap workflow", () => {
  it("menyebut satu requirement untuk setiap kunci, tanpa celah", () => {
    expect(Object.keys(ORGANIZATION_WORKFLOW_AUTHORITY_REQUIREMENTS).sort())
      .toEqual([...ORGANIZATION_WORKFLOW_KEYS].sort());
  });

  it("menyimpan dua workflow yang bukan LINE_AND_UNIT, karena itulah yang pernah salah", () => {
    // Cuti Tanpa Gaji adalah ketidakcocokan yang ditemukan saat memperbaiki pratinjau: runtime
    // `UNIT_ONLY`, pratinjau `LINE_AND_UNIT` — bukan galat, melainkan rantai lain, dua langkah
    // alih-alih satu. Kasbon menambah kursi tetap di atas approver unit.
    expect(authorityRequirementOf("leave.unpaid")).toBe("UNIT_ONLY");
    expect(authorityRequirementOf("LOAN")).toBe("UNIT_AND_APPROVAL_SEATS");
    const others = ORGANIZATION_WORKFLOW_KEYS
      .filter((key) => key !== "leave.unpaid" && key !== "LOAN");
    expect(others.map(authorityRequirementOf)).toEqual(others.map(() => "LINE_AND_UNIT"));
  });
});
