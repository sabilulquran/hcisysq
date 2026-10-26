# ATT-011-2 — Hitung Ulang Otomatis: Rencana Implementasi

**Status:** **DIGANTIKAN SEBAGIAN 2026-10-24** oleh ATT-014 (`attendance-report-calculation.md`).
Owner memutuskan kehadiran dihitung lewat tombol **Kalkulasi** per unit dan rentang, bukan otomatis
di latar belakang. Antrean `attendance_recompute_requests`, worker interval, sweeper, dan pemicu
otomatis (§1–§3) **tidak dikerjakan**. Yang dibawa ke ATT-014: hitung ulang rentang sebagai proses
yang dapat dipantau, alias `finalize/{date}`, idempotensi engine (§6 butir 3–4), aturan status hari
berjalan (§5.1(b)), dan temuan data production (R9/R10). Dokumen ini dipertahankan sebagai riwayat
analisis. Tidak ada kode yang ditulis.
**Specification:** ATT-011 §6.4, tabel paket §10 baris ATT-011-2
**Menutup gap:** K-1, K-2, J-8 (`attendance-operational-simplification-gap-analysis.md`)
**Invariant yang dijaga:** I-1 … I-8 (§1 spec), khususnya I-2 (bukti immutable), I-3 (missing punch tetap `incomplete`), I-4 (jadwal bukan bukti), I-5 (cuti belum final tidak mengubah hasil)
**Review tambahan (AGENTS.md §8):** ya — migration + pemicu engine
**Disusun:** 2026-10-23

---

## 0. Ringkasan masalah dan bentuk solusi

Hari ini hasil kehadiran hanya ditulis ketika sesuatu memanggil `materializeAttendanceResult`
secara sinkron: absen HP, keputusan klarifikasi, koreksi HC, keputusan tukar shift, atau
`POST /admin/attendance/finalize/:date`. Scan mesin fingerprint, publikasi jadwal, dan keputusan
cuti **tidak** memanggilnya. Akibatnya `attendanceDailyReadModel` jatuh ke cabang live yang
mengabaikan bukti scan dan menampilkan `absent` setelah jam pulang (K-1), dan hasil lama tetap
salah sampai HC menekan Finalisasi per tanggal (K-2, J-8).

Bentuk solusi (sesuai §6.4): sumber perubahan **mengantrikan** pasangan `(employee_id, work_date)`
ke tabel antrean; sebuah worker interval di dalam proses API menguras antrean dengan memanggil
`materializeAttendanceResult` yang sudah idempotent. Mesin hitung tidak pernah berada di jalur
ACK perangkat. Sementara antrean belum terkuras, daily read menandai baris tersebut
`recomputePending` sehingga UI menulis "Sedang diperbarui", bukan "Tidak hadir".

Tidak ada perubahan pada aturan perhitungan di `evaluateSessions`/`resolveSchedule`. Paket ini
hanya mengubah **kapan** engine dijalankan dan **bagaimana** hasil yang belum siap ditampilkan.

### Berkas yang tersentuh (perkiraan)

| Berkas | Perubahan |
|---|---|
| `apps/api/migrations/0061_attendance_auto_recompute.sql` | baru, additive |
| `apps/api/src/modules/attendance/recompute-queue.ts` | baru: `enqueueRecompute`, `enqueueRecomputeRange`, `claimRecomputeBatch`, `pendingRecomputeFor` |
| `apps/api/src/modules/attendance/recompute-worker.ts` | baru: `runRecomputeBatch`, `startAttendanceRecomputeWorker` |
| `apps/api/src/app.ts` | start/stop worker, hook `onClose` |
| `apps/api/src/config/env.ts` | 4 variabel worker (default aman) |
| `apps/api/src/modules/attendance/adms/routes.ts` | enqueue setelah durable capture |
| `apps/api/src/modules/attendance/adms/projection.ts` | ekspor helper target `(employee, date)` agar dipakai ulang |
| `apps/api/src/modules/attendance/workforce-routes.ts` | enqueue pada publish roster + perubahan assignment; endpoint `recompute`; alias `finalize/:date`; `recomputePending` di daily |
| `apps/api/src/modules/attendance/reporting.ts` | `recomputePending`, koreksi status waktu-turunan, ringkasan |
| `apps/api/src/modules/leave/*-routes.ts` | enqueue setelah keputusan cuti final / validasi / resolution |
| `docs/api/attendance-workforce.openapi.yaml` | endpoint baru + deprecate alias |
| `apps/web/src/lib/workforceAttendance.ts`, `AdminAttendanceRecalculatePage.tsx`, `AdminAttendanceDailyPage.tsx`, `attendanceNavigation.ts` | UI |
| `docs/domain/attendance-operational-simplification-spec.md` | catatan implementasi §10.2 |

---

## 1. Tabel antrean `attendance_recompute_requests`

### 1.1 Skema (migration additive `0061_attendance_auto_recompute.sql`)

```sql
CREATE TABLE attendance_recompute_requests (
  id                uuid PRIMARY KEY,
  employee_id       uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date         date NOT NULL,
  reason            text NOT NULL CHECK (reason IN (
                      'adms_scan', 'mobile_clock', 'manual_correction',
                      'clarification_decision', 'overtime_decision', 'shift_swap',
                      'roster_published', 'schedule_assignment_changed', 'schedule_version_changed',
                      'calendar_exception_changed',
                      'leave_decision', 'leave_validation', 'attendance_resolution',
                      'operator_range', 'sweeper')),
  requested_at      timestamptz NOT NULL DEFAULT now(),
  last_enqueued_at  timestamptz NOT NULL DEFAULT now(),
  not_before        timestamptz NOT NULL DEFAULT now(),
  claimed_at        timestamptz,
  processed_at      timestamptz,
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code   text CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 80),
  last_failed_at    timestamptz,
  requested_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL
);

-- Dedupe: maksimal satu permintaan belum selesai per pegawai per tanggal.
CREATE UNIQUE INDEX attendance_recompute_pending_key
  ON attendance_recompute_requests (employee_id, work_date)
  WHERE processed_at IS NULL;

-- Urutan klaim worker.
CREATE INDEX attendance_recompute_claim_idx
  ON attendance_recompute_requests (not_before, requested_at)
  WHERE processed_at IS NULL;

-- Pembersihan baris selesai.
CREATE INDEX attendance_recompute_processed_idx
  ON attendance_recompute_requests (processed_at)
  WHERE processed_at IS NOT NULL;
```

