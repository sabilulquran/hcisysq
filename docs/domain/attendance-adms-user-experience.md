# ATT-012 — ADMS User Experience Baseline

**Status:** ACCEPTED PRODUCT BASELINE  
**Owner decision:** 2026-09-23  
**Related:** `attendance-adms-capability-matrix.md`, `attendance-adms-operational-management.md`

## Goal

GUI Manajemen ADMS harus terasa seperti aplikasi operasional Human Capital, bukan console engineering.

Operator harus memahami **apa yang dilakukan terhadap mesin**, tanpa harus memahami wire protocol, command grammar, capability key, atau terminology physical validation.

## Non-negotiable language rule

Istilah berikut **tidak boleh muncul di GUI normal**:

- physical parity;
- canary;
- capability key;
- wire command;
- raw command;
- return code;
- operation id;
- command type;
- protocol name;
- `DATA UPDATE`;
- `SET OPTION`;
- `RELOAD OPTIONS`;
- nama field/vendor internal yang tidak dibutuhkan user.

Istilah tersebut boleh ada pada log internal, source code, specification, atau halaman teknis terbatas bila benar-benar diperlukan.

### Translation examples

| Engineering/internal | GUI normal |
|---|---|
| physical operation | Tindakan pada mesin |
| capability verified | Siap digunakan |
| capability not verified | Perlu pengujian perangkat |
| unsupported | Tidak didukung mesin ini |
| blocked | Belum dapat digunakan |
| command pending | Menunggu dikirim ke mesin |
| delivered | Sudah dikirim ke mesin |
| acknowledged | Sudah diterima mesin |
| failed | Gagal |
| time sync | Sinkronkan waktu |
| user profile upsert | Kirim / perbarui pegawai |
| user enable/disable | Aktifkan / nonaktifkan pegawai |
| range recovery | Ambil ulang transaksi |
| device info read | Perbarui informasi mesin |
| duplicate punch period | Jeda absensi ganda |
| firmware upgrade | Pembaruan firmware |
| server config | Alamat server mesin |
| biometric enrollment | Daftarkan sidik jari / biometrik |
| biometric restore | Pulihkan biometrik |
| physical operation history | Riwayat tindakan |

## Primary information architecture

Sidebar Admin tetap hanya mempunyai satu entry:

```text
Manajemen ADMS
```

Workspace utama:

```text
Dashboard
Perangkat
Pegawai & Mapping
Sinkronisasi
Transaksi
Kesehatan & Alert
Audit
```

Do not add separate sidebar entries for individual ADMS screens.

## Device detail information architecture

Target detail mesin:

```text
Ringkasan
Pengguna
Biometrik
Data Mesin
Transaksi
Konfigurasi
Maintenance
```

### 1. Ringkasan

Purpose: pengguna segera memahami apakah mesin sehat dan apa yang perlu dilakukan.

Content:

- nama mesin;
- serial;
- lokasi/unit;
- status Aktif/Dinonaktifkan/Karantina/Dipensiunkan;
- Online/Offline/Belum diketahui;
- terakhir terhubung;
- model dan versi firmware bila terobservasi;
- jumlah pengguna terhubung;
- jumlah PIN belum termap;
- transaksi terakhir;
- masalah aktif.

#### Aksi cepat

Only frequent, understandable actions:

- **Perbarui informasi mesin**
- **Ambil transaksi terbaru**
- **Ambil ulang transaksi...**
- **Sinkronkan waktu**
- **Sinkronkan pegawai**
- **Mulai ulang mesin**

Visibility rule:

- action may be visible but disabled with an understandable reason such as **“Perlu pengujian perangkat”**;
- do not show internal state such as `documented`, `canary_pending`, or `not_verified`;
- dangerous actions never appear in Aksi cepat.

### 2. Pengguna

Purpose: manage the relationship between HCIS employees and users stored on the device.

Primary table:

| Pegawai HCIS | PIN | Status di mesin | Biometrik | Tindakan |
|---|---|---|---|---|

Human-facing states:

- Sinkron
- Belum ada di mesin
- Data berbeda
- Belum terhubung
- Perlu ditinjau
- Dinonaktifkan di mesin

