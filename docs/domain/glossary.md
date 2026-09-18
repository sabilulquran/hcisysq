# Domain Glossary

**Status:** DISCOVERY

Istilah pada UI, API, database, dokumentasi, dan test harus menggunakan definisi yang sama.

| Istilah | Definisi awal |
|---|---|
| Employee / Pegawai | Individu yang memiliki atau pernah memiliki hubungan kerja dan menjadi principal utama untuk akses HCIS. Status aktif menentukan akses operasional. |
| Candidate / Kandidat | Individu pada proses rekrutmen yang belum menjadi pegawai. Guard dan datanya harus terpisah dari employee. |
| Unit | Bagian organisasi tempat pegawai ditugaskan. Struktur dan kewenangannya perlu diverifikasi. |
| Position / Posisi | Jabatan atau fungsi organisasi yang dapat memengaruhi akses dan approval. |
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
| Attendance Event | Bukti kehadiran atau aktivitas terkait kehadiran pada waktu tertentu. |
| Payroll Period | Periode perhitungan dan penerbitan payroll. |
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
