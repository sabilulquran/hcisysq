-- TRIP-002 D-20 release gate, bagian setelah migrate dan sebelum cutover
-- (trip_002_gate_mapped di scripts/mi8/release-mi8.sh).
--
-- Gerbang ini ada untuk meramalkan penolakan 409 TRIP_PER_DIEM_GOLONGAN_UNMAPPED yang nyata,
-- jadi kueri di bawah menirukan jalur runtime, bukan menebaknya:
--   * resolveGolongan() di apps/api/src/modules/trip-advances/routes.ts, dan
--   * bindingsOn() di apps/api/src/modules/organization/job-classification-resolver.ts.
-- Runtime memberi golongan jika dan hanya jika paling sedikit satu klasifikasi jabatan yang
-- terikat pada tanggal itu punya baris di trip_per_diem_golongan_map. Pegawai tanpa ikatan
-- klasifikasi sama sekali juga tidak mendapat golongan, dan karena itu diperiksa dari ORANGNYA,
-- bukan dari katalog.
--
-- Berkas ini dipakai apa adanya oleh dua pihak, supaya keduanya tidak pernah berbeda teks:
-- release-mi8.sh menjalankannya di perangkat, dan scripts/mi8/test-trip-002-gate.sh
-- menjalankannya terhadap PostgreSQL sekali pakai.
--
-- Batas sintaksis: kueri ini diratakan menjadi satu baris dan menumpang di dalam tanda kutip
-- ganda bersusun pada perangkat, jadi tidak boleh mengandung tanda kutip ganda, backslash,
-- tanda dolar, atau backtick.
--
-- Setiap baris keluaran (psql -At, satu kolom): SEVERITY|KIND|DETAIL
--   OK    baris sentinel, selalu ada. Keluaran tanpa baris ini berarti kuerinya tidak pernah
--         menjawab, dan itu harus dibaca sebagai gagal, bukan sebagai bersih: psql menulis
--         galat ke stderr dan tidak mencetak apa pun ke stdout, persis seperti dunia yang
--         semuanya beres.
--   FAIL  menghentikan rilis; ada orang atau uang muka nyata yang akan ditolak 409.
--   WARN  dicetak saja; belum memutus apa pun hari ini.
WITH
-- Kelayakan: siapa yang dapat mengajukan uang muka dinas. Runtime menuntut akun pegawai aktif
-- pada pegawai aktif yang belum dikeluarkan (loadEmployeeContext). Gerbang sengaja TIDAK
-- menyaring lebih jauh dari itu: ia harus menjadi superset dari runtime, bukan himpunan yang
-- lebih sempit. Khususnya management_scope tidak diperiksa di sini, karena rutenya pun tidak
-- memeriksanya, sehingga pegawai OUTSIDE_HCIS berakun aktif tetap akan ditolak 409 bila
-- golongannya tidak ketemu. Akun juga tidak disyaratkan: pegawai aktif yang akunnya baru
-- diaktifkan besok tetap harus sudah punya golongan hari ini.
eligible AS (
  SELECT employee.id, employee.employee_number
    FROM employees employee
   WHERE employee.status = 'active'
     AND employee.removed_at IS NULL
),
-- Uang muka yang masih hidup: penyelesaiannya resolve pada tanggal berangkatnya sendiri, yang
-- boleh berada di masa lalu dan boleh menyebut klasifikasi yang sejak itu sudah ditutup.
live_advance AS (
  SELECT advance.id::text AS advance_id, advance.employee_id, trip.start_on
    FROM trip_advances advance
    JOIN business_trip_requests trip ON trip.id = advance.business_trip_id
   WHERE advance.status NOT IN ('SETTLED', 'REJECTED', 'CANCELLED')
),
subject AS (
  SELECT 'EMPLOYEE' AS kind, eligible.id AS employee_id, current_date AS on_date,
         eligible.employee_number AS label
    FROM eligible
  UNION ALL
  SELECT 'ADVANCE', live_advance.employee_id, live_advance.start_on,
         live_advance.advance_id || ' berangkat ' || to_char(live_advance.start_on, 'YYYY-MM-DD')
    FROM live_advance
),
-- Subjek yang resolve ke tanpa golongan. Sama persis dengan bindingsOn() lalu pencocokan ke
-- trip_per_diem_golongan_map: penempatan yang dibatalkan tidak dihitung, kursi harus benar
-- berlaku pada tanggal itu, dan struktur dibaca dari change set yang terbit untuk tanggal itu.
unresolved AS (
  SELECT subject.kind, subject.label
    FROM subject
   WHERE NOT EXISTS (
     SELECT 1
       FROM employments employment
       JOIN employment_placements placement
         ON placement.employment_id = employment.id
        AND placement.voided_by_action_id IS NULL
        AND placement.effective_from <= subject.on_date
        AND (placement.effective_to IS NULL OR placement.effective_to >= subject.on_date)
       LEFT JOIN LATERAL (
         SELECT change_set.id
           FROM organization_change_sets change_set
          WHERE change_set.status = 'PUBLISHED' AND change_set.effective_on <= subject.on_date
          ORDER BY change_set.effective_on DESC, change_set.published_at DESC,
                   change_set.created_at DESC, change_set.id DESC
          LIMIT 1
       ) effective_change_set ON true
       LEFT JOIN organization_positions position_row
         ON position_row.change_set_id = effective_change_set.id
        AND position_row.stable_key = placement.org_position_key
        AND position_row.active
        AND position_row.effective_from <= subject.on_date
        AND (position_row.effective_to IS NULL OR position_row.effective_to >= subject.on_date)
       JOIN trip_per_diem_golongan_map map
         ON map.job_classification_code
            = COALESCE(placement.job_classification_code, position_row.job_classification_code)
      WHERE employment.employee_id = subject.employee_id
        AND employment.voided_by_action_id IS NULL
        AND (employment.started_on IS NULL OR employment.started_on <= subject.on_date)
        AND (employment.ended_on IS NULL OR employment.ended_on >= subject.on_date))
),
classification_today AS (
  SELECT classification.code
    FROM job_classifications classification
   WHERE classification.active
     AND classification.effective_from <= current_date
     AND (classification.effective_to IS NULL OR classification.effective_to >= current_date)
),
-- Katalog yang sudah terbit untuk tanggal di depan. Belum memutus apa pun hari ini, jadi hanya
-- WARN; akan memutus pada tanggalnya bila tidak dipetakan lebih dulu.
classification_future AS (
  SELECT classification.code, classification.effective_from
    FROM job_classifications classification
   WHERE classification.active AND classification.effective_from > current_date
),
finding AS (
  -- A. Katalog klasifikasi jabatan kosong. Nol baris pada pemeriksaan B dulu terbaca
  -- "semuanya terpetakan", padahal artinya tidak seorang pun dapat memperoleh golongan.
  SELECT 1 AS ord, 'FAIL' AS severity, 'CATALOGUE_EMPTY' AS kind,
         'tidak ada klasifikasi jabatan ORG-011 yang berlaku hari ini; tidak seorang pegawai pun dapat memperoleh golongan' AS detail
   WHERE NOT EXISTS (SELECT 1 FROM classification_today)
  UNION ALL
  -- B. Klasifikasi yang berlaku hari ini tetapi belum dipetakan. Ini daftar yang sama dengan
  -- "Belum dipetakan" pada layar Admin, dan pegawai pertama yang ditempatkan di sana langsung 409.
  SELECT 2, 'FAIL', 'CLASSIFICATION_UNMAPPED', classification_today.code
    FROM classification_today
   WHERE NOT EXISTS (SELECT 1 FROM trip_per_diem_golongan_map map
                      WHERE map.job_classification_code = classification_today.code)
  UNION ALL
  -- C. Dari orangnya: pegawai berhak yang hari ini tidak memperoleh golongan sama sekali,
  -- termasuk yang tidak punya satu pun ikatan klasifikasi sehingga tidak terlihat dari katalog.
  SELECT 3, 'FAIL', 'EMPLOYEE_UNRESOLVED', unresolved.label
    FROM unresolved WHERE unresolved.kind = 'EMPLOYEE'
  UNION ALL
  -- D. Uang muka yang masih hidup, pada tanggal berangkatnya sendiri.
  SELECT 4, 'FAIL', 'ADVANCE_UNRESOLVED', unresolved.label
    FROM unresolved WHERE unresolved.kind = 'ADVANCE'
  UNION ALL
  SELECT 5, 'WARN', 'CLASSIFICATION_UNMAPPED_FUTURE',
         classification_future.code || ' berlaku ' || to_char(classification_future.effective_from, 'YYYY-MM-DD')
    FROM classification_future
   WHERE NOT EXISTS (SELECT 1 FROM trip_per_diem_golongan_map map
                      WHERE map.job_classification_code = classification_future.code)
),
-- Daftar dipotong pada 20 baris per jenis: pemetaan yang masih kosong akan menyebut setiap
-- pegawai, dan bukti rilis tidak perlu memuat seluruh daftar pegawai.
ranked AS (
  SELECT finding.ord, finding.severity, finding.kind, finding.detail,
         row_number() OVER (PARTITION BY finding.ord ORDER BY finding.detail) AS seq,
         count(*) OVER (PARTITION BY finding.ord) AS total
    FROM finding
)
-- Baris sentinel. Tanpa ini, keluaran kosong karena kueri gagal tidak dapat dibedakan dari
-- keluaran kosong karena semuanya beres, dan gerbang akan mencetak hijau justru ketika ia
-- tidak tahu apa-apa.
SELECT 'OK|GATE|kueri golongan TRIP-002 dijawab'
UNION ALL
SELECT ranked.severity || '|' || ranked.kind || '|' || ranked.detail
  FROM ranked WHERE ranked.seq <= 20
UNION ALL
SELECT ranked.severity || '|' || ranked.kind || '|dan ' || (ranked.total - 20)::text || ' lagi'
  FROM ranked WHERE ranked.seq = 20 AND ranked.total > 20
ORDER BY 1;
