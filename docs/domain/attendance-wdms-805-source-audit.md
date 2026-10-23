# Audit Sumber WDMS 8.0.5 dan Pemetaan ke Modul ADMS HCIS

**Status:** DISCOVERY — temuan reverse engineering, belum menjadi keputusan produk.
**Tanggal:** 2026-10-23
**Terkait:** ATT-005 (paritas WDMS), ATT-007 (engine), ATT-010 (konvergensi), ATT-011-2 (hitung ulang otomatis)

## 1. Bahan dan metode

Bahan: paket instalasi lokal `references/WDMS/wdms-server/Solution WDMS 8.0.5 7819` (di luar repo),
manual PDF, dan importer lama (VB6, `att2008`) yang tidak relevan untuk protokol.

Temuan identitas:

- Aplikasi adalah **ZKBioTime yang dikustomisasi untuk Indonesia** (path build tertanam
  `ZKBioTime customize\C20220902-ID-01`) dengan merek OEM **"Solution"**: server menolak
  perangkat yang `~OEMVendor`-nya bukan `solution`.
- Stack: Django + Python 3.7, Apache/mod_wsgi, PostgreSQL/MySQL, Redis, Celery
  (beat + 6 worker dengan antrean terpisah), memcached; supervisor proses `iclockservice.exe`.
- Handler protokol PUSH `/iclock/*` dikompilasi Cython (`iclock/comm/devview.pyd`), **tetapi
  berkas C keluaran Cython ikut terkirim** (`devview.c`). Cython menyisipkan baris sumber asli
  sebagai komentar, sehingga 953 dari 983 baris `devview.py` dapat direkonstruksi utuh.
- Modul lain berupa bytecode `.pyc` Python 3.7, didekompilasi dengan `decompyle3` / `xdis`
  (PyPI) di folder scratch. Tidak ada biner vendor yang dijalankan.

Referensi publik yang dicek: dokumen umum PUSH SDK ZKTeco dan beberapa paket ADMS PHP/Laravel
kecil (lihat §7). Tidak ada implementasi publik yang lebih otoritatif daripada kode server WDMS ini.

Batasan: versi 8.0.5 (2022) lebih tua daripada baseline ATT-005 (manual WDMS 9.0.5, rilis 9.0.7).
Perilaku di sini adalah bukti perilaku vendor pada versi ini, bukan kontrak firmware.
Tidak ada kode vendor yang disalin ke repo; dokumen ini hanya meringkas perilaku.

## 2. Arsitektur WDMS yang relevan

```text
Perangkat --HTTP--> /iclock/cdata (POST ATTLOG)
                      │ verifikasi SN (+lisensi, area, OEM)
                      │ parse baris -> INSERT iclock_transaction (unik: emp_code + punch_time)
                      │ publish event (Celery, antrean att_real_time)   <- tidak menunggu
                      └─> balas "OK:<n>" / "ERROR:<n>"
Celery att_real_time:  subscriber transaksi -> att.run_calculation([emp], tgl, tgl)
                       -> hapus timecard rentang itu -> hitung ulang
Celery beat:           data_sync tiap 3 dtk (antrean perintah ke perangkat),
                       device_online_monitor, retensi, ekspor
```

Fakta kunci dari kode:

