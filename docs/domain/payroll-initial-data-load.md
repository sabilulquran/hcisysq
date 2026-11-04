# Payroll Initial Data Load (PAY-003 §9.1)

**Status:** ACCEPTED untuk implementasi (parameter bertanda `DRAFT` adalah default keputusan agent, menunggu konfirmasi process owner)  
**Specification:** PAY-003-MIG  
**Induk:** PAY-003 v1 `docs/domain/payroll-calculation-v1.md` §9.1  
**Related:** EMP-005 (employment baseline), ORG-011 `docs/domain/job-classification-grade.md`, LOAN-001 `docs/domain/employee-loans.md`  
**Evidence:** `docs/domain/payroll-legacy-flow-audit.md` (aturan legacy), `apps/api/src/modules/payroll/policy.ts`, `apps/api/src/modules/payroll/admin-routes.ts`

Spesifikasi ini mengatur pemuatan data awal payroll dari spreadsheet legacy ke tiga tabel PAY-003 yang masih kosong di production: `payroll_policy_versions`, `payroll_compensation_profiles`, dan `payroll_loans`. Tanpa data ini tidak ada periode yang dapat dihitung, sehingga parallel run (§9.2) tidak dapat dimulai.

Dokumen ini **tidak** memuat data pegawai, nominal gaji perorangan, atau nomor rekening. Nilai kebijakan legacy yang sudah dicatat di audit legacy tidak diulang di sini; nilai lengkap hanya ada di berkas masukan yang disiapkan di luar repository.

## 1. Cakupan

Termasuk:

- Satu versi awal untuk setiap kunci kebijakan yang dibaca engine (`POLICY_KEYS` di `policy.ts`) ditambah `VARIANCE_THRESHOLD`. `PPH21_TER` didukung CLI tetapi tidak dimuat pada putaran pertama (§3.2).
- Satu profil kompensasi per employment aktif yang dapat dicocokkan lewat NIP.
- Satu kasbon per pegawai yang masih bersisa utang pada bulan legacy terakhir.

Di luar cakupan: histori `PAYROLL` lama (tetap arsip PAY-001), input periode (lembur, pendidikan anak, rapel, penyesuaian, kehadiran PKWT), dan pembuatan employment. Employment adalah milik EMP-005; CLI ini tidak pernah membuatnya (§5.1).

## 2. Aktor, permission, dan prasyarat

| Aktor | Peran |
|---|---|
| Operator (Human Capital, dijalankan agent/owner di server) | Menyiapkan berkas masukan di luar repository, menjalankan dry-run, lalu `--apply`. |
| Akun pelaku (`--actor-account`) | Akun HCIS yang tercatat sebagai pelaku pada setiap baris dan audit event. Wajib untuk `--apply`. |

Akun pelaku harus aktif dan memegang permission yang sama dengan route HTTP untuk setiap bagian yang ada di berkas: `payroll.policies.manage` (kebijakan), `payroll.profiles.manage` (profil), `payroll.loans.manage` (kasbon). Bila tidak ada satu akun yang memegang ketiganya (di peran bawaan, kebijakan dan profil milik Kepala Human Capital, kasbon milik Keuangan), berkas dipecah per bagian dan dijalankan dengan akun pelaku masing-masing. Aturan route "tidak mengubah profil sendiri" juga berlaku: profil untuk employment milik akun pelaku ditolak (`OWN_RECORD`); profil itu dimuat lewat run terpisah dengan akun pelaku lain.

Prasyarat data: employment EMP-005 sudah ada untuk pegawai yang dimuat (baseline `employment:baseline --apply` sudah dijalankan). Tanpa employment, profil dilaporkan `EMPLOYMENT_MISSING` dan tidak ditulis.

Prasyarat periode: tidak ada periode payroll berstatus `CALCULATED` ke atas yang tanggal gajiannya pada atau setelah tanggal berlaku data. Bila ada, seluruh kebijakan dan profil ditolak (`SETTLED_PERIOD`); CLI tidak menyediakan jalur berlaku mundur.

## 3. Pemetaan sumber ke target

Sumber legacy (dibaca oleh operator, bukan oleh CLI): spreadsheet *Payroll SDM YSQ* (tab `FORMULA GAJI`, `Master Data SDM`, `DATA OLAHAN GAJI`) dan *Input PG & Lembur* (tab `Kinerja & Jml Jam`, `Kasbon Karyawan`).

