# Payslip MVP

**Status:** VERIFIED MVP BASELINE  
**Specification:** PAYSLIP-001  
**Related:** AUTH-010, ORG-003, SEC-001

## Purpose

Payslip pada MVP adalah dokumen data hasil import. HCIS tidak menghitung payroll dan tidak menurunkan nilai baru dari data payslip.

## Import contract

MVP menerima CSV UTF-8 dengan header tepat:

```text
employee_number,period,lines_json
```

- `employee_number`: natural key employee yang harus sudah ada di employee master.
- `period`: periode tampilan berformat `YYYY-MM`.
- `lines_json`: JSON array non-kosong berisi maksimal 100 object `{ "label": string, "value": string }`.

`label` dan `value` diperlakukan sebagai data tampilan opaque yang berasal dari sumber import. Sistem tidak memberi arti payroll pada label, tidak mengubah `value` menjadi angka, dan tidak menjumlahkan atau menurunkan komponen apa pun.

Contract ini sengaja tidak menetapkan komponen gaji Indonesia, currency, gross/net, pajak, BPJS, overtime, deduction, attendance deduction, atau formula lain. Penambahan semantik payroll membutuhkan specification terpisah.

`period` adalah nilai kalender `YYYY-MM`, bukan timestamp. API harus mengembalikannya sebagai canonical date/month string dan tidak boleh membiarkan konversi timezone menggeser bulan tampilan.

## Workflow

```text
Authorized importer
  -> upload CSV
  -> validate format + employee reference + duplicate employee/period in batch
  -> preview
  -> review detail bila diperlukan
  -> commit as draft
  -> authorized publisher publishes batch
  -> employee can read own published payslip
```

### Preview and review

Preview disimpan sebagai batch agar detail dan validation error dapat direview sebelum keputusan commit/publish. Row invalid tetap tersimpan bersama validation error. Preview tidak membuat payslip yang dapat dibaca employee.

MVP tidak memiliki persisted `reviewed` acknowledgement/state dan commit tidak mensyaratkan transition review terpisah. Membuka detail batch dicatat sebagai `payslip.import.review_opened` untuk audit akses sensitif, bukan sebagai bukti bahwa review formal telah diselesaikan.

### Commit

Commit hanya diizinkan bila batch berstatus `previewed` dan tidak memiliki validation error. Commit membuat draft payslip. Kombinasi employee + period harus unik; existing draft maupun published payslip tidak ditimpa.

Preview persistence, commit, dan publish menggunakan satu PostgreSQL client per transaction. Batch lock, payslip write, batch state update, dan audit event yang menjadi bagian transition harus commit atau rollback sebagai satu unit.

### Publish

Publish hanya diizinkan untuk batch `committed`. Publish membuat draft batch tersebut visible pada employee self-service. Published payslip tidak memiliki route mutation pada MVP dan dilindungi dari UPDATE/DELETE setelah `published_at` terisi.

## Authorization

- `EMPLOYEE`: hanya membaca payslip miliknya sendiri yang sudah published, dan account maupun employee record harus berstatus aktif.
- `FOUNDATION_BOARD`: tidak mendapat akses personal payslip dan tidak mendapat import/publish capability.
- `SUPER_ADMIN`: memiliki explicit system-administration capability untuk import/review/publish, tetapi tidak dianggap employee dan tidak mendapat employee self-view.
- `EMPLOYEE` dengan role tambahan dapat mengakses import/publish hanya bila assignment aktif memuat permission `payslips.import` atau `payslips.publish` **dan** `scope_type='organization'`.
- Assignment `own` atau `unit` tidak memberi hak import/publish organization-wide.

Backend selalu me-resolve `employee_id` self-service dari account session. Client tidak dapat memilih employee ID untuk membaca payslip.

## Privacy and audit

- Semua payslip response menggunakan `Cache-Control: private, no-store` atau `no-store`.
- Sensitive employee read dicatat sebagai `payslip.read`.
- Preview, review-open, commit, dan publish dicatat sebagai audit event.
- Audit payload hanya memuat identifier, period, dan summary count yang diperlukan; `lines` tidak disalin ke audit payload.
- Application logging tidak boleh memasukkan uploaded CSV atau `lines` payslip.

## Foundation Board boundary

Board tetap aggregate-first dan read-only. PAYSLIP-001 tidak menambahkan payroll total, salary trend, personal payslip drill-down, atau payslip mutation ke `/board`. Keberadaan dataset payslip tidak cukup untuk menyimpulkan metrik payroll.

## Verification

Final isolated synthetic browser UAT verified:

- synthetic CSV upload;
- preview and review detail;
- commit to draft;
- draft hidden from employee self-service;
- publish;
- owner self-read after publish;
- cross-employee denial;
- Foundation Board denial;
- published immutability;
- opaque line values without payroll calculation.

The UAT found one period-serialization defect where imported `2026-07` rendered as `2026-06` after a PostgreSQL `DATE` crossed JavaScript timezone conversion. The final MVP patch returns canonical period/date strings and includes a regression test. Visible Edge retest confirmed `2026-07` remains `2026-07`.

## Acceptance criteria

- PAYSLIP-001-A: invalid employee reference gagal validation dan tidak dapat di-commit.
- PAYSLIP-001-B: preview dan draft tidak terlihat employee.
- PAYSLIP-001-C: employee hanya dapat membaca published payslip miliknya sendiri.
- PAYSLIP-001-D: mengetahui UUID payslip employee lain tetap menghasilkan not found.
- PAYSLIP-001-E: employee tidak memiliki mutation route terhadap payslip.
- PAYSLIP-001-F: Foundation Board tidak dapat membaca personal payslip atau menjalankan import/publish. *(Amandemen 2026-11-18, ADR-0008: aturan ini tetap berlaku untuk jalur slip PAY-001/PAY-002 — layar slip pegawai, import, dan publish tetap tertutup bagi Organ Yayasan. Yang dibuka keputusan owner B5 adalah angka hasil payroll per orang dan baris slip periode yang sudah disahkan, lewat route organ `GET /governance/payroll/*` dan permission `payroll.governance.results.read`.)*
- PAYSLIP-001-G: Super Admin tidak memperoleh employee self-view hanya karena privilege administratif.
- PAYSLIP-001-H: import/publish authorization ditegakkan server-side dan employee-role capability membutuhkan organization scope aktif.
- PAYSLIP-001-I: sensitive read, preview, review-open, commit, dan publish diaudit tanpa menyalin isi `lines` ke audit payload.
- PAYSLIP-001-J: tidak ada payroll calculation engine atau derived payroll value pada MVP.
- PAYSLIP-001-K: account employee aktif yang terhubung ke employee inactive/resigned tidak dapat membaca payslip self-service.
- PAYSLIP-001-L: preview/commit/publish transition tidak memakai `pool.query("BEGIN")`; seluruh transaction body berjalan pada satu connected client.
- PAYSLIP-001-M: shell payslip employee menggunakan identitas employee aktif yang terhubung, bukan raw email fallback ketika profil employee tersedia.
- PAYSLIP-001-N: `period` dipertahankan sebagai canonical `YYYY-MM`/date text dan tidak boleh bergeser bulan akibat timezone serialization.
