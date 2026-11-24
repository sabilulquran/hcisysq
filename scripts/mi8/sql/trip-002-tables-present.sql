-- TRIP-002: tabel mana yang sudah ada di database ini?
--
-- Dipisah dari kueri isinya karena PostgreSQL menolak kueri yang menyebut tabel yang belum ada
-- pada waktu parse, bukan pada waktu jalan. Jadi keberadaannya ditanyakan lewat katalog dulu,
-- baru isinya dibaca. Aman dijalankan pada dry run sebelum migrate.
--
-- Batas sintaksis sama dengan berkas gerbang lain: tanpa tanda kutip ganda, backslash, tanda
-- dolar, atau backtick, karena teksnya diratakan dan menumpang di dalam kutip ganda bersusun.
--
-- Keluaran: satu baris sentinel, OK|TABLES|<peta>|<saklar>, masing-masing ABSENT atau PRESENT.
--   peta    trip_per_diem_golongan_map (dibuat migrasi 0172)
--   saklar  trip_per_diem_activation   (dibuat migrasi 0183)
SELECT 'OK|TABLES|'
       || CASE WHEN to_regclass('trip_per_diem_golongan_map') IS NULL THEN 'ABSENT' ELSE 'PRESENT' END
       || '|'
       || CASE WHEN to_regclass('trip_per_diem_activation') IS NULL THEN 'ABSENT' ELSE 'PRESENT' END;
