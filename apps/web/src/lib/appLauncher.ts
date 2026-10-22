import {
  Boxes,
  BriefcaseBusiness,
  GraduationCap,
  MessageCircle,
  PanelsTopLeft,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

// AUTH-013: the header launcher shows the same applications as SQ Hub. The list comes from the
// HCIS API (/api/auth/launcher), which asks SQ Hub server-to-server; the browser never calls SQ Hub.

export interface LauncherApplication {
  key: string;
  name: string;
  canonicalUrl: string;
}

export const CURRENT_APPLICATION: LauncherApplication = Object.freeze({
  key: "hcis",
  name: "HCIS",
  canonicalUrl: "/app",
});

export interface ApplicationAppearance {
  icon: LucideIcon;
  tile: string;
}

// Same key -> icon/category colour as SQ Hub apps/web/src/components/applicationAppearance.ts,
// the table in SQ Hub HUB-IMPL-022 §6 (docs/design/sq-core-design-system-c.md: one category per
// application). The cat-* tokens in styles.css carry the same hex values as SQ Hub. Keep in sync.
const appearanceByKey: Record<string, ApplicationAppearance> = {
  hcis: { icon: UsersRound, tile: "bg-cat-attendance-soft text-cat-attendance" },
  "aset-sq": { icon: Boxes, tile: "bg-cat-service-soft text-cat-service" },
  "karir-sq": { icon: BriefcaseBusiness, tile: "bg-cat-task-soft text-cat-task" },
  "spmb-sq": { icon: GraduationCap, tile: "bg-cat-leave-soft text-cat-leave" },
  "kirim-sq": { icon: MessageCircle, tile: "bg-cat-pay-soft text-cat-pay" },
};

const defaultAppearance: ApplicationAppearance = {
  icon: PanelsTopLeft,
  tile: "bg-brand-primary-pale text-brand-primary-deep",
};

export function applicationAppearance(key: string): ApplicationAppearance {
  return appearanceByKey[key] ?? defaultAppearance;
}

/**
 * Tiles to render. `null` (still loading, or SQ Hub unavailable) and an empty list both give the
 * current-app tile alone; HCIS is always present, linked in-app, even when SQ Hub left it out.
 */
export function launcherTiles(applications: LauncherApplication[] | null): LauncherApplication[] {
  const others = (applications ?? []).filter((application) => application.key !== CURRENT_APPLICATION.key);
  return [...others, CURRENT_APPLICATION].sort((left, right) => left.name.localeCompare(right.name, "id"));
}

function isLauncherApplication(value: unknown): value is LauncherApplication {
  if (!value || typeof value !== "object") return false;
  const { key, name, canonicalUrl } = value as Record<string, unknown>;
  if (typeof key !== "string" || typeof name !== "string" || typeof canonicalUrl !== "string") return false;
  try {
    return ["https:", "http:"].includes(new URL(canonicalUrl).protocol);
  } catch {
    return false;
  }
}

/** Resolves to null whenever the list cannot be shown; it never throws. */
export async function fetchLauncherApplications(): Promise<LauncherApplication[] | null> {
  try {
    const response = await fetch("/api/auth/launcher", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { applications?: unknown };
    if (!Array.isArray(body.applications)) return null;
    return body.applications.filter(isLauncherApplication);
  } catch {
    return null;
  }
}

// One read per page load and at most every 5 minutes, matching the API's per-session cache.
const CLIENT_CACHE_MS = 5 * 60_000;
let cached: { at: number; value: Promise<LauncherApplication[] | null> } | null = null;

export function loadLauncherApplications(now: number = Date.now()): Promise<LauncherApplication[] | null> {
  if (!cached || now - cached.at >= CLIENT_CACHE_MS) {
    const entry = { at: now, value: fetchLauncherApplications() };
    cached = entry;
    // An unavailable list is not kept: the next mount asks again (the API rate-limits SQ Hub reads).
    void entry.value.then((value) => {
      if (value === null && cached === entry) cached = null;
    });
  }
  return cached.value;
}

export function resetLauncherCacheForTests(): void {
  cached = null;
}
