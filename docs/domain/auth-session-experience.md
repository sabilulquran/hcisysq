> **RETIRED / ARCHIVED — DO NOT DEPLOY — DO NOT RECREATE.** Staging references and staging commands in this document are historical evidence. The production VPS is production-only by owner decision of 2 October 2026. See the permanent-retirement runbook; historical staging instructions do not authorize deployment.

# Shared Identity Session Experience

**Status:** ACCEPTED  
**Specification:** AUTH-003 — Shared Identity Session Experience  
**Related:** AUTH-001, AUTH-002, AUTH-010, AUTH-012, AUTH-013, `HUB-IMPL-003`

Dokumen ini menetapkan pengalaman sesi/account HCIS setelah autentikasi Staff dipindahkan ke SQ Identity. Scope ini tidak memindahkan business authorization HCIS ke platform dan tidak menjadikan HCIS pemilik credential global.

## Actor dan tujuan

Actor utama adalah pegawai yang sudah memiliki sesi HCIS valid melalui SQ Identity.

Tujuan pengguna:

- dapat menemukan identitas account yang sedang digunakan dari shell HCIS;
- memiliki jalur `Keluar` yang jelas di desktop maupun mobile;
- mendapat pesan yang membedakan kegagalan autentikasi SQ Identity dari penolakan/ketidaktersediaan Application Access;
- melihat affordance `Akun Saya` tanpa membuat HCIS menjadi pemilik password, MFA, recovery, atau security settings bersama.

## Precondition

- HCIS berjalan pada `AUTH_MODE=oidc` untuk alur SQ Identity, atau pada local mode untuk compatibility path yang masih berlaku;
- sesi aplikasi tetap memakai cookie server-side `hcis_session`;
- Application Access tetap diperiksa pada pembuatan sesi baru sesuai `HUB-IMPL-003`, bukan pada setiap request aplikasi;
- domain role/permission HCIS tetap ditentukan HCIS.

## Account menu

Shell pegawai menampilkan account menu dari dua affordance desktop yang konsisten:

1. profile/avatar di kanan atas;
2. user card di bagian bawah sidebar.

Pada mobile, profile/avatar di header tetap terlihat dan membuka menu yang sama. Mobile tidak boleh bergantung pada sidebar desktop untuk keluar.

Menu minimum:

- nama dan konteks jabatan/unit yang sudah tersedia di shell;
- `Akun Saya`;
- `Keluar`.

### `Akun Saya`

`Akun Saya` adalah affordance menuju shared **SQ Account Center**, bukan halaman pengelolaan credential lokal HCIS.

Sampai SQ Account Center memiliki URL yang benar-benar tersedia pada environment tersebut, item tetap terlihat sebagai target platform tetapi disabled/berstatus `Segera`. HCIS tidak boleh membuat halaman password/MFA/recovery lokal hanya untuk mengisi kekosongan ini.

Ketika target platform tersedia pada milestone berikutnya, item dapat menjadi deep-link tanpa mengubah ownership credential.

## Logout

`Keluar` memanggil kontrak resmi `POST /auth/logout`.

Perilaku:

- HCIS selalu menghapus sesi lokal dan cookie sesi;
- local-auth compatibility path kembali ke entry HCIS setelah sesi dihapus;
- OIDC path mengikuti `logoutUrl` yang dibentuk backend untuk RP-initiated logout SQ Identity;
- UI tidak melakukan redirect lokal kedua yang dapat menimpa redirect end-session;
- tombol menunjukkan progress dan tidak dapat dipicu berulang selama request berjalan;
- bila request logout gagal sebelum redirect, user mendapat error generik yang dapat dicoba ulang.

Keycloak meminta konfirmasi logout ("Keluar dari Akun SQ?") bila RP-initiated logout tidak membawa `id_token_hint`. Halaman itu kedaluwarsa setelah beberapa menit; pada Keycloak 26.7.2 konfirmasi basi menghasilkan "Log keluar gagal", dan bila form yang sama dikirim ulang (misalnya setelah Back) Keycloak mengembalikan internal server error (temuan owner 2026-10-18). UI tetap tidak menyembunyikan konfirmasi dengan CSS/JS. Kontrak RP-initiated logout kini:

