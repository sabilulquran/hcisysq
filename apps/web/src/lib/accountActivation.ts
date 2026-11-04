import type { InvitationEmailStatus, InvitationHubAccess, InvitationWhatsAppStatus } from "@/lib/adminOrgAccess";
import type { PrincipalType } from "@/types/hcis";

export class AccountActivationApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AccountActivationApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => null)) as
    | { code?: string; message?: string }
    | null;
  throw new AccountActivationApiError(
    response.status,
    body?.code ?? "ACCOUNT_ACTIVATION_REQUEST_FAILED",
    body?.message ?? "Permintaan aktivasi account tidak dapat diproses.",
  );
}

export async function prepareBoardAccount(email: string): Promise<{
  id: string;
  email: string;
  principalType: "FOUNDATION_BOARD";
  status: "invited";
}> {
  const response = await fetch("/api/admin/access/board-accounts", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email }),
  });
  return readJson(response);
}

export async function issueAccountActivation(accountId: string): Promise<{
  activationPath: string;
  expiresAt: string;
}> {
  const response = await fetch(`/api/admin/access/accounts/${accountId}/activation`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson(response);
}

export interface ActivationInvitationResult {
  invitationId: string;
  emailStatus: InvitationEmailStatus;
  whatsappStatus: Exclude<InvitationWhatsAppStatus, "pending">;
  hubAccess: InvitationHubAccess;
  maskedEmail: string;
  maskedPhone: string | null;
  emailLinkHours: number;
}

/** AUTH-002-INVITE: SQ Hub prepares the Akun SQ, Keycloak e-mails the link, HCIS sends WhatsApp. */
export async function sendActivationInvitation(accountId: string): Promise<ActivationInvitationResult> {
  const response = await fetch(`/api/admin/access/accounts/${accountId}/activation-invitation`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson(response);
}

export async function getActivationPreview(token: string): Promise<{
  maskedEmail: string;
  principalType: Exclude<PrincipalType, "SUPER_ADMIN">;
  expiresAt: string;
}> {
  const response = await fetch("/api/auth/activation/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ token }),
  });
  return readJson(response);
}

export async function activateAccount(
  token: string,
  password: string,
): Promise<{
  status: "active";
  principalType: Exclude<PrincipalType, "SUPER_ADMIN">;
  message: string;
}> {
  const response = await fetch("/api/auth/activation/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ token, password }),
  });
  return readJson(response);
}
