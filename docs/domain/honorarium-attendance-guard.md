# Penjagaan Honorarium yang Dibayar dari Kehadiran

**Status:** DRAFT — spesifikasi ini **belum** mengizinkan implementasi. Isinya adalah kajian atas apa yang hari ini menjadi uang tanpa keputusan manusia, daftar cara kehadiran dapat ada tanpa pekerjaan di baliknya, dan usulan penjagaan. Setiap aturan yang belum diputuskan owner ditandai `DRAFT` dengan default paling masuk akal (aturan owner 2026-10-26).
**Spesifikasi:** PAY-004 (Guard atas pembayaran honorarium berbasis kehadiran)
**Tanggal:** 2026-11-18
**Pertanyaan owner:** "perlu ada penanggulangan jika otomasi dari presensi, kalau lebih hadir tapi bukan untuk pekerjaan bagaimana otomasi rekognisinya."
**Terkait:** PAY-003 (`docs/domain/payroll-calculation-v1.md` §4, §5.2, §10 butir 1 dan 4), ATT-011 (klarifikasi/koreksi jam), ATT-013 (hari multi-blok), ATT-014 (jenis hari, transaksi real-time), ATT-015 (`docs/domain/attendance-remote-and-schedule-requests.md` D-06, D-07, D-09), TRIP-001 (`docs/domain/business-travel.md` D-17), ATT-005/ATT-012 (ADMS), APR-001, ORG-004, NOTIF-004, AUTH-011
**Implementasi yang dikaji:** `apps/api/src/modules/payroll/attendance-inputs.ts`, `apps/api/src/modules/payroll/inputs-store.ts`, `apps/api/src/modules/attendance/engine.ts`

## 1. Tujuan

Pegawai honorer (`KONTRAK_HONORER`) dan pekerja lepas (`LEPAS`) dibayar dari kehadiran: transport Rp15.000 per kehadiran dan honor Rp15.400 per jam mengajar (PAY-003 §3.2, §5.2). Kehadiran itu dibaca mesin dari hasil kehadiran, bukan diketik siapa pun. Pertanyaan owner adalah pertanyaan tentang uang yang berpindah tanpa ada yang memutuskan: **bila seseorang tercatat hadir tetapi kehadiran itu bukan untuk pekerjaan yayasan, apa yang menahan pembayarannya, dan siapa yang memutuskan?**

Dokumen ini menjawab tiga hal:

1. kuantitas berbayar mana yang **benar-benar** diturunkan dari kehadiran tanpa keputusan manusia, dan mana yang hanya tampak begitu (§3);
2. cara konkret kehadiran dapat ada tanpa pekerjaan di baliknya, menurut model kehadiran yang ada sekarang — termasuk yang sudah tertutup (§4);
3. penjagaan yang diusulkan, masing-masing dengan **biayanya dalam pekerjaan HC dan kepala unit** serta **cara gagalnya** (§5–§7).

Yang tidak dilakukan dokumen ini: menuduh siapa pun, dan menetapkan kebijakan yayasan. Penjagaan yang menahan uang orang adalah kebijakan, bukan keputusan teknis; semuanya `DRAFT` sampai owner memutuskan (§15).

## 2. Batas

Termasuk:

- populasi `KONTRAK_HONORER` dan `LEPAS` pada mesin PAY-003 (3 orang PKWT pada Oktober 2026 menurut PAY-003 §1.1; jumlah `LEPAS` belum tercatat di dokumen mana pun);
- dua kunci input periode yang ditulis resolver kehadiran (`CONTRACT_ATTENDANCE_DAYS`, `OVERTIME_HOURS`) dan komponen `TRANSPORT`;
- cara kerja penjagaan di dalam lifecycle periode PAY-003 yang sudah ada (§6 PAY-003), bukan lifecycle baru.