**Tanggal berlaku (`DRAFT`).** Semua kebijakan dan profil berlaku mulai **2026-10-01**, yaitu bulan legacy terakhir yang sudah dihitung (Oktober 2026). Dengan begitu periode Oktober dapat dihitung ulang di HCIS sebagai pembanding pertama terhadap `DATA OLAHAN GAJI`, sebelum periode November berjalan paralel.

### 3.1 Kebijakan (`payroll_policy_versions`)

Referensi unit dan jabatan di dalam payload ditulis secara simbolik di berkas masukan (`unit:<nama>`, `functional:<label>`, `structural:<label>`) dan diselesaikan CLI menjadi uuid (§4).

| Kunci | Sumber legacy | Isi payload |
|---|---|---|
| `SALARY_SCALE` | `FORMULA GAJI` kolom A–E (pendidikan × MKG 0–27) | `scale.<SD/SMP/SLTA/D1_D2/D3_D4/S1/S2_S3>` = 28 nominal per MKG, **nilai apa adanya tanpa pembulatan** (§3.4). |
| `BASIC_MULTIPLIER` | rumus gaji pokok `DATA OLAHAN GAJI` | `units = { unit:Taman Tahfizh: 0.5 }`; `knownUnitRefs` = semua unit HCIS yang dipakai pegawai di berkas; `workPatterns = { HALF_DAY: 0.6, HALF_DAY_II: 0.65 }`. |
| `TEACHING_HOURS` | `FORMULA GAJI` "Minimal jam/bulan"; rumus kelebihan/kekurangan jam | `monthlyHourLimit` 96, tarif kelebihan dan kekurangan per jam sesuai rumus, `weeksPerMonth` 4. |
| `PERFORMANCE` | `FORMULA GAJI` "Tunjangan Kinerja", "Nilai Tunjangan", 60/40 | `defaultBase`, `annualShare` 0.6, `monthlyShare` 0.4, `baseByPosition = { structural:Kepala General Affair: <nilai khusus> }`, `unratedBelowOneYear = { annualRate: 0, monthlyRate: 0 }` (PAY-003 §10 butir 3, keputusan owner 2026-11-04: sama dengan spreadsheet, yang membayar 0 tanpa penilaian). |
| `FAMILY` | `FORMULA GAJI` Istri/Suami, Anak | `spouseRate`, `childRate`. |
| `FUNCTIONAL_ALLOWANCE` | `FORMULA GAJI` kolom J:K, "Tunj. rangkap" | `byPosition` = setiap label tabel J:K sebagai `functional:<label>`; `concurrentStructuralFactor` 0.7; `excludedUnits = [unit:Pesantren Tahfizh]`; `positionsWithoutAllowance = []`. |
| `POSITIONAL_ALLOWANCE` | `FORMULA GAJI` kolom J:K, "Kepala unit + Taman tahfizh" | `byPosition` = setiap label tabel J:K sebagai `structural:<label>`, ditambah `structural:Kepala General Affair` dengan nominal Kepala Unit (§3.3); `unitMultipliers = { unit:Taman Tahfizh: 0.5 }`; `positionsWithoutAllowance = []`. |
| `OVERTIME` | rumus lembur (D3) | `monthlyHourDivisor` 173. |
| `BPJS_KESEHATAN` | `FORMULA GAJI` UMK Kota Cirebon dan 5%; D11 | `contributionRate` 0.05, `extraFamilyRate` 0.01, `floor` = UMK 2026, `ceiling` 12.000.000, `coveredChildren` 3, `fixedAllowanceComponents = [BASIC, PERF, SPOUSE, CHILD, FUNC, POS, SPECIAL_QUAL]` (PAY-003 §10 butir 2). |
| `CONTRACT_RATES` | `FORMULA GAJI` Trasport PKWT, Honor PKWT/Jam | `transportPerAttendance`, `teachingFeePerHour`. |
| `EARLY_SERVICE` | rumus "Gaji Netto 80%" (D8) | `months` 2, `netRate` 0.8. |
| `VARIANCE_THRESHOLD` | PAY-003 §10 butir 6 | `relative` 0.1, `absolute` 50.000, `manualInput` 1.000.000. |
| `PPH21_TER` | tidak ada di spreadsheet | **tidak dimuat** (§3.2). |

Setiap baris menyimpan `source` yang menyebut berkas, tab, dan bulan data, dan CLI menambahkan penanda `[PAY-003-MIG]` bila belum ada. Penanda ini dipakai rollback (§8).

### 3.2 PPh21 TER

