// EMP-005 / EMP-006 read API client (docs/api/employment.openapi.yaml).
// Presentation labels only: every state, flag, and issue is derived by the API.

export type EmploymentRolloutMode = "OFF" | "SHADOW" | "AUTHORITATIVE";
export type EmploymentCategory =
  | "TETAP"
  | "KONTRAK"
  | "KONTRAK_HONORER"
  | "MAGANG"
  | "PERCOBAAN"
  | "LEPAS"
  | "BELUM_DIKLASIFIKASIKAN";
export type EmploymentState = "AKTIF" | "AKAN_MULAI" | "BERAKHIR" | "TANPA_DATA";

export interface Employment {
  id: string;
  employeeId: string;
  staffType: "PENDIDIK" | "KEPENDIDIKAN" | null;
  startedOn: string | null;
  startBasis: "RECORDED" | "UNKNOWN";
  serviceStartOn: string | null;
  endedOn: string | null;
  endBasis: "RECORDED" | "UNKNOWN" | null;
  endPrecision: "DAY" | "MONTH" | null;
  endReason: string | null;
  version: number;
}

export interface EmploymentTerm {
  id: string;
  employmentId: string;
  sequence: number;
  category: EmploymentCategory;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  contractReference: string | null;
}

export interface Placement {
  id: string;
  employmentId: string;
  kind: "PRIMARY" | "ADDITIONAL";
  unitName: string | null;
  positionName: string | null;
  jobTitleLabel: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  effectiveFromBasis: "RECORDED" | "BASELINE_ASSUMED";
}

export interface EmploymentSummary {
  mode: EmploymentRolloutMode;
  date: string;
  state: EmploymentState;
  flags: string[];
  current: {
    employment: Employment | null;
    term: EmploymentTerm | null;
    primaryPlacement: Placement | null;
    additionalPlacements: Placement[];
  };
  employments: Array<Employment & { terms: EmploymentTerm[]; placements: Placement[] }>;
}

export interface EmploymentTimelineItem {
  id: string;
  actionType: string;
  effectiveOn: string | null;
  state: "RECORDED" | "REVERSED";
  reversedByActionId: string | null;
  reasonCode: string | null;
  previousSnapshot: Record<string, unknown>;
  newSnapshot: Record<string, unknown>;
  recordedAt: string;
  documents: Array<{ id: string; kind: "PERJANJIAN_KERJA" | "SURAT_KEPUTUSAN"; number: string; type: string | null }>;
}

export interface EmploymentConsistencyReport {
  mode: EmploymentRolloutMode;
  date: string;
  employeeCount: number;
  groups: Array<{ code: string; count: number }>;
  total: number;
  page: number;
  pageSize: number;
  rows: Array<{
    employeeId: string;
    employeeNumber: string | null;
    fullName: string | null;
    codes: string[];
    differingFields: string[];
  }>;
}

export class EmploymentApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EmploymentApiError";
  }
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
  throw new EmploymentApiError(response.status, body?.code ?? "REQUEST_FAILED", body?.message ?? "Permintaan tidak dapat diproses.");
}

export function getEmployeeEmployment(employeeId: string): Promise<EmploymentSummary> {
  return getJson(`/api/admin/employees/${encodeURIComponent(employeeId)}/employment`);
}

export function getEmployeeEmploymentTimeline(employeeId: string): Promise<{ mode: EmploymentRolloutMode; items: EmploymentTimelineItem[] }> {
  return getJson(`/api/admin/employees/${encodeURIComponent(employeeId)}/employment/timeline`);
}

export function getEmploymentConsistency(input: { code?: string; page?: number } = {}): Promise<EmploymentConsistencyReport> {
  const params = new URLSearchParams({ page: String(input.page ?? 1), pageSize: "50" });
  if (input.code) params.set("code", input.code);
  return getJson(`/api/admin/employment/consistency?${params.toString()}`);
}

/** One view state for every employment screen (loading, OFF, forbidden, error, ready). */
export type EmploymentView<T> =
  | { kind: "loading" }
  | { kind: "disabled" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: T };

export function viewFromError(cause: unknown): EmploymentView<never> {
  if (cause instanceof EmploymentApiError) {
    if (cause.code === "EMPLOYMENT_HISTORY_DISABLED") return { kind: "disabled" };
    if (cause.status === 403) return { kind: "forbidden" };
    return { kind: "error", message: cause.message };
  }
  return { kind: "error", message: "Data kepegawaian tidak dapat dimuat. Periksa koneksi lalu coba lagi." };
}

export const CATEGORY_LABEL: Record<EmploymentCategory, string> = {
  TETAP: "Pegawai Tetap",
  KONTRAK: "Pegawai Kontrak",
  KONTRAK_HONORER: "Pegawai Kontrak Honorer",
  MAGANG: "Magang",
  PERCOBAAN: "Masa Percobaan",
  LEPAS: "Pegawai Lepas",
  BELUM_DIKLASIFIKASIKAN: "Belum dikelompokkan",
};

export const STATE_LABEL: Record<EmploymentState, string> = {
  AKTIF: "Aktif",
  AKAN_MULAI: "Akan mulai",
  BERAKHIR: "Berakhir",
  TANPA_DATA: "Belum ada data",
};

