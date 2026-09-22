# Payslip Partial Draft Resolution

**Status:** ACCEPTED  
**Specification:** PAYSLIP-003  
**Extends:** PAYSLIP-001, PAYSLIP-002, PAY-001, PAY-002  
**Decision date:** 2026-09-22

## Purpose

PAYSLIP-003 mengubah error handling import payslip agar baris valid tidak tertahan oleh baris invalid dalam batch yang sama.

HCIS tetap tidak menghitung payroll. Perubahan ini hanya mengatur lifecycle import/review/draft/publish dan koreksi referensi baris sebelum publish.

## Product decision

Batch import tidak lagi bersifat all-or-nothing pada tahap commit draft.

- Baris valid dapat dimasukkan ke draft walaupun batch masih memiliki baris error.
- Baris error tetap tersimpan sebagai **Perlu tindakan** dan tidak menghasilkan payslip draft.
- Operator dapat memperbaiki referensi employee/NIP dan period dari review batch, kemudian memasukkan baris tersebut ke draft.
- Operator dapat memilih **Hapus dari batch** untuk baris yang memang tidak boleh diikutkan.
- Hapus dari batch adalah soft exclusion yang tetap diaudit; row source tidak dihapus secara fisik.
- Publish tetap fail-closed: seluruh row non-excluded harus sudah berhasil masuk draft sebelum batch dapat dipublish.

Dengan demikian, partial draft diperbolehkan; partial publish tanpa penyelesaian eksplisit tidak diperbolehkan.

## Actor and authorization

Tidak ada permission baru.

- Preview, review, koreksi row, exclude row, dan commit valid rows membutuhkan `payslips.import`.
- Publish tetap membutuhkan `payslips.publish`.
- Published payslip tetap immutable.
- Employee tetap hanya membaca published payslip miliknya sendiri.

## Row states

Setiap `payslip_import_rows` memiliki resolution state:

- `pending`: belum masuk draft dan belum dikeluarkan dari batch;
- `drafted`: sudah menghasilkan satu payslip draft;
- `excluded`: dikeluarkan secara eksplisit dari batch oleh operator.

Existing rows sebelum PAYSLIP-003 dimigrasikan dengan default `pending`.

### Pending valid

Row `pending` dengan `validation_errors = []` adalah **Siap draft**.

### Pending invalid

Row `pending` dengan satu atau lebih validation error adalah **Perlu tindakan**.

### Drafted

Row yang berhasil dimasukkan ke draft menyimpan `draft_payslip_id`. Row tersebut tidak dapat diedit atau dihapus dari batch.

### Excluded

Row yang dikeluarkan menyimpan actor dan waktu exclusion. Excluded row tidak menghasilkan payslip dan tidak menghalangi publish.

## Workflow

```text
upload
  -> preview
  -> review
  -> commit semua pending valid row ke draft
       -> valid rows = drafted
       -> invalid rows = tetap pending / Perlu tindakan
  -> untuk setiap pending invalid:
       -> perbaiki NIP/employee + period -> revalidate -> commit ke draft
       OR
       -> Hapus dari batch -> excluded
  -> hanya ketika tidak ada pending row
       -> publish
       -> notification employee
```

Commit dapat dipanggil lebih dari sekali sebelum publish untuk memasukkan row yang baru selesai diperbaiki.

## Editable correction

Review row mendukung koreksi:

- `employeeNumber` / NIP;
- `period` dalam bentuk `YYYY-MM`.

Server wajib melakukan revalidation setelah koreksi:

- employee reference ada;
- period valid;
- imported line payload masih tersedia;
- employee + period tidak duplikat terhadap row non-excluded lain dalam batch;
- employee + period belum mempunyai payslip existing.

Nilai payroll dan `lines` tidak dapat diedit dari review. Bila source row rusak pada komponen nominal/struktur sehingga tidak dapat direvalidasi hanya dengan NIP/period, operator harus memperbaiki source CSV dan upload ulang, atau mengecualikan row tersebut.

## Soft exclusion

`DELETE /admin/payslip-imports/{batchId}/rows/{rowNumber}` berarti **exclude from batch**, bukan hard delete.

Preconditions:

- batch belum published;
- row masih `pending`.

Effects:

- `resolution_status = excluded`;
- `excluded_by_account_id` dan `excluded_at` disimpan;
- row tidak ikut commit/publish;
- audit event dicatat tanpa nominal payroll.

