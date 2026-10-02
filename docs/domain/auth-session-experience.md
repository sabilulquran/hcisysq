> **RETIRED / ARCHIVED — DO NOT DEPLOY — DO NOT RECREATE.** Staging references and staging commands in this document are historical evidence. The production VPS is production-only by owner decision of 2 October 2026. See the permanent-retirement runbook; historical staging instructions do not authorize deployment.

# Shared Identity Session Experience

**Status:** ACCEPTED  
**Specification:** AUTH-003 — Shared Identity Session Experience  
**Related:** AUTH-001, AUTH-002, AUTH-010, `HUB-IMPL-003`

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

Keycloak saat ini dapat meminta konfirmasi logout sebelum SSO benar-benar diputus. AUTH-003 tidak menyembunyikan atau melewati konfirmasi tersebut dengan CSS/JS. Penghilangan konfirmasi kedua memerlukan perubahan kontrak RP-initiated logout yang dinilai terpisah dan harus tetap menjaga terminasi SSO.

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

- tidak ada database migration;
- bergantung pada kontrak `/auth/logout` dan error `AuthError` yang sudah ada;
- SQ Account Center adalah dependency platform masa depan, bukan blocker logout/account menu;
- perubahan runtime harus diverifikasi pada staging OIDC sebelum merge/cutover lebih lanjut.