**Tidak** termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| Mengubah mesin kehadiran (ATT) | Penjagaan ini membaca hasil kehadiran; mengubah cara hari dinilai adalah perubahan ATT dengan spesifikasi dan test sendiri. Guardrail anti-copy "jangan mensintesis punch" (roadmap) tetap berlaku dan dokumen ini tidak melanggarnya. |
| Jalur slip resmi PAY-001/PAY-002 | Tidak berubah. Seluruh isi dokumen ini hidup di PAY-003, yang masih parallel run. |
| Honor mengajar sebagai angka yang diketik | `CONTRACT_TEACHING_HOURS` adalah input manual HC (§3). Bukti untuk angka itu adalah pertanyaan tersendiri (G-10, §15 pertanyaan 7), bukan otomasi kehadiran. |
| Sanksi kepegawaian | Bila ditemukan hari terbayar yang tidak semestinya, koreksinya adalah uang (§9.4). Konsekuensi kepegawaian ada di EMP, bukan di sini. |
| Deteksi titip absen secara biometrik | ATT-005/ATT-012 memegang sisi perangkat. Dokumen ini hanya mencatatnya sebagai jalan masuk (§4 butir 7). |

## 3. Yang benar-benar menjadi uang tanpa keputusan manusia

| Kuantitas | Sumber | Ada keputusan manusia? |
| --- | --- | --- |
| `CONTRACT_ATTENDANCE_DAYS` → komponen `TRANSPORT` (hari × Rp15.000) | Resolver `resolveAttendanceDays` membaca versi hasil kehadiran terbaru dalam jendela cutoff dan menulis input periode `origin = ATTENDANCE` | **Tidak.** Tidak ada ambang, tidak ada persetujuan, dan kunci ini **tidak ada** di `MANUAL_INPUT_KEYS`, sehingga HC bahkan tidak dapat mengetiknya: satu-satunya cara mengubahnya adalah memperbaiki kehadirannya lalu menjalankan resolver ulang, atau memakai `ADJUSTMENT` dengan alasan dan referensi keputusan. |
| `CONTRACT_TEACHING_HOURS` → `TEACH_FEE` (jam × Rp15.400) | Input HC per periode (PAY-003 §4) | **Ya**, seorang manusia mengetiknya — tetapi spesifikasi tidak mewajibkan bukti apa pun di baliknya. Nominalnya jauh lebih besar daripada transport. |
| `OVERTIME_HOURS` → `OVERTIME` | Resolver yang sama, tetapi hanya untuk `TETAP`, `PERCOBAAN`, `KONTRAK` | Tidak relevan untuk honorer: honorer tidak punya komponen lembur (§5.2 PAY-003), dan angkanya membaca `approved_minutes` yang sudah diputus approver. |

**Kesimpulan yang penting.** Satu-satunya uang honorer yang benar-benar lahir dari otomasi adalah **transport, Rp15.000 per hari**. Paparan maksimumnya kecil per orang per bulan (26 hari ≈ Rp390.000), dan tidak bertambah oleh jam: honorer dibayar per hari hadir, bukan per menit. Karena itu **perangkat yang dibiarkan menyala atau lupa check-out tidak menambah satu rupiah pun** bagi honorer; ia hanya menambah `worked_minutes` yang tidak dibaca rumus §5.2. Yang menambah uang adalah **bertambahnya hari**, bukan bertambahnya jam.

Sebaliknya, angka terbesar di slip honorer — honor mengajar — justru diketik tanpa bukti yang diwajibkan. Penjagaan yang hanya menyentuh otomasi akan menjaga Rp390.000 dan membiarkan Rp1,4 juta. Itu sebabnya G-10 ada di daftar.

## 4. Cara kehadiran dapat ada tanpa pekerjaan

Disusun dari model kehadiran yang berlaku sekarang. Kolom terakhir membedakan yang **sudah tertutup** (tidak perlu penjagaan baru, cukup test yang mengunci perilakunya) dari yang **terbuka**.

