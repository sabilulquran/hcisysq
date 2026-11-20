-- PERF-001 Paket 2a (keputusan owner 18 Nov 2026): rubrik berversi dan bercakupan jabatan,
-- serta siklus semesteran.
-- Spec: docs/domain/performance-review.md §4 (D-18, D-19, D-20), §7.11, §12.
--
-- Dua perubahan, satu migrasi karena keduanya menyentuh `performance_cycles`:
--   1. D-18: `kind` menerima 'SEMESTER' (kalender pendidikan: ganjil dan genap).
--   2. D-19/D-20: bobot indikator tidak lagi tertanam di kode. Rubrik menjadi versi bertanggal
--      milik HC, dan bobotnya boleh berbeda menurut kelompok jabatan — akhlak berbobot lain
--      bagi guru tahfizh dan bagi office boy. Kelompoknya memakai katalog klasifikasi jabatan
--      ORG-011 (ADR-0004), bukan daftar jenis pekerjaan baru dan tidak pernah teks nama jabatan.
--
-- Bentuk tabelnya mengikuti `trip_per_diem_rates` (append-only, berlaku sejak tanggal) dan bukan
-- `payroll_policy_versions` (rentang `effective_from`/`effective_to` dengan EXCLUDE): rubrik
-- tidak pernah ditutup mundur, dan versi berikutnya cukup berlaku sejak tanggalnya. Barisnya
-- sekaligus audit — pembuat dan waktunya ada di baris itu dan tidak pernah berubah — jadi tidak
-- ada event baru di `performance_events`.
--
-- Reproducibility: siklus yang sudah dinilai harus tetap menghasilkan angka yang sama, dan satu
-- siklus kini memuat beberapa rubrik sekaligus (satu per kelompok jabatan). Karena itu rubrik
-- yang dipakai dibekukan **pada penilaian**, bukan hanya pada siklus, dan nomor versinya dicatat
-- di sana. Mengubah rubrik hanya memengaruhi penilaian yang dibuat sesudahnya.
--
-- Tidak ada permission baru: rubrik dikelola `performance.manage` yang sudah ada.
--
-- Deploy aman: versi 1 memuat angka yang hari ini sudah dipakai kode sebagai cakupan DEFAULT,
-- dan setiap penilaian lama dibekukan dengan rubrik siklusnya sendiri, sehingga tidak ada nilai
-- yang berubah saat migrasi berjalan.
--
-- Down:
--   ALTER TABLE performance_reviews
--     DROP COLUMN IF EXISTS rubric,
--     DROP COLUMN IF EXISTS rubric_version_id,
--     DROP COLUMN IF EXISTS rubric_version;
--   ALTER TABLE performance_cycles
--     DROP CONSTRAINT IF EXISTS performance_cycles_rubric_weight_total,
--     DROP COLUMN IF EXISTS rubric_version_id,
--     DROP COLUMN IF EXISTS rubric_version;
--   ALTER TABLE performance_cycles DROP CONSTRAINT performance_cycles_kind_check;
--   ALTER TABLE performance_cycles ADD CONSTRAINT performance_cycles_kind_check
--     CHECK (kind IN ('MONTHLY', 'ANNUAL'));   -- hapus dulu siklus SEMESTER yang terlanjur ada
--   DROP TABLE IF EXISTS performance_rubric_version_jobs;
--   DROP TABLE IF EXISTS performance_rubric_versions;
--   DROP FUNCTION IF EXISTS performance_rubric_refuse_change();
--   DROP FUNCTION IF EXISTS performance_rubric_weight_total(jsonb);