| Area | Perilaku WDMS 8.0.5 |
|---|---|
| Endpoint | `cdata` (GET handshake / POST data), `getrequest`, `devicecmd`, `fdata` (foto), `ping`, `file/*` (firmware). Tidak ada `querydata` maupun `registry` di versi ini. |
| Penerimaan perangkat | SN baru didaftarkan otomatis ke *area default* dan dijawab "Not Authorized Terminal" sampai admin memindahkan ke area nyata (karantina). Ditolak bila melebihi kuota lisensi, bila SN < 6 karakter, atau bila vendor OEM bukan `solution`. Autentikasi hanya berbasis SN. |
| Handshake | Opsi bergantung versi push perangkat (2.2.0 / 2.3.0 / 2.4.1). Untuk 2.4.x mengirim `SupportPing=1`, `PushOptionsFlag=1` + daftar `PushOptions`, `MaxPostSize=1048576`, `MultiBioDataSupport`. `Stamp/OpStamp/PhotoStamp` diambil dari server (stamp tertinggi yang sudah tersimpan). `ErrorDelay=60`; `Delay`, `TransTimes`, `TransInterval`, `Realtime` dari pengaturan. |
| ATTLOG | Baris tab: PIN, waktu, status, verify, workcode, reserved, (mask, suhu). Dedupe di database pada **(emp_code, punch_time)** — global, tanpa SN. Punch di luar retensi dibuang. Balasan `OK:<jumlah>`; bila ada baris gagal, `ERROR:<jumlah>` (perangkat mengirim ulang). |
| Data pengguna (OPERLOG/USER/FP/FACE/BIODATA) | Perangkat **menimpa master pegawai**: nama, kartu, password perangkat, privilege, verify mode diperbarui dari perangkat (default aktif); PIN yang belum dikenal dapat membuat pegawai baru. Password perangkat disimpan apa adanya. |
| Antrean perintah | Format `C:<id>:<perintah>`; satu poll `getrequest` mengirim sampai 256 perintah / 64 KB, berhenti setelah `REBOOT`. Perintah tanpa balasan dikirim ulang setelah 30 menit. `CHECK LOG` me-reset stamp server ke 0 agar perangkat mengunggah ulang semua log. |
| Rekonsiliasi | `VERIFY SUM ATTLOG StartTime=…\tEndTime=…` → perangkat membalas `AttlogSum` → server membandingkan dengan jumlah tersimpan untuk SN itu → bila server kurang, otomatis mengantrikan `DATA QUERY ATTLOG` untuk rentang yang sama; hasil dicatat di tabel bukti (`TransactionProofCmd`). |
| Hitung kehadiran (R1/R2) | Docstring `run_calculation`: **R1 real-time** untuk transaksi perangkat, log manual, cuti, lembur, training, penyesuaian/penugasan jadwal, libur. **R2 manual** untuk perubahan aturan, jam istirahat, timetable, shift. Pemicu = sinyal `post_save` → task Celery per pegawai per rentang; **tanpa dedupe**. |
| Pasangan scan | Bukan toggle. Jam masuk = scan pertama di jendela masuk shift, jam pulang = scan terakhir di jendela pulang. Scan yang berjarak < `punch_period` (default **1 menit**) dari scan diterima sebelumnya diabaikan (debounce scan ganda). |
| Hasil | Timecard rentang dihapus lalu ditulis ulang. Tidak ada versi, tidak ada lock per pegawai/tanggal. |
| Koreksi manual | Log manual yang disetujui **ditulis ke tabel transaksi mentah** (`source=2`); saat dibatalkan, baris transaksi dengan PIN + detik yang sama **dihapus** — dapat ikut menghapus scan mesin asli pada detik yang sama. |

## 3. Pemetaan ke HCIS

| # | Aspek | WDMS 8.0.5 | HCIS sekarang | Penilaian |
|---|---|---|---|---|
| M1 | Penerimaan perangkat | Auto-register ke area default (karantina), kuota lisensi, cek OEM | `lifecycle` `active/disabled/quarantined`; perangkat tak dikenal tidak menghasilkan data | Setara. HCIS tidak butuh cek OEM/lisensi. |
| M2 | Autentikasi perangkat | SN saja; `Encrypt=0` | SN + host ingress terpisah | Keduanya mempercayai SN. Tidak ada mekanisme protokol yang lebih kuat di versi ini untuk ditiru. |
| M3 | Handshake | Opsi per versi push, stamp dari server, `MaxPostSize`, `PushOptionsFlag=1` | Statis 2.4.1 untuk semua perangkat, `ErrorDelay=30`, `Delay=10`, `TransFlag` hanya `AttLog`, tidak ada `MaxPostSize` | Lihat R4: HCIS menolak/menyunting body > 512 KB tetapi tidak memberi tahu perangkat batas itu. |
| M4 | Penyimpanan ATTLOG | Insert langsung ke tabel transaksi; balas setelah insert | Body mentah ditangkap durable lebih dulu, lalu diparse; baris rusak dikarantina | HCIS lebih kuat (bukti mentah + karantina). Pertahankan. |
| M5 | Kunci dedupe | `(emp_code, punch_time)` global | Hash `(serial, pin, waktu mentah, status, verify, workcode, sha256 baris mentah)` | HCIS benar menyimpan scan yang sama dari dua mesin, tetapi **sha baris mentah** membuat unggahan ulang dengan format kolom berbeda (mis. firmware menambah kolom mask/suhu) menjadi event baru. Lihat R3. |
| M6 | Pemetaan pegawai | PIN global = kode pegawai; perangkat dapat membuat/menimpa data pegawai | Mapping per `(device, pin)` dengan effective dating; master HR authoritative | HCIS lebih benar untuk yayasan multi-unit. **Jangan** tiru penimpaan dari perangkat. |
| M7 | Pengiriman perintah | Batch ≤ 256 perintah / 64 KB per poll; kirim ulang 30 menit | Satu perintah per poll `getrequest`, terketik, ber-allowlist, ber-canary | HCIS sengaja konservatif (ATT-005). Konsekuensi: sinkronisasi banyak pengguna lambat (± `Delay` detik per perintah). Lihat R6. |
| M8 | Rekonsiliasi log | `VERIFY SUM` otomatis → tarik ulang hanya bila jumlah kurang; bukti tercatat | Pemulihan `DATA QUERY ATTLOG` berbasis job manual, satu chunk aktif | HCIS belum punya *bukti kelengkapan* murah. Lihat R2. |
| M9 | Pemrosesan setelah scan | ACK hanya menunggu insert; hitung di antrean terpisah | Proyeksi ADMS dijalankan **sinkron sebelum ACK**; engine tidak terpicu sama sekali (K-1) | Ini persis masalah ATT-011-2. Lihat R1. |
| M10 | Daftar pemicu hitung ulang | R1 real-time / R2 manual (lihat §2) | Rencana ATT-011-2: scan, jadwal (publish/assignment), cuti/resolution otomatis; shift hanya hari ini; rentang lewat Hitung ulang | Rencana HCIS sejalan dengan pembagian vendor; tambahkan **libur kalender** ke pemicu (lihat R1). |
| M11 | Pasangan scan | Jendela + first-in/last-out + debounce 1 menit | `buildSessions` men-toggle setiap `punch`; tanpa debounce. Proyeksi lama (`attendance_daily_records`) justru first/last | **Risiko akurasi terbesar.** Lihat R3. |
| M12 | Model hasil | Hapus-tulis ulang, tanpa versi/lock | Versi immutable + `input_hash` + advisory lock | HCIS lebih kuat. Jangan tiru. |
| M13 | Koreksi manual | Ditulis ke tabel scan mentah, dihapus saat batal | Klarifikasi/koreksi terpisah; bukti mentah immutable (I-2) | HCIS benar; pola WDMS bisa menghapus scan asli. Jangan tiru. |
| M14 | Pemantauan online | Offline bila `now - last_activity > heartbeat + batas`; notifikasi | Kesehatan perangkat dari aktivitas ingress | Setara. |

