# ATT-012 — ADMS Operational Management

**Status:** ACCEPTED  
**Parent:** ATT-005 — WDMS-compatible fingerprint device operations  
**Accepted:** 2026-09-22

## Goal

Menjadikan kemampuan ADMS HCIS yang sudah luas sebagai produk operasional yang sederhana untuk Human Capital, tanpa melemahkan safety boundary ATT-005 dan tanpa menganggap capability fisik terverifikasi hanya karena software tersedia.

HCIS Employee tetap source of truth. Mesin fingerprint adalah replica operasional. ADMS menjaga fleet, hubungan PIN, desired-vs-observed user state, transaksi, command/job, dan health evidence agar sinkron, dapat dipulihkan, dan dapat diaudit.

## Product decisions

1. Satu pintu navigasi utama bernama **Manajemen ADMS**.
2. Operator menggunakan bahasa tugas manusia; istilah wire/protocol/canary/capability key hanya ada pada **Diagnostik teknis**.
3. Desired state dan observed state dipisahkan:
   - mapping aktif ke employee = siapa yang seharusnya dikelola HCIS untuk device tersebut;
   - roster/event observation = apa yang pernah benar-benar teramati pada mesin;
   - selisih keduanya menghasilkan status sinkronisasi.
4. PIN yang belum termap adalah antrean kerja first-class dan harus dapat dikelola lintas mesin.
5. Mesin yang diganti tidak boleh ditimpa serialnya. Device lama menjadi retired dan boleh menunjuk replacement device baru.
6. Physical capability ATT-005 tetap per-device, fail-closed, dan tidak diwariskan ke replacement device.
7. Biometric payload tetap encrypted/opaque dan tidak masuk ordinary API/UI/log.
8. ADMS tetap device/evidence plane. Jadwal, terlambat, lembur, payroll, dan attendance policy tetap milik attendance engine.
9. HCIS tidak mengadopsi tenant/vendor layer RuangHadir karena HCIS adalah sistem internal satu organisasi.

## Actors and permissions

### Human Capital Administrator

Existing organization-wide permission bundle tetap:
- `attendance.devices.read`
- `attendance.devices.configure`
- `attendance.devices.operate`
- `attendance.devices.export`

Dapat:
- membuka Manajemen ADMS;
- melihat fleet dan health;
- claim/register device;
- mengelola mapping PIN;
- melihat desired-vs-observed user sync;
- menjalankan operasi non-destruktif yang sudah tersedia untuk operator;
- melihat transaksi, job/command, dan audit aman;
- retire device melalui workflow eksplisit.

Tidak otomatis mendapat:
- biometric maintenance;
- firmware;
- destructive maintenance;
- engineering physical-canary controls.

### Technical device operator

Permission `attendance.devices.technical` adalah capability khusus untuk surface diagnostik/physical validation. Legacy SUPER_ADMIN compatibility memilikinya; Human Capital Administrator tidak mendapatkannya secara default.

Permission khusus ATT-005 tetap berlaku:
- `attendance.devices.biometrics`
- `attendance.devices.firmware`
- `attendance.devices.destructive`

## Information architecture

Sidebar Admin hanya mempunyai satu entry ADMS:

```text
Manajemen ADMS
```

Di dalam workspace:

```text
Dashboard
Perangkat
Pegawai & Mapping
Sinkronisasi
Transaksi
Kesehatan & Alert
Audit
```

### Dashboard

Menjawab:
- berapa mesin online/offline/unknown;
- berapa mesin baru terdeteksi;
- berapa PIN belum termap;
- berapa hubungan perlu review;
- berapa job/perintah gagal atau menunggu;
- apa masalah yang membutuhkan perhatian sekarang.

### Perangkat

Daftar fleet tetap table-first. Onboarding memprioritaskan detected-device claim. Manual serial registration tetap fallback.

### Pegawai & Mapping

Fleet-level desired-vs-observed matrix/queue.

Status minimum:
- `synced`: mapping aktif dan observed user sesuai;
- `unmapped`: PIN terlihat di mesin/event tetapi belum dihubungkan;
- `missing_on_device`: mapping aktif ada tetapi user belum teramati pada device;
- `name_drift`: user teramati tetapi nama berbeda dari employee master;
- `review_required`: employee mapping tidak lagi aktif/valid.

Unmapped row harus dapat:
1. membuka dialog Hubungkan;
2. mencari pegawai aktif;
3. memilih pegawai secara eksplisit;
4. membuat mapping existing ATT-005;
5. memuat ulang status setelah sukses.

Similarity/name suggestion boleh membantu tetapi tidak boleh membuat mapping otomatis.

