# ATT-004 — ADMS Admin UI & Live Readiness

**Status:** IMPLEMENTED — ACCESS MODEL UPDATED 2026-09-21

## Tujuan

Menyediakan surface operasional native HCIS untuk meregistrasi mesin fingerprint ADMS, memetakan PIN ke employee, memantau raw event/quarantine, dan menyiapkan ingress deployment tanpa bergantung pada UI atau runtime RuangHadir.

ATT-004 memakai ATT-002 sebagai raw transport foundation dan ATT-003 sebagai mapping/projection foundation. Tidak ada biometric/template sync atau remote device command pada milestone ini.

## Actor

Akses perangkat memakai permission backend, bukan label jabatan di UI.

- `SUPER_ADMIN` compatibility tetap memiliki capability ADMS yang tercantum pada `ADMIN_PERMISSIONS`.
- `human_capital_admin` organization-wide menerima capability operasional non-destruktif:
  - `attendance.devices.read`;
  - `attendance.devices.configure`;
  - `attendance.devices.operate`;
  - `attendance.devices.export`.
- `attendance.devices.destructive`, `attendance.devices.firmware`, dan `attendance.devices.biometrics` **tidak** otomatis diberikan ke Human Capital Admin dan tetap memerlukan grant terpisah.

Human Capital operasional biasa tidak otomatis menjadi operator perangkat.

## Device registry

Device tidak pernah dibuat otomatis dari traffic. Super Admin meregistrasi serial secara eksplisit sebelum device diizinkan menghasilkan raw attendance event accepted.

Field operasional:

- serial number;
- display name opsional;
- lifecycle `active | disabled | quarantined`;
- timezone IANA, default `Asia/Jakarta`;
- model/firmware bila tersedia dari administrasi/manual discovery;
- first/last seen, last successful request, last IP sebagai observability evidence.

Perubahan registry/lifecycle menghasilkan immutable admin audit event.

## PIN mapping

UI menampilkan PIN yang benar-benar pernah terlihat pada raw ATTLOG. Super Admin memilih employee dan effective start secara eksplisit.

Default UI untuk mapping baru adalah awal hari berjalan `Asia/Jakarta`, agar punch pertama hari itu dapat segera diproyeksikan setelah mapping dikonfirmasi. API membatasi backfill mapping baru maksimum 62 hari dan tidak mengizinkan effective start jauh di masa depan.

Setelah mapping berhasil dibuat, HCIS melakukan bounded re-projection untuk raw event yang termasuk effective window tersebut. Ini adalah aksi eksplisit akibat mapping admin, bukan auto-guess `PIN = employee_number`.

Mengakhiri mapping berarti menutup mapping aktif pada waktu server saat aksi dilakukan; row mapping tidak dihapus.

## Admin API

- `GET /admin/attendance/adms/devices`
- `POST /admin/attendance/adms/devices`
- `GET /admin/attendance/adms/devices/:deviceId`
- `PATCH /admin/attendance/adms/devices/:deviceId`
- `POST /admin/attendance/adms/devices/:deviceId/mappings`
- `DELETE /admin/attendance/adms/mappings/:mappingId`

Semua response operasional menggunakan `Cache-Control: no-store`.

Device detail memuat current mappings, observed PIN summary, recent raw events, dan recent quarantine outcomes. Raw body request tidak dikirim ke browser Admin.

## UI

Area **Admin > Kehadiran** memiliki panel **Mesin fingerprint** yang dapat:

1. meregistrasi serial mesin;
2. melihat lifecycle dan last seen;
3. memilih satu mesin;
4. melihat PIN yang sudah pernah muncul;
5. memetakan PIN ke employee aktif;
6. mengakhiri mapping aktif;
7. melihat raw event terbaru dan quarantine terbaru.

UI tidak menampilkan atau mengedit biometric template.

## Deployment contract

Production API menerima `ADMS_INGRESS_HOST=adms.sabilulquran.or.id`. Production compose meneruskan variable tersebut ke API container dan API berada pada edge network agar reverse proxy dapat meneruskan dedicated ADMS host langsung ke port API.

Tidak ada ingress ADMS staging terpisah. Staging HCIS tetap memakai konfigurasi existing tanpa ADMS hostname.

Dedicated Caddy host production harus:

- menggunakan `http://adms.sabilulquran.or.id` selama HTTPS capability firmware belum terbukti;
- meneruskan `/iclock/*` langsung ke HCIS API, bukan SPA web;
- tidak melakukan response caching;
- membatasi request body selaras dengan application cap 512 KiB;
- mempertahankan Host header agar API dapat memverifikasi `ADMS_INGRESS_HOST`;
- tidak membuka Admin API pada host machine-only tersebut sebagai surface yang disarankan.

DNS aktual dan production cutover membutuhkan human approval sesuai `AGENTS.md`.

## Production canary

Tidak ada setup staging ADMS kedua. Validasi awal dilakukan langsung pada production ingress menggunakan satu mesin terkontrol sebelum mesin lain diarahkan.

Urutannya:

1. deploy migration/API/UI production;
2. set `ADMS_INGRESS_HOST=adms.sabilulquran.or.id`, DNS, dan dedicated Caddy route;
3. register serial satu mesin canary di HCIS dalam lifecycle `active`;
4. arahkan hanya mesin tersebut ke `http://adms.sabilulquran.or.id`;
5. verifikasi options handshake, request journal, last seen, raw event dan cursor;
6. lakukan satu test punch operasional yang diizinkan;
7. map PIN secara eksplisit;
8. verifikasi `attendance_daily_records.source = integration` dan provenance `adms:*`;
9. replay/duplicate tidak menggandakan raw event atau canonical attendance;
10. baru arahkan mesin lain setelah canary production dinyatakan sehat.

## Acceptance criteria

1. Hanya principal dengan permission perangkat yang sesuai dapat membaca/mengubah registry dan mapping ADMS; Human Capital Admin mendapat bundle non-destruktif, sedangkan destructive/firmware/biometric tetap terpisah.
2. Unknown traffic tidak membuat device otomatis.
3. Device register/update dan mapping create/end mempunyai immutable audit.
4. Leading-zero PIN tetap utuh pada API/UI.
5. Mapping creation dapat memproyeksikan raw event yang termasuk effective window secara bounded.
6. Mapping end tidak menghapus histori mapping.
7. UI menampilkan loading/error/empty state dan tidak memaparkan raw request body.
8. Device detail menampilkan observed PIN, mapping, recent event, dan quarantine.
9. Dedicated production ingress host `adms.sabilulquran.or.id` dapat diproxy langsung ke API dengan `ADMS_INGRESS_HOST` yang sama.
10. Production DNS/migration/cutover tidak dilakukan tanpa human approval.
11. Typecheck, lint, test, build, migration, dan compose validation harus lulus sebelum ATT-004 dinyatakan verified.
