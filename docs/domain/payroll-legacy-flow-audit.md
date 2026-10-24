# Audit Alur Payroll Legacy (Google Sheets) dan Arah Efisiensi HCIS

**Status:** DISCOVERY / AUDIT  
**Specification:** PAY-003 (lampiran discovery)  
**Tanggal audit:** 2026-10-23  
**Related:** PAY-001, PAY-002, PAY-003, PAYSLIP-001..006, ATT-007, LEAVE-001  
**Lanjutan:** `docs/domain/payroll-calculation-v1.md` (PAY-003 v1, DRAFT), ADR-0003 (PROPOSED)  
**Keputusan owner (2026-10-23):** HCIS akan **menghitung** payroll (bukan hanya impor slip). Keputusan ini mengubah batas MVP di `AGENTS.md` §5 dan `docs/product/mvp.md`; perubahan batas tersebut wajib dituangkan dalam ADR sebelum implementasi.

Dokumen ini merekam alur payroll yang berjalan saat ini, hasil audit (akurasi, kontrol, keamanan, efisiensi), dan usulan alur HCIS. Dokumen ini **tidak** memuat data pegawai, nominal gaji perorangan, nomor rekening, atau kredensial. Nilai parameter kebijakan (tarif, persentase, ambang) dicantumkan sebagai bukti discovery dan tetap berstatus `DISCOVERY` sampai disahkan process owner.

## 1. Sumber yang diaudit

| Sumber | Peran |
|---|---|
| Spreadsheet **Input PG & Lembur** | Input bulanan: lembur, kinerja & jam/pekan, potongan BPJS tambahan, kasbon (oleh keuangan), potongan pendidikan anak, rekap potongan, potongan honorer. |
| Spreadsheet **Payroll SDM YSQ** (file utama) | Master SDM (IMPORTRANGE dari Masterdata Pangkalan Data Pegawai), parameter `FORMULA GAJI`, perhitungan `DATA OLAHAN GAJI` / `OlahanGajiHonorer`, histori `PAYROLL` / `Gaji Honorer`, daftar transfer `BSI` / `BSI Honorer`, `PPh21`. |
| Spreadsheet **Input Kehadiran Guru PKBM (PKWT)** | Jumlah kehadiran (transport) dan jam mengajar honorer/PKWT. |
| Spreadsheet **Payroll 2025/2026** (file laporan) | Gabung pegawai + honorer + non-pegawai, perbaikan nama, insentif Pj. Media, routing BSI/Tunai, log, PPh21 + Histori + Laporan TER, THR. |
| Spreadsheet **Payroll Maker 2025** | Paket pengajuan pindah buku BSI: daftar, data surat, histori tautan dokumen. |
| Spreadsheet **Laporan Pj. Media** + Apps Script **Laporan Pj. Media** (web app) | Daftar Pj. Media, laporan konten harian oleh Pj. Media sendiri, rekap per periode, tab Insentif. |
| Spreadsheet **Data_Master_ (SPP)** | Beban/piutang SPP siswa sebagai sumber potongan pendidikan anak. |
| Apps Script **Payroll** | `creatdatagaji` / `creathonorer` (snapshot ke histori), pengirim slip lama (di luar cakupan, digantikan PAY-002). |
| Apps Script **Payroll Tools** | `TarikData` (mutasi & routing), `Import` (transfer ke Payroll Maker), `ImporttoDoc` (surat Doc/PDF, lampiran, share, WA). |
| Apps Script **PPh21** | `createHistoriPPh21` (append histori), `ImporPPh` (arsip laporan PPh21 + WA), fungsi kustom `HIJRIAH`. |

## 2. Alur saat ini