### Sinkronisasi

Workspace ini memprioritaskan desired-vs-observed employee synchronization lintas mesin. Operator memilih pegawai atau scope unit, memilih mesin target, melihat preview perbedaan dalam bahasa manusia, lalu hanya perubahan eligible yang dapat dikirim setelah capability perangkat berstatus verified.

Riwayat proses tetap tersedia di bagian yang sama dengan status manusia:
- menunggu;
- dikirim;
- diterima mesin;
- berhasil;
- gagal;
- kedaluwarsa;
- dibatalkan.

Ordinary UI tidak menampilkan command number, return code, operation ID, capability key, wire command, atau enum internal. Detail tersebut hanya boleh berada pada surface teknis berizin.

### Transaksi

Global raw transaction view yang sudah ada tetap authoritative, tetapi diakses dari Manajemen ADMS dan tidak menjadi item sidebar terpisah.

### Kesehatan & Alert

Alert dihitung dari evidence, bukan dugaan bisnis.

Minimum:
- active device offline;
- active device connectivity unknown;
- PIN belum termap;
- recent failed command;
- stale enabled reconciliation;
- source-IP churn/anomaly;
- device lifecycle non-active yang masih menghasilkan traffic bila evidence tersedia.

Alert tidak menyimpulkan terlambat/absen.

Clock drift hanya boleh ditampilkan bila device clock evidence tersedia secara eksplisit. Jangan mengarang drift dari received time.

### Audit

Menampilkan recent append-only ADMS admin audit dan command/physical operation summaries tanpa raw biometric/wire secret.

## Device detail

Ordinary tabs:

1. Ringkasan
2. Pengguna
3. Biometrik — hanya bila principal memiliki permission biometrik
4. Data Mesin
5. Transaksi
6. Konfigurasi
7. Maintenance

`Data Mesin` memuat Kode kegiatan dan Pesan untuk mesin. `Maintenance` memuat perawatan aman, riwayat tindakan, firmware bila actor memiliki izin terkait, akses ke diagnostik teknis, dan tindakan berisiko tinggi yang dipisahkan secara visual.

`Diagnostik teknis` tetap secondary route dan memerlukan `attendance.devices.technical`. Physical parity, canary, evidence classification, protocol-oriented controls, dan support tooling hanya hidup di sini.

Aksi bisnis yang diklasifikasikan **Operator after verification** tidak memerlukan permission teknis untuk mode execute. Mode canary/physical verification tetap memerlukan `attendance.devices.technical`. Tindakan break-glass tetap memerlukan `attendance.devices.destructive`; firmware tetap memerlukan `attendance.devices.firmware`; biometrik tetap memerlukan `attendance.devices.biometrics`. Semua execute tetap fail-closed bila capability per-device belum verified.

Legacy `/operations` deep link tidak boleh menjadi jalur biasa menuju physical-canary cockpit.

## Device retirement and replacement

### Retire

Preconditions:
- device ada;
- device belum retired;
- actor mempunyai `attendance.devices.configure`;
- note wajib;
- replacement optional dan tidak boleh menunjuk device yang sama.

Transition:
`active|disabled|quarantined -> retired`

Persist:
- `retired_at`;
- `retired_by_account_id`;
- `retirement_note`;
- optional `replaced_by_device_id`.

Effects:
- ingress tidak lagi accepted karena existing device trust hanya menerima lifecycle active;
- historical raw evidence, mappings, audit, commands, and credentials tidak dihapus;
- replacement device tidak mewarisi physical-capability verification.

Retired device tidak dapat diaktifkan kembali melalui ordinary PATCH. Reversal membutuhkan future explicit specification/migration, bukan toggle.

## Source-IP security evidence

Serial tetap identifier, bukan secret.

ATT-012 tidak mengarang cryptographic device authentication yang belum didukung firmware. Sebagai compensating control, health surface menampilkan source-IP anomaly dari durable request journal. Existing dedicated ingress host, explicit registry, quarantine, request-size limit, audit, and lifecycle gates tetap wajib.

Future per-device cryptographic authentication membutuhkan bukti firmware/protocol dan specification tersendiri.

## API additions

- `GET /admin/attendance/adms/management/summary`
- `GET /admin/attendance/adms/management/user-sync`
- `GET /admin/attendance/adms/management/jobs`
- `GET /admin/attendance/adms/management/health`
- `GET /admin/attendance/adms/management/audit`
- `POST /admin/attendance/adms/devices/{deviceId}/retire`

Semua response menggunakan `Cache-Control: no-store`.

## Audit

Device retirement menghasilkan append-only `device_retired` audit event.

