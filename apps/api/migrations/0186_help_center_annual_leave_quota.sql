-- LEAVE-003 R2 / HELP-001: the Cuti Tahunan entitlement FAQ described one quota rule as if it were
-- the only one. It now names both, says which one applies (the rule in force on the leave date) and
-- where the employee reads the figure that actually binds their request.
-- Spec: docs/domain/leave-policy-ysq.md §"LEAVE-003 R2", docs/domain/help-center.md §8.1.
--
-- HC's own edits always win; the article changes only while its body is still the 0130 text,
-- following the same two cases as 0137 (untouched draft corrected in place; published-but-never-saved
-- seed edited as a normal save). Re-running is harmless: once the body has changed, nothing matches.
--
-- The comparison strips CR before matching. A row seeded from a CRLF checkout holds the same words
-- with different line endings, and an exact match would then find nothing, report success and leave
-- every employee reading the old rule — a silent no-op with no error and no row count anyone sees.
-- The text written is always the LF form, so the row is normalised on the way through.
--
-- Down: none needed for safety. To restore the 0130 wording of an untouched draft, run only the
-- draft and draft_revision parts with old and new swapped; a published one is edited back by HC on
-- the admin screen.

WITH changes(id, old_body, new_body, change_note) AS (VALUES
  ('33b7ee82-a5df-5249-9d20-722b12b83e74',
   $help$Untuk tenaga non-pendidikan, hak cuti tahunan adalah 12 hari kerja per tahun, dengan pemakaian paling banyak 3 hari kerja per periode tiga bulan (Januari–Maret, April–Juni, Juli–September, Oktober–Desember). Hak mulai dapat dipakai setelah 12 bulan bekerja; periode sebelum itu tidak berlaku mundur, dan sisa periode saat ini tidak otomatis dibawa ke periode berikutnya.

Untuk tenaga pendidikan, hak tahunan dipenuhi lewat Cuti Akhir Semester dan Akhir Tahun Pelajaran sesuai kalender akademik yayasan, bukan lewat pengajuan Cuti Tahunan perorangan. Kelompok Anda tampil di kotak Hak Cuti Tahunan.$help$,
   $help$Untuk tenaga non-pendidikan, hak cuti tahunan adalah 12 hari kerja per tahun. Pemakaiannya dibatasi per periode kuota. Batas dan periode yang berlaku untuk tanggal cuti Anda selalu tampil di kotak Hak Cuti Tahunan pada menu Cuti & Izin; angka di kotak itulah yang dipakai sistem.

Ada dua aturan periode. Aturan lama: paling banyak 3 hari kerja per periode tiga bulan (Januari–Maret, April–Juni, Juli–September, Oktober–Desember). Penggantinya, yang berlaku mulai tanggal yang ditetapkan yayasan: paling banyak 6 hari kerja per semester (Januari–Juni dan Juli–Desember). Yang dipakai adalah aturan yang berlaku pada tanggal cuti, bukan pada tanggal Anda mengajukan, sehingga pengajuan yang sudah dikirim tidak berubah aturannya.

Satu pengajuan harus berada dalam satu periode. Selama aturan semester berlaku, tanggal yang melewati 30 Juni–1 Juli atau pergantian tahun diajukan terpisah. Hak mulai dapat dipakai setelah 12 bulan bekerja; periode sebelum itu tidak berlaku mundur, dan sisa periode tidak otomatis dibawa ke periode berikutnya.

Untuk tenaga pendidikan, hak tahunan dipenuhi lewat Cuti Akhir Semester dan Akhir Tahun Pelajaran sesuai kalender akademik yayasan, bukan lewat pengajuan Cuti Tahunan perorangan. Kelompok Anda tampil di kotak Hak Cuti Tahunan.$help$,
   $help$Menyebut kedua aturan periode kuota Cuti Tahunan dan aturan tanggal berlakunya (LEAVE-003 R2).$help$)
),
draft AS (
  UPDATE help_articles article
     SET body = replace(changes.new_body, chr(13), ''), updated_at = now()
    FROM changes
   WHERE article.id = changes.id::uuid
     AND article.origin = 'SEED' AND article.status = 'DRAFT' AND article.version = 1
     AND article.published_at IS NULL AND replace(article.body, chr(13), '') = replace(changes.old_body, chr(13), '')
  RETURNING article.id, article.kind, article.topic, article.title, changes.change_note
),
draft_revision AS (
  UPDATE help_article_revisions revision
     SET body = replace(changes.new_body, chr(13), '')
    FROM draft
    JOIN changes ON changes.id::uuid = draft.id
   WHERE revision.article_id = draft.id AND revision.version = 1
  RETURNING revision.article_id
),
live AS (
  UPDATE help_articles article
     SET body = replace(changes.new_body, chr(13), ''), version = article.version + 1, updated_at = now()
    FROM changes
   WHERE article.id = changes.id::uuid
     AND article.origin = 'SEED' AND article.status = 'PUBLISHED' AND replace(article.body, chr(13), '') = replace(changes.old_body, chr(13), '')
     AND NOT EXISTS (SELECT 1 FROM help_article_revisions saved
                      WHERE saved.article_id = article.id AND saved.actor_account_id IS NOT NULL)
  RETURNING article.id, article.kind, article.topic, article.title, article.body, article.status,
            article.version, changes.change_note
),
live_revision AS (
  INSERT INTO help_article_revisions (id, article_id, version, kind, topic, title, body, status, change_note)
  SELECT gen_random_uuid(), live.id, live.version, live.kind, live.topic, live.title, live.body, live.status,
         live.change_note
    FROM live
  RETURNING article_id
),
draft_audit AS (
  INSERT INTO help_audit_events (id, event_type, article_id, reason, metadata)
  SELECT gen_random_uuid(), 'help.article.seed_corrected', draft.id, draft.change_note,
         jsonb_build_object('kind', draft.kind, 'topic', draft.topic, 'title', draft.title,
                            'version', 1, 'origin', 'SEED', 'migration', '0186')
    FROM draft
  RETURNING id
)
INSERT INTO help_audit_events (id, event_type, article_id, reason, metadata)
SELECT gen_random_uuid(), 'help.article.edited', live.id, live.change_note,
       jsonb_build_object('kind', live.kind, 'topic', live.topic, 'title', live.title,
                          'version', live.version, 'status', live.status, 'previousTitle', live.title,
                          'origin', 'SEED', 'migration', '0186')
  FROM live;