Engine tidak membaca `PPH21_TER`, dan tabel TER A/B/C tidak ada di spreadsheet legacy (perhitungan PPh21 legacy berada di berkas laporan terpisah). Menyalin tabel dari ingatan tidak dapat diverifikasi, jadi putaran pertama **tidak** memuatnya (`DRAFT`). CLI menerima kunci ini bila disertakan; isinya harus disalin dari lampiran PP 58/2023 dan diverifikasi sebelum laporan PPh21 dibangun (PAY-003 §10 butir 9).

### 3.3 Profil kompensasi (`payroll_compensation_profiles`)

Satu baris berkas per pegawai, dicocokkan lewat **NIP** (`employees.employee_number`). Field mengikuti `profileBody` route HTTP.

| Field | Sumber legacy | Aturan |
|---|---|---|
| `education` | `PENDIDIKAN TERAKHIR` | SD, SMP, SLTA (juga SMA), D1/D2 → `D1_D2`, D3/D4 → `D3_D4`, S1, S2/S3 → `S2_S3`. Nilai lain → baris ditolak (`INVALID`), tidak ditebak. |
| `workPattern` | akhiran label `JABATAN FUNGSIONAL` | "…Half Day II" → `HALF_DAY_II`; "…Half Day" → `HALF_DAY`; selain itu `null` (penuh). Sama dengan `RIGHT()` di rumus legacy. |
| `unit` | `UNIT` | Nama unit HCIS (`organizational_units`), §4. |
| `functional` | `JABATAN FUNGSIONAL` | Label tabel tunjangan J:K. Label yang **tidak ada** di tabel J:K dimuat sebagai `null` (§3.5). |
| `structural` | `JABATAN STRUKTURAL` | Sama seperti fungsional. Pengecualian: pegawai dengan `JABATAN` = "Kepala General Affair" diberi `structural:Kepala General Affair` (§3.5). |
| `teachingHoursPerWeek` | `DATA OLAHAN GAJI` "Jumlah Jam" bulan terakhir (= jam per pekan × 4, dari `Kinerja & Jml Jam`) | Dibagi 4. 0 atau kosong → `null` (tidak terkena aturan jam, sama dengan legacy yang hanya memotong bila jam > 0). |
| `spouseCount`, `childCount` | `ISTRI/ SUAMI`, `ANAK` | Bilangan bulat ≥ 0. |
| `registeredDependants` | — | `DRAFT`: pasangan + anak (seluruh keluarga dianggap terdaftar), sehingga anggota tambahan BPJS = anak di atas 3. HC mengoreksi lewat profil baru bila data kepesertaan berbeda. |
| `annualPerformanceRate`, `monthlyPerformanceRate` | `Kinerja & Jml Jam` bulan terakhir | Persen → pecahan (100% → 1). Kosong → `null`. |
| `specialQualificationTarget` | `FORMULA GAJI` kolom N:Q "GAJI BARU" | Hanya bila kolom NIP berisi NIP yang cocok; baris berisi nama, bukan NIP, dilaporkan di berkas persiapan dan tidak dimuat. |
| `bpjsSegment`, `bpjsActiveFrom` | `BPJS KESEHATAN` | Nomor diawali "00" (aturan tunjangan BPJS legacy) → `PPU_YAYASAN`, aktif sejak tanggal berlaku data (`DRAFT`). Selain itu `BELUM_TERDAFTAR` tanpa tanggal (`DRAFT`; spreadsheet tidak membedakan PBI dan mandiri, dan keduanya tidak menghasilkan iuran). |
| `ptkpStatus` | `Status PTKP` | Teks apa adanya, maksimal 16 karakter. |
| `bankName` | — | `DRAFT`: "BSI", bank daftar transfer legacy. |
| `bankAccountNumber` | `No. Rekening BANK` | Teks apa adanya. |
| `bankAccountName` | `NAMA` | `DRAFT`: nama pegawai di master SDM. Legacy memperbaiki nama pemilik rekening di berkas laporan terpisah; HC memverifikasi sebelum periode diajukan. |
| `legacyServiceStartDate` | `TMT` | Tidak disimpan. CLI membandingkannya dengan TMT employment EMP-005 dan memberi peringatan `TMT_DIFFERS` karena MKG dihitung dari employment. |

Populasi: baris `DATA OLAHAN GAJI` bulan terakhir (status master SDM `Aktif`, yang kolomnya diambil legacy dari master SDM lewat `VLOOKUP`) ditambah pegawai `Aktif PKWT` di `OlahanGajiHonorer`. Baris `Pengurus Yayasan` tidak dimuat: EMP-005 mengecualikan pengurus dari employment, dan payroll v1 tidak membayar mereka. Profil PKWT tetap dibutuhkan karena perhitungan tanpa profil memblokir pegawai (`PROFILE_MISSING`) dan rekening dibaca dari profil.

