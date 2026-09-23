# ATT-012 — ADMS Master Capability Matrix

**Status:** ACCEPTED PRODUCT BASELINE  
**Parent:** ATT-005 — WDMS-compatible fingerprint device operations  
**Owner decision:** 2026-09-23  
**Implementation status:** documentation baseline; implementation may lag this document

## Purpose

Dokumen ini menjadi peta tunggal kemampuan komunikasi HCIS dengan mesin fingerprint/ADMS.

Tujuannya:

1. mencegah fitur protokol, backend, dan GUI tercampur;
2. mencegah kemampuan mesin hilang hanya karena GUI disederhanakan;
3. mencegah fitur berisiko muncul sebagai tombol biasa;
4. membedakan dukungan referensi, implementasi HCIS, bukti perangkat fisik, dan kelayakan GUI;
5. menjadi input wajib sebelum perubahan GUI atau command/device behavior berikutnya.

## Evidence hierarchy

Matrix ini disusun dari empat sumber yang **tidak boleh disamakan**:

1. **Legacy ADMS discovery** — paket `ADMS(v3.1-168)` yang diberikan product owner dan dibedah pada 2026-09-23. Ini menunjukkan breadth kemampuan software/protokol lama, bukan jaminan semua mesin YSQ mendukungnya.
2. **ZKTeco WDMS/PUSH reference** — referensi kemampuan produk/protokol vendor. Dukungan aktual tetap bergantung model dan firmware.
3. **HCIS repository** — bukti apakah typed capability/API/data plane sudah ada di repository.
4. **ATT-005 physical parity ledger** — satu-satunya source of truth untuk status physical verification per capability pada mesin YSQ.

Aturan penting:

> Supported by protocol/reference != implemented in HCIS != physically verified != allowed to ordinary operator.

Tidak satu pun capability boleh dinaikkan menjadi “terverifikasi” hanya karena command builder, API, atau GUI sudah tersedia.

## Product model

HCIS Employee adalah **source of truth**.

Mesin fingerprint adalah **replica operasional** yang menyimpan sebagian identitas, credential, konfigurasi, dan transaksi untuk kebutuhan perangkat.

Alur target:

```text
HCIS employee / desired state
          |
          v
compare desired vs observed
          |
          v
device synchronization jobs
          |
          v
fingerprint device fleet
          |
          v
raw evidence / transaction / result
          |
          v
HCIS reconciliation + audit
```

“Copy Device A -> Device B” bukan model utama. Bila data perlu dikirim ke banyak mesin, HCIS menjadi perantara source of truth.

## Exposure classes

| Class | Arti |
|---|---|
| **Operator** | Layak dipakai Human Capital pada alur normal setelah capability perangkat memenuhi safety/verification gate |
| **Restricted** | Berguna secara operasional tetapi membutuhkan permission khusus, konfirmasi, atau policy tambahan |
| **Technical** | Untuk pemeliharaan/diagnostik teknis; tidak menjadi workflow HC sehari-hari |
| **Break-glass** | Destruktif/berisiko tinggi; hanya untuk kondisi khusus dengan confirmation + audit |
| **Excluded** | Sengaja tidak menjadi produk HCIS walaupun legacy protocol mungkin mampu |

## Master matrix

### A. Koneksi, identitas mesin, dan health

| Capability internal | Label GUI yang diinginkan | Legacy/WDMS evidence | HCIS repository | Physical evidence | Exposure |
|---|---|---|---|---|---|
| device registration / serial identity | Daftarkan mesin | Ada | Implemented: registry + detected-device claim | Ikuti ATT-005 ledger | Operator |
| last seen / heartbeat | Status koneksi | Ada | Implemented | Ikuti ATT-005 ledger | Operator |
| read/refresh device information | Perbarui informasi mesin | Ada | Implemented typed read/info flow | Ikuti ATT-005 ledger | Operator |
| model / firmware / Push metadata | Informasi mesin | Ada | Implemented safe observed metadata | Device-dependent | Operator |
| adaptive online/offline health | Kesehatan mesin | Reference-derived | Implemented | Runtime evidence based | Operator |
| source-IP anomaly evidence | Perubahan jaringan perlu diperiksa | N/A as product UX | Implemented ATT-012 | Runtime evidence based | Operator |
| capability profile per model/device | Kemampuan mesin | Ada secara konsep | Implemented physical capability state | Belum lengkap per device | Technical; ringkasan user-friendly boleh tampil |

### B. Transaksi kehadiran

| Capability internal | Label GUI yang diinginkan | Legacy/WDMS evidence | HCIS repository | Physical evidence | Exposure |
|---|---|---|---|---|---|
| realtime ATTLOG push | Transaksi terbaru | Ada | Implemented durable ingress/dedupe | Operational data exists; closure tetap mengikuti ATT-005 | Operator |
| request new transactions | Ambil transaksi terbaru | Ada | Implemented | Device-specific verification required | Operator |
| bounded range recovery | Ambil ulang transaksi | Ada | Implemented | Repository/runtime supported | Operator |
| scheduled reconciliation | Pemulihan transaksi otomatis | N/A as legacy UI contract | Implemented | Runtime policy evidence | Operator |
| offline ATTLOG import | Impor transaksi dari file | Ada sebagai recovery pattern | Implemented | Does not require device command | Restricted |
| attendance photo ingest | Foto absensi dari mesin | Ada pada compatible WDMS/device | Foundation implemented + encrypted/gated path | `not_verified` per ATT-005 ledger | Restricted |
| clear attendance log | Hapus transaksi di mesin | Ada | Typed implementation exists | `not_verified` | Break-glass |

