// OPS-PILOT-GA-001: pilot Cuti Tahunan General Affair, dari baris rollout sampai pemberitahuan hasil,
// dengan bagan sintetis yang meniru bentuk ikatan bagan terbit (bukan orang-orangnya).
//
//   Direksi Sintetis              ← kursi Direktur (berpejabat)
//   └── Bidang Operasional Sint.  ← kursi Kepala Bidang KOSONG, CLIMB_TO_PARENT ke Direktur
//       ├── General Affair Sint.  ← kursi Kepala GA; LEADER → Kepala GA, UNIT_APPROVER → Kepala Bidang (kosong)
//       │   ├── Sub-node A        ← tanpa ikatan sendiri
//       │   ├── Sub-node B        ← tanpa ikatan sendiri
//       │   └── Sub-node berpimpinan ← LEADER → pimpinan sub-node (tanpa akun), UNIT_APPROVER → Kepala GA
//       │       └── Cucu sub-node ← tanpa ikatan sendiri
//       └── Unit tetangga Sint.   ← di luar pilot
//
// Yang dibuktikan, berbeda dari pilot Taman Tahfizh (`ops-pilot-tt-001-flow`):
// 1. kursi penyetuju unit yang kosong mendaki ke Direktur, bukan menolak;
// 2. Kepala GA sebagai pemohon diputuskan oleh Direktur saja;
// 3. sub-node yang punya pimpinan sendiri tanpa akun berhenti tertutup, tidak melompati kursi itu;
// 4. baris rollout pada General Affair tidak menyentuh unit tetangga;
// 5. dua peserta, dua pengajuan selesai diputuskan, Setujui dan Tolak, dan pemberitahuan pemohon.
//
// Semua baris sintetis, satu transaksi per uji yang selalu di-ROLLBACK; SQ Hub dan WhatsApp tiruan.
// Kelompok `non_education` peserta kedua dipasang di fixture hanya sebagai keadaan "sesudah HCM
// menetapkannya" — uji ini tidak menyatakan siapa pun di production berhak.

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

