# ADR-0004: Klasifikasi Jabatan Terpisah dari Struktur dan dari Skala Gaji (ORG-011)

- **Status:** PROPOSED
- **Date:** 2026-10-27
- **Related:** ORG-004, ORG-006, ORG-007, EMP-005, EMP-006, PAY-003, AUTH-011; ADR-0001, ADR-0003
- **Evidence:** `docs/domain/job-classification-grade.md`, `docs/domain/payroll-calculation-v1.md`, `apps/api/migrations/0019_dynamic_organization.sql`, `apps/api/migrations/0056_employment_history_foundation.sql`

## Context

Roadmap bagian C meminta HCIS membedakan *position* ORG-004 (struktur, reporting, authority) dari *klasifikasi pekerjaan/kompensasi*, dan melarang tabel grade ad-hoc.

Keadaan sekarang:

- `organization_positions` adalah kursi di dalam change set ORG-004, lengkap dengan authority binding dan vacancy policy. Satu kursi per unit, jadi tidak dapat dipakai sebagai kelas pekerjaan yang dibagi banyak orang.
- `employment_placements` menyimpan `functional_label` dan `structural_label` sebagai teks bebas.
- PAY-003 §3.3 sudah mensyaratkan pemetaan tunjangan fungsional dan jabatan "lewat referensi stabil, bukan label teks", tetapi referensi itu belum ada, sehingga payroll berisiko lahir dengan pencocokan teks.

Pada saat yang sama, PAY-003 sudah menetapkan bahwa skala gaji pokok YSQ ditentukan pendidikan terakhir x MKG, bukan golongan. Memaksa model grade -> nominal akan membuat dua sumber kebenaran untuk gaji.

## Decision

1. Perkenalkan ORG-011: katalog `job_classifications` dan `job_grades`, effective-dated, **di luar** change set ORG-004.
2. Katalog ORG-011 **tidak menyimpan nominal, pengali, atau band gaji**. Nilai uang tetap milik tabel kebijakan berversi PAY-003.
3. Skala gaji pokok tidak berubah: tetap pendidikan terakhir x MKG. Golongan tidak menjadi dasar gaji pokok pada v1.
4. Klasifikasi dan golongan **tidak pernah** memberi approval authority. Authority tetap hanya dari `organization_authority_bindings`.
5. Pengikatan dua lapis: klasifikasi default pada `organization_positions` (ikut change set), override pada `employment_placements` (ikut employment action). Placement menang.
6. Payroll mengonsumsi satu fungsi resolusi `resolveJobClassification(employmentId, onDate)` dan menyimpan hasilnya pada snapshot input periode, sehingga periode yang sudah disahkan kebal terhadap perubahan katalog.
7. Label teks lama tetap ada untuk tampilan, tetapi dilarang menjadi kunci perhitungan setelah ORG-011 aktif.

## Consequences

Positif:

- PAY-003 mendapat kunci stabil sebelum perhitungan tunjangan diimplementasikan, bukan sesudahnya.
- Reorganisasi struktur tidak menerbitkan ulang katalog kompensasi, dan perubahan katalog tidak memaksa change set struktur.
- Tidak ada dua model grade yang bersaing, karena hanya ORG-011 yang boleh mendefinisikan kelas pekerjaan dan hanya PAY-003 yang boleh memegang nominal.
- Riwayat payroll tetap dapat dijelaskan karena semuanya effective-dated dan ter-snapshot.

Negatif atau biaya:

- Dua lapis pengikatan menambah satu aturan resolusi yang harus diuji (placement menang atas position).
- HC harus mengisi katalog dan memetakan label lama secara eksplisit; tidak ada migrasi otomatis dari teks.
- Selama masa transisi, label teks dan klasifikasi hidup berdampingan dan dapat berbeda sampai parallel run selesai.

## Alternatives considered

| Alternatif | Alasan ditolak |
|---|---|
| Pakai `organization_positions` langsung sebagai kelas pekerjaan | kursi bersifat per unit dan membawa authority; tunjangan akan ikut tercampur dengan approval |
| Simpan grade sebagai kolom pada employment | tidak effective-dated sebagai katalog, tidak dapat divalidasi, dan mengulang masalah label teks |
| Grade membawa nominal gaji pokok | bertabrakan dengan skala pendidikan x MKG PAY-003; menciptakan dua sumber kebenaran gaji |
| Tunda sampai payroll selesai | payroll akan terlanjur memakai pencocokan label teks yang dilarang PAY-003 §3.3 |

## Compliance

- Tidak boleh ada kolom nominal, pengali, atau band pada tabel ORG-011.
- Tidak boleh ada pembacaan klasifikasi atau golongan di jalur authorization maupun approval.
- Setiap permission baru ORG-011 wajib automated test.
- Perubahan katalog wajib menghasilkan audit event.
- ADR ini harus `ACCEPTED` sebelum migration ORG-011 dibuat.
