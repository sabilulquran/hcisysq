# Payslip UX and Print Polish

**Status:** ACCEPTED  
**Specification:** PAYSLIP-004  
**Extends:** PAYSLIP-001, PAYSLIP-002, PAYSLIP-003  
**Decision date:** 2026-09-22

## Purpose

PAYSLIP-004 memperbaiki dua friction operasional yang ditemukan pada production UAT:

1. review import payroll masih terlalu padat dan koreksi massal belum nyaman;
2. employee dengan puluhan slip harus scroll panjang, sedangkan dokumen print terlalu renggang dan dapat jatuh ke dua halaman.

Perubahan ini tidak menambah payroll calculation engine dan tidak mengubah visibility/security payslip.

## Legacy evidence adopted

Legacy HCIS dipakai sebagai reference untuk elemen dokumen berikut:

- penandatangan slip: **Ketua Yayasan**;
- tiga catatan kerahasiaan:
  1. Dokumen ini bersifat RAHASIA dan PRIBADI.
  2. Dilarang menyebarluaskan atau menunjukkan isi dokumen ini kepada pihak yang tidak berwenang.
  3. Segala risiko finansial atau hukum akibat penyalahgunaan dokumen menjadi tanggung jawab pribadi pegawai.
- slip mempunyai area tanda tangan;
- detail gaji disusun rapat dalam pasangan label/nilai agar cocok untuk satu lembar.

Legacy public signature image **tidak** diadopsi ke bundle web baru. Signature image merupakan asset sensitif dan tidak boleh dikembalikan menjadi public static asset.

## Import review workbench

Review batch harus berorientasi pada penyelesaian error, bukan menampilkan seluruh komponen payroll terbuka secara default.

### Row presentation

Kolom utama:

- selector;
- row;
- status;
- NIP/nomor pegawai;
- periode;
- validation issue;
- action.

Imported salary lines disembunyikan di disclosure `Lihat komponen` agar tabel tetap ringkas.

### Bulk selection

Operator dapat:

- memilih beberapa pending rows;
- pilih semua rows pada filter/page saat ini;
- menerapkan satu periode `YYYY-MM` ke rows terpilih;
- menyimpan seluruh perubahan NIP/periode yang sudah diedit dalam satu aksi;
- exclude rows terpilih secara audited.

Drafted/excluded rows tidak editable dan tidak dapat dipilih untuk correction/exclusion.

### Correction CSV

Operator dapat:

- mengunduh correction CSV berisi hanya:
  - `row`;
  - `employee_number`;
  - `period`;
  - `errors`;
- mengedit `employee_number` dan `period` di spreadsheet;
- mengunggah correction CSV;
- client mengirim correction set ke server;
- server tetap melakukan revalidation authoritative.

Correction CSV tidak boleh memuat nominal payroll/imported lines.

## Bulk correction API behavior

Bulk correction menerima maksimal 500 rows per request.

Setiap correction wajib berisi:

- `rowNumber`;
- `employeeNumber`;
- `period` `YYYY-MM`.

Server:

- lock batch dan relevant rows;
- hanya menerima batch non-published;
- hanya mengubah rows dengan `resolution_status = pending`;
- melakukan revalidation yang sama dengan single-row correction;
- tidak mengubah imported `lines`;
- refresh derived counters;
- membuat satu audit event summary tanpa salary value.

Request atomic: bila payload/state invalid secara struktural, seluruh request ditolak. Validation errors hasil revalidation per row disimpan sebagai row state normal.

## Bulk exclusion API behavior

Bulk exclusion menerima maksimal 500 row numbers.

Server:

- hanya menerima pending rows;
- soft-exclude semuanya dalam satu transaction;
- drafted/published rows tidak dapat di-exclude;
- mencatat actor/time dan satu audit summary;
- tidak menghapus row source secara fisik.

## Employee payslip navigation

Daftar vertikal puluhan slip dihapus.

Employee page menggunakan compact selector di atas dokumen:

- input combobox/searchable;
- option menampilkan bulan/tahun + jenis slip;
- tombol `Tampilkan`;
- latest published slip dapat menjadi default selection;
- hanya satu slip dirender pada satu waktu;
- dokumen mendapatkan full available content width.

Employee tetap hanya dapat memilih ID yang berasal dari owner-scoped `GET /payslips`.

## Payslip document header

PAYSLIP-005 supersedes the PAYSLIP-004 split/full-width presentation. Horizontal brand asset existing tetap digunakan, tetapi dokumen kembali dirender sebagai A4 portrait dan header disusun centered: logo -> SLIP GAJI -> periode.

## Signer

PAYSLIP-005 supersedes keputusan signer PAYSLIP-004. Signer utama menjadi **Kepala Human Capital Management**, fallback **Direktur**, dengan self-sign guard terhadap employee pemilik slip. Lihat `docs/domain/payslip-a4-signer-authority.md`.

## One-page print contract

Untuk structured operational payslip `tetap` dan `honorer`, print CSS ditargetkan satu lembar A4 portrait:

- `@page size: A4 portrait`;
- print margin compact;
- padding/section gaps/table row height compact;
- two-pair detail layout;
- notes + signature berada dalam compact footer;
- browser-only controls tidak dicetak;
- document tidak menambah artificial blank page;
- Chromium print receives print-specific scale/zoom safety margin.

Generic imported payslip tetap menampilkan seluruh lines; bila source mempunyai jumlah line ekstrem di luar operational fixed/honorer shape, satu halaman tidak boleh dicapai dengan menghilangkan data.

## Confidentiality notes

PAYSLIP-005 memindahkan tiga note berikut ke luar lembar A4 sebagai guidance UI dan tidak mencetaknya di dokumen:

1. Dokumen ini bersifat **RAHASIA dan PRIBADI**.
2. Dilarang menyebarluaskan atau menunjukkan isi dokumen ini kepada pihak yang tidak berwenang.
3. Segala risiko finansial atau hukum akibat penyalahgunaan dokumen menjadi tanggung jawab pribadi pegawai.

## Authorization and privacy

Tidak ada permission baru.

- bulk correction/exclusion tetap memerlukan `payslips.import`;
- employee owner-only published access tetap berlaku;
- salary lines tidak masuk audit payload;
- correction export tidak berisi salary values;
- signer resolution tidak memperluas Board/payroll access.

## Acceptance criteria

- PAYSLIP-004-A: review rows tidak membuka salary components secara default.
- PAYSLIP-004-B: operator dapat select rows dan bulk-apply period.
- PAYSLIP-004-C: operator dapat menyimpan multiple edited rows dalam satu request.
- PAYSLIP-004-D: correction CSV dapat diunduh, diedit, dan di-upload kembali tanpa nominal payroll.
- PAYSLIP-004-E: operator dapat bulk exclude pending rows; audit tetap ada.
- PAYSLIP-004-F: employee dengan puluhan slip tidak membutuhkan vertical history list.
- PAYSLIP-004-G: searchable selector + Tampilkan memilih owner-scoped published slip.
- PAYSLIP-004-H: kop menggunakan `ysq-logo-white.png`, bukan square mark.
- PAYSLIP-004-I: slip mempunyai compact Ketua Yayasan signature area.
- PAYSLIP-004-J: tiga confidentiality note legacy tampil pada slip.
- PAYSLIP-004-K: fixed/honorer print layout ditargetkan satu lembar A4 dan tidak menghasilkan page kedua hanya karena spacing/footer aplikasi.
- PAYSLIP-004-L: existing PAYSLIP-001/002/003 authorization, immutability, and publish gates tetap berlaku.
