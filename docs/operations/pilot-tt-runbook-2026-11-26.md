# Runbook pilot Cuti Tahunan Taman Tahfizh — dari undangan Akun SQ sampai pemberitahuan hasil

**Spec ID:** OPS-PILOT-TT-001 (runbook pelaksanaan)
**Tanggal:** 2026-11-26
**Status:** SUPERSEDED 2026-11-27 — tidak dijalankan. HCM memindahkan pilot ke General Affair
(`docs/operations/pilot-cuti-general-affair-2026-11-27.md`). Tabel kalender §4, kueri bukti §5, dan
jalan mundur §6 tetap berlaku untuk pilot General Affair.
**Rilis production terakhir yang tercatat saat disusun:** `hcis-6694a49e-20261126` (tanpa migrasi,
hanya tampilan web; `docs/development/production-release-verification-2026-11-26-6694a49e.md`).
Perbaikan 409 dari `7fd89146` termasuk di dalamnya.
**Cakupan:** hanya Cuti Tahunan, hanya node Taman Tahfizh. Atasan dibaca dari Struktur Organisasi
terbit; kolom atasan lama tidak diisi.
**Terkait:** rencana `pilot-cuti-taman-tahfizh-2026-11-25.md`, bukti
`pilot-tt-readiness-evidence-2026-11-26.md`, panduan peserta `panduan-pilot-cuti-taman-tahfizh.md`.

Dokumen ini memakai label peran. Nama, penetapan per orang, dan kelompok hak cuti per pegawai
tidak dicatat di repository.

---

## 1. Keputusan yang dicatat

| Tanggal | Keputusan | Oleh |
| --- | --- | --- |
| 2026-11-26 | Peserta pertama ditetapkan | HCM |
| 2026-11-26 | **Ukuran keberhasilan: dua pengajuan selesai diputuskan, dari dua peserta** (jalan A pada OPS-PILOT-TT-001 §8); peserta dihitung hanya setelah HCM menyatakannya berhak mengajukan Cuti Tahunan | Owner |
| 2026-11-27 | Unit pilot dipindahkan ke General Affair; runbook ini tidak dijalankan | HCM |

Kelompok hak cuti hanya `non_education` yang berhak atas Cuti Tahunan individual. Penetapan
kelompok adalah keputusan HCM/HC dan tidak ditebak dari unit atau jabatan. Selama baru satu peserta
terverifikasi, laporan pilot menulis "1 peserta, 2 skenario".

## 2. Langkah pemegang akun (agen tidak menjalankannya)

Langkah ini dijalankan oleh akun HC yang memegang `leave.configuration.manage`, `access.manage`,
dan `approvals.policy.manage`. Penyetuju diaktifkan lebih dulu, baris rollout ditulis terakhir.

| # | Langkah | Di mana | Siapa | Yang harus terlihat |
| --- | --- | --- | --- | --- |
| H1 | Tetapkan kelompok hak cuti peserta | Admin → **Kebijakan Cuti** (`/admin/leave`) | HC | Kelompok tercatat; audit `leave.entitlement_group.changed` |
| H2 | Tetapkan peserta kedua dan kelompoknya (bila ada) | HCM memutuskan; HC di layar yang sama | HCM, HC | Keputusan HCM; kelompok `non_education` |
| H3 | Catat hari libur nasional dan cuti bersama yang diikuti yayasan, sesuai tabel §4 | Admin → **Kalender Kerja** (`/admin/leave/calendar`) | HC | Audit `leave.calendar.exception.upserted` |
| H4 | **Kirim aktivasi** ke penyetuju unit | Admin → **Account & Akses** (`/admin/access`) | HC | "Email terkirim" di layar |
| H5 | Penyetuju unit mengisi kata sandinya sendiri dari email (berlaku 12 jam), lalu masuk sekali | Email dan halaman masuk Akun SQ | Penyetuju unit | Akun `active` |
| H6 | H4–H5 untuk kepala unit | Sama | HC, kepala unit | Akun `active` |
| H7 | H4–H5 untuk peserta | Sama | HC, peserta | Akun `active` |
| H8 | Pindahkan unit: **Taman Tahfizh** · **Cuti Tahunan** · sumber **Struktur ini** · berlaku hari ini · alasan `Pilot Cuti Tahunan Taman Tahfizh` | Admin → **Struktur Organisasi** → **Mode persetujuan per unit** | HCM | Satu baris berlaku; audit `organization.rollout.changed` |

