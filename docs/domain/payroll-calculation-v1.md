# Payroll Calculation v1

**Status:** DRAFT  
**Specification:** PAY-003 (v1)  
**ADR:** ADR-0003 (PROPOSED)  
**Related:** PAY-001, PAY-002, PAYSLIP-001..006, ATT-010, EMP-005, AUTH-011, ORG-010  
**Evidence:** `docs/domain/payroll-legacy-flow-audit.md` (aturan legacy dan keputusan D1–D11), `docs/domain/payroll-engine-discovery.md` (arah arsitektur)

Spesifikasi ini mendefinisikan versi pertama perhitungan payroll di HCIS. Nilai parameter berasal dari spreadsheet legacy dan berstatus `DISCOVERY` sampai disahkan process owner melalui tabel kebijakan berversi. Spesifikasi ini tidak mengizinkan implementasi sebelum ADR-0003 `ACCEPTED`.

## 1. Cakupan

### 1.1 Termasuk v1

- Pegawai dengan employment aktif kategori tetap, masa percobaan, dan kontrak honorer/PKWT (EMP-005).
- Komponen pegawai tetap/percobaan: gaji pokok, kelebihan/kekurangan jam, tunjangan kinerja, tunjangan pasangan, tunjangan anak, tunjangan fungsional, tunjangan jabatan, tunjangan kualifikasi khusus, tunjangan BPJS Kesehatan, lembur, rapel, penyesuaian gaji.
- Komponen PKWT/honorer: transport per kehadiran, honor per jam mengajar, pemasukan lain.
- Potongan: kasbon, iuran BPJS Kesehatan, iuran anggota keluarga tambahan, pendidikan anak, kekurangan jam, penyesuaian.
- Insentif Pj. Media untuk pegawai aktif (input periode).
- Netto 80% selama 2 bulan pertama masa kerja; prorata sebagai penyesuaian berwenang.
- Lifecycle periode dengan pengesahan Direktur, laporan untuk Keuangan/Direktur/Pengurus, publikasi slip lewat PAY-002, laporan PPh21 TER.

### 1.2 Di luar v1

Penerima non-pegawai/pengabdian/honor lain, THR, modul laporan konten Pj. Media (v1 hanya menerima rekap), reimbursement, integrasi transfer bank, multi legal entity (ORG-007), akuntansi.

## 2. Aktor dan permission

Permission mengikuti pola `<resource>.<action>[.<scope>]`. Semua permission baru wajib automated test (AGENTS.md §7) termasuk daftar test minimum `roles-permissions.md`.

| Aktor | Permission (usulan) | Scope |
|---|---|---|
| Kepala HCM / staf HC | `payroll.policies.manage`, `payroll.profiles.manage`, `payroll.periods.manage`, `payroll.inputs.manage`, `payroll.calculate`, `payroll.submit` | organization |
| Keuangan (pengelola kasbon) | `payroll.loans.manage`, `payroll.payments.confirm` | organization |
| Kepala Keuangan | `payroll.reports.read`, `payroll.payments.confirm` | organization |
| Direktur | `payroll.approve`, `payroll.reopen.approve`, `payroll.reports.read` | organization |
| Pengurus Yayasan | `payroll.reports.read` (read-only) | organization — **butuh review keamanan**, mengubah batas Foundation Board (PAYSLIP-001/ORG-010) |
| Pegawai | `payslips.read.own` (sudah ada) | own |

Aturan:

- Tidak ada self-approval: akun yang mengajukan (`payroll.submit`) tidak dapat mengesahkan periode yang sama.
- Super Admin tidak otomatis mendapat permission payroll.
- Laporan payroll per orang adalah data sensitif: setiap baca dicatat `payroll.report.read`.

## 3. Data dasar (berlaku-efektif)

Semua data dasar memiliki `effective_from`/`effective_to` (tanggal Asia/Jakarta, inklusif). Perubahan tidak menimpa histori.

### 3.1 Katalog komponen

Setiap komponen memiliki kode stabil, nama tampilan, kategori (`EARNING`, `DEDUCTION`, `EMPLOYER_COST`), penanda **tunjangan tetap** untuk dasar BPJS, penanda masuk dasar PPh21, dan urutan tampil di slip.

Komponen awal v1 (kode final saat implementasi):

