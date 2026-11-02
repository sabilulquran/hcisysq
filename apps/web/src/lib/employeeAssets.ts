// ASSET-001 client. Asset facts come from Aset SQ through the HCIS API; this module only
// shapes requests. Spec: docs/domain/employee-assets.md.

export interface AssetAssignment {
  assignmentId: string;
  assetTag: string;
  assetLabel: string;
  custodyState: "ACTIVE" | "PENDING_ACCEPTANCE";
  checkoutAt: string;
  expectedReturnOn: string | null;
  overdue: boolean;
}

export type AssetHoldings =
  | { status: "NOT_CONFIGURED" | "UNAVAILABLE"; selfServiceUrl: string }
  | {
    status: "AVAILABLE";
    generatedAt: string;
    clearance: "CLEAR" | "OUTSTANDING";
    counts: { outstanding: number; pendingAcceptance: number; overdue: number };
    assignments: AssetAssignment[];
    truncated: boolean;
    selfServiceUrl: string;
  };

async function get(path: string): Promise<AssetHoldings> {
  const response = await fetch(`/api${path}`, { credentials: "include", headers: { Accept: "application/json" } });
  const body = await response.json().catch(() => null) as AssetHoldings | { message?: string } | null;
  if (!response.ok) {
    throw new Error((body as { message?: string } | null)?.message ?? "Data aset tidak dapat dimuat.");
  }
  return body as AssetHoldings;
}

export function getMyAssets() {
  return get("/assets/me");
}

export function getEmployeeAssets(employeeId: string) {
  return get(`/admin/employees/${encodeURIComponent(employeeId)}/assets`);
}

/** Only http(s) links leave HCIS; anything else falls back to the Aset SQ home. */
export function safeAssetLink(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.toString();
  } catch {
    // fall through
  }
  return "https://aset.sabilulquran.or.id/my-assets";
}

export function formatAssetDate(value: string | null): string {
  if (!value) return "-";
  // A bare date is a calendar day; read it at noon so no time zone moves it.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00+07:00`) : new Date(value);
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeZone: "Asia/Jakarta" }).format(date);
}