Batas aktivasi: 10 menit antarpengiriman per akun, paling banyak 5 kali per 24 jam, undangan
berlaku 14 hari. Kata sandi selalu diisi orangnya sendiri.

## 3. Dua skenario keputusan — dapat dijalankan dengan satu peserta

Pemohon peserta dari node Tata Usaha; rantai **kepala unit → penyetuju unit** (uji kering
production 2026-11-26, bukti §4).

Aturan tanggal: ajukan minimal H-7; satu hari kerja per pengajuan; hindari tanggal libur nasional
dan cuti bersama di §4 (untuk masa pilot: **24 dan 25 Desember 2026**, **1 dan 5 Januari 2027**)
selama tanggal itu belum tercatat di kalender production. Pengajuan yang ditolak atau dibatalkan
tidak memakai kuota.

| # | S1 — Setujui | S2 — Tolak |
| --- | --- | --- |
| 1 | Peserta: **Cuti & Izin** → **Cuti Tahunan** → satu tanggal → pratinjau menyebut 1 hari kerja dan rantai kepala unit → penyetuju unit → **Kirim** | Peserta mengajukan tanggal lain dengan cara yang sama |
| 2 | Kepala unit: lonceng "menunggu persetujuan Anda" → **Persetujuan** → **Setujui** | Kepala unit: **Persetujuan** → **Tolak** → alasan di dialog dalam halaman |
| 3 | Penyetuju unit: **Persetujuan** → **Setujui** → pengajuan disetujui | Pengajuan ditolak; penyetuju unit tidak pernah menerimanya |
| 4 | Peserta: lonceng "Pengajuan cuti Anda disetujui" | Peserta: lonceng "Pengajuan cuti Anda ditolak" tanpa alasan; alasan terbaca di Cuti & Izin |

Pemberitahuan hasil ada **di dalam aplikasi**; keputusan cuti tidak mengirim WhatsApp.

## 4. Kalender kerja dan libur