| Kode (usulan) | Komponen | Kategori | Tunjangan tetap? |
|---|---|---|---|
| `BASIC` | Gaji pokok | EARNING | ya (gaji pokok) |
| `TEACH_OVER` | Kelebihan jam | EARNING | TBD (§10 butir 2) |
| `PERF` | Tunjangan kinerja | EARNING | TBD |
| `SPOUSE` | Tunjangan pasangan | EARNING | ya |
| `CHILD` | Tunjangan anak | EARNING | ya |
| `FUNC` | Tunjangan fungsional | EARNING | ya |
| `POS` | Tunjangan jabatan | EARNING | ya |
| `SPECIAL_QUAL` | Tunjangan kualifikasi khusus | EARNING | TBD |
| `BPJS_KES_ALLOW` | Tunjangan BPJS Kesehatan | EARNING | tidak |
| `OVERTIME` | Lembur | EARNING | tidak |
| `ARREARS` | Rapel gaji | EARNING | tidak |
| `PJ_MEDIA` | Insentif Pj. Media | EARNING | tidak |
| `TRANSPORT` | Transport PKWT | EARNING | tidak |
| `TEACH_FEE` | Honor mengajar PKWT | EARNING | tidak |
| `OTHER_INCOME` | Pemasukan lain | EARNING | tidak |
| `LOAN` | Potongan kasbon | DEDUCTION | — |
| `BPJS_KES` | Iuran BPJS Kesehatan | DEDUCTION | — |
| `BPJS_KES_EXTRA` | Iuran anggota keluarga tambahan | DEDUCTION | — |
| `CHILD_EDU` | Pendidikan anak | DEDUCTION | — |
| `TEACH_SHORT` | Kekurangan jam | DEDUCTION | — |
| `ADJUST` | Penyesuaian gaji | DEDUCTION/EARNING | — |
| `PPH21_EMPLOYER` | PPh21 ditanggung yayasan | EMPLOYER_COST | — |

### 3.2 Tabel kebijakan berversi

| Kebijakan | Isi (nilai legacy, `DISCOVERY`) |
|---|---|
| Skala gaji pokok | Pendidikan terakhir (SD, SMP, SLTA, D1/D2, D3/D4, S1, S2/S3) × MKG 0–27 → nominal dan pangkat. MKG di luar tabel tidak ditebak (§7). |
| Pengali gaji pokok | Unit Taman Tahfizh 50%; pola kerja Half Day 60%, Half Day II 65%. Disimpan sebagai atribut unit/pola kerja, bukan pencocokan teks jabatan. |
| Jam mengajar | Batas 96 jam/bulan (24 jam/pekan × 4); tarif kelebihan dan kekurangan Rp10.000/jam. |
| Tunjangan kinerja | Dasar Rp100.000 dibagi 60% tahunan / 40% bulanan; dasar khusus Rp150.000 untuk jabatan yang ditetapkan (legacy: Kepala General Affair). |
| Tunjangan keluarga | Pasangan 5% × gaji pokok per orang; anak 2% × gaji pokok per anak, tanpa batas jumlah (D4). |
| Tunjangan fungsional | Tabel per jabatan fungsional; 70% bila merangkap jabatan struktural; unit yang tidak memberi tunjangan fungsional ditandai di kebijakan (legacy: Pesantren Tahfizh). |
| Tunjangan jabatan | Tabel per jabatan struktural; pengali per unit (legacy: Kepala Unit di Taman Tahfizh 50%). |
| Lembur | Gaji pokok / 173 × jam lembur, tanpa pengali (D3). |
| BPJS Kesehatan | 5% × dasar; dasar = gaji pokok + komponen bertanda tunjangan tetap; batas bawah UMK Kota Cirebon; batas atas Rp12.000.000; anggota keluarga tambahan +1% × dasar per orang (D11). Sumber: Perpres 82/2018 s.d. Perpres 59/2024, wajib diverifikasi ke naskah resmi sebelum `ACCEPTED`. |
| UMK | Nilai per tahun berlaku (legacy 2026: Rp2.878.646). |
| PKWT | Transport Rp15.000/kehadiran; honor Rp15.400/jam. |
| Masa kerja awal | Netto dibayar 80% bila masa kerja < 2 bulan pada tanggal gajian (D8). |
| PPh21 TER | Tabel TER A/B/C dengan pemetaan status PTKP; kode objek 21-100-01. |

