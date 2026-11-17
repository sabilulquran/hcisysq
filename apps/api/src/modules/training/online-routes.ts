// TRAIN-001 R4 routes: online modules, materials, video upload through the ObjectStorage port,
// range streaming for enrolled participants, server-credited watch sessions, module quizzes and
// completion into the training record. Spec: docs/domain/training-online-modules.md.
//
// Behind TRAINING_ONLINE_ENABLED (default off, M-05): while off every route answers 404
// TRAINING_ONLINE_DISABLED. No new permission (M-17). Video bytes never pass through the database.

import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import type { FastifyInstance, FastifyReply } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";

import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import { ObjectNotFoundError, ObjectTooLargeError, readRange, type ObjectStorage } from "../../lib/object-storage.js";
import { jakartaDate } from "../documents/service.js";
import { notifyEmployee } from "../notifications/service.js";
import { publicItems, scoreTest, validateAnswers, type Item } from "./evaluation-domain.js";
import {
  creditHeartbeat,
  DEFAULT_QUIZ_MAX_ATTEMPTS,
  DEFAULT_QUIZ_PASSING_SCORE,
  inspectMp4,
  MATERIAL_KINDS,
  MAX_MATERIALS_PER_MODULE,
  MAX_MODULES_PER_PROGRAM,
  MAX_TEXT_LENGTH,
  moduleComplete,
  parseRange,
  PLAYBACK_IDLE_MS,
  quizStanding,
  validCreditHours,
  VideoInspectionError,
  videoCompleted,
} from "./online-domain.js";
import { audit, loadSelf, send, TrainingError, type Queryable, type TrainingRouteKit } from "./shared.js";

export interface OnlineModuleOptions {
  enabled: boolean;
  storage: ObjectStorage | null;
  videoMaxBytes: number;
  mediaQuotaBytes: number;
}

const idParams = z.object({ id: z.string().uuid() });
const progressParams = z.object({ id: z.string().uuid(), employeeId: z.string().uuid() });
const moduleBody = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  creditHours: z.number(),
});
const modulePatch = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  creditHours: z.number().optional(),
  quizInstrumentId: z.string().uuid().nullable().optional(),
  quizPassingScore: z.number().int().min(0).max(100).optional(),
  quizMaxAttempts: z.number().int().min(1).max(10).optional(),
});
const materialBody = z.object({
  kind: z.enum(MATERIAL_KINDS),
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(MAX_TEXT_LENGTH).optional(),
}).refine((value) => (value.kind === "TEXT") === (value.body !== undefined), { message: "body" });
const reasonBody = z.object({ reason: z.string().trim().min(5).max(500) });
const heartbeatBody = z.object({ position: z.number().min(0).max(100_000) });
const streamQuery = z.object({ playback: z.string().uuid() });
const quizBody = z.object({ answers: z.record(z.unknown()) });

const disabled = () => new TrainingError(404, "TRAINING_ONLINE_DISABLED", "Modul daring belum diaktifkan.");
const moduleNotFound = () => new TrainingError(404, "TRAINING_MODULE_NOT_FOUND", "Modul tidak ditemukan.");
const materialNotFound = () => new TrainingError(404, "TRAINING_MATERIAL_NOT_FOUND", "Materi tidak ditemukan.");

interface ModuleRow {
  id: string;
  programId: string;
  programTitle: string;
  programStatus: string;
  delivery: string;
  title: string;
  status: string;
  creditHours: number;
  quizItems: Item[] | null;
  quizPassingScore: number;
  quizMaxAttempts: number;
}

const MODULE_SELECT = `
  module.id, module.program_id AS "programId", program.title AS "programTitle", program.status AS "programStatus",
  program.delivery, module.title, module.status, module.credit_hours::float8 AS "creditHours", module.quiz_items AS "quizItems",
  module.quiz_passing_score AS "quizPassingScore", module.quiz_max_attempts AS "quizMaxAttempts"`;

async function loadModule(db: Queryable, id: string, lock = false): Promise<ModuleRow> {
  const result = await db.query<ModuleRow>(
    `SELECT ${MODULE_SELECT} FROM training_modules module JOIN training_programs program ON program.id = module.program_id
      WHERE module.id = $1 ${lock ? "FOR UPDATE OF module" : ""}`,
    [id],
  );
  if (!result.rows[0]) throw moduleNotFound();
  return result.rows[0];
}

interface MaterialRow {
  id: string;
  moduleId: string;
  kind: "VIDEO" | "TEXT";
  title: string;
  objectKey: string | null;
  byteSize: number | null;
  durationSeconds: number | null;
  status: string;
}

const MATERIAL_SELECT = `material.id, material.module_id AS "moduleId", material.kind, material.title,
  material.object_key AS "objectKey", material.byte_size::float8 AS "byteSize",
  material.duration_seconds::float8 AS "durationSeconds", material.status`;

