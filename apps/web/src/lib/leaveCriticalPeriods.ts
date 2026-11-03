// LEAVE-009 client: HC manages critical periods (masa kritis) and decides the extra review they
// add to leave. Spec: docs/domain/leave-critical-periods.md. The API owns every rule.

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export interface CriticalPeriod {
  id: string;
  label: string;
  description: string | null;
  startOn: string;
  endOn: string;
  unitId: string | null;
  unitName: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A matched period as stored on a request or returned by a leave preview. */
export interface CriticalPeriodMatch {
  id: string;
  label: string;
  startOn: string;
  endOn: string;
  scope: "organization" | "unit";
  unitId: string | null;
  unitName: string | null;
}

export interface CriticalPeriodInput {
  label: string;
  description: string | null;
  startOn: string;
  endOn: string;
  unitId: string | null;
}

export interface CriticalReviewQueueItem {
  reviewId: string;
  requestId: string;
  requesterEmployeeId: string;
  requesterName: string;
  employeeNumber: string;
  unitName: string | null;
  positionName: string | null;
  policyKey: string;
  policyName: string;
  startOn: string;
  endOn: string;
  workingDays: number;
  reason: string | null;
  submittedAt: string;
  periods: CriticalPeriodMatch[];
}

export class CriticalPeriodApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CriticalPeriodApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
  throw new CriticalPeriodApiError(
    response.status,
    body?.code ?? "REQUEST_FAILED",
    body?.message ?? "Permintaan tidak dapat diproses.",
  );
}

function send(method: "POST" | "PATCH", path: string, body: unknown) {
  return fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string) {
  return fetch(`/api${path}`, { credentials: "include", headers: { Accept: "application/json" } });
}

export async function getCriticalPeriods(input: {
  page: number;
  pageSize: number;
  status: "active" | "inactive" | "all";
}): Promise<{ items: CriticalPeriod[]; pagination: Pagination; unitOptions: Array<{ id: string; name: string }> }> {
  const query = new URLSearchParams({
    page: String(input.page),
    pageSize: String(input.pageSize),
    status: input.status,
  });
  return readJson(await get(`/admin/leave/critical-periods?${query}`));
}

export async function createCriticalPeriod(input: CriticalPeriodInput): Promise<CriticalPeriod> {
  return readJson(await send("POST", "/admin/leave/critical-periods", input));
}

export async function updateCriticalPeriod(
  id: string,
  input: Partial<CriticalPeriodInput> & { isActive?: boolean },
): Promise<CriticalPeriod> {
  return readJson(await send("PATCH", `/admin/leave/critical-periods/${id}`, input));
}

export async function getCriticalReviewQueue(input: { page: number; pageSize: number }): Promise<{
  items: CriticalReviewQueueItem[];
  pagination: Pagination;
}> {
  const query = new URLSearchParams({ page: String(input.page), pageSize: String(input.pageSize) });
  return readJson(await get(`/leave/hc/critical-reviews?${query}`));
}

export async function decideCriticalReview(
  reviewId: string,
  input: { decision: "approve" | "reject"; note: string | null },
): Promise<{ requestStatus: "in_review" | "approved" | "rejected"; hcTaskStatus: "pending" | null }> {
  return readJson(await send("POST", `/leave/hc/critical-reviews/${reviewId}/decision`, input));
}

export function formatCriticalDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(new Date(`${value}T00:00:00+07:00`));
}

export function criticalPeriodRange(period: { startOn: string; endOn: string }) {
  return period.startOn === period.endOn
    ? formatCriticalDate(period.startOn)
    : `${formatCriticalDate(period.startOn)} – ${formatCriticalDate(period.endOn)}`;
}

/** Plain-language warning shown before a leave in a critical period is sent (D-01: never blocks). */
export function criticalPeriodWarning(periods: readonly Pick<CriticalPeriodMatch, "label">[]) {
  if (periods.length === 0) return null;
  const labels = periods.map((period) => period.label).join(", ");
  return `Tanggal ini masuk masa kritis ${labels}. Pengajuan tetap bisa dikirim; setelah atasan menyetujui, Human Capital akan meninjaunya.`;
}