Drafted atau published row tidak dapat di-exclude.

## Commit behavior

`POST /admin/payslip-imports/{batchId}/commit`:

- menerima batch `previewed` atau `committed`, selama belum published;
- hanya memproses row `pending` yang saat itu valid;
- row error tetap pending;
- setiap row yang berhasil menghasilkan payslip draft diubah menjadi `drafted`;
- commit atomic untuk seluruh set pending-valid yang dipilih pada invocation tersebut;
- batch menjadi `committed` setelah minimal satu row berhasil masuk draft;
- invocation berikutnya dapat memasukkan row yang baru diperbaiki.

Jika tidak ada pending-valid row, server mengembalikan conflict yang menjelaskan bahwa tidak ada row siap draft.

## Publish gate

Publish hanya boleh terjadi jika:

- batch berstatus `committed`;
- tidak ada row `pending`;
- minimal satu payslip draft ada untuk batch.

Dengan demikian semua error harus berakhir sebagai:

- fixed -> drafted; atau
- explicitly excluded.

Tidak ada silent skip saat publish.

## Batch counters

API review/list mengembalikan current derived counters:

- `draftedCount`;
- `pendingValidCount`;
- `unresolvedCount`;
- `excludedCount`.

`validCount` dan `errorCount` tetap tersedia untuk compatibility, tetapi UI operasional mengutamakan counter derived di atas.

## Admin UX

Halaman pengelolaan payslip harus:

- menggunakan file picker eksplisit dengan tombol `Pilih file CSV` dan nama file terpilih;
- menampilkan ringkasan status row;
- menyediakan filter `Semua` dan `Perlu tindakan`;
- menampilkan agregasi jenis validation error;
- menyediakan unduh CSV daftar error tanpa salary values;
- menyediakan edit NIP dan period pada row pending-error;
- menyediakan `Simpan perbaikan`;
- menyediakan `Hapus dari batch` dengan konfirmasi;
- menyediakan `Masukkan baris valid ke draft` walau unresolved rows masih ada;
- menonaktifkan Publish sampai `pendingValidCount = 0` dan `unresolvedCount = 0`.

Untuk batch dengan error, review default ke `Perlu tindakan` agar ribuan row valid tidak memenuhi layar.

## Audit and privacy

Audit events baru:

- `payslip.import.row_corrected`;
- `payslip.import.row_excluded`;
- `payslip.import.committed` tetap dipakai per invocation dengan count row yang baru drafted.

Audit payload tidak boleh menyimpan salary values atau imported lines.

Download daftar error hanya memuat row number, employee number/NIP, period, dan pesan validation error.

## Migration and recovery

Migration additive menambahkan metadata resolution ke `payslip_import_rows`.

Existing batch seperti preview yang dibuat sebelum PAYSLIP-003 tetap dapat dilanjutkan:

- seluruh existing row default `pending`;
- validation error existing tetap dipertahankan;
- valid/error state diturunkan dari `validation_errors`.

Rollback aplikasi ke SHA sebelum PAYSLIP-003 aman selama belum ada row `drafted` melalui partial behavior baru. Setelah partial commit dilakukan, jangan memakai aplikasi lama untuk melanjutkan batch tersebut karena aplikasi lama tidak memahami resolution state.

## Acceptance criteria

- PAYSLIP-003-A: batch dengan valid + invalid rows dapat commit seluruh pending-valid rows.
- PAYSLIP-003-B: invalid rows tidak menghasilkan payslip draft dan tetap terlihat sebagai Perlu tindakan.
- PAYSLIP-003-C: correction NIP/period direvalidate server-side.
- PAYSLIP-003-D: corrected valid row dapat dicommit pada invocation berikutnya.
- PAYSLIP-003-E: pending row dapat di-exclude secara audited; drafted row tidak dapat di-exclude.
- PAYSLIP-003-F: publish ditolak selama masih ada pending row.
- PAYSLIP-003-G: publish diperbolehkan setelah semua non-drafted row explicitly excluded dan minimal satu draft ada.
- PAYSLIP-003-H: existing pre-PAYSLIP-003 preview batch tetap dapat diproses tanpa upload ulang.
- PAYSLIP-003-I: UI menampilkan file picker eksplisit, filter error, error summary, dan CSV error export.
- PAYSLIP-003-J: CSV error export tidak memuat nominal payroll.
- PAYSLIP-003-K: authorization dan employee owner-only published access tidak berubah.
