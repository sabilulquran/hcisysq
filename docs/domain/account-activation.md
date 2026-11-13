# Account Activation

**Status:** ACCEPTED  
**Specification:** AUTH-002 — Invited Account Activation

Dokumen ini menetapkan aktivasi account `EMPLOYEE` dan `FOUNDATION_BOARD` untuk MVP Human Capital Information System Yayasan Sabilul Qur'an.

## Tujuan

- Account non-Super Admin yang sudah disiapkan dapat benar-benar dipakai untuk login.
- Tidak membuka registrasi publik.
- Tidak meminta pengguna memilih role atau jenis account saat login/aktivasi.
- Token aktivasi tidak disimpan dalam bentuk plaintext.
- Aktivasi tidak mengubah role/scope yang sudah ditetapkan Super Admin.

## Model account

### EMPLOYEE

1. Super Admin menyiapkan account dari employee aktif dengan email login yang telah dikonfirmasi.
2. Account dibuat sebagai `invited`.
3. Super Admin menerbitkan link aktivasi sekali pakai.
4. Pegawai membuka link, membuat password, lalu account menjadi `active`.
5. Setelah login, principal `EMPLOYEE` masuk ke `/app`.

Employee yang sudah tidak aktif tidak boleh menyelesaikan aktivasi account baru.

### FOUNDATION_BOARD

1. Super Admin membuat account Organ Yayasan dengan email login.
2. Account dibuat sebagai `invited` tanpa employee palsu.
3. Aktivasi menggunakan alur token yang sama.
4. Setelah login, principal `FOUNDATION_BOARD` masuk ke `/board`.

Akun ini tetap read-only sesuai `AUTH-001` kecuali permission lain secara eksplisit ditetapkan pada milestone berikutnya.

## Token aktivasi

- Token adalah opaque random value dengan entropy minimal 256 bit.
- Database hanya menyimpan SHA-256 token.
- Plaintext token hanya dikembalikan pada respons penerbitan kepada Super Admin dan tidak masuk audit/log/database.
- Masa berlaku token: **24 jam**.
- Hanya satu token aktif per account. Penerbitan token baru mencabut token aktif sebelumnya.
- Token hanya dapat digunakan sekali.
- Token invalid, expired, revoked, atau consumed menghasilkan respons generik `ACTIVATION_LINK_INVALID`.
- Endpoint aktivasi menggunakan `Cache-Control: no-store`.
- Token tidak ditempatkan pada URL path/query request server. Link menggunakan fragment `#token=...`, sehingga fragment tidak dikirim ke reverse proxy/web server. Frontend mengirim token pada JSON request body ke endpoint aktivasi tetap.

Sampai adapter email resmi tersedia, UI Super Admin menampilkan link aktivasi satu kali agar dapat disampaikan melalui kanal internal yang sesuai. Sistem tidak mengklaim telah mengirim email.

## Password

- Panjang minimal 12 karakter dan maksimal 128 karakter.
- Password di-hash dengan primitive yang sama dengan autentikasi yang sudah ada (`scrypt`).
- Tidak ada aturan komposisi karakter yang memaksa pola tertentu.
- Password tidak pernah ditulis ke log, audit payload, atau notifikasi.

## Penyelesaian aktivasi

Penyelesaian harus atomik:

1. lock token + account;
2. validasi token masih aktif dan belum expired;
3. validasi account masih `invited`;
4. untuk `EMPLOYEE`, validasi employee masih `active`;
5. simpan password hash dan `password_changed_at`;
6. ubah status account menjadi `active`;
7. tandai token `consumed_at`;
8. revoke sesi lama account bila ada;
9. tulis audit event tanpa token/password.

Aktivasi tidak otomatis membuat role tambahan dan tidak mengubah reporting line.

## Aktivasi melalui Akun SQ (OIDC)

**Status:** decision note 2026-10-18 (gap fix, AUTH-002-OIDC). Login HCIS production memakai Akun SQ (Keycloak OIDC), sehingga account baru tidak pernah memiliki password lokal. Link aktivasi di atas hanya relevan untuk mode password lokal.

