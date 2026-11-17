# Tunjangan Hari Raya (THR) di PAY-003

**Status:** ACCEPTED untuk implementasi (keputusan bertanda `DRAFT` adalah default agent 2026-11-17, menunggu konfirmasi process owner)  
**Specification:** PAY-003-THR (bagian dari PAY-003)  
**Related:** PAY-003 v1 (`payroll-calculation-v1.md`), PAY-002, PAYSLIP-001, EMP-005, AUTH-011  
**Dasar hukum:** Permenaker 6/2016 tentang THR Keagamaan bagi Pekerja/Buruh di Perusahaan; PP 58/2023 dan PMK 168/2023 untuk PPh21 TER.

THR berada di luar PAY-003 v1 (`payroll-calculation-v1.md` §1.2). Spesifikasi ini menambahkannya sebagai **jenis periode** tersendiri yang memakai lifecycle, izin, laporan, daftar transfer, dan jalur slip yang sama dengan periode gaji bulanan. Tidak ada aturan baru bagi periode bulanan.

## 1. Aturan pokok (Permenaker 6/2016)

| Hal | Aturan | Disimpan sebagai |
|---|---|---|
| Masa kerja ≥ 12 bulan terus-menerus | THR = 1 bulan upah | `THR.fullServiceMonths` = 12 |
| Masa kerja ≥ 1 bulan dan < 12 bulan | THR = masa kerja (bulan) / 12 × 1 bulan upah | `THR.minimumServiceMonths` = 1 |
| Masa kerja < 1 bulan | tidak berhak | — |
| Upah | gaji pokok + tunjangan tetap | penanda katalog `payroll_components.is_thr_wage` |
| Waktu bayar | paling lambat 7 hari sebelum hari raya | `THR.paymentDeadlineDaysBeforeHoliday` = 7 |
| PKWTT yang berakhir ≤ 30 hari sebelum hari raya | tetap berhak | `THR.terminationGraceDays` = 30, `THR.terminationGraceTermCategories` |

Semua angka di atas disimpan sebagai **versi kebijakan `THR`** (bukan konstanta kode), seperti kebijakan statutori lain (`payroll-calculation-v1.md` §10 butir 9). Migration 0162 memuat satu versi awal bertanda `DRAFT` yang berlaku sejak 2026-01-01; perubahan dilakukan dengan menambah versi.

## 2. Keputusan (`DRAFT`, default agent 2026-11-17)