Actions:

- Hubungkan ke pegawai
- Kirim ke mesin
- Perbarui data di mesin
- Aktifkan
- Nonaktifkan
- Daftarkan biometrik
- Lihat detail

Never require operator to type an employee UUID.

### 3. Biometrik

Visible only to users with the proper biometric permission and only when product/security gates permit.

Content should be employee-centric:

```text
M. Imadduddin Muqoyim
Fingerprint
  - Jari 1    Tersimpan
  - Jari 2    Belum ada
Face          Tidak didukung mesin ini
```

Actions:

- Daftarkan sidik jari
- Cadangkan
- Pulihkan
- Sinkronkan ke mesin lain
- Hapus biometrik terpilih

Do not expose:

- template content;
- ciphertext;
- IV;
- auth tag;
- encryption key identifier;
- vendor binary format;
- protocol selection unless Technical mode absolutely requires it.

Compatibility must be checked before cross-device distribution.

### 4. Data Mesin

Purpose: operator-manageable non-employee content.

Sections:

#### Kode kegiatan

- daftar kode;
- nama;
- status di mesin;
- Tambah;
- Sinkronkan;
- Hapus dari mesin.

#### Pesan

- pesan untuk semua pengguna;
- pesan untuk pegawai tertentu;
- periode tampil;
- status sinkron;
- hapus dari mesin.

Do not use `Work Code` as the primary user-facing term when **Kode kegiatan** is clearer. Technical documentation may keep the vendor term in parentheses where useful.

### 5. Transaksi

Content:

- waktu;
- PIN/pegawai;
- sumber mesin;
- jenis evidence yang aman;
- status mapping;
- filter tanggal;
- filter pegawai;
- filter PIN.

Actions:

- Ambil transaksi terbaru
- Ambil ulang transaksi untuk rentang tanggal
- Export sesuai permission

Do not infer lateness, overtime, or leave policy here. Raw ADMS transaction remains policy-neutral.

### 6. Konfigurasi

Only configuration that an authorized operator can understand and safely manage.

Sections:

#### Identitas dan lokasi

- Nama mesin
- Unit/lokasi
- Zona waktu
- Status lifecycle

#### Waktu dan absensi

- Sinkronkan waktu
- Sumber waktu otomatis
- Jeda absensi ganda

#### Pengiriman data

- profile/status transfer yang disederhanakan;
- photo/biometric flags only if relevant and gated.

Advanced server/protocol settings are not ordinary configuration.

### 7. Maintenance

Purpose: infrequent technical or high-risk work.

Subsections:

#### Perawatan aman

- Mulai ulang mesin
- Perbarui informasi mesin
- Riwayat tindakan

#### Pembaruan firmware

Technical/restricted. Must show model compatibility and target version in user language.

#### Diagnostik teknis

Requires `attendance.devices.technical`.

May contain:

- detailed capability evidence;
- physical verification tooling;
- protocol-specific evidence;
- safe command/result metadata;
- support bundle retrieval when implemented.

#### Tindakan berisiko tinggi

Separate visual area, never mixed with routine actions.

Examples:

- Bersihkan transaksi di mesin
- Bersihkan cache foto
- Hapus seluruh data mesin

Requirements:

- break-glass permission;
- explicit impact text;
- typed confirmation;
- audit event;
- safe precondition;
- no default placement near routine buttons.

## Fleet synchronization UX

The preferred model is not “copy machine”.

Target:

```text
Pegawai                  Mesin A        Mesin B        Mesin C
----------------------------------------------------------------
Ahmad                    Sinkron        Belum ada      Sinkron
Budi                     Masih aktif    Sinkron        Sinkron
Citra                    Nama berbeda   Sinkron        Belum ada

[ Sinkronkan yang belum sesuai ]
```

The system must calculate differences from:

- HCIS desired state;
- explicit PIN mapping;
- observed roster/device evidence;
- device compatibility/capability state.

Actions must remain explicit and previewable.

### Bulk workflow

1. choose employees or organizational scope;
2. choose target devices;
3. preview differences;
4. show planned changes in human language;
5. exclude blocked/unsupported devices with reason;
6. user confirms;
7. create typed jobs;
8. show progress and final result;
9. preserve audit.