### 3.3 Profil kompensasi pegawai

Per employment, berlaku-efektif:

- pendidikan terakhir untuk skala gaji, TMT masa kerja (dari EMP-005), dan dasar MKG;
- jumlah pasangan dan anak tertanggung;
- pola kerja (penuh / Half Day / Half Day II);
- jam mengajar per pekan (kosong = tidak terkena aturan jam);
- persentase kinerja tahunan dan bulanan (default eksplisit, bukan diketik ulang per bulan; kebijakan default untuk masa kerja < 1 tahun `TBD`);
- target kualifikasi khusus (opsional);
- kepesertaan BPJS Kesehatan: segmen (`PPU_YAYASAN`, `PBI`, `MANDIRI`, `BELUM_TERDAFTAR`), tanggal aktif, jumlah anggota keluarga tambahan, referensi SK (D2);
- status PTKP;
- rekening bank dan nama pemilik rekening;
- tugas tambahan Pj. Media (placement `ADDITIONAL`, EMP-005) dengan tarif per konten.

Jabatan fungsional dan struktural dibaca dari placement EMP-005 dan dipetakan ke tabel tunjangan lewat referensi stabil, bukan label teks.

### 3.4 Kasbon

Kasbon adalah pinjaman per pegawai: tanggal, pokok, dan potongan per periode (tetap atau ditentukan Keuangan per periode). Sisa = pokok − total potongan final. Potongan tidak boleh melebihi sisa. Hanya `payroll.loans.manage`.

## 4. Input periode

| Input | Sumber v1 | Catatan |
|---|---|---|
| Jam lembur | Lembur disetujui ATT-010 (`approved_minutes`) dalam jendela cutoff periode | Menggantikan input manual. Jendela cutoff `TBD` (§10 butir 1). |
| Kehadiran PKWT (transport) | Hasil kehadiran ATT dalam jendela cutoff | Definisi "hadir" untuk transport `TBD`. |
| Jam mengajar PKWT | Input HC per periode | |
| Potongan pendidikan anak | Impor/entri HC per periode (rincian SPP, katering/laundry, PPDB, buku, kegiatan) | Integrasi langsung sistem SPP di luar v1. |
| Insentif Pj. Media | Rekap periode: jumlah konten disetujui × tarif penugasan | Modul laporan konten di luar v1. |
| Rapel | Input HC dengan alasan | |
| Penyesuaian gaji | Input HC dengan alasan dan referensi keputusan | Wajib untuk kasus yang dulu memakai kualifikasi khusus negatif (D1). |
| Prorata | Penyesuaian berwenang dengan alasan | |
| Override kinerja/jam | Input HC untuk periode itu | Mengalahkan profil hanya pada periode tersebut. |

Setiap input mencatat aktor, waktu, alasan bila diwajibkan, dan audit event.

## 5. Perhitungan

Semua uang dalam **rupiah bulat** (integer). Pembulatan per baris mengikuti spreadsheet legacy agar parallel run dapat dibandingkan; total dijumlahkan dari baris yang sudah dibulatkan. Fungsi perhitungan murni dan deterministik untuk snapshot input + versi kebijakan yang sama.

### 5.1 Pegawai tetap / masa percobaan