| # | Langkah | Aktor | Alat |
|---|---|---|---|
| 1 | Tetapkan tanggal gajian/periode di `DATA OLAHAN GAJI` dan teks periode (`-Bulan Tahun`) di tab BSI/PPh21. | Human Capital | Manual |
| 2 | Input lembur (jam) per pegawai dengan tanggal gajian. | Human Capital | Input PG & Lembur |
| 3 | Pastikan kinerja tahunan/bulanan (umumnya 100% untuk masa kerja ≥ 1 tahun) dan jam/pekan (lebih dari 24 jam untuk tugas tambahan). | Human Capital | Input PG & Lembur |
| 4 | Input potongan BPJS tambahan (nominal 1% untuk anggota keluarga tambahan). | Human Capital | Input PG & Lembur |
| 5 | Input kasbon (saldo awal, potongan). | Keuangan | Input PG & Lembur |
| 6 | Input potongan pendidikan anak; sisa tagihan dibaca dari sistem SPP. | Human Capital | Input PG & Lembur + Data_Master_ |
| 7 | Input kehadiran & jam mengajar PKWT/honorer. | Human Capital | Input Kehadiran PKWT |
| 8 | Perhitungan otomatis (formula). | — | DATA OLAHAN GAJI / OlahanGajiHonorer |
| 9 | Snapshot hasil ke histori (append). | Human Capital | Script `creatdatagaji` / `creathonorer` |
| 10 | Daftar transfer per bulan terbentuk dari histori. | — | BSI / BSI Honorer (QUERY) |
| 11 | Gabung + non-pegawai + perbaikan nama + Pj. Media → routing BSI / Tunai + log. | Human Capital | Script `TarikData` |
| 12 | Isi metadata surat (tanggal Hijriah/Masehi, nomor surat, tanggal pindah buku). | Human Capital | Manual (file laporan) |
| 13 | Transfer ke Payroll Maker → surat Doc/PDF + lampiran → share email → WA. | Human Capital | Script `Import` + `ImporttoDoc` |
| 14 | PPh21: data PPh21 file utama masuk ke tab PPh21 file laporan. | Human Capital | `DISCOVERY`: diasumsikan salin manual (tidak ada script yang ditemukan) |
| 15 | Append ke Histori PPh21 → Laporan PPh21 (TER A/B/C) → arsip + WA. | Human Capital | Script `createHistoriPPh21` + `ImporPPh` |
| 16 | Slip gaji: data kolom PAYROLL diunggah ke HCIS (PAYSLIP/PAY-001). | Human Capital | HCIS import |

Total: 7 file, 3 project Apps Script, ±16 langkah, ±6 tombol script, beberapa salin manual.

## 3. Model perhitungan yang ditemukan (`DISCOVERY`)

### 3.1 Pegawai tetap

