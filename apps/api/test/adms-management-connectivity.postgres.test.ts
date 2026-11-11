import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  countActiveDeviceConnectivity,
  humanAction,
} from "../src/modules/attendance/adms/management-routes.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

describe("ATT-012 operator action wording", () => {
  it("names physical device actions in operator language instead of a generic label", () => {
    expect(humanAction("device_option", "admin_physical_operation", "time_sync")).toBe("Sinkronkan waktu");
    expect(humanAction("device_option", "admin_physical_operation", "duplicate_punch_period")).toBe("Jeda absensi ganda");
    expect(humanAction("physical_work_code", "admin_physical_operation", "work_code_delivery")).toBe("Kode kegiatan di mesin");
    expect(humanAction("physical_user", "admin_physical_operation", "user_profile_upsert")).toBe("Kirim / perbarui pegawai");
    expect(humanAction("device_reboot", "admin_physical_operation", "reboot")).toBe("Mulai ulang mesin");
    expect(humanAction("device_clear", "admin_physical_operation", "clear_all_data")).toBe("Hapus seluruh data mesin");
  });

  it("keeps the existing wording for non-physical commands", () => {
    expect(humanAction("data_query", "admin_range_recovery")).toBe("Ambil ulang transaksi");
    expect(humanAction("sync_new", "admin_sync_new", null)).toBe("Sinkronkan data baru");
    expect(humanAction("read_info", "admin_read_information")).toBe("Perbarui informasi mesin");
    expect(humanAction("device_option", "admin_physical_operation", "unknown_capability")).toBe("Operasi perangkat");
  });
});

// Synthetic devices inside one transaction that is always rolled back.
describe.skipIf(!allowed)("ATT-012 dashboard connectivity counters (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    // Isolate from any other rows in the scratch database for the duration of the transaction.
    await client.query("UPDATE attendance_adms_devices SET lifecycle = 'disabled' WHERE lifecycle = 'active'");
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  async function device(input: {
    lifecycle?: string;
    lastSeenSecondsAgo: number | null;
    timeoutSeconds?: number | null;
    heartbeatSeconds?: number;
  }) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO attendance_adms_devices (
         id, serial_number, lifecycle, timezone, last_seen_at,
         connectivity_timeout_seconds, heartbeat_interval_seconds
       ) VALUES (
         $1, $2, $3, 'Asia/Jakarta',
         CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(secs => $4::int) END,
         $5, $6
       )`,
      [
        id,
        `CONN-${id}`,
        input.lifecycle ?? "active",
        input.lastSeenSecondsAgo,
        input.timeoutSeconds ?? null,
        input.heartbeatSeconds ?? 30,
      ],
    );
  }

  it("counts active machines as online, offline or unknown with the health timeout rule", async () => {
    // Default timeout = clamp(heartbeat * 3, 60, 900) = 90 s for a 30 s heartbeat.
    await device({ lastSeenSecondsAgo: 20 });
    await device({ lastSeenSecondsAgo: 300 });
    // Explicit timeout wins over the heartbeat default.
    await device({ lastSeenSecondsAgo: 300, timeoutSeconds: 600 });
    // A long heartbeat is clamped to 900 s.
    await device({ lastSeenSecondsAgo: 1_000, heartbeatSeconds: 600 });
    await device({ lastSeenSecondsAgo: null });
    // Non-active machines never count.
    await device({ lifecycle: "disabled", lastSeenSecondsAgo: 5_000 });
    await device({ lifecycle: "quarantined", lastSeenSecondsAgo: null });

    await expect(countActiveDeviceConnectivity(client)).resolves.toEqual({ online: 2, offline: 2, unknown: 1 });
  });
});
