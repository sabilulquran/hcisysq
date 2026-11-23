// ORG-004: satu pengajuan Cuti Tahunan berjalan dari ujung ke ujung dalam mode `STRUCTURE`,
// lewat route API yang sama dengan yang dipakai Portal Pegawai — bukan lewat resolver yang
// dipanggil sendirian.
//
// Yang sudah ada tidak menutup ini. `org004-rollout-switch.postgres.test.ts` membuktikan siapa
// yang bagan tunjuk sebagai approver dan bahwa rantai tersimpan tidak ikut bergerak; ia tidak
// pernah memutuskan satu langkah pun. Berkas ini yang memutuskan: setiap langkah lewat
// `POST /leave/approvals/:stepId/decision`, sampai pengajuannya `approved`, `rejected`, atau
// `cancelled`, dan langkah tersimpannya diperiksa sesudahnya.
//
// Bentuk fixture-nya mengikuti satu unit sungguhan sebagaimana diukur owner (baca saja) pada
// 2026-11-23, dengan nama dan id sintetis:
//
//   Yayasan Sintetis
//   └── Bidang Pendidikan Sintetis      ← kursi `Kepala Bidang` (penyetuju unit)
//       └── Taman Tahfizh Sintetis      ← kursi `Kepala` (kepala unit), 1 pegawai duduk di sini
//           ├── Guru Sintetis           ← 7 pegawai, tanpa binding sendiri
//           └── Tata Usaha Sintetis     ← 1 pegawai, tanpa binding sendiri
//
// Tiga sifat unit itu yang dibawa ke sini karena ketiganya yang menentukan hasil:
//
// 1. binding `LEADER` node unit menunjuk kursi `Kepala` pada node yang sama, dipegang `PRIMARY`;
// 2. binding `UNIT_APPROVER` node unit menunjuk kursi pada node **lain** (`Bidang Pendidikan`),
//    jadi kepala unit dan penyetuju unit adalah dua orang berbeda;
// 3. kesembilan pegawai itu `direct_manager_employee_id`-nya NULL, dan tidak satu pun diisi di
//    sini. Justru kosongnya kolom itu yang membuat seluruh berkas ini berarti.
//
// Semua baris sintetis, satu transaksi per uji yang selalu di-ROLLBACK, dan tidak ada apa pun
// yang menyentuh produksi: tidak ada akun yang diaktifkan di sana, tidak ada pengajuan nyata,
// tidak ada notifikasi yang terkirim. "Taman Tahfizh Sintetis" adalah nama fixture, bukan unit
// yayasan; pemilihan unit pilot dan go/no-go tetap gate ORG-004 yang masih terbuka, dan produksi
// tetap `LEGACY` di mana-mana.

import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { AuthService } from "../src/modules/auth/service.js";
import { registerEmployeeLeaveRoutes } from "../src/modules/leave/employee-routes.js";
import { encodeWorkingWeekdays } from "../src/modules/leave/domain/working-calendar.js";
import { resolveLeaveAuthorities } from "../src/modules/leave/organization-authority.js";
import { leaveWorkflowKey } from "../src/modules/organization/workflow-keys.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

/**
 * Route-nya memegang transaksinya sendiri; BEGIN/COMMIT/ROLLBACK-nya menjadi savepoint milik uji
 * ini. Hanya ketiga kata itu yang disadap, persis sebagai pernyataan utuh: jalur persetujuan
 * terakhir menjalankan `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` bernama sendiri (pemberitahuan
 * oversight ORG-004), dan menyadap `ROLLBACK TO SAVEPOINT …` sebagai "rollback transaksi" akan
 * membatalkan savepoint uji ini, bukan savepoint yang dimaksud route.
 */