| # | Jalan masuk | Apa yang terjadi hari ini | Status |
| --- | --- | --- | --- |
| 1 | Scan pada hari **tanpa jadwal** | Tidak membayar. Engine hanya membaca punch di dalam jendela jadwal (±6 jam) sehingga `first_check_in_at` tetap kosong, dan hari tanpa jadwal berjenis `rest_day` yang sudah disaring resolver. Scan-nya tetap terlihat HC di tab **Tanpa Jadwal** (ATT-014). | Tertutup |
| 2 | Scan pada **hari libur** atau hari istirahat | Tidak membayar, kecuali hari libur yang memang dijadwalkan kerja (`holiday_scheduled_work`). | Tertutup |
| 3 | WFH/WFA (`remote_work`) tanpa scan | Tidak membayar (ATT-015 D-07): tidak ada yang berangkat. | Tertutup |
| 4 | Hadir sebentar lalu pulang | **Membayar penuh.** Syaratnya hanya `first_check_in_at` terisi; lama kerja, check-out, dan keterlambatan tidak diperiksa sama sekali (PAY-003 §10 butir 4: "tanpa memperhitungkan keterlambatan"). Satu scan pukul 06.00 lalu pergi = satu hari transport. | **Terbuka** |
| 5 | Scan **di luar geofence** atau dengan akurasi GPS meragukan | Bukti disimpan dan hari ditandai `needs_review` (ATT-006), tetapi check-in tetap ada, sehingga hari tetap dibayar walaupun orangnya tidak berangkat ke lokasi kerja. | **Terbuka** |
| 6 | **Jadwal yang keliru**: seseorang dijadwalkan pada hari yang sebenarnya tidak diminta bekerja, atau jadwalnya diubah lewat ATT-015 D-09 dan diterapkan HC | Hari itu menjadi hari kerja; ada scan = dibayar. Jadwal adalah satu-satunya pagar antara "ada scan" dan "ada uang", dan jadwal disusun HC/roster tanpa persetujuan terpisah. | **Terbuka** |
| 7 | Scan yang **bukan milik orangnya**: pemetaan `device user` ↔ pegawai yang salah (ATT-012, `attendance-adms-device-user-correction.md`), PIN/kartu dipakai orang lain, titip absen | Hari terbayar atas nama orang yang tidak datang. Mesin payroll tidak dapat membedakannya dari kehadiran asli. | **Terbuka** (penjagaannya di sisi ATT/perangkat) |
| 8 | **Hadir di lokasi untuk urusan bukan pekerjaan** (mengantar anak, pengajian, mengambil barang) lalu scan | Dibayar. Model kehadiran tidak menyimpan apa pun tentang maksud kedatangan. Inilah kasus yang persis ditanyakan owner, dan **tidak ada data di HCIS yang dapat membedakannya**. | **Terbuka, tidak dapat dipecahkan oleh data** |
| 9 | **Hari terjadwal yang dihadiri tetapi tidak ada pekerjaan yang ditugaskan** (kelas kosong, kegiatan batal) | Dibayar. Penugasan tidak ada di model kehadiran; tidak ada tautan antara hari hadir dan pekerjaan. | **Terbuka, tidak dapat dipecahkan oleh data** |
| 10 | **Tugas luar `APPROVED` tanpa scan** (ATT-015 D-07) dan **dinas `ISSUED`/`COMPLETED`** (TRIP-001 D-17) | Dibayar **tanpa bukti kehadiran sama sekali**. Penjagaan satu-satunya adalah rantai approval APR-001 yang menyetujui pengajuannya, dan itu memang keputusan manusia — tetapi keputusan yang diambil **sebelum** harinya, bukan atas kehadiran yang benar-benar terjadi. | Terbuka, dengan penjaga |
| 11 | **Koreksi jam lewat klarifikasi** (ATT-011-7, ≤ 7 hari ke belakang) yang menciptakan check-in pada hari tanpa scan | Dibayar. Keputusannya diambil **satu orang HC** ("Perbaiki jam"), tanpa tahap kedua, dan hasilnya langsung menjadi uang pada periode berikutnya. | **Terbuka** |
| 12 | Hari yang sama dibayar dua kali lewat dua employment | Sudah dipersempit: resolver membuang employment yang tanggal akhirnya `UNKNOWN`, memisahkan legal entity, dan EMP-005 melarang employment yang tumpang tindih. | Tertutup |