### C. Pegawai dan identitas pada mesin

| Capability internal | Label GUI yang diinginkan | Legacy/WDMS evidence | HCIS repository | Physical evidence | Exposure |
|---|---|---|---|---|---|
| observed PIN/user roster | Pengguna di mesin | Ada | Implemented passive roster/mapping | Runtime evidence | Operator |
| explicit PIN -> employee mapping | Hubungkan ke pegawai | HCIS product rule | Implemented | N/A device write | Operator |
| unmapped PIN queue | Belum terhubung | HCIS product rule | Implemented ATT-012 | N/A | Operator |
| user profile upsert | Kirim / perbarui pegawai di mesin | Ada | Typed implementation exists | `not_verified` | Operator after verification |
| user enable / disable | Aktifkan / nonaktifkan pegawai di mesin | Ada | Typed non-delete implementation exists | `not_verified` | Operator after verification |
| user authorization group/timezone/door | Hak akses perangkat | Ada on capable device families | Part of typed user enable/upsert path | `not_verified`; hardware scope dependent | Restricted / discovery |
| delete user identity from machine | Hapus pegawai dari mesin | Legacy ADMS supports it | Intentionally not used as normal HCIS workflow | Excluded by current safety direction | Excluded from ordinary product |
| fleet desired-vs-observed reconciliation | Status sinkron pegawai | HCIS product design | Partial: user-sync state exists; bulk action UX incomplete | N/A + device writes depend capability | Operator |
| bulk sync selected employees to selected devices | Sinkronkan pegawai | Legacy/WDMS breadth supports multi-device operation | Backend primitives exist; fleet workflow incomplete | Physical verification required | Operator target |

### D. Biometrik

| Capability internal | Label GUI yang diinginkan | Legacy/WDMS evidence | HCIS repository | Physical evidence | Exposure |
|---|---|---|---|---|---|
| fingerprint/biometric query | Periksa data biometrik | Ada | Typed implementation exists | `not_verified` | Restricted |
| remote enrollment | Daftarkan sidik jari / biometrik | Ada | Typed legacy + unified enrollment exists | `not_verified` | Restricted |
| encrypted biometric vault | Penyimpanan biometrik aman | WDMS parity requirement + HCIS security design | Implemented foundation | Physical workflow `not_verified` | Restricted |
| biometric backup | Cadangkan biometrik | Ada secara operational parity | Foundation implemented | `not_verified` | Restricted |
| restore same device | Pulihkan biometrik | Ada | Typed implementation exists | `not_verified` | Restricted |
| distribute to compatible device | Sinkronkan biometrik ke mesin lain | Ada | Foundation via explicit target/restore | `not_verified` | Restricted |
| selected biometric delete | Hapus biometrik terpilih | Ada | Typed implementation exists | `not_verified` | Restricted |
| automatic mass biometric distribution | — | Technically conceivable | Intentionally not a default workflow | Not permitted without compatibility/policy | Excluded as automatic behavior |
| raw template display/download in ordinary UI | — | Legacy tools may expose low-level data | Explicitly prohibited | N/A | Excluded |

**Biometric rule:** `BIOMETRIC_COLLECTION_ENABLED` remains OFF until separately approved operational/security prerequisites are met. This matrix does not activate collection.

### E. Data tambahan pada mesin

| Capability internal | Label GUI yang diinginkan | Legacy/WDMS evidence | HCIS repository | Physical evidence | Exposure |
|---|---|---|---|---|---|
| work code catalog | Kode kegiatan | Ada | HCIS catalog implemented | N/A until delivery | Operator |
| work code delivery/delete | Sinkronkan kode kegiatan | Ada | Typed delivery exists | `not_verified` | Operator after verification |
| public device message | Pesan untuk semua pengguna | Ada | Catalog + typed delivery exists | `not_verified` | Operator after verification |
| private device message | Pesan untuk pegawai tertentu | Ada | Explicit employee target exists | `not_verified` | Operator after verification |
| message removal | Hapus pesan dari mesin | Ada | Typed delete exists | `not_verified` | Operator after verification |

### F. Waktu dan konfigurasi umum