| Komponen | Aturan |
|---|---|
| Kunci periode | NIP + "-Bulan Tahun" dari tanggal gajian. |
| MKG | Tahun penuh TMT → tanggal gajian. Tabel hanya sampai MKG 27 (owner: aturan > 27 belum ada). |
| Gaji pokok | Tabel pendidikan terakhir (SD, SMP, SLTA, D1/D2, D3/D4, S1, S2/S3) × MKG, kenaikan berkala berpola 0/3/3/6–7% per tahun, disertai pangkat. Pengali: unit Taman Tahfizh 50%; jabatan fungsional "…Half Day" 60%, "…Half Day II" 65%. |
| Jam | Jumlah jam = jam/pekan × 4. Batas 96 jam/bulan. Kelebihan dibayar Rp10.000/jam; kekurangan dipotong Rp10.000/jam (hanya bila jam > 0). |
| Tunjangan kinerja | %kinerja tahunan × Rp60.000 + %kinerja bulanan × Rp40.000 (dasar Rp100.000, 60/40). Pengecualian satu jabatan: dasar Rp150.000. |
| Tunjangan istri/suami | Gaji pokok × jumlah pasangan × 5%. |
| Tunjangan anak | Gaji pokok × jumlah anak × 2% (tidak ditemukan batas jumlah anak). |
| Tunjangan fungsional | Tabel per jabatan fungsional; 70% bila merangkap jabatan struktural; tidak berlaku untuk unit Pesantren Tahfizh. |
| Tunjangan jabatan | Tabel per jabatan struktural; Kepala Unit di Taman Tahfizh 50%. |
| Tunjangan kualifikasi khusus | Daftar per pegawai berisi "gaji baru" (target). Nilai = target − (gapok + kelebihan jam + kinerja + istri + anak + fungsional + jabatan). Bisa **negatif**. |
| Tunjangan BPJS | Hanya bila nomor BPJS diawali "00": 5% × max(jumlah komponen termasuk lembur dan rapel, UMK Kota Cirebon). |
| Lembur | Gaji pokok / 173 × jam lembur. |
| Rapel, prorata | Diisi manual bila ada. |
| Bruto | Jumlah semua pendapatan di atas. |
| Potongan | Kasbon; BPJS = tunjangan BPJS + tambahan 1% per anggota keluarga tambahan (dasar sama); pendidikan anak; kekurangan jam. |
| Netto | Bruto − potongan. Masa kerja < 2 bulan dibayar 80% (masa percobaan 3 bulan, tetapi 80% hanya 2 bulan pertama). |
| Nilai transfer | Prorata bila diisi, selain itu netto 80% bila berlaku, selain itu netto. |
| THR | Komponen tetap − kekurangan jam; masa kerja < 1 tahun: × bulan/12. |
| PPh21 | Tidak dipotong dari gaji; ditanggung yayasan. Laporan memakai TER A/B/C berdasarkan status PTKP. |

### 3.2 PKWT / honorer

Transport Rp15.000 × jumlah kehadiran + honor Rp15.400 × jam mengajar + pemasukan lain − (kasbon + potongan lain + pendidikan anak).

### 3.3 Pembayaran di luar perhitungan

- **Insentif Pj. Media:** lihat §3.4.
- **Non-Pegawai / Pengabdian / honor lain:** daftar manual di file laporan.

### 3.4 Alur Pj. Media

Penerima ada dua jenis: **pegawai aktif** yang diberi tugas tambahan Pj. Media, dan **non-pegawai** yang hanya bertugas sebagai Pj. Media.

| # | Langkah | Aktor | Alat |
|---|---|---|---|
| 1 | Daftarkan Pj. Media (nama, NIP, unit, kata sandi awal = NIK, foto, rekening). | Human Capital | Tab `Pj. Media` |
| 2 | Pj. Media login (NIP + kata sandi) dan mengirim laporan konten: tanggal, tema, deskripsi, link (atau "-" bila belum ada; dilengkapi kemudian). Pekan dihitung otomatis. | Pj. Media | Web app Laporan Pj. Media → tab `Laporan` |
| 3 | Pilih tahun, bulan, nama → daftar konten periode **23 bulan lalu s.d. 22 bulan berjalan** → jumlah konten. | Human Capital | Tab `Rekap` |
| 4 | Pilih tarif per konten (Rp30.000 atau Rp40.000; tersedia dua baris, yang tersimpan baris pertama) → total insentif. | Human Capital | Tab `Rekap` |
| 5 | Simpan rekap satu orang ke tab `Insentif` (append, rekening dicari dari nama). Diulang per orang. | Human Capital | Script `simpanKeInsentif` |
| 6 | File laporan payroll membaca `Insentif` (IMPORTRANGE) dan memfilter periode. | — | `QueryPj.Media` → `Pj. Media` |
| 7 | `TarikData` menambahkan insentif ke transfer **berdasarkan nomor rekening**; rekening yang tidak cocok dengan pegawai/honorer/non-pegawai hanya diberi peringatan ("tambahkan ke Non-Pegawai"). | Human Capital | Script `TarikData` |
| 8 | Kolom "Media" pada PPh21. | Human Capital | File laporan |

Temuan khusus Pj. Media (lihat juga §4):

