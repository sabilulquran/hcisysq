# ORG-015 — Route keputusan untuk Portal Organ Yayasan

**Status:** ACCEPTED (ADR-0012 D4 dan ORGAN-IMPL-001 §4.2, keputusan owner 2026-11-12). Butir bertanda `DRAFT` adalah default agent yang menunggu konfirmasi owner.
**Specification:** ORG-015
**Menutup:** `TBD` di ORG-013-3 ("Jalur token exchange untuk Portal Organ Yayasan berstatus `TBD`").
**Mengamandemen:** ORG-010-E (bearer hanya di route governance). Route keputusan ini adalah pengecualian ketiga, dan satu-satunya yang melakukan mutasi.
**Related:** ORG-010, ORG-013, ORG-014, AUTH-014 §2.11 (jti sekali pakai), APR-001, LEAVE-003-N; SQ Hub ADR-0012, ORGAN-IMPL-001 R2

## Mengapa

Portal Organ Yayasan R1 hanya menampilkan jumlah keputusan yang menunggu, lalu menautkan anggota ke HCIS `/board`. R2 memindahkan layar persetujuan ke portal, sedangkan mesin approval tetap di HCIS (ADR-0012 D3). Untuk itu HCIS perlu menerima keputusan dari portal atas nama anggota, tanpa sesi cookie HCIS.

Keputusan adalah mutasi, jadi ia tidak boleh memakai token baca ringkasan. ORG-013-3 sengaja menolak bearer di `/leave/approvals` sampai ada amandemen yang menetapkan syaratnya. Dokumen ini adalah amandemen itu.

## Yang tidak berubah

- Tidak ada aturan workflow, state, role, atau permission baru. Siapa menyetujui apa tetap berasal dari bagan dan ORG-013.
- `GET /leave/approvals` dan `POST /leave/approvals/:stepId/decision` tetap **hanya menerima sesi cookie**. Keduanya tidak menerima bearer, sekarang maupun nanti.
- Transisi, audit event, concurrency, notifikasi, larangan self-approval, dan pemeriksaan capability APR-001/ORG-013 dipakai ulang apa adanya. Route baru memanggil fungsi keputusan yang sama dengan route cookie.
- Dasbor agregat `/board` dan ORG-010-P tidak berubah.

## Ruang lingkup

Termasuk: langkah approval cuti yang dimiliki **principal akun** (`approver_account_id`), yaitu akun `FOUNDATION_BOARD`.

Tidak termasuk:

- langkah milik principal pegawai. Pengurus bergaji tetap memutuskan di HCIS dengan sesi cookie (ORGAN-IMPL-001 §4.2);
- workflow selain cuti. Perjalanan dinas, pinjaman, pengaturan kerja, lembur, dan penilaian kinerja tidak ikut;
- penundaan cuti (`/leave/approvals/:stepId/postpone`) dan koreksi HC;
- snapshot bulanan R3, yang memakai client mesin tersendiri.

## ORG-015-1 Audience dan client

| Hal | Nilai |
|---|---|
| Audience | `hcis-organ-decision`, terpisah dari `GOVERNANCE_SUMMARY_AUDIENCE` dan tidak pernah menjadi default scope |
| `azp` yang diterima | Hanya client portal, yaitu `sq-organ` (`GOVERNANCE_DECISION_ALLOWED_CLIENTS`, bawaan `sq-organ`). `sq-hub` selalu ditolak |
| Flag | `GOVERNANCE_DECISIONS_ENABLED`, bawaan `false`. Mati berarti kedua route menjawab `404` sebelum apa pun dibaca. Route tetap terdaftar agar tercakup gate route AUTH-011 |

Audience ini milik client Keycloak tanpa alur login, dibuat hanya agar ada audience yang dapat dituju. Ia tidak pernah dipakai untuk masuk.

Token ringkasan tidak pernah diterima di sini, dan token keputusan tidak pernah diterima di `/governance/summary` atau `/governance/employees`, karena `aud` keduanya berbeda.

## ORG-015-2 Syarat token

Selain seluruh pemeriksaan ORG-010 §3.2 (tanda tangan RS256, issuer, `exp`/`nbf` dengan toleransi 30 detik, `typ = Bearer`, `sub` ada), token keputusan harus memenuhi:

1. **`aud`** memuat `hcis-organ-decision`; selain itu `403 FORBIDDEN_AUDIENCE`.
2. **`azp`** ada di allowlist; selain itu `403 FORBIDDEN_CLIENT`.
3. **`acr = "2"`** (`DRAFT`), yaitu Level of Authentication yang hanya dicapai dengan TOTP. Trusted device (HUB-IMPL-012) dan recovery code tidak memenuhinya. Tanpa itu `403 STEP_UP_REQUIRED`.
4. **Umur** dari `iat` paling lama **60 detik**, diukur dengan toleransi jam yang sama. Lebih tua dari itu `401 TOKEN_TOO_OLD`, meskipun `exp`-nya belum lewat.
5. **`jti`** ada dan **dibelanjakan sekali pakai**. Presentasi kedua dengan `jti` yang sama `409 DECISION_TOKEN_SPENT`.

