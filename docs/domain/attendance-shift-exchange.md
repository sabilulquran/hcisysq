# ATT-008 — Shift Exchange Workflow

**Status:** IMPLEMENTED — REPOSITORY VERIFIED; PRODUCTION DEPLOYMENT PENDING  
**Decision date:** 2026-09-21  
**Related:** ATT-003, ATT-010, APR-001

## Tujuan

Menyediakan alur Tukar Shift yang aman dan auditable tanpa mengubah histori jadwal atau raw attendance evidence.

Alur pertama:

```text
Pegawai A mengajukan tukar shift
-> Pegawai B menyetujui / menolak
-> Human Capital menyetujui / menolak
-> bila disetujui: publish roster version baru
-> attendance engine otomatis membaca roster terbaru
```

ATT-008 tidak memakai model vendor/tenant dan tidak mengubah payroll.

## Scope v1

V1 menukar shift **dua pegawai pada tanggal kerja yang sama**.

Alasan pembatasan tanggal sama:

- definisi pertukaran tetap jelas;
- tidak membuat perpindahan hari kerja lintas minggu secara implisit;
- roster version dapat diterbitkan atomik dalam satu minggu;
- audit lebih mudah menjelaskan siapa menerima shift siapa.

Pertukaran hari kerja berbeda dapat ditambahkan sebagai extension terpisah bila benar-benar diperlukan.

## Eligibility

Pengajuan hanya dapat dibuat bila:

- requester dan counterpart adalah pegawai aktif yang berbeda;
- keduanya berada pada organizational unit yang sama;
- work date belum melewati waktu mulai shift paling awal;
- keduanya mempunyai resolved schedule dengan state `scheduled`;
- kedua schedule mempunyai immutable `schedule_version_id`;
- schedule version kedua pegawai berbeda;
- tidak ada shift-swap aktif lain yang melibatkan salah satu pegawai pada tanggal yang sama.

Tidak ada arbitrary 24-hour cutoff pada v1. Cutoff fail-closed adalah **sebelum earliest scheduled start**.

Jika roster/jadwal berubah setelah submission sehingga snapshot tidak lagi cocok, HC approval harus gagal dengan conflict dan request baru diperlukan.

## Counterpart consent

Counterpart yang disnapshot saat submission adalah satu-satunya pegawai yang boleh menerima/menolak tahap counterpart.

State:

```text
awaiting_counterpart
  -> awaiting_hc
  -> rejected_by_counterpart
  -> cancelled
```

Requester dapat membatalkan selama request masih `awaiting_counterpart` atau `awaiting_hc`.

## HC decision

Setelah counterpart menerima:

```text
awaiting_hc
  -> approved
  -> rejected_by_hc
  -> cancelled
```

Keputusan HC membutuhkan permission:

```text
attendance.shift_swap.manage
```

Permission diberikan kepada role Human Capital yang sudah mempunyai domain attendance organization-wide. Backend tetap authoritative.

V1 tidak menambahkan direct-manager approval. Counterpart consent adalah persetujuan peer; keputusan operasional final berada pada Human Capital. Jika policy YSQ kemudian membutuhkan line-manager step, chain harus ditambah secara eksplisit dan tetap mengikuti prinsip APR-001 snapshot.

## Snapshot rule

Saat submission, request menyimpan:

- requester employee;
- counterpart employee;
- work date;
- requester schedule template/version;
- counterpart schedule template/version;
- roster id yang menghasilkan schedule masing-masing bila ada;
- scheduled start/end masing-masing;
- note requester.

Snapshot tidak mengikuti perubahan jadwal secara dinamis.

Pada final approval HC, current schedule kedua pegawai diverifikasi ulang. Bila schedule version sekarang berbeda dari snapshot, approval fail-closed dengan stale-schedule conflict.

## Roster application

Approval tidak mengedit roster lama.

HCIS:

1. lock request;
2. lock week secara advisory;
3. pastikan tidak ada DRAFT roster pada week yang sama;
4. load latest published roster version;
5. create published roster version baru;
6. copy seluruh entries latest published bila ada;
7. set requester pada work date ke schedule version counterpart;
8. set counterpart pada work date ke schedule version requester;
9. simpan `published_roster_id` pada request;
10. commit request + roster + audit atomically;
11. recompute canonical result untuk kedua pegawai/date.

Jika draft roster manual sedang ada, approval berhenti dengan conflict. Sistem tidak boleh diam-diam menimpa draft HC.

## Conflict and concurrency

Request creation mengambil advisory lock per employee/date dalam urutan stabil.

Active statuses:

- `awaiting_counterpart`;
- `awaiting_hc`.

Satu employee/date tidak boleh berada di dua active shift-swap sekaligus.

HC approval juga memvalidasi ulang:

- request masih `awaiting_hc`;
- counterpart sudah accepted;
- earliest shift belum mulai;
- requester/counterpart schedule version masih sama dengan snapshot;
- tidak ada DRAFT roster week tersebut.

Double decision menghasilkan state conflict, bukan dua roster publication.

## Audit

Append-only events:

- `submitted`;
- `counterpart_accepted`;
- `counterpart_rejected`;
- `hc_approved`;
- `hc_rejected`;
- `cancelled`.

Access audit juga mencatat submission, counterpart decision, HC decision, dan published roster id.

Tidak ada event yang dihapus atau ditulis ulang.

## Employee UX

Route:

```text
/app/attendance/shift-swap
```

Employee dapat:

- memilih tanggal;
- melihat shift dirinya;
- melihat kandidat satu unit yang eligible beserta shift;
- mengajukan;
- melihat request keluar;
- melihat request masuk;
- accept/reject bila menjadi counterpart;
- cancel request sendiri yang masih aktif.

## HC UX

Route:

```text
/admin/attendance/workforce/shift-swaps
```

HC dapat:

- filter waiting/history;
- melihat requester, counterpart, work date, shift snapshot, note;
- approve/reject request `awaiting_hc`;
- melihat published roster version/id hasil approval.

## API

Employee:

- `GET /attendance/shift-swaps/candidates?workDate=YYYY-MM-DD`
- `GET /attendance/shift-swaps/me?status=...`
- `POST /attendance/shift-swaps`
- `POST /attendance/shift-swaps/:id/counterpart-decision`
- `POST /attendance/shift-swaps/:id/cancel`

Admin:

- `GET /admin/attendance/shift-swaps?status=...`
- `POST /admin/attendance/shift-swaps/:id/decision`

## Non-goals

- cross-unit swap;
- different-date/day-off exchange;
- manager approval step;
- automatic expiry job;
- payroll mutation;
- attendance evidence mutation;
- face recognition;
- notification delivery adapter.

## Acceptance criteria

- ATT-008-A: requester hanya melihat kandidat active same-unit yang eligible.
- ATT-008-B: submission snapshot menyimpan immutable schedule version kedua pihak.
- ATT-008-C: counterpart yang tepat dapat accept/reject; pihak lain forbidden.
- ATT-008-D: requester dapat cancel hanya sebelum terminal state.
- ATT-008-E: HC approval membutuhkan `attendance.shift_swap.manage`.
- ATT-008-F: approval membuat published roster version baru tanpa mutasi roster historis.
- ATT-008-G: requester menerima counterpart schedule version dan counterpart menerima requester schedule version pada tanggal yang sama.
- ATT-008-H: active request conflict per employee/date fail-closed.
- ATT-008-I: stale schedule atau existing draft roster membuat approval conflict.
- ATT-008-J: approval recompute canonical attendance result kedua pegawai.
- ATT-008-K: employee/admin UI hanya menampilkan aksi yang valid untuk state/actor.
- ATT-008-L: audit/events append-only dan keputusan ganda tidak menghasilkan dua publication.
- ATT-008-M: migration, typecheck, lint, tests, build, dan staging compose PASS sebelum merge.