- saat callback OIDC berhasil, backend menyimpan ID token Akun SQ di cookie `hcis_oidc_id_token` (HttpOnly, SameSite=Lax, Secure di production, umur sama dengan sesi). Token tidak disimpan di database, localStorage, atau log;
- `POST /auth/logout` mengirim token itu sebagai `id_token_hint` bersama `client_id` dan `post_logout_redirect_uri`, lalu menghapus cookie sesi dan cookie ID token. Keycloak memverifikasi tanda tangan hint dan langsung memutus SSO tanpa halaman konfirmasi, jadi terminasi SSO tetap terjadi;
- bila HCIS tidak memegang ID token (misalnya login ditolak HCIS sehingga tidak ada sesi, atau cookie tidak berbentuk JWS), `logoutUrl` tetap dibentuk tanpa hint dan Keycloak menampilkan konfirmasinya.

## OIDC callback failure UX

Backend tetap menjadi sumber klasifikasi failure. Callback tidak boleh menaruh token, authorization code, issuer subject, atau detail internal pada URL browser.

Setelah callback gagal, route hanya meneruskan kategori aman berikut ke login page:

| Backend outcome | Browser category | Pesan pengguna |
| --- | --- | --- |
| `HCIS_ACCESS_DENIED` | `access_denied` | Identitas berhasil dikenali, tetapi account belum mendapat akses HCIS. |
| `APPLICATION_ACCESS_UNAVAILABLE` | `access_unavailable` | Hak akses belum dapat diverifikasi; user diminta mencoba lagi. |
| `ACCOUNT_INACTIVE` | `account_inactive` | Account HCIS sedang tidak aktif; user diarahkan ke Human Capital bila perlu diperiksa. |
| semua callback/mapping/provider failure lain | `oidc_failed` | Kegagalan masuk SQ Identity generik tanpa detail sensitif. |

`OIDC_ACCOUNT_NOT_MAPPED`, invalid/expired state, token-validation failure, provider error, dan unexpected error tidak dibedakan di URL browser.

## AUTH-012 — Masuk langsung ke Akun SQ

**Status:** ACCEPTED (owner, 2026-10-21)

Pada `AUTH_MODE=oidc`, halaman perantara "Masuk dengan Akun SQ" tidak lagi ditampilkan bila tidak ada kegagalan sebelumnya. Keycloak (realm `sq-staff`) sudah meneruskan tanpa interaksi bila sesi SSO Akun SQ masih aktif, sehingga HCIS cukup langsung membuka route start.

- Actor: pengunjung tanpa sesi HCIS yang membuka `/` atau route terlindungi.
- Flow: route terlindungi mengarahkan ke `/?returnTo=<path>`; login entry memeriksa `/auth/mode`, lalu `window.location.replace("/api/auth/oidc/start?returnTo=<path>")`. Selama itu hanya tampil status netral "Membuka Akun SQ…", bukan halaman hero.
- `returnTo` hanya path same-origin yang diawali satu `/` (maksimal 512 karakter); `//`, backslash, scheme, karakter kontrol, serta path `/api/*` dan `/auth/*` ditolak. API memvalidasi ulang, menyimpannya di baris `auth_oidc_transactions.return_to` (migration `0060`), dan callback sukses mengarah ke nilai dari transaksi itu, tidak pernah dari query callback. Nilai tidak aman diabaikan dan login tetap berjalan ke `/`.
- Failure: bila ada query `authError` (nilai apa pun), login entry tidak memulai ulang otomatis supaya tidak terjadi loop; pesan kategori di atas tetap tampil dengan tombol "Masuk dengan Akun SQ" sebagai percobaan ulang (membawa `returnTo` bila ada). Gagal memuat mode tetap fail closed.
- Tidak ada `prompt=none`, direct grant/ROPC, atau form kata sandi. Local mode tetap memakai `LoginForm`.
- Audit: tidak ada event baru; event OIDC yang ada tetap berlaku.

## AUTH-013 — Peluncur aplikasi bersama

**Status:** ACCEPTED (owner, 2026-10-23; kontrak peluncur SQ Core yang sama untuk HCIS, Aset, Karir staf, SPMB staf)

Peluncur di header (ikon titik 3×3) menampilkan daftar yang sama dengan peluncur SQ Hub: baris SQ Hub ("Beranda semua aplikasi Anda", ke `https://hub.sabilulquran.or.id/`), lalu "Aplikasi Anda" berupa grid 3 kolom dengan ikon/warna kategori yang sama dengan SQ Hub (`applicationAppearance`, tabel SQ Hub HUB-IMPL-022 §6: `hcis` → UsersRound/attendance, `aset-sq` → Boxes/service, `karir-sq` → BriefcaseBusiness/task, `spmb-sq` → GraduationCap/leave, `kirim-sq` → MessageCircle/pay, lainnya → PanelsTopLeft/brand), HCIS ditandai "Di sini", dan tautan "Lihat semua aplikasi" ke `https://hub.sabilulquran.or.id/apps`. Referensi desain: SQ Hub `docs/design/sq-core-app-shell.md` item 4 ("same in every app").