| # | Keputusan | Default |
|---|---|---|
| T1 | Bentuk | Periode terpisah dengan `period_kind = 'THR'` (periode gaji bulanan `REGULAR`). Satu periode per jenis per bulan per legal entity (exclusion constraint diperluas dengan jenis). Periode THR menyimpan `holiday_date` (tanggal hari raya yang diinput HC) dan `holiday_name` (mis. "Idul Fitri 1448 H"). Bulan periode = bulan tanggal bayar. |
| T2 | Tanggal acuan masa kerja | `holiday_date`. Masa kerja = bulan penuh dari TMT (EMP-005, sama dengan MKG) sampai tanggal hari raya. |
| T3 | Tanggal bayar | Harus sebelum hari raya (400 bila tidak) dan tidak lewat batas `paymentDeadlineDaysBeforeHoliday` kebijakan `THR` yang berlaku pada tanggal bayar (`409 PAYROLL_THR_PAY_DATE_LATE`), diperiksa saat periode dibuat — tanggal bayar tidak dapat diubah sesudahnya — dan sekali lagi saat hitung, terhadap kebijakan yang berlaku saat itu. |
| T4 | Populasi | Employment yang aktif pada hari raya, atau berakhir paling lama `terminationGraceDays` sebelumnya bila kategori kontraknya termasuk `terminationGraceTermCategories` (default `TETAP`, `PERCOBAAN` — PKWTT). Kategori kontrak dibaca pada tanggal yang lebih awal dari hari raya dan tanggal berakhir. Hanya kategori dalam `eligibleTermCategories` (default `TETAP`, `PERCOBAAN`, `KONTRAK`). |
| T5 | Honorer / non-tetap | `KONTRAK_HONORER` dan `LEPAS` **dikecualikan** karena tidak ada di `eligibleTermCategories`. Bila kebijakan berversi memasukkannya, baris pegawai itu mendapat blocker `THR_WAGE_BASIS_UNSUPPORTED`: Permenaker 6/2016 menghitung upah pekerja harian dari rata-rata 12 bulan, dan v1 tidak menebaknya. |
| T6 | Upah satu bulan | Satu bulan seperti perhitungan reguler (§5.1 PAY-003) **tanpa input periode** (tanpa lembur, rapel, potongan), dengan kebijakan yang berlaku pada tanggal bayar THR dan profil kompensasi yang berlaku pada tanggal bayar itu (atau pada tanggal berakhirnya employment bila lebih awal; MKG dibaca pada tanggal yang sama), lalu dijumlahkan hanya komponen yang bertanda `is_thr_wage`. Default penanda: `BASIC`, `PERF`, `SPOUSE`, `CHILD`, `FUNC`, `POS`, `SPECIAL_QUAL` — gaji pokok dan tunjangan yang dibayar rutin tanpa bergantung kehadiran, sama dengan daftar tunjangan tetap §10 butir 2. Tidak termasuk kelebihan jam, lembur, tunjangan BPJS, transport, honor, insentif, rapel, dan penyesuaian. |
| T7 | Rumus dan pembulatan | `THR = upah` bila masa kerja ≥ 12 bulan; selain itu `THR = ROUNDUP(upah × masa_kerja / 12)` ke rupiah bulat, dihitung dengan aritmetika bilangan bulat (hasil bagi dan sisa), tanpa pecahan biner. Faktor masa kerja awal (80%) dan prorata **tidak** berlaku; aturan proporsional THR menggantikannya. |
| T8 | Komponen | Kode katalog baru `THR` (EARNING, masuk dasar PPh21, bukan tunjangan tetap BPJS). Potongan cicilan pinjaman pegawai LOAN-001 Paket 2, penyerahan reimbursement REIMB-001 §9, dan tautan kinerja PERF-001 juga tidak diterapkan pada periode THR. Input periode yang boleh diketik di periode THR hanya `ADJUSTMENT` (dengan alasan dan referensi keputusan), menjadi `ADJUST_EARN`/`ADJUST_DEDUCT`. Tidak ada potongan kasbon, BPJS, atau pendidikan anak dari THR; register kasbon menolak periode THR (`PAYROLL_LOAN_NOT_FOR_THR`). |
| T9 | Blocker | Blocker pemetaan dari perhitungan reguler (MKG di luar skala, pendidikan, unit, pola kerja, jabatan, kualifikasi khusus negatif yang belum ditutup penyesuaian), profil hilang, tanggal akhir belum diresolusi, rekening kosong, netto negatif, dan `THR_WAGE_BASIS_UNSUPPORTED`. Pegawai dengan masa kerja < 1 bulan tidak masuk hasil sama sekali (tidak berhak, bukan blocker) dan dihitung pada audit `not_eligible_count`. |
| T10 | PPh21 | THR adalah penghasilan tidak teratur yang dibayar pada bulan itu. Masa pajak = bulan pembayaran; TER bulanan dikenakan atas **jumlah** bruto bulan itu. Laporan PPh21 (§7.2 PAY-003) pada periode mana pun menggabungkan semua periode legal entity yang sama pada bulan itu yang sudah `APPROVED` ke atas (gaji bulanan + THR), per orang. Baris yang memuat THR diberi penanda `INCLUDES_THR`; respons JSON menyebut periode yang digabung. Periode bulan itu yang belum disahkan tidak ikut, dan laporan menyebut jumlahnya (`pendingPeriodCount`) agar pembaca tahu angka belum final. Tabel TER dibaca pada tanggal bayar terakhir di antara periode yang digabung, sehingga laporan sama dari periode mana pun dibuka; pembacaan dicatat pada setiap periode yang digabung. Pengingat tenggat input (REMIND) tidak berlaku untuk periode THR. Perhitungan tahunan Pasal 17 dan bukti potong 1721-A1 (§7.4 PAY-003) membaca periode gaji dan THR satu bulan sebagai satu bulan yang sama; komponen `THR` masuk baris "Tantiem, bonus, gratifikasi, jasa produksi, dan THR". |
| T11 | Lifecycle dan izin | Sama persis dengan periode bulanan (`payroll-calculation-v1.md` §6): hitung, ajukan, kembalikan/sahkan Direktur (tanpa self-approval), konfirmasi bayar, siapkan dan terbitkan slip, buka ulang. Izin dan pembaca angka per orang (§7.3) tidak berubah. "Ambil lembur & kehadiran" tidak ditawarkan untuk periode THR. |
| T12 | Perbandingan | Periode THR dibandingkan dengan periode THR sebelumnya yang sudah disahkan; periode bulanan hanya dengan periode bulanan. |
| T13 | Slip | `payslips.kind` (`REGULAR`/`THR`); satu slip berlaku per pegawai per bulan **per jenis**, sehingga slip THR tidak menggantikan slip gaji bulan yang sama. Slip THR memuat jenis, nama hari raya, tanggal hari raya, masa kerja (bulan), baris THR, dan ringkasan ("THR bersih"). Komit batch impor PAY-001 juga hanya bertabrakan dengan slip `REGULAR`. Daftar slip pegawai menandai slip THR. Surat keterangan penghasilan (DOC-001) hanya membaca slip `REGULAR`: THR bukan penghasilan bulanan rutin (`DRAFT`). |
| T14 | Daftar transfer | Sama dengan periode bulanan; berkas `daftar-transfer-thr-YYYY-MM.csv`. |

