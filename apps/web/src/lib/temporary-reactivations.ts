// EMP-005 S5A client (docs/api/employment.openapi.yaml 0.5.0). The API decides
// who may grant, how long a grant may last, and what it opens.

import { EmploymentApiError } from "@/lib/employment";

export const MAX_REACTIVATION_DAYS = 30;

export interface TemporaryReactivation {
  id: string;
  accountId: string;
  reason: string;
  startsAt: string;
  expiresAt: string;
  grantedByAccountId: string | null;
  revokedAt: string | null;
  revokedByAccountId: string | null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    ...init,
  });
  if (response.ok) return (await response.json()) as T;
  const failure = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
  throw new EmploymentApiError(
    response.status,
    failure?.code ?? "REQUEST_FAILED",
    failure?.message ?? "Permintaan tidak dapat diproses.",
  );
}

export function listTemporaryReactivations(accountId: string): Promise<{ items: TemporaryReactivation[] }> {
  return request(`/api/admin/access/accounts/${encodeURIComponent(accountId)}/temporary-reactivations`);
}

export function grantTemporaryReactivation(
  accountId: string,
  body: { reason: string; expiresAt: string },
): Promise<{ id: string; accountId: string; expiresAt: string }> {
  return request(`/api/admin/access/accounts/${encodeURIComponent(accountId)}/temporary-reactivations`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function revokeTemporaryReactivation(accountId: string, grantId: string): Promise<{ id: string; revoked: boolean }> {
  return request(
    `/api/admin/access/accounts/${encodeURIComponent(accountId)}/temporary-reactivations/${encodeURIComponent(grantId)}/revoke`,
    { method: "POST" },
  );
}