**Pegawai kontrak (diselesaikan 2026-11-04).** Legacy menghitung pegawai berstatus `Aktif` dengan kepegawaian "Pegawai Kontrak" memakai rumus pegawai tetap (gaji pokok dan tunjangan), sedangkan hanya `Aktif PKWT` yang dibayar sebagai honorer. Owner memutuskan 2026-11-04 bahwa kontrak memang ada dua jenis: `KONTRAK` kini berarti kontrak bergaji (PAY-003 §5.1) dan `KONTRAK_HONORER` kontrak per kehadiran (§5.2). Baseline EMP-005 memetakan `Aktif PKWT` ke `KONTRAK_HONORER` (EMP-005 §4.2.1); employment yang sudah terlanjur dibuat sebagai `KONTRAK` dikoreksi dengan koreksi kategori baseline (EMP-005 §8.2). Profil semua pegawai kontrak tetap dimuat lengkap, jadi koreksi ini tidak membutuhkan pemuatan ulang.

### 3.4 Skala gaji tanpa pembulatan

Skala legacy dihitung berantai dengan persentase kenaikan, sehingga nilainya bukan rupiah bulat, dan rumus gaji pokok membulatkan **setelah** pengali (`ROUNDUP(skala × pengali)`). Membulatkan skala lebih dulu menggeser hasil satu rupiah pada pola Half Day. Karena itu skema `SALARY_SCALE` menerima nominal pecahan yang tidak negatif (perubahan kode PAY-003-MIG); `BASIC` tetap dibulatkan ke atas oleh engine seperti sebelumnya, sehingga semua uang yang dibayar tetap rupiah bulat (PAY-003 §5).

### 3.5 Label jabatan tanpa tarif (`DRAFT`)

Rumus legacy membungkus pencarian tunjangan dengan `IFERROR(…, "")`: label yang tidak ada di tabel J:K menghasilkan tunjangan kosong **dan** tidak memicu faktor rangkap 70% (faktor itu bergantung pada sel tunjangan jabatan yang terisi). Engine memicu 70% begitu `structuralPositionRef` terisi. Agar parallel run sebanding, label yang tidak bertarif dimuat sebagai referensi `null`, bukan sebagai referensi yang masuk `positionsWithoutAllowance`. Label aslinya tetap tersimpan di data pegawai (`employees.functional_position` / `structural_position`). Jumlah label semacam ini dilaporkan berkas persiapan sebagai `LABEL_NOT_PRICED` untuk ditinjau HC; bila HC kemudian memberi tarif, profil baru dibuka dengan referensi yang sesuai.

Tunjangan kinerja khusus legacy dipicu oleh `JABATAN` = "Kepala General Affair", sedangkan engine memakai referensi jabatan struktural. Karena itu pegawai tersebut memakai referensi struktural tersendiri yang di `POSITIONAL_ALLOWANCE` bernilai sama dengan Kepala Unit dan di `PERFORMANCE.baseByPosition` bernilai dasar khusus.

Perbedaan yang tetap ada dan harus dijelaskan saat parallel run: pengali unit tunjangan jabatan legacy hanya untuk "Kepala Unit" di Taman Tahfizh, sedangkan engine memakai pengali unit untuk semua jabatan struktural di unit itu; dan pegawai Taman Tahfizh dengan pola Half Day mendapat pengali gabungan di engine tetapi hanya 50% di legacy. Berkas persiapan menghitung kasus semacam ini; bila ada, kasusnya dicatat sebagai selisih yang disengaja atau dikoreksi lewat profil.

### 3.6 Kasbon (`payroll_loans`)

| Field | Sumber legacy | Aturan |
|---|---|---|
| pegawai | `NIP` | Dicocokkan ke `employees.employee_number`. |
| `principal` | `Sisa Hutang` pada bulan legacy terakhir | Saldo berjalan setelah potongan bulan itu. Sisa 0 → tidak dimuat. Satu kasbon per pegawai (legacy menyimpan saldo gabungan per bulan). |
| `grantedOn` | — | `DRAFT`: 2026-10-31, hari terakhir bulan legacy terakhir; ini tanggal pindah saldo, bukan tanggal pinjaman asli. |
| `instalment` | — | `null`: potongan legacy berubah tiap bulan, jadi Keuangan menetapkannya per periode. |
| `note` | — | "Saldo kasbon pindahan dari spreadsheet legacy [PAY-003-MIG]". |