-- Tabelnya kecil, tetapi jangan antrekan layar penilaian di belakang transaksi panjang.
--
-- Catatan jendela deploy untuk operator: `ALTER TABLE performance_reviews ALTER COLUMN rubric
-- SET NOT NULL` di bawah mengambil ACCESS EXCLUSIVE atas `performance_reviews`. Dengan
-- `lock_timeout` 5 detik, satu penambahan peserta dari instance lama yang commit tepat saat
-- migrasi berjalan akan membuat migrasi ini **gagal bersih** (tidak ada yang separuh jadi,
-- seluruhnya satu transaksi). Itu disengaja. Yang tidak boleh dilakukan adalah mengulanginya
-- membabi buta: jalankan lagi hanya setelah memastikan tidak ada siklus penilaian yang sedang
-- diubah, atau saat HCIS tidak dipakai. Rilis ini sebaiknya di luar jam kerja HC.
SET LOCAL lock_timeout = '5s';

-- D-19: jumlah bobot dijaga database, bukan hanya kode, dan per versi. Payload yang bentuknya
-- salah, bobot bukan angka, atau daftar indikator kosong menghasilkan -1 supaya CHECK-nya
-- menolak, bukan menghasilkan NULL yang lolos.
CREATE OR REPLACE FUNCTION performance_rubric_weight_total(rubric jsonb)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  total numeric;
BEGIN
  IF jsonb_typeof(rubric -> 'indicators') <> 'array' THEN
    RETURN -1;
  END IF;
  SELECT sum((indicator ->> 'weight')::numeric) INTO total
    FROM jsonb_array_elements(rubric -> 'indicators') AS indicator;
  RETURN coalesce(total, -1);
EXCEPTION
  WHEN others THEN RETURN -1;
END;
$$;

CREATE OR REPLACE FUNCTION performance_rubric_refuse_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'performance rubric versions are append-only' USING ERRCODE = '23514';
END;
$$;

-- D-19: rubrik yang berlaku pada satu tanggal adalah baris dengan `effective_from` terbesar yang
-- tidak melewati tanggal itu, di antara versi yang mencakup jabatan pegawai itu. Mengubah rubrik
-- berarti menambah versi, tidak pernah menimpa satu pun.
CREATE TABLE IF NOT EXISTS performance_rubric_versions (
  id uuid PRIMARY KEY,
  version integer NOT NULL UNIQUE CHECK (version >= 1),
  -- D-20: 'DEFAULT' berlaku untuk jabatan apa pun yang tidak disebut versi bercakupan; 'JOB_GROUP'
  -- berlaku hanya untuk kode klasifikasi jabatan yang didaftarkan di tabel di bawah.
  scope text NOT NULL CHECK (scope IN ('DEFAULT', 'JOB_GROUP')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 3 AND 120),
  effective_from date NOT NULL,
  -- Indikator (code, label, description, weight) dan predikat (code, label, minScore), bentuk
  -- yang sama dengan `performance_cycles.rubric`.
  payload jsonb NOT NULL,
  -- Dari mana angkanya, misalnya nomor keputusan atau tanggal rapat.
  source text NOT NULL CHECK (char_length(btrim(source)) BETWEEN 1 AND 200),
  note text NULL CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  created_by_account_id uuid NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT performance_rubric_versions_weight_total
    CHECK (performance_rubric_weight_total(payload) = 100),
  CONSTRAINT performance_rubric_versions_shape
    CHECK (jsonb_typeof(payload -> 'indicators') = 'array' AND jsonb_typeof(payload -> 'predicates') = 'array')
);

CREATE INDEX IF NOT EXISTS performance_rubric_versions_effective_idx
  ON performance_rubric_versions (effective_from DESC, version DESC);

-- D-20: kelompok jabatan satu versi. Kode klasifikasi disimpan verbatim, seperti kebijakan
-- payroll berversi menyimpannya (ORG-011 §2.6: kode permanen, klasifikasi yang salah
-- dinonaktifkan dan diganti, tidak pernah diganti nama), jadi tanpa foreign key ke katalog yang
-- bertanggal. Satu versi menyebut beberapa jabatan; satu jabatan boleh disebut beberapa versi
-- dari waktu ke waktu, dan yang berlaku adalah versi terbaru yang sudah mulai.
CREATE TABLE IF NOT EXISTS performance_rubric_version_jobs (
  rubric_version_id uuid NOT NULL REFERENCES performance_rubric_versions(id) ON DELETE CASCADE,
  job_classification_code text NOT NULL CHECK (job_classification_code ~ '^[A-Z][A-Z0-9_]{0,47}$'),
  PRIMARY KEY (rubric_version_id, job_classification_code)
);

