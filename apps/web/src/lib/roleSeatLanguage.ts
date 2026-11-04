// AUTH-015: sentences for "peran mengikuti jabatan" on the Akses screen.

import type { RoleSeat, RoleSeatCheck, RoleSeatMismatch, SeatNotEffectiveReason } from "@/lib/adminOrgAccess";

/** The seat as an operator names it: title and the unit it sits in. */
export function roleSeatName(seat: Pick<RoleSeat, "title" | "unitName">): string | null {
  if (!seat.title) return null;
  return seat.unitName ? `${seat.title} (${seat.unitName})` : seat.title;
}

/** Why a linked seat confers the role on nobody right now, or null when someone holds it. */
export function roleSeatStatusSentence(seat: RoleSeat): string | null {
  switch (seat.status) {
    case "NO_PUBLISHED_STRUCTURE":
      return "Belum ada struktur organisasi yang diterbitkan untuk hari ini, jadi peran ini belum dipegang siapa pun lewat jabatan.";
    case "SEAT_NOT_IN_STRUCTURE":
      return "Jabatan ini tidak ada atau tidak aktif di struktur yang berlaku hari ini, jadi tidak memberi peran kepada siapa pun.";
    case "SEAT_VACANT":
      return "Jabatan ini sedang kosong, jadi peran ini tidak dipegang siapa pun lewat jabatan ini.";
    default:
      return null;
  }
}

const NOT_EFFECTIVE: Record<SeatNotEffectiveReason, string> = {
  NO_ACCOUNT: "belum punya akun HCIS",
  ACCOUNT_NOT_ACTIVE: "akun HCIS-nya belum aktif",
  EMPLOYEE_NOT_ACTIVE: "status kepegawaiannya tidak aktif",
};

export function notEffectiveSentence(reason: SeatNotEffectiveReason): string {
  return NOT_EFFECTIVE[reason];
}

export function roleSeatMismatchSentence(check: RoleSeatCheck, mismatch: RoleSeatMismatch): string {
  if (mismatch.kind === "DIRECT_HOLDER_NOT_SEATED") {
    return `${mismatch.name} memegang peran ${check.roleName} lewat pemberian langsung, bukan lewat jabatan; peran itu tidak akan pindah otomatis bila jabatannya berganti pemegang.`;
  }
  const seat = check.seats.find((item) => item.positionKey === mismatch.positionKey);
  const seatName = (seat && roleSeatName(seat)) ?? "jabatan ini";
  const holder = mismatch.incumbentKind === "ACTING" ? `Plt ${seatName}` : `pemegang ${seatName}`;
  return `${mismatch.name} adalah ${holder}, tetapi peran ${check.roleName} belum berlaku karena ${NOT_EFFECTIVE[mismatch.reason]}.`;
}