Mapping tetap menggunakan audit existing:
- `mapping_created`
- `mapping_ended`

Read-only management views tidak membuat audit side effect.

## Failure behavior

- invalid device/replacement UUID -> 400;
- unknown device/replacement -> 404;
- self replacement -> 400;
- already retired -> 409;
- retired device ordinary reactivation -> 409;
- permission missing -> 403 sebelum data operasional dibaca/diubah;
- employee search/mapping tetap mengikuti permission API existing;
- management query failure tidak mengubah raw evidence atau command state.

## Migration

Additive migration:
- extend device lifecycle with `retired`;
- add retirement/replacement metadata;
- extend ADMS admin audit action allowlist with `device_retired`.

Rollback:
- application rollback aman selama tidak ada row `retired`;
- setelah retirement dipakai, schema tidak boleh down-migrate sebelum row retired direkonsiliasi secara eksplisit;
- tidak ada raw evidence yang dihapus.

## Acceptance criteria

1. Sidebar tidak lagi menampilkan tiga entry ADMS terpisah.
2. Manajemen ADMS mempunyai internal navigation untuk fleet, mapping, jobs, transactions, health, dan audit.
3. PIN belum termap dapat dikelola lintas mesin tanpa membuka URL detail satu per satu.
4. Mapping tetap explicit; tidak ada auto-map.
5. Fleet user sync membedakan desired dan observed state.
6. Human Capital Admin tidak melihat physical parity/canary sebagai primary workflow.
7. Technical diagnostics memerlukan `attendance.devices.technical`.
8. Device dapat retired dengan note dan optional replacement tanpa mengubah serial/history.
9. Retired device tidak dapat ordinary-reactivated.
10. Health alerts bersumber dari durable evidence dan mencakup source-IP anomaly.
11. Tidak ada biometric payload/secret/raw request body baru pada response ordinary.
12. Existing ATT-005 physical capability state tidak diubah/diwariskan oleh retirement.
13. OpenAPI, tests, typecheck, lint, and build harus lulus sebelum merge.
14. Production deployment dan physical canary tetap human-approved gate terpisah.

## Non-goals

- mengaktifkan biometric collection;
- menandai capability fisik sebagai verified tanpa canary;
- arbitrary/raw device command;
- membuat tenant/vendor layer;
- menghitung attendance policy dari raw device data;
- menjadikan source IP sebagai authentication credential;
- otomatis menyebarkan biometric ke semua mesin;
- production deployment dalam PR implementasi ini.


## 2026-09-23 capability and UX baseline

Product owner accepted the post-deployment ADMS capability/GUI direction after review of:

- the legacy `ADMS(v3.1-168)` package;
- ZKTeco WDMS/PUSH capability references;
- current HCIS production repository behavior;
- ATT-005 physical parity status.

The following documents now refine ATT-012 and are authoritative for future ADMS capability exposure and GUI work:

- `attendance-adms-capability-matrix.md`
- `attendance-adms-user-experience.md`

### Clarification to the original ATT-012 UI boundary

The original ATT-012 implementation correctly removed engineering-oriented controls from ordinary Human Capital navigation. However, **ordinary business actions must not be hidden merely because their backend implementation uses the physical device operation plane**.

Examples of actions that may belong in ordinary operator UX after their capability/readiness gates are satisfied:

- Perbarui informasi mesin;
- Ambil transaksi terbaru;
- Ambil ulang transaksi;
- Sinkronkan waktu;
- Sinkronkan pegawai;
- Kirim/perbarui pegawai di mesin;
- Aktifkan/nonaktifkan pegawai di mesin;
- Kode kegiatan dan pesan perangkat;
- Mulai ulang mesin.

Technical mechanics remain hidden:

- physical parity terminology;
- canary mechanics;
- capability keys;
- wire command;
- protocol-specific command grammar;
- raw return codes;
- raw shell/filesystem access.

Destructive, firmware, server-target, biometric, and other sensitive operations remain subject to their specific permissions and safety gates.

### Target detail-device IA

The future operator-facing detail IA is:

```text
Ringkasan
Pengguna
Biometrik
Data Mesin
Transaksi
Konfigurasi
Maintenance
```

This replaces the earlier narrower list in this document **for future UX work**. Current production may still use the earlier route structure until a separate implementation PR is accepted and deployed.

### Implementation rule

Before future ADMS coding, implementation must:

1. use the Master Capability Matrix to determine product exposure;
2. use the UX Baseline for naming and placement;
3. keep ATT-005 ledger as the physical-verification authority;
4. never convert protocol/vendor support into a verified-device claim;
5. keep raw/engineering controls out of the normal HC GUI.
