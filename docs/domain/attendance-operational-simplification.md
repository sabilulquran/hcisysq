# Attendance Operational Simplification

**Status:** PROPOSED PRODUCT UX DIRECTION  
**Specification:** ATT-011  
**Proposed:** 2026-09-22  
**Related:** ATT-001, ATT-002, ATT-003, ATT-005, ATT-006, ATT-007, ATT-008, ATT-009, ATT-010

## Problem

Attendance engine HCIS mempunyai backend yang lebih kuat daripada HRIS klasik, tetapi kompleksitas seperti default assignment, weekly roster, versioning, evidence source, clarification, dan evaluation tidak boleh membuat pekerjaan operator lebih rumit.

Target mental model Human Capital harus sesederhana:

```text
Shift -> Jadwal -> Kehadiran -> Lembur
```

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
- pola mingguan/default;
- perubahan hari tertentu;
- OFF/libur;
- copy minggu sebelumnya;
- bulk edit;
- publish;
- riwayat versi sebagai detail/advanced state, bukan menu utama.

Operator tidak perlu memahami istilah "default assignment" versus "roster override" untuk melakukan tugas harian normal.

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

### Lembur

"Apa pekerjaan di luar jadwal yang diajukan/disetujui/dihitung?"

Workspace lembur harus memisahkan fakta jam kerja dari keputusan approval/policy dan dari konsekuensi payroll.

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
2. bulk assign jadwal satu unit;
3. copy jadwal minggu sebelumnya;
4. mengganti jadwal satu pegawai satu hari;
5. melihat siapa terlambat/tidak hadir hari ini;
6. menyelesaikan satu klarifikasi;
7. melihat/memproses lembur;
8. employee melihat jadwal dan kehadirannya.

Keberhasilan ATT-011 diukur dari berkurangnya langkah dan istilah operasional, bukan dari menghapus correctness model di backend.
