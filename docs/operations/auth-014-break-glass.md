# AUTH-014 F1 — Prosedur break-glass HCIS

**Spec:** AUTH-014 §3.2 (`docs/domain/sq-core-administrator-layers.md`), ADR-0006 D-3.
**Status:** alat tersedia sejak F1. Runbook operasional of record tetap Google Doc "Mi8VPS Platform Runbook"; dokumen ini adalah salinan prosedur yang hidup bersama kodenya.

## Apa ini

Akun `SUPER_ADMIN` HCIS adalah jalan masuk cadangan ketika SQ Hub tidak dapat memberi peran. Sampai AUTH-014 ia tidak punya alat sama sekali: `bootstrap-super-admin` menolak bekerja begitu satu akun ada, dan `assertAccountManagementTarget` melarang `SUPER_ADMIN` menjadi target pengelolaan akun lewat API. Satu-satunya jalan adalah SQL tangan di host production — dan itulah yang membuat akun ini pernah tidak bisa dipakai sama sekali.

Dua perintah di bawah menggantikan SQL itu.

## Keadaan sekarang (30 Oktober 2026)

Akun break-glass **aktif dan dipakai sehari-hari**, karena SQ Hub belum bisa memberi peran. Itu bukan pelanggaran rencana, melainkan urutannya: §3 menetapkan `inactive` sebagai keadaan **normal** baru pada F7, bukan sekarang.

> **Jangan menonaktifkan akun ini sebelum F5a lulus.** Sampai SQ Hub benar-benar bisa memberi peran, menonaktifkannya berarti tidak ada seorang pun yang bisa memberi peran di HCIS.

## Perintah

Keduanya di `apps/api`, pratinjau sebagai perilaku default, dan hanya bekerja pada akun `SUPER_ADMIN`.

```bash
npm --prefix apps/api run auth:break-glass -- --help
```

### Menghidupkan atau menonaktifkan

```bash
HCIS_ALLOW_BREAK_GLASS=1 npm --prefix apps/api run auth:break-glass -- \
  --set-status inactive --reason "selesai latihan break-glass 2026-11-02"
```

Tanpa `--apply` tidak ada yang ditulis; keluarannya `would_change`. Tambahkan `--apply` setelah memeriksa akun dan alasannya. Menonaktifkan juga mencabut sesi yang sedang hidup.

### Memutar kredensial

```bash
HCIS_ALLOW_BREAK_GLASS=1 HCIS_BREAK_GLASS_PASSWORD='<kata sandi baru>' \
  npm --prefix apps/api run auth:break-glass -- \
  --rotate-credential --reason "rotasi setelah pemakaian 2026-11-02" --apply
```

Kata sandi, TOTP, dan recovery code diputar **bersama-sama**, dan sesi yang hidup dicabut. Memutar kata sandi saja akan meninggalkan faktor kedua yang sudah terpakai.

TOTP dan recovery code ditampilkan **sekali**. Jangan menempelkannya ke chat dan jangan men-commit-nya.

## Prosedur pemakaian

1. Catat alasannya. `--reason` wajib dan ikut tertulis di `auth_audit_events`, bukan hanya di runbook.
2. Aktifkan akun bila sedang nonaktif (`--set-status active --apply`).
3. Kerjakan pekerjaannya. Setiap pemberian peran lewat jalur ini tercatat sebagai `actor_source = "hcis_break_glass"` begitu F2 dan F3 terpasang.
4. Kembalikan ke `inactive` **setelah F5a lulus**; sebelum itu akun memang harus tetap aktif.
5. Putar kredensial setelah setiap pemakaian.

## Pengaman yang melekat pada alat

| Pengaman | Perilakunya |
|---|---|
| Flag lingkungan | `HCIS_ALLOW_BREAK_GLASS=1` harus dipasang dengan sengaja |
| Pratinjau dulu | tanpa `--apply` tidak ada tulisan ke database |
| Sasaran terbatas | hanya `principal_type = 'SUPER_ADMIN'`; principal lain ditolak `BREAK_GLASS_ACCOUNT_NOT_FOUND` |
| Tidak menebak | bila ada lebih dari satu akun `SUPER_ADMIN`, perintah menolak dan meminta `--account-id` |
| Alasan wajib | minimal 8 karakter, tersimpan di audit |
| Satu transaksi | `--apply` berjalan dalam satu transaksi; kegagalan apa pun membatalkan seluruhnya |
| Rahasia tidak masuk argumen | kata sandi dibaca dari `HCIS_BREAK_GLASS_PASSWORD`, tidak dari baris perintah, sehingga tidak masuk daftar proses atau riwayat shell |

## Memeriksa jejaknya

```sql
SELECT occurred_at, event_type, user_agent
FROM auth_audit_events
WHERE event_type LIKE 'auth.break_glass.%'
ORDER BY occurred_at DESC
LIMIT 20;
```

`user_agent` memuat alasan yang diketik operator. Itu kolom teks bebas satu-satunya pada tabel ini; pemakaiannya disengaja, karena alasan yang hanya ada di runbook adalah alasan yang tidak bisa ditemukan kembali.

## Kalau akun break-glass hilang sama sekali

Bila tidak ada baris `SUPER_ADMIN` sama sekali, perintah ini menolak dan `bootstrap-super-admin` adalah jalannya — ia memang hanya bekerja ketika belum ada akun. Setelah itu akun baru harus **ditautkan ke Akun SQ** dengan `auth:map-oidc-identity` dan **diuji login**, karena akun istimewa yang belum pernah diuji bukan jalan cadangan.
