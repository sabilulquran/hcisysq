# AUTH-015 — Peran mengikuti jabatan

**Status:** ACCEPTED (owner decision 2026-11-04). Keputusan: ADR-0007.
**Related:** AUTH-010, AUTH-011, AUTH-014, ORG-004, ORG-008-9 (digantikan), ORG-008-10, PAY-003, LOAN-001.

## 1. Keputusan owner

> "jangan bound ke orang, tapi ke struktur organisasi biar kalau resign itu otomatis ke penggantinya"
>
> "kalau tugasnya itu lebih ke staf, yaitu panji. tapi pastikan tidak bisa lihat gaji utuh"

Pemakaian pertama: peran pengelola kasbon `finance_officer` ("Staf Keuangan (Kasbon)") dipegang lewat jabatan staf Keuangan yang diduduki Panji Irawan, dan peran itu tidak boleh membuka gaji siapa pun.

## 2. Model

| Konsep | Arti |
|---|---|
| Tautan peran–jabatan | Baris `access_role_position_links (role_key, position_key, reason, set_by_account_id, set_at)`. Satu peran boleh punya beberapa jabatan; satu jabatan boleh membawa beberapa peran. `position_key` adalah stable key jabatan yang pernah terbit, dipilih lewat pencarian jabatan, tidak pernah ditebak dari judul. |
| Pemegang jabatan hari ini | Incumbency `PRIMARY` atau `ACTING` (Plt) yang berlaku hari ini, di change set `PUBLISHED` terakhir yang berlaku hari ini, pada jabatan aktif yang berlaku hari ini dengan `holder_source = 'EMPLOYEE'`. |
| Peran dari jabatan | Peran bertaut yang dipegang pemegang jabatan hari ini. Scope selalu organisasi. |
| Izin efektif | Pemberian langsung (AUTH-011) ∪ peran dari jabatan, dikurangi setiap permission `access.*` yang berasal dari jabatan. |

Evaluasi dilakukan **di setiap permintaan** oleh fungsi database `hcis_seat_permissions(as_of, account)` (migration 0139), dipakai oleh `hasOrganizationPermission`, `resolveAuthorizationContext` (dan karenanya `/auth/me` serta setiap route guard), scope laporan RPT-001, dan kelayakan otoritas struktural (`capabilityValid`). Tidak ada cache dan tidak ada salinan, sehingga pergantian pemegang jabatan langsung memindahkan peran pada permintaan berikutnya.

Tanggal: `current_date` database, yang di production berzona `Asia/Jakarta` (diverifikasi 2026-11-04), sama dengan tanggal bisnis struktur.

## 3. Guardrail

Lihat ADR-0007 G-1 sampai G-6. Ringkas:

- `access.*` tidak pernah mengalir dari jabatan (ditegakkan saat evaluasi, bukan hanya saat menautkan).
- Peran yang boleh ditautkan: lolos `canDelegateRole`, tanpa `access.*`, bekerja **hanya** di scope organisasi, bukan `governance_leave_approver`. Hari ini artinya `human_capital_admin` dan peran pemberi akses **tidak** dapat ditautkan; peran yang juga bisa untuk satu unit (`human_capital`, `finance`, `management`, `unit_manager`) juga tidak.
- Menautkan = memberi peran: break-glass Super Admin, alasan wajib, diaudit beserta daftar pemegang saat itu; sebelum menyimpan layar menampilkan pemegang hari ini dan yang sudah terbit untuk nanti. Kanal SQ Hub: `TBD`.
- Akun dan pegawai harus aktif. Akun `invited` belum memegang peran dari jabatan.
- Penerbit struktur tidak dapat mendudukkan dirinya di jabatan bertaut, dibanding struktur yang digantikan (`403 ORGANIZATION_PUBLISH_SELF_ROLE_SEAT`); publikasi mengunci change set-nya.
- Setiap publikasi yang memindahkan peran bertaut menulis `role.seat_holder.gained` / `role.seat_holder.lost` ke audit akses.

## 4. Workflow

### 4.1 Menautkan peran ke jabatan

