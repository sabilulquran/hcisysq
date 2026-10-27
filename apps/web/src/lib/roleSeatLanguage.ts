// ORG-008-9: sentences for the Kepala HC role/seat comparison on the Akses screen.

import type { RoleSeatCheck, RoleSeatMismatch } from "@/lib/adminOrgAccess";

const ROLE_LABELS: Record<string, string> = { human_capital_lead: "Kepala HC" };

export function roleSeatLabel(roleKey: string) {
  return ROLE_LABELS[roleKey] ?? roleKey;
}

/** The seat as an operator names it: title and the unit it sits in. */
export function roleSeatName(check: RoleSeatCheck): string | null {
  if (!check.seat?.title) return null;
  return check.seat.unitName ? `${check.seat.title} (${check.seat.unitName})` : check.seat.title;
}

/** Why the comparison could not run, or null when it did. */
export function roleSeatStatusSentence(check: RoleSeatCheck): string | null {
  const role = roleSeatLabel(check.roleKey);
  switch (check.status) {
    case "SEAT_NOT_SET":
      return `Jabatan acuan ${role} belum ditetapkan, jadi pemegang peran ${role} belum bisa dibandingkan dengan struktur.`;
    case "NO_PUBLISHED_STRUCTURE":
      return "Belum ada struktur organisasi yang diterbitkan untuk hari ini, jadi pemegang jabatan belum bisa diperiksa.";
    case "SEAT_NOT_IN_STRUCTURE":
      return "Jabatan acuan tidak ada atau tidak aktif di struktur yang berlaku hari ini. Tetapkan ulang jabatan acuannya.";
    case "SEAT_VACANT":
      return `Jabatan ${roleSeatName(check) ?? "acuan"} sedang kosong di struktur yang berlaku hari ini.`;
    default:
      return null;
  }
}

export function roleSeatMismatchSentence(check: RoleSeatCheck, mismatch: RoleSeatMismatch): string {
  const role = roleSeatLabel(check.roleKey);
  const seat = roleSeatName(check) ?? `jabatan ${role}`;
  if (mismatch.kind === "HOLDER_NOT_SEATED") {
    return `${mismatch.name} memegang peran ${role}, tetapi bukan pemegang ${seat} di struktur yang berlaku.`;
  }
  const holder = mismatch.incumbentKind === "ACTING" ? `Plt ${seat}` : `pemegang ${seat}`;
  if (mismatch.reason === "NO_ACCOUNT") return `${mismatch.name} adalah ${holder}, tetapi belum punya akun HCIS.`;
  if (mismatch.reason === "ACCOUNT_NOT_ACTIVE") return `${mismatch.name} adalah ${holder}, tetapi akun HCIS-nya belum aktif.`;
  return `${mismatch.name} adalah ${holder}, tetapi belum memegang peran ${role}.`;
}
