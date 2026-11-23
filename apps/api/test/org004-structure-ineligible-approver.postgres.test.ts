// ORG-004 (DRAFT D-R5, 2026-11-23): kursi yang pejabatnya ada tetapi akunnya belum siap bukan
// kursi kosong, dan tidak boleh dilewati diam-diam.
//
// Yang diperiksa di sini adalah selisih antara dua keadaan yang sebelumnya diperlakukan sama oleh
// `vacancy_policy = CLIMB_TO_PARENT`:
//
//   1. kursi yang **tidak ada** yang menduduki → memanjat ke kursi induk, seperti dulu;
//   2. kursi yang pejabatnya tertulis, orangnya ada, tetapi akun HCIS-nya belum aktif → menolak,
//      dengan kalimat berbahasa Indonesia yang menyebut kursi dan orangnya.
//
// Sebelum perubahan ini keadaan kedua menghasilkan pengajuan yang tetap disetujui dengan satu
// langkah lebih sedikit: kepala unit hilang dari rantai, tidak pernah melihat pengajuannya, dan
// tidak ada satu pun pesan yang mengatakan demikian. Berkas ini memeriksa lewat route API yang
// sama dengan yang dipakai Portal Pegawai, lalu membaca apa yang benar-benar tersimpan.
//
// Bentuk fixture-nya mengikuti satu unit yayasan yang sungguhan, dengan nama dan id sintetis:
//
//   Yayasan Sintetis
//   └── Bidang Pendidikan Sintetis      ← kursi `Kepala Bidang` (penyetuju unit)
//       └── Taman Tahfizh Sintetis      ← kursi `Kepala` (kepala unit)
//           └── Guru Sintetis           ← pemohon duduk di sini, tanpa binding sendiri
//
// Seperti di produksi, setiap binding dan setiap kursi memakai `CLIMB_TO_PARENT`, dan kolom
// `direct_manager_employee_id` setiap pegawai kosong. Semua baris sintetis, satu transaksi per uji
// yang selalu di-ROLLBACK; tidak ada baris produksi yang dibaca maupun ditulis, dan produksi tetap
// `LEGACY` di mana-mana.

import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { AuthService } from "../src/modules/auth/service.js";
import { registerEmployeeLeaveRoutes } from "../src/modules/leave/employee-routes.js";
import { encodeWorkingWeekdays } from "../src/modules/leave/domain/working-calendar.js";
import { leaveWorkflowKey } from "../src/modules/organization/workflow-keys.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

