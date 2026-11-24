-- TRIP-002 D-22: apakah tabel saklar uang saku sudah ada di database ini?
--
-- Dipisah dari kueri keadaannya karena PostgreSQL menolak kueri yang menyebut tabel yang belum
-- ada pada waktu parse, bukan pada waktu jalan. Jadi keberadaannya ditanyakan lewat katalog
-- dulu, baru keadaannya dibaca. Keduanya aman dijalankan pada dry run sebelum migrate.
--
-- Batas sintaksis sama dengan berkas gerbang lain: tanpa tanda kutip ganda, backslash, tanda
-- dolar, atau backtick, karena teksnya diratakan dan menumpang di dalam kutip ganda bersusun.
--
-- Keluaran: satu baris sentinel.
--   OK|TABLE|ABSENT   belum ada (0183 belum jalan) -> fitur uang saku mustahil aktif
--   OK|TABLE|PRESENT  ada -> keadaannya dibaca oleh trip-002-activation-state.sql
SELECT 'OK|TABLE|' || CASE WHEN to_regclass('trip_per_diem_activation') IS NULL
                           THEN 'ABSENT' ELSE 'PRESENT' END;