Masalah yang ditutup: account `FOUNDATION_BOARD` (Organ Yayasan non-pegawai, HUB-IMPL-021 Path B) dibuat `invited`, tetapi `PATCH /admin/access/accounts/:accountId/status` menolak `active` karena tidak ada `password_hash`, sedangkan login OIDC mensyaratkan status `active`. Akibatnya Organ Yayasan non-pegawai tidak pernah bisa memakai HCIS atau Ringkasan Yayasan.

Aturan:

1. Administrator dapat mengubah status account menjadi `active` bila account mempunyai **salah satu** metode masuk:
   - password lokal (aturan lama, tidak berubah); atau
   - identitas Akun SQ yang sudah dipetakan tepat pada `identity_issuer + identity_subject`, dengan issuer sama dengan `OIDC_ISSUER` yang dikonfigurasi HCIS.
2. Tanpa keduanya: `409 ACCOUNT_ACTIVATION_NOT_READY`. Pemetaan dari issuer lain atau saat `OIDC_ISSUER` tidak dikonfigurasi: `409 OIDC_ISSUER_MISMATCH`.
3. Untuk `EMPLOYEE` tanpa password, employee harus `active` (`409 EMPLOYEE_NOT_ACTIVE`), sama seperti aturan link aktivasi.
4. Authorization tidak berubah: perlu `access.manage`; target `FOUNDATION_BOARD` juga perlu `access.governance.manage` (Super Admin memilikinya); target `SUPER_ADMIN` dan diri sendiri tetap ditolak.
5. Audit tetap `account.status.updated` di `access_audit_events` dengan actor, ditambah `authenticationMethod` (`password` atau `oidc_identity`). Tidak ada issuer, subject, token, atau password di payload.
6. Email **tidak pernah** dipakai untuk mengikat identitas atau mengaktifkan account.

Pemetaan identitas tetap dilakukan operator dengan perintah `map-oidc-identity` (HUB-IMPL-003): preview, lalu `--apply`, dengan `HCIS_ALLOW_OIDC_IDENTITY_MAPPING=1`. Perintah itu memeriksa issuer terhadap `OIDC_ISSUER`, menolak identitas yang sudah dipakai account lain, dan menulis `auth.oidc.identity_mapped`. Urutan untuk Organ Yayasan non-pegawai:

1. Pemegang `access.governance.manage` membuat account Organ Yayasan (`POST /admin/access/board-accounts`), status `invited`.
2. Operator memetakan `iss + sub` Akun SQ orang tersebut ke account itu (CLI, preview lalu `--apply`).
3. Pemegang `access.governance.manage` mengubah status menjadi **Aktif** di Admin Akses.
4. Orang tersebut masuk dengan Akun SQ; akses aplikasi HCIS di SQ Hub tetap diperiksa saat login dan saat Ringkasan Yayasan diminta.

Tidak dibuat dalam perubahan ini (usulan lanjutan, butuh keputusan owner): route admin teraudit untuk memetakan Akun SQ ke account `FOUNDATION_BOARD` tanpa CLI. **Saran:** buat nanti bila penambahan Organ Yayasan non-pegawai menjadi rutin; batasi ke account `invited` tanpa pemetaan, issuer harus `OIDC_ISSUER`, input `sub` eksak (bukan email), Super Admin saja, dan penggantian pemetaan tetap lewat CLI.

## AUTH-002-INVITE — Kirim aktivasi Akun SQ dari Admin Akses (mode OIDC)

**Status:** ACCEPTED 2026-11-04 (permintaan Kepala HC: "ketika buat link aktivasi pegawai kirim ke WA dan emailnya"). Pasangan di SQ Hub: `HUB-IMPL-024` (`docs/specs/HUB-IMPL-024-hcis-staff-activation-invite.md` di repository SQ Hub).

