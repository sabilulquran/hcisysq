# Aset Pegawai — Asset Saya dan Peringatan Aset saat Pemberhentian

**Status:** ACCEPTED — spesifikasi ini mengizinkan implementasi. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal (aturan owner 2026-10-26).
**Spesifikasi:** ASSET-001 (Employee asset assignment and return)
**Tanggal:** 2026-11-02
**Terkait:** EMP-005 (tindakan Pemberhentian), ORG-006/ORG-010 (Organization Directory), AUTH-013, ADR-0002; Aset SQ ADR-0001, ASQ-001, ASQ-002, ASQ-004
**Implementasi:** `apps/api/src/modules/employee-assets/` (adapter `aset-sq-client.ts`, rute `routes.ts`), `apps/web/src/pages/EmployeeAssetsPage.tsx`, `apps/web/src/components/employment/TerminationAssetWarning.tsx`; kontrak `docs/api/employee-assets.openapi.yaml`. Fitur mati sampai tiga variabel §7 diisi.
**Roadmap:** `docs/product/hcis-capability-map.md` §5, `docs/design/employee-self-service-experience.md` (Layanan Pegawai → Asset Saya)

## 1. Keputusan

**HCIS tidak membangun modul aset.** Aset SQ (`sabilulquran/Aset-SQ`, `https://aset.sabilulquran.or.id`) sudah berjalan di production sebagai system of record aset dan serah terima. HCIS hanya:

1. menampilkan **Asset Saya** secara read-only: daftar aset yang sedang dipegang pegawai yang login, dengan tautan ke Aset SQ untuk setiap tindakan;
2. menampilkan **peringatan "masih memegang aset"** di dialog Pemberhentian (EMP-005), supaya HC tahu ada aset yang harus kembali sebelum atau sesudah pegawai keluar.

Semua data diambil saat itu juga dari satu API baca baru di Aset SQ (ASQ-004) lewat adapter di infrastructure layer HCIS. HCIS tidak menyimpan, menyalin, atau mengubah data aset.

Tidak perlu ADR baru: batas domainnya sudah diputuskan di Aset SQ ADR-0001 ("HCIS boleh menyediakan entry point Aset Saya dan workflow HR seperti offboarding clearance, tetapi asset facts tetap berasal dari Aset SQ melalui deep-link atau narrow integration contract"), dan polanya (client-credentials Keycloak dengan audience khusus, token diverifikasi dengan JWKS) sudah dipakai di AUTH-013, ORG-010, dan ASQ-003.

## 2. Bukti kajian (2026-11-02)

Dibaca dari `sabilulquran/Aset-SQ` `main` `70d69bd`:

| Pertanyaan | Jawaban | Bukti |
| --- | --- | --- |
| Apakah Aset SQ sudah punya konsep "aset dipegang pegawai"? | Ya, lengkap: serah terima (checkout), konfirmasi/penolakan penerima, pengembalian (checkin), riwayat yang tidak pernah dihapus. | `apps/api/migrations/0003_custody-workflow.sql`, `apps/api/src/modules/custody/domain.ts` (state `PENDING_ACCEPTANCE`, `ACTIVE`, `REJECTED`, `CANCELLED`, `RETURNED`), `docs/implementation/ASQ-001-custody-workflow.md` |
| Apakah Aset SQ sudah punya layar Aset Saya? | Ya: `GET /api/v1/my-assets`, `/my-assets/:assetId`, termasuk tombol terima/tolak. Hanya bisa dipakai lewat sesi Aset SQ sendiri (cookie), tidak bisa dipanggil HCIS. | `docs/implementation/ASQ-001-my-assets-self-service.md`, `apps/api/src/modules/self-service/routes.ts` |
| Identitas pegawai apa yang dipakai? | `recipient_person_ref` = `hcis:employee:<uuid>`, yaitu `employees.id` HCIS, didapat dari SQ Hub Organization Directory. Bukan NIP, bukan Keycloak `sub`. | `apps/api/src/modules/directory/sq-hub-directory.ts` (`personId` regex), HCIS `apps/api/src/modules/organization-directory/producer.ts` |
| Apakah ada API mesin untuk HCIS? | **Belum.** Endpoint bearer satu-satunya adalah ringkasan governance (ASQ-003) untuk SQ Hub. Kontrak offboarding baru tercatat sebagai "candidate future contract". | `docs/integrations/sq-ecosystem.md` §4, `apps/api/src/app.ts` (bearer hanya di `/api/v1/governance/summary`) |