Dua baris terakhir pada §4 yang ditandai "tidak dapat dipecahkan oleh data" adalah inti jawaban atas pertanyaan owner: untuk butir 8 dan 9, **tidak ada otomasi yang dapat mengenali bedanya**, karena yang membedakan "hadir untuk bekerja" dari "hadir saja" hanya diketahui orang yang menugaskan. Penjagaan untuk dua butir itu wajib berbentuk seseorang yang mengatakannya, bukan aturan mesin (§7).

## 5. Penjagaan yang diusulkan

Setiap butir adalah keputusan `DRAFT` dengan default. Kolom **Biaya** adalah pekerjaan manusia per bulan; kolom **Cara gagal** adalah kerugian yang ditimbulkannya bila dipakai.

| # | Penjagaan (default `DRAFT`) | Biaya per bulan | Cara gagal |
| --- | --- | --- | --- |
| G-01 | **Bayar hanya terhadap jadwal.** Perilaku hari ini (§4 butir 1–3) dinyatakan sebagai invarian tertulis dan dikunci test: hari tanpa jadwal, hari istirahat, dan hari libur tanpa `holiday_scheduled_work` tidak pernah menghasilkan transport, berapa pun scan-nya. | Nol. Sudah berlaku. | Tidak menangkap apa pun yang terjadi **di dalam** hari terjadwal (butir 4–9). Mengandalkan jadwal yang benar. |
| G-02 | **Plafon hari berbayar = jumlah hari terjadwal** orang itu dalam jendela cutoff. Hari berbayar yang melebihi hari terjadwal adalah mustahil menurut G-01, sehingga selisihnya menjadi **blocker tingkat periode** (`HONORARIUM_DAYS_EXCEED_SCHEDULE`), bukan peringatan. | Nol (dihitung mesin); hanya muncul bila ada cacat data. | Tidak menangkap jadwal yang memang keliru (butir 6). Pagar terhadap cacat, bukan terhadap kebijakan. |
| G-03 | **Plafon rupiah bulanan per orang**, default Rp450.000 (30 hari × Rp15.000) sebagai jaring pengaman terakhir. Melebihi plafon = blocker, dilepas hanya lewat `ADJUSTMENT` berwenang dengan alasan. | Nol pada bulan normal. | Angka tetap akan usang bila tarif berubah; harus hidup sebagai kebijakan berversi, bukan konstanta kode. |
| G-04 | **Asal-usul hari ditampilkan.** Rekap honorer per orang memecah jumlah hari menjadi `SCAN`, `FIELD` (tugas luar tanpa scan), `TRIP` (dinas), `CORRECTION` (hari yang lahir dari koreksi jam), dan `HOLIDAY_SCHEDULED`. Tanpa nominal pada log. | Nol untuk HC (satu kolom tambahan di layar yang sudah dibaca). | Hanya memperlihatkan, tidak menahan. Tidak berguna bila tidak ada yang melihatnya — karena itu dipasangkan dengan G-06. |
| G-05 | **Hari tanpa scan dibatasi**: jumlah hari `FIELD` + `TRIP` + `CORRECTION` dalam satu periode di atas ambang (default **5 hari**) menjadikan baris itu **tertahan** sampai dikonfirmasi (G-06). Di bawah ambang, lewat tanpa konfirmasi. | Mendekati nol pada bulan normal; satu konfirmasi pada bulan yang tidak normal. | Ambang yang terlalu rendah memindahkan pekerjaan ke orang yang memang sering tugas luar; terlalu tinggi tidak menahan apa pun. |
| G-06 | **Konfirmasi bulanan kepala unit** atas rekap honorer unitnya: satu layar per unit berisi daftar orang, jumlah hari, dan asal-usulnya (G-04), diselesaikan dengan **satu tombol per unit**, bukan per baris. Tanpa konfirmasi, periode tetap dapat dihitung; yang tertahan hanya baris G-05. | **Satu layar dan satu tombol per unit per bulan.** Dengan populasi honorer sekarang (satuan orang) ini menit, bukan jam. | Menjadi stempel bila daftarnya panjang. Karena itu ia **tidak boleh** tumbuh menjadi konfirmasi per baris kehadiran: 26 baris × jumlah honorer per bulan adalah pekerjaan yang akan diklik tanpa dibaca, dan penjagaan yang diklik tanpa dibaca lebih buruk daripada tidak ada penjagaan, karena ia memindahkan tanggung jawab tanpa memindahkan perhatian. |
| G-07 | **Penandaan outlier terhadap riwayat orang itu sendiri**, memakai ambang PAY-003 §10 butir 6 yang sudah ada (selisih > 10% **dan** > Rp50.000 dibanding periode `APPROVED` sebelumnya) pada komponen `TRANSPORT`. Peringatan, tidak memblokir. | Nol; muncul di layar review yang sudah dibaca HC. | Pegawai baru tidak punya riwayat; kenaikan yang pelan tidak pernah melewati ambang. |
| G-08 | **Hari dari koreksi jam butuh pemutus kedua** bila jumlahnya > 2 dalam satu periode: klarifikasi `correction` yang menciptakan check-in pada hari tanpa scan disetujui HC seperti sekarang, tetapi hari ke-3 dan seterusnya dalam bulan yang sama ikut tertahan G-05. | Satu konfirmasi pada bulan yang tidak normal. | Menghukum pegawai yang perangkatnya memang bermasalah. Mitigasi: masalah perangkat diselesaikan di ATT-012, bukan dengan menahan uang berulang kali. |
| G-09 | **Scan di luar geofence yang masih `needs_review` tidak dihitung hadir** sampai review-nya selesai. | HC menyelesaikan review yang hari ini sudah ada antreannya; jumlahnya kecil. | Menggeser beban ke antrean review, dan menahan uang orang karena akurasi GPS. Default `DRAFT` yang lebih aman: **tetap dihitung, tetapi ditandai** (G-04) — lihat rekomendasi §6. |
| G-10 | **Honor mengajar butuh rekap jam yang disetujui atasan** sebelum dapat diketik sebagai input periode. Di luar otomasi kehadiran, tetapi ini angka terbesar di slip honorer (§3). | Satu rekap per unit per bulan. | Menambah pekerjaan pada hal yang tidak ditanyakan owner. Disajikan terpisah di §15 pertanyaan 7. |
| G-11 | **Default selama belum ada yang memutuskan:** baris yang tertahan (G-05, G-08) **tidak dibayar pada periode itu**, dan dibayar sebagai `ARREARS` pada periode berikutnya begitu dikonfirmasi. Uang tidak hilang, hanya terlambat satu bulan. | Nol bila tidak ada yang tertahan. | Orang yang benar menunggu uangnya sebulan karena konfirmasi tidak datang. Alternatifnya — bayar dulu, periksa belakangan — memindahkan kerugian ke yayasan dan menjadikan koreksinya potongan pada bulan berikutnya, yang jauh lebih menyakitkan bagi pekerja honorer. |

