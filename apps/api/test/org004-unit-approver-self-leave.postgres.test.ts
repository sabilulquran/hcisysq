// ORG-004 D-R6 / APR-001: penyetuju unit mengajukan cutinya sendiri.
//
// Audit kesiapan 2026-11-24 (skenario B29) menemukan bahwa orang ini tidak dapat mengajukan cuti
// sama sekali. Kursi penyetuju unitnya memang dipegang dirinya, rungnya dibuang — itu yang diminta
// APR-001 ("No self-approval") dan LEAVE-004-G ("self-unit-approval is not added") — tetapi
// pemeriksaan di hilir membaca rantai tanpa rung `UNIT_APPROVER` sebagai "approver unit belum
// dikonfigurasi" dan menjawab `409 UNIT_APPROVER_MISSING`. Pesannya menyalahkan konfigurasi yang
// justru benar, dan tidak ada yang dapat diperbaiki HC untuk melepaskannya.
//
// Di produksi ini bukan kasus sudut: delapan dari sembilan pegawai yang menjadi penyetuju unit
// adalah penyetuju bagi unitnya sendiri (pengukuran baca-saja 2026-11-24).
//
// Bentuk fixture-nya meniru bagan produksi: kursi `Kepala Bidang` memimpin node bidang **dan**
// menjadi penyetuju unit bagi node bidang itu sendiri serta bagi unit di bawahnya.
//
//   Yayasan Uji            ← kursi `Ketua`
//   └── Bidang Uji         ← kursi `Kepala Bidang`; LEADER dan UNIT_APPROVER keduanya ke kursi itu
//       └── Unit Uji       ← kursi `Kepala Unit`; UNIT_APPROVER ke `Kepala Bidang`
//
// Semua baris sintetis, satu transaksi per uji yang selalu di-ROLLBACK.

import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { AuthService } from "../src/modules/auth/service.js";
import { registerEmployeeLeaveRoutes } from "../src/modules/leave/employee-routes.js";
import { registerLeaveAdminRoutes } from "../src/modules/leave/admin-routes.js";
import { encodeWorkingWeekdays } from "../src/modules/leave/domain/working-calendar.js";
import { resolveLeaveAuthorities } from "../src/modules/leave/organization-authority.js";
import { leaveWorkflowKey } from "../src/modules/organization/workflow-keys.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