```text
MKG          = tahun penuh dari TMT s.d. tanggal gajian (0 bila TMT > tanggal gajian)
BASIC        = ROUNDUP(skala[pendidikan, MKG] × pengali_unit_atau_pola)
jam_bulan    = jam_per_pekan × 4                      (bila jam_per_pekan diisi)
TEACH_OVER   = max(0, jam_bulan − 96) × 10.000
TEACH_SHORT  = max(0, 96 − jam_bulan) × 10.000        (hanya bila jam_bulan > 0)
PERF         = %tahunan × dasar_kinerja × 60% + %bulanan × dasar_kinerja × 40%
SPOUSE       = ROUNDUP(BASIC × pasangan × 5%)
CHILD        = ROUNDUP(BASIC × anak × 2%)
FUNC         = tabel_fungsional × (70% bila punya jabatan struktural)   (0 bila unit dikecualikan)
POS          = tabel_struktural × pengali_unit
SPECIAL_QUAL = target − (BASIC + TEACH_OVER + PERF + SPOUSE + CHILD + FUNC + POS), bila target ada
               nilai < 0 → blocker sampai PENYESUAIAN ditetapkan (D1)
OVERTIME     = ROUNDUP(BASIC / 173 × jam_lembur)
dasar_bpjs   = clamp(BASIC + Σ komponen tunjangan tetap, UMK, 12.000.000)
BPJS_KES_ALLOW = BPJS_KES = ROUND(dasar_bpjs × 5%)    (hanya segmen PPU_YAYASAN yang aktif)
BPJS_KES_EXTRA = ROUND(dasar_bpjs × 1% × anggota_tambahan)
BRUTO        = Σ EARNING
POTONGAN     = LOAN + BPJS_KES + BPJS_KES_EXTRA + CHILD_EDU + TEACH_SHORT + ADJUST(potongan)
NETTO        = BRUTO − POTONGAN
DIBAYAR      = NETTO × 80% bila masa kerja < 2 bulan pada tanggal gajian; selain itu NETTO;
               prorata diterapkan sebagai penyesuaian berwenang
```

Tunjangan BPJS ditampilkan sebagai pendapatan sekaligus potongan agar sama dengan slip legacy; efek bersihnya nol bagi pegawai dan seluruh iuran 5% menjadi biaya yayasan.

### 5.2 PKWT / honorer

```text
TRANSPORT   = kehadiran × 15.000
TEACH_FEE   = jam_mengajar × 15.400
BRUTO       = TRANSPORT + TEACH_FEE + OTHER_INCOME
NETTO       = BRUTO − (LOAN + CHILD_EDU + potongan lain)
```

### 5.3 PPh21

PPh21 tidak dipotong dari gaji; dicatat sebagai `PPH21_EMPLOYER`. Penghasilan bruto pelaporan diturunkan dari hasil final yang **benar-benar dibayar** (D9), memakai TER sesuai status PTKP. Pengecualian pelaporan per orang disimpan sebagai atribut eksplisit dengan alasan, bukan NIK hard-coded.

### 5.4 Blocker (fail closed)

Periode tidak dapat diajukan bila ada blocker:

- MKG di luar tabel skala (D7);
- pendidikan, jabatan, atau unit tidak terpetakan ke kebijakan;
- kualifikasi khusus negatif tanpa penyesuaian;
- netto atau nilai dibayar negatif;
- potongan kasbon melebihi sisa pinjaman;
- kebijakan statutori tidak tersedia untuk tanggal periode;
- rekening kosong atau tidak valid untuk penerima transfer;
- satu rekening dipakai lebih dari satu pegawai;
- input periode berubah setelah perhitungan terakhir.

Peringatan (tidak memblokir, wajib ditinjau): selisih per komponen dibanding periode lalu di atas ambang `TBD`, pegawai baru/keluar, input manual bernilai besar.

## 6. Lifecycle periode

```text
DRAFT → COLLECTING → CALCULATED → SUBMITTED → APPROVED → PAYMENT_CONFIRMED → PUBLISHED
                         ↑            │           │
                         └── kembali ─┘           └→ REOPEN_REQUESTED → REOPENED → COLLECTING
```

| Transisi | Aktor | Precondition | Audit event |
|---|---|---|---|
| buat periode | HC | belum ada periode untuk bulan itu | `payroll.period.created` |
| mulai kumpulkan input | HC | DRAFT | `payroll.period.collecting` |
| hitung / hitung ulang | HC | COLLECTING atau CALCULATED | `payroll.period.calculated` (jumlah pegawai, total, blocker) |
| ajukan | HC (`payroll.submit`) | CALCULATED, tanpa blocker, hasil terbaru | `payroll.period.submitted` |
| kembalikan | Direktur | SUBMITTED, alasan wajib | `payroll.period.returned` |
| sahkan | Direktur (`payroll.approve`), bukan pengaju | SUBMITTED | `payroll.period.approved` |
| konfirmasi bayar | Keuangan (`payroll.payments.confirm`) | APPROVED | `payroll.payment.confirmed` |
| publikasi slip | HC | PAYMENT_CONFIRMED | `payroll.payslips.published` |
| minta buka ulang | HC | APPROVED/PAYMENT_CONFIRMED/PUBLISHED, alasan wajib | `payroll.reopen.requested` |
| setujui buka ulang | Direktur | REOPEN_REQUESTED | `payroll.reopen.approved` |

