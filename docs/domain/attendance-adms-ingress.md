# ATT-005 Historical Go 1 — ADMS/iClock Ingress Foundation

**Status:** IMPLEMENTED LEGACY SUB-SCOPE OF ATT-005

> Historical note: this document originally used feature ID ATT-002. The canonical capability map now reserves ATT-002 for attendance clarification. ADMS ingress is an ATT-005 device-plane sub-scope; database filenames and historical PR references are intentionally unchanged.

## Tujuan

Menerima fakta punch mentah dari mesin fingerprint ADMS/iClock langsung ke HCIS tanpa bergantung pada runtime, API, database, atau deployment RuangHadir.

Implementasi protocol di-port dari clean-room/proven implementation `imadjinasi/ruanghadir-69075d19`, lalu diadaptasi ke Fastify + PostgreSQL HCIS. Setelah port, source code menjadi bagian dari repository HCIS dan tidak memiliki runtime dependency ke RuangHadir.

## Scope Go 1

- endpoint machine-only `/iclock/*` pada host ingress khusus;
- serial-device registry;
- lossless request journal;
- ATTLOG parser 11 field tab-separated;
- raw attendance event storage;
- stable event deduplication;
- quarantine untuk payload/protocol/data yang tidak dapat diterima;
- ATTLOG transfer cursor;
- ACK hanya setelah persistence transaction commit.

## Non-goals

Go 1 **tidak**:

- memetakan PIN mesin ke employee;
- menulis `attendance_daily_records`;
- menentukan check-in/check-out;
- menyimpulkan terlambat, tidak hadir, jam kerja, overtime, payroll, atau attendance-resolution outcome;
- mengirim user/template/biometric ke mesin;
- mengirim remote command ke mesin — ini adalah batas historis Go 1; ATT-005 transport recovery di bawah memperluasnya hanya untuk command `LOG` yang terdokumentasi dan non-destruktif;
- menyediakan Admin UI.

Mapping, projection attendance native HCIS, dan UI berada pada Go 2/Go 3. Device-management parity yang lebih luas berada pada ATT-005.

## Invariant

1. ADMS ingress adalah infrastructure adapter, bukan attendance policy engine.
2. Raw request/event adalah evidence dan bersifat append-only.
3. Unknown serial tidak otomatis membuat device atau memberi akses.
4. Source IP hanya evidence transport; bukan authentication key.
5. Device `disabled`/`quarantined` tidak boleh menghasilkan raw attendance event yang accepted.
6. Exact duplicate event tidak menghasilkan event kedua.
7. Parser mempertahankan leading-zero PIN, raw timestamp, raw line, dan sebelas raw fields.
8. Timestamp device diinterpretasikan menggunakan timezone device; default registry adalah `Asia/Jakarta`.
9. Payload lebih dari 512 KiB tidak diproses sebagai ATTLOG dan dicatat sebagai quarantine bila request berhasil mencapai parser aplikasi.
10. ACK ATTLOG diberikan hanya setelah request journal, event/quarantine, dan cursor durable di database.
11. Failure pada projection masa depan tidak boleh mengubah fakta raw yang sudah durable menjadi retry protocol.
12. Polling `GET /iclock/getrequest` tanpa command dibalas literal `OK`; HTTP 200 dengan body kosong bukan response idle yang sesuai kontrak PUSH SDK.
13. Recovery ATTLOG yang awalnya diterima dari unknown device hanya boleh terjadi setelah serial tersebut diregistrasi eksplisit dan lifecycle-nya `active`.
14. Recovery tidak mengubah atau menghapus request/quarantine lama; event hasil recovery menunjuk ke request journal asli dan tetap memakai exact-event deduplication.
15. Remote command pada extension awal hanya allowlist `LOG`; tidak ada generic arbitrary-command API.

## Host dan routing

Production menggunakan dedicated machine hostname `adms.sabilulquran.or.id`, dikonfigurasi melalui `ADMS_INGRESS_HOST=adms.sabilulquran.or.id`.

Request dengan host lain tidak diperlakukan sebagai ADMS ingress. Hanya namespace `/iclock/*` yang diterima oleh adapter.

Tidak ada deployment ADMS staging terpisah. Validasi awal dilakukan sebagai controlled production canary menggunakan satu mesin yang diregistrasi eksplisit sebelum traffic diperluas.

