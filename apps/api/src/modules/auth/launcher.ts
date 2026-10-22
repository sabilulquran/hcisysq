import type { LauncherApplication } from "./application-access.js";

// AUTH-013 (docs/domain/auth-session-experience.md): the header launcher lists the same SQ Hub
// applications as SQ Hub itself. The browser never calls SQ Hub; HCIS reads the list
// server-to-server with its existing machine client and keeps it per session for 5 minutes.

export const LAUNCHER_CACHE_TTL_MS = 5 * 60_000;
/** A failed read is retried sooner than a successful one, but not on every page load. */
export const LAUNCHER_FAILURE_TTL_MS = 30_000;
const LAUNCHER_CACHE_MAX_ENTRIES = 2_000;

export type LauncherResult =
  | { applications: LauncherApplication[] }
  | { applications: null; unavailable: true };

export const LAUNCHER_UNAVAILABLE: LauncherResult = Object.freeze({ applications: null, unavailable: true as const });

export interface LauncherIdentity {
  issuer: string;
  subject: string;
}

export interface LauncherSource {
  listLauncherApplications(identity: LauncherIdentity): Promise<LauncherApplication[]>;
}

/**
 * The launcher endpoint sits next to the access check on SQ Hub, so its URL is derived from
 * SQ_HUB_APPLICATION_ACCESS_URL (".../application-access/check" -> ".../application-access/launcher")
 * unless an explicit override is configured. Returns null when neither gives a usable URL.
 */
export function deriveLauncherUrl(accessCheckUrl: string, override?: string | null): string | null {
  if (override) return override;
  try {
    const url = new URL(accessCheckUrl);
    if (!url.pathname.endsWith("/application-access/check")) return null;
    url.pathname = url.pathname.replace(/\/check$/, "/launcher");
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

interface CacheEntry {
  expiresAt: number;
  value: Promise<LauncherResult>;
}

export class LauncherService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly source: LauncherSource | null,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * `sessionKey` identifies the HCIS session (the stored session-token hash, never the raw token).
   * `loadIdentity` is only called on a cache miss. Every failure becomes LAUNCHER_UNAVAILABLE.
   */
  async get(sessionKey: string, loadIdentity: () => Promise<LauncherIdentity | null>): Promise<LauncherResult> {
    if (!this.source) return LAUNCHER_UNAVAILABLE;

    const cached = this.cache.get(sessionKey);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    if (cached) this.cache.delete(sessionKey);

    const source = this.source;
    const entry: CacheEntry = { expiresAt: this.now() + LAUNCHER_CACHE_TTL_MS, value: Promise.resolve(LAUNCHER_UNAVAILABLE) };
    entry.value = (async (): Promise<LauncherResult> => {
      try {
        const identity = await loadIdentity();
        if (!identity) {
          entry.expiresAt = this.now() + LAUNCHER_FAILURE_TTL_MS;
          return LAUNCHER_UNAVAILABLE;
        }
        return { applications: await source.listLauncherApplications(identity) };
      } catch {
        entry.expiresAt = this.now() + LAUNCHER_FAILURE_TTL_MS;
        return LAUNCHER_UNAVAILABLE;
      }
    })();

    this.prune();
    this.cache.set(sessionKey, entry);
    return entry.value;
  }

  private prune(): void {
    if (this.cache.size < LAUNCHER_CACHE_MAX_ENTRIES) return;
    const now = this.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
    // Still full: drop the oldest insertions (Map keeps insertion order).
    for (const key of this.cache.keys()) {
      if (this.cache.size < LAUNCHER_CACHE_MAX_ENTRIES) break;
      this.cache.delete(key);
    }
  }
}