Catatan skema:

- Tidak ada data pribadi di tabel ini: hanya id pegawai, tanggal kerja, alasan teknis, dan kode
  error pendek. `last_error_code` adalah kode internal (`ENGINE_ERROR`, `SCHEDULE_UNRESOLVED`, …),
  bukan pesan exception; pesan lengkap hanya ke log aplikasi (AGENTS.md §8).
- Tidak ada permission baru. Tidak ada perubahan pada tabel lain. Tidak ada backfill.
- `last_enqueued_at` adalah penanda anti-hilang untuk pemicu yang datang saat worker sedang
  menghitung baris tersebut (lihat §6).

### 1.2 Rollback dan recovery

| Skenario | Dampak | Tindakan |
|---|---|---|
| Rollback rilis (kembali ke rilis sebelumnya) | Kode lama tidak mengenal tabel; antrean berhenti terkuras; tidak ada error. | Tidak ada. HC kembali memakai Finalisasi per tanggal (alias endpoint lama tetap ada di rilis lama). Hasil yang sudah dibuat worker tetap valid karena diproduksi oleh engine yang sama. |
| Rollback migration | `DROP TABLE attendance_recompute_requests;` aman: isinya murni data turunan/antrean, bukan bukti maupun hasil. | Jalankan `DROP TABLE` hanya bila owner meminta; tidak diperlukan untuk rollback rilis. |
| Antrean menumpuk (worker mati) | Daily read tetap benar karena `recomputePending` dihitung dari **bukti vs hasil**, bukan dari antrean saja (§5.2). Status tampil "Sedang diperbarui", bukan "Tidak hadir". | Hidupkan kembali worker; antrean terkuras sendiri. |
| Baris macet gagal ≥ 5 kali | Baris berhenti diklaim dan dilaporkan sebagai "Gagal dihitung". | HC menjalankan Hitung ulang rentang untuk tanggal itu; endpoint mereset `attempts = 0` dan `not_before = now()`. |
| Perlu membuang antrean | `DELETE FROM attendance_recompute_requests WHERE processed_at IS NULL;` aman; sweeper (§2.4) akan mengisi ulang yang memang perlu. | Operasi database production butuh persetujuan owner. |

Retensi: worker menghapus baris `processed_at < now() - interval '14 days'` (maks 500 baris per tick),
agar tabel tidak tumbuh tanpa batas di perangkat Mi8VPS.

---

## 2. Pemicu

Helper tunggal, dipanggil dengan `PoolClient` transaksi sumber bila ada:

```ts
enqueueRecompute(db: Pool | PoolClient, items: Array<{ employeeId: string; workDate: string }>,
                 reason: RecomputeReason, requestedByAccountId?: string): Promise<number>
```

Implementasi: satu `INSERT … SELECT * FROM unnest($1::uuid[], $2::date[])`
dengan `ON CONFLICT (employee_id, work_date) WHERE processed_at IS NULL
DO UPDATE SET last_enqueued_at = now(), not_before = least(…, now())`. Satu statement untuk
seluruh batch, jadi biayanya satu round-trip berapa pun jumlah pasangannya.

**Aturan tanggal:** pasangan dengan `work_date > hari ini (Asia/Jakarta)` tidak diantrikan
(§6.4: tanggal masa depan tidak dihitung, read model menampilkan Terjadwal).

### 2.1 ADMS — ACK tidak boleh menunggu mesin hitung

Keadaan sekarang: handler `cdata` di `adms/routes.ts` memanggil `projectAdmsRequest(pool, …)`
**sebelum** mengirim ACK, dan fungsi itu membuka transaksi per pasangan `(pegawai, tanggal)`.
Jadi jalur ACK hari ini sudah mengandung kerja per-pasangan; paket ini **tidak boleh menambah**
mesin hitung di sana.

Rencana:

1. Ekstrak query target di `projectAdmsRequest` menjadi `admsProjectionTargets(db, requestId)`
   (perilaku tidak berubah; `projectAdmsRequest` memakainya).
2. Setelah durable capture dan setelah `projectAdmsRequest`, panggil `enqueueRecompute` satu kali
   untuk seluruh target request tersebut dengan `reason = 'adms_scan'`.
3. Panggilan enqueue dibungkus `try/catch` dengan log — kegagalan enqueue **tidak pernah**
   mengubah status ACK, sama seperti perlakuan proyeksi saat ini. Jaring pengamannya adalah
   sweeper (§2.4) dan `recomputePending` yang dihitung dari bukti (§5.2).
4. **Shift melewati tengah malam.** Target ADMS memakai tanggal Jakarta dari `occurred_at`,
   sedangkan engine membaca event pada jendela ±6 jam di sekitar jadwal. Scan pulang pukul 05:10
   milik shift malam 21:00–05:00 bertanggal kerja H-1. Karena itu untuk setiap target tanggal `D`
   kita mengantrikan `D` **dan** `D-1`. Dedupe membuat ini murah, dan `materializeAttendanceResult`
   pada hari yang tidak berubah tidak menghasilkan versi baru (input hash sama).

Biaya tambahan di jalur ACK: satu `INSERT … ON CONFLICT` untuk seluruh request. Diukur dalam
test (§7 butir b) dengan memastikan `materializeAttendanceResult` tidak terpanggil selama request.

Absen HP (`POST /attendance/mobile/clock`, `workforce-routes.ts:529`) dan koreksi HC sudah
menghitung sinkron dan memang mengembalikan hasil ke pemanggil; perilaku itu dipertahankan,
tidak diganti antrean, agar respons UI tetap menampilkan hasil langsung.

