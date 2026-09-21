export interface InAppNotification {
  id: string;
  category: "attendance" | "payslip" | "system";
  title: string;
  body: string;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { message?: string } | null;
  if (!response.ok) {
    throw new Error((body as { message?: string } | null)?.message ?? "Notifikasi tidak dapat diproses.");
  }
  return body as T;
}

export async function getMyNotifications(state: "all" | "unread" = "all", limit = 50) {
  return readJson<{ unreadCount: number; items: InAppNotification[] }>(
    await fetch(`/api/notifications/me?state=${state}&limit=${limit}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function markNotificationRead(notificationId: string) {
  return readJson<{ id: string; readAt: string }>(
    await fetch(`/api/notifications/${notificationId}/read`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function markAllNotificationsRead() {
  return readJson<{ updated: number }>(
    await fetch("/api/notifications/read-all", {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    }),
  );
}
