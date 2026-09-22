# Payslip A4 Presentation and Signer Authority

**Status:** ACCEPTED  
**Specification:** PAYSLIP-005  
**Extends:** PAYSLIP-001, PAYSLIP-002, PAYSLIP-003, PAYSLIP-004  
**Decision date:** 2026-09-22

## Purpose

PAYSLIP-005 mengoreksi arah presentasi slip setelah production UAT:

1. slip pada layar harus tetap terasa sebagai dokumen A4, bukan card dashboard full-width;
2. header dokumen harus berurutan logo -> SLIP GAJI -> periode;
3. pilihan periode harus searchable sekaligus menampilkan daftar pilihan yang terlihat;
4. catatan kerahasiaan tetap tersedia untuk employee, tetapi berada di luar lembar slip;
5. authority penandatangan mengikuti proses payroll Yayasan, bukan asumsi legacy Ketua Yayasan.

Perubahan ini tidak mengubah payroll calculation, visibility, publish gate, atau ownership access.

## Signer authority decision

Payroll diolah oleh Human Capital Management. Keuangan hanya mengeksekusi pembayaran hasil payroll melalui kanal pembayaran.

Karena itu authority penandatangan slip ditetapkan:

1. **Kepala Human Capital Management** sebagai penandatangan utama;
2. **Direktur** sebagai fallback;
3. bila payslip adalah milik incumbent Kepala Human Capital Management sendiri, Kepala HCM tidak boleh menandatangani slipnya sendiri dan sistem langsung fallback ke Direktur;
4. bila candidate fallback Direktur juga sama dengan employee pemilik slip, candidate tersebut juga tidak boleh self-sign;
5. bila tidak ada incumbent aktif yang eligible, area tanda tangan tetap tampil dengan keterangan **Pejabat penandatangan belum ditetapkan**.

Tidak ada nama yang ditebak.

## Signer resolution

Resolver menggunakan effective published organization snapshot terlebih dahulu.

### Kepala Human Capital Management

Candidate cocok bila salah satu kondisi berikut terpenuhi:

- normalized position title = `kepala human capital management`; atau
- normalized position title = `kepala` dan normalized organization node name = `human capital management`.

Candidate harus:

- berasal dari latest effective PUBLISHED organization change set;
- position active/effective;
- incumbency PRIMARY/ACTING effective;
- employee active.

Jika dynamic organization tidak menemukan candidate, fallback employee master boleh digunakan:

- position/structural position = `Kepala Human Capital Management`; atau
- position = `Kepala` dan organizational unit = `Human Capital Management`.

### Direktur

Candidate cocok bila normalized position title = `direktur`.

Jika dynamic organization tidak menemukan candidate, fallback employee master boleh memakai position/structural position `Direktur`.

### Self-sign guard

Resolver menerima `payslipOwnerEmployeeId`.

- candidate dengan employee id yang sama dengan payslip owner tidak eligible;
- primary HCM self-match memicu pencarian Direktur;
- Director self-match menghasilkan signer unassigned;
- query tidak boleh mengganti owner payslip atau memperluas access.

## API contract

Payslip detail response:

```text
signer:
  title: "Kepala Human Capital Management" | "Direktur"
  name: string | null
```

Jika tidak ada eligible signer, `name = null`.

## Employee navigation

Employee page menggunakan custom searchable combobox:

- fokus pada input menampilkan daftar pilihan;
- pilihan dapat difilter dengan mengetik bulan, tahun, atau jenis slip;
- option tetap terlihat dalam dropdown scrollable;
- klik option memilih slip;
- tombol `Tampilkan` merender hanya slip yang dipilih;
- latest published slip dapat tetap menjadi initial selection.

Native datalist-only interaction tidak digunakan karena daftar pilihan tidak cukup eksplisit pada semua browser.

## Confidentiality notice

Tiga catatan PAYSLIP-004 tetap dipertahankan, tetapi dipindahkan ke luar dokumen A4, di atas selector:

1. Dokumen ini bersifat RAHASIA dan PRIBADI.
2. Dilarang menyebarluaskan atau menunjukkan isi dokumen ini kepada pihak yang tidak berwenang.
3. Segala risiko finansial atau hukum akibat penyalahgunaan dokumen menjadi tanggung jawab pribadi pegawai.

Catatan ini adalah guidance UI dan tidak menjadi bagian lembar slip yang dicetak.

## A4 screen contract

Slip di layar dirender sebagai lembar A4 portrait:

- centered;
- maximum width 210 mm;
- minimum visual height 297 mm pada desktop;
- responsive downscale pada viewport kecil;
- white document surface dengan shadow tipis di screen.

Header dokumen berada di tengah:

```text
[horizontal Yayasan logo]
SLIP GAJI
Periode <bulan tahun>
[jenis slip]
```

Horizontal logo existing tetap digunakan. Tidak ada split header logo-kiri/title-kanan.

## Print contract

Print tetap A4 portrait satu lembar untuk operational `tetap`/`honorer` normal:

- `@page size: A4 portrait`;
- compact print margin;
- screen minimum A4 height tidak dipaksakan saat print;
- confidentiality notice dan selector tidak dicetak;
- signature tetap dicetak;
- spacing detail cukup rapat;
- tidak menggunakan artificial width > 100% atau oversized zoom yang dapat memicu halaman tambahan.

Generic payslip dengan line ekstrem tetap tidak boleh kehilangan data demi memaksa satu halaman.

## Acceptance criteria

- PAYSLIP-005-A: screen document centered dengan silhouette A4 portrait.
- PAYSLIP-005-B: header berurutan horizontal logo, SLIP GAJI, periode.
- PAYSLIP-005-C: searchable selector menunjukkan pilihan nyata saat fokus/typing.
- PAYSLIP-005-D: confidentiality notes berada di luar lembar slip dan tidak ikut print.
- PAYSLIP-005-E: primary signer adalah Kepala Human Capital Management.
- PAYSLIP-005-F: Director dipakai bila HCM tidak tersedia.
- PAYSLIP-005-G: slip milik Kepala HCM fallback ke Director dan tidak self-sign.
- PAYSLIP-005-H: Director juga tidak boleh self-sign.
- PAYSLIP-005-I: signer yang tidak tersedia menampilkan placeholder, bukan nama tebakan.
- PAYSLIP-005-J: existing owner-only payslip access dan audit read tetap berlaku.
- PAYSLIP-005-K: operational print layout tidak menambah page kedua karena screen A4 sizing atau notes di luar dokumen.