Pembelanjaan `jti` memakai tabel `auth_actor_assertions` dan fungsi `spendActorAssertion` yang sudah ada (AUTH-014 §2.11), dengan binding method dan path route ini. Alasannya: mekanismenya sudah terbukti, penyapuan baris kedaluwarsa sudah benar, dan tidak ada tabel baru yang perlu dirawat. Satu token adalah satu percobaan: token tetap terbakar walaupun keputusannya kemudian ditolak.

Urutan pemeriksaan: token diverifikasi dan `jti` dibelanjakan **sebelum** langkah dibaca, sehingga token yang terekam tidak dapat dicoba berulang kali terhadap langkah yang berbeda.

## ORG-015-3 Route

### `GET /governance/decisions`

Langkah `pending` milik akun pemanggil, pada pengajuan berstatus `in_review`. Isinya mengikuti batas data ORG-013-3:

| Field | Isi |
|---|---|
| `stepId`, `requestId` | id langkah dan pengajuan |
| `kind` | jenis pengajuan (`policyKey`) |
| `requester` | `name`, `positionLabel` (jabatan struktural, fungsional, atau nama jabatan), `unitName` |
| `period` | `startOn`, `endOn`, `workingDays` |
| `reason` | alasan pengajuan |
| `submittedAt` | waktu pengajuan |
| `history` | daftar langkah: `order`, `status`, `decidedAt`, `approverRole` |

`approverRole` berasal dari `sources` langkah itu ("Atasan langsung", "Penyetuju unit", "Organ Yayasan"), bukan dari orang yang memegangnya. Langkah tidak menyimpan jabatan approver, dan mencarinya ke data pegawai akan membuka nama yang justru dilarang di sini.

Yang tidak pernah dikembalikan: `decision_note` approver lain, lampiran, kontak, data payroll, dan nama approver lain.

Jawaban memakai `Cache-Control: private, no-store`. Pemanggil yang tidak punya langkah mendapat daftar kosong, bukan `403`.

### `POST /governance/decisions/:stepId`

Body:

```ts
{ decision: "approve" | "reject", note?: string, requestId: string /* uuid */ }
```

`note` dibatasi sama panjang dengan route cookie dan hanya tersimpan sebagai `decision_note` langkah itu sendiri.

| Keadaan | Jawaban |
|---|---|
| Diputuskan | `200` dengan status langkah dan status pengajuan sesudahnya |
| `requestId` sama dengan yang memutuskan langkah ini | `200`, hasil keputusan pertama diulang. Tidak ada keputusan kedua |
| Langkah sudah diputuskan oleh `requestId` lain | `409 APPROVAL_STEP_DECIDED` |
| Pemanggil bukan akun `FOUNDATION_BOARD` | `403 NOT_FOUNDATION_BOARD`, sebelum token dibelanjakan |
| Langkah bukan milik pemanggil | `403 APPROVAL_FORBIDDEN` |
| Pemanggil kehilangan `leave.governance.approve` | `403 APPROVAL_FORBIDDEN`, kode yang sama dengan route sesi |
| Pemohon adalah orang yang sama (ORG-013-1 butir 4) | `403 APPROVAL_SELF_FORBIDDEN` |
| Langkah tidak ada | `404 APPROVAL_STEP_NOT_FOUND` |
| Pengajuan sedang dikunci | `409 LEAVE_REQUEST_BUSY` |

### Idempotency

`leave_request_approval_steps` mendapat satu kolom baru `decision_request_id uuid`, diisi bersamaan dengan keputusan dari route ini. Kolom kosong untuk keputusan lewat sesi cookie dan untuk baris lama.

Replay diputuskan dari kolom itu di dalam transaksi yang sama, setelah `FOR UPDATE`, sehingga dua permintaan serentak dengan `requestId` sama menghasilkan satu keputusan dan satu audit event.

Replay tidak membutuhkan token yang sama: `jti` token pertama sudah terbakar, jadi portal mengirim ulang dengan token baru dan `requestId` lama. Inilah yang membuat kirim ulang aman ketika hasil permintaan pertama tidak sampai ke portal.

Jawaban replay berisi keadaan langkah dan pengajuan itu sekarang, bukan rekaman jawaban pertama: itulah hasil keputusan tersebut. Dua field yang hanya bermakna pada saat keputusan dibuat, yaitu status tugas HC dan status telaah periode kritis, dikembalikan `null` dan tidak dihitung ulang.

Replay sengaja diperiksa sebelum capability dan larangan self-approval. Keputusannya sudah terjadi dan sudah tercatat; membacanya ulang tidak boleh bergantung pada capability yang mungkin sudah dicabut sesudahnya.