- Konten dengan link "-" (belum ada bukti) ikut terhitung dan terbayar.
- Tarif dipilih manual per orang per periode; tidak ada aturan tertulis kapan Rp30.000 atau Rp40.000.
- Identitas dicocokkan lewat **nama** (laporan, rekap, rekening) dan pembayaran lewat **nomor rekening**, bukan NIP.
- `simpanKeInsentif` tanpa pengaman duplikasi.
- Web app dapat diakses anonim; kata sandi awal = NIK, tersimpan teks biasa, dan seluruh data pengguna termasuk kata sandi dikembalikan ke browser dan disimpan di `localStorage`.
- Insentif pegawai tidak masuk slip gaji; insentif non-pegawai hanya terbayar bila rekeningnya tercantum di Non-Pegawai.

## 4. Temuan audit

Tingkat: **T** = tinggi (risiko salah bayar/kebocoran data), **S** = sedang, **R** = rendah.

### 4.1 Akurasi perhitungan

| ID | Tingkat | Temuan |
|---|---|---|
| A1 | T | **Data impor berbasis posisi baris.** Kinerja/jam (`O:Q`) dan kasbon/BPJS tambahan/pendidikan anak (`AD:AF`) masuk ke `DATA OLAHAN GAJI` lewat IMPORTRANGE kolom penuh, bukan lookup per NIP. Urutannya hanya benar selama daftar pegawai di dua file identik dan sinkron; bila IMPORTRANGE terlambat/berubah urutan, nilai bisa menempel ke pegawai lain tanpa peringatan. |
| A2 | T | **Kegagalan senyap.** Hampir semua formula dibungkus `IFERROR(…, "")`. Data yang hilang (kinerja kosong, jabatan tak dikenali, MKG di luar tabel) menjadi kosong = 0 tanpa tanda. |
| A3 | S | **Lembur hanya baris pertama.** Rekap lembur memakai VLOOKUP; bila satu pegawai punya > 1 baris lembur pada periode yang sama, baris berikutnya diabaikan. Potongan lain sudah memakai SUMIF. |
| A4 | S | **Gapok kosong untuk MKG > 27** (tabel berhenti di 27). |
| A5 | S | **Kualifikasi khusus negatif.** Bila komponen melebihi target, nilainya negatif dan mengurangi gaji. Perlu konfirmasi apakah memang "total tetap". |
| A6 | S | **Dasar tunjangan BPJS** memasukkan lembur, rapel, dan kelebihan jam, tanpa batas atas. Perlu diverifikasi terhadap ketentuan BPJS Kesehatan yang berlaku dan kebijakan yayasan. |
| A7 | S | **Dasar lembur** = gaji pokok/173 tanpa pengali jam. Kolom `PENGHITUNGAN LEMBUR` (max(gapok, gaji minimal)) dihitung tetapi tidak dipakai. Perlu ditetapkan aturan resminya. |
| A8 | S | **Dasar PPh21** dibangun ulang dari netto (+ potongan + tunjangan BPJS) dan memakai netto penuh, bukan nilai yang benar-benar dibayar (80%/prorata). Satu NIK dikecualikan secara hard-coded. |
| A9 | R | Label "< 3 Bulan" pada parameter berbeda dengan rumus "< 2 bulan" (rumus benar menurut owner). |
| A10 | R | UMK tercatat dua kali (tab `UMK Kota` berhenti 2024, dipakai nilai manual di `FORMULA GAJI`). |

### 4.2 Kontrol dan integritas

