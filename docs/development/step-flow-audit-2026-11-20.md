# Audit alur bertumpuk (UX-FLOW-001)

**Status:** ACTIVE. Audit tanggal 2026-11-20 atas `apps/web/src`, dilakukan setelah keputusan owner bahwa semua alur bertahap di SQ Suite mengikuti **satu langkah per layar** ([UX-FLOW-001](https://github.com/sabilulquran/SQ-Hub/blob/main/docs/design/sq-step-flow.md)).
**Komponen:** `src/lib/useWizardStep.ts` (langkah di `?langkah=`), `src/components/wizard/WizardSteps.tsx`, `src/components/wizard/WizardDone.tsx`.

"Diperbaiki" artinya sudah diubah di branch. Status ini **bukan** berarti sudah dirilis.

## Pelanggaran yang diperbaiki

| Alur | Lokasi | Pengguna | Sebelumnya | Sekarang |
| --- | --- | --- | --- | --- |
| Cuti Tahunan | `pages/EmployeeAnnualLeavePage.tsx` (`/app/leave/annual`) | pegawai | form, ringkasan, dan kirim menumpuk di halaman Cuti & Izin | Isi tanggal → Periksa → Selesai |
| Kondisi khusus | `pages/EmployeeSpecialLeavePage.tsx` | pegawai | pilihan, form, ringkasan menumpuk | Pilih → Isi → Periksa → Selesai |
| Keperluan terencana | `pages/EmployeePlannedLeavePage.tsx` | pegawai | sama | Pilih → Isi → Periksa → Selesai |
| Ajukan pinjaman | `pages/EmployeeLoansPage.tsx` | pegawai | cicilan dan penyetuju muncul di dalam form | Isi data → Periksa (cicilan + penyetuju) → Selesai |
| Ajukan perjalanan dinas | `pages/EmployeeTripsPage.tsx` | pegawai | penyetuju muncul di dalam form | Isi data → Periksa (penyetuju) → Selesai |
| Tugas Luar/WFH/Ubah shift | `pages/EmployeeWorkArrangementsPage.tsx` | pegawai | pilihan jenis dan ringkasan menumpuk dengan form | Pilih → Isi data → Periksa (penyetuju + bentrok rapat) → Selesai |
| Tindakan kepegawaian | `components/employment/EmploymentActionDialog.tsx` | admin | ringkasan "Dari → Menjadi" dan Simpan di bawah form di dalam dialog | Isi data → Periksa (ringkasan, peringatan, Simpan) di dalam dialog |
| Impor Pegawai | `pages/AdminEmployeeImportPage.tsx` | admin | preview dan konfirmasi di bawah form unggah | Unggah → Periksa → Selesai (`?langkah=`) |
| Impor jabatan | `components/job-classifications/JobCatalogImportPanel.tsx` | admin | laporan dry-run dan Terapkan di bawah input berkas | Unggah berkas → Periksa → Hasil (state panel) |
| Sesuaikan dengan TMT | `components/attendance/reports/UnscheduledTab.tsx` | admin | panel preview dan Terapkan disisipkan di atas daftar | tampilan penyesuaian menggantikan daftar, dengan "Kembali ke daftar" |
| Usulkan tanggal lain | `components/leave/ProposeAlternativeDates.tsx` | atasan/HC | hasil periksa di bawah tanggal yang masih bisa diubah | Isi tanggal → Periksa (read-only + Kirim usulan) di dalam dialog |

## Dikecualikan, dengan alasan

| Alur | Lokasi | Alasan |
| --- | --- | --- |
| Peringatan lembur ("Tetap catat/kirim") | `pages/EmployeeAttendancePage.tsx`, `pages/AdminAttendanceOvertimePage.tsx`, `pages/EmployeeTeamOvertimePage.tsx` | Ini peringatan validasi yang muncul ketika mengirim, bukan langkah periksa. UX-FLOW-001 mengecualikan pesan validasi. |
| Kirim klaim reimbursement | `pages/EmployeeReimbursementsPage.tsx` | Form draf sudah diganti tampilan detail. Kotak penyetuju tampil di layar detail tanpa input yang menumpuk. |
| Perbarui dari struktur terbaru, Validasi/Dampak, konflik perubahan | `components/organization/*`, `pages/AdminOrganizationPage.tsx` | Halaman kerja (workspace) struktur. Hasil validasi adalah informasi, bukan langkah kirim, dan penerbitan memakai dialog terpisah. Pengecualian ini **tidak** mencakup `components/organization/OrganizationManagerBulkTab.tsx` (ORG-001): itu alur bertahap sungguhan dan mengikuti UX-FLOW-001 — lihat baris di bawah. |
| Perbaikan batch slip | `pages/AdminPayslipsPage.tsx` | Halaman kerja. Panel dibuka dari daftar batch, bukan langkah lanjutan form impor. |

## Alur baru yang lahir sudah mengikuti aturan

| Alur | Lokasi | Pengguna | Bentuk |
| --- | --- | --- | --- |
| Atasan langsung massal (ORG-001) | `components/organization/OrganizationManagerBulkTab.tsx` | admin (HC) | Unggah berkas → Periksa → Hasil (state panel, mengikuti Impor jabatan). Panel ini menumpang tab `?tab=` milik Struktur Organisasi, jadi langkahnya **tidak** ditulis ke `?langkah=`: `useWizardStep` akan membuang `tab` saat berpindah langkah. |

Pengecualian ditinjau ulang ketika alurnya disentuh. Alur yang dinilai OK (aktivasi akun, cek chain cuti, konfirmasi ya/tidak, dialog satu langkah) tidak dicatat.