## ORG-015-4 Identitas dan izin

1. Token dipetakan ke akun lewat `identity_issuer` + `identity_subject`, sama seperti ORG-010. Tidak pernah lewat email atau nama.
2. Akun harus `active` dan ber-`principal_type` `FOUNDATION_BOARD`. Akun `EMPLOYEE` mendapat `403`: pegawai memutuskan dengan sesi cookie.
3. Akun harus memegang `leave.governance.approve` yang efektif pada tanggal keputusan (ORG-013-1 butir 3). Diperiksa ulang di dalam transaksi keputusan, bukan hanya saat daftar dibuka.
4. Application Access ke HCIS diperiksa ulang ke SQ Hub, sama seperti `/governance/summary`. Keanggotaan organ dan Application Access `organ` dijaga portal di sisinya sendiri.
5. Larangan self-approval memakai `governanceActorIsRequester` yang sudah ada, termasuk pencocokan email ORG-013-1 butir 4.

Kepemilikan jabatan tidak pernah memberi capability, dan portal tidak pernah menilai izin apa pun.

## Audit

- Keputusan memakai audit APR-001 yang sudah ada, dengan `actor_account_id` akun organ. Tidak ada event baru untuk keputusannya.
- Pembelanjaan token tercatat di `auth_actor_assertions` dengan method, path, dan `actor_account_id`.
- Penolakan token dicatat seperti ORG-010: `governance.decision.denied` di `auth_audit_events`, berisi kode saja, tanpa klaim token.
- Keberhasilan dicatat sebagai `governance.decision.served`, berisi kode saja.

## Data, migrasi, dan rollback

| Migrasi | Isi |
|---|---|
| `0166_leave_decision_request_id.sql` | Kolom `uuid` nullable `decision_request_id` pada `leave_request_approval_steps`. Tambahan, tidak dirujuk tabel lain |

Rollback: matikan `GOVERNANCE_DECISIONS_ENABLED`, lalu portal kembali menautkan ke `/board` (ORG-013-3 amandemen 2026-11-13). Kolom boleh dibiarkan.

## Test wajib

- token ringkasan (`aud` HCIS) ditolak `403` di route keputusan, dan token keputusan ditolak `403` di `/governance/summary` serta `/governance/employees`;
- `azp = sq-hub` ditolak `403 FORBIDDEN_CLIENT`;
- token tanpa `acr`, atau `acr` selain `"2"`, ditolak `403 STEP_UP_REQUIRED`;
- token dengan `iat` 61 detik lalu ditolak `401 TOKEN_TOO_OLD` walaupun belum kedaluwarsa;
- token yang sama dipakai dua kali: yang kedua `409 DECISION_TOKEN_SPENT`, dan tidak ada keputusan kedua;
- `jti` terbakar walaupun keputusannya berakhir `403` atau `404`;
- `requestId` sama dikirim ulang dengan token baru mengembalikan hasil pertama, dengan satu audit event dan satu notifikasi;
- `requestId` berbeda pada langkah yang sudah diputuskan mendapat `409`;
- langkah milik akun lain `403`; langkah milik pegawai `403`;
- akun yang kehilangan `governance_leave_approver` mendapat `403` walaupun langkahnya masih miliknya;
- self-approval lewat akun, `employee_id`, atau email yang sama ditolak saat keputusan;
- `GET` tidak memuat `decision_note` approver lain maupun nama approver lain;
- cookie HCIS yang sah tidak diterima di route ini, dan bearer tetap ditolak di `/leave/approvals` (test ORG-013 yang ada diperbarui dan menyebut pengecualian ini);
- `GOVERNANCE_DECISIONS_ENABLED=false` membuat kedua route `404`, dan konfigurasi tanpa audience sendiri ditolak saat start;
- `FOUNDATION_BOARD` tetap `403` di `/app` dan `/admin`.

## Acceptance criteria

- ORG-015-A: keputusan dari portal hanya diterima dengan token ber-`aud` `hcis-organ-decision`, `azp` client portal, `acr = "2"`, umur `iat` ≤ 60 detik, dan `jti` yang belum terpakai. Gagal satu syarat berarti tidak ada keputusan.
- ORG-015-B: aturan siapa boleh menyetujui, larangan self-approval, transisi, audit, dan notifikasi identik dengan route sesi cookie, karena keduanya memanggil fungsi yang sama.
- ORG-015-C: kirim ulang dengan `requestId` yang sama tidak pernah menghasilkan keputusan atau notifikasi kedua, dan `requestId` lain pada langkah yang sudah diputuskan mendapat `409`.
- ORG-015-D: daftar dan keputusan tidak membocorkan catatan approver lain, lampiran, atau data payroll.
- ORG-015-E: mematikan flag mengembalikan keadaan R1 tanpa perubahan di modul cuti.