### 2.2 Jadwal

| Titik | Yang diantrikan | Alasan |
|---|---|---|
| `POST /admin/attendance/rosters/:rosterId/publish` | Semua `(employee_id, work_date)` dari `attendance_roster_entries` roster tersebut, dibatasi `work_date <= hari ini`; di dalam transaksi publish. | `roster_published` |
| `POST /admin/attendance/schedule-assignments` dan `PATCH …/:assignmentId` | Pegawai assignment tersebut untuk tanggal terdampak dalam irisan `[effective_from, coalesce(effective_to, hari ini)]` ∩ `[hari ini - 93 hari, hari ini]`, difilter `weekday_mask`. | `schedule_assignment_changed` |
| Versi shift yang berlaku berubah (saat ini hanya lewat pembuatan versi di `workforce-routes`) | Pegawai yang memakai template itu, untuk hari ini saja. | `schedule_version_changed` |
| Libur kalender ditambah/diubah: `PUT /admin/leave/calendar/exceptions/:date` (`leave/calendar-admin-routes.ts`) | Pegawai aktif yang jadwalnya ter-resolve dari assignment pada tanggal itu, hanya bila tanggal `<= hari ini`. Resolver ATT-007 memprioritaskan libur di atas assignment, jadi hasil yang sudah ada berubah. WDMS 8.0.5 juga memasukkan libur ke pemicu real-time (lihat `attendance-wdms-805-source-audit.md` R1). | `calendar_exception_changed` |

Batas 93 hari ke belakang disengaja: mengubah assignment lama tidak boleh menjadwalkan
hitung ulang seluruh sejarah di perangkat Mi8VPS. Rentang lebih panjang tetap bisa diminta HC
lewat Hitung ulang rentang. Batas ini dicatat sebagai konstanta bernama dan disebut di dokumen.

Di ATT-011-4 titik pemicu ini pindah ke `schedule change set` applied (§5.3 spec, langkah 5);
helper `enqueueRecompute` dipakai ulang tanpa perubahan.

### 2.3 Cuti dan resolution

Diantrikan di dalam transaksi keputusan, untuk **setiap tanggal kalender** yang terdampak,
dibatasi `<= hari ini`:

| Titik | Berkas | `reason` |
|---|---|---|
| Langkah persetujuan terakhir → `leave_requests.status = 'approved'` | `leave/employee-routes.ts` (~937/980), `planned-leave-routes.ts` (~1041/1153), `special-leave-routes.ts` (~990) | `leave_decision` |
| Hari divalidasi / `needs_correction` → `leave_request_validation_days.status` berubah | `attendance-resolution-routes.ts` (~500/570/577), `planned-leave-routes.ts` (~993/1034) | `leave_validation` |
| Keputusan HC resolution → `attendance_resolution_cases.status = 'resolved'` | `attendance-resolution-routes.ts` (~822) | `attendance_resolution` |
| Konversi cuti tahunan oleh pegawai → `resolved` | `attendance-resolution-routes.ts` (~986) | `attendance_resolution` |

Rentang tanggal diambil dari `start_on`/`end_on` request atau dari
`attendance_resolution_days.calendar_date`, sehingga tidak ada tebakan.

**I-5 dijaga:** yang diantrikan adalah *keputusan*, bukan pengajuan. Pengajuan `in_review` dan hari
`unresolved` tidak memicu apa pun, dan sekalipun diantrikan oleh pemicu lain, query disposisi di
`materializeAttendanceResult` tetap mengabaikannya — hasilnya tidak berubah menjadi `leave`.

**Pembatalan cuti approved:** status `cancelled` ada di tipe domain, tetapi belum ada endpoint
yang menulisnya. Tidak ada pemicu yang bisa dipasang sekarang; dicatat sebagai pertanyaan
owner Q6 dan sebagai TODO di dokumen bila endpoint itu dibuat.

### 2.4 Sweeper penangkap sisa (disarankan, dalam scope)

Satu pass periodik (default tiap 10 menit, jendela 3 hari ke belakang) yang mengantrikan pasangan
yang **punya bukti lebih baru daripada hasil tersimpan**:

```sql
SELECT event.employee_id, (event.occurred_at AT TIME ZONE 'Asia/Jakarta')::date
FROM attendance_events event
LEFT JOIN LATERAL (
  SELECT max(result.created_at) AS created_at
  FROM attendance_result_versions result
  WHERE result.employee_id = event.employee_id
    AND result.work_date = (event.occurred_at AT TIME ZONE 'Asia/Jakarta')::date
) latest ON true
WHERE event.occurred_at >= now() - $window
  AND (latest.created_at IS NULL OR latest.created_at < event.received_at)
GROUP BY 1, 2
LIMIT $cap
```

Ini menutup enqueue yang gagal, restart proses di tengah batch, dan event yang masuk lewat jalur
recovery ADMS. Biayanya satu query beragregat per 10 menit pada jendela kecil. Tanpa sweeper,
sistem tetap benar di layar (karena `recomputePending`) tetapi hasil tersimpan bisa tertinggal diam-diam.

---

## 3. Desain worker

### 3.1 Kendala Mi8VPS

Tidak ada systemd dan tidak ada Docker; proses `hcis` dijalankan `sq-core-launch.sh` dan diawasi
`sq-core-worker.sh`, dan **mengubah launcher adalah perubahan perangkat yang membutuhkan
persetujuan owner** (AGENTS.md §2). Karena itu worker **tidak boleh** menjadi proses baru:
ia adalah `setInterval` di dalam proses API yang sudah berjalan. Konsekuensi yang harus diterima
dan dicatat di release note:

1. **Berbagi CPU dan pool koneksi dengan request HTTP.** Perangkat adalah ponsel Android dalam
   chroot. Batch besar bisa membuat halaman Kehadiran dan ACK ADMS melambat.
