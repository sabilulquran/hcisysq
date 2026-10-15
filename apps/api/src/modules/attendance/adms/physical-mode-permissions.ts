import type { AdminPermission } from "../../auth/permissions.js";

/**
 * Permissions for a typed physical operation, resolved from the raw request
 * body so authorization runs before body validation.
 *
 * Only an explicit `mode: "execute"` gets the execute permissions. A missing,
 * "canary" or invalid mode needs `attendance.devices.technical` as well, because
 * the body schemas default to canary and invalid input must not get a cheaper
 * path to a 400 response.
 */
export function physicalModePermissions(
  body: unknown,
  executePermissions: AdminPermission | readonly AdminPermission[],
): AdminPermission[] {
  const base: AdminPermission[] = typeof executePermissions === "string" ? [executePermissions] : [...executePermissions];
  const mode = body !== null && typeof body === "object" ? (body as { mode?: unknown }).mode : undefined;
  if (mode === "execute") return base;
  return [...new Set<AdminPermission>(["attendance.devices.technical", ...base])];
}