/** Route memegang transaksinya sendiri; BEGIN/COMMIT/ROLLBACK-nya menjadi savepoint uji ini. */
function savepointPool(client: PoolClient): Pool {
  let depth = 0;
  const run = async (text: string, values?: unknown[]) => {
    const statement = String(text).trim().toUpperCase().replace(/;$/, "").trim();
    if (statement === "BEGIN") return client.query(`SAVEPOINT self_sp_${++depth}`);
    if (statement === "COMMIT") {
      const name = `self_sp_${depth}`;
      depth -= 1;
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (statement === "ROLLBACK") {
      const name = `self_sp_${depth}`;
      depth -= 1;
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    return client.query(text, values);
  };
  const handle = { query: run, release: () => {} };
  return { query: run, connect: async () => handle } as unknown as Pool;
}

const PEOPLE = ["ketua", "kabid", "kepalaUnit", "guru"] as const;
type Person = (typeof PEOPLE)[number];

const NOW = new Date("2099-01-05T01:00:00.000Z");
const TODAY = "2099-01-05";
const LEAVE = { startOn: "2099-02-02", endOn: "2099-02-03" };
const ANNUAL = leaveWorkflowKey("annual");

describe.skipIf(!allowed)("ORG-004 D-R6: penyetuju unit mengajukan cutinya sendiri (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let bidangUnitId = "";
  let unitUnitId = "";
  let changeSet = "";

  const people = {} as Record<Person, { employeeId: string; accountId: string; cookie: string }>;
  const nodes = { yayasan: "", bidang: "", unit: "" };
  const positions = { ketua: "", kepalaBidang: "", kepalaUnit: "" };

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  function call(who: Person, method: "GET" | "POST", url: string, payload?: object) {
    return app.inject({
      method, url, headers: { cookie: people[who].cookie }, ...(payload ? { payload } : {}),
    });
  }

  function submitAnnual(who: Person, dates = LEAVE) {
    return call(who, "POST", "/leave/me/annual/submit", {
      ...dates, reason: "Keperluan keluarga sintetis", idempotencyKey: randomUUID(),
    });
  }

  async function storedSteps(requestId: string) {
    const rows = await client.query<{ approver: string | null; sources: string[]; status: string }>(
      `SELECT approver_employee_id AS approver, sources, status
         FROM leave_request_approval_steps WHERE leave_request_id = $1 ORDER BY step_order`,
      [requestId],
    );
    return rows.rows;
  }

  /** Rantai yang runtime susun, dengan kolom lama dibaca apa adanya dari basis data. */
  async function runtimeChain(who: Person, policyChain: "LINE_AND_UNIT" | "UNIT_ONLY" = "LINE_AND_UNIT") {
    const legacyRow = await client.query<{
      directManagerEmployeeId: string | null; unitApproverEmployeeId: string | null;
    }>(
      `SELECT e.direct_manager_employee_id AS "directManagerEmployeeId",
              u.leave_approver_employee_id AS "unitApproverEmployeeId"
         FROM employees e LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
        WHERE e.id = $1`,
      [people[who].employeeId],
    );
    return resolveLeaveAuthorities(client, {
      workflowKey: ANNUAL,
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

  async function switchToStructure(nodeKey: string) {
    await client.query(
      `INSERT INTO organization_rollout_settings
         (id, workflow_key, node_key, mode, effective_from, reason, changed_by_account_id)
       VALUES ($1,$2,$3,'STRUCTURE','2020-01-01','Uji ORG-004 D-R6',$4)`,
      [randomUUID(), ANNUAL, nodeKey, people.ketua.accountId],
    );
  }

  beforeEach(async () => {
    vi.setSystemTime(NOW);
    client = await pool.connect();
    await client.query("BEGIN");
    const transactionPool = savepointPool(client);

    bidangUnitId = randomUUID();
    unitUnitId = randomUUID();
    for (const [id, name] of [[bidangUnitId, "Bidang Uji D-R6"], [unitUnitId, "Unit Uji D-R6"]] as const) {
      await client.query(
        "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, $3)",
        [id, `org004-dr6-${id}`, name],
      );
    }
    await client.query(
      `INSERT INTO leave_calendar_settings(singleton, timezone, working_weekday_mask)
       VALUES (true, 'Asia/Jakarta', $1)
       ON CONFLICT (singleton) DO UPDATE SET working_weekday_mask = EXCLUDED.working_weekday_mask`,
      [encodeWorkingWeekdays([1, 2, 3, 4, 5])],
    );
    await client.query(
      "DELETE FROM leave_calendar_exceptions WHERE calendar_date BETWEEN '2099-01-01' AND '2099-12-31'",
    );
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
      const unitId = who === "ketua" || who === "kabid" ? bidangUnitId : unitUnitId;
      await client.query(
        `INSERT INTO employees(id, employee_number, full_name, status, started_on,
                               organizational_unit_id, leave_entitlement_group, management_scope)
         VALUES ($1, $2, $3, 'active', '2020-01-06', $4, 'non_education', 'MANAGED')`,
        [employeeId, `DR6-${employeeId.slice(0, 8)}`, `Pegawai ${who}`, unitId],
      );
      const accountId = randomUUID();
      await client.query(
        `INSERT INTO accounts(id, employee_id, email, principal_type, status)
         VALUES ($1, $2, $3, 'EMPLOYEE', 'active')`,
        [accountId, employeeId, `org004-dr6-${accountId}@example.invalid`],
      );
      const session = await auth.createSessionForAccountId(accountId, {
        ipAddress: "127.0.0.1", userAgent: "rollback-only-org004-dr6-test",
      });
      people[who] = { employeeId, accountId, cookie: session.setCookie.split(";")[0]! };
    }

    // Kolom lama, persis sebentuk produksi: penyetuju unit bidang adalah kepala bidang sendiri.
    await client.query("UPDATE organizational_units SET leave_approver_employee_id = $2 WHERE id = $1",
      [bidangUnitId, people.kabid.employeeId]);
    await client.query("UPDATE organizational_units SET leave_approver_employee_id = $2 WHERE id = $1",
      [unitUnitId, people.kabid.employeeId]);
    await client.query("UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1",
      [people.kabid.employeeId, people.ketua.employeeId]);
    await client.query("UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1",
      [people.guru.employeeId, people.kepalaUnit.employeeId]);

    changeSet = randomUUID();
    await client.query(
      `INSERT INTO organization_change_sets
         (id, name, effective_on, status, created_by_account_id, validated_at, published_at)
       VALUES ($1,'Struktur uji ORG-004 D-R6','2020-01-01'::date,'PUBLISHED',$2, now(), now())`,
      [changeSet, people.ketua.accountId],
    );
    for (const [key, parent, name] of [
      ["yayasan", null, "Yayasan Uji"],
      ["bidang", "yayasan", "Bidang Uji"],
      ["unit", "bidang", "Unit Uji"],
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
      ["ketua", "yayasan", null, "Ketua Uji"],
      ["kepalaBidang", "bidang", "ketua", "Kepala Bidang Uji"],
      ["kepalaUnit", "unit", "kepalaBidang", "Kepala Unit Uji"],
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
      ["ketua", "ketua"], ["kepalaBidang", "kabid"], ["kepalaUnit", "kepalaUnit"],
    ] as const) {
      await client.query(
        `INSERT INTO organization_incumbencies
           (id, change_set_id, position_key, employee_id, kind, effective_from)
         VALUES ($1,$2,$3,$4,'PRIMARY','2020-01-01')`,
        [randomUUID(), changeSet, positions[positionKey], people[who].employeeId],
      );
    }
    // Node bidang memimpin dirinya sendiri DAN menjadi penyetuju unit bagi dirinya sendiri.
    for (const [nodeKey, bindingType, target] of [
      ["bidang", "LEADER", "kepalaBidang"],
      ["bidang", "UNIT_APPROVER", "kepalaBidang"],
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
      ["ketua", "yayasan"], ["kabid", "bidang"], ["kepalaUnit", "unit"], ["guru", "unit"],
    ] as const) {
      await client.query(
        `INSERT INTO organization_memberships
           (id, change_set_id, employee_id, node_key, is_primary, effective_from)
         VALUES ($1,$2,$3,$4,true,'2020-01-01')`,
        [randomUUID(), changeSet, people[who].employeeId, nodes[nodeKey]],
      );
    }

    // Indikator kesiapan di layar Konfigurasi Cuti dibaca lewat route aslinya, jadi `ketua`
    // merangkap pembaca HC di uji ini.
    const roleId = randomUUID();
    await client.query(
      "INSERT INTO roles(id, role_key, name, is_system) VALUES ($1,$2,'Peran sintetis D-R6', false)",
      [roleId, `dr6-${roleId}`],
    );
    for (const permission of ["leave.configuration.manage", "approvals.policy.manage"]) {
      await client.query(
        "INSERT INTO role_permissions(role_id, permission_key) VALUES ($1,$2)",
        [roleId, permission],
      );
    }
    await client.query(
      "INSERT INTO account_role_assignments(id, account_id, role_id, scope_type) VALUES ($1,$2,$3,'organization')",
      [randomUUID(), people.ketua.accountId, roleId],
    );

    app = Fastify({ logger: false });
    await registerEmployeeLeaveRoutes(app, transactionPool, config);
    await registerLeaveAdminRoutes(app, transactionPool, config);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
      vi.useRealTimers();
    }
  });

  it("fixture: penyetuju unit bidang memang dirinya sendiri, pada kolom lama dan pada bagan", async () => {
    const legacy = await client.query<{ approver: string }>(
      "SELECT leave_approver_employee_id AS approver FROM organizational_units WHERE id = $1",
      [bidangUnitId],
    );
    expect(legacy.rows[0]!.approver).toBe(people.kabid.employeeId);
    const binding = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM organization_authority_bindings
        WHERE change_set_id = $1 AND subject_key = $2 AND binding_type = 'UNIT_APPROVER'
          AND target_position_key = $3`,
      [changeSet, nodes.bidang, positions.kepalaBidang],
    );
    expect(binding.rows[0]!.count).toBe("1");
  });

  it("LEGACY: pengajuannya diterima dan berhenti di atasan langsungnya, bukan ditolak", async () => {
    const response = await submitAnnual("kabid");
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json() as { id: string; approvalChain: Array<{ employeeId: string }> };
    expect(body.approvalChain.map((step) => step.employeeId)).toEqual([people.ketua.employeeId]);

    const steps = await storedSteps(body.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.approver).toBe(people.ketua.employeeId);
    expect(steps[0]!.sources).toEqual(["DIRECT_MANAGER"]);
  });

  it("LEGACY: dirinya sendiri tidak pernah masuk rantai, dan atasannya memutuskan sampai selesai", async () => {
    const submitted = (await submitAnnual("kabid")).json() as { id: string };
    const own = await call("kabid", "GET", "/leave/approvals");
    expect((own.json() as { items: unknown[] }).items).toHaveLength(0);

    const inbox = (await call("ketua", "GET", "/leave/approvals")).json() as {
      items: Array<{ stepId: string; requestId: string }>;
    };
    const step = inbox.items.find((item) => item.requestId === submitted.id);
    expect(step).toBeDefined();
    const decided = await call("ketua", "POST", `/leave/approvals/${step!.stepId}/decision`, { decision: "approve" });
    expect(decided.statusCode, decided.body).toBe(200);
    const status = await client.query<{ status: string }>(
      "SELECT status FROM leave_requests WHERE id = $1", [submitted.id],
    );
    expect(status.rows[0]!.status).toBe("approved");
  });

  it("STRUCTURE: rantainya memanjat ke kursi induk, tanpa kolom atasan lama", async () => {
    await switchToStructure(nodes.bidang);
    await client.query("UPDATE employees SET direct_manager_employee_id = NULL WHERE id = $1",
      [people.kabid.employeeId]);

    const chain = await runtimeChain("kabid");
    expect(chain.context.mode).toBe("STRUCTURE");
    expect(chain.approvalChain.map((step) => step.employeeId)).toEqual([people.ketua.employeeId]);

    const response = await submitAnnual("kabid");
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json() as { approvalChain: Array<{ employeeId: string }> };
    expect(body.approvalChain.map((step) => step.employeeId)).toEqual([people.ketua.employeeId]);
  });

  it("kedua mode memberi rantai yang sama untuk orang ini", async () => {
    const legacy = await runtimeChain("kabid");
    expect(legacy.context.mode).toBe("LEGACY");
    await switchToStructure(nodes.bidang);
    const structure = await runtimeChain("kabid");
    expect(structure.context.mode).toBe("STRUCTURE");
    expect(structure.approvalChain.map((step) => step.employeeId))
      .toEqual(legacy.approvalChain.map((step) => step.employeeId));
  });

  it("pegawai biasa di bawahnya tetap melewati dua langkah, jadi rungnya tidak hilang untuk semua orang", async () => {
    const response = await submitAnnual("guru");
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json() as { approvalChain: Array<{ employeeId: string }> };
    expect(body.approvalChain.map((step) => step.employeeId))
      .toEqual([people.kepalaUnit.employeeId, people.kabid.employeeId]);
  });

  it("UNIT_ONLY tidak punya rung lain, jadi keadaan yang sama ditolak — dan menyebut sebabnya", async () => {
    await expect(runtimeChain("kabid", "UNIT_ONLY")).rejects.toMatchObject({
      code: "UNIT_APPROVER_SELF",
    });
    await switchToStructure(nodes.bidang);
    await expect(runtimeChain("kabid", "UNIT_ONLY")).rejects.toMatchObject({
      code: "UNIT_APPROVER_SELF",
    });
  });

  /**
   * ORG-004 D-R6: layar HC dan rute yang benar-benar merutekan harus membaca sumber yang sama.
   * Sebelum ini layar Konfigurasi Cuti menghitung kolom atasan lama untuk semua orang, sehingga
   * unit yang sudah pindah ke bagan tetap terbaca "belum siap" dan HC diminta mengisi kolom yang
   * tidak dibaca siapa pun — pengisian ganda yang justru ingin dihindari.
   */
  describe("indikator kesiapan di layar Konfigurasi Cuti", () => {
    async function readiness() {
      const response = await call("ketua", "GET", "/admin/leave/configuration");
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as {
        employees: Array<{ id: string; approvalSource: string; directManagerEmployeeId: string | null }>;
        summary: { activeEmployees: number; directManagerConfigured: number; structureRouted: number };
      };
    }

    it("menghitung pegawai yang dirutekan bagan sebagai siap, tanpa kolom atasan lama", async () => {
      await client.query(
        "UPDATE employees SET direct_manager_employee_id = NULL WHERE id = ANY($1::uuid[])",
        [[people.kabid.employeeId, people.guru.employeeId]],
      );
      const before = await readiness();
      const beforeRow = before.employees.find((row) => row.id === people.guru.employeeId)!;
      expect(beforeRow.approvalSource).toBe("LEGACY");
      expect(beforeRow.directManagerEmployeeId).toBeNull();

      await switchToStructure(nodes.bidang);

      const after = await readiness();
      const afterRow = after.employees.find((row) => row.id === people.guru.employeeId)!;
      expect(afterRow.approvalSource).toBe("STRUCTURE");
      expect(afterRow.directManagerEmployeeId).toBeNull();
      expect(after.summary.structureRouted).toBeGreaterThan(before.summary.structureRouted);
      expect(after.summary.directManagerConfigured)
        .toBeGreaterThan(before.summary.directManagerConfigured);
    });

    it("pegawai di luar jangkauan baris rollout tetap dihitung dari kolom lama", async () => {
      await switchToStructure(nodes.unit);
      const data = await readiness();
      // `ketua` duduk di node yayasan, di atas baris rollout node unit.
      expect(data.employees.find((row) => row.id === people.ketua.employeeId)!.approvalSource)
        .toBe("LEGACY");
      expect(data.employees.find((row) => row.id === people.guru.employeeId)!.approvalSource)
        .toBe("STRUCTURE");
    });
  });

  /**
   * APR-001 "Reassignment": satu langkah yang tersangkut dapat dipindahkan administrator.
   *
   * Audit 2026-11-24 (skenario C15) mencatat bahwa cuti tidak punya jalur ini sama sekali, padahal
   * APR-001 memintanya: begitu akun pejabat lama ditangguhkan, setiap pengajuan di mejanya berhenti
   * selamanya dan satu-satunya jalan adalah menyunting basis data.
   */
  describe("pengalihan langkah persetujuan yang tersangkut", () => {
    async function pendingStep() {
      const requestId = (await submitAnnual("guru")).json().id as string;
      const steps = await storedSteps(requestId);
      const rows = await client.query<{ id: string }>(
        `SELECT id FROM leave_request_approval_steps
          WHERE leave_request_id = $1 AND status = 'pending' ORDER BY step_order LIMIT 1`,
        [requestId],
      );
      expect(steps[0]!.approver).toBe(people.kepalaUnit.employeeId);
      return { requestId, stepId: rows.rows[0]!.id };
    }

    const reassign = (stepId: string, newApproverEmployeeId: string, reason = "Pejabat lama tidak dapat bertindak") =>
      call("ketua", "POST", `/admin/leave/approvals/${stepId}/reassign`, { newApproverEmployeeId, reason });

    it("memindahkan langkah ke penyetuju lain, dan yang baru dapat memutuskannya sampai selesai", async () => {
      const { requestId, stepId } = await pendingStep();
      // Pejabat lama kehilangan akses setelah pengajuan masuk.
      await client.query("UPDATE accounts SET status = 'suspended' WHERE employee_id = $1",
        [people.kepalaUnit.employeeId]);

      const moved = await reassign(stepId, people.ketua.employeeId);
      expect(moved.statusCode, moved.body).toBe(200);

      // Sesi pejabat lama ikut mati bersama akunnya, jadi antreannya dibaca dari basis data:
      // langkah itu bukan lagi miliknya, apa pun yang terjadi pada sesinya.
      const lama = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM leave_request_approval_steps
          WHERE leave_request_id = $1 AND approver_employee_id = $2`,
        [requestId, people.kepalaUnit.employeeId],
      );
      expect(lama.rows[0]!.count).toBe("0");
      const inboxBaru = (await call("ketua", "GET", "/leave/approvals")).json() as {
        items: Array<{ stepId: string; requestId: string }>;
      };
      expect(inboxBaru.items.find((item) => item.requestId === requestId)).toBeDefined();

      const decided = await call("ketua", "POST", `/leave/approvals/${stepId}/decision`, { decision: "approve" });
      expect(decided.statusCode, decided.body).toBe(200);
      const steps = await storedSteps(requestId);
      expect(steps[0]!.approver).toBe(people.ketua.employeeId);
      // Rantainya tidak dihitung ulang: langkah kedua tetap milik penyetuju unit yang tersimpan.
      expect(steps[1]!.approver).toBe(people.kabid.employeeId);
      expect(steps.map((step) => step.sources)).toEqual([["DIRECT_MANAGER"], ["UNIT_APPROVER"]]);
    });

    it("mencatat pejabat lama, pejabat baru, pelaksana, dan alasannya — di riwayat dan di audit", async () => {
      const { requestId, stepId } = await pendingStep();
      await reassign(stepId, people.ketua.employeeId, "Kepala unit cuti panjang");

      const event = await client.query<{ payload: Record<string, unknown>; actor: string }>(
        `SELECT payload, actor_account_id AS actor FROM leave_request_events
          WHERE leave_request_id = $1 AND event_type = 'leave.approval.reassigned'`,
        [requestId],
      );
      expect(event.rows).toHaveLength(1);
      expect(event.rows[0]!.actor).toBe(people.ketua.accountId);
      expect(event.rows[0]!.payload).toMatchObject({
        stepId,
        previousApproverEmployeeId: people.kepalaUnit.employeeId,
        newApproverEmployeeId: people.ketua.employeeId,
        reason: "Kepala unit cuti panjang",
      });

      const audited = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM access_audit_events
          WHERE action = 'leave.approval.reassigned' AND entity_id = $1`,
        [stepId],
      );
      expect(audited.rows).toHaveLength(1);
      expect(audited.rows[0]!.payload).toMatchObject({ leaveRequestId: requestId });
    });

    it("memberi tahu penyetuju baru bahwa langkah itu kini miliknya", async () => {
      const { stepId } = await pendingStep();
      await reassign(stepId, people.ketua.employeeId);
      const notifications = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM in_app_notifications
          WHERE recipient_account_id = $1 AND event_key = $2`,
        [people.ketua.accountId, `leave.approval.requested.${stepId}`],
      );
      expect(notifications.rows[0]!.count).toBe("1");
    });

    it("menolak alasan kosong, langkah yang sudah diputuskan, pemohon sendiri, dan akun yang belum aktif", async () => {
      const { requestId, stepId } = await pendingStep();

      const tanpaAlasan = await call("ketua", "POST", `/admin/leave/approvals/${stepId}/reassign`,
        { newApproverEmployeeId: people.ketua.employeeId });
      expect(tanpaAlasan.statusCode).toBe(400);

      const kePemohon = await reassign(stepId, people.guru.employeeId);
      expect(kePemohon.statusCode).toBe(409);
      expect(kePemohon.json().code).toBe("APPROVAL_REASSIGNMENT_SELF");

      // Penggantinya sendiri yang akunnya belum aktif — bukan pelaksananya, yang sesinya harus
      // tetap hidup supaya penolakannya terbaca sebagai 409 dan bukan 401.
      await client.query("UPDATE accounts SET status = 'invited' WHERE employee_id = $1",
        [people.kabid.employeeId]);
      const akunBelumAktif = await reassign(stepId, people.kabid.employeeId);
      expect(akunBelumAktif.statusCode).toBe(409);
      expect(akunBelumAktif.json().code).toBe("APPROVER_ACCOUNT_NOT_READY");
      await client.query("UPDATE accounts SET status = 'active' WHERE employee_id = $1",
        [people.kabid.employeeId]);

      const keluar = await reassign(stepId, randomUUID());
      expect(keluar.statusCode).toBe(409);
      expect(keluar.json().code).toBe("APPROVER_NOT_ACTIVE");

      // Langkah yang sudah diputuskan adalah sejarah, bukan antrean.
      const inbox = (await call("kepalaUnit", "GET", "/leave/approvals")).json() as {
        items: Array<{ stepId: string; requestId: string }>;
      };
      const step = inbox.items.find((item) => item.requestId === requestId)!;
      await call("kepalaUnit", "POST", `/leave/approvals/${step.stepId}/decision`, { decision: "approve" });
      const sudahDiputuskan = await reassign(stepId, people.ketua.employeeId);
      expect(sudahDiputuskan.statusCode).toBe(409);
      expect(sudahDiputuskan.json().code).toBe("APPROVAL_STEP_NOT_PENDING");
    });

    /**
     * ORG-013: langkah yang dipegang akun Organ Yayasan tidak boleh berpindah ke pegawai.
     *
     * Ditemukan review independen PR #412. Keputusan atas langkah principal akun melewati
     * `assertGovernanceApprovalCapability`; gerbang itu hanya ada pada cabang akun. Memindahkan
     * langkahnya ke `approver_employee_id` membuat keputusan berikutnya mengambil cabang pegawai
     * biasa — kapabilitas governance tidak pernah diperiksa — sementara `sources` tetap menuliskan
     * `GOVERNANCE_APPROVER`. Wewenang turun tanpa jejak.
     */
    it("menolak memindahkan langkah yang dipegang akun Pengurus Yayasan, dan tidak mengubah apa pun", async () => {
      const { stepId } = await pendingStep();
      await client.query(
        `UPDATE leave_request_approval_steps
            SET approver_employee_id = NULL, approver_account_id = $2, sources = ARRAY['GOVERNANCE_APPROVER']
          WHERE id = $1`,
        [stepId, people.ketua.accountId],
      );

      const ditolak = await reassign(stepId, people.ketua.employeeId);
      expect(ditolak.statusCode).toBe(409);
      expect(ditolak.json().code).toBe("APPROVAL_STEP_ACCOUNT_HELD");

      const after = await client.query<{ employee: string | null; account: string | null }>(
        `SELECT approver_employee_id AS employee, approver_account_id AS account
           FROM leave_request_approval_steps WHERE id = $1`,
        [stepId],
      );
      expect(after.rows[0]).toEqual({ employee: null, account: people.ketua.accountId });
      const jejak = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM leave_request_events WHERE event_type = 'leave.approval.reassigned'`,
      );
      expect(jejak.rows[0]!.count).toBe("0");
    });

    it("menulis intent outbox di samping notifikasi, seperti pengaktifan langkah lain", async () => {
      const { requestId, stepId } = await pendingStep();
      await reassign(stepId, people.ketua.employeeId);
      const outbox = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM leave_notification_outbox
          WHERE leave_request_id = $1 AND event_type = 'leave.approval.requested'
            AND target_type = 'employee' AND target_key = $2`,
        [requestId, people.ketua.employeeId],
      );
      expect(outbox.rows[0]!.count).toBe("1");
    });

    it("hanya pemegang izin kebijakan persetujuan yang dapat mengalihkan", async () => {
      const { stepId } = await pendingStep();
      const olehPegawai = await call("guru", "POST", `/admin/leave/approvals/${stepId}/reassign`,
        { newApproverEmployeeId: people.ketua.employeeId, reason: "Mencoba sendiri" });
      expect(olehPegawai.statusCode).toBe(403);
      const olehPenyetuju = await call("kabid", "POST", `/admin/leave/approvals/${stepId}/reassign`,
        { newApproverEmployeeId: people.ketua.employeeId, reason: "Mencoba sendiri" });
      expect(olehPenyetuju.statusCode).toBe(403);
    });
  });

  it("penyetuju unit yang memang belum dikonfigurasi tetap ditolak UNIT_APPROVER_MISSING", async () => {
    await client.query("UPDATE organizational_units SET leave_approver_employee_id = NULL WHERE id = $1",
      [bidangUnitId]);
    const response = await submitAnnual("kabid");
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "UNIT_APPROVER_MISSING" });
  });
});