Kasbon pindahan tidak terhubung ke LOAN-001 (`employee_loan_id` kosong, sesuai `docs/domain/employee-loans.md` untuk kasbon lama).

Pokok pindahan sudah **setelah** potongan Oktober. Register kasbon tidak menyaring kasbon menurut `granted_on`, jadi bila periode Oktober dihitung ulang di HCIS sebagai pembanding (§3), potongan kasbon Oktober **tidak** dimasukkan; selisih baris `LOAN` Oktober terhadap legacy adalah akibat yang disengaja. Potongan pertama di HCIS adalah potongan November.

### 3.7 Pemeriksaan berkas sebelum dimuat

Berkas yang disiapkan dijalankan lewat engine yang sama terhadap nominal Oktober 2026 di `DATA OLAHAN GAJI`, di luar repository dan hanya dengan keluaran jumlah. Hasil pada persiapan 2026-11-03: `BASIC`, `TEACH_OVER`, `SPOUSE`, `CHILD`, `FUNC`, dan `POS` sama untuk seluruh pegawai bergaji pokok. Selisih hanya pada `PERF` untuk pegawai di bawah setahun yang belum punya nilai kinerja (legacy membayar 0, engine memakai default PAY-003 §10 butir 3), dan pada `SPECIAL_QUAL` pegawai yang sama karena targetnya menyerap `PERF` tersebut. Selisih ini harus dicatat sebagai keputusan §10 butir 3 pada gate parallel run. Satu pegawai memiliki kualifikasi khusus negatif di legacy dan akan diblokir sampai penyesuaian gaji ditetapkan (D1).

## 4. Referensi unit dan jabatan

Payload kebijakan dan profil memakai uuid tanpa foreign key (migration 0069), dan engine hanya mencocokkan uuid profil dengan kunci kebijakan. Tidak ada tabel HCIS yang dapat menjadi rujukan bersama untuk keduanya hari ini:

- Kursi ORG-004 (`organization_positions.stable_key`) hanya berisi kursi struktural; tidak ada kursi untuk jabatan fungsional guru, dan penempatan EMP-006 belum menunjuk kursi (`job-classification-grade.md` §1.1).
- Katalog ORG-011 (`job_classifications`) masih kosong, dan kodenya, bukan uuid barisnya, yang stabil lintas versi.

Keputusan (`DRAFT`):

| Simbol | Uuid | Validasi |
|---|---|---|
| `unit:<nama>` | `organizational_units.id`, dicocokkan dengan nama ternormalisasi (`normalized_name`) | Nama tidak ditemukan → `UNIT_UNKNOWN`, baris ditolak. Tabel ini yang dirujuk `employees.organizational_unit_id` dan `employment_placements.legacy_unit_id`. |
| `functional:<label>` | uuid v5 deterministik dari label ternormalisasi, namespace fungsional | — |
| `structural:<label>` | uuid v5 deterministik dari label ternormalisasi, namespace struktural | — |

Uuid v5 memakai namespace tetap `PAYROLL_REF_NAMESPACE` di `initial-load.ts`, sehingga label yang sama selalu menghasilkan uuid yang sama di setiap lingkungan dan setiap re-run. Setiap payload kebijakan yang memuat referensi juga menyimpan `refLabels: { <uuid>: "<simbol>" }`, sehingga uuid dapat dijelaskan dari database tanpa berkas masukan. Engine mengabaikan field ini (skema zod membuang kunci yang tidak dikenal).

Jalan keluarnya adalah ORG-011 §7 langkah 5: setiap uuid di `refLabels` dipetakan ke `classificationCode` dan kunci `byPosition` disalin. Mengganti label di data pegawai setelah pemuatan **tidak** mengubah gaji, karena profil menyimpan uuid, bukan label.

## 5. Perilaku CLI

```text
npm --workspace @hcis/api run payroll:initial-load -- --file <input.json> [--actor-account <uuid>] [--apply]
```

Di release Mi8VPS: `node apps/api/dist/modules/payroll/cli/payroll-initial-load.js --file … [--actor-account …] [--apply]` (lihat `docs/development/mi8vps-hcis-release.md` §4.11).