Di production HCIS memakai Akun SQ (`AUTH_MODE=oidc`), sehingga link aktivasi lokal di atas tidak membuat pegawai bisa masuk. AUTH-002-INVITE menggantinya, **hanya di mode OIDC dan hanya untuk account `EMPLOYEE`**, dengan satu tombol **Kirim aktivasi** di Administrasi → Account & Akses. Mode lokal (development) tetap memakai alur lama; account `FOUNDATION_BOARD` di mode OIDC diaktifkan lewat pemetaan Akun SQ (lihat "AUTH-002 — penutupan").

### Keputusan desain

- Kata sandi Akun SQ hanya dibuat di halaman Akun SQ (Keycloak) melalui link yang dibuat dan dikirim **oleh Keycloak sendiri** ke email pegawai (tindakan `VERIFY_EMAIL` + `UPDATE_PASSWORD`, berlaku 12 jam, alur HUB-IMPL-013 yang sudah aktif). HCIS dan SQ Hub tidak pernah memegang link itu, token, atau kata sandi.
- WhatsApp (Kirim SQ) membawa pemberitahuan **tanpa rahasia**: akun sudah disiapkan, email Akun SQ dikirim ke alamat tersamar, alamat HCIS untuk masuk, dan petunjuk menghubungi HC bila email tidak datang. Link pembuat kata sandi tidak pernah dikirim lewat WhatsApp, karena hanya Keycloak yang dapat membuatnya dan ia hanya mengirimkannya lewat email. `DRAFT`: bila banyak pegawai tanpa email, link sekali pakai milik SQ Hub yang juga dikirim lewat WhatsApp dapat dibuat sebagai lanjutan; perlu keputusan owner karena SQ Hub lalu ikut menangani kata sandi.
- Pemetaan identitas HCIS ↔ Akun SQ memakai `issuer + sub` persis yang dikembalikan SQ Hub untuk **employee id HCIS yang sama** (`hcis:employee:<uuid>`, atribut `hcisEmployeeId` di Keycloak). Email tidak pernah dipakai untuk mengikat identitas.

### Aktor, izin, prasyarat

- Aktor: pemegang `access.manage` (Kepala HC / Super Admin), dengan pemeriksaan target yang sama dengan alur lain (`assertAccountManagementTarget`: bukan diri sendiri, bukan `SUPER_ADMIN`).
- Prasyarat: `AUTH_MODE=oidc`; account `EMPLOYEE` berstatus `invited`; employee `active`; email employee terisi (Akun SQ wajib punya email); account belum dipetakan ke identitas lain.
- Input: `POST /admin/access/accounts/:accountId/activation-invitation` tanpa body. Kontak tidak pernah diterima dari browser; SQ Hub membaca email dari HCIS (HCIS-ID-001), dan nomor WhatsApp dibaca dari `employees.phone`.

### Alur dan transisi

1. HCIS mengunci account, memeriksa prasyarat dan batas kirim ulang, lalu mencatat percobaan (`pending`) dan commit. Tidak ada transaksi atau kunci yang ditahan selama SQ Hub bekerja.
2. HCIS memanggil SQ Hub `POST /internal/v1/staff-activation/invite` dengan machine client HCIS: `{ employeeNumber, requestedBy: { accountId } }`. SQ Hub memverifikasi employee ke HCIS, membuat atau memakai kembali Akun SQ (username = NIP), mengirim email Keycloak bila kata sandi belum dibuat, dan memberi akses aplikasi `hcis` bila belum ada catatan akses.
3. HCIS menolak jawaban yang issuer-nya bukan `OIDC_ISSUER` atau employee id-nya bukan employee account ini. Lalu, dalam transaksi baru, HCIS mengunci dan memeriksa ulang account (masih `invited`, employee masih sama dan aktif), memetakan `issuer + sub` ke account (aturan `map-oidc-identity`: identitas yang sudah dipakai account lain ditolak, pemetaan berbeda tidak ditimpa) dan menandai percobaan `issued` di `account_activation_invitations`. Kegagalan menandainya `failed` dengan kodenya. Status account **tetap `invited`**.
4. Setelah commit, HCIS mengirim WhatsApp lewat Kirim SQ bila email terkirim atau kata sandi sudah ada, dan akses `hcis` di SQ Hub tidak dicabut. `WHATSAPP_RECIPIENT_MODE=allowlist` tetap berlaku: NIP di luar `WHATSAPP_ALLOWLIST` tidak dikirimi (`not_allowlisted`). Adapter `log` hanya mencatat (`dry_run`).
5. Saat pegawai pertama kali masuk HCIS dengan Akun SQ yang dipetakan, dan akses aplikasi `hcis` di SQ Hub diizinkan, account `invited` dengan undangan `issued` yang belum selesai/dicabut untuk identitas yang sama dan dikirim **dalam 14 hari terakhir** (`DRAFT`) otomatis menjadi `active` (employee harus masih `active`). Undangan ditandai selesai. Lewat 14 hari, HC mengirim ulang.