function savepointPool(client: PoolClient): Pool {
  let depth = 0;
  const run = async (text: string, values?: unknown[]) => {
    const statement = String(text).trim().toUpperCase().replace(/;$/, "").trim();
    if (statement === "BEGIN") return client.query(`SAVEPOINT ga_sp_${++depth}`);
    if (statement === "COMMIT") {
      const name = `ga_sp_${depth}`;
      depth -= 1;
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (statement === "ROLLBACK") {
      const name = `ga_sp_${depth}`;
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
const NOW = new Date("2099-01-05T01:00:00.000Z");
const TODAY = "2099-01-05";
const FIRST_LEAVE = { startOn: "2099-02-02", endOn: "2099-02-03" };
const SECOND_LEAVE = { startOn: "2099-05-04", endOn: "2099-05-05" };
const ANNUAL = leaveWorkflowKey("annual");

const PEOPLE = ["direktur", "kepalaGa", "anggotaA", "anggotaB", "pimpinanSub", "cucuSub", "keuangan", "hc"] as const;
type Person = (typeof PEOPLE)[number];
/** Holders of a seat the chain reaches, and the two pilot participants, start `invited`. */
const INVITED: readonly Person[] = ["direktur", "kepalaGa", "anggotaA", "anggotaB", "cucuSub"];
/** A sub-node head with no e-mail and no account at all. */
const NO_ACCOUNT: readonly Person[] = ["pimpinanSub"];

describe.skipIf(!allowed)("OPS-PILOT-GA-001 pilot Cuti Tahunan General Affair (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;
  let transactionPool: Pool;
  let app: ReturnType<typeof Fastify>;
  let auth: AuthService;
  let inviteActor: AuthPrincipal;
  const people = {} as Record<Person, { employeeId: string; accountId: string | null; cookie: string }>;
  const nodes = { direksi: "", bidang: "", ga: "", subA: "", subB: "", subLed: "", cucuSub: "", keuangan: "" };
  const seats = { direktur: "", kepalaBidang: "", kepalaGa: "", pimpinanSubSeat: "", kepalaKeuangan: "" };

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  function call(who: Person, method: "GET" | "POST" | "PATCH", url: string, payload?: object) {
    return app.inject({ method, url, headers: { cookie: people[who].cookie }, ...(payload ? { payload } : {}) });
  }

  async function signInSession(who: Person) {
    const session = await auth.createSessionForAccountId(people[who].accountId!, {
      ipAddress: "127.0.0.1", userAgent: "rollback-only-ops-pilot-ga-001",
    });
    people[who].cookie = session.setCookie.split(";")[0]!;
  }

  async function chainFor(who: Person) {
    return resolveLeaveAuthorities(client, {
      workflowKey: ANNUAL, requesterEmployeeId: people[who].employeeId, effectiveDate: TODAY,
      legacy: { directManagerEmployeeId: null, unitApproverEmployeeId: null },
      policyChain: "LINE_AND_UNIT", allowAccountPrincipal: true,
    });
  }

  async function inboxOf(who: Person) {
    const response = await call(who, "GET", "/leave/approvals");
    expect(response.statusCode, response.body).toBe(200);
    return (response.json() as { items: Array<{ stepId: string; requestId: string }> }).items;
  }

  async function decided(who: Person, requestId: string) {
    return (await client.query<{ title: string; body: string }>(
      "SELECT title, body FROM in_app_notifications WHERE recipient_account_id = $1 AND event_key = $2",
      [people[who].accountId, `leave.request.decided.${requestId}`],
    )).rows;
  }

  async function submit(who: Person, dates: { startOn: string; endOn: string }) {
    const response = await call(who, "POST", "/leave/me/annual/submit", {
      ...dates, reason: "Keperluan keluarga", idempotencyKey: randomUUID(),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; approvalChain: Array<{ employeeId: string | null }> };
  }

  async function decide(who: Person, requestId: string, decision: "approve" | "reject", note?: string) {
    const items = await inboxOf(who);
    const step = items.find((item) => item.requestId === requestId);
    expect(step, `${who} has no pending step for ${requestId}`).toBeDefined();
    const response = await call(who, "POST", `/leave/approvals/${step!.stepId}/decision`, {
      decision, ...(note ? { note } : {}),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { requestStatus: string };
  }

  const whatsapp: InvitationWhatsApp = {
    sender: { name: "log", send: async () => ({ id: "log-1", dryRun: true }) },
    allowlist: null,
    origin: "https://hcis.example.test",
  };

  function sqHub() {
    const employeeOf = new Map<string, string>();
    for (const who of PEOPLE) if (people[who].accountId) employeeOf.set(people[who].accountId!, people[who].employeeId);
    const inviter: StaffActivationInviter = {
      invite: async (input) => ({
        identity: { issuer: ISSUER, subject: `kc-${input.accountId}` },
        employeeId: `hcis:employee:${employeeOf.get(input.accountId)}`,
        credentialInitialization: "sent",
        applicationAccess: "granted",
      }),
    };
    return inviter;
  }

  async function inviteAndSignIn(who: Person) {
    const service = new ActivationInvitationService(transactionPool, sqHub(), whatsapp, ISSUER);
    const sent = await service.send(people[who].accountId!, inviteActor);
    expect(sent).toMatchObject({ emailStatus: "sent", hubAccess: "granted" });
    const activated = await activateInvitedAccountOnSignIn(transactionPool, {
      accountId: people[who].accountId!, issuer: ISSUER, subject: `kc-${people[who].accountId}`,
      ipAddress: "127.0.0.1", userAgent: "vitest",
    });
    expect(activated).toBe(true);
    await signInSession(who);
  }

  async function writeRollout() {
    const response = await call("hc", "PATCH", "/admin/organization/rollout", {
      mode: "STRUCTURE", workflowKey: ANNUAL, organizationalNodeKey: nodes.ga,
      effectiveFrom: TODAY, reason: "Pilot Cuti Tahunan General Affair",
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().id as string;
  }

  beforeEach(async () => {
    vi.setSystemTime(NOW);
    client = await pool.connect();
    await client.query("BEGIN");
    transactionPool = savepointPool(client);

    const unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'General Affair Sintetis')",
      [unitId, `ops-pilot-ga-${unitId}`],
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
      // Production: only the GA head is recorded `non_education`; everyone else is unclassified.
      await client.query(
        `INSERT INTO employees(id, employee_number, full_name, status, started_on, email,
                               organizational_unit_id, leave_entitlement_group, management_scope)
         VALUES ($1, $2, $3, 'active', '2020-01-06', $4, $5, $6, 'MANAGED')`,
        [employeeId, `GA-${employeeId.slice(0, 8)}`, `Pegawai ${who}`,
          NO_ACCOUNT.includes(who) ? null : `ga-${employeeId}@example.invalid`, unitId,
          who === "kepalaGa" ? "non_education" : null],
      );
      let accountId: string | null = null;
      if (!NO_ACCOUNT.includes(who)) {
        accountId = randomUUID();
        await client.query(
          "INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', $4)",
          [accountId, employeeId, `ga-acc-${accountId}@example.invalid`, INVITED.includes(who) ? "invited" : "active"],
        );
      }
      people[who] = { employeeId, accountId, cookie: "" };
    }
    await signInSession("hc");

    const roleId = randomUUID();
    await client.query(
      "INSERT INTO roles(id, role_key, name, is_system) VALUES ($1, $2, 'Peran sintetis pilot GA', false)",
      [roleId, `ops-pilot-ga-${roleId}`],
    );
    await client.query("INSERT INTO role_permissions(role_id, permission_key) VALUES ($1, 'approvals.policy.manage')", [roleId]);
    await client.query(
      "INSERT INTO account_role_assignments(id, account_id, role_id, scope_type) VALUES ($1, $2, $3, 'organization')",
      [randomUUID(), people.hc.accountId, roleId],
    );

    const adminId = randomUUID();
    await client.query(
      `INSERT INTO accounts (id, email, principal_type, status, password_hash, password_changed_at,
         mfa_secret_ciphertext, mfa_secret_iv, mfa_secret_tag, mfa_enabled_at)
       VALUES ($1, $2, 'SUPER_ADMIN', 'active', 'synthetic-hash', now(),
               'synthetic-ciphertext', 'synthetic-iv', 'synthetic-tag', now())`,
      [adminId, `ga-admin-${adminId}@example.invalid`],
    );
    inviteActor = { id: adminId, email: `ga-admin-${adminId}@example.invalid`, principalType: "SUPER_ADMIN" };

    const changeSet = randomUUID();
    await client.query(
      `INSERT INTO organization_change_sets (id, name, effective_on, status, created_by_account_id, validated_at, published_at)
       VALUES ($1,'Bagan pilot GA sintetis','2020-01-01'::date,'PUBLISHED',$2, now(), now())`,
      [changeSet, people.hc.accountId],
    );
    for (const [key, parent, name] of [
      ["direksi", null, "Direksi Sintetis"],
      ["bidang", "direksi", "Bidang Operasional Sintetis"],
      ["ga", "bidang", "General Affair Sintetis"],
      ["subA", "ga", "Sub-node A Sintetis"],
      ["subB", "ga", "Sub-node B Sintetis"],
      ["subLed", "ga", "Sub-node Berpimpinan Sintetis"],
      ["cucuSub", "subLed", "Cucu Sub-node Sintetis"],
      ["keuangan", "bidang", "Keuangan Sintetis"],
    ] as const) {
      nodes[key] = randomUUID();
      await client.query(
        `INSERT INTO organization_nodes (id, change_set_id, stable_key, name, node_type, parent_node_key, effective_from)
         VALUES ($1,$2,$3,$4,'UNIT',$5,'2020-01-01')`,
        [randomUUID(), changeSet, nodes[key], name, parent ? nodes[parent] : null],
      );
    }
    for (const [key, nodeKey, parent, title] of [
      ["direktur", "direksi", null, "Direktur Sintetis"],
      ["kepalaBidang", "bidang", "direktur", "Kepala Bidang Sintetis"],
      ["kepalaGa", "ga", "kepalaBidang", "Kepala GA Sintetis"],
      ["pimpinanSubSeat", "subLed", "kepalaGa", "Pimpinan Sub-node Sintetis"],
      ["kepalaKeuangan", "keuangan", "kepalaBidang", "Kepala Keuangan Sintetis"],
    ] as const) {
      seats[key] = randomUUID();
      await client.query(
        `INSERT INTO organization_positions
           (id, change_set_id, stable_key, node_key, title, parent_position_key, effective_from, vacancy_policy)
         VALUES ($1,$2,$3,$4,$5,$6,'2020-01-01','CLIMB_TO_PARENT')`,
        [randomUUID(), changeSet, seats[key], nodes[nodeKey], title, parent ? seats[parent] : null],
      );
    }
    // Kepala Bidang Operasional is deliberately left without an incumbent, as in production.
    for (const [seat, who] of [
      ["direktur", "direktur"], ["kepalaGa", "kepalaGa"],
      ["pimpinanSubSeat", "pimpinanSub"], ["kepalaKeuangan", "keuangan"],
    ] as const) {
      await client.query(
        `INSERT INTO organization_incumbencies (id, change_set_id, position_key, employee_id, kind, effective_from)
         VALUES ($1,$2,$3,$4,'PRIMARY','2020-01-01')`,
        [randomUUID(), changeSet, seats[seat], people[who].employeeId],
      );
    }
    for (const [nodeKey, bindingType, target] of [
      ["direksi", "LEADER", "direktur"],
      ["bidang", "LEADER", "kepalaBidang"],
      ["ga", "LEADER", "kepalaGa"],
      ["ga", "UNIT_APPROVER", "kepalaBidang"],
      ["subLed", "LEADER", "pimpinanSubSeat"],
      ["subLed", "UNIT_APPROVER", "kepalaGa"],
      ["keuangan", "LEADER", "kepalaKeuangan"],
      ["keuangan", "UNIT_APPROVER", "kepalaBidang"],
    ] as const) {
      await client.query(
        `INSERT INTO organization_authority_bindings
           (id, change_set_id, subject_kind, subject_key, binding_type, target_position_key, vacancy_policy, effective_from)
         VALUES ($1,$2,'NODE',$3,$4,$5,'CLIMB_TO_PARENT','2020-01-01')`,
        [randomUUID(), changeSet, nodes[nodeKey], bindingType, seats[target]],
      );
    }
    for (const [who, nodeKey] of [
      ["direktur", "direksi"], ["kepalaGa", "ga"], ["anggotaA", "subA"], ["anggotaB", "subB"],
      ["pimpinanSub", "subLed"], ["cucuSub", "cucuSub"], ["keuangan", "keuangan"],
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

  it("rantai dari bagan: kursi penyetuju unit yang kosong mendaki ke Direktur; sub-node berpimpinan tanpa akun berhenti tertutup; unit tetangga tetap LEGACY", async () => {
    // Hari ini production: tanpa baris rollout, data atasan lama kosong.
    await expect(chainFor("anggotaA")).rejects.toMatchObject({ code: "DIRECT_MANAGER_MISSING" });

    await writeRollout();
    // Selama akun Kepala GA invited, rantai berhenti di kursinya, tidak memanjat diam-diam.
    await expect(chainFor("anggotaA")).rejects.toMatchObject({ code: "APPROVER_ACCOUNT_NOT_READY" });

    await client.query("UPDATE accounts SET status = 'active' WHERE id = ANY($1::uuid[])",
      [[people.kepalaGa.accountId, people.direktur.accountId]]);

    for (const who of ["anggotaA", "anggotaB"] as const) {
      const chain = await chainFor(who);
      expect(chain.context.mode).toBe("STRUCTURE");
      expect(chain.approvalChain.map((s) => s.employeeId)).toEqual([
        people.kepalaGa.employeeId, people.direktur.employeeId,
      ]);
    }
    const head = await chainFor("kepalaGa");
    expect(head.approvalChain.map((s) => s.employeeId)).toEqual([people.direktur.employeeId]);

    // Pimpinan sub-node berpejabat tetapi tanpa akun: menolak, tidak melompati kursinya.
    await expect(chainFor("cucuSub")).rejects.toMatchObject({ code: "APPROVER_ACCOUNT_NOT_READY" });

    // Unit tetangga di bawah Bidang Operasional tidak ikut pindah.
    await expect(chainFor("keuangan")).rejects.toMatchObject({ code: "DIRECT_MANAGER_MISSING" });
  });

  it("dua peserta, dua pengajuan selesai diputuskan: Setujui dua langkah, Tolak di langkah pertama, Setujui oleh Direktur, dengan pemberitahuan", async () => {
    const rolloutId = await writeRollout();
    // Penyetuju lebih dulu, lalu kedua peserta.
    for (const who of ["direktur", "kepalaGa", "anggotaA"] as const) await inviteAndSignIn(who);

    // Peserta kedua belum diklasifikasi: berhenti 409 sebelum rantai disentuh.
    const blocked = await call("anggotaA", "POST", "/leave/me/annual/submit", {
      ...FIRST_LEAVE, reason: "Keperluan keluarga", idempotencyKey: randomUUID(),
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "UNSUPPORTED_ENTITLEMENT_GROUP" });
    // Keadaan "sesudah HCM menetapkan" — hanya di fixture.
    await client.query("UPDATE employees SET leave_entitlement_group = 'non_education' WHERE id = $1", [people.anggotaA.employeeId]);

    // Peserta B (anggota sub-node A) — S1 Setujui.
    const s1 = await submit("anggotaA", FIRST_LEAVE);
    expect(s1.approvalChain.map((s) => s.employeeId)).toEqual([people.kepalaGa.employeeId, people.direktur.employeeId]);
    expect((await decide("kepalaGa", s1.id, "approve")).requestStatus).toBe("in_review");
    expect((await decide("direktur", s1.id, "approve")).requestStatus).toBe("approved");
    expect(await decided("anggotaA", s1.id)).toEqual([expect.objectContaining({ title: "Pengajuan cuti Anda disetujui" })]);

    // Peserta 1 — S2 Tolak di langkah pertama; Direktur tidak pernah menerimanya.
    const s2 = await submit("anggotaA", SECOND_LEAVE);
    const reason = "Bertepatan dengan jadwal jaga";
    expect((await decide("kepalaGa", s2.id, "reject", reason)).requestStatus).toBe("rejected");
    expect((await inboxOf("direktur")).map((i) => i.requestId)).not.toContain(s2.id);
    const rejected = await decided("anggotaA", s2.id);
    expect(rejected).toEqual([expect.objectContaining({ title: "Pengajuan cuti Anda ditolak" })]);
    expect(rejected[0]!.body).not.toContain(reason);

    // Peserta 2 (Kepala GA, kelompok tercatat) — diputuskan Direktur saja.
    const s3 = await submit("kepalaGa", FIRST_LEAVE);
    expect(s3.approvalChain.map((s) => s.employeeId)).toEqual([people.direktur.employeeId]);
    expect((await decide("direktur", s3.id, "approve")).requestStatus).toBe("approved");
    expect(await decided("kepalaGa", s3.id)).toEqual([expect.objectContaining({ title: "Pengajuan cuti Anda disetujui" })]);

    // Jalan mundur tersedia dan teraudit.
    const ended = await call("hc", "POST", `/admin/organization/rollout/${rolloutId}/end`, { reason: "Pilot selesai" });
    expect(ended.statusCode, ended.body).toBe(200);
    const audit = await client.query(
      "SELECT action FROM organization_audit_events WHERE entity_id = $1",
      [rolloutId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["organization.rollout.changed", "organization.rollout.ended"]));
  });
});