| Aspek | Isi |
|---|---|
| Aktor | Super Admin (break-glass). Akun lain: `403 ROLE_GRANT_SUPER_ADMIN_ONLY` sebelum input dibaca. |
| Prasyarat | Jabatan pernah terbit; peran lolos G-2. |
| Input | `POST /admin/access/role-seat-links` `{ roleKey, positionKey, reason, preview? }`. Dengan `preview: true` API menjawab `200 { holders }` (pemegang hari ini dan yang sudah terbit untuk nanti) tanpa menulis apa pun; layar memanggilnya begitu jabatan dipilih dan baru mengaktifkan tombol simpan setelahnya. |
| Transisi | tidak ada tautan → tautan ada. Pemegang jabatan hari ini (yang akunnya aktif) memegang peran mulai permintaan berikutnya. |
| Audit | `role.seat_link.set` `{ roleKey, positionKey, reason, holderEmployeeIds }`, `actor_source = 'hcis_break_glass'` |
| Gagal | `400 INVALID_ROLE_SEAT_LINK` (input), `400 ROLE_NOT_SEAT_LINKABLE`, `404 ORGANIZATION_POSITION_NOT_PUBLISHED`, `409 ROLE_SEAT_LINK_EXISTS` |

### 4.2 Melepas tautan

`DELETE /admin/access/role-seat-links/:roleKey/:positionKey` `{ reason }`, aktor sama. Audit `role.seat_link.cleared`. `404 ROLE_SEAT_LINK_NOT_FOUND` bila tidak ada. Peran hilang dari pemegang jabatan pada permintaan berikutnya; pemberian langsung tidak tersentuh.

### 4.3 Pergantian pemegang jabatan

Lewat jalur ORG-004 biasa (draft → validasi → terbit oleh orang kedua). Tidak ada langkah akses tambahan. Penerbitan ditolak bila memberi penerbit sendiri masa memegang jabatan bertaut yang belum ada di struktur yang digantikan (G-5). Publikasi menulis `role.seat_holder.gained`/`lost` (entity = pegawai, payload `roleKey`, `positionKey`, `changeSetId`, `effectiveOn`) untuk setiap orang yang masuk atau keluar dari jabatan bertaut karena publikasi itu (G-7; `actor_source` NULL karena bukan kanal pemberian peran). Perubahan tanpa publikasi (incumbency berakhir karena waktu, status akun atau pegawai) tidak menulis baris ini; riwayat lengkapnya direkonstruksi dari struktur terbit dan audit akun.

### 4.4 Melihat

`GET /admin/access/role-seat-checks` (`access.manage`): per peran yang punya tautan, jabatannya, pemegang tiap jabatan dan apakah peran berlaku untuknya (alasan bila belum: tidak punya akun, akun belum aktif, pegawai tidak aktif), serta pemberian langsung yang tidak mengikuti jabatan mana pun; plus `linkableRoles`. `GET /admin/access` menambahkan `seatRoles` per akun (peran, jabatan, unit, Plt atau bukan, berlaku atau belum), terpisah dari `assignments` dan tidak dapat dicabut dari baris akun.

Layar Akses: panel "Peran yang mengikuti jabatan" menggantikan panel ORG-008-9; baris akun menampilkan peran dari jabatan sebagai chip bergaris putus-putus "dari jabatan …".

## 5. "Tidak bisa lihat gaji utuh" (`finance_officer`)

`finance_officer` membawa tepat `payroll.loans.manage`, `loans.read`, `loans.manage` (production 2026-11-04). Yang terbuka:

| Permukaan | Isi |
|---|---|
| `GET/POST /payroll/loans`, `PUT /payroll/periods/:id/loan-deductions` | register kasbon PAY-003: pegawai, pokok, cicilan, sisa |
| `GET /payroll/employments` | pemilih pegawai: nama, NIP, tanggal mulai/selesai, jumlah profil — tanpa nominal (diuji kunci-kuncinya) |
| `/admin/loans*` (LOAN-001) | register pinjaman, jadwal, pembayaran; tidak membaca gaji (LOAN-001 menolak plafon berbasis gaji) |
| Layar | `/admin/payroll/reference` tab Kasbon saja; `/admin/loans`. Menu "Kasbon & Acuan Payroll" ditambahkan karena sebelumnya tidak ada jalan ke layar ini selain mengetik alamat. |