/** Route-nya memegang transaksinya sendiri; BEGIN/COMMIT/ROLLBACK-nya menjadi savepoint uji ini. */
function savepointPool(client: PoolClient): Pool {
  let depth = 0;
  const run = async (text: string, values?: unknown[]) => {
    const statement = String(text).trim().toUpperCase().replace(/;$/, "").trim();
    if (statement === "BEGIN") return client.query(`SAVEPOINT ineligible_sp_${++depth}`);
    if (statement === "COMMIT") {
      const name = `ineligible_sp_${depth}`;
      depth -= 1;
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (statement === "ROLLBACK") {
      const name = `ineligible_sp_${depth}`;
      depth -= 1;
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    return client.query(text, values);
  };
  const handle = { query: run, release: () => {} };
  return { query: run, connect: async () => handle } as unknown as Pool;
}

const PEOPLE = ["kepalaUnit", "penyetujuUnit", "pelaksanaHarian", "guru"] as const;
type Person = (typeof PEOPLE)[number];

/** Senin 5 Januari 2099, 08:00 Jakarta. Cutinya jatuh jauh melewati pemberitahuan H-7. */
const NOW = new Date("2099-01-05T01:00:00.000Z");
const LEAVE = { startOn: "2099-02-02", endOn: "2099-02-03" };
const ANNUAL = leaveWorkflowKey("annual");

describe.skipIf(!allowed)("ORG-004 penyetuju yang belum layak dalam mode STRUCTURE (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let unitId = "";
  let changeSet = "";

  const people = {} as Record<Person, { employeeId: string; accountId: string; cookie: string }>;
  const nodes = { yayasan: "", bidang: "", unit: "", guru: "" };
  const positions = { kepalaBidang: "", kepalaUnit: "" };

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  function submit(who: Person) {
    return app.inject({
      method: "POST",
      url: "/leave/me/annual/submit",
      headers: { cookie: people[who].cookie },
      payload: { ...LEAVE, reason: "Acara keluarga sintetis", idempotencyKey: randomUUID() },
    });
  }

  async function storedSteps(requestId: string) {
    const rows = await client.query<{ approver: string | null; sources: string[] }>(
      `SELECT approver_employee_id AS "approver", sources
         FROM leave_request_approval_steps WHERE leave_request_id = $1 ORDER BY step_order`,
      [requestId],
    );
    return rows.rows;
  }

  /** Berapa pengajuan yang benar-benar tersimpan untuk pemohon, apa pun statusnya. */
  async function storedRequestsOf(who: Person) {
    const rows = await client.query<{ id: string }>(
      "SELECT id FROM leave_requests WHERE employee_id = $1", [people[who].employeeId],
    );
    return rows.rows;
  }

  async function setAccountStatus(who: Person, status: "active" | "invited") {
    await client.query("UPDATE accounts SET status = $2 WHERE id = $1", [people[who].accountId, status]);
  }

  async function setVacancyPolicy(policy: "CLIMB_TO_PARENT" | "BLOCK") {
    await client.query(
      "UPDATE organization_authority_bindings SET vacancy_policy = $2 WHERE change_set_id = $1",
      [changeSet, policy],
    );
    await client.query(
      "UPDATE organization_positions SET vacancy_policy = $2 WHERE change_set_id = $1",
      [changeSet, policy],
    );
  }

  beforeEach(async () => {
    vi.setSystemTime(NOW);
    client = await pool.connect();
    await client.query("BEGIN");
    const transactionPool = savepointPool(client);

    unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'Taman Tahfizh Sintetis')",
      [unitId, `org004-ineligible-${unitId}`],
    );
    await client.query(
      `INSERT INTO leave_calendar_settings(singleton, timezone, working_weekday_mask)
       VALUES (true, 'Asia/Jakarta', $1)
       ON CONFLICT (singleton) DO UPDATE SET working_weekday_mask = EXCLUDED.working_weekday_mask`,
      [encodeWorkingWeekdays([1, 2, 3, 4, 5])],
    );
    await client.query(
      "DELETE FROM leave_calendar_exceptions WHERE calendar_date BETWEEN '2099-01-01' AND '2099-12-31'",
    );
    // Produksi menjalankan `LEGACY` di mana-mana; uji ini memasang sendiri baris yang diperlukan.
    await client.query("DELETE FROM organization_rollout_settings");
    await client.query(
      "UPDATE leave_critical_periods SET is_active = false WHERE starts_on <= '2099-12-31' AND ends_on >= '2099-01-01'",
    );

    const config = {
      NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: databaseUrl!,
      AUTH_MODE: "local", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
    } as ApiConfig;
    const auth = new AuthService(transactionPool, config.AUTH_ENCRYPTION_KEY!, 8, false);
    for (const who of PEOPLE) {
      const employeeId = randomUUID();
      // `direct_manager_employee_id` sengaja tidak pernah diisi, seperti di unit yang diukur.
      await client.query(
        `INSERT INTO employees(id, employee_number, full_name, status, started_on,
                               organizational_unit_id, leave_entitlement_group, management_scope)
         VALUES ($1, $2, $3, 'active', '2020-01-06', $4, 'non_education', 'MANAGED')`,
        [employeeId, `ORG004I-${employeeId.slice(0, 8)}`, `Pegawai ${who}`, unitId],
      );
      const accountId = randomUUID();
      await client.query(
        `INSERT INTO accounts(id, employee_id, email, principal_type, status)
         VALUES ($1, $2, $3, 'EMPLOYEE', 'active')`,
        [accountId, employeeId, `org004-ineligible-${accountId}@example.invalid`],
      );
      const session = await auth.createSessionForAccountId(accountId, {
        ipAddress: "127.0.0.1", userAgent: "rollback-only-org004-ineligible-test",
      });
      people[who] = { employeeId, accountId, cookie: session.setCookie.split(";")[0]! };
    }
    await client.query(
      "UPDATE organizational_units SET leave_approver_employee_id = $2 WHERE id = $1",
      [unitId, people.penyetujuUnit.employeeId],
    );

    changeSet = randomUUID();
    await client.query(
      `INSERT INTO organization_change_sets
         (id, name, effective_on, status, created_by_account_id, validated_at, published_at)
       VALUES ($1,'Struktur uji ketidaklayakan ORG-004','2020-01-01'::date,'PUBLISHED',$2, now(), now())`,
      [changeSet, people.penyetujuUnit.accountId],
    );
    for (const [key, parent, name] of [
      ["yayasan", null, "Yayasan Sintetis"],
      ["bidang", "yayasan", "Bidang Pendidikan Sintetis"],
      ["unit", "bidang", "Taman Tahfizh Sintetis"],
      ["guru", "unit", "Guru Sintetis"],
    ] as const) {
      nodes[key] = randomUUID();
      await client.query(
        `INSERT INTO organization_nodes
           (id, change_set_id, stable_key, name, node_type, parent_node_key, effective_from)
         VALUES ($1,$2,$3,$4,'UNIT',$5,'2020-01-01')`,
        [randomUUID(), changeSet, nodes[key], name, parent ? nodes[parent] : null],
      );
    }
    for (const [key, nodeKey, parent, title] of [
      ["kepalaBidang", "bidang", null, "Kepala Bidang Pendidikan Sintetis"],
      ["kepalaUnit", "unit", "kepalaBidang", "Kepala Taman Tahfizh Sintetis"],
    ] as const) {
      positions[key] = randomUUID();
      await client.query(
        `INSERT INTO organization_positions
           (id, change_set_id, stable_key, node_key, title, parent_position_key, effective_from, vacancy_policy)
         VALUES ($1,$2,$3,$4,$5,$6,'2020-01-01','CLIMB_TO_PARENT')`,
        [randomUUID(), changeSet, positions[key], nodes[nodeKey], title, parent ? positions[parent] : null],
      );
    }
    for (const [positionKey, who] of [
      ["kepalaBidang", "penyetujuUnit"],
      ["kepalaUnit", "kepalaUnit"],
    ] as const) {
      await client.query(
        `INSERT INTO organization_incumbencies
           (id, change_set_id, position_key, employee_id, kind, effective_from)
         VALUES ($1,$2,$3,$4,'PRIMARY','2020-01-01')`,
        [randomUUID(), changeSet, positions[positionKey], people[who].employeeId],
      );
    }
    // Seperti di produksi: setiap binding `CLIMB_TO_PARENT`.
    for (const [nodeKey, bindingType, target] of [
      ["unit", "LEADER", "kepalaUnit"],
      ["unit", "UNIT_APPROVER", "kepalaBidang"],
    ] as const) {
      await client.query(
        `INSERT INTO organization_authority_bindings
           (id, change_set_id, subject_kind, subject_key, binding_type, target_position_key, vacancy_policy, effective_from)
         VALUES ($1,$2,'NODE',$3,$4,$5,'CLIMB_TO_PARENT','2020-01-01')`,
        [randomUUID(), changeSet, nodes[nodeKey], bindingType, positions[target]],
      );
    }
    for (const [who, nodeKey] of [
      ["kepalaUnit", "unit"],
      ["pelaksanaHarian", "unit"],
      ["guru", "guru"],
      ["penyetujuUnit", "bidang"],
    ] as const) {
      await client.query(
        `INSERT INTO organization_memberships
           (id, change_set_id, employee_id, node_key, is_primary, effective_from)
         VALUES ($1,$2,$3,$4,true,'2020-01-01')`,
        [randomUUID(), changeSet, people[who].employeeId, nodes[nodeKey]],
      );
    }
    await client.query(
      `INSERT INTO organization_rollout_settings
         (id, workflow_key, node_key, mode, effective_from, reason, changed_by_account_id)
       VALUES ($1,$2,$3,'STRUCTURE','2020-01-01','Uji ketidaklayakan ORG-004 sintetis',$4)`,
      [randomUUID(), ANNUAL, nodes.unit, people.penyetujuUnit.accountId],
    );

    app = Fastify({ logger: false });
    await registerEmployeeLeaveRoutes(app, transactionPool, config);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
      vi.useRealTimers();
    }
  });

  /**
   * Yang dikejar seluruh berkas ini. Kepala unit yang akunnya masih `invited` — keadaan 74 akun
   * pegawai hari ini — dengan binding `CLIMB_TO_PARENT`, yaitu kebijakan setiap binding dan setiap
   * kursi pada bagan terbit.
   */
  it("menolak kepala unit yang akunnya belum aktif, meskipun kebijakannya CLIMB_TO_PARENT", async () => {
    await setAccountStatus("kepalaUnit", "invited");

    const refused = await submit("guru");
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().code).toBe("APPROVER_ACCOUNT_NOT_READY");
    // Pesannya menyebut orangnya dan kursinya, dan mengatakan apa yang harus terjadi.
    expect(refused.json().message).toContain("Pegawai kepalaUnit");
    expect(refused.json().message).toContain("Kepala Taman Tahfizh Sintetis");
    expect(refused.json().message).toContain("belum aktif");

    // Dan tidak ada rantai yang tersimpan tanpa dia di dalamnya: pengajuannya tidak jadi sama
    // sekali, bukan jadi dengan satu langkah lebih sedikit.
    expect(await storedRequestsOf("guru")).toHaveLength(0);
    const anyStep = await client.query(
      `SELECT 1 FROM leave_request_approval_steps s
         JOIN leave_requests r ON r.id = s.leave_request_id
        WHERE r.employee_id = $1`,
      [people.guru.employeeId],
    );
    expect(anyStep.rowCount).toBe(0);
  });

  it("menolak dengan cara yang sama ketika kebijakannya BLOCK", async () => {
    await setVacancyPolicy("BLOCK");
    await setAccountStatus("kepalaUnit", "invited");

    const refused = await submit("guru");
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().code).toBe("APPROVER_ACCOUNT_NOT_READY");
    expect(refused.json().message).toContain("Pegawai kepalaUnit");
    expect(refused.json().message).toContain("Kepala Taman Tahfizh Sintetis");
  });

  /**
   * Sisi lain garisnya. Kursi yang benar-benar tidak ada yang menduduki tetap memanjat, karena
   * itulah arti `CLIMB_TO_PARENT` yang memang dikonfigurasikan yayasan.
   */
  it("tetap memanjat melewati kursi yang benar-benar kosong", async () => {
    await client.query(
      "DELETE FROM organization_incumbencies WHERE change_set_id = $1 AND position_key = $2",
      [changeSet, positions.kepalaUnit],
    );

    const accepted = await submit("guru");
    expect(accepted.statusCode, accepted.body).toBe(201);
    const body = accepted.json() as {
      id: string;
      approvalChain: Array<{ employeeId: string | null }>;
    };
    expect(body.approvalChain.map((step) => step.employeeId))
      .toEqual([people.penyetujuUnit.employeeId]);

    const steps = await storedSteps(body.id);
    expect(steps.map((step) => step.approver)).toEqual([people.penyetujuUnit.employeeId]);
    expect(steps[0]!.sources).toEqual(["DIRECT_MANAGER", "UNIT_APPROVER"]);
  });

  /**
   * Penolakannya baru terjadi setelah kedua jenis pejabat dicoba. Pelaksana harian yang akunnya
   * aktif tetap menyelamatkan kursinya — itulah jalan keluar yang memang disediakan bagan, dan
   * aturan baru ini tidak boleh menutupnya.
   */
  it("membiarkan pelaksana harian yang akunnya aktif menyelamatkan kursi itu", async () => {
    await setAccountStatus("kepalaUnit", "invited");
    await client.query(
      `INSERT INTO organization_incumbencies
         (id, change_set_id, position_key, employee_id, kind, effective_from, reason)
       VALUES ($1,$2,$3,$4,'ACTING','2020-01-01','Mandat pelaksana harian sintetis')`,
      [randomUUID(), changeSet, positions.kepalaUnit, people.pelaksanaHarian.employeeId],
    );

    const accepted = await submit("guru");
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect((accepted.json() as { approvalChain: Array<{ employeeId: string | null }> })
      .approvalChain.map((step) => step.employeeId))
      .toEqual([people.pelaksanaHarian.employeeId, people.penyetujuUnit.employeeId]);
  });

  /** Penyetuju yang memang sudah siap tetap dirutekan seperti biasa: dua langkah, dua orang. */
  it("merutekan seperti biasa ketika kedua penyetujunya sudah siap", async () => {
    const accepted = await submit("guru");
    expect(accepted.statusCode, accepted.body).toBe(201);
    const body = accepted.json() as {
      id: string;
      approvalChain: Array<{ employeeId: string | null }>;
    };
    expect(body.approvalChain.map((step) => step.employeeId)).toEqual([
      people.kepalaUnit.employeeId, people.penyetujuUnit.employeeId,
    ]);
    expect((await storedSteps(body.id)).map((step) => step.approver)).toEqual([
      people.kepalaUnit.employeeId, people.penyetujuUnit.employeeId,
    ]);
  });

  /**
   * `LEGACY` adalah mode yang produksi jalankan hari ini, dan tidak satu huruf pun di dalamnya
   * berubah. Rantainya tidak lewat resolver sama sekali, jadi akun yang belum aktif tetap ketahuan
   * di `hydrateApprovalChain`, dengan kode dan kalimat yang sama persis seperti sebelumnya.
   */
  describe("LEGACY tidak berubah", () => {
    beforeEach(async () => {
      await client.query("DELETE FROM organization_rollout_settings");
      await client.query(
        "UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1",
        [people.guru.employeeId, people.kepalaUnit.employeeId],
      );
    });

    it("menolak akun yang belum aktif dengan kalimat `LEGACY` yang persis sama", async () => {
      await setAccountStatus("kepalaUnit", "invited");
      const refused = await submit("guru");
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toEqual({
        code: "APPROVER_ACCOUNT_NOT_READY",
        message: "Akun approver Pegawai kepalaUnit belum aktif.",
      });
    });

    it("merutekan dari kedua kolom lama, tanpa membaca bagan sama sekali", async () => {
      // Kepala unit pada bagan dikosongkan: kalau `LEGACY` ikut membaca bagan, uji ini berubah.
      await client.query(
        "DELETE FROM organization_incumbencies WHERE change_set_id = $1 AND position_key = $2",
        [changeSet, positions.kepalaUnit],
      );
      const accepted = await submit("guru");
      expect(accepted.statusCode, accepted.body).toBe(201);
      const body = accepted.json() as {
        id: string;
        approvalChain: Array<{ employeeId: string | null }>;
      };
      expect(body.approvalChain.map((step) => step.employeeId)).toEqual([
        people.kepalaUnit.employeeId, people.penyetujuUnit.employeeId,
      ]);
      const mode = await client.query<{ mode: string | null }>(
        "SELECT validation_summary #>> '{authorityResolution,mode}' AS mode FROM leave_requests WHERE id = $1",
        [body.id],
      );
      expect(mode.rows[0]!.mode).toBe("LEGACY");
    });
  });
});