CREATE INDEX IF NOT EXISTS performance_rubric_version_jobs_code_idx
  ON performance_rubric_version_jobs (job_classification_code);

DROP TRIGGER IF EXISTS performance_rubric_versions_immutable ON performance_rubric_versions;
CREATE TRIGGER performance_rubric_versions_immutable
  BEFORE UPDATE OR DELETE ON performance_rubric_versions
  FOR EACH ROW EXECUTE FUNCTION performance_rubric_refuse_change();

DROP TRIGGER IF EXISTS performance_rubric_version_jobs_immutable ON performance_rubric_version_jobs;
-- Termasuk DELETE: menghapus satu baris jabatan akan diam-diam mengubah cakupan versi yang
-- sudah dipakai. ON DELETE CASCADE di atas tidak pernah berjalan karena versinya sendiri tidak
-- dapat dihapus; ia ada supaya maksudnya terbaca.
CREATE TRIGGER performance_rubric_version_jobs_immutable
  BEFORE UPDATE OR DELETE ON performance_rubric_version_jobs
  FOR EACH ROW EXECUTE FUNCTION performance_rubric_refuse_change();

-- Versi 1 adalah angka yang sudah berjalan sejak rilis PERF-001 (3 Nov 2026): hasil kerja 30,
-- disiplin 20, akhlak 20, kerja sama 15, inisiatif 15; skala 1-4; A >= 3,50, B >= 2,50,
-- C >= 1,50, D >= 1,00. Cakupannya DEFAULT, jadi pegawai yang jabatannya belum diklasifikasikan
-- pun tetap dinilai, dan tidak ada yang berubah saat migrasi ini terpasang.
INSERT INTO performance_rubric_versions (id, version, scope, name, effective_from, payload, source, note)
SELECT
  '7f2b2c66-8a4e-4f1e-9a3f-0f1d9d1a0175'::uuid,
  1,
  'DEFAULT',
  'Rubrik dasar semua jabatan',
  DATE '2026-11-03',
  '{
     "indicators": [
       {"code": "TASK_RESULT", "label": "Hasil kerja", "description": "Mutu dan ketuntasan tugas pokok pada periode ini.", "weight": 30},
       {"code": "DISCIPLINE", "label": "Disiplin dan kehadiran", "description": "Ketepatan waktu, kehadiran, dan kepatuhan pada aturan kerja.", "weight": 20},
       {"code": "AKHLAK", "label": "Akhlak dan adab", "description": "Adab kepada santri, rekan, dan atasan; amanah dan kejujuran.", "weight": 20},
       {"code": "TEAMWORK", "label": "Kerja sama dan komunikasi", "description": "Kesediaan membantu, koordinasi, dan cara menyampaikan informasi.", "weight": 15},
       {"code": "INITIATIVE", "label": "Inisiatif dan pengembangan diri", "description": "Usulan perbaikan, belajar hal baru, dan tanggung jawab di luar tugas pokok.", "weight": 15}
     ],
     "predicates": [
       {"code": "A", "label": "Sangat baik", "minScore": 3.5},
       {"code": "B", "label": "Baik", "minScore": 2.5},
       {"code": "C", "label": "Cukup", "minScore": 1.5},
       {"code": "D", "label": "Kurang", "minScore": 1}
     ]
   }'::jsonb,
  'PERF-001 D-05/D-06 (rubrik bawaan sejak rilis 3 Nov 2026)',
  'Dimuat migrasi 0175 supaya angka yang sedang berjalan menjadi versi 1; tidak ada perubahan perilaku.'
