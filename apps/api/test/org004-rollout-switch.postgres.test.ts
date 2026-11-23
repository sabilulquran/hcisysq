// ORG-004: saklar rollout terhadap skema sungguhan — lingkup yang memanjat, kunci workflow yang
// ditolak database, bagan yang menentukan approver, dan rantai yang sudah tersimpan yang tidak
// ikut bergerak. Berkas ini menjawab lima bukti yang diminta owner sebelum satu unit mana pun
// dipertimbangkan untuk `STRUCTURE`.
//
// Semua baris sintetis, satu transaksi yang selalu di-ROLLBACK, dan tidak satu pun kolom atasan
// lama (`employees.direct_manager_employee_id`) diisi: justru kosongnya kolom itu yang diuji.
//
// "Unit Pilot Sintetis" di bawah adalah nama fixture, bukan sebuah unit yayasan. Pemilihan unit
// pilot, `SHADOW`, dan go/no-go adalah gate ORG-004 yang semuanya masih terbuka (OPS-CLOSE-001
// L3); produksi tetap `LEGACY` di mana-mana dan berkas ini tidak menyalakan apa pun.

import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { AuthService } from "../src/modules/auth/service.js";
import { registerEmployeeLeaveRoutes } from "../src/modules/leave/employee-routes.js";
import { LeaveApprovalConfigurationError } from "../src/modules/leave/domain/approval-chain.js";
import { encodeWorkingWeekdays } from "../src/modules/leave/domain/working-calendar.js";
import { resolveLeaveAuthorities } from "../src/modules/leave/organization-authority.js";
import { registerOrganizationAdminRoutes } from "../src/modules/organization/admin-routes.js";
import { PostgresOrganizationRepository } from "../src/modules/organization/index.js";
import { leaveWorkflowKey } from "../src/modules/organization/workflow-keys.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

