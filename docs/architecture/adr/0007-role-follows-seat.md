# ADR-0007: Peran administratif mengikuti jabatan, bukan orang (AUTH-015)

- **Status:** ACCEPTED
- **Date:** 2026-11-04
- **Decider:** Owner Yayasan Sabilul Qur'an
- **Related:** AUTH-010, AUTH-011, AUTH-014 (ADR-0006), ORG-004, ORG-008-9, ORG-008-10, PAY-003, LOAN-001
- **Supersedes:** klausul AUTH-011 / ORG-008-9 "jabatan tidak pernah memberi izin administrasi" (`docs/domain/hcis-authorization-modernization.md`, `docs/domain/organization-designer-ux-spec.md` baris ORG-008-9, komentar migration 0066)
- **Spec:** `docs/domain/role-follows-seat.md`

## Context

Peran administratif HCIS (misalnya `finance_officer`, `human_capital_lead`, `director`) diberikan ke **akun orang** lewat `account_role_assignments`. Sejak AUTH-014, pemberian itu lewat kanal SQ Hub (Admin Platform) atau break-glass. Struktur organisasi yang diterbitkan (ORG-004) sudah mencatat siapa memegang jabatan apa, dengan tanggal berlaku dan Plt.

Akibatnya peran dan jabatan bisa berpisah. Bila pemegang jabatan resign atau diganti, peran tetap menempel pada orang lama sampai seseorang mencabutnya, dan penggantinya tidak memegang apa pun sampai seseorang memberinya. ORG-008-9 (2026-10-27) hanya menambah peringatan, karena AUTH-011 saat itu melarang jabatan memberi izin administrasi.

Keputusan owner 2026-11-04 (chat, verbatim):

> "jangan bound ke orang, tapi ke struktur organisasi biar kalau resign itu otomatis ke penggantinya"
>
> "kalau tugasnya itu lebih ke staf, yaitu panji. tapi pastikan tidak bisa lihat gaji utuh"

## Decision

1. **Peran dapat ditautkan ke satu atau lebih jabatan** (position stable key) di struktur yang diterbitkan. Satu jabatan dapat membawa beberapa peran. Tabel: `access_role_position_links` (dipakai ulang dari ORG-008-9, kunci menjadi `(role_key, position_key)`).
2. **Izin efektif = pemberian langsung ∪ peran dari jabatan yang sedang dipegang.** Jabatan dihitung dari change set `PUBLISHED` terakhir yang berlaku pada tanggal itu (urutan sama dengan `loadEffectiveSnapshot`), incumbency `PRIMARY` atau `ACTING` yang berlaku pada tanggal itu, posisi aktif dan berlaku, `holder_source = 'EMPLOYEE'`.
3. **Dievaluasi setiap permintaan**, di database (`hcis_seat_permissions`, migration 0139). Begitu struktur baru berlaku, peran pindah ke pemegang baru tanpa langkah tambahan dan tanpa salinan yang bisa basi. Tidak ada baris `account_role_assignments` yang dibuat atau dicabut.
4. Peran dari jabatan selalu ber-scope **organisasi**.

### Guardrail

