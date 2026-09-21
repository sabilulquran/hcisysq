import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { getAdmsDeviceHealth, type AdmsDeviceHealth } from "@/lib/admsAdmin";
import { getCurrentSession } from "@/lib/auth";
import type { AuthSession } from "@/types/hcis";
import { getAdmsDevice, type AdmsDeviceDetailResponse } from "@/lib/attendance";

type DeviceAdminContextValue = {
  deviceId: string;
  detail: AdmsDeviceDetailResponse | null;
  health: AdmsDeviceHealth | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  session: AuthSession | null;
  sessionResolved: boolean;
  refresh: () => Promise<void>;
};

const DeviceAdminContext = createContext<DeviceAdminContextValue | null>(null);

export function DeviceAdminProvider({ deviceId, children }: { deviceId: string; children: ReactNode }) {
  const [detail, setDetail] = useState<AdmsDeviceDetailResponse | null>(null);
  const [health, setHealth] = useState<AdmsDeviceHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [sessionResolved, setSessionResolved] = useState(false);

  const load = useCallback(async (initial: boolean) => {
    if (initial) setLoading(true);
    else setRefreshing(true);

    try {
      const [nextDetail, nextHealth] = await Promise.all([
        getAdmsDevice(deviceId),
        getAdmsDeviceHealth(deviceId),
      ]);
      setDetail(nextDetail);
      setHealth(nextHealth);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Detail mesin fingerprint tidak dapat dimuat.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [deviceId]);

  useEffect(() => {
    let active = true;
    setDetail(null);
    setHealth(null);
    setError(null);
    void load(true);
    void getCurrentSession()
      .then((value) => { if (active) setSession(value); })
      .catch(() => { if (active) setSession(null); })
      .finally(() => { if (active) setSessionResolved(true); });

    const timer = window.setInterval(() => void load(false), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [load]);

  const value = useMemo<DeviceAdminContextValue>(
    () => ({
      deviceId,
      detail,
      health,
      loading,
      refreshing,
      error,
      session,
      sessionResolved,
      refresh: () => load(false),
    }),
    [deviceId, detail, error, health, load, loading, refreshing, session, sessionResolved],
  );

  return <DeviceAdminContext.Provider value={value}>{children}</DeviceAdminContext.Provider>;
}

export function useDeviceAdmin() {
  const value = useContext(DeviceAdminContext);
  if (!value) throw new Error("useDeviceAdmin must be used inside DeviceAdminProvider");
  return value;
}
