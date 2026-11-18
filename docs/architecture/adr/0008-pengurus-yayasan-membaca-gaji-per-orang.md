# ADR-0008: Pengurus Yayasan boleh melihat gaji per orang (B5)

- **Status:** ACCEPTED
- **Date:** 2026-11-18
- **Decider:** Owner Yayasan Sabilul Qur'an
- **Related:** PAY-003 (ADR-0003), ORG-003-F, ORG-010-B/ORG-010-F, ORG-013, ORG-014, ORG-015, PAYSLIP-001-F, AUTH-011, AUTH-014, AUTH-015 (ADR-0007)
- **Amandemen terhadap:** ADR-0003 butir 6 (amandemen 2026-10-27), ORG-003-F, ORG-010-F, PAYSLIP-001-F, `docs/domain/organ-account-approver.md` §Ruang lingkup, `docs/domain/organ-employee-list.md`, `docs/domain/payroll-calculation-v1.md` §2 (Batas Pengurus Yayasan), `docs/domain/roles-permissions.md`
- **Spec/manifest:** `docs/domain/AUTH-011-admin-route-permissions.json`, migrasi `0180_governance_payroll_reader.sql`

## Konteks

Daftar sign-off HC pertanyaan B5, "Siapa boleh melihat gaji per orang?", dijawab owner pada 2026-11-18 dengan **opsi c: Pengurus Yayasan boleh melihat gaji per orang.**

Sampai hari ini yang boleh membacanya hanya Direktur, Kepala Keuangan, Kepala HCM, dan staf HC yang menghitung payroll (migrasi 0151 untuk `payroll.results.read.organization`, ditambah `payroll.calculate` dan `payroll.inputs.manage` bagi yang membangun angkanya). Pengurus Yayasan dikecualikan secara eksplisit di enam tempat: ADR-0003 butir 6 (amandemen 2026-10-27) dan konsekuensinya, ORG-003-F, ORG-010-F, PAYSLIP-001-F, pengecualian di `organ-account-approver.md` §Ruang lingkup, dan `organ-employee-list.md`. ADR-0003 menyebut dengan kata-katanya sendiri bahwa membuka akses itu adalah "perubahan batas governance yang membutuhkan ADR tersendiri". ADR ini adalah ADR tersendiri itu.

ADR ini **hanya** memindahkan batas yang disebut di bawah. Setiap aturan lain di dokumen-dokumen itu tetap berlaku apa adanya, dan amandemennya ditulis sebagai catatan bertanggal di dokumen aslinya, bukan dengan menghapus aturannya.

## Keputusan

### D-1 Apa yang dibuka

Pemegang peran ini boleh membaca, untuk periode payroll yang berstatus `APPROVED` atau sesudahnya (`PAYMENT_CONFIRMED`, `PUBLISHED`, `REOPEN_REQUESTED`):

- hasil payroll per orang: nama, nomor pegawai, bruto, potongan, neto, dan nilai yang dibayarkan;
- baris slip untuk tiap orang: kode komponen, kategori, nominal, dan urutannya;
- daftar periode yang sudah disahkan (bulan, jenis, status, tanggal bayar).

Hanya baca. Tidak ada aksi, tidak ada ekspor.

### D-2 Apa yang **tidak** dibuka

Dituliskan, karena yang tidak berubah sama pentingnya dengan yang berubah:

- **Daftar transfer berisi nomor rekening** (`payroll.transfers.read.organization`). Tetap milik Keuangan. ADR-0003 butir 6 memisahkannya dari laporan rekap dan pemisahan itu tetap berdiri. Tidak ada route organ untuk daftar transfer, dalam bentuk apa pun.
- **Aksi siklus periode**: `calculate`, `submit`, `approve`, `confirm_payment`, `publish`, `request_reopen`, `approve_reopen`, `reject_reopen`. Pengesahan dua tahap ADR-0003 butir 7 tidak berubah.
- **Input periode, kebijakan payroll, profil payroll, pinjaman, PPh21 per orang, dan perbandingan antarperiode.** Angka kerja milik yang menjalankan periode.
- **Periode yang belum disahkan.** Periode `DRAFT`/`COLLECTING`/`CALCULATED`/`SUBMITTED` tidak muncul dan dijawab `404`, sama seperti id yang tidak dikenal: surface ini tidak memberi tahu periode apa yang sedang dikerjakan.
- **Slip pegawai perorangan di jalur PAY-001/PAY-002.** PAYSLIP-001-F tetap melarang Pengurus membuka layar slip pegawai, menjalankan import, atau publish. Yang dibuka adalah angka hasil payroll pada surface organ, bukan layar slip pegawai.
- **Akses ke `/app` dan `/admin`.** `FOUNDATION_BOARD` tetap ditolak di sana (ORG-013 §Ruang lingkup).
- **Agregat payroll di dasbor/ringkasan organ.** ORG-003-F dan ORG-010-F tetap melarang metrik agregat payroll di `/board/dashboard` dan `GET /governance/summary`; membukanya memerlukan semantik dan izin yang ditetapkan tersendiri. Yang ADR ini buka adalah route baru, bukan isi dasbor yang lama.

### D-3 Siapa persisnya, dan bagaimana ia memperolehnya

`DRAFT` (default agent 2026-11-18, karena daftar sign-off hanya menyebut "Pengurus Yayasan"): **Pengurus Yayasan = pemegang jabatan Ketua, Sekretaris, dan Bendahara pada node Pengurus Yayasan / Dewan Pengurus.** Pembina dan Pengawas **tidak** termasuk. Owner dapat mengubah daftar ini tanpa ADR baru; yang membutuhkan ADR adalah batas datanya, bukan jumlah orangnya.

**Akses tidak pernah lahir dari jabatan.** ORG-013-1 butir 3 menetapkan bahwa kepemilikan jabatan tidak pernah memberi capability, dan ADR ini mengikutinya tanpa pengecualian:

- permission baru `payroll.governance.results.read`;
- role baru `governance_payroll_reader`, hanya membawa permission itu (migrasi 0180);
- diberikan ke akun `FOUNDATION_BOARD` lewat kanal pemberian role (ORG-013-2): scope organisasi, alasan wajib (nomor SK kepengurusan), tanggal berakhir wajib (akhir masa jabatan), tanpa self-grant, diaudit seperti assignment lain, dan ditolak bila email akun cocok dengan email pegawai aktif;
- akun pegawai **tidak pernah** menerima role ini, di kanal mana pun (`ROLE_TARGET_INVALID`);
- role ini berada di luar seluruh bundel HC dan di luar kompatibilitas legacy Super Admin, seperti `BOARD_READ_PERMISSION` (`apps/api/src/modules/auth/permissions.ts`);
- role ini tidak dapat ditautkan ke jabatan (AUTH-015 / ADR-0007 G-2 menolak peran governance Organ Yayasan), sehingga tidak ada jalur diam-diam dari struktur ke gaji.

**Tentang `findFoundationChair`** (`apps/api/src/modules/documents/signer-authority.ts:137-170`): fungsi itu menemukan pemegang kursi "Ketua Yayasan" — atau "Ketua" di node bernama "Dewan Pengurus"/"Pengurus Yayasan" — dengan mencocokkan **nama jabatan dan nama node sebagai teks**. Untuk menandatangani surat, pencocokan nama itu memadai: salah orang berarti surat tidak tercetak. Untuk membuka gaji, tidak. Nama node bisa diubah penerbit struktur, dan sebuah node baru bernama "Pengurus Yayasan" akan memperluas aksesnya tanpa seorang pun memberi peran. Karena itu **lookup tersebut tidak dipakai di sini**, dan tidak dipakai juga sebagai pengganti pemberian peran: yang menentukan adalah assignment `governance_payroll_reader` yang eksplisit, bertanggal, dan dapat dicabut. Kursi menentukan siapa yang pantas diberi peran; peranlah yang memberi akses.

