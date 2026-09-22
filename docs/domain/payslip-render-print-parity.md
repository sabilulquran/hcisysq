# Payslip Render and Print Parity

**Status:** ACCEPTED  
**Specification:** PAYSLIP-006  
**Extends:** PAYSLIP-005  
**Decision date:** 2026-09-22

## Purpose

PAYSLIP-006 menutup final visual gaps dari production UAT pada employee payslip:

1. logo dokumen terlalu kecil;
2. signature block perlu berada di sisi kiri;
3. automatic footer copy terlalu panjang;
4. print preview mengecilkan typography/spacing sehingga tidak menyerupai A4 render di web;
5. period selector terisi otomatis sehingga user tidak benar-benar menggunakan dropdown.

## Document logo

Horizontal Yayasan logo tetap digunakan.

Pada screen A4, visual height logo dinaikkan kira-kira 2x dari PAYSLIP-005, dengan width tetap auto agar aspect ratio asset tidak berubah.

Print tidak memiliki logo-size override yang berbeda dari screen.

## Signature placement

Signature block berada di sisi kiri bawah dokumen.

Signer authority tetap PAYSLIP-005:

- Kepala Human Capital Management;
- fallback Direktur;
- self-sign guard tetap berlaku.

## Automatic footer

Footer system copy persis:

`Dibuat otomatis oleh HCIS Sabilul Qur'an.`

Tidak ada kalimat tambahan mengenai sumber payroll atau kalkulasi di lembar slip.

## Period selector initial state

Saat halaman pertama kali dibuka:

- selector text kosong;
- tidak ada payslip yang dipilih otomatis;
- tidak ada detail slip yang dimuat otomatis;
- fokus/click pada selector menampilkan semua published payslip milik employee;
- setelah employee memilih option, tombol `Tampilkan` memuat slip tersebut.

Latest slip tidak lagi menjadi default selection.

## Screen A4

Screen document menggunakan silhouette A4 portrait:

- centered;
- width maksimal 210 mm;
- minimum height 297 mm;
- typography/spacing menjadi canonical visual source untuk print.

## Print parity

Print memakai markup dan typography yang sama dengan screen.

Print-specific CSS hanya boleh:

- menetapkan A4 portrait page;
- menyembunyikan application chrome/control;
- memosisikan lembar A4 pada page;
- menghapus screen-only shadow/border radius;
- mempertahankan print background color.

Print-specific CSS tidak boleh lagi mengecilkan:

- font size;
- line height;
- logo;
- section padding;
- row spacing;
- signature spacing.

Dengan demikian print preview harus secara visual menyerupai A4 render di web.

## PAYSLIP-007 supersession

PAYSLIP-007 supersedes employee-facing source-format labels and refines the internal document detail layout into explicit Penghasilan/Potongan columns. PAYSLIP-006 print parity and selector behavior otherwise remain unchanged.

## Acceptance criteria

- PAYSLIP-006-A: horizontal logo terlihat kira-kira 2x lebih besar dibanding PAYSLIP-005.
- PAYSLIP-006-B: signature block berada di sisi kiri.
- PAYSLIP-006-C: automatic footer hanya berisi `Dibuat otomatis oleh HCIS Sabilul Qur'an.`
- PAYSLIP-006-D: selector period default kosong.
- PAYSLIP-006-E: halaman tidak auto-load latest payslip.
- PAYSLIP-006-F: focus pada selector kosong menampilkan seluruh option.
- PAYSLIP-006-G: print tidak mempunyai typography/spacing shrink overrides yang berbeda dari screen.
- PAYSLIP-006-H: existing signer authority, owner-only access, print A4, and confidentiality guidance remain unchanged.