| ID | Aturan | Ditegakkan di |
|---|---|---|
| G-1 | Permission `access.*` (termasuk `IDENTITY_PERMISSIONS`, `access.manage`, `access.accounts.temporary_reactivate`) **tidak pernah** mengalir dari jabatan, meskipun tautannya ada di tabel. | `hcis_seat_permissions` (filter `NOT LIKE 'access.%'`), dan penolakan tautan |
| G-2 | Hanya peran yang lolos `isSeatLinkableRole` yang boleh ditautkan: boleh diberikan menurut `canDelegateRole`, tanpa permission `access.*`, bekerja di scope organisasi, bukan peran governance Organ Yayasan. Ditolak `400 ROLE_NOT_SEAT_LINKABLE`. | `role-assignment.ts`, route tautan |
| G-3 | Menautkan atau melepas tautan **adalah pemberian peran** kepada siapa pun yang duduk di jabatan itu, sekarang dan nanti. Penjaganya sama dengan pemberian peran: break-glass Super Admin di HCIS (`authenticateRoleGrantor`); jalur Admin Platform lewat kanal SQ Hub belum dibuat (`TBD`). Alasan wajib, setiap perubahan ditulis ke `access_audit_events` (`role.seat_link.set` / `role.seat_link.cleared`, `actor_source = 'hcis_break_glass'`). | `admin-org-access-routes.ts` |
| G-4 | Penjaga akun tetap berlaku: akun `EMPLOYEE` berstatus `active`, pegawai `active` dan tidak dihapus. Akun `invited` (belum aktivasi) **tidak** memegang peran dari jabatan sampai aktif. | `hcis_seat_permissions` |
| G-5 | Penerbit struktur tidak boleh mendudukkan dirinya sendiri di jabatan bertaut peran: bila change set memberi pegawai milik penerbit incumbency baru (jabatan, jenis, atau tanggal yang belum pernah terbit) pada jabatan bertaut, publikasi ditolak `403 ORGANIZATION_PUBLISH_SELF_ROLE_SEAT` dan harus diterbitkan pemegang izin terbit lain. Ini melengkapi empat mata ORG-008-10. | `publisherGainsLinkedSeat`, route publish |
| G-6 | Jabatan yang dipegang **akun** (holder_source `ACCOUNT`, misalnya Organ Yayasan) tidak pernah memberi peran (AUTH-010 "account-held position is not access" tetap berlaku). | `hcis_seat_role_holders` |

Audit saat peran dari jabatan "mulai" atau "berhenti" berlaku tidak ditulis terpisah: evaluasinya hidup, dan peristiwa yang menyebabkannya sudah teraudit (publikasi struktur `organization.draft.published`, perubahan tautan `role.seat_link.*`, perubahan status akun).

### Yang tidak berubah

- Pemberian langsung tetap ada dan tetap dihitung. Layar Akses memisahkan "pemberian langsung" dari "dari jabatan" dan menandai pemberian langsung yang tidak mengikuti jabatan mana pun.
- Larangan self-grant, allowlist peran, mandat, dan atomisitas audit AUTH-014 tidak berubah.
- Free-text job title dan level organisasi tetap tidak pernah memberi izin (AUTH-010-K). Yang memberi izin hanya tautan eksplisit yang dibuat pemberi peran, pada jabatan yang dipilih dari struktur terbit (stable key), bukan dari nama.

## Consequences

- Menerbitkan struktur kini dapat **memindahkan peran**. Penerbit (pemegang `approvals.policy.manage`) mendapat kuasa tidak langsung atas siapa memegang peran bertaut. G-5 mencegah penerbit memberi dirinya sendiri; empat mata ORG-008-10 mencegah penyusun menerbitkan sendiri. Menampilkan dampak peran pada layar dampak publikasi adalah `TBD`.
- AUTH-014 §4.2 pernah merencanakan `organization.role_seat_links.manage` untuk Admin Modul dengan alasan "tautan tidak memberi peran". Alasan itu gugur: tautan kini memberi peran, sehingga rencana itu **dibatalkan**; tautan tetap di tangan pemberi peran (G-3).
- Rantai PAY-003 "tidak ada satu akun yang membawa periode dari input sampai pengesahan" tetap ditegakkan di transisi (`forbidsSubmitter`). Bila satu orang memegang dua jabatan bertaut (rangkap), ia memegang kedua peran; pemisahan tugas pada transisi tetap berlaku.

## Rollback

Hapus tautan lewat `DELETE /admin/access/role-seat-links/:roleKey/:positionKey` (teraudit): peran dari jabatan hilang pada permintaan berikutnya. Rollback skema ada di komentar migration 0139.
