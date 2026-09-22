# Payslip Operational Compatibility

**Status:** ACCEPTED  
**Specification:** PAYSLIP-002  
**Extends:** PAYSLIP-001, PAY-001, PAY-002, NOTIF-004  
**Decision date:** 2026-09-21

## Purpose

PAYSLIP-002 membuat alur payslip yang sudah terverifikasi pada PAYSLIP-001 dapat dipakai dengan sumber payroll operasional Yayasan Sabilul Qur'an tanpa membangun payroll calculation engine.

Legacy HCIS dipakai sebagai evidence untuk dua bentuk sumber data yang benar-benar digunakan: payroll pegawai tetap dan honorer. HCIS baru tetap memperlakukan seluruh nilai payroll sebagai **display data hasil import**. Backend tidak menghitung bruto, netto, transport, honor, potongan, pajak, BPJS, atau komponen lain.

## Actor and authorization

- Human Capital operator dapat preview/review/commit hanya dengan effective organization-scoped permission `payslips.import`.
- Publisher dapat publish hanya dengan effective organization-scoped permission `payslips.publish`.
- `human_capital_admin` saat ini memiliki kedua permission tersebut pada organization scope sesuai AUTH-011.
- Super Admin mempertahankan system-administration capability yang sudah ada pada PAYSLIP-001.
- Foundation Board tidak mendapat personal payslip, import, atau publish capability.
- Employee hanya membaca published payslip miliknya sendiri.
- PAYSLIP-002 tidak menambah atau memperluas role/permission.

## Supported import shapes

Satu endpoint preview menerima tiga bentuk CSV.

### 1. Canonical generic

Header tetap:

```text
employee_number,period,lines_json
```

Behavior tetap mengikuti PAYSLIP-001.

### 2. Legacy-compatible pegawai tetap

Format terdeteksi sebagai `tetap` ketika header memuat indikator seperti `GAJI POKOK` atau `TUNJANGAN KINERJA`.

Natural key employee adalah `NIP`, dicocokkan ke `employees.employee_number`.

Kolom nominal minimum yang wajib tersedia:

- `GAJI POKOK`;
- `TOTAL BRUTO GAJI` atau `TOTAL BRUTO`;
- `GAJI NETO` atau `GAJI NETTO`.

Kolom legacy lain yang dikenali sebagai display lines antara lain kelebihan jam, tunjangan, lembur, rapel, potongan, Gaji Neto 80%, dan Gaji Prorata. Nilai dipertahankan sebagai string sumber.

### 3. Legacy-compatible honorer

Format terdeteksi sebagai `honorer` ketika header memuat indikator seperti `VALUE TRANSPORT`, `VALUE HONOR`, atau `JUMLAH JAM MENGAJAR`.

Natural key employee adalah `NIP`, dicocokkan ke `employees.employee_number`.

Kolom nominal minimum yang wajib tersedia:

- `TOTAL PENGHASILAN`;
- `GAJI NETO` atau `GAJI NETTO`.

Kolom legacy lain yang dikenali sebagai display lines antara lain value transport, jumlah kehadiran, value honor, jumlah jam mengajar, total transport, total honor mengajar, pemasukan lainnya, dan potongan. Nilai dipertahankan sebagai string sumber.

## Period resolution

Untuk legacy-compatible CSV:

1. bila baris memiliki `TANGGAL` valid `DD/MM/YYYY`, period diambil dari bulan dan tahun pada baris;
2. bila tidak ada tanggal, operator wajib memasok fallback period `YYYY-MM` pada preview;
3. bila keduanya tidak tersedia, row invalid dan tidak dapat di-commit.

Period tetap disimpan sebagai canonical month/date dan response mengembalikan `YYYY-MM` tanpa timezone shift.

## Delimiter and value handling

- CSV legacy dapat memakai koma atau titik koma sebagai delimiter.
- Header dibandingkan case-insensitively setelah trim.
- Nominal **tidak** diparse menjadi angka.
- Separator ribuan/desimal, simbol mata uang, teks `/hari`, `/jam`, dan formatting lain dipertahankan sebagai string.
- HCIS tidak menjumlahkan, membandingkan, mengoreksi, atau menurunkan nilai payroll.

## Presentation metadata

Setiap batch dan payslip menyimpan `source_format`:

- `generic`;
- `tetap`;
- `honorer`.

Legacy-compatible line dapat membawa `section` presentasi:

- `identity`;
- `income`;
- `deduction`;
- `summary`;
- `other`.