## Protocol subset

Go 1 awal mendukung transport attendance-log berikut:

- `GET /iclock/cdata?...&options=all` untuk options handshake;
- `POST /iclock/cdata?...&table=ATTLOG&Stamp=...` untuk ATTLOG;
- `GET /iclock/getrequest` untuk polling command; tanpa pending command response idle wajib plain-text `OK`.

ATT-005 transport recovery memperluas subset tersebut secara sempit dengan:

- delivery `C:<command-number>:LOG\n` melalui `GET /iclock/getrequest` untuk meminta device segera memeriksa/mengirim data baru;
- `POST /iclock/devicecmd?SN=...` untuk acknowledgement/result command dengan bentuk `ID=<n>&Return=<code>&CMD=<command>`;
- response `OK` pada `/iclock/devicecmd` setelah request/result durable;
- durable command status dan append-only command-event history.

Tidak ada arbitrary shell/config/user/template command pada extension ini. Command lain baru boleh ditambahkan melalui ATT-005 setelah wire behavior, capability, authorization, failure semantics, dan audit-nya dispesifikasikan.

Handshake masih mengaktifkan ATTLOG saja dan tidak meminta OPERLOG, photo, user, atau biometric material pada extension ini.

## Registration-after-capture recovery

Traffic dari serial yang belum diregistrasi tetap dijournal secara lossless, mendapat `UNKNOWN_DEVICE`, dan tidak langsung menghasilkan `attendance_adms_events`.

Setelah admin kemudian meregistrasi serial tersebut sebagai device `active`, request aktif pertama melakukan recovery satu kali untuk durable ATTLOG pra-registrasi yang:

- mempunyai hash serial yang sama;
- diklasifikasikan sebagai ATTLOG;
- body tertangkap penuh;
- sebelumnya mendapat response sukses;
- diterima sebelum waktu registrasi device.

Recovery:

1. decode dan parse body menggunakan timezone device;
2. insert valid raw event dengan `source_request_id` menunjuk ke request journal asli;
3. memakai stable event identity sehingga replay/recovery tidak menggandakan event;
4. mempertahankan quarantine `UNKNOWN_DEVICE` lama sebagai fakta historis dan menambah recovery quarantine bila payload historis ternyata invalid;
5. seed opaque ATTLOG cursor dari request historis terbaru yang valid bila cursor yang lebih baru belum ada;
6. tandai recovery pra-registrasi completed agar polling berikutnya tidak terus memindai history yang sama;
7. queue satu command `LOG` non-destruktif untuk meminta device memeriksa backlog/new transaction setelah trust diberikan.

Projection ATT-003 untuk event hasil recovery tetap best-effort setelah raw commit dan hanya bekerja bila mapping `(device, PIN) -> employee` sudah efektif. Tidak ada auto-guess PIN.

## Durable command lifecycle minimum

`attendance_adms_commands` menyimpan command `LOG` yang dihasilkan oleh registration recovery.

Status yang disiapkan untuk ATT-005:

- `pending`;
- `delivered`;
- `acknowledged`;
- `succeeded`;
- `failed`;
- `expired`;
- `cancelled`.

Pada extension awal:

- pending `LOG` dikirim pada poll `/getrequest` berikutnya;
- `LOG` boleh di-redeliver setelah timeout karena command ini idempotent/non-destruktif, dengan batas attempt;
- `/devicecmd` `Return >= 0` menyelesaikan command sebagai `succeeded`;
- negative return menyelesaikan command sebagai `failed`, kecuali vendor wait-state `-5000` yang dicatat sebagai `acknowledged`;
- duplicate completed acknowledgement yang identik tidak membuat state/event baru;
- unknown/conflicting command result masuk quarantine;
- setiap queue/delivery/result mempunyai append-only `attendance_adms_command_events` evidence.

## Data model

### attendance_adms_devices

Registry device eksplisit: serial number, lifecycle, timezone, model/firmware metadata, first/last seen, last IP, last successful request, dan marker completion recovery pra-registrasi.

Lifecycle Go 1:

- `active`
- `disabled`
- `quarantined`

Device tidak dibuat otomatis dari traffic unknown.

### attendance_adms_request_journal

Evidence setiap request yang mencapai ingress: method/path/query, serial candidate hash, safe metadata, body/hash/length, classification, response, timestamps.

