// ORG-001: penetapan atasan langsung massal — dry-run wajib, lalu penerapan
// satu transaksi. Fake pool dengan master pegawai sintetis yang benar-benar
// berubah saat UPDATE dijalankan, sehingga idempotensi dan "data bergeser di
// bawah preview" dapat diuji sungguhan, bukan hanya dicocokkan ke string SQL.

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerManagerAssignmentAdminRoutes } from "../src/modules/employees/admin-manager-assignment-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://manager-assignment-bulk-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "77".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const ACTOR_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";

interface FakeEmployee {
  id: string;
  employeeNumber: string;
  fullName: string;
  status: "active" | "inactive" | "resigned";
  managementScope: "MANAGED" | "OUTSIDE_HCIS";
  directManagerEmployeeId: string | null;
}

function employee(
  index: number,
  overrides: Partial<Omit<FakeEmployee, "id" | "employeeNumber">> = {},
): FakeEmployee {
  return {
    id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    employeeNumber: `YSQ-${String(index).padStart(3, "0")}`,
    fullName: `Pegawai ${index}`,
    status: "active",
    managementScope: "MANAGED",
    directManagerEmployeeId: null,
    ...overrides,
  };
}

interface AuditEvent {
  action: string;
  entityType: string;
  entityId: string | null;
  payload: Record<string, unknown>;
}

