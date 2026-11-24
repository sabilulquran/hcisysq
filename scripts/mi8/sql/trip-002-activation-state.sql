-- TRIP-002 D-22: keadaan saklar uang saku yang sedang berlaku.
--
-- Barisan ini hanya ditambahi, jadi yang berlaku adalah baris terakhir; tabel kosong berarti
-- belum pernah dinyalakan, yaitu INACTIVE. Sama persis dengan perDiemActivation() di
-- apps/api/src/modules/trip-advances/activation.ts.
--
-- Hanya dijalankan setelah trip-002-activation-present.sql menjawab PRESENT.
--
-- Keluaran: satu baris sentinel, OK|STATE|ACTIVE atau OK|STATE|INACTIVE.
SELECT 'OK|STATE|' || COALESCE((SELECT activation.state FROM trip_per_diem_activation activation
                                 ORDER BY activation.recorded_seq DESC LIMIT 1),
                               'INACTIVE');
