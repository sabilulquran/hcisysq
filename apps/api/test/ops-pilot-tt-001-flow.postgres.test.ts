// OPS-PILOT-TT-001: urutan pilot Cuti Tahunan Taman Tahfizh dari ujung ke ujung, dalam satu uji,
// lewat route dan layanan yang sama dengan production.
//
// Uji yang sudah ada membuktikan potongannya masing-masing:
// - `org004-structure-leave-flow` — pengajuan di bawah STRUCTURE sampai approved/rejected, tetapi
//   baris rollout-nya ditulis dengan SQL dan pemberitahuannya tidak diperiksa;
// - `leave010-requester-decision-notification` — pemberitahuan ke pemohon, tetapi hanya di LEGACY;
// - `activation-invitation` — undangan dan aktivasi pada masuk pertama, tanpa routing.
// Tidak ada yang merangkai keempat sasaran owner (OPS-PILOT-TT-001 §1) dalam urutan §5: baris
// rollout dari route admin, akun penyetuju yang baru aktif lewat undangan, pengajuan yang membaca
// bagan terbit, Setujui dan Tolak, pemberitahuan hasil, lalu jalan mundurnya. Berkas ini yang
// merangkainya.
//
// Bentuk bagannya mengikuti pembacaan production 2026-11-26 (bagan terbit "Kursi Staf Kasir untuk
// peran kasbon"), dengan nama dan id sintetis:
//
//   Yayasan Sintetis
//   └── Bidang Pendidikan Sintetis   ← kursi Kepala Bidang (penyetuju unit)
//       └── Taman Tahfizh Sintetis   ← kursi Kepala (kepala unit); LEADER + UNIT_APPROVER di sini
//           ├── Guru Sintetis        ← tanpa ikatan sendiri
//           └── Tata Usaha Sintetis  ← tanpa ikatan sendiri; pemohon pilot duduk di sini
//
// Kebijakan kekosongan `CLIMB_TO_PARENT`, seperti production. Kolom atasan lama
// (`direct_manager_employee_id`) kosong untuk semua orang, seperti production. Satu transaksi
// per uji yang selalu di-ROLLBACK; SQ Hub dan WhatsApp adalah tiruan.

import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import {
  activateInvitedAccountOnSignIn,
  ActivationInvitationService,
  type InvitationWhatsApp,
} from "../src/modules/auth/activation-invitation.js";
import { AuthService, type AuthPrincipal } from "../src/modules/auth/service.js";
import type { StaffActivationInviter } from "../src/modules/auth/sq-hub-staff-activation.js";
import { encodeWorkingWeekdays } from "../src/modules/leave/domain/working-calendar.js";
import { registerEmployeeLeaveRoutes } from "../src/modules/leave/employee-routes.js";
import { resolveLeaveAuthorities } from "../src/modules/leave/organization-authority.js";
import { registerOrganizationAdminRoutes } from "../src/modules/organization/admin-routes.js";
import { leaveWorkflowKey } from "../src/modules/organization/workflow-keys.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