| ID | Tingkat | Temuan |
|---|---|---|
| K1 | T | **Snapshot tanpa pengaman duplikasi.** `creatdatagaji`, `creathonorer`, dan `createHistoriPPh21` selalu append. Tombol yang terjalankan dua kali menggandakan satu periode; BSI lalu menjumlahkan transfer ganda. |
| K2 | T | **Tidak ada penguncian periode.** Parameter dan input bisa berubah setelah snapshot; tidak ada jejak siapa mengubah apa. |
| K3 | S | **Kunci periode berupa teks** ("-September 2026") yang diketik manual di beberapa tab; salah ketik = data kosong. |
| K4 | S | **Aturan bergantung teks nama** jabatan/unit ("Kepala General Affair", "Taman Tahfizh", "Pesantren Tahfizh", akhiran "Half Day"). Ganti nama jabatan = ganti gaji. |
| K5 | S | **Parameter tanpa tanggal berlaku.** Mengubah tabel gaji/tunjangan mengubah semua periode yang belum disnapshot; periode lama tidak bisa dihitung ulang secara sah. |
| K6 | S | **Perbaikan nama via nomor rekening** adalah tambalan atas data rekening yang tidak menyimpan nama pemilik rekening. |
| K7 | R | Baris kosong pemisah ikut tersalin ke histori setiap periode. |

### 4.3 Keamanan dan privasi (tindak lanjut segera, terlepas dari HCIS)

| ID | Tingkat | Temuan | Rekomendasi segera |
|---|---|---|---|
| S1 | T | **API key StarSender tertulis langsung di script PPh21.** | Rotasi key; pindahkan ke Script Properties seperti di Payroll Tools. |
| S2 | T | **Arsip laporan PPh21 dibagikan "siapa saja yang memiliki link"**; isinya NIK dan penghasilan bruto. | Ubah ke akses terbatas; tinjau arsip yang sudah terbuat. |
| S3 | T | **Kata sandi/PIN tersimpan teks biasa** di tab PASWORD, tab DataKaryawan (nilai default seragam), dan file Pj. Media (kata sandi = NIK). | Hentikan; autentikasi dipindah ke HCIS (AUTH). |
| S4 | S | Lampiran payroll dibagikan ke daftar email dan tautan unduhan dikirim via WA. | Batasi penerima; HCIS memakai akses berbasis role. |
| S5 | S | Data pribadi (NIK, rekening, HP, email, nama ibu kandung) tersebar di ≥ 7 file dengan hak akses file-level. | Satu sumber data di HCIS dengan least privilege. |

### 4.4 Efisiensi

| ID | Temuan | Arah HCIS |
|---|---|---|
| E1 | Kinerja 100% dan jam 24/pekan dimasukkan ulang setiap bulan. | Nilai **berlaku-efektif** (default) per pegawai; bulanan hanya pengecualian. |
| E2 | Lembur diketik manual. | Ambil dari lembur yang **sudah disetujui** di modul kehadiran (ATT); input manual hanya koreksi. |
| E3 | Kehadiran & jam mengajar PKWT diketik manual di file terpisah. | Ambil dari kehadiran HCIS; jam mengajar sebagai input periode. |
| E4 | BPJS tambahan 1% diketik sebagai nominal. | Simpan **jumlah anggota keluarga tambahan** (berlaku-efektif); nominal dihitung. |
| E5 | Kasbon: saldo awal & potongan diketik ulang tiap bulan. | Objek **pinjaman** dengan cicilan; sisa dihitung otomatis; diinput oleh role Keuangan. |
| E6 | Pendidikan anak dicocokkan lewat teks "Nama - Kelas \| No Induk". | Impor tagihan SPP per periode dengan kunci No Induk ↔ pegawai. |
| E7 | Insentif Pj. Media dihitung di aplikasi lain dan ditempel di tahap transfer berdasarkan rekening; tidak masuk slip. | Jadikan **komponen pendapatan variabel** dengan input periode (impor rekap), muncul di slip dan dasar PPh21. |
| E8 | Snapshot, transfer BSI, histori PPh21: tiga langkah salin. | Hilang — hasil perhitungan **sudah** tersimpan per periode; finalisasi = kunci. |
| E9 | Metadata surat (Hijriah, nomor surat) diisi manual. | Dibuat otomatis dari periode + penomoran surat. |
| E10 | 7 file dihubungkan IMPORTRANGE; banyak titik putus. | Satu sistem; integrasi luar hanya lewat adapter (SPP, bank, WA). |