function savepointPool(client: PoolClient): Pool {
  let depth = 0;
  const run = async (text: string, values?: unknown[]) => {
    const statement = String(text).trim().toUpperCase().replace(/;$/, "").trim();
    if (statement === "BEGIN") return client.query(`SAVEPOINT flow_sp_${++depth}`);
    if (statement === "COMMIT") {
      const name = `flow_sp_${depth}`;
      depth -= 1;
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (statement === "ROLLBACK") {
      const name = `flow_sp_${depth}`;
      depth -= 1;
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    return client.query(text, values);
  };
  const handle = { query: run, release: () => {} };
  return { query: run, connect: async () => handle } as unknown as Pool;
}

/**
 * Kesembilan pegawai unit, ditambah penyetuju unit yang duduk di node lain. `guru7` adalah orang
 * yang pada kasus 5 naik menjadi kepala unit — seorang guru yang dipromosikan, jadi jumlah
 * pegawai unitnya tetap sembilan.
 */
const UNIT_PEOPLE = [
  "kepala", "guru1", "guru2", "guru3", "guru4", "guru5", "guru6", "guru7", "tataUsaha1",
] as const;
const PEOPLE = [...UNIT_PEOPLE, "penyetujuUnit"] as const;
type Person = (typeof PEOPLE)[number];

/** Senin 5 Januari 2099, 08:00 Jakarta. Setiap cuti jatuh jauh melewati pemberitahuan H-7. */
const NOW = new Date("2099-01-05T01:00:00.000Z");
const TODAY = "2099-01-05";
/** Dua kuartal berbeda, supaya pengajuan kedua dalam satu uji tidak tertolak batas 3 hari. */
const FIRST_LEAVE = { startOn: "2099-02-02", endOn: "2099-02-03" };
const SECOND_LEAVE = { startOn: "2099-05-04", endOn: "2099-05-05" };
const ANNUAL = leaveWorkflowKey("annual");

describe.skipIf(!allowed)("ORG-004 alur cuti penuh dalam mode STRUCTURE (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let unitId = "";
  let changeSet = "";

  const people = {} as Record<Person, { employeeId: string; accountId: string; cookie: string }>;
  /** Kunci stabil bagan, sebentuk unit sungguhan: yayasan, bidang, unit, dan dua anak unit. */
  const nodes = { yayasan: "", bidang: "", unit: "", guru: "", tataUsaha: "" };
  const positions = { kepalaBidang: "", kepalaUnit: "" };
  /** Baris incumbency kursi kepala unit — satu-satunya baris yang kasus 5 sentuh. */
  let kepalaIncumbency = "";

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  function call(who: Person, method: "GET" | "POST", url: string, payload?: object) {
    return app.inject({
      method, url, headers: { cookie: people[who].cookie }, ...(payload ? { payload } : {}),
    });
  }

  async function submitAnnual(who: Person, dates: { startOn: string; endOn: string }) {
    const response = await call(who, "POST", "/leave/me/annual/submit", {
      ...dates, reason: "Acara keluarga sintetis", idempotencyKey: randomUUID(),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as {
      id: string;
      approvalChain: Array<{ id: string; employeeId: string | null; name: string }>;
    };
  }

  /** Langkah persetujuan yang benar-benar tersimpan, menurut urutannya. */
  async function storedSteps(requestId: string) {
    const rows = await client.query<{
      id: string; approver: string | null; sources: string[]; status: string; order: number;
      actedBy: string | null; note: string | null;
    }>(
      `SELECT id, approver_employee_id AS "approver", sources, status, step_order AS "order",
              acted_by_account_id AS "actedBy", decision_note AS note
         FROM leave_request_approval_steps
        WHERE leave_request_id = $1
        ORDER BY step_order`,
      [requestId],
    );
    return rows.rows;
  }

  async function requestStatus(requestId: string) {
    const rows = await client.query<{ status: string; finalDecidedAt: Date | null }>(
      `SELECT status, final_decided_at AS "finalDecidedAt" FROM leave_requests WHERE id = $1`,
      [requestId],
    );
    return rows.rows[0]!;
  }

  async function inboxOf(who: Person) {
    const response = await call(who, "GET", "/leave/approvals");
    expect(response.statusCode, response.body).toBe(200);
    return (response.json() as { items: Array<{ stepId: string; requestId: string }> }).items;
  }

  function decide(who: Person, stepId: string, decision: "approve" | "reject", note?: string) {
    return call(who, "POST", `/leave/approvals/${stepId}/decision`, {
      decision, ...(note ? { note } : {}),
    });
  }

  /** Rantai yang runtime susun, dengan kolom atasan lama dibaca apa adanya dari basis data. */
  async function runtimeChain(who: Person) {
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
      workflowKey: ANNUAL,
      requesterEmployeeId: people[who].employeeId,
      effectiveDate: TODAY,
      legacy: {
        directManagerEmployeeId: legacyRow.rows[0]!.directManagerEmployeeId,
        unitApproverEmployeeId: legacyRow.rows[0]!.unitApproverEmployeeId,
      },
      policyChain: "LINE_AND_UNIT",
      allowAccountPrincipal: true,
    });
  }

  beforeEach(async () => {
    vi.setSystemTime(NOW);
    client = await pool.connect();
    await client.query("BEGIN");
    const transactionPool = savepointPool(client);

    unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'Taman Tahfizh Sintetis')",
      [unitId, `org004-flow-${unitId}`],
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
      // `direct_manager_employee_id` sengaja tidak pernah diisi, persis seperti kesembilan
      // pegawai unit yang diukur owner.
      await client.query(
        `INSERT INTO employees(id, employee_number, full_name, status, started_on,
                               organizational_unit_id, leave_entitlement_group, management_scope)
         VALUES ($1, $2, $3, 'active', '2020-01-06', $4, 'non_education', 'MANAGED')`,
        [employeeId, `ORG004F-${employeeId.slice(0, 8)}`, `Pegawai ${who}`, unitId],
      );
      const accountId = randomUUID();
      await client.query(
        `INSERT INTO accounts(id, employee_id, email, principal_type, status)
         VALUES ($1, $2, $3, 'EMPLOYEE', 'active')`,
        [accountId, employeeId, `org004-flow-${accountId}@example.invalid`],
      );
      const session = await auth.createSessionForAccountId(accountId, {
        ipAddress: "127.0.0.1", userAgent: "rollback-only-org004-flow-test",
      });
      people[who] = { employeeId, accountId, cookie: session.setCookie.split(";")[0]! };
    }
    // Kolom penyetuju unit lama tetap terisi, seperti di produksi. Dengan kolom atasan langsung
    // kosong, `LEGACY` tetap menolak — dan itu diperiksa pada kasus 1.
    await client.query(
      "UPDATE organizational_units SET leave_approver_employee_id = $2 WHERE id = $1",
      [unitId, people.penyetujuUnit.employeeId],
    );

    // Bagan yang terbit.
    changeSet = randomUUID();
    await client.query(
      `INSERT INTO organization_change_sets
         (id, name, effective_on, status, created_by_account_id, validated_at, published_at)
       VALUES ($1,'Struktur uji alur ORG-004','2020-01-01'::date,'PUBLISHED',$2, now(), now())`,
      [changeSet, people.penyetujuUnit.accountId],
    );
    for (const [key, parent, name] of [
      ["yayasan", null, "Yayasan Sintetis"],
      ["bidang", "yayasan", "Bidang Pendidikan Sintetis"],
      ["unit", "bidang", "Taman Tahfizh Sintetis"],
      ["guru", "unit", "Guru Sintetis"],
      ["tataUsaha", "unit", "Tata Usaha Sintetis"],
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
      ["kepalaBidang", "bidang", null, "Kepala Bidang Sintetis"],
      ["kepalaUnit", "unit", "kepalaBidang", "Kepala Sintetis"],
    ] as const) {
      positions[key] = randomUUID();
      await client.query(
        `INSERT INTO organization_positions
           (id, change_set_id, stable_key, node_key, title, parent_position_key, effective_from, vacancy_policy)
         VALUES ($1,$2,$3,$4,$5,$6,'2020-01-01','BLOCK')`,
        [randomUUID(), changeSet, positions[key], nodes[nodeKey], title, parent ? positions[parent] : null],
      );
    }
    for (const [positionKey, who] of [
      ["kepalaBidang", "penyetujuUnit"],
      ["kepalaUnit", "kepala"],
    ] as const) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO organization_incumbencies
           (id, change_set_id, position_key, employee_id, kind, effective_from)
         VALUES ($1,$2,$3,$4,'PRIMARY','2020-01-01')`,
        [id, changeSet, positions[positionKey], people[who].employeeId],
      );
      if (positionKey === "kepalaUnit") kepalaIncumbency = id;
    }
    // Binding hanya pada node unit. Anak-anaknya sengaja tidak punya binding sendiri: pegawai
    // `Guru` dan `Tata Usaha` sampai ke kepala unit dengan memanjat satu tingkat.
    for (const [nodeKey, bindingType, target] of [
      ["unit", "LEADER", "kepalaUnit"],
      ["unit", "UNIT_APPROVER", "kepalaBidang"],
    ] as const) {
      await client.query(
        `INSERT INTO organization_authority_bindings
           (id, change_set_id, subject_kind, subject_key, binding_type, target_position_key, vacancy_policy, effective_from)
         VALUES ($1,$2,'NODE',$3,$4,$5,'BLOCK','2020-01-01')`,
        [randomUUID(), changeSet, nodes[nodeKey], bindingType, positions[target]],
      );
    }
    // Satu pegawai duduk di node unit, tujuh di `Guru`, satu di `Tata Usaha`.
    for (const [who, nodeKey] of [
      ["kepala", "unit"],
      ["guru1", "guru"], ["guru2", "guru"], ["guru3", "guru"], ["guru4", "guru"],
      ["guru5", "guru"], ["guru6", "guru"], ["guru7", "guru"],
      ["tataUsaha1", "tataUsaha"],
      ["penyetujuUnit", "bidang"],
    ] as const) {
      await client.query(
        `INSERT INTO organization_memberships
           (id, change_set_id, employee_id, node_key, is_primary, effective_from)
         VALUES ($1,$2,$3,$4,true,'2020-01-01')`,
        [randomUUID(), changeSet, people[who].employeeId, nodes[nodeKey]],
      );
    }
    // Satu baris rollout pada node unit, dan hanya untuk Cuti Tahunan.
    await client.query(
      `INSERT INTO organization_rollout_settings
         (id, workflow_key, node_key, mode, effective_from, reason, changed_by_account_id)
       VALUES ($1,$2,$3,'STRUCTURE','2020-01-01','Uji alur ORG-004 sintetis',$4)`,
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
   * Fixture-nya memang berbentuk seperti unit yang diukur: sembilan pegawai, tidak satu pun punya
   * atasan langsung, dan mode untuk mereka `STRUCTURE`. Tanpa uji ini, kelima uji berikutnya bisa
   * lulus karena fixture-nya diam-diam berubah bentuk.
   */
  it("fixture: sembilan pegawai unit tanpa atasan langsung, dan modenya STRUCTURE", async () => {
    const unitEmployeeIds = UNIT_PEOPLE.map((who) => people[who].employeeId);
    expect(unitEmployeeIds).toHaveLength(9);

    const withManager = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM employees
        WHERE id = ANY($1::uuid[]) AND direct_manager_employee_id IS NOT NULL`,
      [unitEmployeeIds],
    );
    expect(withManager.rows[0]!.count).toBe("0");

    const chain = await runtimeChain("guru1");
    expect(chain.context.mode).toBe("STRUCTURE");
    expect(chain.context.rolloutScope).toMatchObject({
      matchedNodeKey: nodes.unit, requesterNodeKey: nodes.guru,
    });
    // Kepala unit dan penyetuju unit adalah dua orang berbeda: itu pokok bentuk unit ini.
    expect(people.kepala.employeeId).not.toBe(people.penyetujuUnit.employeeId);
  });

  /**
   * Kasus 1. Alur penuh: seorang guru mengajukan Cuti Tahunan, kepala unit menyetujui, penyetuju
   * unit menyetujui, dan pengajuannya `approved`.
   *
   * Inilah bukti yang selama ini hilang. Yang sudah ada berhenti di "siapa yang bagan tunjuk";
   * uji ini menjalankan keputusannya satu per satu lewat route yang sama dengan yang dipakai
   * approver sungguhan, lalu membaca langkah tersimpannya.
   */
  it("kasus 1: pengajuan guru melewati kepala unit lalu penyetuju unit sampai approved", async () => {
    // `LEGACY` untuk orang yang sama menolak, karena kolom atasan langsungnya kosong. Jadi yang
    // dibuktikan di bawah adalah selisihnya, bukan sekadar bahwa cuti bisa disetujui.
    await client.query("SAVEPOINT tanpa_rollout");
    await client.query("DELETE FROM organization_rollout_settings");
    const legacy = await call("guru1", "POST", "/leave/me/annual/submit", {
      ...FIRST_LEAVE, reason: "Acara keluarga sintetis", idempotencyKey: randomUUID(),
    });
    expect(legacy.statusCode).toBe(409);
    expect(legacy.json()).toMatchObject({ code: "DIRECT_MANAGER_MISSING" });
    await client.query("ROLLBACK TO SAVEPOINT tanpa_rollout");
    await client.query("RELEASE SAVEPOINT tanpa_rollout");

    const request = await submitAnnual("guru1", FIRST_LEAVE);
    expect(request.approvalChain.map((step) => step.employeeId)).toEqual([
      people.kepala.employeeId, people.penyetujuUnit.employeeId,
    ]);
    expect((await requestStatus(request.id)).status).toBe("in_review");

    // Langkah pertama ada di antrean kepala unit, dan belum di antrean penyetuju unit.
    const firstInbox = await inboxOf("kepala");
    expect(firstInbox.map((item) => item.requestId)).toEqual([request.id]);
    expect(await inboxOf("penyetujuUnit")).toEqual([]);

    const firstDecision = await decide("kepala", firstInbox[0]!.stepId, "approve", "Disetujui kepala unit");
    expect(firstDecision.statusCode, firstDecision.body).toBe(200);
    expect(firstDecision.json()).toMatchObject({
      requestId: request.id, requestStatus: "in_review", stepStatus: "approved",
    });

    // Barulah giliran penyetuju unit, dan kepala unit tidak lagi memegang apa pun.
    const secondInbox = await inboxOf("penyetujuUnit");
    expect(secondInbox.map((item) => item.requestId)).toEqual([request.id]);
    expect(await inboxOf("kepala")).toEqual([]);

    const secondDecision = await decide("penyetujuUnit", secondInbox[0]!.stepId, "approve");
    expect(secondDecision.statusCode, secondDecision.body).toBe(200);
    expect(secondDecision.json()).toMatchObject({
      requestStatus: "approved", stepStatus: "approved", nextPendingStepId: null,
    });

    const final = await requestStatus(request.id);
    expect(final.status).toBe("approved");
    expect(final.finalDecidedAt).not.toBeNull();

    // Rantai tersimpan: tepat kedua orang itu, dalam urutan itu, keduanya disetujui, dan masing-
    // masing oleh akun yang memang memegang langkahnya.
    const steps = await storedSteps(request.id);
    expect(steps.map((step) => step.approver)).toEqual([
      people.kepala.employeeId, people.penyetujuUnit.employeeId,
    ]);
    expect(steps.map((step) => step.status)).toEqual(["approved", "approved"]);
    expect(steps.map((step) => step.actedBy)).toEqual([
      people.kepala.accountId, people.penyetujuUnit.accountId,
    ]);
    expect(steps.map((step) => step.sources)).toEqual([["DIRECT_MANAGER"], ["UNIT_APPROVER"]]);
    expect(steps[0]!.note).toBe("Disetujui kepala unit");
  });

  /**
   * Kasus 1 lagi, dari anak node yang satunya: pegawai Tata Usaha memanjat ke kepala yang sama.
   * Anak node tidak punya binding sendiri, jadi inilah yang membuktikan pendakian itu benar-benar
   * menanggung orangnya sampai keputusan, bukan hanya sampai resolusi.
   */
  it("kasus 1: pegawai Tata Usaha memanjat ke kepala unit yang sama dan ikut disetujui", async () => {
    const request = await submitAnnual("tataUsaha1", FIRST_LEAVE);
    expect(request.approvalChain.map((step) => step.employeeId)).toEqual([
      people.kepala.employeeId, people.penyetujuUnit.employeeId,
    ]);

    const first = await inboxOf("kepala");
    expect((await decide("kepala", first[0]!.stepId, "approve")).statusCode).toBe(200);
    const second = await inboxOf("penyetujuUnit");
    expect((await decide("penyetujuUnit", second[0]!.stepId, "approve")).statusCode).toBe(200);

    expect((await requestStatus(request.id)).status).toBe("approved");
  });

  /**
   * Kasus 2. Cuti kepala unit sendiri.
   *
   * Binding `LEADER` node unit menunjuk kursi yang dia duduki, jadi rantai yang menyertakan
   * dirinya akan menyuruhnya menyetujui cutinya sendiri. Yang terjadi: pencarian atasan
   * langsungnya naik ke kursi induk kursinya — `Kepala Bidang` — dan kursi itu orangnya sama
   * dengan penyetuju unit, sehingga keduanya menyatu menjadi satu langkah dengan dua sumber.
   */
  it("kasus 2: cuti kepala unit berhenti di penyetuju unit, tanpa dirinya di dalam rantai", async () => {
    const request = await submitAnnual("kepala", FIRST_LEAVE);
    expect(request.approvalChain.map((step) => step.employeeId))
      .toEqual([people.penyetujuUnit.employeeId]);
    expect(request.approvalChain.map((step) => step.employeeId))
      .not.toContain(people.kepala.employeeId);

    // Dan dia tidak memegang langkah apa pun atas cutinya sendiri.
    expect(await inboxOf("kepala")).toEqual([]);

    const inbox = await inboxOf("penyetujuUnit");
    expect(inbox.map((item) => item.requestId)).toEqual([request.id]);
    expect((await decide("penyetujuUnit", inbox[0]!.stepId, "approve")).statusCode).toBe(200);
    expect((await requestStatus(request.id)).status).toBe("approved");

    const steps = await storedSteps(request.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.approver).toBe(people.penyetujuUnit.employeeId);
    // Satu orang, dua sumber: dia atasan struktural kepala unit sekaligus penyetuju unitnya.
    expect(steps[0]!.sources).toEqual(["DIRECT_MANAGER", "UNIT_APPROVER"]);
  });

  /**
   * Kasus 3. Penolakan di langkah pertama. Pengajuannya berakhir `rejected`, dan langkah kedua
   * tidak pernah menjadi giliran siapa pun: ia tetap `waiting`, bukan `pending`.
   */
  it("kasus 3: penolakan kepala unit mengakhiri pengajuan dan langkah kedua tidak menjadi pending", async () => {
    const request = await submitAnnual("guru2", FIRST_LEAVE);
    const inbox = await inboxOf("kepala");

    const rejection = await decide("kepala", inbox[0]!.stepId, "reject", "Jadwal unit sedang padat");
    expect(rejection.statusCode, rejection.body).toBe(200);
    expect(rejection.json()).toMatchObject({
      requestStatus: "rejected", stepStatus: "rejected", nextPendingStepId: null,
    });

    const final = await requestStatus(request.id);
    expect(final.status).toBe("rejected");
    expect(final.finalDecidedAt).not.toBeNull();

    const steps = await storedSteps(request.id);
    expect(steps.map((step) => step.status)).toEqual(["rejected", "waiting"]);
    expect(steps.map((step) => step.status)).not.toContain("pending");
    // Dan tidak pernah sampai ke antrean penyetuju unit.
    expect(await inboxOf("penyetujuUnit")).toEqual([]);
  });

  /**
   * Kasus 3, langkah kedua. Yang berbeda di sini: langkah pertama sudah `approved` dan tidak
   * boleh ikut berubah ketika langkah kedua menolak.
   */
  it("kasus 3: penolakan penyetuju unit mengakhiri pengajuan dan menyisakan langkah pertama disetujui", async () => {
    const request = await submitAnnual("guru3", FIRST_LEAVE);
    const first = await inboxOf("kepala");
    expect((await decide("kepala", first[0]!.stepId, "approve")).statusCode).toBe(200);

    const second = await inboxOf("penyetujuUnit");
    const rejection = await decide("penyetujuUnit", second[0]!.stepId, "reject", "Beban kerja bidang");
    expect(rejection.statusCode, rejection.body).toBe(200);
    expect(rejection.json()).toMatchObject({ requestStatus: "rejected", stepStatus: "rejected" });

    expect((await requestStatus(request.id)).status).toBe("rejected");
    const steps = await storedSteps(request.id);
    expect(steps.map((step) => step.status)).toEqual(["approved", "rejected"]);
    expect(steps.map((step) => step.status)).not.toContain("pending");
    expect(await inboxOf("kepala")).toEqual([]);
    expect(await inboxOf("penyetujuUnit")).toEqual([]);
  });

  /**
   * Kasus 4. Pemohon membatalkan sendiri selagi pengajuannya masih di tangan approver. Langkah
   * yang tertunda ikut ditutup, supaya tidak ada yang tertinggal di antrean siapa pun.
   */
  it("kasus 4: pemohon membatalkan saat masih di review, dan antrean approver ikut kosong", async () => {
    const request = await submitAnnual("guru4", FIRST_LEAVE);
    expect(await inboxOf("kepala")).toHaveLength(1);

    const cancellation = await call("guru4", "POST", `/leave/me/requests/${request.id}/cancel`, {
      reason: "Acara keluarganya batal",
    });
    expect(cancellation.statusCode, cancellation.body).toBe(200);
    expect(cancellation.json()).toMatchObject({ id: request.id, status: "cancelled" });

    expect((await requestStatus(request.id)).status).toBe("cancelled");
    const steps = await storedSteps(request.id);
    expect(steps.map((step) => step.status)).toEqual(["cancelled", "cancelled"]);
    expect(await inboxOf("kepala")).toEqual([]);
    expect(await inboxOf("penyetujuUnit")).toEqual([]);

    // Dan langkah yang sudah dibatalkan tidak bisa diputuskan sesudahnya.
    const late = await decide("kepala", steps[0]!.id, "approve");
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ code: "REQUEST_NOT_REVIEWABLE" });
  });

  /**
   * Kasus 4 dari sisi kedua: pembatalan setelah langkah pertama disetujui menutup langkah kedua
   * yang sedang menjadi giliran penyetuju unit.
   */
  it("kasus 4: pembatalan setelah langkah pertama disetujui menutup giliran penyetuju unit", async () => {
    const request = await submitAnnual("guru5", FIRST_LEAVE);
    const first = await inboxOf("kepala");
    expect((await decide("kepala", first[0]!.stepId, "approve")).statusCode).toBe(200);
    expect(await inboxOf("penyetujuUnit")).toHaveLength(1);

    const cancellation = await call("guru5", "POST", `/leave/me/requests/${request.id}/cancel`, {});
    expect(cancellation.statusCode, cancellation.body).toBe(200);

    expect((await requestStatus(request.id)).status).toBe("cancelled");
    const steps = await storedSteps(request.id);
    // Langkah yang sudah diputuskan tidak ditulis ulang; hanya yang tertunda yang ditutup.
    expect(steps.map((step) => step.status)).toEqual(["approved", "cancelled"]);
    expect(await inboxOf("penyetujuUnit")).toEqual([]);
  });

  /**
   * Kasus 5. Pejabat diganti sementara sebuah pengajuan sudah ada di antrean orang lama.
   *
   * Sisi resolusinya sudah dibuktikan `org004-rollout-switch.postgres.test.ts` (bukti 1 dan 2).
   * Yang baru di sini: pengajuan yang *sudah berada di antrean* seseorang tetap bisa — dan hanya
   * bisa — diputuskan olehnya, sementara pengajuan berikutnya betul-betul berpindah ke
   * penggantinya dan berjalan sampai selesai. Yang berubah hanya satu baris bagan.
   */
  it("kasus 5: pengajuan di antrean tetap milik pejabat lama, pengajuan berikutnya ke penggantinya", async () => {
    const before = await submitAnnual("guru6", FIRST_LEAVE);
    const heldStep = (await inboxOf("kepala"))[0]!;
    expect(heldStep.requestId).toBe(before.id);

    // Satu baris bagan: kursi kepala unit berpindah ke guru7.
    const swap = await client.query(
      "UPDATE organization_incumbencies SET employee_id = $2 WHERE id = $1",
      [kepalaIncumbency, people.guru7.employeeId],
    );
    expect(swap.rowCount).toBe(1);

    // Pengajuan yang sudah masuk tidak ikut pindah: masih di antrean pejabat lama, dan bukan di
    // antrean penggantinya.
    expect((await inboxOf("kepala")).map((item) => item.requestId)).toEqual([before.id]);
    expect(await inboxOf("guru7")).toEqual([]);
    // Penggantinya pun tidak bisa memutuskannya dari belakang layar.
    const intruder = await decide("guru7", heldStep.stepId, "approve");
    expect(intruder.statusCode).toBe(403);
    expect(intruder.json()).toMatchObject({ code: "APPROVAL_FORBIDDEN" });

    // Pejabat lama menyelesaikan apa yang ada di tangannya, sampai pengajuannya disetujui.
    expect((await decide("kepala", heldStep.stepId, "approve")).statusCode).toBe(200);
    const secondOfBefore = (await inboxOf("penyetujuUnit"))[0]!;
    expect((await decide("penyetujuUnit", secondOfBefore.stepId, "approve")).statusCode).toBe(200);
    expect((await requestStatus(before.id)).status).toBe("approved");
    expect((await storedSteps(before.id)).map((step) => step.approver)).toEqual([
      people.kepala.employeeId, people.penyetujuUnit.employeeId,
    ]);

    // Pengajuan sesudah pergantian pergi ke penggantinya, dan selesai di tangannya.
    const after = await submitAnnual("guru6", SECOND_LEAVE);
    expect(after.approvalChain.map((step) => step.employeeId)).toEqual([
      people.guru7.employeeId, people.penyetujuUnit.employeeId,
    ]);
    expect(await inboxOf("kepala")).toEqual([]);
    const successorStep = (await inboxOf("guru7"))[0]!;
    expect(successorStep.requestId).toBe(after.id);
    expect((await decide("guru7", successorStep.stepId, "approve")).statusCode).toBe(200);
    const lastStep = (await inboxOf("penyetujuUnit"))[0]!;
    expect((await decide("penyetujuUnit", lastStep.stepId, "approve")).statusCode).toBe(200);
    expect((await requestStatus(after.id)).status).toBe("approved");

    // Dan tidak satu pun kolom atasan lama ikut diisi oleh pergantian itu.
    const legacy = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM employees
        WHERE organizational_unit_id = $1 AND direct_manager_employee_id IS NOT NULL`,
      [unitId],
    );
    expect(legacy.rows[0]!.count).toBe("0");
  });

  /**
   * Kasus 6. Yang menolak adalah keadaan akun penyetuju, bukan bagannya.
   *
   * Ini pembedaan yang paling sering harus dijelaskan dengan kata-kata: "bagannya salah" versus
   * "akunnya belum aktif". Di sini bagannya lengkap dan benar — terbukti karena satu-satunya
   * yang berubah di antara penolakan dan penerimaan adalah status akun, di basis data uji.
   *
   * **Catatan revisi, 2026-11-23 (ORG-004 D-R5).** Versi pertama berkas ini mencatat bahwa
   * `STRUCTURE` menolak dengan `409 AUTHORITY_INELIGIBLE` berpesan bahasa Inggris yang tidak
   * menyebut siapa pun, karena resolver menyaring akun yang bukan `active` sebagai incumbent yang
   * tidak layak (alasan `ACCOUNT_NOT_ACTIVE`) sebelum `hydrateApprovalChain`, dan `mapKnownError`
   * tidak meneruskan `details`. Temuan itu benar dan sudah diperbaiki: keadaan akun kini dijawab
   * dengan kode yang sama seperti `LEGACY`, `409 APPROVER_ACCOUNT_NOT_READY`, dengan kalimat
   * berbahasa Indonesia yang menyebut kursinya, orangnya, dan bahwa yang perlu diselesaikan
   * adalah aktivasi akunnya. Jadi pembedaan "bagannya salah" versus "akunnya belum aktif" kembali
   * terbaca dari kodenya saja, pada kedua mode.
   */
  it("kasus 6: akun penyetuju unit yang belum aktif menolak pengajuan, dan hanya itu yang berubah", async () => {
    // Bagannya terbukti sanggup: rantainya resolve sebelum akunnya disentuh.
    const healthy = await runtimeChain("guru1");
    expect(healthy.approvalChain.map((step) => step.employeeId)).toEqual([
      people.kepala.employeeId, people.penyetujuUnit.employeeId,
    ]);

    await client.query(
      "UPDATE accounts SET status = 'invited' WHERE id = $1",
      [people.penyetujuUnit.accountId],
    );
    const refused = await call("guru1", "POST", "/leave/me/annual/submit", {
      ...FIRST_LEAVE, reason: "Acara keluarga sintetis", idempotencyKey: randomUUID(),
    });
    expect(refused.statusCode, refused.body).toBe(409);
    // Kode yang sama dengan `LEGACY`, dan pesannya menyebut kursi serta orangnya (D-R5).
    expect(refused.json()).toMatchObject({ code: "APPROVER_ACCOUNT_NOT_READY" });
    expect(refused.json().message).toContain("Pegawai penyetujuUnit");
    expect(refused.json().message).toContain("Kepala Bidang Sintetis");
    // Dan tidak ada apa pun yang tersimpan separuh jalan.
    const nothing = await client.query(
      "SELECT 1 FROM leave_requests WHERE employee_id = $1", [people.guru1.employeeId],
    );
    expect(nothing.rowCount).toBe(0);

    // Satu-satunya yang berubah: status akun. Bagannya tidak disentuh sama sekali.
    await client.query(
      "UPDATE accounts SET status = 'active' WHERE id = $1",
      [people.penyetujuUnit.accountId],
    );
    const accepted = await submitAnnual("guru1", FIRST_LEAVE);
    expect(accepted.approvalChain.map((step) => step.employeeId)).toEqual([
      people.kepala.employeeId, people.penyetujuUnit.employeeId,
    ]);
  });

  it("kasus 6: akun kepala unit yang belum aktif menolak dengan cara yang sama", async () => {
    await client.query(
      "UPDATE accounts SET status = 'invited' WHERE id = $1", [people.kepala.accountId],
    );
    const refused = await call("guru1", "POST", "/leave/me/annual/submit", {
      ...FIRST_LEAVE, reason: "Acara keluarga sintetis", idempotencyKey: randomUUID(),
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: "APPROVER_ACCOUNT_NOT_READY" });
    expect(refused.json().message).toContain("Pegawai kepala");

    await client.query(
      "UPDATE accounts SET status = 'active' WHERE id = $1", [people.kepala.accountId],
    );
    const accepted = await submitAnnual("guru1", FIRST_LEAVE);
    expect(accepted.approvalChain.map((step) => step.employeeId)).toEqual([
      people.kepala.employeeId, people.penyetujuUnit.employeeId,
    ]);
  });

  /**
   * Kasus 6, sisi yang paling perlu diketahui sebelum memilih unit pilot.
   *
   * Versi pertama berkas ini menemukan bahwa fixture di atas menolak hanya karena memakai
   * `BLOCK`. Dengan `CLIMB_TO_PARENT` — kebijakan yang dipakai **seluruh** 63 ikatan wewenang dan
   * seluruh 29 jabatan pada bagan terbit production, tanpa satu pun pengecualian — kepala unit
   * yang akunnya belum aktif tidak menolak apa pun: kursinya dilewati diam-diam dan rantainya
   * naik ke `Kepala Bidang`, yang di unit ini orangnya sama dengan penyetuju unit. Dua langkah
   * menyusut menjadi satu, cutinya tetap disetujui, dan kepala unit tidak pernah melihatnya.
   *
   * Itu sudah diperbaiki (ORG-004 D-R5): kursi yang pejabatnya ada tetapi akunnya belum siap
   * bukan kursi kosong, dan tidak lagi dilewati, apa pun kebijakan kekosongannya. Uji ini kini
   * memeriksa perbaikannya, dan khususnya memeriksa bahwa **tidak ada rantai tersimpan yang
   * kehilangan kepala unit tanpa suara**.
   */
  it("kasus 6: dengan CLIMB_TO_PARENT, kepala unit yang akunnya belum aktif tetap menolak", async () => {
    await client.query(
      `UPDATE organization_authority_bindings SET vacancy_policy = 'CLIMB_TO_PARENT'
        WHERE change_set_id = $1 AND subject_key = $2 AND binding_type = 'LEADER'`,
      [changeSet, nodes.unit],
    );
    await client.query(
      "UPDATE accounts SET status = 'invited' WHERE id = $1", [people.kepala.accountId],
    );

    const refused = await call("guru1", "POST", "/leave/me/annual/submit", {
      ...FIRST_LEAVE, reason: "Acara keluarga sintetis", idempotencyKey: randomUUID(),
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: "APPROVER_ACCOUNT_NOT_READY" });
    expect(refused.json().message).toContain("Pegawai kepala");
    expect(refused.json().message).toContain("Kepala Sintetis");

    // Dan tidak ada rantai yang tersimpan tanpa kepala unit di dalamnya: pengajuannya tidak jadi
    // sama sekali, bukan jadi dengan satu langkah lebih sedikit.
    const stored = await client.query(
      "SELECT 1 FROM leave_requests WHERE employee_id = $1", [people.guru1.employeeId],
    );
    expect(stored.rowCount).toBe(0);
    expect(await inboxOf("penyetujuUnit")).toEqual([]);

    // Kursi yang benar-benar kosong tetap memanjat: yang berubah hanya kelayakan pejabatnya.
    await client.query(
      "DELETE FROM organization_incumbencies WHERE id = $1", [kepalaIncumbency],
    );
    const request = await submitAnnual("guru1", FIRST_LEAVE);
    expect(request.approvalChain.map((step) => step.employeeId))
      .toEqual([people.penyetujuUnit.employeeId]);
    const steps = await storedSteps(request.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.sources).toEqual(["DIRECT_MANAGER", "UNIT_APPROVER"]);
  });

  /**
   * Pembanding yang menjelaskan dari mana `APPROVER_ACCOUNT_NOT_READY` sebenarnya datang:
   * `LEGACY`, yaitu mode yang produksi jalankan hari ini. Di sana rantainya tidak lewat resolver,
   * jadi akun yang belum aktif baru ketahuan di `hydrateApprovalChain` — dan pesannya menyebut
   * nama orangnya. Inilah penjelasan dari 409 yang selama ini dilaporkan dari produksi.
   */
  it("kasus 6: pada LEGACY, akun yang sama menolak sebagai APPROVER_ACCOUNT_NOT_READY", async () => {
    await client.query("DELETE FROM organization_rollout_settings");
    // `LEGACY` butuh kedua kolom lama; di sini sengaja diisi supaya yang diuji benar-benar
    // status akunnya, bukan kolom yang kosong.
    await client.query(
      "UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1",
      [people.guru1.employeeId, people.kepala.employeeId],
    );
    await client.query(
      "UPDATE accounts SET status = 'invited' WHERE id = $1", [people.penyetujuUnit.accountId],
    );

    const refused = await call("guru1", "POST", "/leave/me/annual/submit", {
      ...FIRST_LEAVE, reason: "Acara keluarga sintetis", idempotencyKey: randomUUID(),
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: "APPROVER_ACCOUNT_NOT_READY" });
    // Pesannya menyebut siapa yang akunnya belum aktif; versi `STRUCTURE` tidak.
    expect(refused.json().message).toContain("Pegawai penyetujuUnit");
  });
});