2. **Tidak ada jaminan berjalan bila proses mati.** Worker hidup selama proses API hidup;
   `sq-core-worker.sh` yang menjaga proses. Tidak ada eksekusi saat downtime — antrean menunggu,
   dan tampilan tetap benar lewat `recomputePending`.
3. **Satu proses, tetapi klaim tetap aman untuk banyak proses.** Klaim memakai
   `FOR UPDATE SKIP LOCKED`, jadi rilis berikutnya boleh menjalankan dua proses tanpa perubahan.
4. **Timer di test.** Worker dimatikan secara default saat `NODE_ENV=test`; test memanggil
   `runRecomputeBatch()` langsung agar tidak ada timer yang bocor.

### 3.2 Bentuk kode

```ts
// recompute-worker.ts
export async function runRecomputeBatch(pool: Pool, options: {
  batchSize: number; maxAttempts: number; budgetMs: number; now?: Date; logger: FastifyBaseLogger;
}): Promise<{ claimed: number; succeeded: number; failed: number; requeued: number }>

export function startAttendanceRecomputeWorker(pool: Pool, options): { stop(): Promise<void> }
```

Alur satu tick:

1. **Klaim** (satu statement):
   ```sql
   UPDATE attendance_recompute_requests queue
   SET claimed_at = now(), attempts = attempts + 1
   WHERE queue.id IN (
     SELECT id FROM attendance_recompute_requests
     WHERE processed_at IS NULL AND not_before <= now() AND attempts < $maxAttempts
     ORDER BY not_before, requested_at
     LIMIT $batchSize
     FOR UPDATE SKIP LOCKED)
   RETURNING id, employee_id, work_date, last_enqueued_at;
   ```
2. **Proses berurutan, satu per satu** (bukan `Promise.all`): untuk setiap baris panggil
   `materializeAttendanceResult(pool, employeeId, workDate)`.
   - Sukses → `UPDATE … SET processed_at = now(), last_error_code = NULL
     WHERE id = $1 AND last_enqueued_at = $2`. Bila `rowCount = 0`, berarti ada pemicu baru
     saat hitung berjalan: baris sengaja dibiarkan pending dan diproses pada tick berikutnya.
   - Gagal → `UPDATE … SET last_error_code = $2, last_failed_at = now(),
     not_before = now() + backoff(attempts)` dengan backoff `30s, 2m, 10m, 30m, 2h`.
     Pesan exception hanya ke log.
3. **Anggaran waktu.** Tick berhenti lebih awal bila `budgetMs` (default 8 detik) terlampaui;
   sisa baris tetap pending dan diambil tick berikutnya. Ini yang mencegah satu tick memonopoli
   perangkat.
4. **Tidak tumpang tindih.** Satu flag `running`; tick yang jatuh saat tick sebelumnya masih
   berjalan dilewati dan dicatat sebagai `skipped_tick` di log.
5. **Pembersihan** retensi 14 hari dan **sweeper** (§2.4) dijalankan pada tick yang jatuh pada
   kelipatan intervalnya masing-masing, bukan setiap tick.
6. **Log terstruktur tanpa data pribadi** per tick: `claimed`, `succeeded`, `failed`, `requeued`,
   `durationMs`, `queueDepth`. Tidak ada nama pegawai; id pegawai tidak dilog pada level info.

### 3.3 Konfigurasi (`config/env.ts`)

| Variabel | Default | Keterangan |
|---|---|---|
| `ATTENDANCE_RECOMPUTE_WORKER` | `1`, dipaksa `0` saat `NODE_ENV=test` | Sakelar mati/hidup tanpa rilis kode baru (hanya restart proses). |
| `ATTENDANCE_RECOMPUTE_INTERVAL_MS` | `30000` (DRAFT) | Interval tick. |
| `ATTENDANCE_RECOMPUTE_BATCH` | `50` (usulan, lebih kecil dari DRAFT 200 di spec) | Jumlah baris diklaim per tick. |
| `ATTENDANCE_RECOMPUTE_BUDGET_MS` | `8000` | Anggaran waktu per tick. |
| `ATTENDANCE_RECOMPUTE_SWEEP_MINUTES` | `10` | Interval sweeper; `0` mematikan. |

Sakelar `ATTENDANCE_RECOMPUTE_WORKER` membuat rilis bertahap mungkin: rilis pertama boleh
dipasang dengan worker **mati** (hanya migration + endpoint + UI), lalu dihidupkan setelah owner
melihat kedalaman antrean di log. Perubahan env di Mi8VPS tetap butuh persetujuan owner.

### 3.4 Memverifikasi asumsi DRAFT kapasitas

Spec menandai interval 30 detik / batch 200 sebagai DRAFT. Usul verifikasi, berurutan, tanpa
menulis apa pun yang baru ke production:

1. **Read-only lebih dulu** (`ssh mi8vps`, diizinkan tanpa persetujuan khusus): jumlah pegawai
   aktif, rata-rata dan puncak `attendance_adms_events` per hari, jumlah `attendance_events`
   per hari, dan ukuran `attendance_result_versions`. Dari sini didapat perkiraan jumlah pemicu
   harian = jumlah scan (bukan jumlah pegawai), karena dedupe menggabungkan scan masuk dan pulang
   satu pegawai menjadi satu baris antrean.
2. **Ukur biaya engine per pasangan tanpa jalur baru.** `POST /admin/attendance/finalize/:date`
   yang ada sekarang menjalankan `materializeAttendanceResult` berurutan untuk seluruh pegawai
   aktif dan **idempotent**: untuk tanggal lampau yang inputnya tidak berubah, ia tidak membuat
   versi baru (cek `input_hash`). Menjalankannya sekali untuk satu tanggal lampau memberi angka
   total/jumlah pegawai = biaya per pasangan di perangkat sebenarnya. Ini tetap memanggil jalur
   tulis, jadi **butuh persetujuan owner** (pertanyaan Q2).
3. **Kalibrasi.** Dengan biaya per pasangan `c` ms dan anggaran tick 8 detik, batch efektif
   ≈ `8000 / c`. Default dikirim dengan batch 50 dan dinaikkan hanya setelah pengukuran.
   Target yang diusulkan ke owner: hasil scan tampil benar di layar ≤ 60 detik setelah scan.