## 5. Usulan alur HCIS

### 5.1 Data dasar (diatur sekali, berlaku-efektif)

- **Katalog komponen** (pendapatan, potongan, biaya pemberi kerja) dengan perlakuan pajak/BPJS.
- **Skala gaji pokok** pendidikan × MKG (berversi), termasuk aturan eksplisit untuk MKG di luar tabel (blokir sampai ada aturan).
- **Tabel tunjangan** fungsional & struktural; **pengali** sebagai atribut kebijakan (unit, pola kerja Half Day), bukan pencocokan teks.
- **Kebijakan statutori berversi:** UMK, tunjangan BPJS 5%, tambahan 1% per anggota keluarga, tabel TER PPh21.
- **Profil kompensasi pegawai berlaku-efektif:** pendidikan, TMT, tanggungan, status PTKP, keikutsertaan BPJS + anggota tambahan, jam wajib, kinerja default, target kualifikasi khusus, rekening + nama pemilik.
- **Pinjaman (kasbon)** dan **potongan berulang**.

### 5.2 Per periode

```text
1. Buka periode (tanggal gajian, cutoff Pj. Media/kehadiran)
2. Kumpulkan input
   - otomatis: lembur disetujui, kehadiran PKWT, cicilan kasbon, tagihan SPP, insentif Pj. Media
   - manual (pengecualian saja): kinerja ≠ default, jam tambahan, rapel, prorata, penyesuaian
3. Hitung → daftar blocker (data hilang, MKG di luar tabel, rekening kosong, netto negatif)
4. Tinjau: selisih vs periode lalu per pegawai/komponen, rekap per unit
5. Finalisasi (kunci; sekali per periode; koreksi lewat reopen tercatat)
6. Serah bayar: laporan payroll final tampil untuk Kepala Keuangan, Direktur, Pengurus Yayasan → Keuangan membayar dan mengonfirmasi
7. Publikasi slip (PAY-002)
8. Laporan PPh21 (TER) untuk pelaporan
```

Operator: dari ±16 langkah di 7 file menjadi ±6 aksi di satu sistem. Langkah salin (snapshot, transfer, histori PPh21), pengetikan ulang nilai default, serta pembuatan memo/Doc/PDF, share email, dan WA hilang.

### 5.3 Pj. Media di HCIS (usulan)

Satu modul laporan konten untuk semua Pj. Media; yang berbeda hanya **jalur pembayarannya**.

```text
Penugasan Pj. Media (berlaku-efektif: orang, unit, tarif per konten)
  -> Pj. Media mengirim laporan konten di HCIS (link wajib sebelum dihitung)
  -> Verifikator menyetujui/menolak konten
  -> Periode cutoff 23–22: jumlah konten disetujui × tarif
       |-- pegawai aktif  -> komponen pendapatan variabel "Insentif Pj. Media"
       |                     di hasil payroll (masuk slip dan dasar PPh21 pegawai)
       '-- non-pegawai    -> daftar pembayaran non-pegawai pada laporan serah bayar
                             (bukan slip pegawai; perlakuan PPh21 bukan pegawai TBD)
```

- **Pegawai aktif:** Pj. Media dicatat sebagai **tugas tambahan** (placement `ADDITIONAL`, EMP-005 D-06) dengan tarif; login memakai akun HCIS yang sudah ada.
- **Non-pegawai:** dicatat sebagai **penerima non-pegawai** (orang + rekening + penugasan), dengan akun HCIS terbatas hanya untuk modul laporan konten. Tidak membuat employment.
- Tarif sebagai atribut penugasan berlaku-efektif (bukan pilihan bulanan), dengan aturan kapan Rp30.000/Rp40.000 ditetapkan process owner.
- Verifikator (`TBD`), mis. Kepala Unit atau Humas.
- Kunci identitas = orang/penugasan HCIS, bukan nama atau rekening.