Kesimpulan: integrasi read-only cukup, dan yang kurang hanya satu endpoint kecil di Aset SQ. Endpoint itu dispesifikasikan dan dibangun di repo Aset SQ sebagai **ASQ-004**, mengikuti aturan repo tersebut.

## 3. Kontrak lintas aplikasi (ringkasan ASQ-004)

Sumber kebenaran kontrak: Aset SQ `docs/specs/ASQ-004-person-custody-read.md`. Ringkasan untuk konsumen HCIS:

```text
GET {ASET_SQ_BASE_URL}/internal/v1/person-custody/{personRef}
Authorization: Bearer <token client-credentials HCIS>
```

- `personRef` harus `hcis:employee:<uuid>`; selain itu `400`.
- Token: dari realm `sq-staff`, `azp` = client mesin HCIS `hcis-aset-custody`, `aud` memuat `aset-sq-person-custody`. Client ini **khusus** untuk panggilan ini; client mesin HCIS yang lain tidak dipakai ulang.
- Jawaban `200` (`Cache-Control: no-store`):

```json
{
  "personRef": "hcis:employee:6f1c…",
  "generatedAt": "2026-11-02T03:00:00.000Z",
  "clearance": "OUTSTANDING",
  "counts": { "outstanding": 2, "pendingAcceptance": 1, "overdue": 0 },
  "assignments": [
    {
      "assignmentId": "…",
      "assetTag": "SQ-LTP-0012",
      "assetLabel": "Lenovo ThinkPad E14",
      "custodyState": "ACTIVE",
      "checkoutAt": "2026-09-01T02:00:00.000Z",
      "expectedReturnOn": null,
      "overdue": false
    }
  ],
  "selfServiceUrl": "https://aset.sabilulquran.or.id/my-assets"
}
```

- Yang dihitung "masih dipegang" (`outstanding`): custody `ACTIVE` dan `PENDING_ACCEPTANCE`. `PENDING_ACCEPTANCE` ikut dihitung karena barangnya sudah diserahkan dan belum dikembalikan, walau penerima belum mengonfirmasi.
- `overdue`: masih dipegang dan `expectedReturnOn` sebelum hari ini (Asia/Jakarta).
- `clearance` = `CLEAR` bila `outstanding = 0`, selain itu `OUTSTANDING`.
- Pegawai yang tidak dikenal Aset SQ dijawab `CLEAR` dengan daftar kosong. HCIS adalah pemilik data pegawai, jadi tidak ada informasi yang bocor.
- Field yang sengaja **tidak** dikirim: harga, unit pemilik aset, lokasi, catatan serah terima, identitas petugas, sumber/versi directory.

## 4. Asset Saya (pegawai)

**Aktor:** pegawai yang login ke HCIS dan tertaut ke record `employees`.

**Precondition:** sesi HCIS aktif; akun bertipe pegawai dengan `employee_id`. Akun tanpa pegawai (Super Admin, akun layanan) mendapat `404 EMPLOYEE_NOT_LINKED`.

**API HCIS:** `GET /assets/me` (tanpa input; pegawai tidak bisa memilih `employeeId` lain).

**Jawaban:**

| Keadaan | Jawaban HCIS |
| --- | --- |
| Integrasi belum dikonfigurasi di HCIS | `200 { "status": "NOT_CONFIGURED", "selfServiceUrl" }` |
| Aset SQ gagal/timeout/jawaban tidak valid | `200 { "status": "UNAVAILABLE", "selfServiceUrl" }` (bukan 5xx, supaya layar tetap bisa menautkan ke Aset SQ) |
| Berhasil | `200 { "status": "AVAILABLE", "clearance", "counts", "assignments", "selfServiceUrl", "generatedAt" }` |

**Layar `/app/services/assets`:**