4. **Setelah rilis:** log per tick (butir 3.2.6) adalah bukti berjalan; bila `queueDepth` tidak
   pernah turun ke nol di luar jam sibuk, batch/interval disesuaikan lewat env.

Alternatif yang **tidak** diambil: benchmark di laptop pengembang. Perangkat Mi8VPS adalah ponsel
Android; angka laptop tidak dapat dipakai untuk menetapkan batas, hanya untuk mendeteksi regresi
besar.

---

## 4. Kontrak API

### 4.1 `POST /admin/attendance/recompute` (baru)

- Permission: `attendance.policy.manage`.
- Body: `{ from: date, to: date, employeeId?: uuid, unitId?: uuid }`.
- Validasi: `from <= to`; rentang maksimal **31 hari**; `to` tidak boleh melewati hari ini
  (Asia/Jakarta) — tanggal masa depan tidak dihitung (§6.4).
- Perilaku: mengantrikan pasangan `(pegawai aktif sesuai filter) × (tanggal dalam rentang)`
  dengan `reason = 'operator_range'`, dan untuk baris pending yang sudah gagal mereset
  `attempts = 0, not_before = now(), last_error_code = NULL`. **Tidak** menghitung sinkron.
- Respons `202`: `{ from, to, queued, employees, dates }`.
- Error: `400 INVALID_RECOMPUTE_RANGE`, `422 RECOMPUTE_RANGE_TOO_LARGE`, `403`.
- Audit: `attendance.finalized` (nama event dipertahankan agar jejak audit lama tetap bisa
  dibaca) dengan metadata `{ from, to, queued, employees, filter }`.

Mengapa asinkron: 31 hari × seluruh pegawai aktif dijalankan serial di perangkat Mi8VPS akan
melewati batas waktu HTTP dan memblokir proses API selama menit-menitan. Konsekuensi yang
terlihat operator: tombol tidak lagi menunggu sampai selesai; halaman menampilkan
"Antrean hitung ulang dibuat" dan daily read menandai baris terkait "Sedang diperbarui" sampai
selesai. Ini perubahan perilaku yang terlihat owner → pertanyaan Q1.

### 4.2 `POST /admin/attendance/finalize/:date` (alias, satu rilis)

Tetap ada, permission sama, memanggil logika yang sama dengan `from = to = :date`.
Respons dipertahankan bentuknya: `{ date, materialized, queued, deprecated: true }` dengan
`materialized` bernilai sama dengan `queued` selama masa alias. Ditandai
`deprecated: true` di OpenAPI dan dihapus pada paket ATT-011-3 atau rilis berikutnya setelah
owner mengonfirmasi tidak ada otomasi luar yang memakainya.

### 4.3 `GET /admin/attendance/daily` — field `recomputePending`

Setiap item mendapat `recomputePending: boolean`. Definisi (§5.2) dan dampaknya pada `summary`
dijelaskan di bawah. `status` **tidak** mendapat nilai enum baru; "Sedang diperbarui" adalah
label UI, bukan status backend. Ini menjaga filter status, laporan, dan konsumen lain tetap valid.

### 4.4 OpenAPI

`docs/api/attendance-workforce.openapi.yaml`: tambah path `/admin/attendance/recompute`
(`operationId: requestAttendanceRecompute`, `x-required-permission: attendance.policy.manage`,
respons 202/400/403/422), tandai `finalizeAttendanceDate` dengan `deprecated: true` dan
deskripsi aliasnya, dan perbarui deskripsi `/admin/attendance/daily` agar menyebut
`recomputePending`. Gaya berkas ini ringkas (deskripsi, tanpa schema komponen) dan diikuti apa adanya.

---

## 5. Read model dan UI

### 5.1 Dua perbaikan di `reporting.ts`

**(a) `recomputePending`.** Dihitung dengan dua query set-based per permintaan daily (bukan per
baris — loop per pegawai yang ada sekarang sudah N+1 dan tidak boleh diperburuk):

1. pasangan pending di `attendance_recompute_requests` untuk tanggal dan himpunan pegawai itu;
2. per pegawai, `max(received_at)` bukti pada jendela tanggal tersebut (`attendance_events`
   ditambah `attendance_adms_events` yang ter-mapping tetapi belum dinormalisasi), dibandingkan
   dengan `created_at` versi hasil terakhir.

`recomputePending = adaBaris pending OR buktiLebihBaruDariHasil`. Klausa kedua penting: ia membuat
layar benar walaupun enqueue gagal atau worker mati, dan ia yang secara langsung menutup K-1.

**(b) Status turunan waktu pada hasil tersimpan.** Risiko baru yang dibawa paket ini: begitu ada
hasil tersimpan untuk **hari ini**, cabang live tidak lagi dipakai, sehingga hasil `scheduled`
atau `pending` yang ditulis pagi hari akan tetap tampil `pending` setelah jam pulang lewat
meskipun pegawai tidak pernah hadir — tidak ada pemicu untuk hari tanpa scan. Perbaikan:
pada daily read, bila hasil tersimpan berstatus `scheduled`/`pending` **dan** tidak punya
`firstCheckInAt`, status tampilan diturunkan dari jam sekarang dengan aturan yang sama persis
dengan cabang live (`now < start` → `scheduled`, `now <= end` → `pending`, selain itu `absent`).
Ini tampilan saja; tidak ada versi hasil baru yang ditulis.

**(c) Ringkasan.** Baris dengan `recomputePending = true` yang status tampilannya `absent`
dikeluarkan dari hitungan kartu `absent` dan dimasukkan ke kunci baru `recomputePending` pada
objek `summary`. Tanpa ini, operator masih melihat angka "Tidak hadir" yang memuat pegawai yang
sudah scan — ATT-011-F belum benar-benar tertutup. Keputusan kecil yang terlihat owner → Q7.

### 5.2 Web