Keputusan terbuka: cakupan non-pegawai di fase 1 (§6.3 butir 1), aturan tarif, verifikator, perlakuan PPh21 penerima bukan pegawai.

### 5.4 Peran

| Peran | Aksi |
|---|---|
| Human Capital | Kelola data dasar, input pengecualian, hitung, tinjau, ajukan finalisasi. |
| Keuangan (Kepala Keuangan) | Input/kelola kasbon; melihat laporan payroll final; konfirmasi pembayaran. |
| Direktur, Pengurus Yayasan | Melihat laporan payroll final (read-only). |
| Penyetuju (D10: Direktur) | Setujui finalisasi dan reopen. |
| Pegawai | Lihat slip sendiri (PAY-002). |

## 6. Keputusan process owner

### 6.1 Sudah diputuskan (2026-10-23)

| # | Topik | Keputusan | Dampak desain HCIS |
|---|---|---|---|
| D1 | Kualifikasi khusus (A5) | Tidak seharusnya negatif. Nilai negatif selama ini dipakai sebagai **penyesuaian** bila gaji seseorang harus di bawah hasil rumus utama. | Pisahkan menjadi dua komponen: *Tunjangan Kualifikasi Khusus* (≥ 0, target berlaku-efektif) dan *Penyesuaian Gaji* (potongan eksplisit, wajib alasan + dasar keputusan, tercatat audit). Hitungan yang menghasilkan kualifikasi khusus < 0 menjadi blocker sampai penyesuaian ditetapkan. |
| D2 | BPJS Kesehatan (A6) | Iuran ditanggung yayasan untuk guru/pegawai tetap dan, bertahap, pekerja lain sesuai SK Direktur No. 01.128/Dir.YSQ/VIII/2026 (pendaftaran bertahap PPU TA 2026/2027; kepesertaan aktif dan tagihan mulai bulan berikutnya setelah pendaftaran). Sebagian pekerja tetap di PBI dan tidak mau dipindah. Batas atas mengikuti peraturan. | Kepesertaan BPJS sebagai **profil berlaku-efektif** per pegawai: segmen (PPU-yayasan / PBI / mandiri / belum terdaftar), tanggal aktif, jumlah anggota keluarga tambahan, referensi SK. Mengganti aturan "nomor diawali 00". Lihat §6.4. |
| D3 | Lembur (A7) | Ikuti spreadsheet. | Aturan berjalan: gaji pokok / 173 × jam lembur, tanpa pengali; jam lembur dari lembur yang disetujui. Kolom "Penghitungan Lembur" (max(gapok, gaji minimal)) tidak dipakai dan tidak dimigrasikan. |
| D4 | Tunjangan anak | Tidak ada batas jumlah anak. | Tanpa batas; jumlah anak berlaku-efektif. |
| D5 | Serah bayar (§5.2 langkah 6) | Payroll sekarang mandiri (bukan pemindahbukuan BSI); serah bayar memakai Memorandum Internal Kepala HCM → Kepala Keuangan beserta lampiran daftar payroll. Di HCIS tidak perlu membuat surat. | HCIS **tidak** membuat memo/surat. Laporan payroll final (daftar penerima, nominal, rekening, rekap per unit, total) tampil di HCIS untuk **Kepala Keuangan, Direktur, dan Pengurus Yayasan** sesuai permission. Penggantian surat, pembuatan Doc/PDF, share email, dan WA dihapus. Catatan: PAYSLIP-001 dan batas Foundation Board saat ini melarang Board melihat total/rincian payroll; akses Pengurus Yayasan ke laporan ini membutuhkan permission baru + review keamanan. |
| D6 | PPh21 | Tidak dipotong dari gaji; ditanggung yayasan. | Biaya pemberi kerja; laporan TER tetap dibuat. |
| D7 | MKG > 27 | Aturan belum ada. | Blocker sampai aturan ditetapkan. |
| D8 | Masa percobaan | 3 bulan; netto 80% hanya 2 bulan pertama. | Dua atribut terpisah. |