## 3. Data

Migration `0162_payroll_thr.sql`:

- `payroll_periods.period_kind` (`REGULAR` default, `THR`), `holiday_date`, `holiday_name`; CHECK: periode THR wajib punya keduanya dan tanggal bayar sebelum hari raya; periode bulanan tidak punya keduanya. Exclusion constraint `payroll_periods_unique_month` diganti `payroll_periods_unique_month_per_kind`.
- `payroll_components.is_thr_wage` + CHECK hanya `EARNING`; komponen baru `THR`.
- `payroll_policy_versions.policy_key` menerima `THR`; satu versi awal `DRAFT`.
- `payslips.kind`; trigger satu-slip-berlaku dan penjaga slip terbit diperbarui agar memperhitungkan jenis.

**Rollback.** Selama belum ada periode THR: `DELETE FROM payroll_policy_versions WHERE policy_key = 'THR'`, kembalikan CHECK `policy_key`, hapus komponen `THR`, kolom `is_thr_wage`, kembalikan exclusion constraint lama, hapus kolom periode, kembalikan fungsi trigger slip (migration 0100) dan hapus `payslips.kind`. Bila sudah ada periode atau slip THR, jangan turunkan skemanya: tarik endpoint pembuatan periode THR dan biarkan kolomnya.

## 4. API

- `POST /payroll/periods` menerima `kind` (`REGULAR` default, `THR`), `holidayDate`, `holidayName`. Untuk THR, `payDate` wajib dan harus sebelum `holidayDate`; `cutoffStart`/`cutoffEnd` tidak dipakai.
- Setiap representasi periode memuat `kind`, `holidayDate`, `holidayName`; `inputRules.manual` untuk periode THR hanya `ADJUSTMENT`.
- `PUT .../inputs` menolak kunci selain `ADJUSTMENT` pada periode THR (`PAYROLL_INPUT_NOT_FOR_THR`); `POST .../inputs/from-attendance` menolak periode THR (`PAYROLL_OPERATION_NOT_FOR_THR`).
- `GET .../pph21` lihat T10.

## 5. Layar

- Daftar periode: formulir "Buat periode" memilih jenis; untuk THR meminta tanggal bayar, tanggal hari raya, dan nama hari raya. Daftar menandai periode THR.
- Layar periode: judul "THR <nama hari raya>", tanggal hari raya; panel input hanya menawarkan penyesuaian.
- Slip pegawai: slip THR diberi label "THR" di daftar dan judul.

## 6. Privasi dan audit

Sama dengan PAY-003 §8: audit `payroll.period.calculated` periode THR memuat agregat (jumlah pegawai, total, `not_eligible_count`), tidak pernah nominal per orang; nama hari raya dan tanggalnya boleh tercatat (`payroll.period.created`).

## 7. Test minimum

- Unit engine: masa kerja 0, 1, 11, 12, 13 bulan; pembulatan proporsional tanpa pecahan biner; komponen yang bukan upah tidak ikut; honorer diblok; penyesuaian; rekening kosong.
- Lifecycle/route: buat periode THR (validasi hari raya dan tanggal bayar), satu THR per bulan di samping periode bulanan, input selain penyesuaian ditolak, operasi kehadiran ditolak, batas 7 hari.
- Integrasi basis data: populasi (aktif, berakhir dalam 30 hari untuk PKWTT, honorer dikecualikan, masa kerja < 1 bulan dikecualikan), slip THR berdampingan dengan slip bulanan, laporan PPh21 gabungan.