## 6. Kombinasi yang direkomendasikan

**G-01 + G-02 + G-04 + G-07 + G-05 + G-06 + G-11**, dengan G-03 sebagai jaring pengaman, G-08 menyusul bila koreksi jam ternyata sering dipakai, dan **G-09 dalam bentuk "tandai, jangan tahan"**. G-10 diajukan terpisah kepada owner.

Alasannya:

- G-01, G-02, G-04, dan G-07 **tidak berbiaya manusia sama sekali**: tiga di antaranya adalah pernyataan atas perilaku yang sudah ada plus satu kolom di layar, dan satu lagi memakai ambang peringatan yang sudah dipakai periode payroll. Penjagaan gratis diambil lebih dulu.
- G-05 + G-06 + G-11 adalah satu-satunya yang menjawab pertanyaan owner yang sebenarnya, karena untuk §4 butir 8 dan 9 **hanya manusia yang tahu**. Keduanya dirancang supaya yang dikonfirmasi adalah **pengecualian**, bukan seluruh bulan: pada bulan biasa tidak ada satu pun baris tertahan dan kepala unit tidak diminta apa pun.
- Yang **tidak** direkomendasikan: ambang jam minimum per hari (menghukum lupa check-out, dan transport memang mengganti ongkos berangkat, bukan lama bekerja — PAY-003 §10 butir 4), persetujuan per hari kehadiran, dan konfirmasi bulanan atas seluruh baris. Ketiganya mahal dan menukar perhatian dengan klik.
- G-09 versi menahan ditolak untuk Paket 1: akurasi GPS bukan bukti ketidakhadiran, dan menahan uang atas dasar itu akan sering salah. Hari di luar geofence cukup **ditandai** di G-04 sehingga ikut terlihat saat review dan saat konfirmasi.