- Actor: principal dengan sesi HCIS (`hcis_session`).
- Flow: SPA memanggil `GET /api/auth/launcher` (same-origin, satu kali per muat halaman, maksimal tiap 5 menit). API memvalidasi sesi, membaca `accounts.identity_issuer`/`identity_subject` milik akun sesi, lalu memanggil SQ Hub `POST /internal/v1/application-access/launcher` server-to-server dengan body `{"identity":{"issuer","subject"}}` dan token `client_credentials` dari machine client yang sama dengan Application Access check (`SQ_HUB_MACHINE_CLIENT_ID`). Browser tidak pernah memanggil SQ Hub dan tidak menerima token.
- URL SQ Hub diturunkan dari `SQ_HUB_APPLICATION_ACCESS_URL` (`.../application-access/check` → `.../application-access/launcher`); `SQ_HUB_APPLICATION_LAUNCHER_URL` opsional sebagai override. Tidak ada env baru yang wajib.
- Respons: `{"applications":[{key,name,canonicalUrl}]}` (SQ Hub sendiri tidak termasuk; hanya link `https:`/`http:` yang diteruskan) atau `{"applications":null,"unavailable":true}`. `Cache-Control: no-store`. Tanpa sesi: `401 UNAUTHENTICATED`.
- Cache: per sesi HCIS (kunci = hash token sesi yang sudah disimpan, bukan token mentah) di memori proses API selama 5 menit; kegagalan disimpan 30 detik supaya SQ Hub tidak dipanggil pada setiap muat halaman. Maksimal 2.000 entri. Restart API mengosongkan cache.
- Failure: timeout 5 detik, HTTP non-2xx, respons tidak valid, URL tidak dapat diturunkan, akun tanpa identitas tersimpan, atau `AUTH_MODE=local` → `unavailable`. Web lalu menampilkan hanya tile HCIS seperti sebelumnya; daftar kosong dari SQ Hub juga menampilkan tile HCIS saja. Bila HCIS tidak ada di daftar SQ Hub, tile HCIS tetap ditampilkan dengan tanda "Di sini". Tile HCIS selalu menuju `/app`.
- Permission: tidak ada capability baru; daftar hanya navigasi. Akses ke aplikasi lain tetap diputuskan oleh aplikasi tersebut dan SQ Hub.
- Audit/log: tidak ada audit event baru (membaca daftar bukan security event). Issuer, subject, dan token tidak ditulis ke log.
- Local mode: perilaku lama (hanya tile HCIS) tetap berlaku.

## Pengikatan login ke browser dan penolakan mutasi lintas situs (SEC-05, SEC-06)

Bagian dari temuan security review `SEC-REV-2026-10-16`.

**SEC-05 — callback hanya diterima di browser yang memulai login.**

- `/auth/oidc/start` memasang satu cookie per percobaan login: nama `__Host-hcis_oidc_state_<32 hex pertama sha256(state)>` (tanpa prefiks `__Host-` bila cookie tidak Secure, yaitu di luar production), nilai `1`, `Path=/; HttpOnly; SameSite=Lax`, umur sama dengan transaksi OIDC (10 menit). Nama per state membuat beberapa tab bisa login bersamaan; prefiks `__Host-` mencegah subdomain saudara menanam cookie ini.
- `/auth/callback` meneruskan ke `OidcLoginService.complete` fungsi pemeriksa yang wajib: tanpa cookie untuk state tersebut, callback ditolak (`OIDC_CALLBACK_UNBOUND`, audit `auth.oidc.callback.invalid`) **sebelum** transaksi dipakai, sehingga browser yang sah masih bisa menyelesaikannya. URL browser hanya menerima kategori `oidc_failed`.
- Cookie state dihapus pada setiap respons callback, sukses maupun gagal.
- Kasus yang dicegah: penyerang mengirim tautan callback dari login miliknya sendiri, sehingga korban masuk ke akun penyerang (login CSRF).

**SEC-06 — mutasi lintas situs ditolak.**