Aturan:

- Satu periode per bulan per legal entity; operasi bersifat idempoten (mengulang aksi tidak menggandakan hasil).
- APPROVED mengunci snapshot input, versi kebijakan, dan baris hasil. Hasil revisi menyimpan lineage ke versi sebelumnya.
- Slip yang sudah dipublikasikan tidak diubah (PAYSLIP-001). Koreksi setelah publikasi memakai slip revisi dengan penanda, mekanismenya `TBD` bersama PAY-002.
- Laporan payroll baru terlihat oleh pembaca laporan setelah APPROVED.

## 7. Output

- **Laporan payroll final** (Keuangan, Direktur, Pengurus): daftar penerima, nominal dibayar, rekening dan nama pemilik rekening, rekap per unit, total, status konfirmasi bayar. Ekspor file `TBD`.
- **Slip pegawai:** hasil final dipetakan ke draft PAY-001 (`lines` label/value sesuai urutan katalog) lalu dipublikasikan lewat alur PAY-002.
- **Laporan PPh21 TER** per masa pajak dari hasil final.
- **Ringkasan biaya yayasan:** BPJS dan PPh21 yang ditanggung yayasan.

## 8. Privasi dan audit

- Nominal, rekening, NIK, dan isi slip tidak masuk application log maupun payload audit; audit hanya memuat identifier, periode, jumlah, dan total agregat.
- Respons laporan dan slip memakai `Cache-Control: no-store`.
- Laporan per orang dan ekspor dicatat sebagai akses sensitif.
- Pengurus Yayasan hanya membaca laporan final; tidak ada mutasi dan tidak ada akses ke input atau profil.

## 9. Migrasi dan verifikasi

### 9.1 Migrasi data awal

- Tabel kebijakan dari tab `FORMULA GAJI` dan parameter terkait (dicatat sumber dan tanggal berlaku).
- Profil kompensasi dari master SDM dan input kinerja/jam terakhir; kepesertaan BPJS dari data kepesertaan + SK pendaftaran bertahap.
- Saldo kasbon berjalan dari tab kasbon.
- Histori `PAYROLL` lama tidak dihitung ulang; tetap sebagai arsip/slip impor PAY-001.

Setiap migration memiliki rollback/recovery plan pada spesifikasi implementasinya.

### 9.2 Parallel run

- Minimal 2–3 periode berturut-turut HCIS dan spreadsheet dijalankan bersamaan.
- Bandingkan per pegawai per komponen. Gate: selisih nol, atau setiap selisih dijelaskan oleh perubahan yang disengaja: dasar BPJS (D11), lembur lebih dari satu baris (A3), pemisahan penyesuaian gaji (D1), dasar PPh21 (D9).
- Selama parallel run, PAY-001/PAY-002 tetap jalur slip resmi.

### 9.3 Test minimum

- Unit test fungsi perhitungan per komponen dengan kasus batas: MKG 0/27/28, jam 0/96/lebih/kurang, BPJS di bawah UMK dan di atas Rp12 juta, segmen PBI, anggota tambahan, masa kerja 1/2/3 bulan, kualifikasi khusus negatif, kasbon melebihi sisa.
- Golden test dari data sintetis yang meniru struktur spreadsheet (bukan data produksi).
- Test otorisasi untuk setiap permission di §2, termasuk larangan self-approval dan read-only Pengurus.
- Test transisi lifecycle, idempotensi, dan blocker.

## 10. Keputusan terbuka

1. Jendela cutoff lembur dan kehadiran PKWT per periode gaji.
2. Komponen yang berstatus tunjangan tetap untuk dasar BPJS: tunjangan kinerja, kualifikasi khusus, kelebihan jam.
3. Default kinerja untuk masa kerja < 1 tahun dan siapa yang menetapkan persentase kinerja.
4. Definisi "hadir" untuk transport PKWT.
5. Pj. Media: aturan tarif Rp30.000/Rp40.000 dan verifikator rekap.
6. Ambang peringatan selisih antar periode.
7. Format ekspor laporan untuk Keuangan.
8. Mekanisme slip revisi setelah publikasi.
9. Verifikasi naskah resmi ketentuan BPJS Kesehatan dan tabel TER PPh21 yang berlaku.