1. Membaca berkas JSON (format `PAY-003-MIG/1`), memeriksa bentuknya, lalu menyusun rencana di dalam transaksi `READ ONLY`.
2. Kebijakan: menyelesaikan simbol, menjalankan `validatePolicyPayload`, dan bentuk `policyBody` route.
3. Profil: menyelesaikan NIP → pegawai → employment, menyelesaikan unit dan jabatan, lalu menjalankan `profileBody` route dan dua aturan basis data yang dipakai route (override BPJS wajib alasan; tanggal aktif BPJS wajib segmen selain `BELUM_TERDAFTAR`).
4. Kasbon: menyelesaikan NIP → pegawai, lalu `loanBody` route.
5. Dry-run (default) mencetak ringkasan dan berhenti. Tidak ada yang ditulis.
6. `--apply` menolak berjalan bila rencana memuat galat apa pun, mencatat `payroll.initial_load.started`, lalu menulis hanya baris berstatus `CREATE` lewat fungsi store yang sama dengan route (`openPolicyVersion`, `openCompensationProfile`, `createLoan`), sehingga setiap baris menghasilkan audit event route yang sama. Satu advisory lock mencegah dua run CLI berjalan bersamaan; lock itu tidak menahan penulisan lewat layar, jadi run dilakukan saat tidak ada yang mengubah data payroll.
7. Setiap baris ditulis dalam transaksinya sendiri. Bila satu baris gagal di tengah, baris sebelumnya tetap tertulis, CLI mencatat `payroll.initial_load.failed` dengan jumlah yang sudah tertulis dan kode SQLSTATE, mencetak laporan beserta `startedAt`, lalu keluar dengan kode 1. Pemulihannya adalah menjalankan ulang berkas yang sama: baris yang sudah tertulis kembali `UNCHANGED`, sisanya ditulis.

### 5.1 Baris yang tidak cocok

Tidak ada yang ditebak. Setiap baris yang tidak dapat dicocokkan dilaporkan dengan kode dan tidak ditulis:

| Kode | Arti |
|---|---|
| `INVALID` | Bentuk baris tidak lolos validasi route atau `validatePolicyPayload`. |
| `DUPLICATE_ROW` | NIP (profil/kasbon) atau kunci kebijakan muncul lebih dari sekali di berkas. |
| `EMPLOYEE_NOT_FOUND` | NIP tidak ada di `employees` (atau sudah dihapus). |
| `EMPLOYMENT_MISSING` | Pegawai ada, tetapi tidak punya employment EMP-005 yang berlaku pada tanggal profil. |
| `EMPLOYMENT_AMBIGUOUS` | Lebih dari satu employment berlaku pada tanggal itu. |
| `UNIT_UNKNOWN` | Nama unit tidak ada di `organizational_units`. |
| `OWN_RECORD` | Profil untuk employment milik akun pelaku. |
| `EXISTS_DIFFERENT` | Sudah ada versi/profil/kasbon pindahan dengan kunci yang sama tetapi isinya berbeda. Tidak ditimpa. |
| `LATER_VERSION_EXISTS` | Sudah ada versi kebijakan atau profil yang berlaku setelah tanggal berkas. |
| `SETTLED_PERIOD` | Ada periode `CALCULATED` ke atas yang tanggal gajiannya tidak sebelum tanggal berlaku. |
| `CORRECTION_TARGET_MISSING` | Baris kebijakan membawa `correctionReason`, tetapi tidak ada versi pada tanggal yang sama untuk dikoreksi (§5.4). |
| `VERSION_NOT_FROM_LOAD` | Versi pada tanggal yang sama tidak dibuka oleh pemuatan awal (tanpa penanda `[PAY-003-MIG]`); koreksi hanya lewat versi baru. |
| `VERSION_IN_USE` | Versi pada tanggal yang sama sudah dipakai hasil perhitungan; koreksi hanya lewat versi baru. |

Peringatan (baris tetap dapat ditulis): `TMT_DIFFERS`, `OUT_OF_PAYROLL_SCOPE` (kategori employment `MAGANG`/`BELUM_DIKLASIFIKASIKAN`), `UNIT_NOT_IN_POLICY` dan `POSITION_NOT_IN_POLICY` (referensi profil tidak dikenal kebijakan di berkas yang sama; periode akan terblokir `UNIT_NOT_MAPPED`/`POSITION_NOT_MAPPED`), `SUPERSEDES_VERSION` (baris akan menutup versi/profil terbuka yang lebih awal), `OPEN_LOAN_EXISTS` (pegawai sudah punya kasbon terbuka lain yang bukan kasbon pindahan).

`INVALID` juga mencakup: tanggal yang tidak ada di kalender, jam mengajar dengan lebih dari 2 desimal atau persentase kinerja dengan lebih dari 4 desimal (kolom basis data akan membulatkannya), referensi di payload kebijakan yang setelah diselesaikan bukan uuid (simbol salah ketik), dan dua simbol yang jatuh ke uuid yang sama di satu tabel. Bagian berkas yang tidak dikenal (misalnya `loan` untuk `loans`) menolak seluruh berkas.