| Berkas | Perubahan |
|---|---|
| `lib/workforceAttendance.ts` | `AttendanceDailyItem.recomputePending: boolean`; ganti `finalizeAttendanceDate` dengan `requestAttendanceRecompute({ from, to, unitId?, employeeId? })`. |
| `pages/AdminAttendanceDailyPage.tsx` | Sel Status menampilkan "Sedang diperbarui" + ikon berputar halus bila `recomputePending`, menggantikan label status (khususnya "Tidak hadir"); judul tooltip "Hasil sedang dihitung ulang dari scan terbaru." Jam tetap "?" bila belum ada (I-3). Chip ringkasan menampilkan "Sedang diperbarui: N". |
| `pages/AdminAttendanceRecalculatePage.tsx` | Dari satu tanggal menjadi rentang **Dari/Sampai** (maks 31 hari, default hari ini), filter unit opsional; pesan sukses "Antrean hitung ulang dibuat untuk N pegawai × M hari. Hasil diperbarui otomatis dalam beberapa menit." Teks pembuka ditulis ulang: halaman ini **bukan** langkah rutin lagi, melainkan alat pemulihan setelah gangguan. |
| `lib/attendanceNavigation.ts` | Label tab/menu "Finalisasi ulang" → "Hitung ulang rentang". Route `/admin/attendance/settings/recalculate` dan permission `attendance.policy.manage` tidak berubah, jadi tidak ada redirect baru. |

Halaman itu **tidak dihapus**: spec §3 menempatkan "Hitung ulang rentang" di Pengaturan secara
permanen, dan ia adalah jalur pemulihan untuk baris yang gagal ≥ 5 kali.

Pelaporan kegagalan: antrean "Perlu tindakan" baru ada di ATT-011-3. Sampai itu, kegagalan
ditampilkan sebagai banner di halaman Kehadiran harian dan di halaman Hitung ulang rentang
("N hasil gagal dihitung — hubungi admin sistem"), tanpa detail teknis, dari hitungan baris
pending dengan `attempts >= 5`. Perlu konfirmasi owner → Q3.

---

## 6. Idempotensi

Lima lapis, tidak ada yang mengandalkan lapis lain:

1. **Dedupe antrean.** Unique index parsial `(employee_id, work_date) WHERE processed_at IS NULL`.
   Sepuluh scan beruntun satu pegawai dalam satu hari = satu baris antrean, satu perhitungan.
2. **Klaim eksklusif.** `FOR UPDATE SKIP LOCKED` pada klaim: satu baris tidak pernah dikerjakan
   dua worker/dua proses sekaligus.
3. **Lock per hasil.** `materializeAttendanceResult` sudah mengambil
   `pg_advisory_xact_lock(hashtextextended('attendance-result:<employee>:<date>'))`, jadi worker,
   absen HP, dan keputusan klarifikasi tidak pernah menulis bersamaan untuk pasangan yang sama.
4. **Dedupe versi hasil.** Engine menghitung `input_hash` dari jadwal, daftar event, klarifikasi,
   cuti/resolution, lembur, dan hasil perhitungan; bila versi dengan hash itu sudah ada ia
   dikembalikan apa adanya. **Tidak ada versi ganda** untuk input yang sama. Ini berlaku juga
   untuk urutan A→B→A: kembali ke A mengembalikan versi A yang lama.
   Pengecualian yang disengaja dan sudah ada hari ini: untuk **hari berjalan**, status turunan
   waktu (`scheduled`/`pending`/`absent`) ikut masuk hash, jadi hitung ulang pada jam berbeda
   memang boleh membuat versi baru. Itu fakta yang berbeda, bukan duplikat. Karena enqueue hanya
   terjadi pada pemicu nyata, jumlahnya terbatas pada jumlah pemicu, bukan jumlah tick.
5. **Pemicu saat perhitungan berjalan.** Penanda `last_enqueued_at`: penyelesaian hanya ditulis
   bila nilainya belum berubah sejak klaim. Bila berubah (ada scan baru di tengah perhitungan),
   baris tetap pending dan dihitung lagi — paling buruk satu perhitungan ekstra, tidak pernah
   hasil yang tertinggal.

**Retry** menambah `attempts` pada saat klaim (bukan saat gagal), sehingga proses yang mati di
tengah perhitungan tidak membuat baris itu dicoba tanpa batas: setelah `maxAttempts` ia berhenti
diklaim dan dilaporkan. Backoff menaik mencegah baris rusak memakan anggaran tick.

---

## 7. Daftar test minimum

Mengikuti kolom test §10 baris ATT-011-2, ditambah dua penjaga regresi yang muncul dari
pembacaan kode. Unit/route test memakai pola `vi.fn()` pool yang sudah ada
(`attendance-workforce-engine.test.ts`); yang membutuhkan semantik PostgreSQL nyata memakai pola
`describe.skipIf(!allowed)` + transaksi luar yang di-rollback
(`attendance-mobile-clock.postgres.test.ts`).

**Berkas baru:** `apps/api/test/attendance-recompute-queue.test.ts`,
`attendance-recompute-worker.test.ts`, `attendance-recompute-routes.test.ts`,
`attendance-auto-recompute-migration.test.ts`, dan tambahan kasus di
`attendance-reporting.test.ts`.