function createPool(employees: FakeEmployee[], permissions = ["approvals.policy.manage"]) {
  const master = new Map(employees.map((row) => [row.id, { ...row }]));
  const audits: AuditEvent[] = [];
  const statements: string[] = [];

  const byNumber = () => new Map([...master.values()].map((row) => [row.employeeNumber, row]));

  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    const text = sql.trim();
    if (text.includes("FROM auth_sessions s")) {
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000100",
          accountId: ACTOR_ACCOUNT_ID,
          email: "hc@example.org",
          principalType: "EMPLOYEE",
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        }],
        rowCount: 1,
      };
    }
    if (text.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    if (text.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) {
      return { rows: permissions.map((permissionKey) => ({ permissionKey })), rowCount: permissions.length };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) {
      statements.push(text.split(/\s/)[0]!);
      return { rows: [], rowCount: 0 };
    }

    if (text.includes("FOR UPDATE")) {
      statements.push("LOCK");
      const wanted = new Set((values?.[0] as string[]) ?? []);
      const rows = [...byNumber().values()]
        .filter((row) => wanted.has(row.employeeNumber))
        .map((row) => ({ id: row.id }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes("WHERE employee_number = ANY($1::text[])")) {
      const wanted = new Set((values?.[0] as string[]) ?? []);
      const rows = [...master.values()].filter((row) => wanted.has(row.employeeNumber)).map((row) => ({ ...row }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes("WHERE id = ANY($1::uuid[])")) {
      const wanted = new Set((values?.[0] as string[]) ?? []);
      const rows = [...master.values()].filter((row) => wanted.has(row.id)).map((row) => ({ ...row }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes("direct_manager_employee_id IS NOT NULL")) {
      const rows = [...master.values()]
        .filter((row) => row.directManagerEmployeeId)
        .map((row) => ({ id: row.id, directManagerEmployeeId: row.directManagerEmployeeId }));
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("UPDATE employees")) {
      statements.push("UPDATE");
      const employeeIds = (values?.[0] as string[]) ?? [];
      const managerIds = (values?.[1] as (string | null)[]) ?? [];
      employeeIds.forEach((id, index) => {
        const row = master.get(id);
        if (row) row.directManagerEmployeeId = managerIds[index] ?? null;
      });
      return { rows: [], rowCount: employeeIds.length };
    }
    if (text.includes("INSERT INTO access_audit_events") && text.includes("unnest")) {
      const employeeIds = (values?.[2] as string[]) ?? [];
      const payloads = (values?.[3] as string[]) ?? [];
      employeeIds.forEach((entityId, index) => {
        audits.push({
          action: "employee.manager.updated",
          entityType: "employee",
          entityId,
          payload: JSON.parse(payloads[index]!),
        });
      });
      return { rows: [], rowCount: employeeIds.length };
    }
    if (text.includes("INSERT INTO access_audit_events")) {
      audits.push({
        action: "employee.manager.batch_applied",
        entityType: "employee_manager_batch",
        entityId: String(values?.[2]),
        payload: JSON.parse(String(values?.[3])),
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const pool = {
    query,
    connect: async () => ({ query, release: () => undefined }),
  } as unknown as Pool;

  return { pool, master, audits, statements };
}

function csv(rows: Array<[string, string]>): string {
  return ["NIP,NIP ATASAN", ...rows.map(([nip, manager]) => `${nip},${manager}`)].join("\r\n");
}

async function withApp<T>(pool: Pool, run: (app: Awaited<ReturnType<typeof build>>) => Promise<T>): Promise<T> {
  const app = await build(pool);
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

async function build(pool: Pool) {
  const app = Fastify({ logger: false });
  app.addContentTypeParser(["text/csv"], { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  await registerManagerAssignmentAdminRoutes(app, pool, config);
  return app;
}

function previewRequest(body: string) {
  return {
    method: "POST" as const,
    url: "/admin/employees/manager-assignments/preview",
    headers: {
      cookie: "hcis_session=test-token",
      "content-type": "text/csv",
      "x-file-name": "atasan.csv",
    },
    payload: body,
  };
}

function applyRequest(body: string, token: string) {
  return {
    method: "POST" as const,
    url: "/admin/employees/manager-assignments/apply",
    headers: {
      cookie: "hcis_session=test-token",
      "content-type": "text/csv",
      "x-file-name": "atasan.csv",
      "x-preview-token": token,
    },
    payload: body,
  };
}

function rowFor(preview: { rows: Array<{ employeeNumber: string }> }, employeeNumber: string) {
  return preview.rows.find((row) => row.employeeNumber === employeeNumber)!;
}

describe("ORG-001 dry-run penetapan atasan langsung massal", () => {
  it("melaporkan baris tidak berubah, baris berubah dengan nama lama dan nama baru", async () => {
    const atasan = employee(1);
    const sudahBenar = employee(2, { directManagerEmployeeId: atasan.id });
    const belumPunya = employee(3);
    const { pool, master } = createPool([atasan, sudahBenar, belumPunya]);

    const response = await withApp(pool, (app) =>
      app.inject(previewRequest(csv([
        [sudahBenar.employeeNumber, atasan.employeeNumber],
        [belumPunya.employeeNumber, atasan.employeeNumber],
      ]))));

    expect(response.statusCode).toBe(200);
    const preview = response.json();
    expect(preview.applicable).toBe(true);
    expect(preview.unchangedCount).toBe(1);
    expect(preview.changeCount).toBe(1);
    expect(preview.refusedCount).toBe(0);
    expect(rowFor(preview, sudahBenar.employeeNumber)).toMatchObject({
      outcome: "unchanged",
      employeeName: sudahBenar.fullName,
      toManager: { employeeNumber: atasan.employeeNumber, fullName: atasan.fullName },
    });
    expect(rowFor(preview, belumPunya.employeeNumber)).toMatchObject({
      outcome: "change",
      fromManager: null,
      toManager: { employeeNumber: atasan.employeeNumber, fullName: atasan.fullName },
    });
    // Dry-run tidak menulis apa pun.
    expect(master.get(belumPunya.id)!.directManagerEmployeeId).toBeNull();
  });

  it("menangkap siklus yang dibentuk dua baris dalam satu berkas", async () => {
    // Tidak satu pun baris ini membentuk siklus bila dikirim sendirian.
    const a = employee(1);
    const b = employee(2);
    const { pool } = createPool([a, b]);

    const response = await withApp(pool, (app) =>
      app.inject(previewRequest(csv([
        [a.employeeNumber, b.employeeNumber],
        [b.employeeNumber, a.employeeNumber],
      ]))));

    const preview = response.json();
    expect(preview.applicable).toBe(false);
    expect(rowFor(preview, a.employeeNumber).code).toBe("REPORTING_LINE_CYCLE");
    expect(rowFor(preview, b.employeeNumber).code).toBe("REPORTING_LINE_CYCLE");
  });

  it("menangkap siklus terhadap reporting line yang sudah ada", async () => {
    const kepala = employee(1);
    const staf = employee(2, { directManagerEmployeeId: kepala.id });
    const { pool } = createPool([kepala, staf]);

    const response = await withApp(pool, (app) =>
      app.inject(previewRequest(csv([[kepala.employeeNumber, staf.employeeNumber]]))));

    expect(rowFor(response.json(), kepala.employeeNumber).code).toBe("REPORTING_LINE_CYCLE");
  });

  it("menolak atasan yang tidak aktif", async () => {
    const mantan = employee(1, { status: "resigned" });
    const staf = employee(2);
    const { pool } = createPool([mantan, staf]);

    const response = await withApp(pool, (app) =>
      app.inject(previewRequest(csv([[staf.employeeNumber, mantan.employeeNumber]]))));

    expect(rowFor(response.json(), staf.employeeNumber).code).toBe("MANAGER_NOT_ACTIVE");
  });

  it("menolak NIP atasan yang tidak terdaftar", async () => {
    const staf = employee(2);
    const { pool } = createPool([staf]);

    const response = await withApp(pool, (app) =>
      app.inject(previewRequest(csv([[staf.employeeNumber, "YSQ-999"]]))));

    expect(rowFor(response.json(), staf.employeeNumber).code).toBe("MANAGER_NOT_FOUND");
  });

  it("menolak NIP pegawai yang tidak terdaftar", async () => {
    const atasan = employee(1);
    const { pool } = createPool([atasan]);

    const response = await withApp(pool, (app) =>
      app.inject(previewRequest(csv([["YSQ-404", atasan.employeeNumber]]))));

    expect(rowFor(response.json(), "YSQ-404").code).toBe("EMPLOYEE_NOT_FOUND");
  });

  it("menolak NIP pegawai yang muncul dua kali pada satu berkas", async () => {
    const atasan = employee(1);
    const lain = employee(2);
    const staf = employee(3);
    const { pool } = createPool([atasan, lain, staf]);

    const response = await withApp(pool, (app) =>
      app.inject(previewRequest(csv([
        [staf.employeeNumber, atasan.employeeNumber],
        [staf.employeeNumber, lain.employeeNumber],
      ]))));

    const preview = response.json();
    expect(preview.applicable).toBe(false);
    expect(preview.rows.map((row: { code: string | null }) => row.code))
      .toEqual(["DUPLICATE_EMPLOYEE_NUMBER", "DUPLICATE_EMPLOYEE_NUMBER"]);
  });

  it("menolak sel NIP ATASAN yang kosong, dan menerima - sebagai pengosongan", async () => {
    const atasan = employee(1);
    const staf = employee(2, { directManagerEmployeeId: atasan.id });
    const lain = employee(3);
    const { pool } = createPool([atasan, staf, lain]);

    const response = await withApp(pool, (app) =>
      app.inject(previewRequest(csv([
        [lain.employeeNumber, ""],
        [staf.employeeNumber, "-"],
      ]))));

    const preview = response.json();
    expect(rowFor(preview, lain.employeeNumber).code).toBe("MANAGER_NUMBER_REQUIRED");
    expect(rowFor(preview, staf.employeeNumber)).toMatchObject({
      outcome: "change",
      fromManager: { employeeNumber: atasan.employeeNumber },
      toManager: null,
    });
  });

  it("menghitung baris yang akan mengosongkan atasan tersendiri pada ringkasan", async () => {
    // Kecelakaan find/replace: seluruh kolom NIP ATASAN berisi "-". Tanpa hitungan
    // tersendiri, ini hanya tampak sebagai sekian baris "akan berubah".
    const atasan = employee(1);
    const satu = employee(2, { directManagerEmployeeId: atasan.id });
    const dua = employee(3, { directManagerEmployeeId: atasan.id });
    const tiga = employee(4);
    const { pool } = createPool([atasan, satu, dua, tiga]);

    const response = await withApp(pool, (app) =>
      app.inject(previewRequest(csv([
        [satu.employeeNumber, "-"],
        [dua.employeeNumber, "-"],
        [tiga.employeeNumber, atasan.employeeNumber],
      ]))));

    const preview = response.json();
    expect(preview.changeCount).toBe(3);
    expect(preview.clearCount).toBe(2);
  });

  it("tidak menghitung baris tanpa atasan yang memang sudah tanpa atasan sebagai pengosongan", async () => {
    const staf = employee(2);
    const { pool } = createPool([staf]);

    const response = await withApp(pool, (app) =>
      app.inject(previewRequest(csv([[staf.employeeNumber, "-"]]))));

    const preview = response.json();
    expect(preview.unchangedCount).toBe(1);
    expect(preview.clearCount).toBe(0);
  });

  it("menolak baris yang salah satu sisinya di luar pengelolaan HCIS", async () => {
    const atasan = employee(1);
    const pengurus = employee(2, { managementScope: "OUTSIDE_HCIS" });
    const stafBumy = employee(3, { managementScope: "OUTSIDE_HCIS" });
    const staf = employee(4);
    const { pool } = createPool([atasan, pengurus, stafBumy, staf]);

    const response = await withApp(pool, (app) =>
      app.inject(previewRequest(csv([
        [stafBumy.employeeNumber, atasan.employeeNumber],
        [staf.employeeNumber, pengurus.employeeNumber],
      ]))));

    const preview = response.json();
    expect(rowFor(preview, stafBumy.employeeNumber).code).toBe("EMPLOYEE_OUTSIDE_HCIS_READ_ONLY");
    expect(rowFor(preview, staf.employeeNumber).code).toBe("EMPLOYEE_OUTSIDE_HCIS_READ_ONLY");
  });

  it("membaca berkas yang setiap selnya dikutip, seperti unduhan usulan bagan", async () => {
    // Unduhan usulan bagan di layar HC mengutip setiap sel (RFC 4180) supaya
    // aman dibuka di Excel. Berkas itu dibuat untuk diunggah lagi ke sini, jadi
    // jalur unggahnya harus benar-benar membacanya.
    const atasan = employee(1);
    const staf = employee(2);
    const { pool } = createPool([atasan, staf]);

    const response = await withApp(pool, (app) =>
      app.inject(previewRequest(
        ["NIP,NIP ATASAN", `"${staf.employeeNumber}","${atasan.employeeNumber}"`].join("\r\n"),
      )));

    expect(response.statusCode).toBe(200);
    expect(rowFor(response.json(), staf.employeeNumber)).toMatchObject({
      outcome: "change",
      toManager: { employeeNumber: atasan.employeeNumber },
    });
  });

  it("menolak berkas tanpa kolom wajib", async () => {
    const { pool } = createPool([employee(1)]);
    const response = await withApp(pool, (app) =>
      app.inject(previewRequest("NIP,NAMA\r\nYSQ-001,Pegawai 1")));

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_MANAGER_ASSIGNMENT_FILE");
  });

  it("menolak berkas yang hanya berisi header", async () => {
    const { pool } = createPool([employee(1)]);
    const response = await withApp(pool, (app) => app.inject(previewRequest("NIP,NIP ATASAN")));

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("tanpa satu pun baris data");
  });
});

describe("ORG-001 penerapan penetapan atasan langsung massal", () => {
  it("menerapkan seluruh berkas dalam satu transaksi dan mencatat audit per pegawai", async () => {
    const atasan = employee(1);
    const lama = employee(2);
    const satu = employee(3);
    const dua = employee(4, { directManagerEmployeeId: lama.id });
    const { pool, master, audits, statements } = createPool([atasan, lama, satu, dua]);
    const file = csv([
      [satu.employeeNumber, atasan.employeeNumber],
      [dua.employeeNumber, atasan.employeeNumber],
    ]);

    const result = await withApp(pool, async (app) => {
      const preview = (await app.inject(previewRequest(file))).json();
      const applied = await app.inject(applyRequest(file, preview.previewToken));
      expect(applied.statusCode).toBe(200);
      return applied.json();
    });

    expect(result.appliedCount).toBe(2);
    expect(master.get(satu.id)!.directManagerEmployeeId).toBe(atasan.id);
    expect(master.get(dua.id)!.directManagerEmployeeId).toBe(atasan.id);
    expect(statements).toContain("BEGIN");
    expect(statements).toContain("LOCK");
    expect(statements).toContain("COMMIT");
    expect(statements).not.toContain("ROLLBACK");

    const perEmployee = audits.filter((event) => event.action === "employee.manager.updated");
    expect(perEmployee).toHaveLength(2);
    expect(perEmployee.find((event) => event.entityId === dua.id)!.payload).toMatchObject({
      managerEmployeeId: atasan.id,
      previousManagerEmployeeId: lama.id,
      source: "BULK_CSV",
      batchId: result.batchId,
    });

    const batch = audits.filter((event) => event.action === "employee.manager.batch_applied");
    expect(batch).toHaveLength(1);
    expect(batch[0]!.entityId).toBe(result.batchId);
    expect(batch[0]!.payload).toMatchObject({
      appliedCount: 2,
      rowCount: 2,
      sourceFilename: "atasan.csv",
      previewToken: result.previewToken,
    });
  });

  it("satu baris yang ditolak membatalkan seluruh berkas", async () => {
    const atasan = employee(1);
    const sah = employee(2);
    const { pool, master, audits, statements } = createPool([atasan, sah]);
    const file = csv([
      [sah.employeeNumber, atasan.employeeNumber],
      ["YSQ-404", atasan.employeeNumber],
    ]);

    const response = await withApp(pool, async (app) => {
      const preview = (await app.inject(previewRequest(file))).json();
      expect(preview.applicable).toBe(false);
      // Token preview tetap dikirim: yang menolak adalah barisnya, bukan tokennya.
      return app.inject(applyRequest(file, preview.previewToken));
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("MANAGER_ASSIGNMENT_BATCH_INVALID");
    expect(master.get(sah.id)!.directManagerEmployeeId).toBeNull();
    expect(audits).toEqual([]);
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("UPDATE");
  });

  it("menyebut preview basi, bukan baris ditolak, ketika berkasnya ditukar sesudah dry-run", async () => {
    const atasan = employee(1);
    const staf = employee(2);
    const { pool, master, audits } = createPool([atasan, staf]);
    const diperiksa = csv([[staf.employeeNumber, atasan.employeeNumber]]);
    // Berkas kedua memuat baris yang akan ditolak; yang sebenarnya salah adalah
    // berkasnya bukan berkas yang dikonfirmasi HC.
    const dikirim = csv([
      [staf.employeeNumber, atasan.employeeNumber],
      ["YSQ-404", atasan.employeeNumber],
    ]);

    const response = await withApp(pool, async (app) => {
      const preview = (await app.inject(previewRequest(diperiksa))).json();
      return app.inject(applyRequest(dikirim, preview.previewToken));
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("MANAGER_ASSIGNMENT_PREVIEW_STALE");
    expect(master.get(staf.id)!.directManagerEmployeeId).toBeNull();
    expect(audits).toEqual([]);
  });

  it("menolak penerapan ketika data sudah bergeser di bawah preview", async () => {
    const atasan = employee(1);
    const lain = employee(2);
    const staf = employee(3);
    const { pool, master, audits } = createPool([atasan, lain, staf]);
    const file = csv([[staf.employeeNumber, atasan.employeeNumber]]);

    const response = await withApp(pool, async (app) => {
      const preview = (await app.inject(previewRequest(file))).json();
      // Jalur satuan memindahkan atasan orang yang sama sesudah dry-run.
      master.get(staf.id)!.directManagerEmployeeId = lain.id;
      return app.inject(applyRequest(file, preview.previewToken));
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("MANAGER_ASSIGNMENT_PREVIEW_STALE");
    expect(master.get(staf.id)!.directManagerEmployeeId).toBe(lain.id);
    expect(audits).toEqual([]);
  });

  it("berkas yang sama dijalankan dua kali tidak mengubah apa pun pada kali kedua", async () => {
    const atasan = employee(1);
    const staf = employee(2);
    const { pool, master, audits } = createPool([atasan, staf]);
    const file = csv([[staf.employeeNumber, atasan.employeeNumber]]);

    const second = await withApp(pool, async (app) => {
      const first = (await app.inject(previewRequest(file))).json();
      expect((await app.inject(applyRequest(file, first.previewToken))).json().appliedCount).toBe(1);

      // Dry-run kedua wajib dijalankan lagi: keadaan data sudah berubah, jadi
      // token yang lama memang tidak akan cocok lagi.
      const preview = (await app.inject(previewRequest(file))).json();
      expect(preview.unchangedCount).toBe(1);
      expect(preview.changeCount).toBe(0);
      return app.inject(applyRequest(file, preview.previewToken));
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().appliedCount).toBe(0);
    expect(master.get(staf.id)!.directManagerEmployeeId).toBe(atasan.id);
    expect(audits.filter((event) => event.action === "employee.manager.updated")).toHaveLength(1);
  });

  it("menolak penerapan tanpa token dry-run", async () => {
    const atasan = employee(1);
    const staf = employee(2);
    const { pool, master } = createPool([atasan, staf]);

    const response = await withApp(pool, (app) =>
      app.inject({
        method: "POST",
        url: "/admin/employees/manager-assignments/apply",
        headers: { cookie: "hcis_session=test-token", "content-type": "text/csv", "x-file-name": "atasan.csv" },
        payload: csv([[staf.employeeNumber, atasan.employeeNumber]]),
      }));

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("MANAGER_ASSIGNMENT_PREVIEW_REQUIRED");
    expect(master.get(staf.id)!.directManagerEmployeeId).toBeNull();
  });

  it("menolak account tanpa approvals.policy.manage", async () => {
    const atasan = employee(1);
    const staf = employee(2);
    const { pool } = createPool([atasan, staf], ["employees.manage"]);

    const response = await withApp(pool, (app) =>
      app.inject(previewRequest(csv([[staf.employeeNumber, atasan.employeeNumber]]))));

    expect(response.statusCode).toBe(403);
  });
});