## 7. Siapa yang memutuskan, dan apa yang terjadi sebelum ada yang memutuskan

Ini jawaban langsung atas pertanyaan owner.

1. **Untuk hari yang dapat dinilai mesin** (ada/tidak ada jadwal, ada/tidak ada scan, jenis hari): mesin memutuskan, dan keputusannya sudah benar hari ini (§4 butir 1–3). Tidak ada manusia yang perlu dilibatkan.
2. **Untuk hari yang tidak dapat dinilai mesin** (hadir tetapi bukan untuk pekerjaan, hadir tetapi tidak ada yang ditugaskan): **kepala unit** yang memutuskan, karena hanya dia yang tahu apa yang diminta dikerjakan hari itu. Bukan HC, yang tidak tahu; bukan Keuangan, yang lebih jauh lagi; bukan atasan langsung saja, karena untuk honorer atasan langsung sering satu orang yang sama dengan yang mengatur jadwalnya.
3. **Selama belum ada yang memutuskan**, baris yang tertahan **tidak dibayar** pada periode itu dan masuk `ARREARS` bulan berikutnya (G-11). Default ini dipilih karena menahan satu bulan dapat dipulihkan utuh, sedangkan menarik kembali uang yang sudah dibayar kepada pekerja honorer tidak.
4. **Bila ditemukan hari yang terlanjur terbayar keliru**, koreksinya mengikuti jalur yang sudah ada: `ADJUST_DEDUCT` pada periode berikutnya dengan alasan dan referensi keputusan (PAY-003 §4), bukan penghapusan hasil periode yang sudah disahkan.
5. **Tidak ada penjagaan yang boleh menjadi blocker senyap.** Setiap baris tertahan muncul di layar review periode dengan nama, jumlah hari, dan asal-usulnya, dan periode tetap dapat diajukan dan disahkan tanpa menunggu konfirmasi — yang tertunda hanya baris itu.

## 8. Actor

| Actor | Tindakan |
| --- | --- |
| Mesin PAY-003 | Menurunkan hari berbayar dari hasil kehadiran, menerapkan G-01–G-03, menandai G-04 dan G-07, menahan baris G-05/G-08 |
| HC (`payroll.inputs.manage`, `payroll.calculate`) | Menjalankan resolver, membaca rekap dan tanda, memperbaiki kehadiran lewat ATT, melepas plafon G-03 lewat `ADJUSTMENT` berwenang |
| Kepala unit (seat ORG-004) | Mengonfirmasi rekap honorer unitnya untuk satu bulan (G-06); melepas baris tertahan |
| Direktur (`payroll.approve`) | Melihat jumlah baris tertahan pada ringkasan periode sebelum mengesahkan |
| Pegawai honorer | Melihat jumlah hari yang dibayarkan pada slipnya seperti sekarang (PAY-002/PAY-003); tidak ada layar baru di Paket 1 |

## 9. Alur

### 9.1 Pada saat resolver dijalankan