| Yang diperiksa | Hasil |
| --- | --- |
| Hari kerja production | Senin–Jumat, `Asia/Jakarta` (pembacaan 2026-11-25) |
| Pengecualian kalender production | satu tanggal, 2026-08-25 (libur); **nol** untuk Desember 2026 dan 2027 (pembacaan 2026-11-27) |
| Sumber resmi 2026 | SKB Menag 1497/2025, Menaker 2/2025, MenPANRB 5/2025, ditetapkan 19 September 2025 ([setneg.go.id](https://www.setneg.go.id/baca/index/inilah_skb_3_menteri_libur_nasional_dan_cuti_bersama_2026), dibaca 2026-11-26) |
| Sumber resmi 2027 | SKB Menag 1205/2026, Menaker 3/2026, MenPANRB 2/2026, ditetapkan 15 September 2026 ([setneg.go.id](https://setneg.go.id/baca/index/inilah_skb_3_menteri_libur_nasional_dan_cuti_bersama_2027), dibaca 2026-11-26) |

Satu-satunya tanggal yang tercatat di production, 2026-08-25, cocok dengan SKB 2026 (Maulid Nabi).
Yang masih harus HC catat lewat H3, selama pilot berjalan:

| Tanggal | Hari | Jenis menurut SKB | Keterangan |
| --- | --- | --- | --- |
| 2026-12-24 | Kamis | Cuti bersama | Kelahiran Yesus Kristus |
| 2026-12-25 | Jumat | Libur nasional | Kelahiran Yesus Kristus |
| 2027-01-01 | Jumat | Libur nasional | Tahun Baru 2027 |
| 2027-01-05 | Selasa | Libur nasional | Isra Mikraj (1448 H) |
| 2027-02-05 | Jumat | Cuti bersama | Imlek 2578 |
| 2027-02-06 | Sabtu | Libur nasional | Imlek 2578 |
| 2027-03-08 | Senin | Libur nasional | Nyepi |
| 2027-03-09 | Selasa | Cuti bersama | Idulfitri 1448 H |
| 2027-03-10 dan 03-11 | Rabu, Kamis | Libur nasional | Idulfitri 1448 H |
| 2027-03-12, 03-15 | Jumat, Senin | Cuti bersama | Idulfitri 1448 H |
| 2027-03-25 | Kamis | Cuti bersama | Wafat Yesus Kristus |
| 2027-03-26 | Jumat | Libur nasional | Wafat Yesus Kristus |

Daftar lengkap 2027 (18 hari libur nasional dan 8 cuti bersama, termasuk Isra Mikraj kedua 1449 H
pada 2027-12-26) ada di halaman Setneg di atas. Libur nasional dicatat sebagai hari bukan kerja.
**Cuti bersama mana yang diikuti yayasan adalah keputusan HC**; agen tidak mengisinya.

Akibatnya bagi kuota: selama tanggal-tanggal ini belum tercatat, cuti yang melewatinya memakan kuota
lebih banyak. Misalnya, 4–11 Januari 2027 dihitung 6 hari kerja, padahal dengan Isra Mikraj
5 Januari seharusnya 5 hari kerja. Aturan tanggal di §3 menjauhi tanggal-tanggal ini.

## 5. Pembacaan bukti oleh operator (baca-saja, `sqcore_hcis`)

Ganti `<peserta>` dan `<penyetuju>` dengan nama lengkap saat menjalankan kueri. Hasilnya dicatat
di dokumen bukti hanya sebagai jumlah, status, dan kode — tanpa nama.

| Sesudah | Kueri | Harus menunjukkan |
| --- | --- | --- |
| H1/H2 | `SELECT leave_entitlement_group FROM employees WHERE full_name IN (<peserta>) AND status='active'` | Kelompok yang HC tetapkan |
| H4–H7 | `SELECT a.status, i.state, i.completed_at IS NOT NULL FROM accounts a JOIN employees e ON e.id=a.employee_id LEFT JOIN account_activation_invitations i ON i.account_id=a.id WHERE e.full_name IN (<penyetuju>, <peserta>)` | Undangan `issued`, selesai, akun `active` |
| H8 | `SELECT workflow_key, mode, effective_from, effective_to FROM organization_rollout_settings` | Satu baris `leave.annual`, `STRUCTURE`, tanpa `effective_to` |
| S1/S2 langkah 1 | `SELECT status, annual_period_key, validation_summary->'authorityResolution'->>'mode' FROM leave_requests ORDER BY submitted_at` | Ditinjau, mode `STRUCTURE` |
| S1/S2 langkah 3 | `SELECT r.status, s.step_order, s.status FROM leave_requests r JOIN leave_request_approval_steps s ON s.leave_request_id=r.id ORDER BY r.submitted_at, s.step_order` | S1: semua langkah disetujui. S2: langkah 1 ditolak, langkah berikutnya dibatalkan |
| S1/S2 langkah 4 | `SELECT title FROM in_app_notifications WHERE event_key LIKE 'leave.request.decided.%'` | Satu "disetujui", satu "ditolak" |

## 6. Jalan mundur

- Routing: **Akhiri** pada baris rollout (alasan wajib); unit kembali ke data atasan lama, rantai
  pengajuan yang sudah terkirim tidak berubah.
- Pengajuan yang belum diputuskan: pemohon **Batalkan pengajuan** di Cuti & Izin.
- Akun: HC menangguhkan akun di Account & Akses.

## 7. Bukti otomatis

`apps/api/test/ops-pilot-tt-001-flow.postgres.test.ts` menjalankan §2–§3 dengan bagan sintetis
berbentuk sama dengan production (rollout dari route, undangan dan aktivasi, `409` saat kelompok
kosong, pengajuan dari bagan terbit, Setujui dua langkah, Tolak di langkah pertama, pemberitahuan,
Akhiri). Lulus 2026-11-26 bersama seluruh suite API (3357 lulus, 1 dilewati).