WHERE NOT EXISTS (SELECT 1 FROM performance_rubric_versions);

-- D-18: siklus semesteran mengikuti kalender pendidikan. Periodenya divalidasi aturan domain,
-- sama seperti MONTHLY dan ANNUAL. Tanpa IF EXISTS: 0120 selalu membuat CHECK ini dengan nama
-- bawaannya, dan no-op diam akan meninggalkan CHECK lama yang menolak jenis baru.
ALTER TABLE performance_cycles DROP CONSTRAINT performance_cycles_kind_check;
ALTER TABLE performance_cycles
  ADD CONSTRAINT performance_cycles_kind_check CHECK (kind IN ('MONTHLY', 'SEMESTER', 'ANNUAL'));

-- D-19: siklus mencatat versi rubrik dasar yang disalinnya. NULL berarti rubrik khusus siklus itu
-- (HC mengetiknya saat siklus masih DRAFT) atau siklus yang dibuat sebelum rubrik berversi ada.
-- Rubrik siklus tetap ada dan tetap dibekukan saat siklus dibuka: ia menjadi rubrik cadangan bagi
-- peserta yang jabatannya tidak dicakup satu pun versi.
ALTER TABLE performance_cycles
  ADD COLUMN IF NOT EXISTS rubric_version_id uuid NULL REFERENCES performance_rubric_versions(id),
  ADD COLUMN IF NOT EXISTS rubric_version integer NULL CHECK (rubric_version IS NULL OR rubric_version >= 1);

-- Salinan beku milik siklus tunduk pada aturan yang sama: bobot berjumlah 100 atau ditolak.
ALTER TABLE performance_cycles
  DROP CONSTRAINT IF EXISTS performance_cycles_rubric_weight_total;
ALTER TABLE performance_cycles
  ADD CONSTRAINT performance_cycles_rubric_weight_total
  CHECK (performance_rubric_weight_total(rubric) = 100);

-- Siklus lama yang rubriknya persis sama dengan versi 1 dicatat sebagai memakai versi 1; yang
-- berbeda tetap NULL (rubrik khusus siklus), tidak ditebak.
UPDATE performance_cycles cycle
   SET rubric_version_id = version.id, rubric_version = version.version
  FROM performance_rubric_versions version
 WHERE version.version = 1
   AND cycle.rubric_version_id IS NULL
   AND cycle.rubric = version.payload;

-- D-20: rubrik yang dipakai satu penilaian dibekukan di penilaian itu, karena satu siklus kini
-- memuat beberapa rubrik sekaligus. Diisi saat pegawai masuk siklus dan tidak berubah sesudahnya.
ALTER TABLE performance_reviews
  ADD COLUMN IF NOT EXISTS rubric jsonb NULL,
  ADD COLUMN IF NOT EXISTS rubric_version_id uuid NULL REFERENCES performance_rubric_versions(id),
  ADD COLUMN IF NOT EXISTS rubric_version integer NULL CHECK (rubric_version IS NULL OR rubric_version >= 1);

-- Penilaian lama memakai rubrik siklusnya; membekukannya di sini membuat hasil lama tetap sama
-- persis, termasuk yang sudah FINALIZED.
UPDATE performance_reviews review
   SET rubric = cycle.rubric
  FROM performance_cycles cycle
 WHERE cycle.id = review.cycle_id
   AND review.rubric IS NULL;

ALTER TABLE performance_reviews ALTER COLUMN rubric SET NOT NULL;

ALTER TABLE performance_reviews
  DROP CONSTRAINT IF EXISTS performance_reviews_rubric_weight_total;
ALTER TABLE performance_reviews
  ADD CONSTRAINT performance_reviews_rubric_weight_total
  CHECK (performance_rubric_weight_total(rubric) = 100);