async function loadMaterial(db: Queryable, id: string, lock = false): Promise<MaterialRow> {
  const result = await db.query<MaterialRow>(
    `SELECT ${MATERIAL_SELECT} FROM training_materials material WHERE material.id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [id],
  );
  if (!result.rows[0] || result.rows[0].status !== "ACTIVE") throw materialNotFound();
  return result.rows[0];
}

function assertDraft(module: ModuleRow) {
  if (module.status !== "DRAFT") throw new TrainingError(409, "TRAINING_MODULE_LOCKED", "Modul yang sudah terbit tidak dapat diubah.");
  if (module.programStatus !== "ACTIVE") throw new TrainingError(409, "TRAINING_PROGRAM_CLOSED", "Program sudah ditutup atau dibatalkan.");
}

/** M-08: the participant may use this material (published module, active online program, enrolled). */
async function participantMaterial(db: Queryable, materialId: string, employeeId: string) {
  const result = await db.query<MaterialRow & { programId: string; programTitle: string; moduleTitle: string }>(
    `SELECT ${MATERIAL_SELECT}, module.program_id AS "programId", program.title AS "programTitle", module.title AS "moduleTitle"
       FROM training_materials material
       JOIN training_modules module ON module.id = material.module_id AND module.status = 'PUBLISHED'
       JOIN training_programs program ON program.id = module.program_id AND program.status = 'ACTIVE' AND program.delivery = 'ONLINE'
       JOIN training_participants participant
         ON participant.program_id = program.id AND participant.employee_id = $2 AND participant.status IN ('ENROLLED', 'COMPLETED')
      WHERE material.id = $1 AND material.status = 'ACTIVE'`,
    [materialId, employeeId],
  );
  if (!result.rows[0]) throw materialNotFound();
  return result.rows[0];
}

async function markMaterialComplete(
  client: PoolClient,
  input: { materialId: string; employeeId: string; via: "WATCHED" | "READ" | "HC_MANUAL"; reason?: string; actorAccountId: string; programId: string },
) {
  const updated = await client.query(
    `INSERT INTO training_material_progress
       (material_id, employee_id, completed_at, completed_via, manual_reason, completed_by_account_id, updated_at)
     VALUES ($1, $2, now(), $3, $4, $5, now())
     ON CONFLICT (material_id, employee_id) DO UPDATE
       SET completed_at = now(), completed_via = EXCLUDED.completed_via, manual_reason = EXCLUDED.manual_reason,
           completed_by_account_id = EXCLUDED.completed_by_account_id, updated_at = now()
       WHERE training_material_progress.completed_at IS NULL`,
    [input.materialId, input.employeeId, input.via, input.reason ?? null, input.actorAccountId],
  );
  if (!updated.rowCount) return false;
  await audit(client, {
    eventType: "training.material.completed", programId: input.programId, employeeId: input.employeeId,
    actorAccountId: input.actorAccountId, note: input.reason ?? null, metadata: { materialId: input.materialId, via: input.via },
  });
  return true;
}

/**
 * M-14: when every published module of the program is complete for the participant, creates the
 * verified internal record (hours = Σ credit hours) and marks the participant COMPLETED, once.
 */
export async function completeOnlineProgramIfDone(
  client: PoolClient,
  input: { programId: string; employeeId: string; actorAccountId: string },
): Promise<boolean> {
  const participant = await client.query<{ status: string; enrolledOn: string }>(
    `SELECT status, to_char(enrolled_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS "enrolledOn"
       FROM training_participants WHERE program_id = $1 AND employee_id = $2 FOR UPDATE`,
    [input.programId, input.employeeId],
  );
  if (participant.rows[0]?.status !== "ENROLLED") return false;
  const modules = await client.query<{ id: string; creditHours: number; materials: number; completed: number; hasQuiz: boolean; quizPassed: boolean }>(
    `SELECT module.id, module.credit_hours::float8 AS "creditHours",
            (SELECT count(*)::int FROM training_materials material WHERE material.module_id = module.id AND material.status = 'ACTIVE') AS materials,
            (SELECT count(*)::int FROM training_materials material
               JOIN training_material_progress progress ON progress.material_id = material.id AND progress.employee_id = $2
              WHERE material.module_id = module.id AND material.status = 'ACTIVE' AND progress.completed_at IS NOT NULL) AS completed,
            module.quiz_items IS NOT NULL AS "hasQuiz",
            EXISTS (SELECT 1 FROM training_quiz_attempts attempt
                     WHERE attempt.module_id = module.id AND attempt.employee_id = $2 AND attempt.passed) AS "quizPassed"
       FROM training_modules module WHERE module.program_id = $1 AND module.status = 'PUBLISHED'`,
    [input.programId, input.employeeId],
  );
  if (modules.rows.length === 0 || !modules.rows.every((row) => moduleComplete({
    materials: row.materials, completedMaterials: row.completed, hasQuiz: row.hasQuiz, quizPassed: row.quizPassed,
  }))) return false;
  const program = (await client.query<{ title: string; category: string; organizer: string }>(
    `SELECT title, category, organizer FROM training_programs WHERE id = $1`, [input.programId],
  )).rows[0]!;
  const hours = Math.round(modules.rows.reduce((sum, row) => sum + row.creditHours, 0) * 100) / 100;
  const recordId = randomUUID();
  const today = jakartaDate(new Date());
  const startOn = participant.rows[0].enrolledOn <= today ? participant.rows[0].enrolledOn : today;
  await client.query(
    `INSERT INTO training_records
       (id, employee_id, source, role, program_id, title, category, organizer, start_on, end_on, hours, completed, status, decided_at)
     VALUES ($1, $2, 'INTERNAL', 'PARTICIPANT', $3, $4, $5, $6, $7::date, $8::date, $9, true, 'VERIFIED', now())`,
    [recordId, input.employeeId, input.programId, program.title, program.category, program.organizer, startOn, today, hours],
  );
  await client.query(
    `UPDATE training_participants SET status = 'COMPLETED', attended_hours = $3, updated_at = now() WHERE program_id = $1 AND employee_id = $2`,
    [input.programId, input.employeeId, hours],
  );
  await audit(client, {
    eventType: "training.record.created", programId: input.programId, recordId, employeeId: input.employeeId,
    actorAccountId: input.actorAccountId, metadata: { role: "PARTICIPANT", hours, completed: true, delivery: "ONLINE" },
  });
  await notifyEmployee(client, input.employeeId, {
    eventKey: `training.program.${input.programId}.online-completed.${input.employeeId}`, category: "system",
    title: "Catatan pelatihan tersimpan", body: `Anda menyelesaikan ${program.title}; ${hours} jam tercatat di riwayat pelatihan.`,
    href: "/app/training", actorAccountId: input.actorAccountId,
  });
  return true;
}

export function registerTrainingOnlineRoutes(app: FastifyInstance, kit: TrainingRouteKit, options: OnlineModuleOptions) {
  const { pool, requireEmployee, requirePermission, handle, transact, invalid } = kit;
  const storage = options.enabled ? options.storage : null;

  if (!app.hasContentTypeParser("video/mp4")) {
    // The upload is streamed to ObjectStorage; Fastify never buffers it.
    app.addContentTypeParser("video/mp4", (_request, payload, done) => done(null, payload));
  }

  function requireEnabled(): ObjectStorage {
    if (!storage) throw disabled();
    return storage;
  }

  async function usedBytes(db: Queryable) {
    const result = await db.query<{ used: number }>(
      `SELECT COALESCE(sum(byte_size), 0)::float8 AS used FROM training_materials WHERE object_key IS NOT NULL AND status = 'ACTIVE'`,
    );
    return result.rows[0]?.used ?? 0;
  }

  async function streamObject(reply: FastifyReply, objects: ObjectStorage, key: string, rangeHeader: string | undefined) {
    const info = await objects.stat(key);
    if (!info) throw materialNotFound();
    const range = parseRange(rangeHeader, info.byteSize);
    reply.header("Cache-Control", "private, no-store");
    reply.header("Accept-Ranges", "bytes");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Disposition", "inline");
    if (range.kind !== "ok") {
      // M-09: no Range, no bytes; a player always asks for a range.
      reply.header("Content-Range", `bytes */${info.byteSize}`);
      return reply.status(416).send({ code: "TRAINING_RANGE_REQUIRED", message: "Video hanya diputar lewat pemutar." });
    }
    const stream: Readable = await objects.read(key, { start: range.start, end: range.end });
    reply.header("Content-Type", "video/mp4");
    reply.header("Content-Range", `bytes ${range.start}-${range.end}/${info.byteSize}`);
    reply.header("Content-Length", String(range.end - range.start + 1));
    return reply.status(206).send(stream);
  }

  // ---------------------------------------------------------------- HC

  app.get("/admin/training/online/storage", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    return handle(reply, async () => send(reply, 200, {
      enabled: storage !== null,
      videoMaxBytes: options.videoMaxBytes,
      quotaBytes: options.mediaQuotaBytes,
      usedBytes: await usedBytes(pool),
    }));
  });

  app.get("/admin/training/programs/:id/modules", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_PROGRAM_ID", "Program pelatihan tidak valid.");
    return handle(reply, async () => {
      requireEnabled();
      // M-02 bounds a program to 20 modules of 20 materials (ENG-LIST-001 bounded).
      const modules = await pool.query(
        `SELECT module.id, module.position, module.title, module.description, module.credit_hours::float8 AS "creditHours",
                module.quiz_instrument_id AS "quizInstrumentId", jsonb_array_length(COALESCE(module.quiz_items, '[]'::jsonb))::int AS "quizItemCount",
                module.quiz_passing_score AS "quizPassingScore", module.quiz_max_attempts AS "quizMaxAttempts", module.status,
                module.archive_reason AS "archiveReason", module.published_at AS "publishedAt",
                COALESCE((SELECT jsonb_agg(jsonb_build_object(
                    'id', material.id, 'position', material.position, 'kind', material.kind, 'title', material.title,
                    'hasVideo', material.object_key IS NOT NULL, 'byteSize', material.byte_size,
                    'durationSeconds', material.duration_seconds, 'bodyLength', char_length(material.body))
                  ORDER BY material.position, material.id)
                  FROM training_materials material WHERE material.module_id = module.id AND material.status = 'ACTIVE'), '[]'::jsonb) AS materials
           FROM training_modules module WHERE module.program_id = $1
          ORDER BY module.position ASC, module.id ASC LIMIT 100`,
        [params.data.id],
      );
      return send(reply, 200, { items: modules.rows });
    });
  });

  app.post("/admin/training/programs/:id/modules", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = moduleBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_TRAINING_MODULE", "Judul atau jam kredit modul tidak valid.");
    return transact(reply, async (client) => {
      requireEnabled();
      if (!validCreditHours(body.data.creditHours)) throw new TrainingError(400, "INVALID_TRAINING_MODULE", "Jam kredit 0,25 sampai 40, kelipatan 0,25.");
      const program = (await client.query<{ status: string; delivery: string }>(
        `SELECT status, delivery FROM training_programs WHERE id = $1 FOR UPDATE`, [params.data.id],
      )).rows[0];
      if (!program) throw new TrainingError(404, "TRAINING_PROGRAM_NOT_FOUND", "Program pelatihan tidak ditemukan.");
      if (program.delivery !== "ONLINE") throw new TrainingError(409, "TRAINING_PROGRAM_NOT_ONLINE", "Modul hanya untuk program daring.");
      if (program.status !== "ACTIVE") throw new TrainingError(409, "TRAINING_PROGRAM_CLOSED", "Program sudah ditutup atau dibatalkan.");
      const count = (await client.query<{ count: number; last: number }>(
        `SELECT count(*) FILTER (WHERE status <> 'ARCHIVED')::int AS count, COALESCE(max(position), 0)::int AS last
           FROM training_modules WHERE program_id = $1`, [params.data.id],
      )).rows[0]!;
      if (count.count >= MAX_MODULES_PER_PROGRAM) throw new TrainingError(409, "TRAINING_MODULE_LIMIT", `Paling banyak ${MAX_MODULES_PER_PROGRAM} modul per program.`);
      const id = randomUUID();
      await client.query(
        `INSERT INTO training_modules (id, program_id, position, title, description, credit_hours, quiz_passing_score, quiz_max_attempts, created_by_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, params.data.id, count.last + 1, body.data.title, body.data.description || null, body.data.creditHours,
          DEFAULT_QUIZ_PASSING_SCORE, DEFAULT_QUIZ_MAX_ATTEMPTS, principal.id],
      );
      await audit(client, { eventType: "training.module.created", programId: params.data.id, actorAccountId: principal.id, metadata: { moduleId: id } });
      return [201, { id, status: "DRAFT" }];
    });
  });

  app.patch("/admin/training/modules/:id", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = modulePatch.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_TRAINING_MODULE", "Perubahan modul tidak valid.");
    return transact(reply, async (client) => {
      requireEnabled();
      const module = await loadModule(client, params.data.id, true);
      assertDraft(module);
      if (body.data.creditHours !== undefined && !validCreditHours(body.data.creditHours)) {
        throw new TrainingError(400, "INVALID_TRAINING_MODULE", "Jam kredit 0,25 sampai 40, kelipatan 0,25.");
      }
      let quiz: { instrumentId: string | null; items: Item[] | null } | null = null;
      if (body.data.quizInstrumentId !== undefined) {
        if (body.data.quizInstrumentId === null) quiz = { instrumentId: null, items: null };
        else {
          const instrument = (await client.query<{ kind: string; status: string; items: Item[] }>(
            `SELECT kind, status, items FROM training_instruments WHERE id = $1`, [body.data.quizInstrumentId],
          )).rows[0];
          if (!instrument || instrument.kind !== "TEST" || instrument.status !== "ACTIVE") {
            throw new TrainingError(409, "TRAINING_INSTRUMENT_MISMATCH", "Kuis memakai instrumen tes yang aktif.");
          }
          // M-13: a copy of the items, like an R3 component (snapshot-on-attach).
          quiz = { instrumentId: body.data.quizInstrumentId, items: instrument.items };
        }
      }
      await client.query(
        `UPDATE training_modules
            SET title = COALESCE($2, title), description = CASE WHEN $3::boolean THEN $4 ELSE description END,
                credit_hours = COALESCE($5, credit_hours),
                quiz_instrument_id = CASE WHEN $6::boolean THEN $7::uuid ELSE quiz_instrument_id END,
                quiz_items = CASE WHEN $6::boolean THEN $8::jsonb ELSE quiz_items END,
                quiz_passing_score = COALESCE($9, quiz_passing_score), quiz_max_attempts = COALESCE($10, quiz_max_attempts),
                updated_at = now()
          WHERE id = $1`,
        [module.id, body.data.title ?? null, body.data.description !== undefined, body.data.description || null,
          body.data.creditHours ?? null, quiz !== null, quiz?.instrumentId ?? null, quiz?.items ? JSON.stringify(quiz.items) : null,
          body.data.quizPassingScore ?? null, body.data.quizMaxAttempts ?? null],
      );
      await audit(client, {
        eventType: "training.module.updated", programId: module.programId, actorAccountId: principal.id,
        metadata: { moduleId: module.id, fields: Object.keys(body.data) },
      });
      return [200, { id: module.id }];
    });
  });

  app.post("/admin/training/modules/:id/publish", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_MODULE_ID", "Modul tidak valid.");
    return transact(reply, async (client) => {
      requireEnabled();
      const module = await loadModule(client, params.data.id, true);
      assertDraft(module);
      const materials = await client.query<{ kind: string; objectKey: string | null }>(
        `SELECT kind, object_key AS "objectKey" FROM training_materials WHERE module_id = $1 AND status = 'ACTIVE'`, [module.id],
      );
      if (materials.rows.length === 0) throw new TrainingError(409, "TRAINING_MODULE_EMPTY", "Modul belum punya materi.");
      if (materials.rows.some((row) => row.kind === "VIDEO" && !row.objectKey)) {
        throw new TrainingError(409, "TRAINING_VIDEO_MISSING", "Masih ada materi video yang belum diunggah.");
      }
      await client.query(`UPDATE training_modules SET status = 'PUBLISHED', published_at = now(), updated_at = now() WHERE id = $1`, [module.id]);
      await audit(client, { eventType: "training.module.published", programId: module.programId, actorAccountId: principal.id, metadata: { moduleId: module.id } });
      const participants = (await client.query<{ employeeId: string }>(
        `SELECT employee_id AS "employeeId" FROM training_participants WHERE program_id = $1 AND status = 'ENROLLED'`, [module.programId],
      )).rows;
      for (const row of participants) {
        await notifyEmployee(client, row.employeeId, {
          eventKey: `training.module.${module.id}.published.${row.employeeId}`, category: "system", title: "Modul daring baru",
          body: `${module.title} pada ${module.programTitle} siap dipelajari.`, href: `/app/training?program=${module.programId}`,
          actorAccountId: principal.id,
        });
      }
      return [200, { id: module.id, status: "PUBLISHED" }];
    });
  });

  app.post("/admin/training/modules/:id/archive", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = reasonBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_TRAINING_REASON", "Alasan 5 sampai 500 huruf.");
    let archivedKeys: string[] = [];
    const result = await transact(reply, async (client) => {
      requireEnabled();
      const module = await loadModule(client, params.data.id, true);
      if (module.status !== "DRAFT") throw new TrainingError(409, "TRAINING_MODULE_LOCKED", "Hanya modul draf yang dapat diarsipkan.");
      await client.query(`UPDATE training_modules SET status = 'ARCHIVED', archive_reason = $2, updated_at = now() WHERE id = $1`, [module.id, body.data.reason]);
      // M-19: an archived draft never plays, so its videos leave storage and the quota.
      const removed = await client.query<{ objectKey: string | null }>(
        `UPDATE training_materials SET status = 'REMOVED', updated_at = now()
          WHERE module_id = $1 AND status = 'ACTIVE' RETURNING object_key AS "objectKey"`,
        [module.id],
      );
      archivedKeys = removed.rows.map((row) => row.objectKey).filter((key): key is string => key !== null);
      await audit(client, { eventType: "training.module.archived", programId: module.programId, actorAccountId: principal.id, note: body.data.reason, metadata: { moduleId: module.id, removedMaterials: removed.rowCount ?? 0 } });
      return [200, { id: module.id, status: "ARCHIVED" }];
    });
    if (storage) for (const key of archivedKeys) await storage.delete(key).catch(() => undefined);
    return result;
  });

  app.post("/admin/training/modules/:id/materials", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = materialBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_TRAINING_MATERIAL", "Jenis, judul, atau isi materi tidak valid.");
    return transact(reply, async (client) => {
      requireEnabled();
      const module = await loadModule(client, params.data.id, true);
      assertDraft(module);
      const count = (await client.query<{ count: number; last: number }>(
        `SELECT count(*) FILTER (WHERE status = 'ACTIVE')::int AS count, COALESCE(max(position), 0)::int AS last
           FROM training_materials WHERE module_id = $1`, [module.id],
      )).rows[0]!;
      if (count.count >= MAX_MATERIALS_PER_MODULE) throw new TrainingError(409, "TRAINING_MATERIAL_LIMIT", `Paling banyak ${MAX_MATERIALS_PER_MODULE} materi per modul.`);
      const id = randomUUID();
      await client.query(
        `INSERT INTO training_materials (id, module_id, position, kind, title, body) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, module.id, count.last + 1, body.data.kind, body.data.title, body.data.body ?? null],
      );
      await audit(client, { eventType: "training.material.created", programId: module.programId, actorAccountId: principal.id, metadata: { moduleId: module.id, materialId: id, kind: body.data.kind } });
      return [201, { id }];
    });
  });

  app.post("/admin/training/materials/:id/remove", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_MATERIAL_ID", "Materi tidak valid.");
    let removedKey: string | null = null;
    const result = await transact(reply, async (client) => {
      requireEnabled();
      const material = await loadMaterial(client, params.data.id, true);
      const module = await loadModule(client, material.moduleId, true);
      // M-19: a draft module's material, or any material of a closed or cancelled program (frees storage).
      if (module.programStatus === "ACTIVE") assertDraft(module);
      await client.query(`UPDATE training_materials SET status = 'REMOVED', updated_at = now() WHERE id = $1`, [material.id]);
      await audit(client, { eventType: "training.material.removed", programId: module.programId, actorAccountId: principal.id, metadata: { materialId: material.id } });
      removedKey = material.objectKey;
      return [200, { id: material.id, status: "REMOVED" }];
    });
    // The object goes only after the row change committed; a failed delete leaves an orphan, never a dangling row.
    if (removedKey && storage) await storage.delete(removedKey).catch(() => undefined);
    return result;
  });

  app.put("/admin/training/materials/:id/video", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_MATERIAL_ID", "Materi tidak valid.");
    return handle(reply, async () => {
      const objects = requireEnabled();
      if (request.headers["content-type"]?.split(";")[0]?.trim() !== "video/mp4") {
        throw new TrainingError(415, "TRAINING_VIDEO_INVALID", "Unggah berkas MP4 (video/mp4).");
      }
      // Precheck outside the transaction: the upload may take minutes and must not hold row locks.
      const material = await loadMaterial(pool, params.data.id);
      if (material.kind !== "VIDEO") throw new TrainingError(409, "TRAINING_MATERIAL_NOT_VIDEO", "Materi ini bukan video.");
      assertDraft(await loadModule(pool, material.moduleId));
      // A declared length lets an oversized upload be refused before any byte is read; cutting a
      // stream midway would reset the connection and the browser would never see the reason.
      const declared = Number(request.headers["content-length"]);
      if (!Number.isSafeInteger(declared) || declared <= 0) {
        throw new TrainingError(411, "TRAINING_VIDEO_LENGTH_REQUIRED", "Unggahan video memerlukan ukuran berkas (Content-Length).");
      }
      if (declared > options.videoMaxBytes) throw new TrainingError(413, "TRAINING_VIDEO_TOO_LARGE", "Video melebihi batas ukuran.");
      const room = options.mediaQuotaBytes - (await usedBytes(pool)) + (material.byteSize ?? 0);
      if (declared > room || room <= 0) throw new TrainingError(507, "TRAINING_MEDIA_QUOTA_EXCEEDED", "Kuota penyimpanan video habis.");
      const key = `training/videos/${material.id}/${randomUUID()}.mp4`;
      let stored;
      try {
        stored = await objects.put(key, request.body as Readable, { maxBytes: Math.min(options.videoMaxBytes, room) });
      } catch (error) {
        if (error instanceof ObjectTooLargeError) {
          throw options.videoMaxBytes <= room
            ? new TrainingError(413, "TRAINING_VIDEO_TOO_LARGE", "Video melebihi batas ukuran.")
            : new TrainingError(507, "TRAINING_MEDIA_QUOTA_EXCEEDED", "Kuota penyimpanan video habis.");
        }
        throw error;
      }
      let durationSeconds: number;
      try {
        durationSeconds = (await inspectMp4((start, end) => readRange(objects, key, { start, end }), stored.byteSize)).durationSeconds;
      } catch (error) {
        await objects.delete(key);
        if (error instanceof VideoInspectionError) throw new TrainingError(400, error.code, error.message);
        throw error;
      }
      let previousKey: string | null = null;
      try {
        await kit.transactWork(async (client) => {
          const current = await loadMaterial(client, material.id, true);
          assertDraft(await loadModule(client, current.moduleId, true));
          // Concurrent uploads each saw room before they started; the quota is settled one at a time here.
          await client.query(`SELECT pg_advisory_xact_lock(hashtext('training_media_quota'))`);
          if ((await usedBytes(client)) - (current.byteSize ?? 0) + stored.byteSize > options.mediaQuotaBytes) {
            throw new TrainingError(507, "TRAINING_MEDIA_QUOTA_EXCEEDED", "Kuota penyimpanan video habis.");
          }
          previousKey = current.objectKey;
          await client.query(
            `UPDATE training_materials SET object_key = $2, byte_size = $3, duration_seconds = $4, sha256 = $5, uploaded_at = now(), updated_at = now()
              WHERE id = $1`,
            [material.id, key, stored.byteSize, durationSeconds, stored.sha256],
          );
          await audit(client, {
            eventType: "training.material.video_uploaded", actorAccountId: principal.id,
            metadata: { materialId: material.id, byteSize: stored.byteSize, durationSeconds, sha256: stored.sha256 },
          });
        });
      } catch (error) {
        await objects.delete(key);
        throw error;
      }
      if (previousKey) await objects.delete(previousKey).catch(() => undefined);
      return send(reply, 200, { id: material.id, byteSize: stored.byteSize, durationSeconds });
    });
  });

  app.get("/admin/training/materials/:id/stream", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_MATERIAL_ID", "Materi tidak valid.");
    return handle(reply, async () => {
      const objects = requireEnabled();
      const material = await loadMaterial(pool, params.data.id);
      if (!material.objectKey) throw materialNotFound();
      return streamObject(reply, objects, material.objectKey, request.headers.range);
    });
  });

  app.get("/admin/training/programs/:id/online-progress", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.read");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const query = pageQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply, "INVALID_TRAINING_FILTER", "Filter tidak valid.");
    return handle(reply, async () => {
      requireEnabled();
      const result = await pool.query<{ total: number }>(
        `SELECT participant.employee_id AS "employeeId", employee.full_name AS "fullName", employee.employee_number AS "employeeNumber",
                participant.status AS "participantStatus",
                (SELECT count(*)::int FROM training_materials material
                   JOIN training_modules module ON module.id = material.module_id AND module.status = 'PUBLISHED'
                  WHERE module.program_id = $1 AND material.status = 'ACTIVE') AS "materialCount",
                (SELECT count(*)::int FROM training_material_progress progress
                   JOIN training_materials material ON material.id = progress.material_id AND material.status = 'ACTIVE'
                   JOIN training_modules module ON module.id = material.module_id AND module.status = 'PUBLISHED'
                  WHERE module.program_id = $1 AND progress.employee_id = participant.employee_id AND progress.completed_at IS NOT NULL) AS "completedMaterials",
                (SELECT count(DISTINCT attempt.module_id)::int FROM training_quiz_attempts attempt
                   JOIN training_modules module ON module.id = attempt.module_id AND module.status = 'PUBLISHED'
                  WHERE module.program_id = $1 AND attempt.employee_id = participant.employee_id AND attempt.passed) AS "passedQuizzes",
                count(*) OVER ()::int AS total
           FROM training_participants participant
           JOIN employees employee ON employee.id = participant.employee_id
          WHERE participant.program_id = $1 AND participant.status <> 'WITHDRAWN'
          ORDER BY employee.full_name ASC, participant.employee_id ASC
          LIMIT $2 OFFSET $3`,
        [params.data.id, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, {
        items: result.rows.map(({ total, ...row }) => { void total; return row; }),
        pagination: pagination(query.data, result.rows[0]?.total ?? 0),
      });
    });
  });

  app.post("/admin/training/materials/:id/progress/:employeeId/complete", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = progressParams.safeParse(request.params);
    const body = reasonBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_TRAINING_REASON", "Alasan 5 sampai 500 huruf.");
    return transact(reply, async (client) => {
      requireEnabled();
      const material = await participantMaterial(client, params.data.id, params.data.employeeId);
      await markMaterialComplete(client, {
        materialId: material.id, employeeId: params.data.employeeId, via: "HC_MANUAL", reason: body.data.reason,
        actorAccountId: principal.id, programId: material.programId,
      });
      const programCompleted = await completeOnlineProgramIfDone(client, { programId: material.programId, employeeId: params.data.employeeId, actorAccountId: principal.id });
      return [200, { materialId: material.id, completed: true, programCompleted }];
    });
  });

  app.post("/admin/training/modules/:id/quiz/:employeeId/extra-attempt", async (request, reply) => {
    const principal = await requirePermission(request, reply, "training.manage");
    if (!principal) return;
    const params = progressParams.safeParse(request.params);
    const body = reasonBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_TRAINING_REASON", "Alasan 5 sampai 500 huruf.");
    return transact(reply, async (client) => {
      requireEnabled();
      const module = await loadModule(client, params.data.id, true);
      const member = await client.query(
        `SELECT 1 FROM training_participants WHERE program_id = $1 AND employee_id = $2 AND status = 'ENROLLED'`,
        [module.programId, params.data.employeeId],
      );
      if (module.status !== "PUBLISHED" || !module.quizItems || module.programStatus !== "ACTIVE" || !member.rows[0]) throw moduleNotFound();
      const used = (await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM training_quiz_attempts WHERE module_id = $1 AND employee_id = $2`,
        [module.id, params.data.employeeId],
      )).rows[0]!.count;
      if (used >= 50) throw new TrainingError(409, "TRAINING_QUIZ_ATTEMPT_LIMIT", "Batas teknis 50 percobaan tercapai.");
      await client.query(
        `INSERT INTO training_quiz_extra_attempts (id, module_id, employee_id, reason, granted_by_account_id) VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), module.id, params.data.employeeId, body.data.reason, principal.id],
      );
      await audit(client, {
        eventType: "training.quiz.attempt_granted", programId: module.programId, employeeId: params.data.employeeId,
        actorAccountId: principal.id, note: body.data.reason, metadata: { moduleId: module.id },
      });
      await notifyEmployee(client, params.data.employeeId, {
        eventKey: `training.quiz.${module.id}.extra.${params.data.employeeId}.${Date.now()}`, category: "system",
        title: "Percobaan kuis tambahan", body: `Anda mendapat satu percobaan lagi untuk kuis ${module.title}.`,
        href: `/app/training?program=${module.programId}`, actorAccountId: principal.id,
      });
      return [200, { moduleId: module.id, granted: 1 }];
    });
  });

  // ---------------------------------------------------------------- employee

  app.get("/training/me/programs/:id/modules", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_PROGRAM_ID", "Program pelatihan tidak valid.");
    return handle(reply, async () => {
      requireEnabled();
      const self = await loadSelf(pool, principal.id);
      const member = await pool.query(
        `SELECT 1 FROM training_participants WHERE program_id = $1 AND employee_id = $2 AND status <> 'WITHDRAWN'`,
        [params.data.id, self.id],
      );
      if (!member.rows[0]) throw new TrainingError(404, "TRAINING_PROGRAM_NOT_FOUND", "Program pelatihan tidak ditemukan.");
      // M-02 bounded: 20 published modules of 20 materials.
      const modules = await pool.query<{
        id: string; title: string; description: string | null; creditHours: number; hasQuiz: boolean; quizPassingScore: number;
        quizMaxAttempts: number; scores: number[]; materials: Array<{ completed: boolean }>;
      }>(
        `SELECT module.id, module.title, module.description, module.credit_hours::float8 AS "creditHours",
                module.quiz_items IS NOT NULL AS "hasQuiz", module.quiz_passing_score AS "quizPassingScore",
                module.quiz_max_attempts + (SELECT count(*)::int FROM training_quiz_extra_attempts extra
                                             WHERE extra.module_id = module.id AND extra.employee_id = $2) AS "quizMaxAttempts",
                COALESCE((SELECT array_agg(attempt.score::float8 ORDER BY attempt.attempt_no) FROM training_quiz_attempts attempt
                           WHERE attempt.module_id = module.id AND attempt.employee_id = $2), '{}') AS scores,
                COALESCE((SELECT jsonb_agg(jsonb_build_object(
                    'id', material.id, 'kind', material.kind, 'title', material.title, 'body', material.body,
                    'durationSeconds', material.duration_seconds, 'creditedSeconds', COALESCE(progress.credited_seconds, 0),
                    'completed', progress.completed_at IS NOT NULL) ORDER BY material.position, material.id)
                  FROM training_materials material
                  LEFT JOIN training_material_progress progress ON progress.material_id = material.id AND progress.employee_id = $2
                  WHERE material.module_id = module.id AND material.status = 'ACTIVE'), '[]'::jsonb) AS materials
           FROM training_modules module
          WHERE module.program_id = $1 AND module.status = 'PUBLISHED'
          ORDER BY module.position ASC, module.id ASC LIMIT 100`,
        [params.data.id, self.id],
      );
      return send(reply, 200, {
        items: modules.rows.map((module) => {
          const standing = quizStanding(module.scores, module.quizPassingScore, module.quizMaxAttempts);
          const allMaterials = module.materials.every((material) => material.completed);
          return {
            ...module,
            quiz: module.hasQuiz ? { ...standing, passingScore: module.quizPassingScore, unlocked: allMaterials } : null,
            completed: moduleComplete({
              materials: module.materials.length, completedMaterials: module.materials.filter((material) => material.completed).length,
              hasQuiz: module.hasQuiz, quizPassed: standing.passed,
            }),
          };
        }),
      });
    });
  });

  app.post("/training/me/materials/:id/playbacks", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_MATERIAL_ID", "Materi tidak valid.");
    return transact(reply, async (client) => {
      requireEnabled();
      const self = await loadSelf(client, principal.id, true);
      const material = await participantMaterial(client, params.data.id, self.id);
      if (material.kind !== "VIDEO" || !material.objectKey) throw new TrainingError(409, "TRAINING_MATERIAL_NOT_VIDEO", "Materi ini bukan video.");
      // M-08: one active watch session per participant and material.
      await client.query(
        `UPDATE training_playbacks SET status = 'ENDED', ended_at = now() WHERE material_id = $1 AND employee_id = $2 AND status = 'ACTIVE'`,
        [material.id, self.id],
      );
      const progress = await client.query<{ credited: number; completed: boolean }>(
        `INSERT INTO training_material_progress (material_id, employee_id) VALUES ($1, $2)
         ON CONFLICT (material_id, employee_id) DO UPDATE SET last_position_seconds = training_material_progress.credited_seconds, updated_at = now()
         RETURNING credited_seconds::float8 AS credited, completed_at IS NOT NULL AS completed`,
        [material.id, self.id],
      );
      const id = randomUUID();
      await client.query(
        `INSERT INTO training_playbacks (id, material_id, employee_id, base_seconds, started_at, last_heartbeat_at)
         VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp())`,
        [id, material.id, self.id, progress.rows[0]!.credited],
      );
      return [201, {
        playbackId: id, durationSeconds: material.durationSeconds, creditedSeconds: progress.rows[0]!.credited,
        completed: progress.rows[0]!.completed, streamUrl: `/api/training/me/materials/${material.id}/stream?playback=${id}`,
      }];
    });
  });

  app.post("/training/me/playbacks/:id/heartbeat", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = heartbeatBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_TRAINING_HEARTBEAT", "Posisi tidak valid.");
    return transact(reply, async (client) => {
      requireEnabled();
      const self = await loadSelf(client, principal.id);
      const found = await client.query<{ materialId: string; status: string; lastHeartbeatAt: Date; nowAt: Date; startedAt: Date; base: number }>(
        `SELECT material_id AS "materialId", status, last_heartbeat_at AS "lastHeartbeatAt", clock_timestamp() AS "nowAt",
                started_at AS "startedAt", base_seconds::float8 AS base
           FROM training_playbacks WHERE id = $1 AND employee_id = $2 FOR UPDATE`,
        [params.data.id, self.id],
      );
      const playback = found.rows[0];
      if (!playback) throw new TrainingError(404, "TRAINING_PLAYBACK_NOT_FOUND", "Sesi tonton tidak ditemukan.");
      const nowMs = playback.nowAt.getTime();
      if (playback.status !== "ACTIVE" || nowMs - playback.lastHeartbeatAt.getTime() > PLAYBACK_IDLE_MS) {
        if (playback.status === "ACTIVE") {
          await client.query(`UPDATE training_playbacks SET status = 'ENDED', ended_at = now() WHERE id = $1`, [params.data.id]);
          return [409, { code: "TRAINING_PLAYBACK_ENDED", message: "Sesi tonton sudah berakhir. Muat ulang video." }];
        }
        throw new TrainingError(409, "TRAINING_PLAYBACK_ENDED", "Sesi tonton sudah berakhir. Muat ulang video.");
      }
      const material = await participantMaterial(client, playback.materialId, self.id);
      const progress = (await client.query<{ credited: number; last: number; completed: boolean }>(
        `SELECT credited_seconds::float8 AS credited, last_position_seconds::float8 AS last, completed_at IS NOT NULL AS completed
           FROM training_material_progress WHERE material_id = $1 AND employee_id = $2 FOR UPDATE`,
        [material.id, self.id],
      )).rows[0] ?? { credited: 0, last: 0, completed: false };
      const next = creditHeartbeat({
        frontierSeconds: progress.credited, lastPositionSeconds: progress.last, lastHeartbeatMs: playback.lastHeartbeatAt.getTime(),
        nowMs, positionSeconds: body.data.position, durationSeconds: material.durationSeconds ?? 0,
        sessionBaseSeconds: playback.base, sessionStartedMs: playback.startedAt.getTime(),
      });
      await client.query(`UPDATE training_playbacks SET last_heartbeat_at = $2 WHERE id = $1`, [params.data.id, playback.nowAt]);
      await client.query(
        `INSERT INTO training_material_progress (material_id, employee_id, credited_seconds, last_position_seconds, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (material_id, employee_id) DO UPDATE
           SET credited_seconds = GREATEST(training_material_progress.credited_seconds, EXCLUDED.credited_seconds),
               last_position_seconds = EXCLUDED.last_position_seconds, updated_at = now()`,
        [material.id, self.id, next.frontierSeconds, next.lastPositionSeconds],
      );
      let completed = progress.completed;
      let programCompleted = false;
      if (!completed && videoCompleted(next.frontierSeconds, material.durationSeconds ?? 0)) {
        completed = await markMaterialComplete(client, {
          materialId: material.id, employeeId: self.id, via: "WATCHED", actorAccountId: principal.id, programId: material.programId,
        });
        programCompleted = await completeOnlineProgramIfDone(client, { programId: material.programId, employeeId: self.id, actorAccountId: principal.id });
      }
      return [200, { creditedSeconds: next.frontierSeconds, completed, programCompleted }];
    });
  });

  app.get("/training/me/materials/:id/stream", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const query = streamQuery.safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply, "INVALID_TRAINING_PLAYBACK", "Sesi tonton tidak valid.");
    return handle(reply, async () => {
      const objects = requireEnabled();
      const self = await loadSelf(pool, principal.id);
      const material = await participantMaterial(pool, params.data.id, self.id);
      const playback = await pool.query(
        `SELECT 1 FROM training_playbacks
          WHERE id = $1 AND material_id = $2 AND employee_id = $3 AND status = 'ACTIVE'
            AND last_heartbeat_at > now() - ($4::int * interval '1 millisecond')`,
        [query.data.playback, material.id, self.id, PLAYBACK_IDLE_MS],
      );
      if (!playback.rows[0] || !material.objectKey) throw new TrainingError(404, "TRAINING_PLAYBACK_NOT_FOUND", "Sesi tonton tidak ditemukan.");
      try {
        return await streamObject(reply, objects, material.objectKey, request.headers.range);
      } catch (error) {
        if (error instanceof ObjectNotFoundError) throw materialNotFound();
        throw error;
      }
    });
  });

  app.post("/training/me/materials/:id/read", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_MATERIAL_ID", "Materi tidak valid.");
    return transact(reply, async (client) => {
      requireEnabled();
      const self = await loadSelf(client, principal.id, true);
      const material = await participantMaterial(client, params.data.id, self.id);
      if (material.kind !== "TEXT") throw new TrainingError(409, "TRAINING_MATERIAL_NOT_TEXT", "Video diselesaikan dengan menonton.");
      await markMaterialComplete(client, { materialId: material.id, employeeId: self.id, via: "READ", actorAccountId: principal.id, programId: material.programId });
      const programCompleted = await completeOnlineProgramIfDone(client, { programId: material.programId, employeeId: self.id, actorAccountId: principal.id });
      return [200, { completed: true, programCompleted }];
    });
  });

  async function participantModule(db: Queryable, moduleId: string, employeeId: string) {
    const module = await loadModule(db, moduleId);
    const member = await db.query(
      `SELECT 1 FROM training_participants WHERE program_id = $1 AND employee_id = $2 AND status IN ('ENROLLED', 'COMPLETED')`,
      [module.programId, employeeId],
    );
    if (module.status !== "PUBLISHED" || module.delivery !== "ONLINE" || module.programStatus !== "ACTIVE" || !member.rows[0] || !module.quizItems) {
      throw moduleNotFound();
    }
    const materials = await db.query<{ total: number; done: number }>(
      `SELECT count(*)::int AS total, count(progress.completed_at)::int AS done
         FROM training_materials material
         LEFT JOIN training_material_progress progress ON progress.material_id = material.id AND progress.employee_id = $2
        WHERE material.module_id = $1 AND material.status = 'ACTIVE'`,
      [moduleId, employeeId],
    );
    const attempts = (await db.query<{ score: number }>(
      `SELECT score::float8 AS score FROM training_quiz_attempts WHERE module_id = $1 AND employee_id = $2 ORDER BY attempt_no`,
      [moduleId, employeeId],
    )).rows.map((row) => row.score);
    const extra = (await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM training_quiz_extra_attempts WHERE module_id = $1 AND employee_id = $2`,
      [moduleId, employeeId],
    )).rows[0]!.count;
    return { module: { ...module, quizMaxAttempts: module.quizMaxAttempts + extra }, unlocked: materials.rows[0]!.done >= materials.rows[0]!.total, attempts };
  }

  app.get("/training/me/modules/:id/quiz", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_TRAINING_MODULE_ID", "Modul tidak valid.");
    return handle(reply, async () => {
      requireEnabled();
      const self = await loadSelf(pool, principal.id);
      const { module, unlocked, attempts } = await participantModule(pool, params.data.id, self.id);
      if (!unlocked) throw new TrainingError(409, "TRAINING_QUIZ_LOCKED", "Selesaikan semua materi modul sebelum kuis.");
      return send(reply, 200, {
        moduleId: module.id, title: module.title, ...quizStanding(attempts, module.quizPassingScore, module.quizMaxAttempts),
        passingScore: module.quizPassingScore, items: publicItems(module.quizItems!),
      });
    });
  });

  app.post("/training/me/modules/:id/quiz/attempts", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    const body = quizBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_TRAINING_RESPONSE", "Jawaban tidak valid.");
    return transact(reply, async (client) => {
      requireEnabled();
      // The employee row lock serializes this employee's attempts (attempt numbering).
      const self = await loadSelf(client, principal.id, true);
      const { module, unlocked, attempts } = await participantModule(client, params.data.id, self.id);
      if (!unlocked) throw new TrainingError(409, "TRAINING_QUIZ_LOCKED", "Selesaikan semua materi modul sebelum kuis.");
      const before = quizStanding(attempts, module.quizPassingScore, module.quizMaxAttempts);
      if (before.passed) throw new TrainingError(409, "TRAINING_QUIZ_PASSED", "Kuis ini sudah lulus.");
      if (before.attemptsLeft === 0) throw new TrainingError(409, "TRAINING_QUIZ_NO_ATTEMPTS", "Percobaan kuis sudah habis. Hubungi Human Capital.");
      const answers = validateAnswers(module.quizItems!, body.data.answers);
      const scored = scoreTest(module.quizItems!, answers);
      const passed = scored.score >= module.quizPassingScore;
      await client.query(
        `INSERT INTO training_quiz_attempts (id, module_id, employee_id, attempt_no, answers, score, passed)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [randomUUID(), module.id, self.id, attempts.length + 1, JSON.stringify(answers), scored.score, passed],
      );
      await audit(client, {
        eventType: "training.quiz.attempted", programId: module.programId, employeeId: self.id, actorAccountId: principal.id,
        metadata: { moduleId: module.id, attemptNo: attempts.length + 1, score: scored.score, passed },
      });
      const programCompleted = passed
        ? await completeOnlineProgramIfDone(client, { programId: module.programId, employeeId: self.id, actorAccountId: principal.id })
        : false;
      const after = quizStanding([...attempts, scored.score], module.quizPassingScore, module.quizMaxAttempts);
      return [201, { score: scored.score, passed, best: after.best, attemptsLeft: after.attemptsLeft, programCompleted }];
    });
  });
}
