-- LOAN-002 F-1: satu kursi persetujuan hanya boleh punya satu pemetaan yang berlaku pada satu
-- tanggal. Spec: docs/domain/employee-loans.md §16.7.
--
-- Migrasi 0177 menjaga satu baris **terbuka** per kursi dengan indeks unik parsial. Itu cukup
-- selama pemetaan hanya ditulis lewat SQL oleh satu orang yang berhati-hati. Begitu Human Capital
-- dapat mengakhiri dan membuat pemetaan sendiri lewat layar, dua baris yang sudah **tertutup**
-- dengan periode beririsan menjadi kemungkinan nyata, dan `loadApprovalSeatMappings` akan memilih
-- salah satunya secara non-deterministik — artinya rantai kasbon yang sama dapat menunjuk jabatan
-- berbeda pada dua pembacaan. Database yang menolaknya, bukan route.
--
-- Periodenya setengah terbuka: [effective_from, effective_to + 1). Pemetaan yang diakhiri pada
-- effective_from - 1 ("tidak pernah berlaku") menghasilkan rentang kosong, yang menurut definisi
-- tidak beririsan dengan apa pun — jadi aturan itu tetap dapat dipakai.
--
-- Aditif dan tidak menulis ulang baris mana pun. Produksi belum punya satu pun baris kursi
-- (0177 sengaja tidak menyemai apa pun), sehingga constraint ini pasti terpasang.
--
-- Rollback:
--   ALTER TABLE organization_approval_seats DROP CONSTRAINT organization_approval_seats_no_overlap;
--
-- Idempotent: menjalankan ulang tidak mengubah apa pun lagi.

-- Dipakai untuk menggabungkan kesamaan (seat_key) dengan irisan rentang dalam satu indeks GiST.
-- Sudah dipasang migrasi 0021 dan 0056; di sana ini no-op.
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_approval_seats_no_overlap'
  ) THEN
    ALTER TABLE organization_approval_seats
      ADD CONSTRAINT organization_approval_seats_no_overlap
      EXCLUDE USING gist (
        seat_key WITH =,
        daterange(
          effective_from,
          COALESCE(effective_to + 1, 'infinity'::date),
          '[)'
        ) WITH &&
      );
  END IF;
END $$;