### attendance_adms_events

ATTLOG facts lossless: device, source request, stable identity hash, PIN, raw timestamp, parsed timestamp, raw line, 11 raw fields, line hash, received timestamp.

Tidak ada kolom employee, check-in/check-out, late, absence, overtime, atau payroll result pada tabel ini.

### attendance_adms_quarantines

Menyimpan outcome yang tidak aman diproyeksikan, termasuk unknown device, invalid field count/timestamp, future timestamp, unsupported encoding, oversized payload, disabled device, exact duplicate, dan invalid/unknown command-result evidence.

### attendance_adms_cursors

Satu opaque ATTLOG `Stamp` per device. Cursor berubah bersama durable ingress/recovery evidence dan update yang lebih tua tidak boleh menimpa cursor yang lebih baru.

### attendance_adms_commands / attendance_adms_command_events

Command state disimpan terpisah dari append-only event history. Extension awal hanya dapat menghasilkan `LOG` untuk registration recovery; tabel sengaja disiapkan untuk ATT-005 tanpa membuka generic remote-command surface.

## Failure behavior

- unknown device: request dijournal, quarantine `UNKNOWN_DEVICE`, tidak membuat event saat itu;
- unknown ATTLOG setelah device kemudian dipercaya: dapat direcover satu kali sesuai aturan registration-after-capture tanpa mengubah request historis;
- disabled/quarantined device: HTTP 403, request dijournal, quarantine `DEVICE_NOT_ALLOWED`;
- payload > 512 KiB: HTTP 413, quarantine `PAYLOAD_TRUNCATED`, tidak ACK sukses;
- malformed ATTLOG line: request tetap durable, line masuk quarantine dan line valid lain dapat tetap disimpan;
- exact duplicate: tidak menambah event kedua; outcome live-ingress dicatat `DUPLICATE_EXACT`;
- malformed/unknown command acknowledgement: request tetap durable dan result masuk quarantine;
- database transaction gagal: jangan kirim success ACK atau command response yang belum durable.

## Security dan privacy

- belum ada biometric template pada extension transport recovery ini;
- raw traffic tidak boleh berisi credential aplikasi HCIS;
- metadata header dibatasi dan control character dibersihkan;
- serial candidate disimpan sebagai hash pada request yang belum ter-resolve;
- hanya documented non-destructive `LOG` yang diizinkan; tidak ada arbitrary remote command;
- dedicated host harus dilindungi reverse proxy, request-size policy, TLS bila firmware mendukung, dan network controls sesuai environment;
- data produksi tidak boleh digunakan pada fixture/test.

## Acceptance criteria Go 1 + transport recovery extension

1. Protocol parser memiliki unit test untuk valid ATTLOG, invalid field count, invalid/future timestamp, serial extraction, handshake, idle `getrequest` ACK, ATTLOG ACK, Stamp, stable identity, `LOG` wire format, dan `/devicecmd` result parsing.
2. Migration membuat registry, journal, event, quarantine, cursor, minimal command state/event history, dan recovery marker tanpa mengubah `attendance_daily_records`.
3. Request/event/quarantine raw dan command event history tidak dapat UPDATE/DELETE melalui application flow.
4. Unknown device tidak langsung menghasilkan attendance event.
5. Setelah explicit registration, durable valid pre-registration ATTLOG dapat direcover idempotently ke raw event dengan provenance request asli.
6. Recovery dapat seed cursor tanpa menurunkan cursor yang lebih baru.
7. Registration recovery queue satu `LOG`, `/getrequest` mengirim wire command secara durable, dan `/devicecmd` mencatat result secara durable sebelum `OK`.
8. Active registered device dapat menghasilkan event durable dan ACK setelah commit.
9. Replay exact ATTLOG tidak menggandakan event.
10. Tidak ada code path ingress/recovery yang menginfer late/absence/overtime/payroll/resolution outcome.
11. Projection failure tidak membatalkan durable ADMS ACK/recovery.
12. Migration, typecheck, lint, test, dan build harus lulus pada environment nyata sebelum extension dinyatakan verified.
13. Fresh physical punch tetap memerlukan production canary terpisah sebelum realtime delivery dinyatakan stabil.
14. Production deployment/cutover tetap membutuhkan human approval sesuai engineering workflow.