export const FLAG_LABEL: Record<string, string> = {
  KONTRAK_SEGERA_BERAKHIR: "Kontrak segera berakhir",
  KONTRAK_LEWAT_TANPA_TINDAK_LANJUT: "Kontrak sudah lewat dan belum ditindaklanjuti",
  TANPA_PENEMPATAN: "Belum ada penempatan utama",
  TANGGAL_MULAI_TIDAK_DIKETAHUI: "Tanggal mulai belum diketahui (data awal)",
  TANGGAL_AKHIR_TIDAK_DIKETAHUI: "Tanggal berakhir belum diketahui (data awal)",
};

export const ACTION_LABEL: Record<string, string> = {
  BASELINE: "Data awal",
  HIRE: "Mulai hubungan kerja",
  CONTRACT_EXTENSION: "Perpanjang kontrak",
  CATEGORY_CHANGE: "Ubah status kepegawaian",
  PLACEMENT: "Penempatan",
  TRANSFER: "Mutasi",
  PROMOTION: "Promosi",
  DEMOTION: "Demosi",
  TERMINATION: "Akhiri hubungan kerja",
  REVERSAL: "Batalkan tindakan",
};

export const END_REASON_LABEL: Record<string, string> = {
  RESIGN: "Resign",
  KONTRAK_BERAKHIR: "Kontrak berakhir",
  PENSIUN: "Pensiun",
  PEMBERHENTIAN: "Pemberhentian",
  MENINGGAL_DUNIA: "Meninggal dunia",
  LAINNYA: "Lainnya",
  LAINNYA_DARI_MASTER: "Tidak aktif (dari master)",
};

export const ISSUE_LABEL: Record<string, string> = {
  // EMP-006 S6: the history and ORG-004 disagree about who sits where.
  STRUCTURE_SEAT_WITHOUT_PLACEMENT: "Memegang jabatan di Struktur Organisasi, tanpa penempatan",
  PLACEMENT_WITHOUT_STRUCTURE_SEAT: "Ada penempatan, tanpa jabatan di Struktur Organisasi",
  BASELINE_NOT_LOADED: "Data awal belum dibuat",
  BASELINE_EXCLUDED_BUMY: "Staf BUMY (tidak dikelola)",
  BASELINE_EXCLUDED_FOUNDATION_BOARD: "Pengurus Yayasan (bukan pegawai)",
  BASELINE_NO_SOURCE_SNAPSHOT: "Belum ada data impor terbaru (impor ulang master)",
  BASELINE_START_UNKNOWN: "Tanggal mulai belum diketahui",
  BASELINE_END_UNKNOWN: "Tanggal keluar belum diketahui",
  BASELINE_END_PRECISION_ASSUMED: "Tanggal keluar hanya bulan (dianggap akhir bulan)",
  BASELINE_DATE_ORDER_INVALID: "Tanggal keluar sebelum tanggal mulai",
  BASELINE_STATUS_CONFLICT: "Status aktif bertentangan dengan tanggal keluar",
  BASELINE_CATEGORY_MISSING: "Status kepegawaian kosong",
  BASELINE_CATEGORY_UNMAPPED: "Status kepegawaian belum dikelompokkan",
  BASELINE_CATEGORY_IS_STATUS: "Kolom status kepegawaian berisi \"Tidak Aktif\"",
  BASELINE_CATEGORY_CONFLICT_PKWT: "Status kepegawaian bertentangan dengan Aktif PKWT",
  BASELINE_CONTRACT_END_UNKNOWN: "Masa kontrak belum diketahui",
  BASELINE_STAFF_TYPE_MISSING: "Jenis kepegawaian kosong/tidak valid",
  BASELINE_PLACEMENT_MISSING: "Tanpa unit",
  BASELINE_POSITION_MISSING: "Tanpa jabatan",
  BASELINE_REMOVED_EMPLOYEE: "Pegawai sudah dikeluarkan dari daftar",
  HISTORY_DIFFERS_FROM_MASTER: "Berbeda dengan master pegawai",
  ACTIVE_WITHOUT_PLACEMENT: "Aktif tanpa penempatan",
  CONTRACT_EXPIRED_WITHOUT_FOLLOW_UP: "Kontrak lewat tanpa tindak lanjut",
};

export const FIELD_LABEL: Record<string, string> = {
  status: "Status",
  startedOn: "TMT",
  organizationalUnitId: "Unit",
  positionId: "Jabatan",
  employmentStatus: "Status kepegawaian",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

/** "2027-07-01" → "1 Jul 2027"; calendar dates are never shifted by time zone. */
export function formatDate(value: string | null | undefined, fallback = "—"): string {
  if (!value) return fallback;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? match[2]} ${match[1]}`;
}

export function formatMonth(value: string | null | undefined): string {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})/.exec(value);
  return match ? `${MONTHS[Number(match[2]) - 1] ?? match[2]} ${match[1]}` : value;
}

/** Masa kerja for display only, from the service start to the summary date. */
export function serviceLength(from: string | null, to: string): string | null {
  if (!from) return null;
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  let months = (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
  if (months < 0) return null;
  const years = Math.floor(months / 12);
  months -= years * 12;
  if (years === 0 && months === 0) return "kurang dari 1 bulan";
  return [years ? `${years} tahun` : null, months ? `${months} bulan` : null].filter(Boolean).join(" ");
}
