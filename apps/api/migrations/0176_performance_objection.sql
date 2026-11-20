-- PERF-001 Paket 2b (keputusan owner 18 Nov 2026, C5): jalur keberatan pegawai sebelum
-- hasil penilaian disahkan Human Capital.
-- Spec: docs/domain/performance-review.md §4 (D-17), §7.11, §12.
--
-- Hari ini nilai akhir datang dari penilai saja, dan setelah HC mengesahkan pegawai hanya
-- dapat menulis tanggapan yang tidak mengubah apa pun (D-09). D-17 menambah satu kesempatan
-- **sebelum** pengesahan: pegawai melihat nilai penilai, lalu boleh mengajukan keberatan
-- sekali, dengan alasan, dalam masa keberatan yang terbatas.
--
-- Satu penilaian hanya punya satu keberatan, dan satu pegawai hanya punya satu penilaian per
-- siklus, jadi "tidak boleh dua kali untuk satu siklus" didapat dari kolom di baris penilaian
-- tanpa tabel baru dan tanpa indeks unik tambahan. Bentuknya sama dengan tanda dibaca
-- (`acknowledged_at`), yang juga atribut penilaian, bukan state tersendiri.
--
-- Tidak ada permission baru: keberatan diajukan pemilik penilaian (kepemilikan sesi, bukan
-- permission) dan diputuskan `performance.manage` yang sudah ada.
--
-- Deploy aman tanpa urutan khusus: semua kolom nullable dan penilaian yang sudah berjalan
-- tidak punya masa keberatan (`objection_due_on` NULL), jadi tidak ada satu pun pengesahan
-- yang tertahan saat migrasi ini terpasang.
--
-- Down:
--   DROP INDEX IF EXISTS performance_reviews_objection_idx;
--   ALTER TABLE performance_reviews
--     DROP CONSTRAINT IF EXISTS performance_reviews_objection_state,
--     DROP CONSTRAINT IF EXISTS performance_reviews_objection_decision,
--     DROP COLUMN IF EXISTS objection_due_on,
--     DROP COLUMN IF EXISTS objection_raised_at,
--     DROP COLUMN IF EXISTS objection_reason,
--     DROP COLUMN IF EXISTS objection_status,
--     DROP COLUMN IF EXISTS objection_decided_at,
--     DROP COLUMN IF EXISTS objection_decided_by_account_id,
--     DROP COLUMN IF EXISTS objection_decision_reason;

SET LOCAL lock_timeout = '5s';

ALTER TABLE performance_reviews
  -- Batas akhir masa keberatan, diisi saat penilai mengirim nilai, yaitu hari pertama pegawai
  -- dapat melihatnya. NULL pada penilaian yang dinilai sebelum migrasi ini.
  ADD COLUMN IF NOT EXISTS objection_due_on date NULL,
  -- Kapan pegawai bersikap: mengajukan keberatan, atau menutup masa keberatannya sendiri.
  ADD COLUMN IF NOT EXISTS objection_raised_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS objection_reason text NULL
    CHECK (objection_reason IS NULL OR char_length(objection_reason) BETWEEN 10 AND 1000),
  -- WAIVED: pegawai menerima nilainya tanpa keberatan, sehingga HC tidak perlu menunggu masa
  -- keberatan habis. UPHELD: keberatan diterima, penilaian kembali ke penilai (D-07 — HC tidak
  -- pernah mengetik nilai pengganti). REJECTED: ditolak dengan alasan, nilai tetap.
  ADD COLUMN IF NOT EXISTS objection_status text NULL
    CHECK (objection_status IS NULL OR objection_status IN ('OPEN', 'UPHELD', 'REJECTED', 'WAIVED')),
  ADD COLUMN IF NOT EXISTS objection_decided_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS objection_decided_by_account_id uuid NULL REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS objection_decision_reason text NULL
    CHECK (objection_decision_reason IS NULL OR char_length(objection_decision_reason) BETWEEN 10 AND 1000);

ALTER TABLE performance_reviews
  DROP CONSTRAINT IF EXISTS performance_reviews_objection_state,
  DROP CONSTRAINT IF EXISTS performance_reviews_objection_decision;

ALTER TABLE performance_reviews
  -- Keberatan ada atau tidak ada seluruhnya. Menutup masa keberatan bukan keberatan, jadi
  -- tanpa alasan; mengajukan keberatan selalu dengan alasan.
  ADD CONSTRAINT performance_reviews_objection_state CHECK (
    (objection_status IS NULL AND objection_raised_at IS NULL AND objection_reason IS NULL)
    OR (objection_status = 'WAIVED' AND objection_raised_at IS NOT NULL AND objection_reason IS NULL)
    OR (objection_status IN ('OPEN', 'UPHELD', 'REJECTED')
        AND objection_raised_at IS NOT NULL AND objection_reason IS NOT NULL)
  ),
  -- Diputuskan HC tepat ketika keberatan selesai di tangan HC, dan tidak pernah tanpa alasan.
  ADD CONSTRAINT performance_reviews_objection_decision CHECK (
    (objection_status IN ('UPHELD', 'REJECTED'))
      = (objection_decided_at IS NOT NULL AND objection_decided_by_account_id IS NOT NULL
         AND objection_decision_reason IS NOT NULL)
  );

-- Rekap HC: keberatan yang masih menunggu keputusan pada satu siklus.
CREATE INDEX IF NOT EXISTS performance_reviews_objection_idx
  ON performance_reviews (cycle_id) WHERE objection_status = 'OPEN';
