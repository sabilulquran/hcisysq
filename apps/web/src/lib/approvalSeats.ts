// LOAN-002 / APR-002: client for Pengaturan > Kursi persetujuan.
//
// The five seats of the kasbon chain are mapped by Human Capital to ORG-004 position stable keys.
// Nothing here ever sends a job title: the position is chosen from the published structure by its
// stable key, and the stored label is derived server side (employee-loans.md §16.2).

import { AdminApiError } from "@/lib/adminEmployees";

export const APPROVAL_SEAT_KEYS = [
  "KEPALA_KEUANGAN",
  "DIREKTUR",
  "KETUA_YAYASAN",
  "BENDAHARA_YAYASAN",
  "PEMBINA",
] as const;
export type ApprovalSeatKey = (typeof APPROVAL_SEAT_KEYS)[number];

export const APPROVAL_SEAT_LABELS: Readonly<Record<ApprovalSeatKey, string>> = {
  KEPALA_KEUANGAN: "Kepala Keuangan",
  DIREKTUR: "Direktur",
  KETUA_YAYASAN: "Ketua Yayasan",
  BENDAHARA_YAYASAN: "Bendahara Yayasan",
  PEMBINA: "Pembina",
};

/** The owner's order, and the rung each seat occupies in the chain (§16.1). */
export const APPROVAL_SEAT_ORDER: Readonly<Record<ApprovalSeatKey, string>> = {
  KEPALA_KEUANGAN: "Langkah 2",
  DIREKTUR: "Langkah 3",
  KETUA_YAYASAN: "Langkah 4",
  BENDAHARA_YAYASAN: "Langkah 5",
  PEMBINA: "Langkah 6, hanya di atas ambang",
};

export type ApprovalSeatState =
  | "READY"
  | "UNMAPPED"
  | "POSITION_NOT_IN_FORCE"
  | "VACANT"
  | "SEAT_HELD_BY_REQUESTER";

export interface ApprovalSeatRow {
  seatKey: ApprovalSeatKey;
  state: ApprovalSeatState;
  positionKey: string | null;
  seatLabel: string | null;
  positionTitle: string | null;
  unitName: string | null;
  holderSource: "EMPLOYEE" | "ACCOUNT" | null;
}

export interface ApprovalSeatMappingHistory {
  id: string;
  seatKey: ApprovalSeatKey;
  positionKey: string;
  seatLabel: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  endedAt: string | null;
  endReason: string | null;
  createdByName: string | null;
  endedByName: string | null;
}

export interface ApprovalSeatReadiness {
  asOf: string;
  structurePublished: boolean;
  ready: boolean;
  /** Seats that have never been mapped at all — production's opening state for all five. */
  neverMapped: ApprovalSeatKey[];
  items: ApprovalSeatRow[];
  history: ApprovalSeatMappingHistory[];
}

export interface ApprovalSeatTarget {
  key: string;
  label: string;
  detail: string;
  holderSource: "EMPLOYEE" | "ACCOUNT";
}

export interface ApprovalSeatTargets {
  asOf: string;
  structurePublished: boolean;
  items: ApprovalSeatTarget[];
}

/** What the state means, and what Human Capital has to do about it. */
export const APPROVAL_SEAT_STATE_LABELS: Readonly<Record<ApprovalSeatState, string>> = {
  READY: "Siap",
  UNMAPPED: "Belum pernah dipetakan",
  POSITION_NOT_IN_FORCE: "Jabatannya tidak berlaku lagi",
  VACANT: "Jabatannya kosong",
  SEAT_HELD_BY_REQUESTER: "Diduduki pemohon",
};