Tidak berubah: resolver tetap mengganti seluruh isi kedua kunci berasal-kehadiran, dan baris yang tidak lagi didukung kehadiran tetap dihapus. Yang ditambahkan adalah **rincian asal-usul** per employment (G-04), disimpan bersama input sehingga rekap tidak perlu menghitung ulang dari tabel kehadiran.

### 9.2 Pada saat periode dihitung

G-02 dan G-03 diperiksa sebagai blocker tingkat periode, sederet dengan blocker PAY-003 §5.4 yang sudah ada. G-05 dan G-08 menandai baris sebagai **tertahan**; baris tertahan menghitung `TRANSPORT` sebesar hari yang tidak tertahan saja, dan sisanya dicatat sebagai hari tertunda pada hasil.

### 9.3 Pada saat konfirmasi unit

```text
belum dikonfirmasi -> dikonfirmasi   (kepala unit, satu bulan, satu unit)
belum dikonfirmasi -> kedaluwarsa    (periode berikutnya disahkan tanpa konfirmasi)
```

Konfirmasi tidak dapat ditarik setelah periode `APPROVED`. Hari tertunda yang dikonfirmasi menjadi `ARREARS` pada periode berikutnya dengan referensi ke periode asalnya. Hari tertunda yang kedaluwarsa tetap dapat dibayarkan lewat `ARREARS` berwenang dengan alasan — kelalaian konfirmasi bukan alasan menghilangkan hak orang.

### 9.4 Koreksi setelah terbayar

`ADJUST_DEDUCT` pada periode berikutnya dengan alasan dan referensi keputusan. Tidak ada jalur yang mengubah hasil periode yang sudah disahkan (PAY-003 §6).

## 10. Permission

Tanpa permission baru untuk HC dan Direktur. Konfirmasi unit (G-06) adalah kepemilikan **seat** ORG-004 atas unit itu, bukan izin global, dengan pola yang sama dengan approver unit APR-001: tidak ada kunci izin yang memberi seseorang hak mengonfirmasi seluruh unit sekaligus. `payroll.results.read.organization` tetap menjadi satu-satunya pintu ke angka per orang; layar konfirmasi menampilkan **jumlah hari**, bukan rupiah.

## 11. Audit dan notifikasi

Audit event baru: `payroll.honorarium.days_withheld` (periode, employment, jumlah hari, asal-usul), `payroll.honorarium.unit_confirmed` (periode, unit, aktor), `payroll.honorarium.days_released`. Seluruhnya **tanpa nominal**, mengikuti PAY-003 §8 dan pola LOAN-001 D-15 / REIMB-001 D-14.

NOTIF-004 kategori `system`: kepala unit diberi tahu saat ada baris tertahan di unitnya; HC diberi tahu saat periode memiliki baris tertahan yang belum dikonfirmasi pada H-3 sebelum tanggal pengajuan. Tanpa nominal, tanpa nama pada judul.

## 12. Penyimpanan

Sketsa, bukan skema final (dokumen ini `DRAFT`):

```text
payroll_period_inputs            kolom rincian asal-usul hari pada baris CONTRACT_ATTENDANCE_DAYS
payroll_honorarium_withholdings  hari tertahan per periode × employment, alasan, rilis
payroll_honorarium_confirmations satu baris per periode × unit, aktor, waktu
```

Aturan yang wajib: hari tertahan tidak pernah dihapus (dilepas, bukan dihilangkan); konfirmasi append-only; tidak ada nominal di ketiga tabel.

## 13. Layar

- Review periode (HC): kolom asal-usul hari pada baris honorer, tanda outlier G-07, dan jumlah baris tertahan di ringkasan.
- Konfirmasi unit (kepala unit): satu halaman per periode × unit berisi nama, jumlah hari, asal-usul, dan satu tombol konfirmasi. Tidak ada rupiah.
- Ringkasan periode (Direktur): jumlah baris tertahan sebagai angka, bukan daftar.

State loading, kosong, galat, terlarang (403), dan mobile wajib ada.

## 14. Acceptance criteria