### Hasil per kanal (ditampilkan ke HC, kontak tersamar)

| Kanal | Nilai | Arti |
| --- | --- | --- |
| Email | `sent` | Keycloak menerima permintaan kirim email Akun SQ |
| Email | `not_needed` | Akun SQ sudah punya kata sandi; tidak ada email |
| Email | `failed` | Email gagal dikirim (atau akun Admin Platform, H-10); WhatsApp tidak dikirim |
| WhatsApp | `sent` / `dry_run` | Diterima Kirim SQ / adapter `log` |
| WhatsApp | `no_phone` | Nomor HP employee kosong atau bukan nomor Indonesia yang valid |
| WhatsApp | `not_allowlisted` | Mode uji: NIP tidak ada di `WHATSAPP_ALLOWLIST` |
| WhatsApp | `failed` / `skipped` | Kirim SQ menolak/gagal / tidak dikirim karena email gagal atau akses `hcis` dicabut |

Akses `hcis` di SQ Hub: `granted`, `already_active`, atau `revoked`. Bila `revoked`, SQ Hub **tidak** memberi akses ulang (pencabutan adalah keputusan Admin Platform), dan HC diberi tahu.

### Batas dan kegagalan

- Batas kirim (`DRAFT`): minimal 10 menit antar pengiriman untuk satu account dan maksimal 5 pengiriman per 24 jam → `429 ACTIVATION_INVITE_RATE_LIMITED`. Setiap percobaan yang sampai ke SQ Hub dihitung, termasuk yang gagal sesudahnya, karena email Keycloak mungkin sudah terkirim.
- Email employee kosong → `409 EMPLOYEE_EMAIL_MISSING` sebelum SQ Hub dipanggil; tidak ada WhatsApp karena Akun SQ belum dapat dibuat (`DRAFT`, lihat keputusan desain).
- Tidak di mode OIDC → `409 ACTIVATION_INVITE_UNAVAILABLE`. Bukan `EMPLOYEE` → `409 ACTIVATION_INVITE_EMPLOYEE_ONLY`. Bukan `invited` → `409 ACCOUNT_NOT_INVITED`. Employee tidak aktif → `409 EMPLOYEE_NOT_ACTIVE`.
- Penolakan SQ Hub diteruskan sebagai `409` dengan kode yang menjelaskan (`AKUN_SQ_CONFLICT`, `AKUN_SQ_DISABLED`, `HCIS_EMPLOYEE_NOT_FOUND`, …); SQ Hub tidak tersedia → `503 SQ_HUB_UNAVAILABLE`. Tidak ada pemetaan, undangan, atau WhatsApp bila langkah SQ Hub gagal.
- Pemetaan yang bentrok (`IDENTITY_ALREADY_ASSIGNED`, `REPLACE_REQUIRED`) → `409`, tanpa WhatsApp.
- Link email Keycloak yang lebih lama tetap berlaku sampai 12 jamnya habis (perilaku Keycloak); batas kirim membatasi jumlahnya.
- Setiap perubahan status account oleh administrator menutup undangan yang belum selesai (`active` → selesai, status lain → dicabut), sehingga login berikutnya tidak mengaktifkan account yang sudah diputuskan lain.
- Akun SQ Organ Yayasan dengan email yang sama tidak dihubungkan lewat jalur ini (`409 ORGAN_IDENTITY_LINK_REQUIRES_ADMIN`); Admin Platform melakukannya di SQ Hub.
- Batas yang diterima (`DRAFT`): email tujuan adalah email pegawai di HCIS. Administrator yang dapat mengubah kontak pegawai sekaligus mengirim aktivasi dapat mengarahkan email Keycloak. Mitigasi: pesan WhatsApp menyebut alamat tersamar, dan setiap pengiriman diaudit di HCIS dan SQ Hub.
- Link aktivasi lokal (`POST /admin/access/accounts/:accountId/activation`) untuk account `EMPLOYEE` di mode OIDC ditolak `409 ACTIVATION_USES_INVITATION`, karena kata sandi lokal tidak dipakai untuk masuk.