/** Same savepoint facade as `org004-structure-leave-flow`: whole statements only. */
function savepointPool(client: PoolClient): Pool {
  let depth = 0;
  const run = async (text: string, values?: unknown[]) => {
    const statement = String(text).trim().toUpperCase().replace(/;$/, "").trim();
    if (statement === "BEGIN") return client.query(`SAVEPOINT pilot_sp_${++depth}`);
    if (statement === "COMMIT") {
      const name = `pilot_sp_${depth}`;
      depth -= 1;
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (statement === "ROLLBACK") {
      const name = `pilot_sp_${depth}`;
      depth -= 1;
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    return client.query(text, values);
  };
  const handle = { query: run, release: () => {} };
  return { query: run, connect: async () => handle } as unknown as Pool;
}

const ISSUER = "https://login.example.test/realms/sq-staff";
/** Senin 5 Januari 2099, 08:00 Jakarta. */
const NOW = new Date("2099-01-05T01:00:00.000Z");
const TODAY = "2099-01-05";
const TOMORROW = "2099-01-06";
const FIRST_LEAVE = { startOn: "2099-02-02", endOn: "2099-02-03" };
const SECOND_LEAVE = { startOn: "2099-05-04", endOn: "2099-05-05" };
const ANNUAL = leaveWorkflowKey("annual");

/** The three pilot roles of OPS-PILOT-TT-001 §5.3, plus one teacher and HC. */
const PILOT = ["penyetujuUnit", "kepala", "tataUsaha"] as const;
const PEOPLE = [...PILOT, "guru", "hc"] as const;
type Person = (typeof PEOPLE)[number];

describe.skipIf(!allowed)("OPS-PILOT-TT-001 urutan pilot Cuti Tahunan dari ujung ke ujung (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;
  let transactionPool: Pool;
  let app: ReturnType<typeof Fastify>;
  let auth: AuthService;
  let inviteActor: AuthPrincipal;
  const people = {} as Record<Person, { employeeId: string; accountId: string; cookie: string }>;
  const nodes = { yayasan: "", bidang: "", unit: "", guru: "", tataUsaha: "" };
  const positions = { kepalaBidang: "", kepalaUnit: "" };

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  function call(who: Person, method: "GET" | "POST" | "PATCH", url: string, payload?: object) {
    return app.inject({ method, url, headers: { cookie: people[who].cookie }, ...(payload ? { payload } : {}) });
  }

  async function signInSession(who: Person) {
    const session = await auth.createSessionForAccountId(people[who].accountId, {
      ipAddress: "127.0.0.1", userAgent: "rollback-only-ops-pilot-tt-001",
    });
    people[who].cookie = session.setCookie.split(";")[0]!;
  }

  async function accountStatus(who: Person) {
    return (await client.query<{ status: string }>("SELECT status FROM accounts WHERE id = $1", [people[who].accountId]))
      .rows[0]!.status;
  }

  async function chainFor(who: Person, date = TODAY) {
    return resolveLeaveAuthorities(client, {
      workflowKey: ANNUAL, requesterEmployeeId: people[who].employeeId, effectiveDate: date,
      legacy: { directManagerEmployeeId: null, unitApproverEmployeeId: null },
      policyChain: "LINE_AND_UNIT", allowAccountPrincipal: true,
    });
  }

  async function notifications(who: Person, prefix: string) {
    return (await client.query<{ title: string; body: string; href: string; eventKey: string }>(
      `SELECT title, body, href, event_key AS "eventKey" FROM in_app_notifications
        WHERE recipient_account_id = $1 AND event_key LIKE $2 ORDER BY created_at, event_key`,
      [people[who].accountId, `${prefix}%`],
    )).rows;
  }

  async function inboxOf(who: Person) {
    const response = await call(who, "GET", "/leave/approvals");
    expect(response.statusCode, response.body).toBe(200);
    return (response.json() as { items: Array<{ stepId: string; requestId: string }> }).items;
  }

  /** A fake SQ Hub that answers exactly as HUB-IMPL-024 for each invited employee. */
  function sqHub() {
    const calls: Array<{ employeeNumber: string; accountId: string }> = [];
    const employeeOf = new Map<string, string>();
    for (const who of PEOPLE) employeeOf.set(people[who].accountId, people[who].employeeId);
    const inviter: StaffActivationInviter = {
      invite: async (input) => {
        calls.push(input);
        return {
          identity: { issuer: ISSUER, subject: `kc-${input.accountId}` },
          employeeId: `hcis:employee:${employeeOf.get(input.accountId)}`,
          credentialInitialization: "sent",
          applicationAccess: "granted",
        };
      },
    };
    return { inviter, calls };
  }

  const whatsapp: InvitationWhatsApp = {
    sender: { name: "log", send: async () => ({ id: "log-1", dryRun: true }) },
    allowlist: null,
    origin: "https://hcis.example.test",
  };

  beforeEach(async () => {
    vi.setSystemTime(NOW);
    client = await pool.connect();
    await client.query("BEGIN");
    transactionPool = savepointPool(client);

    const unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'Taman Tahfizh Sintetis')",
      [unitId, `ops-pilot-${unitId}`],
    );
    await client.query(
      `INSERT INTO leave_calendar_settings(singleton, timezone, working_weekday_mask)
       VALUES (true, 'Asia/Jakarta', $1)
       ON CONFLICT (singleton) DO UPDATE SET working_weekday_mask = EXCLUDED.working_weekday_mask`,
      [encodeWorkingWeekdays([1, 2, 3, 4, 5])],
    );
    await client.query("DELETE FROM leave_calendar_exceptions WHERE calendar_date BETWEEN '2099-01-01' AND '2099-12-31'");
    await client.query("DELETE FROM organization_rollout_settings");
    await client.query(
      "UPDATE leave_critical_periods SET is_active = false WHERE starts_on <= '2099-12-31' AND ends_on >= '2099-01-01'",
    );

    const config = {
      NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: databaseUrl!,
      AUTH_MODE: "local", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
    } as ApiConfig;
    auth = new AuthService(transactionPool, config.AUTH_ENCRYPTION_KEY!, 8, false);

    for (const who of PEOPLE) {
      const employeeId = randomUUID();
      // Kelompok hak cuti sengaja kosong, seperti kesembilan pegawai unit pilot hari ini.
      await client.query(
        `INSERT INTO employees(id, employee_number, full_name, status, started_on, email,
                               organizational_unit_id, management_scope)
         VALUES ($1, $2, $3, 'active', '2020-01-06', $4, $5, 'MANAGED')`,
        [employeeId, `PILOT-${employeeId.slice(0, 8)}`, `Pegawai ${who}`,
          `pilot-${employeeId}@example.invalid`, unitId],
      );
      const accountId = randomUUID();
      // Tiga peran pilot dan guru `invited`, seperti di production. HC sudah aktif.
      await client.query(
        "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', $4)",
        [accountId, employeeId, `pilot-acc-${accountId}@example.invalid`, who === "hc" ? "active" : "invited"],
      );
      people[who] = { employeeId, accountId, cookie: "" };
    }
    await signInSession("hc");

    // HC memegang izin yang dipakai panel "Mode persetujuan per unit".
    const roleId = randomUUID();
    await client.query(
      "INSERT INTO roles(id, role_key, name, is_system) VALUES ($1, $2, 'Peran sintetis pilot', false)",
      [roleId, `ops-pilot-${roleId}`],
    );
    await client.query("INSERT INTO role_permissions(role_id, permission_key) VALUES ($1, 'approvals.policy.manage')", [roleId]);
    await client.query(
      "INSERT INTO account_role_assignments(id, account_id, role_id, scope_type) VALUES ($1, $2, $3, 'organization')",
      [randomUUID(), people.hc.accountId, roleId],
    );

    // Pengirim undangan, seperti pada uji AUTH-002-INVITE.
    const adminId = randomUUID();
    await client.query(
      `INSERT INTO accounts (id, email, principal_type, status, password_hash, password_changed_at,
         mfa_secret_ciphertext, mfa_secret_iv, mfa_secret_tag, mfa_enabled_at)
       VALUES ($1, $2, 'SUPER_ADMIN', 'active', 'synthetic-hash', now(),
               'synthetic-ciphertext', 'synthetic-iv', 'synthetic-tag', now())`,
      [adminId, `pilot-admin-${adminId}@example.invalid`],
    );
    inviteActor = { id: adminId, email: `pilot-admin-${adminId}@example.invalid`, principalType: "SUPER_ADMIN" };

    // Bagan yang terbit.
    const changeSet = randomUUID();
    await client.query(
      `INSERT INTO organization_change_sets (id, name, effective_on, status, created_by_account_id, validated_at, published_at)
       VALUES ($1,'Bagan pilot sintetis','2020-01-01'::date,'PUBLISHED',$2, now(), now())`,
      [changeSet, people.hc.accountId],
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
        `INSERT INTO organization_nodes (id, change_set_id, stable_key, name, node_type, parent_node_key, effective_from)
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
         VALUES ($1,$2,$3,$4,$5,$6,'2020-01-01','CLIMB_TO_PARENT')`,
        [randomUUID(), changeSet, positions[key], nodes[nodeKey], title, parent ? positions[parent] : null],
      );
    }
    for (const [positionKey, who] of [["kepalaBidang", "penyetujuUnit"], ["kepalaUnit", "kepala"]] as const) {
      await client.query(
        `INSERT INTO organization_incumbencies (id, change_set_id, position_key, employee_id, kind, effective_from)
         VALUES ($1,$2,$3,$4,'PRIMARY','2020-01-01')`,
        [randomUUID(), changeSet, positions[positionKey], people[who].employeeId],
      );
    }
    for (const [bindingType, target] of [["LEADER", "kepalaUnit"], ["UNIT_APPROVER", "kepalaBidang"]] as const) {
      await client.query(
        `INSERT INTO organization_authority_bindings
           (id, change_set_id, subject_kind, subject_key, binding_type, target_position_key, vacancy_policy, effective_from)
         VALUES ($1,$2,'NODE',$3,$4,$5,'CLIMB_TO_PARENT','2020-01-01')`,
        [randomUUID(), changeSet, nodes.unit, bindingType, positions[target]],
      );
    }
    for (const [who, nodeKey] of [
      ["kepala", "unit"], ["guru", "guru"], ["tataUsaha", "tataUsaha"], ["penyetujuUnit", "bidang"],
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

  it("§5 berurutan: rollout dari layar, undangan, pengajuan dari bagan, Setujui, Tolak, pemberitahuan, Akhiri", async () => {
    // 0. Hari ini production: tanpa baris rollout, kolom atasan lama kosong menolak pengajuan.
    await expect(chainFor("tataUsaha")).rejects.toMatchObject({ code: "DIRECT_MANAGER_MISSING" });

    // 1. §5.5 — HC memindahkan unit ke bagan lewat route panel "Mode persetujuan per unit".
    const rollout = await call("hc", "PATCH", "/admin/organization/rollout", {
      mode: "STRUCTURE", workflowKey: ANNUAL, organizationalNodeKey: nodes.unit,
      effectiveFrom: TODAY, reason: "Pilot Cuti Tahunan Taman Tahfizh",
    });
    expect(rollout.statusCode, rollout.body).toBe(200);
    const rolloutId = rollout.json().id as string;
    const changedAudit = await client.query(
      "SELECT 1 FROM organization_audit_events WHERE action = 'organization.rollout.changed' AND entity_id = $1",
      [rolloutId],
    );
    expect(changedAudit.rowCount).toBe(1);

    // 2. Rantai kini dibaca dari bagan, tetapi berhenti di kursi kepala unit selama akunnya invited
    //    (ORG-004 D-R5): tidak memanjat diam-diam melewati orang yang belum masuk.
    await expect(chainFor("tataUsaha")).rejects.toMatchObject({ code: "APPROVER_ACCOUNT_NOT_READY" });

    // 3. §5.3 — undangan Akun SQ, penyetuju lebih dulu, lalu masuk pertama mengaktifkan akun.
    const hub = sqHub();
    const service = new ActivationInvitationService(transactionPool, hub.inviter, whatsapp, ISSUER);
    for (const who of PILOT) {
      const sent = await service.send(people[who].accountId, inviteActor);
      expect(sent).toMatchObject({ emailStatus: "sent", hubAccess: "granted" });
      expect(await accountStatus(who)).toBe("invited");
      const activated = await activateInvitedAccountOnSignIn(transactionPool, {
        accountId: people[who].accountId, issuer: ISSUER, subject: `kc-${people[who].accountId}`,
        ipAddress: "127.0.0.1", userAgent: "vitest",
      });
      expect(activated).toBe(true);
      expect(await accountStatus(who)).toBe("active");
      await signInSession(who);
    }
    expect(hub.calls.map((c) => c.accountId)).toEqual(PILOT.map((who) => people[who].accountId));
    // Guru tidak diundang, dan tidak ikut aktif.
    expect(await accountStatus("guru")).toBe("invited");

    // 4. §5.1 — selama kelompok hak cuti kosong, pengajuan berhenti sebelum rantai disentuh.
    const blocked = await call("tataUsaha", "POST", "/leave/me/annual/submit", {
      ...FIRST_LEAVE, reason: "Acara keluarga", idempotencyKey: randomUUID(),
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    // Dulu 500: galat modul kebijakan tidak dipetakan route mana pun (diperbaiki 2026-11-26).
    expect(blocked.json()).toMatchObject({ code: "UNSUPPORTED_ENTITLEMENT_GROUP" });
    expect(blocked.json().message).toContain("belum ditetapkan oleh Human Capital");
    const previewBlocked = await call("tataUsaha", "POST", "/leave/me/annual/preview", FIRST_LEAVE);
    expect(previewBlocked.statusCode, previewBlocked.body).toBe(409);
    // Tanggal yang tidak ada di kalender dulu sampai ke PostgreSQL dan menjadi 500.
    const impossible = await call("tataUsaha", "POST", "/leave/me/annual/preview", { startOn: "2099-02-30", endOn: "2099-03-02" });
    expect(impossible.statusCode, impossible.body).toBe(400);
    // HC menetapkan kelompoknya (di production lewat Admin → Konfigurasi Cuti).
    await client.query("UPDATE employees SET leave_entitlement_group = 'non_education' WHERE id = $1", [people.tataUsaha.employeeId]);

    // 5. Sasaran 2 — pengajuan masuk ke penyetuju yang benar, dari bagan terbit.
    const submitted = await call("tataUsaha", "POST", "/leave/me/annual/submit", {
      ...FIRST_LEAVE, reason: "Acara keluarga", idempotencyKey: randomUUID(),
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const first = submitted.json() as { id: string; approvalChain: Array<{ employeeId: string | null }> };
    expect(first.approvalChain.map((s) => s.employeeId)).toEqual([people.kepala.employeeId, people.penyetujuUnit.employeeId]);
    const storedContext = await client.query<{ mode: string; source: string }>(
      `SELECT validation_summary->'authorityResolution'->>'mode' AS mode,
              validation_summary->'authorityResolution'->>'authoritativeSource' AS source
         FROM leave_requests WHERE id = $1`,
      [first.id],
    );
    expect(storedContext.rows[0]).toEqual({ mode: "STRUCTURE", source: "STRUCTURE" });
    expect(await notifications("kepala", "leave.approval.requested.")).toHaveLength(1);
    expect(await inboxOf("penyetujuUnit")).toEqual([]);

    // 6. Sasaran 3 — Setujui dari layar, dua langkah.
    const [kepalaStep] = await inboxOf("kepala");
    expect(kepalaStep?.requestId).toBe(first.id);
    const approve1 = await call("kepala", "POST", `/leave/approvals/${kepalaStep!.stepId}/decision`, { decision: "approve" });
    expect(approve1.statusCode, approve1.body).toBe(200);
    expect(approve1.json()).toMatchObject({ requestStatus: "in_review" });
    expect(await notifications("penyetujuUnit", "leave.approval.requested.")).toHaveLength(1);
    const [unitStep] = await inboxOf("penyetujuUnit");
    expect(unitStep?.requestId).toBe(first.id);
    const approve2 = await call("penyetujuUnit", "POST", `/leave/approvals/${unitStep!.stepId}/decision`, { decision: "approve" });
    expect(approve2.statusCode, approve2.body).toBe(200);
    expect(approve2.json()).toMatchObject({ requestStatus: "approved" });

    // 7. Sasaran 4 — pemohon menerima hasilnya.
    const approvedNote = await notifications("tataUsaha", `leave.request.decided.${first.id}`);
    expect(approvedNote).toHaveLength(1);
    expect(approvedNote[0]).toMatchObject({ title: "Pengajuan cuti Anda disetujui" });

    // 8. Sasaran 3 dan 4 — Tolak dengan alasan; alasannya tersimpan, tidak bocor ke lonceng.
    const second = await call("tataUsaha", "POST", "/leave/me/annual/submit", {
      ...SECOND_LEAVE, reason: "Urusan keluarga", idempotencyKey: randomUUID(),
    });
    expect(second.statusCode, second.body).toBe(201);
    const secondId = second.json().id as string;
    const [rejectStep] = await inboxOf("kepala");
    expect(rejectStep?.requestId).toBe(secondId);
    const reason = "Bertepatan dengan penerimaan rapor";
    const rejected = await call("kepala", "POST", `/leave/approvals/${rejectStep!.stepId}/decision`, { decision: "reject", note: reason });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json()).toMatchObject({ requestStatus: "rejected" });
    const storedNote = await client.query<{ note: string }>(
      "SELECT decision_note AS note FROM leave_request_approval_steps WHERE id = $1", [rejectStep!.stepId],
    );
    expect(storedNote.rows[0]!.note).toBe(reason);
    const rejectedNote = await notifications("tataUsaha", `leave.request.decided.${secondId}`);
    expect(rejectedNote).toHaveLength(1);
    expect(rejectedNote[0]).toMatchObject({ title: "Pengajuan cuti Anda ditolak" });
    expect(rejectedNote[0]!.body).not.toContain(reason);
    // Penyetuju unit tidak pernah melihat pengajuan yang ditolak di langkah pertama.
    expect(await inboxOf("penyetujuUnit")).toEqual([]);

    // 9. Jalan mundur — Akhiri. Hari ini tetap STRUCTURE, besok kembali ke data atasan lama, dan
    //    rantai pengajuan yang sudah tersimpan tidak disentuh.
    const ended = await call("hc", "POST", `/admin/organization/rollout/${rolloutId}/end`, { reason: "Pilot selesai" });
    expect(ended.statusCode, ended.body).toBe(200);
    const endedAudit = await client.query(
      "SELECT 1 FROM organization_audit_events WHERE action = 'organization.rollout.ended' AND entity_id = $1",
      [rolloutId],
    );
    expect(endedAudit.rowCount).toBe(1);
    expect((await chainFor("tataUsaha", TODAY)).context.mode).toBe("STRUCTURE");
    await expect(chainFor("tataUsaha", TOMORROW)).rejects.toMatchObject({ code: "DIRECT_MANAGER_MISSING" });
    const steps = await client.query<{ approver: string }>(
      `SELECT approver_employee_id AS approver FROM leave_request_approval_steps
        WHERE leave_request_id = $1 ORDER BY step_order`,
      [first.id],
    );
    expect(steps.rows.map((r) => r.approver)).toEqual([people.kepala.employeeId, people.penyetujuUnit.employeeId]);
  });

  it("kepala unit sebagai pemohon langsung ke penyetuju unit, dan guru mendaki ke kepala unit", async () => {
    const rollout = await call("hc", "PATCH", "/admin/organization/rollout", {
      mode: "STRUCTURE", workflowKey: ANNUAL, organizationalNodeKey: nodes.unit,
      effectiveFrom: TODAY, reason: "Pilot Cuti Tahunan Taman Tahfizh",
    });
    expect(rollout.statusCode, rollout.body).toBe(200);
    await client.query("UPDATE accounts SET status = 'active' WHERE id = ANY($1::uuid[])",
      [[people.kepala.accountId, people.penyetujuUnit.accountId]]);

    const kepala = await chainFor("kepala");
    expect(kepala.approvalChain.map((s) => s.employeeId)).toEqual([people.penyetujuUnit.employeeId]);
    const guru = await chainFor("guru");
    expect(guru.context.mode).toBe("STRUCTURE");
    expect(guru.approvalChain.map((s) => s.employeeId)).toEqual([people.kepala.employeeId, people.penyetujuUnit.employeeId]);
  });
});
