# ORG-014 — Daftar pegawai untuk Organ Yayasan

**Status:** ACCEPTED (keputusan owner 2026-11-13). Field yang ditampilkan adalah default agent `DRAFT` dan menunggu konfirmasi owner.
**Specification:** ORG-014
**Mengamandemen:** ORG-003-C ("named employee drill-down is out of scope unless a later permission decision explicitly authorizes it"). Inilah keputusan izin tersebut.
**Related:** ORG-003, ORG-010 (bearer, `board.read`), ORG-013, SQ Hub ORGAN-IMPL-001 (Portal Organ Yayasan)

## Keputusan owner

Pada 2026-11-13, saat melihat Portal Organ, owner meminta dua hal:

1. Tautan "Lihat rincian" tetap berada di `organ.sabilulquran.or.id` dan tidak berpindah ke HCIS `/board`.
2. Organ Yayasan bisa melihat daftar lengkap nama pegawai dengan informasi seperlunya, tanpa menampilkan semua data.

## Siapa

Siapa pun yang memiliki board access (ORG-010 §1.3): akun `FOUNDATION_BOARD` yang aktif, atau `EMPLOYEE` yang aktif dengan `board.read` yang efektif. Tidak ada permission baru.

## Field yang ditampilkan (`DRAFT`)

Hanya pegawai berstatus `active`. Field yang dikembalikan:

| Field | Sumber |
|---|---|
| Nama | `employees.full_name` |
| NIP | `employees.employee_number` |
| Unit | `organizational_units.name` |
| Jabatan | `structural_position`, bila kosong `functional_position`, bila kosong `positions.name` |
| Status kepegawaian | `employees.employment_status` |
| Mulai bekerja | `employees.started_on` |

Yang **tidak** pernah dikembalikan:

- email, telepon, pendidikan, tanggal lahir, nomor identitas, alamat, dan rekening;
- dokumen, presensi, cuti, dan slip gaji;
- payroll dalam bentuk apa pun (ORG-003-F dan ADR-0003 tetap berlaku);
- catatan internal HC dan `management_scope`.

## Endpoint

`GET /governance/employees?page=&pageSize=&q=&unitId=`

- Autentikasinya sama dengan `/governance/summary` (ORG-010 §3): satu bearer hasil token exchange, dengan `aud` = `GOVERNANCE_SUMMARY_AUDIENCE` dan `azp` yang ada di `GOVERNANCE_SUMMARY_ALLOWED_CLIENTS`. Akun harus terpetakan, aktif, dan punya board access. Application Access diperiksa ulang di SQ Hub. Cookie tidak pernah diterima.
- ENG-LIST-001:
  - pagination di server, `pageSize` bawaan 25 dan maksimal 100, dengan `total`;
  - pencarian `q` (2–80 karakter) atas nama dan NIP;
  - filter `unitId`;
  - semua filter dijalankan sebelum `LIMIT`;
  - urutan nama, lalu NIP.
- Respons:
  - `{ items: [{ fullName, employeeNumber, unitName, position, employmentStatus, startedOn }], pagination, units: [{ id, name }] }`;
  - `units` berisi unit aktif yang memiliki pegawai aktif, untuk dropdown filter;
  - `Cache-Control: private, no-store`.
- `GOVERNANCE_SUMMARY_ENABLED=false` membuat endpoint ini 404, sama seperti ringkasan.

## Audit

Setiap permintaan yang dilayani menulis `governance.employees.listed` ke `auth_audit_events` dengan akun peminta. Kode `reason_code` dipakai untuk penolakan, sama seperti ringkasan. Isi daftar, kata pencarian, dan token tidak ditulis ke audit maupun log.

## Galat

Sama dengan ringkasan (ORG-010 §7): `401` untuk token tidak ada atau tidak sah, `403` untuk audience, client, pemetaan akun, status akun, board access, atau Application Access, `503` bila Application Access atau kunci penandatangan tidak tersedia, dan `400` untuk parameter tidak sah.

## Konsumen

Portal Organ Yayasan (SQ Hub ORGAN-IMPL-001 §3.1) memanggil endpoint ini atas nama anggota dengan token exchange yang sama seperti ringkasan, lalu menampilkannya di halaman "Rincian SDM" di `organ.`. Portal tidak menyimpan daftar ini.

## Acceptance criteria

- ORG-014-A: hanya principal dengan board access yang mendapat daftar. Yang lain mendapat `403` dan audit penolakan.
- ORG-014-B: daftar hanya berisi pegawai `active`, dengan enam field di atas dan tidak ada field lain.
- ORG-014-C: pagination, pencarian, dan filter unit dijalankan di server sebelum `LIMIT`, dengan `pageSize` maksimal 100.
- ORG-014-D: setiap permintaan yang dilayani tercatat sebagai `governance.employees.listed` tanpa isi daftar.
- ORG-014-E: endpoint mati bila `GOVERNANCE_SUMMARY_ENABLED` tidak `true`, dan tidak pernah menerima cookie.