Metadata tersebut hanya untuk layout. Ia tidak memberi semantik perhitungan.

## Workflow

```text
Authorized Human Capital importer
  -> upload CSV
  -> detect generic/tetap/honorer
  -> validate employee + period + required headers + duplicate
  -> persist preview
  -> review rows/errors
  -> commit valid batch as draft
  -> authorized publisher publishes
  -> employee receives in-app notification
  -> employee reads/prints own published payslip
```

Import tetap **tidak** membuat payslip visible kepada employee. Notification hanya dibuat pada publish, bukan pada preview atau commit.

## Employee layout

Published payslip mempunyai presentation yang layak dibaca dan dicetak:

- identitas organisasi;
- judul Slip Gaji dan periode;
- identitas employee dari employee master yang sedang terhubung;
- badge jenis sumber `Tetap`, `Honorer`, atau `Imported`;
- grouped display lines sesuai section;
- aksi `Cetak / Simpan PDF` memakai browser print/save-as-PDF.

Layout legacy dipakai sebagai referensi visual, tetapi PAYSLIP-002 tidak mengadopsi signer/tanda tangan karena belum ada source of truth baru yang menetapkan pejabat penandatangan payslip.

## Admin UX

Halaman pengelolaan payslip harus:

- menjelaskan tiga format import yang didukung;
- menyediakan fallback period untuk CSV legacy;
- menampilkan format yang terdeteksi pada preview dan riwayat batch;
- mempertahankan preview -> commit -> publish;
- tidak menampilkan publish sebagai tindakan aktif bila actor tidak memiliki `payslips.publish`;
- tetap menampilkan validation error sebelum commit.

Katalog modul admin membedakan:

- **Slip Gaji** (PAY-001/PAY-002): available;
- **Payroll** (PAY-003 calculation/reconciliation engine): planned.

## Audit and privacy

PAYSLIP-001 privacy rules tetap berlaku.

- Jangan masukkan salary values atau imported lines ke application log.
- Audit event hanya menyimpan identifier dan summary count yang diperlukan.
- Notification tidak memuat nominal.
- Response payslip tetap private/no-store.
- Published payslip tetap immutable.

## Failure behavior

- format tidak dikenal -> preview gagal;
- required header hilang -> preview gagal dengan pesan kolom yang hilang;
- employee/NIP tidak ditemukan -> row invalid;
- period tidak dapat di-resolve -> row invalid;
- duplicate employee + period dalam batch -> row invalid;
- existing payslip employee + period -> commit conflict seperti PAYSLIP-001;
- batch dengan validation error tidak dapat di-commit;
- publish selain state `committed` ditolak.

## Migration and recovery

Perubahan persistence bersifat additive: kolom `source_format` ditambahkan ke batch dan payslip dengan default `generic`, sehingga seluruh data PAYSLIP-001 existing tetap valid.

Recovery bila deployment belum publish data baru dapat dilakukan dengan rollback aplikasi ke SHA sebelumnya; kolom additive boleh dibiarkan. Setelah data dengan format baru dipublish, jangan drop kolom atau menulis ulang published payslip karena invariant immutability tetap berlaku.

## Acceptance criteria

- PAYSLIP-002-A: canonical generic CSV PAYSLIP-001 tetap diterima tanpa perubahan perilaku.
- PAYSLIP-002-B: CSV tetap legacy dapat dideteksi dan dipreview tanpa menghitung nominal.
- PAYSLIP-002-C: CSV honorer legacy dapat dideteksi dan dipreview tanpa menghitung nominal.
- PAYSLIP-002-D: delimiter koma dan titik koma didukung untuk legacy-compatible CSV.
- PAYSLIP-002-E: legacy period berasal dari `TANGGAL` atau fallback `YYYY-MM`; missing period menjadi validation error.
- PAYSLIP-002-F: preview dan batch history menampilkan source format yang terdeteksi.
- PAYSLIP-002-G: source format dipertahankan sampai published employee read.
- PAYSLIP-002-H: employee tetap hanya dapat membaca published payslip miliknya sendiri.
- PAYSLIP-002-I: publish tetap membutuhkan `payslips.publish` dan menghasilkan NOTIF-004 tanpa nominal.
- PAYSLIP-002-J: employee dapat mencetak/simpan PDF dari layout slip tanpa payroll calculation baru.
- PAYSLIP-002-K: admin catalog membedakan Slip Gaji available dari PAY-003 Payroll planned.
- PAYSLIP-002-L: test mempertahankan opaque-value invariant dan membuktikan fixed/honorer compatibility.