No direct device-to-device blind replication.

## User-facing state vocabulary

Use a small consistent vocabulary.

### Synchronization

- Sinkron
- Belum ada di mesin
- Perlu diperbarui
- Belum terhubung
- Perlu ditinjau
- Sedang diproses
- Gagal

### Device health

- Online
- Offline
- Belum diketahui
- Perlu perhatian

### Capability readiness

- Siap digunakan
- Perlu pengujian perangkat
- Tidak didukung mesin ini
- Belum dapat digunakan

Never show engineering state enum directly.

## Progressive disclosure

The GUI must follow:

```text
common task
   -> visible immediately

less common configuration
   -> inside appropriate section

technical evidence
   -> Diagnostics

destructive operation
   -> Break-glass Maintenance
```

Do not place 15-20 command buttons in one panel.

## Action placement rules

| Action | Normal placement |
|---|---|
| Perbarui informasi mesin | Ringkasan / Aksi cepat |
| Ambil transaksi terbaru | Ringkasan + Transaksi |
| Ambil ulang transaksi | Transaksi |
| Sinkronkan waktu | Ringkasan + Konfigurasi |
| Sinkronkan pegawai | Ringkasan + Pengguna/Sinkronisasi |
| Kirim/update pegawai | Pengguna |
| Aktifkan/nonaktifkan pegawai | Pengguna |
| Enroll biometric | Biometrik |
| Work Code / message | Data Mesin |
| Jeda absensi ganda | Konfigurasi |
| NTP | Konfigurasi, restricted |
| Reboot | Ringkasan + Maintenance |
| ADMS server target | Maintenance / technical |
| Firmware | Maintenance / technical |
| Clear attendance/photo/all | Maintenance / break-glass |
| Capability canary | Diagnostik teknis only |
| Raw command / Shell | Never |

## Empty, loading, error, and disabled states

Every screen must define:

- loading skeleton/state;
- empty state with next useful action;
- forbidden state;
- device offline state;
- action disabled reason;
- partially supported device;
- job failure with retry guidance;
- stale observed data warning.

Disabled controls should explain **why**, for example:

- “Mesin sedang offline.”
- “Fitur ini perlu diuji pada model mesin ini.”
- “Anda tidak memiliki akses untuk tindakan ini.”
- “Mesin ini tidak mendukung fitur tersebut.”

Avoid:

- “capability blocked”
- “operation conflict”
- “canary not verified”
- “return code -1”

## Mobile behavior

- no horizontal primary-navigation dependency;
- key status + quick actions remain visible;
- dense tables may transform into cards;
- destructive actions never become accidental one-tap controls;
- modal/dialog actions must remain usable on small screens.

## Accessibility and interaction

- text labels must accompany non-obvious icons;
- status must not rely on color alone;
- confirmation dialog must state object + action + impact;
- routine action needs at most one confirmation when consequence is reversible;
- high-risk actions require stronger confirmation.

## Permissions are not the information architecture

Do not hide all useful operational actions simply because the backend implementation is classified as physical/technical.

Instead:

1. identify the **business action**;
2. place it in the correct operator page;
3. apply server-side permission;
4. apply capability/readiness gate;
5. translate failure/readiness into user language.

`attendance.devices.technical` protects technical tooling. It must not become a blanket reason to hide ordinary actions such as refresh info, transaction recovery, time sync, user sync, or reboot when those actions are otherwise approved and verified.

## Deliberately hidden from ordinary GUI

- raw wire command;
- arbitrary shell;
- filesystem browser;
- physical canary mechanics;
- capability keys;
- protocol selectors;
- biometric raw data;
- firmware binary internals;
- low-level return codes;
- database/runtime implementation details.

## Implementation boundary

This document is an **approved UX/product baseline**, not proof that all screens/actions are currently implemented or physically verified.

Before code changes:

1. check current main;
2. compare current GUI with this document and the master matrix;
3. produce a concrete gap list;
4. update API/permission contracts if behavior changes;
5. implement in one scoped PR;
6. run quality gates;
7. physical device testing remains separately gated.