### Audit dan privasi

- `access_audit_events`: `account.activation.invitation.issued` (payload: `invitationId`, `emailStatus`, `whatsappStatus`, `hubAccess`), `account.activation.invitation.whatsapp` (payload: `invitationId`, `whatsappStatus` akhir) dan `account.activation.invitation.failed` (payload: `code`). Tanpa email, nomor, NIP, issuer, subject, atau token.
- `auth_audit_events`: `auth.oidc.identity_mapped` (pemetaan, sama dengan CLI) dan `auth.activation.invitation_completed` saat login pertama mengaktifkan account.
- Log WhatsApp hanya nomor tersamar dan `ref` `auth:activation-invitation:<id>`.
- `GET /admin/access` menambah `activationMethod` (`link` | `invitation`) dan, per account, `latestInvitation` (waktu, status kanal, selesai/dicabut) tanpa kontak.

### Konfigurasi

Tidak ada variabel baru yang wajib. HCIS memakai machine client SQ Hub yang sudah ada (`SQ_HUB_MACHINE_CLIENT_ID/SECRET`) dan alamat `<origin SQ_HUB_APPLICATION_ACCESS_URL>/internal/v1/staff-activation/invite`; `SQ_HUB_STAFF_ACTIVATION_URL` hanya untuk menimpa alamat itu. Di SQ Hub, client tersebut harus tercantum di `STAFF_ACTIVATION_ALLOWED_CLIENTS` (HUB-IMPL-024). WhatsApp memakai `WHATSAPP_ADAPTER`, `WHATSAPP_RECIPIENT_MODE`, `WHATSAPP_ALLOWLIST`, dan `KIRIM_DEVICE_HCIS` yang sama dengan CAL-001.

### Rollback

Kode dapat dikembalikan ke rilis sebelumnya; tabel `account_activation_invitations` (migration `0138`) boleh tetap ada. Account yang sudah dipetakan tetap dapat diatur dengan `map-oidc-identity --clear` bila perlu.

## AUTH-002 — penutupan: pemulihan kata sandi dan link lokal di mode Akun SQ

**Status:** ACCEPTED 2026-11-11 (penutupan AUTH-002). Production memakai `AUTH_MODE=oidc`; seluruh kata sandi pegawai dan Organ Yayasan berada di Akun SQ (Keycloak realm `sq-staff`), bukan di HCIS.

### Pemulihan kata sandi (password recovery)

- HCIS **tidak** membangun reset kata sandi sendiri. Pemulihan kata sandi adalah tautan **"Lupa kata sandi?"** di halaman masuk Akun SQ, yang mengirim email reset milik Keycloak ke email akun. HCIS dan SQ Hub tidak pernah memegang link atau token reset.
- Bukti read-only 2026-11-11 (tanpa mengirim email ke pegawai): realm `sq-staff` `resetPasswordAllowed = true`; konfigurasi SMTP realm lengkap (host `mail.sabilulquran.or.id`, port 465, SSL, autentikasi aktif, kredensial terisi); server SMTP dapat dijangkau dari Mi8VPS dengan sertifikat TLS yang valid untuk nama host tersebut; halaman masuk Akun SQ untuk client `hcis` menampilkan tautan "Lupa kata sandi?" (`login-actions/reset-credentials`). Satu-satunya email reset yang tercatat di event store Keycloak (2026-09-09) terkirim; log Keycloak sejak 2026-10-05 tidak memuat satu pun kegagalan pengiriman email (`SEND_RESET_PASSWORD_ERROR`, `EmailException`).
- Penyelesaian pertama setelah aktivasi tetap lewat email aktivasi Akun SQ (AUTH-002-INVITE untuk pegawai, HUB-IMPL-021 untuk Organ Yayasan non-pegawai).