- PAY-004-A: scan pada hari tanpa jadwal, hari istirahat, dan hari libur tanpa `holiday_scheduled_work` tidak pernah menghasilkan hari berbayar (mengunci perilaku §4 butir 1–3).
- PAY-004-B: hari berbayar tidak pernah melebihi hari terjadwal orang itu dalam jendela cutoff; selisihnya memblokir pengajuan periode.
- PAY-004-C: rekap honorer memecah hari menurut asal-usulnya, dan jumlah pecahannya sama dengan `CONTRACT_ATTENDANCE_DAYS`.
- PAY-004-D: hari tanpa scan di atas ambang G-05 tertahan; `TRANSPORT` periode itu dihitung tanpa hari tertahan.
- PAY-004-E: konfirmasi unit melepas hari tertahan menjadi `ARREARS` periode berikutnya tepat satu kali; konfirmasi ganda tidak menggandakan.
- PAY-004-F: tanpa konfirmasi, periode tetap dapat dihitung, diajukan, dan disahkan; tidak ada blocker senyap.
- PAY-004-G: layar konfirmasi, audit, dan notifikasi tidak memuat nominal.
- PAY-004-H: orang yang bukan pemegang seat unit itu tidak dapat mengonfirmasinya (403).
- PAY-004-I: tidak ada perilaku PAY-001/PAY-002 yang berubah.

## 15. Pertanyaan yang hanya dapat dijawab owner

| # | Pertanyaan | Default `DRAFT` yang dipakai | Taruhannya |
| --- | --- | --- | --- |
| 1 | Transport melekat pada **keberangkatan** atau pada **pekerjaan**? Orang yang datang sesuai jadwal tetapi tidak ada yang ditugaskan — dibayar atau tidak? | Dibayar: ia sudah mengeluarkan ongkos berangkat, dan kesalahan penjadwalan bukan kesalahannya. | Menentukan apakah §4 butir 9 perlu penjagaan sama sekali. |
| 2 | Plafon hari berbayar per orang per bulan. | Jumlah hari terjadwal (G-02), dengan jaring pengaman Rp450.000 (G-03). | Angka ini kebijakan, bukan teknis. |
| 3 | Siapa yang mengonfirmasi bulan honorer? | Kepala unit, satu tombol per unit (G-06). | Bila jawabannya HC, penjagaan kehilangan satu-satunya orang yang tahu pekerjaan hari itu. |
| 4 | Default saat belum dikonfirmasi: tertahan atau dibayar? | Tertahan, dibayar sebagai rapel bulan berikutnya (G-11). | Menahan = pekerja menunggu; membayar = yayasan menarik kembali. |
| 5 | Hari tugas luar dan dinas **tanpa scan** tetap otomatis dibayar? | Ya di bawah 5 hari sebulan, tertahan di atasnya (G-05). | Hari ini satu-satunya penjaganya adalah persetujuan yang diberikan sebelum harinya. |
| 6 | Hari yang lahir dari **koreksi jam** boleh membayar transport? | Boleh, dengan ambang 2 hari sebulan (G-08). | Hari ini satu orang HC dapat menciptakan hari berbayar. |
| 7 | **Honor mengajar** perlu rekap jam yang disetujui atasan? | Belum diwajibkan (status quo). | Angka terbesar di slip honorer tidak punya bukti yang diwajibkan (§3). |
| 8 | Scan di luar geofence membayar? | Ya, tetapi ditandai (G-09 versi tandai). | Menahan atas dasar GPS akan sering salah. |
| 9 | Koreksi atas hari yang terlanjur terbayar keliru: dipotong bulan berikutnya atau diikhlaskan? | Dipotong lewat `ADJUST_DEDUCT` dengan alasan dan referensi keputusan. | Ini keputusan kebijakan yayasan terhadap pekerja honorer, bukan keputusan teknis. |

Setiap jawaban owner mengubah tabel §5 dan §6, bukan hanya baris ini. Selama belum dijawab, tidak ada bagian dokumen ini yang boleh diimplementasikan.
