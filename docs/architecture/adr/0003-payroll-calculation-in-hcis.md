# ADR-0003: HCIS Menghitung Payroll (PAY-003 v1)

- **Status:** ACCEPTED
- **Date:** 2026-10-24 (PROPOSED), 2026-10-27 (ACCEPTED)
- **Related:** PAY-001, PAY-002, PAY-003, PAYSLIP-001..006, ATT-010, EMP-005, AUTH-011, ORG-010; ADR-0001, ADR-0002
- **Evidence:** `docs/domain/payroll-legacy-flow-audit.md`, `docs/domain/payroll-engine-discovery.md`, `docs/domain/payroll-calculation-v1.md`

## Context

MVP HCIS sengaja membatasi payroll pada impor dan validasi data slip (PAY-001) serta akses baca slip oleh pegawai (PAY-002). `AGENTS.md` §5 dan `docs/product/mvp.md` §7 melarang membangun payroll calculation engine untuk memenuhi layar slip MVP. Product owner sudah memasukkan perhitungan payroll ke roadmap pada 2026-09-18 (PAY-003, `planned`), tetapi PAY-003 masih discovery.

Payroll YSQ saat ini dihitung di tujuh spreadsheet Google dan tiga project Apps Script (audit 2026-10-23). Audit menemukan risiko salah bayar (data impor berbasis posisi baris, kegagalan senyap `IFERROR`, lembur hanya baris pertama, snapshot tanpa pengaman duplikasi), tidak ada penguncian periode, dan data pribadi tersebar dengan akses file-level. Hasil hitungan spreadsheet kemudian diimpor ke HCIS sebagai slip opaque.

Pada 2026-10-23 product owner memutuskan bahwa **HCIS akan menghitung payroll**. Kemungkinan adanya sistem payroll baru di masa depan tetap diakui.

## Decision

1. **Batas MVP payroll diakhiri untuk PAY-003.** HCIS boleh memiliki payroll calculation engine sebagai modul pasca-MVP sesuai `docs/domain/payroll-calculation-v1.md`. Larangan di `AGENTS.md` §5 tetap berlaku untuk surface MVP yang sudah ada (PAY-001/PAY-002 tidak boleh diam-diam menghitung ulang nilai impor).
2. **Cakupan v1** (`DRAFT`: default agent 2026-10-24 atas butir yang belum dipilih owner; `docs/domain/payroll-legacy-flow-audit.md` §6.3 butir 1 mencatat butir yang sama sebagai belum dipilih, dan keputusan owner 2026-10-24 di §6.2 mencakup D9/D10/D11 saja):
   - pegawai tetap, masa percobaan, dan PKWT/honorer;
   - insentif Pj. Media untuk pegawai aktif sebagai komponen pendapatan variabel;
   - **di luar v1:** penerima non-pegawai/pengabdian/honor lain, THR, reimbursement, dan pembayaran langsung ke bank.
3. **Lokasi modul:** modul `payroll` di dalam modular monolith (ADR-0001), dengan aturan perhitungan di `packages/domain` sebagai fungsi murni tanpa ketergantungan HTTP/database (AGENTS.md §4). Integrasi luar (impor SPP, laporan PPh21) lewat adapter (ADR-0002).
4. **Hasil payroll adalah fakta tersimpan per periode.** Finalisasi mengunci input snapshot, versi kebijakan, dan baris hasil. Nilai final tidak dihitung ulang diam-diam; koreksi hanya lewat reopen yang disetujui.
5. **Publikasi slip memakai jalur PAY-001/PAY-002 yang ada.** Hasil final dipetakan ke baris slip (label/value) dan dipublikasikan lewat alur draft → publish yang sudah terverifikasi. Tampilan slip pegawai tidak berubah.
6. **Serah bayar tanpa surat.** HCIS tidak membuat memorandum, PDF, share email, atau pesan WA untuk serah bayar. Laporan payroll final tampil di HCIS untuk Kepala Keuangan dan Direktur sesuai permission.

   *Amandemen 2026-10-27:* akses Pengurus Yayasan **dikeluarkan dari v1**. ORG-003-F/ORG-010-F melarang Pengurus melihat agregat payroll dan PAYSLIP-001-F melarang slip perorangan; membuka akses itu adalah perubahan batas governance yang membutuhkan ADR tersendiri. Daftar transfer berisi nomor rekening dipisahkan dari laporan rekap (`docs/domain/payroll-calculation-v1.md` §7).
7. **Pengesahan dua tahap.** Kepala HCM mengajukan finalisasi; Direktur mengesahkan. Reopen periode final membutuhkan persetujuan Direktur.
8. **Kebijakan statutori berversi.** BPJS Kesehatan mengikuti peraturan (gaji pokok + tunjangan tetap, batas bawah UMK, batas atas Rp12.000.000); PPh21 ditanggung yayasan dan dilaporkan dari nominal yang benar-benar dibayar.
9. **Portabilitas ke sistem payroll lain.** Input periode, hasil, dan baris komponen memakai kode komponen stabil dan dapat diekspor, sehingga perhitungan dapat dipindahkan ke sistem lain tanpa kehilangan histori.

## Alternatives considered

- **Tetap impor slip dari spreadsheet (status quo).** Tidak ada risiko implementasi di HCIS, tetapi seluruh temuan audit (salah bayar, tanpa kunci periode, data tersebar) tetap ada. Ditolak owner 2026-10-23.
- **HCIS hanya menampung input, perhitungan tetap di luar.** Mengurangi pengetikan ulang, tetapi kebenaran nilai tetap bergantung pada spreadsheet dan dua sumber kebenaran harus disinkronkan. Ditolak owner 2026-10-23.
- **Langsung memakai sistem payroll pihak ketiga.** Belum ada sistem yang dipilih; aturan gaji YSQ (tabel pendidikan × MKG, kualifikasi khusus, jam mengajar) perlu didokumentasikan lebih dulu di mana pun perhitungan dijalankan. Tidak dipilih sekarang; keputusan 9 menjaga jalur ini tetap terbuka.
- **Microservice payroll terpisah.** Tidak ada kebutuhan skala; AGENTS.md §4 melarang microservice tanpa ADR. Ditolak.

## Consequences

- `AGENTS.md` §5, `docs/product/mvp.md` §7, dan `docs/product/feature-parity.yaml` (PAY-003) diperbarui bersama pengesahan ADR ini.
- Batas Foundation Board (PAYSLIP-001-F, ORG-003-F, ORG-010-F) tidak berubah: v1 tidak memberi Pengurus Yayasan permission payroll. Test otorisasi harus membuktikan penolakannya.
- Perubahan nilai dibanding spreadsheet yang disengaja (dasar BPJS, perbaikan lembur, pemisahan penyesuaian gaji, dasar PPh21) harus dijelaskan per pegawai saat parallel run.
- Auth, permission, audit, payroll, dan migration masuk kategori review tambahan (AGENTS.md §8). Setiap tahap implementasi memiliki spesifikasi implementasi dan migration rollback plan sendiri.
- Spreadsheet dibekukan hanya setelah parallel run minimal 2–3 periode lulus; sampai itu PAY-001/PAY-002 tetap jalur slip resmi.
- ADR ini tidak mengizinkan perubahan production. Rilis modul payroll ke Mi8VPS memerlukan gate kandidat, backup database sebelum migrasi, dan rollback bila verifikasi gagal (`docs/development/mi8vps-hcis-release.md`).