### Link aktivasi lokal ditutup di mode Akun SQ

Di `AUTH_MODE=oidc` tidak ada yang dapat masuk HCIS dengan kata sandi lokal (`POST /auth/login` sudah menolak), sehingga link kata sandi lokal hanya menyesatkan:

| Titik | Perilaku di mode `oidc` | Mode `local` (development) |
|---|---|---|
| `POST /admin/access/accounts/:accountId/activation` | `409 ACTIVATION_USES_INVITATION` untuk `EMPLOYEE` (sudah sejak AUTH-002-INVITE), `409 ACTIVATION_USES_AKUN_SQ` untuk jenis account lain | tidak berubah |
| `POST /auth/activation/preview`, `POST /auth/activation/complete` | `409 ACTIVATION_USES_AKUN_SQ` sebelum token dibaca; tidak ada query database | tidak berubah |
| Administrasi → Account & Akses | tombol **Buat link aktivasi** tidak tampil untuk account apa pun; form Organ Yayasan menjadi **Siapkan account** tanpa link, dengan petunjuk aktivasi lewat pemetaan Akun SQ (§Aktivasi melalui Akun SQ) | tidak berubah |
| Halaman `/activate` | menampilkan "Aktivasi memakai Akun SQ" dengan tombol **Masuk dengan Akun SQ** dan petunjuk "Lupa kata sandi?"; tidak ada form kata sandi | tidak berubah |

Token lokal yang pernah diterbitkan tetap tersimpan sampai kedaluwarsa tetapi tidak dapat dipakai. Rollback: kembalikan kode; tidak ada perubahan database.

### Temuan email Keycloak (kegagalan 2026-10-17)

Kegagalan `staff_identity.password_initialization` pada 2026-10-17 00:15 WIB (uji HUB-IMPL-013) dan `organ_identity.activation_email` pada 2026-10-18 00:08 WIB **bukan kegagalan SMTP**: log Keycloak pada kedua waktu itu tidak memuat percobaan kirim maupun galat email. Penyebabnya, realm `sq-staff` tidak memiliki konfigurasi *user profile* sendiri, sehingga Keycloak 26 memakai bawaan *unmanaged attributes disabled* dan **membuang** atribut `hcisEmployeeId` yang dikirim SQ Hub saat membuat Akun SQ (2026-11-11: 0 pengguna `sq-staff` memiliki atribut itu). SQ Hub mensyaratkan atribut itu sebelum meminta email aktivasi (`IDENTITY_ACTION_NOT_PENDING`), jadi Keycloak tidak pernah diminta mengirim. Untuk Organ Yayasan, penanda `sqProvisionedFor` terbuang dengan cara yang sama (sudah dikoreksi SQ Hub 2026-10-18).

Dampak lanjutan: **AUTH-002-INVITE ("Kirim aktivasi") tidak dapat berhasil di production** sampai atribut itu tersimpan. Gerbangnya ada di SQ Hub, bukan di HCIS: `provisionVerified` menolak identitas yang sudah ada tetapi tidak membawa employee id (`EMPLOYEE_IDENTITY_CONFLICT`), dan `sendPasswordInitialization` menolak meminta email tanpa employee id (`IDENTITY_ACTION_NOT_PENDING`). Dua percobaan pada 2026-11-04 gagal di tahap pembuatan identitas; penjelasan paling mungkin adalah identitas uji 2026-10-17 dengan username yang sama tanpa `hcisEmployeeId` (`DISCOVERY`: log SQ Hub hari itu sudah terotasi).

Perbaikan (butuh kredensial admin Keycloak, jadi dikerjakan owner/operator, bukan agent):