- judul "Asset Saya"; ringkasan "Anda memegang N aset", dengan penanda "menunggu konfirmasi" dan "lewat tanggal kembali";
- daftar kartu: kode aset, nama aset, status (Dipegang / Menunggu konfirmasi Anda), tanggal serah terima, tanggal harus kembali;
- tombol **Buka Aset SQ** ke `selfServiceUrl`. Menerima, menolak, dan mengembalikan aset tetap dilakukan di Aset SQ;
- kosong: "Tidak ada aset organisasi yang sedang Anda pegang.";
- tidak tersedia / belum dikonfigurasi: pesan singkat plus tombol Buka Aset SQ;
- loading dan tampilan ponsel diperiksa.

**Pagination (ENG-LIST-001):** pengecualian tertulis. Daftar ini adalah aset yang sedang dipegang **satu** orang, sehingga kecil dan terbatas secara alami. Aset SQ mengembalikan paling banyak 200 penugasan dengan `counts` yang selalu lengkap dan `truncated: true` bila terpotong; layar HCIS lalu menampilkan "Sebagian aset tidak ditampilkan, buka Aset SQ untuk daftar lengkap". Tidak ada pemotongan diam-diam.

## 5. Peringatan aset di Pemberhentian (HC)

**Aktor:** pemegang permission `employment.manage` (yang boleh mencatat Pemberhentian). Tidak ada permission baru.

**API HCIS:** `GET /admin/employees/{employeeId}/assets`.

- `employment.manage` wajib, kalau tidak `403`; pegawai yang tidak ada atau sudah dihapus dari master `404`.
- Jawaban berbentuk sama dengan `/assets/me`.

**Alur:** saat dialog tindakan kepegawaian dibuka dengan jenis **Pemberhentian**, web memanggil endpoint ini. Bila `clearance = OUTSTANDING`, dialog menampilkan peringatan kuning:

> Pegawai ini masih memegang N aset organisasi di Aset SQ (M lewat tanggal kembali). Pemberhentian tetap bisa dicatat. Pastikan aset dikembalikan dan dicatat di Aset SQ.

dengan daftar kode aset dan tautan ke Aset SQ. Bila `UNAVAILABLE`/`NOT_CONFIGURED`: "Status aset di Aset SQ tidak dapat diperiksa saat ini." Dialog tidak pernah gagal karena Aset SQ.

**`DRAFT` — peringatan, bukan penghalang.** Belum ada aturan tertulis bahwa pegawai tidak boleh diberhentikan sebelum aset kembali. Default: peringatan saja; pencatatan Pemberhentian tidak diblokir dan tidak butuh konfirmasi tambahan. Alasan: tanggal keluar adalah fakta kepegawaian yang tidak bisa ditahan oleh status barang, dan pengembalian aset sering terjadi pada hari terakhir. Bila owner menetapkan aturan blokir atau persetujuan khusus, itu perubahan terpisah.

Pratinjau dan pencatatan tindakan (`POST …/employment-actions/preview` dan `POST …/employment-actions`) **tidak** memanggil Aset SQ. Transaksi kepegawaian tidak bergantung pada aplikasi lain.

## 6. Permission dan audit

| Endpoint | Permission | Audit di HCIS |
| --- | --- | --- |
| `GET /assets/me` | sesi pegawai; hanya diri sendiri | tidak ada (membaca data sendiri, bukan transisi state) |
| `GET /admin/employees/{id}/assets` | `employment.manage` | tidak ada (bacaan; tidak ada state yang berubah) |

Aset SQ mencatat setiap panggilan, baik yang dilayani maupun yang ditolak, ke `asset_audit_events` (`person_custody.read_served` / `person_custody.read_denied`, resource = person ref, aktor = service account HCIS). Jadi jejak "siapa membaca aset pegawai X" ada di pemilik datanya.

HCIS tidak me-log isi jawaban, person ref, atau secret; kegagalan dicatat dengan kode singkat saja.

## 7. Konfigurasi HCIS

