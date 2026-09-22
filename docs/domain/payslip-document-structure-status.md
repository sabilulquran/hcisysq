# Payslip Document Structure and Employment Status

**Status:** ACCEPTED  
**Specification:** PAYSLIP-007  
**Extends:** PAYSLIP-001 through PAYSLIP-006  
**Decision date:** 2026-09-22

## Purpose

PAYSLIP-007 memperjelas struktur slip gaji setelah production UAT:

1. typography pada lembar slip dibatasi maksimum 12 pt;
2. lembar A4 memiliki border standar di seluruh sisi;
3. rincian Penghasilan dan Potongan dipisah menjadi dua kolom domain yang jelas;
4. status pegawai tidak boleh diturunkan dari format import payroll.

## Typography

Di dalam lembar slip:

- ukuran font maksimum 12 pt;
- judul SLIP GAJI = 12 pt;
- body utama 9-10.5 pt;
- section heading 8-9 pt;
- footer/system note 8 pt atau lebih kecil.

Application chrome di luar lembar slip tidak termasuk batas ini.

## Document border

Lembar slip A4 memiliki border standar tipis pada atas, kanan, bawah, dan kiri.

Border tetap terlihat di screen dan print.

## Penghasilan dan Potongan

Untuk structured operational payslip:

- kolom kiri berjudul **PENGHASILAN**;
- kolom kanan berjudul **POTONGAN**;
- row dengan `section = income` hanya tampil di kolom Penghasilan;
- row dengan `section = deduction` hanya tampil di kolom Potongan;
- kedua kolom memiliki tabel label/nilai masing-masing;
- jumlah row tidak perlu sama;
- tidak ada pairing silang income/deduction berdasarkan urutan array.

Contoh potongan yang harus berada di kolom Potongan:
- Potongan Kasbon;
- BPJS;
- Pendidikan Anak;
- Kekurangan Jam.

Summary tetap terpisah:
- Total Bruto/Total Penghasilan;
- Total Potongan;
- Gaji Neto.

Generic payslip tetap dapat menggunakan layout daftar netral karena section source belum tentu tersedia.

## Employment status vs source format

`source_format` adalah metadata teknis import dan hanya boleh digunakan untuk parsing/operational compatibility.

Nilai:
- `generic`;
- `tetap`;
- `honorer`.

Nilai tersebut **bukan** status kepegawaian.

Employee-facing payslip tidak boleh menyimpulkan:
- `source_format = tetap` => Pegawai Tetap;
- non-honorer => Pegawai Tetap.

Label employee-facing berasal dari `employees.employment_status` (master field `STATUS KEPEGAWAIAN`).

Contoh nilai yang dapat muncul dari master:
- Tetap;
- Honorer;
- Kontrak;
- Probation;
- nilai deskriptif lain yang sah di master SDM.

Jika `employment_status` kosong:
- badge status tidak ditampilkan;
- period selector hanya menampilkan periode;
- jangan membuat fallback status berdasarkan source format.

## API contract

Employee payslip summary/detail menambahkan:

`employmentStatus: string | null`

Nilai dibaca dari current employee master untuk employee owner yang sama.

`sourceFormat` tetap dikirim untuk compatibility/internal presentation logic, tetapi tidak digunakan sebagai employee-status label.

## Acceptance criteria

- PAYSLIP-007-A: tidak ada font di dalam lembar slip > 12 pt.
- PAYSLIP-007-B: border luar A4 terlihat pada screen dan print.
- PAYSLIP-007-C: income dan deduction dirender sebagai dua kolom terpisah dengan heading masing-masing.
- PAYSLIP-007-D: Potongan Kasbon, BPJS, Pendidikan Anak, dan Kekurangan Jam tidak muncul di kolom Penghasilan.
- PAYSLIP-007-E: source format tidak lagi menghasilkan label "Pegawai Tetap"/"Honorer" di employee UI.
- PAYSLIP-007-F: employment status berasal dari employee master.
- PAYSLIP-007-G: null employment status tidak menghasilkan label buatan.
- PAYSLIP-007-H: period search dapat memfilter employment status dari master.
- PAYSLIP-007-I: existing signer authority, owner-only access, import workflow, and print parity tetap berlaku.