| # | Test | Butir spec |
|---|---|---|
| a | Scan ADMS ter-mapping → satu tick worker → versi hasil `present`/`late` ada **tanpa** memanggil finalisasi; daily read menampilkannya. | Scan ADMS → result tanpa finalisasi; ATT-011-F |
| b | Handler `cdata` ADMS membalas ACK dengan baris antrean pending dan **tanpa** `materializeAttendanceResult` terpanggil di jalur request (spy pada modul engine). | ACK ADMS tidak menunggu engine |
| c | Enqueue ADMS mengantrikan `D` dan `D-1`; scan pulang 05:10 untuk shift 21:00–05:00 menghasilkan sesi lengkap pada tanggal kerja H-1. | Pemicu ADMS (§2.1) |
| d | Cuti `approved` + hari `validated` → hitung ulang menghasilkan `leave`. | Cuti approved/validated → `leave` |
| e | Cuti `in_review`, dan hari `unresolved`, → hitung ulang **tidak** mengubah status menjadi `leave`. | Cuti belum final tidak berubah; I-5 |
| f | Resolution `unpaid_absence` resolved → `absent` dengan `source_attendance_resolution_case_id` terisi. | K-2 |
| g | Publish roster mengantrikan hanya tanggal `<= hari ini` untuk pegawai di roster; tanggal masa depan tidak diantrikan. | Publish jadwal → hitung ulang; J-8 |
| h | Perubahan assignment mengantrikan tanggal dalam irisan effective range ∩ 93 hari terakhir, terfilter `weekday_mask`. | §2.2 |
| i | **Missing punch tetap `incomplete`**: satu event masuk tanpa pulang → status `incomplete`, `lastCheckOutAt = null`, `incompleteSession = true` setelah hitung ulang otomatis. | Missing punch tetap `incomplete`; I-3; ATT-011-K |
| j | **Jam jadwal tidak pernah menjadi bukti**: untuk kasus (i), `firstCheckInAt` sama persis dengan `occurred_at` event, dan tidak ada nilai hasil yang sama dengan `scheduledStartAt`/`scheduledEndAt` kecuali kolom jadwal itu sendiri; tidak ada sesi yang dibuat untuk hari tanpa event. | I-3, I-4; ATT-011-K |
| k | **Idempotent**: enqueue tiga kali → satu baris pending; dua tick berturut-turut tanpa perubahan input → jumlah `attendance_result_versions` tetap, `version` tidak naik. | Idempotent (tidak ada versi duplikat) |
| l | **Bukti tidak berubah**: snapshot `attendance_events` dan `attendance_adms_events` sebelum/sesudah satu tick identik, kecuali baris normalisasi ADMS yang **hanya menambah** (diperiksa eksplisit: tidak ada UPDATE/DELETE). | Bukti tidak berubah; I-2 |
| m | **Retry/backoff**: `materializeAttendanceResult` dipaksa melempar → `attempts` naik, `not_before` maju, `last_error_code` terisi, tidak ada versi hasil; setelah `maxAttempts` baris tidak lagi diklaim dan terhitung sebagai gagal. | Worker retry/backoff |
| n | Pemicu baru saat baris sedang dihitung → baris tetap pending (`last_enqueued_at` berubah) dan diproses pada tick berikutnya. | §6 butir 5 |
| o | Dua `runRecomputeBatch` paralel (postgres) → tidak ada baris diproses dua kali, tidak ada versi ganda. | §6 butir 2 |
| p | `POST /admin/attendance/recompute`: 403 tanpa `attendance.policy.manage`; 400 `from > to`; 422 rentang > 31 hari; 400 `to` di masa depan; 202 dengan `queued` benar; audit `attendance.finalized` memuat `from`/`to`. | Kontrak API |
| q | Alias `POST /admin/attendance/finalize/:date` tetap 200 dan mengantrikan pasangan yang sama. | Alias satu rilis |
| r | `recomputePending` pada daily: `true` bila ada bukti lebih baru dari hasil **tanpa** baris antrean (worker mati); `false` setelah hitung ulang; baris pending dikeluarkan dari hitungan `absent` di `summary`. | §5.1; ATT-011-F |
| s | **Regresi waktu**: hasil tersimpan `pending` untuk hari ini tanpa check-in ditampilkan `absent` setelah jam pulang lewat, tanpa menulis versi baru. | §5.1(b) |
| t | Migration: tabel, unique index parsial, dan index klaim ada; tidak ada permission atau kolom tabel lain yang berubah. | Migration additive |
| u | `createApp` **tidak** memasang interval saat `NODE_ENV=test` / sakelar mati; `stop()` membersihkan timer (tidak ada handle menggantung di vitest). | §3.1 butir 4 |
| v | Web: baris dengan `recomputePending` menampilkan "Sedang diperbarui" dan bukan "Tidak hadir"; halaman Hitung ulang menolak rentang > 31 hari di klien. | UI §5.2 |

Gate kualitas (AGENTS.md §7) dijalankan sungguhan sebelum merge: `pnpm -r typecheck`,
`pnpm -r lint`, `pnpm -r test`, `pnpm -r build`, dan migration bersih pada database kosong.
Tidak ada data pegawai nyata di fixture.

---

## 8. Risiko, dampak rollback, dan pertanyaan owner

### 8.1 Risiko