- Hook `onRequest` untuk `POST`, `PUT`, `PATCH`, `DELETE` (kecuali ingress perangkat `/iclock/*`): bila browser mengirim `Sec-Fetch-Site`, hanya `same-origin` dan `none` yang diterima; `same-site` (aplikasi SQ Core lain di domain yayasan) dan `cross-site` ditolak `403 CROSS_SITE_REQUEST_REJECTED`.
- Browser lama tanpa `Sec-Fetch-Site`: `Origin` harus sama dengan origin publik HCIS (diambil dari `OIDC_REDIRECT_URI`). Pada local mode origin publik tidak dikenal, sehingga hanya `Sec-Fetch-Site` yang diperiksa.
- Klien tanpa `Sec-Fetch-Site` dan tanpa `Origin` (perangkat, token mesin, skrip) tidak membawa risiko cookie browser dan tetap diterima; route-nya tetap dijaga autentikasi masing-masing.
- Frontend tidak berubah: SPA memanggil `/api` dari origin yang sama.

## Permission dan authorization

Account menu tidak memberikan capability baru. Menampilkan `Akun Saya` atau `Keluar` tidak mengubah role, scope, Application Access, maupun permission domain.

Logout dapat dilakukan oleh setiap principal yang memiliki sesi. Semua backend route lain tetap melakukan authorization seperti sebelumnya.

## Audit

AUTH-003 memakai audit auth yang sudah ada:

- logout tetap menghasilkan audit sesi melalui `AuthService.logout`;
- Application Access denied/unavailable dan account inactive tetap memakai event OIDC yang sudah ada;
- UI menu open/close bukan security event dan tidak perlu audit baru.

Tidak ada token, password, ID token, recovery code, authorization code, atau `logoutUrl` penuh yang ditulis ke audit/log aplikasi.

## Failure behavior

- gagal memuat auth mode tetap fail closed dan tidak menampilkan fallback password pada OIDC environment;
- kategori OIDC yang tidak dikenal selalu menjadi `oidc_failed`;
- logout failure tidak menghapus/mengarang state di frontend; user dapat mencoba ulang;
- tidak tersedianya SQ Account Center tidak boleh mengarah ke URL palsu atau halaman credential HCIS.

## Notification

Tidak ada notifikasi out-of-band untuk menu account, login failure, atau logout pada scope AUTH-003.

## Acceptance criteria

- AUTH-003-A: top-right profile pegawai membuka account menu pada desktop.
- AUTH-003-B: sidebar user card membuka account menu yang sama pada desktop.
- AUTH-003-C: mobile header memiliki jalur account/logout yang dapat digunakan tanpa sidebar.
- AUTH-003-D: `Akun Saya` tidak mengelola password/MFA/recovery di HCIS dan tidak mengarah ke URL platform yang belum tersedia.
- AUTH-003-E: `Keluar` memakai endpoint logout resmi, menghapus sesi HCIS, lalu mengikuti SQ Identity end-session pada OIDC mode tanpa redirect lokal yang menimpa flow tersebut.
- AUTH-003-F: `HCIS_ACCESS_DENIED`, `APPLICATION_ACCESS_UNAVAILABLE`, dan `ACCOUNT_INACTIVE` mendapat copy yang berbeda dari kegagalan OIDC teknis; error lainnya tetap generik.
- AUTH-003-G: browser URL/log tidak menerima token, subject, authorization code, atau detail internal sebagai bagian dari error classification.
- AUTH-003-H: existing-session, Application Access timing, issuer, dan domain authorization semantics dari `HUB-IMPL-003` tidak berubah.
- AUTH-003-I: UI account menu memiliki keyboard focus yang terlihat, `aria-expanded`/`aria-haspopup`, Escape-to-close, dan tidak mengalami horizontal overflow pada mobile.

## Dependency dan migration impact

- AUTH-003 tidak membutuhkan database migration; AUTH-012 menambah kolom nullable `auth_oidc_transactions.return_to` (`0060_oidc_transaction_return_to.sql`, aditif, rollback `DROP COLUMN IF EXISTS return_to`);
- AUTH-013 tidak membutuhkan database migration (memakai kolom `accounts.identity_issuer`/`identity_subject` yang sudah ada) dan bergantung pada endpoint SQ Hub `/internal/v1/application-access/launcher`; sebelum endpoint itu live, peluncur tetap menampilkan tile HCIS saja. Rollback: revert commit, tanpa langkah data;
- bergantung pada kontrak `/auth/logout` dan error `AuthError` yang sudah ada;
- SQ Account Center adalah dependency platform masa depan, bukan blocker logout/account menu;
- perubahan runtime harus diverifikasi pada staging OIDC sebelum merge/cutover lebih lanjut.