## 4. Catatan keamanan WDMS (alasan tidak menjalankan/meniru apa adanya)

- `/iclock/file/<path>` menyajikan direktori file tambahan dengan *directory listing* tanpa autentikasi.
- Perintah `Shell` dan `GetFile` tersedia ke perangkat; hasil `GetFile` ditulis ke disk server.
- Password perangkat pegawai disimpan apa adanya; nama/kartu ditimpa dari perangkat.
- Celery memakai serializer `pickle` (berbahaya bila broker Redis terekspos).
- Berkas konfigurasi bawaan memuat kredensial database/Redis default. Isinya **tidak** disalin ke dokumen ini.

## 5. Rekomendasi

Urut menurut nilai bagi operator dan risiko.

**R1 — Lanjutkan ATT-011-2 seperti direncanakan, dengan dua penyesuaian (prioritas: sekarang).**
WDMS membuktikan pola yang sama dipakai vendor: ACK perangkat hanya menunggu penyimpanan, perhitungan
di antrean terpisah. Penyesuaian:
1. Tambahkan **perubahan libur kalender** (`leave_calendar_exceptions`) sebagai pemicu R1, karena resolver
   ATT-007 memprioritaskan libur di atas assignment — vendor juga memasukkannya ke R1.
2. Setelah antrean ada, pertimbangkan memindahkan `projectAdmsRequest` (proyeksi ke tabel kompatibilitas)
   dari jalur ACK ke worker yang sama. Ini mengikuti pola vendor dan mengurangi latensi ACK; tetapi
   mengubah perilaku jalur ingest, jadi diusulkan sebagai langkah terpisah setelah ATT-011-2 stabil.
Yang **tidak** ditiru: hitung ulang per scan tanpa dedupe dan hasil hapus-tulis ulang; desain HCIS
(dedupe antrean + versi immutable) lebih kuat.

**R2 — Rekonsiliasi kelengkapan log dengan `VERIFY SUM ATTLOG` (prioritas: tinggi, butuh canary).**
Tiap malam, per perangkat aktif, minta jumlah ATTLOG perangkat untuk hari kemarin, bandingkan dengan
jumlah event yang tersimpan untuk serial itu, dan hanya bila kurang buat job pemulihan `DATA QUERY ATTLOG`
yang sudah ada untuk rentang itu. Simpan setiap perbandingan sebagai bukti. Ini mengubah pemulihan dari
"HC curiga lalu menjalankan job" menjadi bukti kelengkapan harian yang murah. Sesuai aturan ATT-005,
perintah baru masuk sebagai kapabilitas terketik dengan status `documented` → canary fisik → `verified`
pada firmware perangkat SQ sebelum dijalankan otomatis.