/** The routes own their transactions; BEGIN/COMMIT/ROLLBACK become savepoints of the test's. */
function savepointPool(client: PoolClient): Pool {
  let depth = 0;
  const run = async (text: string, values?: unknown[]) => {
    const statement = String(text).trim().toUpperCase();
    if (statement.startsWith("BEGIN")) return client.query(`SAVEPOINT org004_sp_${++depth}`);
    if (statement.startsWith("COMMIT")) {
      const name = `org004_sp_${depth}`;
      depth -= 1;
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (statement.startsWith("ROLLBACK")) {
      const name = `org004_sp_${depth}`;
      depth -= 1;
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    return client.query(text, values);
  };
  const handle = { query: run, release: () => {} };
  return { query: run, connect: async () => handle } as unknown as Pool;
}

type Person = "requester" | "childMember" | "outsider" | "head" | "successor" | "director"
  | "otherHead" | "hc";
const PEOPLE: readonly Person[] = [
  "requester", "childMember", "outsider", "head", "successor", "director", "otherHead", "hc",
];

/** Senin 5 Januari 2099, 08:00 Jakarta. Cutinya beberapa minggu sesudahnya. */
const NOW = new Date("2099-01-05T01:00:00.000Z");
const TODAY = "2099-01-05";
const FIRST_LEAVE = { startOn: "2099-02-02", endOn: "2099-02-03" };
/** Kuartal berikutnya, supaya pengajuan kedua tidak tertolak kuota alih-alih diuji. */
const SECOND_LEAVE = { startOn: "2099-05-04", endOn: "2099-05-05" };
const ANNUAL = leaveWorkflowKey("annual");
const UNPAID = leaveWorkflowKey("unpaid");

describe.skipIf(!allowed)("ORG-004 saklar rollout (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let repository: PostgresOrganizationRepository;
  let unitId = "";
  let changeSet = "";

  const people = {} as Record<Person, { employeeId: string; accountId: string; cookie: string }>;
  /** Kunci stabil bagan: satu unit pilot, satu anaknya, dan satu unit lain di luar pilot. */
  const nodes = { root: "", pilot: "", pilotChild: "", other: "" };
  const positions = { director: "", head: "", otherHead: "" };
  /** Baris incumbency kursi kepala unit pilot — satu-satunya baris yang bukti 1 sentuh. */
  let headIncumbency = "";

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  function call(who: Person, method: "GET" | "POST", url: string, payload?: object) {
    return app.inject({ method, url, headers: { cookie: people[who].cookie }, ...(payload ? { payload } : {}) });
  }

  /** Satu baris rollout. Tanpa `nodeKey` baris itu global (`node_key IS NULL`). */
  async function rolloutRow(
    workflowKey: string,
    mode: "LEGACY" | "SHADOW" | "STRUCTURE",
    nodeKey: string | null = null,
  ) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO organization_rollout_settings
         (id, workflow_key, node_key, mode, effective_from, reason, changed_by_account_id)
       VALUES ($1,$2,$3,$4,'2020-01-01','Uji ORG-004 sintetis',$5)`,
      [id, workflowKey, nodeKey, mode, people.hc.accountId],
    );
    return id;
  }

  /** Rantai yang dipakai runtime cuti, dengan kolom atasan lama dibaca apa adanya dari basis data. */
  async function runtimeChain(who: Person, workflowKey = ANNUAL, policyChain: "LINE_AND_UNIT" | "UNIT_ONLY" = "LINE_AND_UNIT") {
    const legacyRow = await client.query<{
      directManagerEmployeeId: string | null;
      unitApproverEmployeeId: string | null;
    }>(
      `SELECT e.direct_manager_employee_id AS "directManagerEmployeeId",
              u.leave_approver_employee_id AS "unitApproverEmployeeId"
         FROM employees e
         LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
        WHERE e.id = $1`,
      [people[who].employeeId],
    );
    return resolveLeaveAuthorities(client, {
      workflowKey,
      requesterEmployeeId: people[who].employeeId,
      effectiveDate: TODAY,
      legacy: {
        directManagerEmployeeId: legacyRow.rows[0]!.directManagerEmployeeId,
        unitApproverEmployeeId: legacyRow.rows[0]!.unitApproverEmployeeId,
      },
      policyChain,
      allowAccountPrincipal: true,
    });
  }

  /** Langkah persetujuan yang benar-benar tersimpan pada satu pengajuan, menurut urutannya. */
  async function storedSteps(requestId: string) {
    const rows = await client.query<{ approver: string | null; sources: string[]; order: number }>(
      `SELECT approver_employee_id AS "approver", sources, step_order AS "order"
         FROM leave_request_approval_steps
        WHERE leave_request_id = $1
        ORDER BY step_order`,
      [requestId],
    );
    return rows.rows;
  }

  async function submitAnnual(dates: { startOn: string; endOn: string }) {
    const response = await call("requester", "POST", "/leave/me/annual/submit", {
      ...dates, reason: "Acara keluarga sintetis", idempotencyKey: randomUUID(),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string };
  }

  beforeEach(async () => {
    vi.setSystemTime(NOW);
    client = await pool.connect();
    await client.query("BEGIN");
    const transactionPool = savepointPool(client);
    repository = new PostgresOrganizationRepository(client);

    unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'Unit Sintetis ORG-004')",
      [unitId, `org004-${unitId}`],
    );
    await client.query(
      `INSERT INTO leave_calendar_settings(singleton, timezone, working_weekday_mask)
       VALUES (true, 'Asia/Jakarta', $1)
       ON CONFLICT (singleton) DO UPDATE SET working_weekday_mask = EXCLUDED.working_weekday_mask`,
      [encodeWorkingWeekdays([1, 2, 3, 4, 5])],
    );
    await client.query("DELETE FROM leave_calendar_exceptions WHERE calendar_date BETWEEN '2099-01-01' AND '2099-06-30'");
    // Produksi menjalankan `LEGACY` di mana-mana; setiap uji memasang sendiri baris yang diperlukan.
    await client.query("DELETE FROM organization_rollout_settings");
    await client.query("UPDATE leave_critical_periods SET is_active = false WHERE starts_on <= '2099-06-30' AND ends_on >= '2099-01-01'");

    const config = {
      NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: databaseUrl!,
      AUTH_MODE: "local", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
    } as ApiConfig;
    const auth = new AuthService(transactionPool, config.AUTH_ENCRYPTION_KEY!, 8, false);
    for (const who of PEOPLE) {
      const employeeId = randomUUID();
      // `direct_manager_employee_id` sengaja tidak pernah diisi: bukti 5 bersandar pada itu.
      await client.query(
        `INSERT INTO employees(id, employee_number, full_name, status, started_on,
                               organizational_unit_id, leave_entitlement_group, management_scope)
         VALUES ($1, $2, $3, 'active', '2020-01-06', $4, 'non_education', 'MANAGED')`,
        [employeeId, `ORG004-${employeeId.slice(0, 8)}`, `Pegawai ${who}`, unitId],
      );
      const accountId = randomUUID();
      await client.query(
        "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
        [accountId, employeeId, `org004-${accountId}@example.invalid`],
      );
      const session = await auth.createSessionForAccountId(accountId, {
        ipAddress: "127.0.0.1", userAgent: "rollback-only-org004-test",
      });
      people[who] = { employeeId, accountId, cookie: session.setCookie.split(";")[0]! };
    }
    // Approver unit lama, supaya `LEGACY` gagal karena atasan langsung saja — bukan karena
    // kebetulan tidak ada apa pun yang dikonfigurasi.
    await client.query(
      "UPDATE organizational_units SET leave_approver_employee_id = $2 WHERE id = $1",
      [unitId, people.director.employeeId],
    );

    const roleId = randomUUID();
    await client.query(
      "INSERT INTO roles(id, role_key, name, is_system) VALUES ($1, $2, 'Peran sintetis ORG-004', false)",
      [roleId, `org004-${roleId}`],
    );
    await client.query(
      "INSERT INTO role_permissions(role_id, permission_key) VALUES ($1, 'organization.manage')",
      [roleId],
    );
    await client.query(
      "INSERT INTO account_role_assignments(id, account_id, role_id, scope_type) VALUES ($1, $2, $3, 'organization')",
      [randomUUID(), people.hc.accountId, roleId],
    );

    // Bagan yang terbit: yayasan, unit pilot, satu anak unit pilot, dan satu unit di luar pilot.
    changeSet = randomUUID();
    await client.query(
      `INSERT INTO organization_change_sets (id, name, effective_on, status, created_by_account_id, validated_at, published_at)
       VALUES ($1,'Struktur uji ORG-004','2020-01-01'::date,'PUBLISHED',$2, now(), now())`,
      [changeSet, people.hc.accountId],
    );
    for (const [key, parent, name] of [
      ["root", null, "Yayasan Sintetis"],
      ["pilot", "root", "Unit Pilot Sintetis"],
      ["pilotChild", "pilot", "Sub-unit Pilot Sintetis"],
      ["other", "root", "Unit Lain Sintetis"],
    ] as const) {
      nodes[key] = randomUUID();
      await client.query(
        `INSERT INTO organization_nodes (id, change_set_id, stable_key, name, node_type, parent_node_key, effective_from)
         VALUES ($1,$2,$3,$4,'UNIT',$5,'2020-01-01')`,
        [randomUUID(), changeSet, nodes[key], name, parent ? nodes[parent] : null],
      );
    }
    for (const [key, nodeKey, parent, title] of [
      ["director", "root", null, "Direktur Sintetis"],
      ["head", "pilot", "director", "Kepala Unit Pilot Sintetis"],
      ["otherHead", "other", "director", "Kepala Unit Lain Sintetis"],
    ] as const) {
      positions[key] = randomUUID();
      await client.query(
        `INSERT INTO organization_positions (id, change_set_id, stable_key, node_key, title, parent_position_key, effective_from, vacancy_policy)
         VALUES ($1,$2,$3,$4,$5,$6,'2020-01-01','BLOCK')`,
        [randomUUID(), changeSet, positions[key], nodes[nodeKey], title, parent ? positions[parent] : null],
      );
    }
    for (const [positionKey, who] of [
      ["director", "director"],
      ["head", "head"],
      ["otherHead", "otherHead"],
    ] as const) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO organization_incumbencies (id, change_set_id, position_key, employee_id, kind, effective_from)
         VALUES ($1,$2,$3,$4,'PRIMARY','2020-01-01')`,
        [id, changeSet, positions[positionKey], people[who].employeeId],
      );
      if (positionKey === "head") headIncumbency = id;
    }
    // Binding hanya pada unit pilot dan unit lain; anak unit pilot memanjat ke induknya.
    for (const [nodeKey, bindingType, target] of [
      ["pilot", "LEADER", "head"],
      ["pilot", "UNIT_APPROVER", "director"],
      ["other", "LEADER", "otherHead"],
      ["other", "UNIT_APPROVER", "director"],
    ] as const) {
      await client.query(
        `INSERT INTO organization_authority_bindings (id, change_set_id, subject_kind, subject_key, binding_type, target_position_key, vacancy_policy, effective_from)
         VALUES ($1,$2,'NODE',$3,$4,$5,'BLOCK','2020-01-01')`,
        [randomUUID(), changeSet, nodes[nodeKey], bindingType, positions[target]],
      );
    }
    for (const [who, nodeKey] of [
      ["requester", "pilot"],
      ["childMember", "pilotChild"],
      ["outsider", "other"],
    ] as const) {
      await client.query(
        `INSERT INTO organization_memberships (id, change_set_id, employee_id, node_key, is_primary, effective_from)
         VALUES ($1,$2,$3,$4,true,'2020-01-01')`,
        [randomUUID(), changeSet, people[who].employeeId, nodes[nodeKey]],
      );
    }

    app = Fastify({ logger: false });
    await registerEmployeeLeaveRoutes(app, transactionPool, config);
    await registerOrganizationAdminRoutes(app, transactionPool, config);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
      vi.useRealTimers();
    }
  });

  /**
   * Bukti 1. Pejabat diganti di satu tempat pada bagan — satu baris incumbency, satu kolom — dan
   * pengajuan berikutnya pergi ke pejabat yang sedang menjabat.
   *
   * Inilah alasan ORG-004 ada: hari ini pergantian kepala unit menuntut mengubah kolom atasan di
   * setiap pegawai yang dipimpinnya. Di sini tidak satu pun kolom itu disentuh, dan dibuktikan
   * memang begitu sesudahnya.
   */
  it("bukti 1: mengganti pejabat di satu tempat memindahkan approver pengajuan baru", async () => {
    await rolloutRow(ANNUAL, "STRUCTURE", nodes.pilot);

    const before = await submitAnnual(FIRST_LEAVE);
    expect((await storedSteps(before.id)).map((step) => step.approver)).toEqual([
      people.head.employeeId, people.director.employeeId,
    ]);

    // Satu baris bagan: kursi kepala unit pilot berpindah ke penggantinya.
    const swap = await client.query(
      "UPDATE organization_incumbencies SET employee_id = $2 WHERE id = $1",
      [headIncumbency, people.successor.employeeId],
    );
    expect(swap.rowCount).toBe(1);

    const after = await submitAnnual(SECOND_LEAVE);
    expect((await storedSteps(after.id)).map((step) => step.approver)).toEqual([
      people.successor.employeeId, people.director.employeeId,
    ]);

    // Tidak ada kolom atasan lama yang ikut diisi: pergantian itu betul-betul hanya di bagan.
    const legacy = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM employees WHERE direct_manager_employee_id IS NOT NULL AND organizational_unit_id = $1",
      [unitId],
    );
    expect(legacy.rows[0]!.count).toBe("0");
  });

  /**
   * Bukti 2. Pengajuan yang sudah masuk tetap memegang approver yang tercatat padanya
   * (snapshot-on-submit, `docs/domain/workflows/approval-engine.md`).
   *
   * Tidak ada uji lain yang membuktikannya untuk bagan ORG-004: `performance.postgres.test.ts`
   * (PERF-001-B) membuktikan hal yang sepadan untuk kolom atasan lama, bukan untuk bagan.
   */
  it("bukti 2: pengajuan yang sudah masuk tidak ikut bergerak saat bagan berubah", async () => {
    await rolloutRow(ANNUAL, "STRUCTURE", nodes.pilot);
    const request = await submitAnnual(FIRST_LEAVE);
    const atSubmit = await storedSteps(request.id);
    expect(atSubmit.map((step) => step.approver)).toEqual([
      people.head.employeeId, people.director.employeeId,
    ]);

    await client.query(
      "UPDATE organization_incumbencies SET employee_id = $2 WHERE id = $1",
      [headIncumbency, people.successor.employeeId],
    );
    // Bahkan bila unit pilot dikembalikan ke LEGACY sesudahnya.
    await client.query("DELETE FROM organization_rollout_settings");

    expect(await storedSteps(request.id)).toEqual(atSubmit);
    // Dan pengajuan itu masih menunggu pejabat yang tercatat padanya, bukan penggantinya.
    const held = await call("head", "GET", "/leave/approvals");
    expect(held.json().items.map((item: { requestId: string }) => item.requestId)).toContain(request.id);
    const successor = await call("successor", "GET", "/leave/approvals");
    expect(successor.json().items).toEqual([]);
  });

  /**
   * Bukti 3. Unit di luar pilot tidak ikut pindah, dan satu baris pada unit pilot sudah menutup
   * anak-anaknya.
   *
   * Orang jarang duduk pada node unit itu sendiri; mereka duduk di anak-anaknya. Tanpa pendakian,
   * memindahkan satu unit menuntut satu baris per node tempat orang benar-benar berada, dikali
   * setiap kunci workflow — dan baris yang terlupakan gagal diam-diam ke `LEGACY`.
   */
  it("bukti 3: satu baris pada unit pilot menutup anaknya dan tidak menyentuh unit lain", async () => {
    const settingId = await rolloutRow(ANNUAL, "STRUCTURE", nodes.pilot);

    await expect(repository.resolveRolloutSetting(ANNUAL, people.requester.employeeId, TODAY))
      .resolves.toEqual({
        mode: "STRUCTURE", matchedNodeKey: nodes.pilot, requesterNodeKey: nodes.pilot, settingId,
      });
    // Anak unit pilot ikut tercakup tanpa baris sendiri.
    await expect(repository.resolveRolloutSetting(ANNUAL, people.childMember.employeeId, TODAY))
      .resolves.toEqual({
        mode: "STRUCTURE", matchedNodeKey: nodes.pilot, requesterNodeKey: nodes.pilotChild, settingId,
      });
    // Unit lain tidak tersentuh sama sekali.
    await expect(repository.resolveRolloutSetting(ANNUAL, people.outsider.employeeId, TODAY))
      .resolves.toEqual({
        mode: "LEGACY", matchedNodeKey: null, requesterNodeKey: nodes.other, settingId: null,
      });
    // Dan workflow lain pada unit pilot pun tidak ikut pindah.
    await expect(repository.resolveRolloutSetting(UNPAID, people.requester.employeeId, TODAY))
      .resolves.toMatchObject({ mode: "LEGACY", matchedNodeKey: null, settingId: null });
  });

  it("bukti 3: anak dengan baris LEGACY eksplisit tetap LEGACY meski induknya STRUCTURE", async () => {
    const parent = await rolloutRow(ANNUAL, "STRUCTURE", nodes.pilot);
    const child = await rolloutRow(ANNUAL, "LEGACY", nodes.pilotChild);

    // Yang terdekat menang, jadi pendakian menambah kemampuan tanpa menghapus satu pun.
    await expect(repository.resolveRolloutSetting(ANNUAL, people.childMember.employeeId, TODAY))
      .resolves.toMatchObject({ mode: "LEGACY", matchedNodeKey: nodes.pilotChild, settingId: child });
    await expect(repository.resolveRolloutSetting(ANNUAL, people.requester.employeeId, TODAY))
      .resolves.toMatchObject({ mode: "STRUCTURE", matchedNodeKey: nodes.pilot, settingId: parent });
  });

  it("bukti 3: baris global adalah pilihan terakhir, kalah dari baris unit mana pun", async () => {
    const global = await rolloutRow(ANNUAL, "SHADOW", null);
    const pilot = await rolloutRow(ANNUAL, "STRUCTURE", nodes.pilot);

    await expect(repository.resolveRolloutSetting(ANNUAL, people.requester.employeeId, TODAY))
      .resolves.toMatchObject({ mode: "STRUCTURE", matchedNodeKey: nodes.pilot, settingId: pilot });
    await expect(repository.resolveRolloutSetting(ANNUAL, people.outsider.employeeId, TODAY))
      .resolves.toMatchObject({ mode: "SHADOW", matchedNodeKey: null, settingId: global });
  });

  /**
   * Bukti 5. Jalur pilot tidak bergantung pada kolom atasan lama.
   *
   * 95 kolom `direct_manager_employee_id` masih kosong di produksi. Kalau `STRUCTURE` diam-diam
   * tetap membutuhkannya, pilot tidak menyelesaikan apa pun. Kedua mode diuji berdampingan supaya
   * yang dibuktikan adalah selisihnya, bukan sekadar bahwa salah satunya jalan.
   */
  it("bukti 5: tanpa kolom atasan lama, STRUCTURE menghasilkan rantai penuh dan LEGACY menolak", async () => {
    const column = await client.query<{ directManagerEmployeeId: string | null }>(
      `SELECT direct_manager_employee_id AS "directManagerEmployeeId" FROM employees WHERE id = $1`,
      [people.requester.employeeId],
    );
    expect(column.rows[0]!.directManagerEmployeeId).toBeNull();

    await rolloutRow(ANNUAL, "STRUCTURE", nodes.pilot);
    const structure = await runtimeChain("requester");
    expect(structure.context.mode).toBe("STRUCTURE");
    expect(structure.approvalChain.map((step) => step.employeeId)).toEqual([
      people.head.employeeId, people.director.employeeId,
    ]);

    // Pemohon yang sama, bagan yang sama, hanya modenya yang berbeda.
    await client.query("DELETE FROM organization_rollout_settings");
    await expect(runtimeChain("requester")).rejects.toMatchObject({
      code: "DIRECT_MANAGER_MISSING",
    });
    await expect(runtimeChain("requester")).rejects.toBeInstanceOf(LeaveApprovalConfigurationError);
  });

  /**
   * `LEGACY` tidak berubah satu bit pun untuk orang lain. Produksi menjalankan `LEGACY` di
   * mana-mana, jadi inilah yang paling penting dijaga: dengan kolom atasan lama terisi, hasil
   * `LEGACY` sama persis seperti hari ini, dan baris rollout pada unit pilot tidak mengubahnya.
   */
  it("LEGACY tidak berubah untuk orang di luar pilot, dengan atau tanpa baris pada unit pilot", async () => {
    await client.query(
      "UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1",
      [people.outsider.employeeId, people.otherHead.employeeId],
    );

    const bare = await runtimeChain("outsider");
    await rolloutRow(ANNUAL, "STRUCTURE", nodes.pilot);
    const withPilotRow = await runtimeChain("outsider");

    expect(bare.context.mode).toBe("LEGACY");
    expect(bare.context.authoritativeSource).toBe("LEGACY");
    expect(bare.approvalChain.map((step) => step.employeeId)).toEqual([
      people.otherHead.employeeId, people.director.employeeId,
    ]);
    // Seluruh konteks yang tersimpan pada pengajuan, bukan hanya rantainya.
    expect(withPilotRow.approvalChain).toEqual(bare.approvalChain);
    expect(withPilotRow.context).toEqual(bare.context);
    expect(withPilotRow.context.mode).toBe("LEGACY");
    expect(withPilotRow.context.shadow).toBeUndefined();
    expect(withPilotRow.context.rolloutScope).toMatchObject({
      matchedNodeKey: null, requesterNodeKey: nodes.other, settingId: null,
    });
  });

  /**
   * Penjaga kedua atas kunci workflow: database menolaknya, bukan hanya route admin. Jalur
   * penulisan lain — psql, skrip, perbaikan data — ikut tertolak.
   */
  it("database menolak baris rollout dengan kunci workflow yang tidak dikenal", async () => {
    // Satu kunci yang dulu bisa tersimpan (`"LEAVE"`, bekas default route) dan satu salah ketik
    // yang masuk akal. Tiap percobaan di dalam savepoint sendiri, karena INSERT yang gagal
    // membatalkan transaksi berjalan.
    for (const workflowKey of ["LEAVE", "leave.anual", "OVERTIMEE"]) {
      await client.query("SAVEPOINT unknown_key");
      await expect(rolloutRow(workflowKey, "STRUCTURE", nodes.pilot), workflowKey)
        .rejects.toMatchObject({ constraint: "organization_rollout_settings_workflow_key_known" });
      await client.query("ROLLBACK TO SAVEPOINT unknown_key");
      await client.query("RELEASE SAVEPOINT unknown_key");
    }
    const rows = await client.query("SELECT 1 FROM organization_rollout_settings");
    expect(rows.rowCount).toBe(0);

    // Kunci yang dikenal tetap masuk, jadi constraint ini memang hanya menyaring yang asing.
    await rolloutRow(ANNUAL, "STRUCTURE", nodes.pilot);
    expect((await client.query("SELECT 1 FROM organization_rollout_settings")).rowCount).toBe(1);
  });

  /**
   * Pratinjau ORG-008-2 meminta persis apa yang diminta runtime (DRAFT D-R3). Sebelum ini ia
   * mengirim `requiredCapability: "leave.approve"` yang tidak pernah dikirim runtime cuti, dan
   * memakai kunci `"LEAVE"`; untuk kasus yang sebenarnya jalan, pratinjau akan menyebut rantainya
   * rusak dan Human Capital mengejar masalah yang tidak ada.
   */
  it("pratinjau menyelesaikan rantai yang sama dengan runtime untuk Cuti Tahunan", async () => {
    await rolloutRow(ANNUAL, "STRUCTURE", nodes.pilot);
    const runtime = await runtimeChain("requester");

    const response = await call("hc", "POST", "/admin/organization/resolution-preview", {
      employeeId: people.requester.employeeId, workflow: "LEAVE_ANNUAL", date: TODAY,
    });
    expect(response.statusCode, response.body).toBe(200);
    const preview = response.json();
    expect(preview.workflowKey).toBe(ANNUAL);
    expect(preview.steps.map((step: { employeeId: string }) => step.employeeId))
      .toEqual(runtime.approvalChain.map((step) => step.employeeId));
    expect(preview.steps.map((step: { authorityType: string }) => step.authorityType))
      .toEqual(runtime.context.authorities.map((item) => item.sources.join(" + ")));
    expect(preview.warnings).toEqual([]);
  });

  it("pratinjau Cuti Tanpa Gaji memakai UNIT_ONLY, seperti runtime", async () => {
    await rolloutRow(UNPAID, "STRUCTURE", nodes.pilot);
    const runtime = await runtimeChain("requester", UNPAID, "UNIT_ONLY");
    expect(runtime.approvalChain.map((step) => step.employeeId)).toEqual([people.director.employeeId]);

    const response = await call("hc", "POST", "/admin/organization/resolution-preview", {
      employeeId: people.requester.employeeId, workflow: "LEAVE_UNPAID", date: TODAY,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().workflowKey).toBe(UNPAID);
    expect(response.json().steps.map((step: { employeeId: string }) => step.employeeId))
      .toEqual(runtime.approvalChain.map((step) => step.employeeId));
  });
});