1. Deklarasikan atribut `hcisEmployeeId` pada user profile realm `sq-staff` dengan izin lihat/ubah **hanya admin** (tidak tampil dan tidak dapat diubah pengguna di konsol akun).
2. Deklarasi tidak mengisi pengguna lama. Setiap identitas staf yang sudah dibuat SQ Hub (per 2026-11-11: 1 identitas, uji 2026-10-17; 3 pengguna non-layanan di realm) harus ditautkan ulang ke employee id-nya lewat Admin Center SQ Hub, atau identitas uji dihapus, sebelum aktivasi berikutnya dikirim.
3. Konfigurasi SMTP tidak perlu diubah.

## MFA

- `SUPER_ADMIN` tetap wajib MFA.
- `EMPLOYEE` dan `FOUNDATION_BOARD` pada MVP dapat login dengan password setelah aktivasi tanpa MFA.
- Kewajiban MFA untuk role sensitif non-Super Admin harus menjadi keputusan keamanan terpisah; tidak diinferensikan diam-diam dari role.

## API MVP

Admin, wajib principal `SUPER_ADMIN`:

- `POST /admin/access/employee-accounts`
- `POST /admin/access/board-accounts`
- `POST /admin/access/accounts/:accountId/activation`

Public capability route:

- `POST /auth/activation/preview` dengan body `{ token }`
- `POST /auth/activation/complete` dengan body `{ token, password }`

Respons penerbitan admin berisi `activationPath` berbentuk `/activate#token=...` dan `expiresAt`. Frontend membentuk absolute URL dari origin saat ini; backend tidak menyimpan hostname production.

## UX

Di detail pegawai/account:

- `Siapkan account pegawai`
- setelah account invited: `Buat link aktivasi`
- setelah token dibuat: tampilkan link + `Salin link`
- jelaskan masa berlaku 24 jam
- jangan tampilkan token kembali setelah halaman direload; Super Admin dapat membuat token baru jika diperlukan.

Di halaman aktivasi:

1. frontend mengambil token dari URL fragment lalu segera menghapus fragment dari address bar setelah token dibaca;
2. validasi link melalui endpoint preview dengan token pada request body;
3. tampilkan email tujuan secara tersamarkan dan jenis akses dalam bahasa pengguna;
4. pengguna membuat dan mengonfirmasi password;
5. setelah sukses arahkan ke halaman login;
6. setelah login backend menentukan `/app` atau `/board`.

## Route lintas principal

Pengguna yang sudah login tetapi membuka area principal lain tidak di-redirect diam-diam ke dashboard miliknya. UI menampilkan halaman **404 / Halaman tidak tersedia**. Backend tetap menjadi sumber otoritatif authorization.

## Audit minimum

- `employee.account.prepared`
- `board.account.prepared`
- `account.activation.issued`
- `auth.activation.completed`
- perubahan status account yang sudah ada tetap diaudit.

Audit tidak boleh memuat token aktivasi, password, password hash, TOTP secret, atau recovery code.

## Acceptance criteria

- Account `EMPLOYEE` invited dapat diaktivasi dan login ke `/app`.
- Account `FOUNDATION_BOARD` invited dapat diaktivasi dan login ke `/board`.
- Account invited tanpa password tetapi dengan identitas Akun SQ terpetakan (issuer = `OIDC_ISSUER`) dapat diaktifkan oleh administrator yang berwenang; tanpa pemetaan tetap ditolak `ACCOUNT_ACTIVATION_NOT_READY`.
- Token hanya sekali pakai, hashed at rest, dan expire 24 jam.
- Token tidak muncul pada server request URL/access log normal.
- Reissue mencabut token lama.
- Employee nonaktif tidak dapat menyelesaikan aktivasi.
- Super Admin tetap wajib MFA.
- Tidak ada registrasi publik atau pilihan role pada login.
- Cross-principal route menampilkan 404, bukan silent redirect.
- Di mode `oidc`, link kata sandi lokal tidak dapat diterbitkan maupun dipakai untuk jenis account apa pun, dan UI tidak menawarkannya (penutupan AUTH-002).
- Pemulihan kata sandi tersedia lewat "Lupa kata sandi?" di Akun SQ; HCIS tidak menyimpan kata sandi.
