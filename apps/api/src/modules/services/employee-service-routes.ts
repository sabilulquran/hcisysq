/**
 * SVC-001 (2026-11-24): keadaan tiap layanan pegawai, sebagaimana server benar-benar
 * memberlakukannya.
 *
 * Mengapa route ini ada. Katalog "Semua Layanan" di Portal Pegawai menuliskan sendiri label tiap
 * layanan, dan seluruhnya tertulis `available`. Audit kesiapan 2026-11-24 menemukan akibatnya pada
 * Uang Muka Dinas: katalog menuliskannya "Tersedia" sementara server menjawab
 * `409 TRIP_PER_DIEM_NOT_ACTIVE` untuk setiap perkiraan dan setiap pengajuan, karena HC belum
 * menyalakannya. Pegawai membaca "Tersedia", membuka layarnya, mengisi formulirnya, dan baru di
 * ujung diberi tahu bahwa layanan itu memang belum dibuka.
 *
 * Label tidak boleh ditebak di frontend: itu aturan bisnis (AGENTS.md §4), dan aturan yang sama
 * sudah ada di server — pada saklar basis data, pada konfigurasi integrasi. Route ini membacakan
 * aturan itu apa adanya, satu baris per layanan, beserta kalimat untuk pegawai dan syarat
 * membukanya untuk HC. Layanan yang tidak punya gerbang server tidak disebut di sini dan terbaca
 * terbuka.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { ApiConfig } from "../../config/env.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import { createPersonCustodyReader } from "../employee-assets/routes.js";
import { createScoreboardReader } from "../rewards/routes.js";
import { perDiemActivation } from "../trip-advances/activation.js";

/**
 * `LOCKED` — tindakan utama layanan ini ditolak server hari ini.
 * `LIMITED` — layanannya terbuka, tetapi satu bagiannya mati.
 * Layanan yang tidak disebut route ini terbuka tanpa syarat.
 */
export type EmployeeServiceState = "LOCKED" | "LIMITED";

export interface EmployeeServiceStatus {
  /** Kunci katalog di `apps/web/src/lib/employeeServices.ts`. */
  key: string;
  state: EmployeeServiceState;
  /** Kode yang sama dengan yang dijawab rutenya bila tetap dicoba. */
  code: string;
  /** Untuk pegawai: apa yang belum dapat dilakukan, tanpa menyalahkan dirinya. */
  message: string;
  /** Untuk HC: apa yang membuka layanan ini. */
  requirement: string;
}

export async function employeeServiceStatuses(
  db: Pool,
  config: ApiConfig,
): Promise<EmployeeServiceStatus[]> {
  const statuses: EmployeeServiceStatus[] = [];

  // TRIP-002 D-22: saklarnya di basis data, bukan di env, dan mati sampai HC menyalakannya.
  const perDiem = await perDiemActivation(db);
  if (perDiem.state !== "ACTIVE") {
    statuses.push({
      key: "trip-advances",
      state: "LOCKED",
      code: "TRIP_PER_DIEM_NOT_ACTIVE",
      message: "Uang muka dan uang harian perjalanan dinas belum dibuka, jadi pengajuan belum "
        + "dapat dikirim. Perjalanan dinasnya sendiri tetap dapat diajukan.",
      requirement: "Human Capital melengkapi katalog klasifikasi jabatan, pemetaan golongan, dan "
        + "tarifnya, lalu menyalakan uang saku dinas (TRIP-002).",
    });
  }

  // ASSET-001: tanpa sambungan ke Aset SQ, layar aset tidak punya sumber data sama sekali.
  if (createPersonCustodyReader(config) === null) {
    statuses.push({
      key: "assets",
      state: "LOCKED",
      code: "ASSET_SOURCE_NOT_CONFIGURED",
      message: "Daftar aset tanggungan Anda belum tersambung, jadi isinya belum dapat ditampilkan.",
      requirement: "Operator menyambungkan HCIS ke Aset SQ (ASSET-001).",
    });
  }

  // TRAIN-001 R4: jadwal, riwayat, dan sertifikat tetap jalan; yang mati modul daringnya saja.
  if (config.TRAINING_ONLINE_ENABLED !== "1") {
    statuses.push({
      key: "training",
      state: "LIMITED",
      code: "TRAINING_ONLINE_DISABLED",
      message: "Modul pelatihan daring belum dibuka. Jadwal, riwayat, dan sertifikat tetap dapat "
        + "dibuka seperti biasa.",
      requirement: "Operator menyiapkan penyimpanan media lalu menyalakan modul daring (TRAIN-001 R4).",
    });
  }

  // REWARD-001: tanpa sumbernya, papan skor bulanan kosong sampai HC mengimpor hasilnya.
  if (createScoreboardReader(config) === null) {
    statuses.push({
      key: "rewards",
      state: "LIMITED",
      code: "REWARD_SCOREBOARD_NOT_CONFIGURED",
      message: "Papan skor tilawah bulanan belum tersambung. Penghargaan yang sudah terbit tetap "
        + "dapat dibuka.",
      requirement: "Operator menyambungkan HCIS ke aplikasi Al-Qur'an, atau Human Capital "
        + "mengimpor hasil bulanannya (REWARD-001).",
    });
  }

  return statuses;
}

async function authenticate(
  auth: Pick<AuthService, "getSession">,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthPrincipal | null> {
  const token = readCookie(request.headers.cookie, AUTH_COOKIE_NAME);
  const session = await auth.getSession(token);
  if (!session) {
    reply.header("Cache-Control", "no-store");
    await reply.status(401).send({
      code: "UNAUTHENTICATED",
      message: "Sesi tidak ditemukan atau sudah berakhir.",
    });
    return null;
  }
  return session.principal;
}

export async function registerEmployeeServiceRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession">,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for employee service routes");
  }
  const auth = injectedAuth ?? new AuthService(
    pool, config.AUTH_ENCRYPTION_KEY, config.AUTH_SESSION_TTL_HOURS, config.NODE_ENV === "production",
  );

  app.get("/me/services", async (request, reply) => {
    const principal = await authenticate(auth, request, reply);
    if (!principal) return;
    reply.header("Cache-Control", "no-store");
    return reply.send({ services: await employeeServiceStatuses(pool, config) });
  });
}
