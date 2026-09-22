# Attendance Operational Simplification

**Status:** PROPOSED PRODUCT UX DIRECTION  
**Specification:** ATT-011  
**Proposed:** 2026-09-22  
**Related:** ATT-001, ATT-002, ATT-003, ATT-005, ATT-006, ATT-007, ATT-008, ATT-009, ATT-010  
**Benchmark evidence:** `docs/product/semarthris-benchmark-2026-09-22.md`

## Problem

Attendance engine HCIS mempunyai backend yang lebih kuat daripada HRIS klasik, tetapi kompleksitas seperti default assignment, weekly roster, versioning, evidence source, clarification, dan evaluation tidak boleh membuat pekerjaan operator lebih rumit.

Target mental model Human Capital harus sesederhana:

```text
Shift -> Jadwal -> Kehadiran -> Lembur
```

## Product principle

HCIS boleh menyimpan model internal yang lebih kaya daripada UI.

Normal operator tidak perlu memahami:

- default assignment versus roster override;
- result version;
- normalized event;
- source precedence;
- recomputation;
- immutable evidence lineage.

Konsep tersebut tetap dipertahankan untuk correctness, audit, troubleshooting, dan advanced administration.

## Operational meaning

### Shift

"Jam kerja seperti apa?"

Contoh:

- Shift Pagi 07:00-15:00;
- Shift Siang 13:00-21:00;
- Shift Malam 21:00-05:00;
- Jam Kantor 08:00-16:00.

Schedule template ATT-003 tetap menjadi backend model, tetapi UX utama menyebutnya **Shift**.

### Jadwal

"Siapa bekerja pada shift apa dan kapan?"

Satu workspace jadwal harus menangani:

- assign shift ke satu/banyak pegawai;
- rentang tanggal;
- pola hari dalam seminggu;
- pola mingguan/default;
- perubahan hari tertentu;
- OFF/libur;
- copy minggu sebelumnya;
- bulk edit;
- publish;
- riwayat versi sebagai detail/advanced state, bukan menu utama.

Operator tidak perlu memahami istilah "default assignment" versus "roster override" untuk melakukan tugas harian normal.

## Schedule range as primary operator abstraction

Benchmark SemartHRIS memperlihatkan nilai dari model operator sederhana:

```text
Pegawai / unit
+ Shift
+ Dari tanggal
+ Sampai tanggal
+ Keterangan
```

HCIS tidak harus menyalin data model tersebut. Namun UI ATT-011 sebaiknya memungkinkan operator menyatakan jadwal dalam bentuk rentang/pola yang natural.

Contoh:

```text
Semua Guru SDIT
Shift Pagi
1 Oktober - 31 Desember

Senin    aktif
Selasa   aktif
Rabu     aktif
Kamis    aktif
Jumat    aktif
Sabtu    off
Minggu   off
```

Backend dapat menerjemahkannya menjadi effective assignment dan/atau published roster sesuai aturan ATT-003.

## Replacement and collision behavior

Perubahan schedule harus mudah dinyatakan tanpa istilah teknis "override".

Contoh existing schedule:

```text
1 Sep --------------------------- 30 Sep
              Shift Pagi
```

Operator membuat perubahan:

```text
15 Sep
Shift Siang
```

Target UX:

> Jadwal baru menggantikan Shift Pagi pada 15 September.

Backend boleh menghasilkan versi/segment yang ekuivalen secara historis:

```text
1-14 Sep    Shift Pagi
15 Sep      Shift Siang
16-30 Sep   Shift Pagi
```

Prinsip:

- historical published truth tidak ditulis ulang diam-diam;
- perubahan harus effective-dated/versioned sesuai ATT-003;
- collision ambigu harus tampil sebagai masalah yang perlu diselesaikan;
- sistem tidak boleh memilih salah satu schedule secara diam-diam;
- operator harus melihat dampak penggantian sebelum publish bila perubahan memengaruhi jadwal yang sudah authoritative.

## Bulk scheduling direction

Operasi normal harus mengutamakan bulk workflow:

- pilih unit/kelompok/pegawai;
- pilih shift;
- pilih rentang/pola hari;
- preview affected employees/dates;
- tampilkan conflict/replacement;
- publish.

Per-employee manual editing tetap tersedia untuk exception, bukan satu-satunya cara mengelola jadwal.

### Kehadiran

"Apa yang benar-benar terjadi?"

Satu workspace harus menyatukan:

- clock/punch;
- hasil hadir/telat/tidak lengkap/izin/cuti/absen;
- source ADMS/mobile/manual;
- exception;
- klarifikasi/koreksi;
- filter laporan;
- drill-down evidence bila diperlukan.

Normalized event dan versioned result tetap backend truth, tetapi operator melihat satu hasil harian yang dapat dijelaskan.

## Daily result presentation

Primary Human Capital view sebaiknya memakai hasil harian yang ringkas:

```text
Tanggal | Pegawai | Shift | Masuk | Pulang | Status | Exception
```

Contoh:

```text
22 Sep | Ahmad | Pagi | 07:03 | 15:01 | Hadir | Terlambat 3 menit
```

Drill-down baru menampilkan:

- source device/mobile/manual;
- raw/normalized event references;
- actual punch timestamps;
- schedule resolved;
- sessions;
- GPS/photo evidence bila authorized;
- clarification/correction;
- leave/permission reference;
- result version/provenance.

Dengan demikian backend tetap dapat menjelaskan keputusan tanpa membuat halaman utama menjadi debugger engine.

## Missing evidence must remain missing

ATT-011 **tidak** boleh menyederhanakan UI dengan memalsukan evidence.

Contoh:

```text
Evidence:
Check-in  07:05
Check-out tidak ada
```

Hasil tidak boleh otomatis menjadi:

```text
07:05 - 15:00
```

hanya karena shift berakhir pukul 15:00.

Target:

```text
07:05 - ?
Status: incomplete
Action: klarifikasi/koreksi bila diperlukan
```

Schedule time adalah expectation, bukan attendance evidence.

## Leave and permission integration

Leave/permission tidak boleh mengubah attendance sebelum workflow yang authoritative selesai.

Target boundary:

```text
Leave/permission request
  -> approval/resolution
  -> approved domain fact
  -> attendance engine input
  -> daily attendance result
```

ATT-011 boleh menyajikan hasil `leave`/izin secara sederhana, tetapi tidak menghapus approval/evidence boundary.

### Lembur

"Apa pekerjaan di luar jadwal yang diajukan/disetujui/dihitung?"

Workspace lembur harus memisahkan:

1. fakta waktu kerja;
2. pengajuan/sumber;
3. keputusan approval/policy;
4. jam lembur yang diakui;
5. konsekuensi payroll.

Primary UX boleh tetap ringkas:

```text
Pegawai | Tanggal | Mulai | Selesai | Status | Jam diakui
```

Detail approval/policy tersedia saat dibutuhkan.

## Proposed admin navigation

```text
Waktu & Kehadiran
  - Ringkasan
  - Shift
  - Jadwal
  - Kehadiran
  - Lembur
  - Mesin Fingerprint
  - Pengaturan
```

Tukar shift dapat hadir sebagai action/subflow pada **Jadwal**, bukan harus menjadi konsep utama yang berdiri sendiri pada navigasi.

Klarifikasi dapat hadir sebagai queue/filter pada **Kehadiran**.

## Proposed employee UX

Pegawai terutama melihat:

- status hari ini;
- shift/jadwal hari ini;
- Clock In / Clock Out bila mobile attendance tersedia;
- jadwal saya;
- riwayat kehadiran;
- lembur saya;
- action tukar shift dari jadwal;
- action klarifikasi dari record kehadiran bermasalah.

## Complexity hiding rule

Backend complexity tetap dipertahankan untuk correctness:

- effective dating;
- roster version;
- immutable evidence;
- source provenance;
- audit;
- recomputation;
- approval snapshots.

Namun konsep tersebut hanya tampil ketika membantu menjelaskan perubahan, audit, atau advanced administration.

## Acceptance direction before implementation

Sebelum ATT-011 menjadi implementation task, minimal harus ada prototype/UX review untuk:

1. membuat shift;
2. bulk assign jadwal satu unit melalui rentang/pola hari;
3. copy jadwal minggu sebelumnya;
4. mengganti jadwal satu pegawai satu hari;
5. menunjukkan conflict/replacement secara jelas tanpa istilah backend;
6. melihat siapa terlambat/tidak hadir/incomplete hari ini;
7. drill-down evidence satu hasil kehadiran;
8. menyelesaikan satu klarifikasi;
9. melihat/memproses lembur;
10. employee melihat jadwal dan kehadirannya.

Keberhasilan ATT-011 diukur dari berkurangnya langkah dan istilah operasional, bukan dari menghapus correctness model di backend.