### D-4 Di mana route-nya

`GET /governance/payroll/periods` dan `GET /governance/payroll/periods/:periodId/results`, pada surface organ, **bukan** `/admin`.

Alasannya ada pada akunnya: `FOUNDATION_BOARD` ditolak di `/app` dan `/admin` (ORG-013 §Ruang lingkup), dan sejak amandemen ORG-010 2026-11-13 akun organ membaca di Portal Organ Yayasan sementara `/board` menyisakan kotak persetujuannya saja. Jadi satu-satunya permukaan yang benar-benar dapat dicapai principal organ adalah surface ini, berdampingan dengan `/governance/summary` (ORG-010) dan `/governance/employees` (ORG-014). Menaruhnya di `/admin` berarti membuka `/admin` untuk `FOUNDATION_BOARD` — perubahan batas yang jauh lebih besar daripada yang owner putuskan.

Teknisnya mengikuti route baca organ yang sudah ada: bearer hasil token exchange dengan `aud` = `GOVERNANCE_SUMMARY_AUDIENCE`, `azp` dibatasi `GOVERNANCE_PAYROLL_ALLOWED_CLIENTS` (bawaan `sq-organ`, seperti ORG-014), identitas dipetakan `iss + sub`, akun aktif, punya board access, dan Application Access diperiksa ulang ke SQ Hub. Cookie tidak pernah diterima. Di atas semua itu: principal wajib `FOUNDATION_BOARD` tanpa `employee_id`, dan wajib memegang `payroll.governance.results.read`. Board access saja tidak membuka apa pun di sini — `foundation_board_viewer` yang hanya membawa `board.read` ditolak.

Tidak ada step-up TOTP dan tidak ada token sekali pakai: itu syarat ORG-015 untuk satu-satunya pintu yang mengubah keadaan, sedangkan dua route ini hanya membaca.

Sakelar `GOVERNANCE_PAYROLL_READ_ENABLED` (bawaan `false`, mensyaratkan `GOVERNANCE_SUMMARY_ENABLED=true`). Selama mati, kedua route menjawab `404`.

### D-5 Audit

Setiap pembacaan hasil per orang oleh principal organ menulis baris audit payroll `payroll.report.read` (`scope = governance_period_results`, `actor = organ`, jumlah baris) — action yang sama dengan pembacaan HC atas angka yang sama — ditambah `governance.payroll.results.read` di `auth_audit_events`. Penolakan menulis `governance.payroll.denied` beserta kodenya.

Baris audit payroll ditulis **sebelum** angkanya dikirim dan tidak ditelan: owner menerima bahwa data gaji kini sampai ke lebih banyak orang **dengan syarat pembacaannya tercatat**, jadi pembacaan yang tidak dapat dicatat tidak terjadi. Isi payload tetap tunduk pada constraint `payroll_audit_events_payload_has_no_personal_amount`: tidak ada nominal, nomor rekening, atau identitas di dalamnya.

### D-6 Yang tidak diaktifkan oleh perubahan ini

Migrasi 0180 hanya membuat permission dan role. **Tidak ada akun yang menerimanya**, dan sakelar route-nya mati. Pengurus Yayasan baru benar-benar dapat membaca gaji setelah owner memberikan role itu lewat kanal pemberian role dan sakelarnya dinyalakan.

## Tindak lanjut yang sengaja ditunda

Tiga temuan review independen 2026-11-18 yang **tidak** dikerjakan di PR pembuka ini. Ketiganya dinilai rendah dan tidak terlihat selama hasil payroll di production masih nol, tetapi dicatat di sini supaya tidak hilang bersama PR-nya:

1. **TOCTOU antara state periode dan angkanya.** Daftar periode dibaca lebih dulu, lalu hasilnya dibaca dalam query terpisah. Periode yang pindah state di antara keduanya (misalnya reopen yang disetujui) membuat pembaca organ menerima angka periode yang sedetik lalu masih `APPROVED`. Perbaikannya: baca keduanya dalam satu transaksi, atau periksa ulang state setelah hasil diambil.
2. **Pembacaan daftar periode dapat lolos tanpa catatan audit.** `audit()` sengaja menelan kegagalan insert agar baris audit tidak pernah mengubah jawaban — benar untuk penolakan, tetapi berarti `GET /governance/payroll/periods` dapat terlayani tanpa jejak. Pembacaan angka per orang tidak punya masalah ini: baris audit payroll-nya tidak ditelan. Perbaikannya: perlakukan audit daftar periode sama tegasnya, atau catat kegagalannya sebagai sinyal operasional.
3. **Pengelompokan baris O(orang × baris) tanpa paginasi.** `loadGovernancePayrollResults` memfilter seluruh baris slip untuk setiap orang. Pada ratusan pegawai masih murah; pada skala lebih besar ini perlu `Map` per `employmentId` dan paginasi, sejalan dengan utang ENG-LIST-001 yang sudah tercatat untuk route sejenis.

## Alternatif yang dipertimbangkan

- **Memberi Pengurus `payroll.results.read.organization` yang sudah ada.** Satu kunci lebih sedikit, tetapi kunci itu dibaca guard `/payroll/*` di `/admin` — yang berarti harus membuka `/admin` untuk `FOUNDATION_BOARD`, atau memberi peran itu ke akun pegawai. Keduanya memindahkan batas yang jauh lebih besar daripada keputusan owner. Ditolak.
- **Memberi `board.read` kemampuan membaca gaji.** Membuat setiap pemegang Panel Organ Yayasan — termasuk `foundation_board_viewer` yang dipegang akun pegawai — ikut melihat gaji. ORG-010-B menyebut `board.read` tidak membawa mutasi dan tidak membawa data pribadi; mengubahnya berarti mengubah arti peran yang sudah berjalan. Ditolak.
- **Menurunkan akses dari jabatan di struktur terbit (lewat `findFoundationChair` atau tautan peran-jabatan).** Rapi di atas kertas, tetapi melanggar ORG-013-1 butir 3 dan membuat penerbit struktur dapat memperluas akses gaji dengan mengganti nama node. Ditolak; lihat D-3.
- **Agregat saja, bukan per orang.** Lebih hemat data, tetapi bukan yang ditanyakan B5 dan bukan yang dijawab owner. Agregat payroll justru tetap tertutup (ORG-003-F), karena semantik dan izinnya memang belum ditetapkan.
- **Menunggu Portal Organ punya layar sendiri.** API-nya adalah batas yang perlu diputuskan; layarnya mengikuti di repository Portal Organ (GOV-001). Tidak menunda ADR ini.

## Konsekuensi

- ADR-0003 butir 6 (amandemen 2026-10-27) dan konsekuensinya, ORG-003-F, ORG-010-F, PAYSLIP-001-F, `organ-account-approver.md` §Ruang lingkup, `organ-employee-list.md`, `payroll-calculation-v1.md`, dan `roles-permissions.md` memperoleh catatan amandemen bertanggal 2026-11-18 yang menunjuk ke ADR ini. Aturan yang tidak disebut di D-1 tetap berlaku.
- Test otorisasi tetap harus membuktikan penolakan, dan sekarang juga membuktikan apa yang **tidak** terbuka: `foundation_board_viewer` biasa ditolak, akun organ tanpa role ditolak, principal pegawai tidak berubah, dan daftar transfer tetap tertutup.
- PR ini menyentuh auth, permission, audit, payroll, dan migration sekaligus — kelima kategori yang menurut `AGENTS.md` §8 wajib melewati satu putaran review independen sebelum merge.
- Rilis ke Mi8VPS mengikuti `docs/development/mi8vps-hcis-release.md`: gate kandidat, backup database sebelum migrasi, rollback bila verifikasi gagal. Jalur turun migrasi 0180 ditulis di berkas migrasinya.
- Bila kelak Portal Organ menampilkan angka ini, batas datanya adalah D-1 dan D-2, bukan apa yang kebetulan tersedia di API lain.