### 6.2 Diputuskan 2026-10-24

| # | Topik | Keputusan | Dampak desain HCIS |
|---|---|---|---|
| D9 | Dasar PPh21 untuk gaji 80%/prorata (A8) | Memakai nominal yang **benar-benar dibayar**. | Penghasilan pelaporan diturunkan dari hasil payroll final (setelah 80%/prorata), bukan direkonstruksi dari netto penuh. Pengecualian hard-coded diganti atribut eksplisit. |
| D10 | Pengesahan | **Kepala HCM mengajukan finalisasi, Direktur mengesahkan**; buka ulang periode final juga lewat persetujuan Direktur. | Dua tahap: `SUBMITTED` (HCM) → `APPROVED/FINALIZED` (Direktur). Reopen butuh persetujuan Direktur + alasan, tercatat audit. Laporan baru tampil ke Keuangan/Direktur/Pengurus setelah disahkan. |
| D11 | Dasar iuran BPJS Kesehatan (A6) | **Sesuai peraturan:** gaji pokok + tunjangan tetap, batas bawah UMK, batas atas Rp12.000.000. | Kebijakan statutori berversi; klasifikasi "tunjangan tetap" per komponen di katalog komponen. Nilai iuran akan berubah dibanding spreadsheet → wajib dijelaskan saat paralel run. |

### 6.3 Masih terbuka

1. **Cakupan versi pertama** — owner belum memilih. **Usulan default:** pegawai tetap + PKWT/honorer + insentif Pj. Media untuk pegawai aktif; non-pegawai/pengabdian dan THR menyusul di versi berikutnya.
2. Klasifikasi komponen sebagai "tunjangan tetap" untuk dasar BPJS (mis. tunjangan kinerja, kualifikasi khusus, kelebihan jam).
3. Pj. Media: aturan tarif Rp30.000/Rp40.000, verifikator konten, perlakuan PPh21 penerima bukan pegawai.

### 6.4 Ketentuan iuran BPJS Kesehatan PPU (`DISCOVERY`, wajib diverifikasi ke teks resmi)

Ringkasan dari sumber sekunder per Oktober 2026; belum dicek ke naskah resmi JDIH/BPJS Kesehatan:

- Dasar hukum: Perpres 82/2018 tentang Jaminan Kesehatan sebagaimana diubah, terakhir Perpres 59/2024; per Oktober 2026 belum ada penetapan iuran baru (KRIS bertahap).
- Iuran PPU: 5% dari gaji/upah per bulan (4% pemberi kerja, 1% pekerja). Di YSQ seluruh 5% ditanggung yayasan.
- Dasar gaji/upah: **gaji pokok + tunjangan tetap**; tunjangan tetap = tunjangan yang dibayar tanpa memperhitungkan kehadiran.
- Batas bawah: UMK (Kota Cirebon). Batas atas: Rp12.000.000/bulan → iuran maksimum Rp600.000.
- Anggota keluarga tambahan (di luar pasangan dan 3 anak): +1% per orang, dibayar pekerja.

Selisih dengan spreadsheet: dasar sekarang memasukkan lembur, rapel, dan kelebihan jam (bukan tunjangan tetap) dan tidak memiliki batas atas. Kebijakan statutori disimpan berversi (tarif, batas bawah/atas, sumber) sesuai PAY-003.

## 7. Migrasi dan verifikasi

- Jalankan HCIS **paralel** dengan spreadsheet minimal 2–3 periode; bandingkan per pegawai per komponen; target selisih nol atau selisih yang dijelaskan oleh temuan §4.
- Histori `PAYROLL` lama tetap sebagai arsip/impor slip (PAY-001); tidak dihitung ulang.
- Spreadsheet dibekukan setelah gate paralel lulus.
