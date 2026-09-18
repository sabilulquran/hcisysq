# Dokumentasi HCIS YSQ

Dokumentasi ini adalah spesifikasi kerja, bukan arsip pasif. Perubahan perilaku harus mengubah dokumen dan test yang terkait.

## Urutan membaca

Untuk pekerjaan setelah MVP freeze, mulai dari checkpoint agar tidak mengulang audit yang sudah selesai:

1. `product/mvp-release-checkpoint.md`
2. `product/mvp.md`
3. `product/scope.md`
4. `product/feature-parity.yaml`
5. `product/vision.md`
6. `domain/glossary.md`
7. `domain/access-model.md`
8. `domain/roles-permissions.md`
9. specification/workflow modul yang akan dikerjakan, termasuk `domain/employee-import.md` untuk EMP-004
   - untuk Organization Directory publishing, baca `domain/organization-directory-publishing.md` (ORG-006) setelah ORG-002/ORG-004.
10. `architecture/system-context.md`
11. ADR yang relevan
12. `api/openapi.yaml`
13. security dan testing guidance

`product/mvp-release-checkpoint.md` adalah durable evidence anchor untuk MVP yang diverifikasi pada 2026-08-22. Jangan menganggap docs-only commit setelah verified application SHA sebagai aplikasi baru yang sudah diuji/deploy. Jika runtime code berubah setelah checkpoint, lakukan targeted verification untuk area yang terdampak dan buat checkpoint baru bila perlu.

Untuk frontend, baca juga:

- `design/brand-guideline.md`
- `design/ui-guidelines.md`
- `design/ui-foundation.md`
- `domain/attendance-device-admin-information-architecture.md` untuk information architecture Admin Mesin Fingerprint (ATT-006)
- `domain/attendance-device-admin-verification.md` untuk bukti implementasi/deployment ATT-006 dan physical safe-name canary yang sudah terverifikasi

Untuk ATT-005 fingerprint/WDMS, baca juga:

- `domain/attendance-wdms-implementation-plan.md` untuk delivery wave ATT-005;
- `domain/attendance-wdms-package1-non-biometric-completion.md` untuk non-biometric operations package;
- `domain/attendance-wdms-package2-biometric-control-plane.md` untuk encrypted-vault readiness, lifecycle review, key rotation procedure, dan fixed biometric hardware boundary;
- `domain/attendance-wdms-package3-operations-closure.md` untuk Work Code/message planning, export, offline ATTLOG import, saved filters, safe queue maintenance, capability matrix, dan final Package 3 closure semantics;
- `api/attendance-adms-biometric-control-plane.openapi.yaml` untuk kontrak API metadata-only Package 2;
- `api/attendance-adms-wave3.openapi.yaml` untuk kontrak API operasi Package 3 yang tetap fail-closed terhadap hardware yang belum terverifikasi.

## Deployment dan repository operations

- `development/vps-deployment.md` — active production runbook untuk exact-SHA GHCR cutover + verification; release image tidak dibangun sebagai langkah normal di VPS.
- `development/github-org-transfer-readiness.md` — readiness dan post-transfer checklist untuk canonical target `sabilulquran/hcisysq`, termasuk PUBLIC visibility invariant, GHCR ownership boundary, deployment freeze, GitHub App/Actions verification, dan exact-SHA organization package proof.
- `development/vps-dev-deployment.md` — superseded early VPS bootstrap guide; jangan gunakan build-on-VPS atau feature-branch deployment dari dokumen lama sebagai release procedure.

## Status dokumen

- `DRAFT` — isi awal, belum disetujui.
- `DISCOVERY` — sedang diekstrak dan dibandingkan dengan implementasi sebelumnya.
- `PROPOSED` — keputusan diajukan, belum menjadi aturan wajib.
- `ACCEPTED` — menjadi acuan implementasi.
- `ACTIVE` — foundation/direction yang sedang berlaku.
- `VERIFIED` — implementation/operational evidence untuk scope dokumen sudah dicatat tanpa menyatakan scope induk lain selesai.
- `VERIFIED MVP BASELINE` — perilaku/slice MVP sudah memiliki implementation + verification evidence yang dirujuk checkpoint; bukan pernyataan Pilot/Production Ready.
- `VERIFIED COMPLETE` — completion criteria dokumen tersebut sudah dipenuhi pada checkpoint yang disebutkan.
- `SUPERSEDED` — digantikan dokumen/ADR lain.

## Konvensi specification ID

```text
AUTH-###
EMP-###
ORG-###
ATT-###
LEAVE-###
APR-###
PAY-###
LOAN-###
PERF-###
TRAIN-###
DOC-###
REIMB-###
NOTIF-###
MIG-###
SEC-###
```

ID tidak boleh digunakan ulang untuk perilaku berbeda.

## Definition of ready

Sebuah item siap diimplementasikan ketika minimal memiliki:

- actor;
- tujuan pengguna;
- precondition;
- input dan validasi;
- happy path;
- failure/forbidden behavior;
- permission;
- audit event;
- notification behavior bila ada;
- acceptance criteria;
- dependency dan migration impact.

## Pemeliharaan

Dokumentasi tidak boleh dibiarkan tertinggal dari implementasi. Pull request yang mengubah perilaku tanpa memperbarui spesifikasi dianggap belum selesai.

Setelah MVP freeze, perubahan post-MVP tidak boleh diam-diam mengubah frozen domain boundary. Jika requirement baru bertentangan dengan checkpoint/specification yang sudah verified, ubah specification secara eksplisit dan catat migration/authorization/regression impact-nya.