Yang tertutup (`403`, diuji otomatis di `auth011-postgres.integration.test.ts` untuk akun yang memegang peran ini lewat jabatan): daftar dan detail periode, input periode, hasil, laporan, daftar transfer, varians, profil kompensasi, kebijakan payroll, impor payslip, data pegawai admin. Menu Payroll (periode) tidak tampil. Slip gaji **milik sendiri** tetap terbuka sebagai layanan mandiri, seperti semua pegawai.

Catatan: setoran kasbon ke potongan periode (`PUT …/loan-deductions`) membutuhkan id periode, sedangkan peran ini tidak dapat membaca daftar periode. Ini bukan kebocoran; alur pemotongan kasbon lewat payroll masih menunggu PAY-003 lulus parallel run (`TBD`: tampilkan pemilih periode yang hanya berisi bulan dan status).

## 6. Production: pemakaian pertama (2026-11-04)

Struktur terbit hari ini: unit Keuangan hanya punya jabatan "Kepala" (Sulthan Zaki); Panji Irawan anggota tim "Kasir" di bawah Keuangan tanpa jabatan; HCM "Kepala" (owner); Direksi "Direktur" (Ichwanudin). Belum ada jabatan staf Keuangan.

Langkah (butuh sesi manusia; agent tidak mengetik kredensial):

1. **Owner** (Struktur Organisasi, `organization.manage`): buat draft berlaku hari ini → tambah jabatan **"Staf Keuangan"** di unit **Keuangan**, melapor ke **Kepala (Keuangan)**, tanpa kewenangan (bukan pemimpin unit, bukan penyetuju) → dudukkan **Panji Irawan** sebagai pemegang utama (PRIMARY) mulai hari ini → validasi.
2. **Penerbit kedua** (empat mata ORG-008-10): pemegang `approvals.policy.manage` selain penyusun, atau Super Admin break-glass, menerbitkan draft. Hari ini pemegang izin terbit satu-satunya adalah owner, jadi praktisnya Super Admin.
3. **Super Admin** (Akses → Peran yang mengikuti jabatan → Tautkan peran ke jabatan): peran "Staf Keuangan (Kasbon)" → jabatan "Staf Keuangan (Keuangan)", alasan "Keputusan owner 2026-11-04: kasbon dikelola staf Keuangan, mengikuti jabatan".
4. Peran berlaku setelah akun Panji aktif (sekarang `invited`; aktivasi akun adalah langkah peluncuran terpisah).

### Usulan tautan lain (`DRAFT`, belum diterapkan)

| Peran | Jabatan | Pemegang hari ini | Catatan |
|---|---|---|---|
| `human_capital_lead` (Kepala HC) | Kepala — Human Capital Management | owner (sudah memegang lewat pemberian langsung) | **jangan diterapkan dulu**: peran ini memegang izin menyusun dan menerbitkan struktur, sehingga tautannya melingkar (ADR-0007 Consequences). Tetap pemberian langsung. |
| `finance_lead` | Kepala — Keuangan | Sulthan Zaki (akun `invited`) | berlaku setelah akun aktif |
| `director` | Direktur — Direksi | Ichwanudin (akun `invited`) | berlaku setelah akun aktif |

## 7. DRAFT / TBD

- `TBD` Jalur Admin Platform (kanal SQ Hub) untuk membuat/melepas tautan; sampai ada, hanya break-glass.
- `TBD` Layar dampak publikasi menampilkan perpindahan peran.
- `DRAFT` Peran dari jabatan selalu scope organisasi; peran unit (`unit_manager`) tidak dapat ditautkan.
- `DRAFT` Jabatan yang dipegang akun (Organ Yayasan) tidak memberi peran.
- `DRAFT` Rangkap jabatan memberi gabungan peran; pemisahan tugas PAY-003 tetap di transisi.
- `DRAFT` Tautan tidak berlaku-bertanggal: `capabilityValid` untuk tanggal lain memakai tautan hari ini.
- `DRAFT` Baris tautan yang ditulis langsung ke database (di luar route) hanya disaring `access.*` saat evaluasi; aturan G-2 lainnya ditegakkan di route. Penulis database langsung sudah berada di luar setiap kendali aplikasi.
- `DRAFT` Fungsi SQL tidak memakai `SET search_path`: berjalan dengan hak pemanggil, sehingga tidak ada eskalasi; dibiarkan agar uji per-skema tetap bekerja.