| # | Risiko | Mitigasi |
|---|---|---|
| R1 | Worker memperlambat API di perangkat Mi8VPS (ponsel, satu proses). | Batch kecil (50), pemrosesan serial, anggaran tick 8 detik, tick tidak tumpang tindih, sakelar env untuk mematikan tanpa rilis, rilis bertahap dengan worker mati dulu. |
| R2 | Asumsi kapasitas DRAFT salah dan antrean tidak pernah kosong. | Rencana verifikasi §3.4; log `queueDepth` per tick; batas yang dapat diubah lewat env dengan persetujuan owner. |
| R3 | Lonjakan versi hasil (`attendance_result_versions` tumbuh) karena hitung ulang lebih sering. | `input_hash` mencegah duplikat; enqueue hanya pada pemicu nyata; tanggal masa depan tidak dihitung; pertumbuhan yang tersisa setara dengan jumlah perubahan fakta sebenarnya. Dipantau lewat jumlah baris sebelum/sesudah rilis. |
| R4 | Jalur ACK ADMS melambat karena enqueue. | Satu `INSERT … ON CONFLICT` per request, di luar transaksi capture, kegagalannya ditelan; diuji (test b). Catatan: proyeksi ADMS yang sudah ada hari ini jauh lebih mahal daripada enqueue ini dan tidak diubah oleh paket ini. |
| R5 | Status `pending` membeku untuk hari berjalan (regresi baru dari paket ini). | §5.1(b) + test (s). |
| R6 | Pemicu cuti menyentuh enam berkas route cuti; salah tempat = hasil tidak ikut berubah. | Enqueue hanya pada titik transisi status final yang sudah teridentifikasi (§2.3) dan di dalam transaksi yang sama; sweeper **tidak** menutup kasus cuti (tidak ada bukti baru), jadi setiap titik punya test sendiri (d, e, f). |
| R7 | Operator menganggap tombol Hitung ulang "tidak bekerja" karena asinkron. | Pesan eksplisit + label "Sedang diperbarui" pada baris terdampak; perilaku ini dibawa ke owner sebagai Q1 sebelum implementasi. |
| R8 | Pembuangan antrean/retensi menghapus baris yang masih dibutuhkan. | Hanya baris `processed_at` yang dihapus; baris pending tidak pernah disentuh retensi. |
| R9 | Nilai paket bergantung pada jadwal. Data production 2026-10-23: hanya 1 dari 99 pegawai aktif punya assignment jadwal, 0 roster published; engine belum pernah memproses scan mesin (`attendance-wdms-805-source-audit.md` §8). Tanpa jadwal, engine memberi `off` dan tidak membaca scan, sehingga hitung ulang otomatis tidak mengubah tampilan. | Jadwal (Pola jadwal yang sudah ada di UI, atau ATT-011-4/5) harus diisi HC sebelum atau bersamaan dengan rilis; ini dibawa ke owner sebagai prasyarat operasional. |
| R10 | Gelombang "Tidak lengkap" begitu jadwal terisi dan worker aktif: ± 29% hari-pegawai hanya punya satu scan. | Perilaku ini benar menurut I-3, tetapi harus diumumkan ke HC sebelum rilis. Hitung ulang rentang historis tidak dijalankan otomatis; worker hanya memproses pemicu baru, dan HC memilih sendiri rentang lampau yang ingin dihitung. |

### 8.2 Dampak rollback

Rollback ke rilis sebelumnya aman dan tanpa kehilangan data: tabel antrean diabaikan, hasil yang
sudah dibuat tetap valid (diproduksi engine yang sama), dan `POST /finalize/:date` ada di kedua
rilis. Yang **kembali** setelah rollback: pegawai yang scan kembali tampil "Tidak hadir" sampai HC
menekan Finalisasi, karena `recomputePending` tidak dikenal rilis lama. Itu adalah perilaku
sebelum paket ini, bukan kerusakan baru, tetapi harus disebut dalam release note sebelum rollback
diputuskan. Migration tidak perlu dibalik; bila owner memintanya, `DROP TABLE` aman.

### 8.3 Pertanyaan yang membutuhkan keputusan owner

| # | Pertanyaan | Usulan |
|---|---|---|
| Q1 | Hitung ulang rentang berjalan **asinkron** (tombol tidak menunggu, hasil masuk dalam beberapa menit) atau tetap sinkron seperti Finalisasi sekarang? | Asinkron. Sinkron untuk 31 hari × seluruh pegawai tidak realistis di Mi8VPS. |
| Q2 | Boleh menjalankan `POST /admin/attendance/finalize/:date` satu kali untuk **satu tanggal lampau** di production demi mengukur biaya engine per pegawai? Operasinya idempotent (tidak membuat versi baru bila input tidak berubah) tetapi tetap memanggil jalur tulis. | Ya, satu kali, pada tanggal yang HC sepakati, dengan pencatatan hasil pengukuran. |
| Q3 | Di mana kegagalan hitung ulang ditampilkan sebelum antrean "Perlu tindakan" (ATT-011-3) ada? | Banner di Kehadiran harian dan di halaman Hitung ulang rentang, tanpa detail teknis. |
| Q4 | Sweeper penangkap sisa (§2.4) masuk scope paket ini? | Ya, jendela 3 hari, interval 10 menit. Tanpa itu hasil tersimpan bisa tertinggal diam-diam saat enqueue gagal. |
| Q5 | Retensi baris antrean yang sudah selesai. | 14 hari. |
| Q6 | Pembatalan cuti yang sudah approved belum punya endpoint. Dibiarkan tanpa pemicu untuk sekarang? | Ya; dicatat sebagai prasyarat bila endpoint itu dibuat. |
| Q7 | Baris yang sedang dihitung ulang dikeluarkan dari hitungan kartu "Tidak hadir" dan dihitung sebagai "Sedang diperbarui"? | Ya; tanpa ini angka kartu masih memuat pegawai yang sudah scan (ATT-011-F belum tertutup). |
| Q8 | Rilis bertahap: rilis pertama dengan worker **mati** lalu dihidupkan lewat env setelah antrean diamati, atau langsung hidup? | Langsung hidup bila Q2 sudah memberi angka; bertahap bila tidak. |

---

## 9. Urutan kerja yang diusulkan (satu PR)

1. Migration `0061` + test migration.
2. `recompute-queue.ts` + test antrean (dedupe, reset, batas tanggal).
3. `recompute-worker.ts` + test worker (sukses, retry/backoff, budget, re-trigger, paralel).
4. Pemasangan worker di `createApp` + env + test tidak-ada-timer-di-test.
5. Pemicu: ADMS → jadwal → cuti/resolution, masing-masing dengan testnya.
6. `reporting.ts`: `recomputePending`, status turunan waktu, ringkasan + test.
7. Endpoint `recompute` + alias `finalize` + audit + OpenAPI + test route.
8. Web: daily label, halaman Hitung ulang rentang, label navigasi + test.
9. Dokumentasi: catatan implementasi §10.2 di spec, status paket, dan dokumen ini.
10. Gate kualitas dijalankan sungguhan; rilis lewat OPS-MI8-REL-001 dengan persetujuan owner.

Scope ini satu tujuan (AGENTS.md §9) dan tidak dicampur refactor lain. Yang **tidak** termasuk:
panel detail dan antrean "Perlu tindakan" (ATT-011-3), change set jadwal (ATT-011-4),
`day_type`/penanda libur pada hasil (ATT-011-6a).