| Variabel | Isi | Wajib |
| --- | --- | --- |
| `ASET_SQ_PERSON_CUSTODY_URL` | basis URL API Aset SQ yang bisa dijangkau API HCIS, misalnya `http://127.0.0.1:<port>` di Mi8VPS | ya, untuk mengaktifkan |
| `ASET_SQ_MACHINE_CLIENT_ID` | `hcis-aset-custody` | ya, bersama secret |
| `ASET_SQ_MACHINE_CLIENT_SECRET` | secret client di atas, dipasang lewat skrip owner | ya |
| `ASET_SQ_SELF_SERVICE_URL` | tautan publik, default `https://aset.sabilulquran.or.id/my-assets` | tidak |

Issuer token memakai `OIDC_ISSUER` yang sudah ada. Ketiga variabel wajib harus diisi bersama atau tidak sama sekali; setengah terisi menolak start. Client mesin ini tidak boleh sama dengan `SQ_HUB_MACHINE_CLIENT_ID` atau client kanal lain.

Adapter: timeout 5 detik, token di-cache sampai 30 detik sebelum kedaluwarsa, jawaban divalidasi dengan schema ketat (jawaban yang tidak cocok = `UNAVAILABLE`).

## 8. Provisioning Keycloak (owner)

Client baru `hcis-aset-custody` di realm `sq-staff`: confidential, hanya service account, tanpa standard/implicit/direct grant, hardcoded audience mapper `aset-sq-person-custody`, tanpa role realm/client tambahan. Service account-nya **wajib** didaftarkan ke permission FGAP "staff lifecycle: deny service accounts" (D-DRIFT-1, checklist aplikasi baru di `sq-core-ops`).

Langkah ini butuh kata sandi admin Keycloak, jadi dijalankan owner dengan skrip yang disiapkan agent (pratinjau bawaan, `--apply` untuk menjalankan). Sebelum skrip dijalankan, HCIS dan Aset SQ boleh sudah dirilis dengan fitur mati; layar Asset Saya menampilkan keadaan `NOT_CONFIGURED` plus tautan ke Aset SQ.

## 9. Kegagalan

| Kegagalan | Perilaku |
| --- | --- |
| Token tidak bisa diambil (client belum ada, secret salah) | `UNAVAILABLE`; log `ASSET_CUSTODY_TOKEN_FAILED` |
| Aset SQ 401/403 (audience/azp belum cocok) | `UNAVAILABLE`; log status |
| Aset SQ 5xx/timeout | `UNAVAILABLE` |
| Jawaban tidak sesuai schema | `UNAVAILABLE`; log `ASSET_CUSTODY_INVALID_RESPONSE` |
| Pegawai tidak tertaut | `404 EMPLOYEE_NOT_LINKED` (Asset Saya) |

## 10. Di luar lingkup

- Serah terima, konfirmasi, penolakan, dan pengembalian aset: tetap di Aset SQ.
- Blokir Pemberhentian karena aset (lihat `DRAFT` di §5).
- Notifikasi otomatis ke pegawai atau unit aset saat Pemberhentian dicatat (kandidat lanjutan, butuh kontrak event).
- Kartu admin "Asset Pegawai" di katalog modul HCIS: dihapus. Pengelolaan aset ada di Aset SQ, yang sudah muncul di peluncur aplikasi.
- Akses Aplikasi Aset SQ untuk seluruh pegawai: pegawai butuh akses `aset-sq` di SQ Hub untuk menerima/menolak aset di Aset SQ. Itu keputusan pemberian akses di SQ Hub, bukan bagian ASSET-001.

## 11. Acceptance

- Pegawai melihat aset yang sedang dipegangnya di HCIS, tanpa bisa melihat milik orang lain.
- HC melihat peringatan aset di dialog Pemberhentian, dan pencatatan tetap berjalan saat Aset SQ mati.
- Tidak ada tabel aset di database HCIS.
- Test: adapter (sukses, timeout, schema salah, 401), `/assets/me` (tidak tertaut, tidak dikonfigurasi, sukses), `/admin/employees/{id}/assets` (403 tanpa `employment.manage`, 404, sukses), dialog Pemberhentian (peringatan tampil, tidak tersedia), layar Asset Saya (kosong, berisi, tidak tersedia).
- Kontrak di `docs/api/employee-assets.openapi.yaml`.