**R3 — Debounce dan aturan pasangan scan di engine (prioritas: diturunkan ke rendah/defensif setelah
verifikasi production §8; tetap butuh keputusan owner bila dikerjakan).**
Pegawai yang menempel jari dua kali dalam beberapa detik saat masuk akan dipasangkan sebagai sesi
beberapa detik oleh `buildSessions`, lalu scan pulang membuka sesi baru → **Tidak lengkap**, padahal
hadir penuh. WDMS mencegahnya dengan debounce 1 menit dan pola first-in/last-out per jendela shift.
Langkah:
1. Verifikasi dulu besarnya masalah secara read-only di production: hitung pasangan scan ADMS satu
   pegawai yang berjarak < 60 detik, dan berapa hasil `incomplete` yang menyertainya (agregat saja,
   tanpa data pribadi di laporan).
2. Bila nyata, ajukan perubahan spesifikasi engine (ATT-007): debounce terkonfigurasi (usul default
   1 menit) diterapkan saat membangun sesi dari event `punch`, tanpa menghapus event (I-2 tetap). Ini
   mengubah hasil kehadiran → butuh keputusan owner, test, dan hitung ulang rentang terdampak.
3. Bersamaan, tambahkan dedupe semantik saat normalisasi ADMS → `attendance_events` pada
   `(device, pin, waktu)` agar unggahan ulang berformat berbeda tidak menggandakan event (M5).

**R4 — Kirim `MaxPostSize` di handshake sesuai batas body HCIS (prioritas: sedang, butuh canary).**
HCIS membatasi body 512 KB tetapi tidak memberi tahu perangkat; unggahan besar (mis. setelah
`CHECK`/pemulihan) bisa melewati batas dan berakhir sebagai bukti tersunting. WDMS mengirim
`MaxPostSize` agar perangkat memecah unggahan. Usul: kirim `MaxPostSize` ≤ `ADMS_MAX_BODY_BYTES`
untuk perangkat 2.4.x, diverifikasi di canary fisik.

**R5 — Opsi handshake per versi push (prioritas: rendah).** HCIS mengirim opsi 2.4.1 ke semua
perangkat. Bila armada SQ hanya 2.4.x ini tidak perlu diubah; cukup catat versi push yang terlihat di
production. Bila ada perangkat 2.2/2.3, ikuti pola vendor (opsi sesuai versi).

**R6 — Throughput perintah (prioritas: rendah, hanya bila terasa).** HCIS mengirim satu perintah per
poll. Untuk sinkronisasi ratusan pengguna ke perangkat baru, ini memakan waktu `jumlah × Delay`. Bila HC
mengeluh, batching beberapa perintah *non-destruktif* yang sudah terverifikasi dalam satu balasan
(vendor: ≤ 256 / 64 KB, berhenti setelah REBOOT) adalah jalurnya, tetap di bawah gerbang ATT-005.

**Tidak direkomendasikan untuk ditiru:** perangkat menimpa master pegawai (M6), koreksi manual ke tabel
scan mentah (M13), hasil hapus-tulis ulang (M12), dedupe global PIN+detik tanpa serial (M5),
endpoint file tanpa autentikasi dan perintah `Shell` (§4).

## 6. Dampak ke rencana ATT-011-2

- Rencana tetap valid; tambahkan pemicu libur kalender (R1.1) dan test-nya.
- Debounce (R3) **bukan** bagian ATT-011-2: ia mengubah aturan engine dan butuh keputusan owner.
  Namun bila R3 disetujui, test (i) "missing punch tetap `incomplete`" di ATT-011-2 harus dibedakan dari
  kasus scan ganda, agar keduanya tidak tertukar.

## 8. Verifikasi production (2026-10-23, read-only)

Dijalankan lewat `ssh mi8vps-root` → `psql` sebagai user Termux pada `sqcore_hcis`, dengan sesi
`default_transaction_read_only=on`. Hanya angka agregat yang dikeluarkan; tidak ada nama, PIN, atau
id pegawai di keluaran maupun di dokumen ini.