export const APPROVAL_SEAT_STATE_HINTS: Readonly<Record<ApprovalSeatState, string>> = {
  READY: "Kursi ini tidak menghalangi apa pun.",
  UNMAPPED: "Petakan kursi ini ke jabatan di struktur yang berlaku. Selama belum, tidak ada kasbon yang dapat diajukan.",
  POSITION_NOT_IN_FORCE: "Jabatan yang dipetakan sudah tidak ada di struktur yang berlaku. Akhiri pemetaan ini lalu petakan ke jabatan yang benar.",
  VACANT: "Jabatannya ada tetapi belum ada yang menduduki. Isi jabatannya di Struktur Organisasi, atau tunjuk pelaksana tugas.",
  SEAT_HELD_BY_REQUESTER: "Pegawai yang ditanyakan menduduki kursi ini, sehingga kasbonnya sendiri tidak dapat melewati rantai ini.",
};

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
  throw new AdminApiError(
    response.status,
    body?.code ?? "REQUEST_FAILED",
    body?.message ?? "Permintaan kursi persetujuan tidak dapat diproses.",
  );
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, value);
  }
  const suffix = search.toString();
  return suffix ? `?${suffix}` : "";
}

export async function getApprovalSeats(input: { asOf?: string; employeeId?: string } = {}): Promise<ApprovalSeatReadiness> {
  const response = await fetch(
    `/api/admin/organization/approval-seats${query({ asOf: input.asOf, employeeId: input.employeeId })}`,
    { credentials: "include", headers: { Accept: "application/json" } },
  );
  return readJson<ApprovalSeatReadiness>(response);
}

export async function searchApprovalSeatTargets(input: { q?: string; asOf?: string } = {}): Promise<ApprovalSeatTargets> {
  const response = await fetch(
    `/api/admin/organization/approval-seats/targets${query({ q: input.q, asOf: input.asOf })}`,
    { credentials: "include", headers: { Accept: "application/json" } },
  );
  return readJson<ApprovalSeatTargets>(response);
}

export interface ApprovalSeatMapped {
  id: string;
  seatKey: ApprovalSeatKey;
  positionKey: string;
  seatLabel: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  readiness: ApprovalSeatReadiness;
}

/** No `seatLabel` here on purpose: the server derives it, and refuses a body that carries one. */
export async function mapApprovalSeat(input: {
  seatKey: ApprovalSeatKey;
  positionKey: string;
  effectiveFrom: string;
}): Promise<ApprovalSeatMapped> {
  const response = await fetch("/api/admin/organization/approval-seats", {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return readJson<ApprovalSeatMapped>(response);
}

export interface ApprovalSeatEnded {
  id: string;
  seatKey: ApprovalSeatKey | null;
  effectiveTo: string;
  readiness: ApprovalSeatReadiness;
  /** D-18: true when ending this mapping stops every employee loan until the seat is mapped again. */
  stopsEmployeeLoans: boolean;
}

export async function endApprovalSeatMapping(input: {
  id: string;
  reason: string;
  lastDay?: string;
}): Promise<ApprovalSeatEnded> {
  const response = await fetch(`/api/admin/organization/approval-seats/${input.id}/end`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ reason: input.reason, ...(input.lastDay ? { lastDay: input.lastDay } : {}) }),
  });
  return readJson<ApprovalSeatEnded>(response);
}

/**
 * The one sentence the screen leads with. Production starts with all five seats unmapped, which is
 * the state most likely to confuse, so it is named rather than left to be counted off a table.
 */
export function approvalSeatSummary(readiness: ApprovalSeatReadiness): string {
  if (!readiness.structurePublished) {
    return "Belum ada struktur organisasi yang berlaku, sehingga kursi persetujuan belum dapat dipetakan.";
  }
  if (readiness.ready) return "Kelima kursi siap. Rantai persetujuan kasbon dapat berjalan.";
  if (readiness.neverMapped.length === APPROVAL_SEAT_KEYS.length) {
    return "Kelima kursi belum pernah dipetakan. Selama itu, tidak ada kasbon yang dapat diajukan siapa pun.";
  }
  const blocking = readiness.items.filter((item) => item.state !== "READY");
  const names = blocking.map((item) => APPROVAL_SEAT_LABELS[item.seatKey]).join(", ");
  return `${blocking.length} kursi belum siap (${names}). Selama itu, tidak ada kasbon yang dapat diajukan siapa pun.`;
}
