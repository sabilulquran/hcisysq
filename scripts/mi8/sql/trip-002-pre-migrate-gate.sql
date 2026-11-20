-- TRIP-002 D-02 release gate, bagian sebelum migrate (scripts/mi8/release-mi8.sh).
--
-- Migrasi 0172_trip_per_diem_decree.sql berhenti bila trip_per_diem_rates masih berisi tarif
-- zona DRAFT: tarif itu tidak punya golongan dan tidak seorang pun boleh menebaknya. Gerbang
-- memakai hitungan ini untuk berhenti sebelum rilis gagal di tengah jalan.
--
-- Satu baris keluaran: cacah baris tarif (psql -At).
SELECT count(*)::text FROM trip_per_diem_rates;