| Pengukuran | Hasil |
|---|---|
| Scan ADMS mentah | 3.475 (28 Agu – 23 Okt 2026), 2 mesin |
| Scan terpetakan ke pegawai pada saat scan | 481 (44 pegawai, 278 hari-pegawai) |
| Scan dengan PIN terpetakan, tetapi terjadi **sebelum** `effective_from` mapping | 2.599 (75%) |
| Scan dari PIN yang tidak pernah dipetakan | 395 (7 kombinasi mesin+PIN) |
| Jeda antarscan ≤ 60 detik (mesin+PIN sama, seluruh 3.475 scan) | **0**; jeda terkecil **68 detik** |
| Jeda 61–300 detik | 17 |
| Event ADMS yang sudah dinormalisasi ke `attendance_events` | **0** |
| Versi hasil kehadiran (`attendance_result_versions`) seluruhnya | **1** |
| Scan per hari-pegawai (terpetakan) | 1 scan: 81 hari (29%) · 2 scan: 191 · 3 scan: 6 |

Kesimpulan:

1. **Scan ganda tidak terjadi di armada sekarang.** Jeda minimum 68 detik dan nol jeda ≤ 60 detik
   menunjukkan mesin sendiri sudah menolak scan berulang dalam ± 1 menit (pengaturan interval
   scan berulang di firmware). R3 diturunkan menjadi langkah defensif: relevan hanya bila pengaturan
   mesin berubah atau mesin baru dipasang. Pengaturan itu sebaiknya dicatat di runbook perangkat.
2. **Engine belum pernah memproses scan mesin, dan jadwal hampir kosong.** 0 event ADMS
   ternormalisasi, 1 versi hasil, 0 audit `attendance.finalized`. Pengukuran lanjutan:

   | Pengukuran | Hasil |
   |---|---|
   | Pegawai aktif | 99 |
   | Pegawai dengan assignment jadwal aktif | **1** |
   | Roster published | **0** |
   | `attendance_daily_records` dari proyeksi ADMS | 278 (31 Agu – 23 Okt), 197 dengan jam pulang |
   | `attendance_events` per sumber | `mobile=3`, tidak ada `adms` |

   Dampak nyata:
   - **Pegawai** melihat jam scan sendiri dengan benar di `/attendance/me`, karena halaman itu jatuh ke
     tabel kompatibilitas `attendance_daily_records` yang diisi proyeksi ADMS (first/last scan).
   - **HC**: resolver ATT-007 memberi status `off` untuk pegawai tanpa jadwal, jadi Kehadiran harian dan
     laporan Detail/Periode/Unit menampilkan 98 dari 99 pegawai sebagai **Libur** setiap hari, apa pun
     scannya. Laporan Data Scan dan Sesi kosong untuk data mesin, karena keduanya membaca
     `attendance_events`/sesi hasil yang belum terisi. Satu-satunya tampilan scan mesin untuk HC adalah
     halaman ADMS (event mentah).
   - Koreksi atas versi awal catatan ini: gejala K-1 ("Tidak hadir" padahal sudah scan) hanya berlaku
     untuk pegawai yang punya jadwal, dan saat ini itu hanya 1 orang. Masalah utama di production adalah
     **jadwal yang belum diisi**, bukan hitung ulang.
3. **ATT-011-2 sendiri hampir tidak mengubah apa pun sampai jadwal terisi.** Engine hanya membaca
   scan bila ada jadwal untuk hari itu (`normalizeAdmsForWindow` dan pemuatan event dilewati saat
   `off`). Hitung ulang otomatis untuk pegawai tanpa jadwal hanya menghasilkan versi `off`.
   Gelombang "Tidak lengkap" (29% hari-pegawai punya satu scan) baru muncul setelah jadwal diisi.
   Perkiraan itu memakai tanggal kalender, sehingga shift lintas tengah malam bisa terhitung dua kali.
4. **Cakupan mapping.** 75% scan mentah jatuh sebelum `effective_from` mapping PIN-nya, sehingga
   tidak pernah menjadi kehadiran. Apakah scan sebelum mapping dibuat seharusnya dihitung adalah
   keputusan data/owner (backdating mapping butuh bukti), bukan perubahan kode.

## 9. Sumber publik yang dicek

- General Introduction of PUSH SDK Protocol (ZKTeco, PDF umum): https://cdn.tvc.mx/media/92189/General-Introduction-of-PUSH-SDK-Protocol.pdf
- dewanlab/laravel-zkteco-adms-core: https://packagist.org/packages/dewanlab/laravel-zkteco-adms-core
- athwari/laravel-zkteco-adms-server: https://packagist.org/packages/athwari/laravel-zkteco-adms-server
- tanemrahman/zkteco-adms: https://packagist.org/packages/tanemrahman/zkteco-adms
- rithy/zkteco-adms: https://packagist.org/packages/rithy/zkteco-adms

Paket-paket tersebut kecil dan tidak menjelaskan `VERIFY SUM`; perilaku itu diambil dari kode server WDMS.
