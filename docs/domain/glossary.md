# Domain Glossary

**Status:** DISCOVERY

Istilah pada UI, API, database, dokumentasi, dan test harus menggunakan definisi yang sama.

| Istilah | Definisi awal |
|---|---|
| Employee / Pegawai | Individu yang memiliki atau pernah memiliki hubungan kerja dan menjadi principal utama untuk akses HCIS. Status aktif menentukan akses operasional. |
| Candidate / Kandidat | Individu pada proses rekrutmen yang belum menjadi pegawai. Guard dan datanya harus terpisah dari employee sampai boundary hire/activation yang diterima. |
| Employment / Hubungan Kerja | Hubungan formal seorang person/employee dengan satu legal entity untuk periode tertentu. Kontrak, assignment, payroll, leave, dan status statutory dapat bergantung pada employment ini. |
| Employment Action / Tindakan Kepegawaian | Perubahan administratif bermakna historis seperti penempatan, promosi, demosi, mutasi, perpanjangan kontrak, atau perubahan kompensasi yang menghasilkan record effective-dated dan audit. |
| Decision Document / Surat Keputusan | Dokumen pendukung/dasar administratif bagi suatu employment action. Nomor dan file dokumen bukan pengganti structured effective-dated domain fact. |
| Legal Entity / Badan Hukum | Boundary organisasi formal yang dapat memiliki struktur ORG-004, site, employment, payroll, leave, dan attendance scope sendiri bila ORG-007 diaktifkan. Bukan sinonim tenant SaaS. |
| Unit | Bagian organisasi tempat pegawai ditugaskan. Struktur dan kewenangannya perlu diverifikasi. |
| Position / Posisi | Jabatan atau fungsi organisasi yang dapat memengaruhi akses dan approval. |
| Job Classification / Grade | Klasifikasi pekerjaan/kompensasi yang terpisah dari hierarchy dan authority ORG-004. Grade tidak otomatis memberi approval authority. |
| Direct Manager / Atasan Langsung | Pegawai yang ditetapkan sebagai atasan operasional utama untuk approval tertentu. Tidak selalu identik dengan role aplikasi. |
| Organization Snapshot | Satu change set ORG-004 yang memuat struktur efektif bertanggal; identitas snapshot tidak sama dengan ordered external version/cursor. |
| Organization Directory | Projection read-only fakta struktur yang bersumber dari HCIS untuk pencarian, navigasi, integrasi, dan distribusi lintas aplikasi; bukan editor/master kedua dan bukan pemilik workflow aplikasi. |
| Stable Business Identifier | Identifier domain yang dimaksudkan bertahan lintas versi/snapshot; tidak boleh disamakan otomatis dengan primary-row id. |
| Role | Kelompok kewenangan tingkat tinggi, misalnya pegawai atau super admin. |
| Permission | Kemampuan spesifik terhadap aksi/resource. Permission lebih presisi daripada role. |
| Policy | Aturan otorisasi yang menilai actor, aksi, dan resource. |
| Approval Request | Permintaan bisnis yang membutuhkan satu atau lebih keputusan. |
| Approval Step | Tahap berurutan atau paralel yang harus diputuskan oleh approver tertentu. |
| Approver | Actor yang berwenang memutuskan satu approval step. |
| Requester | Actor yang mengajukan permintaan. |
| Audit Event | Catatan append-oriented mengenai aksi, actor, waktu, target, dan metadata aman. |
| Working Day | Hari yang dihitung sebagai hari kerja berdasarkan kalender, jadwal, unit, dan aturan yang berlaku. |
| Leave Balance | Hak cuti yang tersedia setelah memperhitungkan entitlement, penggunaan, koreksi, dan periode. |
| Shift | Definisi jam/pola kerja seperti jam mulai, jam selesai, grace/tolerance, dan konteks lokasi yang menjadi expectation schedule; bukan bukti bahwa pegawai benar-benar hadir pada jam tersebut. |
| Work Schedule / Jadwal Kerja | Penetapan shift/OFF kepada pegawai pada tanggal atau pola periode tertentu. Backend dapat versioned/effective-dated walau operator memakai bahasa Jadwal. |
| Attendance Event | Bukti kehadiran atau aktivitas terkait kehadiran pada waktu tertentu. |
| Attendance Daily Result | Hasil resolusi kehadiran untuk satu employee/work date berdasarkan schedule, evidence, approved leave/permission, dan correction/justification yang berlaku; detail provenance tetap dapat ditelusuri. |
| Payroll Component | Definisi semantik baris payroll, misalnya earning, deduction, atau employer cost. Bukan nilai aktual pegawai pada periode tertentu. |
| Recurring Compensation | Assignment kompensasi berulang/effective-dated pada employment, misalnya gaji pokok atau tunjangan tetap. |
| Payroll Adjustment | Penambahan/pengurangan satu periode atau koreksi terkontrol dengan alasan, actor, source, dan audit. |
| Employer Cost / Company Cost | Biaya yang ditanggung pemberi kerja untuk payroll period dan tidak otomatis menjadi take-home pay pegawai. |
| Statutory Profile | Fakta effective-dated pada employee/employment yang diperlukan untuk perhitungan statutory, misalnya klasifikasi pajak/BPJS/risk bila kebijakan memerlukannya. |
| Payroll Period | Periode perhitungan dan penerbitan payroll; window input dapat memakai cutoff yang berbeda dari bulan kalender bila kebijakan menetapkan. |
| Payslip | Dokumen hasil payroll untuk satu pegawai dan satu periode dengan akses sangat terbatas. |
| Loan | Pinjaman pegawai dengan principal, tenor/cicilan, status, approval, dan rekonsiliasi. |
| Reimbursement | Penggantian biaya berdasarkan bukti dan kebijakan. |
| Notification | Pesan yang dipicu event melalui kanal seperti in-app, email, atau WhatsApp. |
| Legacy HCIS | Implementasi sebelumnya yang digunakan untuk discovery dan sumber migrasi. |
| Synthetic Data | Data buatan yang tidak berasal dari atau sengaja menyerupai data individu nyata. |

## Aturan terminologi

- Jangan menggunakan `user` ketika yang dimaksud secara spesifik adalah employee atau candidate.
- Bedakan role, position, dan direct manager.
- Bedakan status request dari status approval step.
- Jangan menyebut data terhapus bila sebenarnya soft-deleted, archived, atau deactivated.
- Istilah payroll dan finansial harus disetujui pemilik proses sebelum dianggap final.