### 5.2 Idempoten

| Data | Kunci | Ulang dengan isi sama | Isi berbeda |
|---|---|---|---|
| Kebijakan | `policy_key` + `effective_from` | `UNCHANGED`, dilewati | `EXISTS_DIFFERENT`, atau `CORRECT` bila baris membawa `correctionReason` dan syarat §5.4 terpenuhi |
| Profil | `employment_id` + `effective_from` | `UNCHANGED`, dilewati | `EXISTS_DIFFERENT` |
| Kasbon | `employee_id` + penanda `[PAY-003-MIG]` di `note` (satu kasbon pindahan per pegawai) | `UNCHANGED`, dilewati | `EXISTS_DIFFERENT`, termasuk bila hanya tanggal atau catatannya yang berubah |

Payload kebijakan dibandingkan setelah kunci diurutkan; profil dibandingkan per field dengan angka dinormalisasi. Baris yang sudah ada persis sama selalu `UNCHANGED`, juga bila sesudahnya sudah dibuka versi yang lebih baru, sehingga run ulang tetap bisa menjadi jalur pemulihan. Menjalankan ulang berkas yang sama setelah `--apply` menghasilkan nol `CREATE`.

### 5.3 Keluaran

Hanya jumlah, kode, kunci kebijakan, dan `rowId` dari berkas masukan (pengenal baris yang ditetapkan operator, bukan NIP). Nama, NIP, nominal, dan nomor rekening tidak pernah dicetak.

### 5.4 Koreksi versi kebijakan hasil muat

Versi kebijakan yang dibuka pemuatan ini dan **belum dipakai hasil perhitungan mana pun** belum pernah membayar siapa pun, jadi kesalahan isinya boleh dikoreksi di tempat tanpa membuka versi baru. Pada tanggal berlaku yang sama tidak mungkin membuka versi kedua (constraint `payroll_policy_versions_no_overlap`), sehingga ini satu-satunya cara memperbaiki nilai yang berlaku sejak tanggal muat.

- Baris kebijakan diberi `correctionReason` (10–500 karakter, misalnya rujukan keputusan owner). Tanpa field itu baris yang berbeda tetap `EXISTS_DIFFERENT`.
- Syarat: ada versi dengan `policy_key` dan `effective_from` sama, sumbernya bertanda `[PAY-003-MIG]`, dan `payroll_results.policy_version_ids` tidak memuat id-nya. Syarat diperiksa saat rencana dan diulang di bawah row lock saat menulis.
- Hasilnya `CORRECT`: `payload`, `source`, dan `note` versi itu diganti; id dan tanggalnya tetap. Audit `payroll.policy.version_corrected` menyimpan `policy_key`, `effective_from`, `version_id`, alasan, serta `previous_payload` dan `previous_source`, sehingga koreksi dapat dibaca ulang dan dibatalkan dengan menjalankan koreksi balik.
- Versi yang sudah dipakai perhitungan, atau yang dibuka lewat layar, hanya dapat diubah dengan versi baru (PAY-003 §10).

Pemakaian pertama (2026-11-04): `PERFORMANCE.unratedBelowOneYear.monthlyRate` 1 → 0 sesuai keputusan owner (PAY-003 §10 butir 3).

## 6. Audit

Setiap baris yang ditulis menghasilkan audit event yang sama dengan jalur HTTP: `payroll.policy.version_opened`, `payroll.profile.opened` (dengan `employment_id`), `payroll.loan.created`; koreksi §5.4 menghasilkan `payroll.policy.version_corrected`. Sebelum baris pertama CLI menulis `payroll.initial_load.started` (waktu mulai, nama berkas), lalu satu `payroll.initial_load.applied` (waktu mulai dan selesai, jumlah per bagian) atau `payroll.initial_load.failed` (jumlah yang sudah tertulis, SQLSTATE). Galat basis data dicetak hanya sebagai SQLSTATE dan nama constraint, karena detailnya dapat mengutip seluruh baris termasuk rekening. Tidak ada nominal perorangan atau rekening di payload; constraint `payroll_audit_events_payload_has_no_personal_amount` tetap berlaku.

## 7. Perubahan basis data

Hanya data. Tidak ada migration. Satu perubahan kode di luar CLI: skema `SALARY_SCALE` menerima nominal pecahan (§3.4).

## 8. Rollback dan pemulihan