| Capability internal | Label GUI yang diinginkan | Legacy/WDMS evidence | HCIS repository | Physical evidence | Exposure |
|---|---|---|---|---|---|
| active time sync | Sinkronkan waktu | Ada | Typed implementation exists | Ledger currently not physically verified; previous blocked attempt must not be treated as PASS | Operator after verification |
| duplicate punch period | Jeda absensi ganda | Ada | Typed implementation exists | `not_verified` | Operator after verification |
| NTP server | Sumber waktu otomatis | Ada | Typed implementation exists | `not_verified` | Restricted |
| HCIS timezone metadata | Zona waktu mesin | Ada secara configuration concept | Implemented registry setting | Metadata-only unless device write is separately proven | Operator |
| device-side timezone/DST configuration | Pengaturan waktu musiman | Ada pada some vendor references | No complete HCIS product workflow established | Not verified | Discovery |
| approved ADMS server rewrite | Alamat server mesin | Ada | Typed safe rewrite to approved ingress only | `not_verified` | Technical |
| transfer/capture profile | Data yang dikirim mesin | Ada | Partial: desired push profile/flags + attendance-photo gates | Device-specific | Technical / restricted |
| arbitrary option editor | — | Legacy software/protocol may allow | Intentionally absent | N/A | Excluded |

### G. Maintenance

| Capability internal | Label GUI yang diinginkan | Legacy/WDMS evidence | HCIS repository | Physical evidence | Exposure |
|---|---|---|---|---|---|
| reboot | Mulai ulang mesin | Ada | Typed implementation exists | `not_verified` | Operator after verification |
| command lifecycle/retry/result | Riwayat tindakan | Ada | Implemented durable queue/result | Runtime supported | Operator |
| cancel undelivered command | Batalkan tindakan yang belum dikirim | N/A | Implemented | N/A | Operator |
| firmware package + upgrade | Pembaruan firmware | Ada | Typed model-bound implementation exists | `not_verified` | Technical |
| clear photo cache | Bersihkan foto di mesin | Ada | Typed implementation exists | `not_verified` | Break-glass |
| clear all device data | Hapus seluruh data mesin | Ada | Typed implementation exists | `not_verified` | Break-glass |
| support file/log retrieval | Ambil paket diagnostik | Legacy has GetFile/file manager | Not implemented as safe product workflow | Not verified | Technical candidate |
| arbitrary filesystem browser | — | Legacy ADMS has file-management capability | Intentionally not a product goal | N/A | Excluded |
| remote shell | — | Legacy ADMS package exposes shell-style capability | Intentionally prohibited | N/A | Excluded |
| arbitrary/raw command textarea | — | Protocol may allow broader command surface | Explicitly prohibited | N/A | Excluded |

### H. Access-control-adjacent capability

HCIS remains attendance-first. Some device families/protocol references contain access-control capabilities, but they are **not automatically HCIS attendance scope**.

| Capability internal | Label GUI potential | HCIS state | Decision |
|---|---|---|---|
| user door/timezone authorization | Hak akses pintu | Low-level typed authorization is used in current user enable path | Keep restricted; reassess only when door-access product scope is explicitly approved |
| remote unlock | Buka pintu | Not an accepted HCIS capability | Discovery only; do not implement from protocol breadth alone |
| cancel alarm | Hentikan alarm | Not an accepted HCIS capability | Discovery only |
| access groups / holidays / doors | Aturan akses | No accepted HCIS product contract | Separate future specification required |

## Gap categories after 2026-09-23 review

### Already implemented; mostly needs better operator UX

- refresh/read device information;
- request/recover transactions;
- mapping and unmapped management;
- command lifecycle/history;
- time sync;
- duplicate-punch period;
- user profile push;
- user enable/disable;
- reboot;
- Work Code;
- public/private message;
- NTP;
- safe server rewrite;
- firmware;
- selected destructive actions.

These capabilities must **not** all remain hidden just because their internal implementation is technical.

### Backend foundation exists; product workflow still incomplete

- fleet employee x device synchronization matrix;
- one-click “sync differences” workflow;
- user-friendly biometric enrollment/distribution workflow;
- compatible-device biometric distribution;
- capture/transfer profile management;
- support diagnostic bundle;
- proactive ADMS notification integration beyond dashboard alerts.

### Discovery / not accepted yet

- full device-side DST/timezone behavior;
- card enrollment as a dedicated workflow;
- access-control operation plane;
- remote unlock/alarm control.

### Intentionally excluded

- raw command console;
- arbitrary option editor;
- remote shell;
- general filesystem browser;
- automatic user inference/mapping;
- blind device-to-device replication bypassing HCIS;
- automatic mass biometric propagation;
- unrestricted ADMS server target changes.

## Physical verification rule

For capabilities governed by ATT-005:

1. repository implementation is not PASS;
2. UI existence is not PASS;
3. vendor documentation is not PASS;
4. legacy ADMS support is not PASS;
5. only accepted device-specific evidence may change ledger status.

The existing `attendance-wdms-full-physical-parity-ledger.md` remains authoritative for physical closure.

## Implementation order derived from this matrix

When product owner asks to continue implementation:

1. preserve this matrix as the scope boundary;
2. implement the approved GUI IA in `attendance-adms-user-experience.md`;
3. restore safe operator-facing actions using human language;
4. complete fleet desired-vs-observed synchronization UX;
5. expose configuration/data-machine capabilities according to Exposure class;
6. keep Technical and Break-glass controls separated;
7. perform one-capability-at-a-time physical verification;
8. biometrics remain last and separately gated.

Do not add protocol capability merely because legacy ADMS or vendor references show it.