Selama belum ada periode yang dihitung dengan data ini, pemuatan dapat dibatalkan. Jalankan **sekali per run** (per akun pelaku), dengan `started` dan `finished` dari audit `payroll.initial_load.started` dan `.applied`/`.failed` run itu, sehingga profil yang dibuka akun yang sama lewat layar sesudahnya tidak ikut terhapus. Dalam `psql`:

```sql
\set actor '<uuid akun pelaku>'
\set started '<started_at>'
\set finished '<finished_at, atau waktu audit .failed>'
BEGIN;
DELETE FROM payroll_loans l
 WHERE l.note LIKE '%[PAY-003-MIG]%'
   AND l.recorded_by_account_id = :'actor'
   AND NOT EXISTS (SELECT 1 FROM payroll_loan_deductions d WHERE d.loan_id = l.id);
DELETE FROM payroll_compensation_profiles p
 WHERE p.recorded_by_account_id = :'actor'
   AND p.recorded_at BETWEEN :'started'::timestamptz AND :'finished'::timestamptz
   AND NOT EXISTS (SELECT 1 FROM payroll_results r WHERE r.compensation_profile_id = p.id);
DELETE FROM payroll_policy_versions v
 WHERE v.source LIKE '%[PAY-003-MIG]%'
   AND v.created_by_account_id = :'actor'
   AND NOT EXISTS (SELECT 1 FROM payroll_results r WHERE r.policy_version_ids ? v.id::text);
COMMIT;
```

Audit event tidak dihapus. Pemuatan awal tidak menutup versi pendahulu karena tabelnya kosong; bila suatu saat dijalankan di atas data yang sudah ada (peringatan `SUPERSEDES_VERSION`), rollback juga harus mengembalikan `effective_to` pendahulu, jadi pastikan dry-run tidak memuat peringatan itu sebelum `--apply`.

Setelah periode dihitung, koreksi tidak dilakukan dengan menghapus, tetapi dengan membuka versi atau profil baru (PAY-003 §3).

Pemulihan penuh tetap lewat backup database harian dan backup pra-rilis (OPS-MI8-REL-001).

## 9. Test

- Integration test PostgreSQL dengan data sintetis: dry-run tidak menulis apa pun; `--apply` menulis kebijakan, profil, kasbon beserta audit event; re-run menghasilkan nol `CREATE`; isi berbeda menghasilkan `EXISTS_DIFFERENT`; koreksi §5.4 hanya dengan alasan, mempertahankan id versi, mencatat payload sebelumnya, dan ditolak untuk versi tanpa penanda muat atau tanpa versi sasaran; NIP tak dikenal, employment tak ada, unit tak dikenal, dan baris tidak valid dilaporkan dan tidak ditulis; periode `CALCULATED` menolak seluruh kebijakan dan profil; profil milik pelaku ditolak; apply ditolak bila ada galat; keluaran tidak memuat NIP, nama, nominal, atau rekening.
- Unit test: uuid v5 deterministik dan sesuai RFC 4122; penyelesaian simbol; `SALARY_SCALE` pecahan diterima dan `BASIC` dibulatkan ke atas.

## 10. Keputusan `DRAFT`

| # | Keputusan | Default |
|---|---|---|
| 1 | Tanggal berlaku kebijakan dan profil | 2026-10-01 (bulan legacy terakhir, agar Oktober dapat dibandingkan) |
| 2 | Rujukan unit | `organizational_units.id` lewat nama ternormalisasi |
| 3 | Rujukan jabatan fungsional/struktural | uuid v5 dari label tabel tunjangan, dengan `refLabels` di payload; dipetakan ke ORG-011 kemudian |
| 4 | Label jabatan tanpa tarif | referensi `null` (sama dengan legacy: tanpa tunjangan dan tanpa faktor rangkap) |
| 5 | Tunjangan kinerja khusus | referensi struktural tersendiri "Kepala General Affair" |
| 6 | Tanggungan terdaftar BPJS | pasangan + anak |
| 7 | Segmen BPJS | nomor "00" → `PPU_YAYASAN` aktif sejak tanggal berlaku; lainnya `BELUM_TERDAFTAR` |
| 8 | Bank dan nama pemilik rekening | "BSI" dan nama pegawai di master SDM |
| 9 | Kasbon | satu per pegawai, pokok = sisa utang bulan terakhir, tanggal 2026-10-31, cicilan per periode |
| 10 | PPh21 TER | tidak dimuat pada putaran pertama |
| 11 | Skala gaji | nilai pecahan apa adanya |
