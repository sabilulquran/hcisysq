import type { Pool, PoolClient } from "pg";

import { resolveEmployeeWorkLocation } from "../organization/read-model.js";
import { PostgresOrganizationRepository } from "../organization/repository.js";
import type { ResolvedSchedule } from "./engine.js";

// ORG-005-3 (DRAFT D-5-8): which place a mobile clock-in is checked against.
//
// 1. The work location of the day's shift version, when it is active, always wins ("shift").
// 2. Otherwise the work location of the employee's primary unit in the structure effective on the
//    work date, inherited from the nearest ancestor unit (ORG-005-1, D-5-3) ("unit"). Not on a day
//    whose schedule is misconfigured: that day keeps needing review, as before.
// 3. Otherwise nothing: the clock-in is recorded as `unassigned_location` and needs review.
//
// The unit rule is the read model's own resolver; nothing is guessed from unit names. A location
// that is switched off or has no point/radius is never used for a check.

export type GeofenceLocation = NonNullable<ResolvedSchedule["workLocation"]>;

export type GeofenceLocationSource = "shift" | "unit";

export type GeofenceLocationResolution = {
  location: GeofenceLocation | null;
  source: GeofenceLocationSource | null;
  /** Set for source "unit" when the location came from an ancestor unit rather than the own unit. */
  inheritedFromNodeKey: string | null;
};

type Db = Pool | PoolClient;

export async function resolveGeofenceLocation(
  db: Db,
  employeeId: string,
  workDate: string,
  schedule: Pick<ResolvedSchedule, "workLocation" | "state">,
): Promise<GeofenceLocationResolution> {
  const none: GeofenceLocationResolution = { location: null, source: null, inheritedFromNodeKey: null };
  if (schedule.workLocation) {
    const shiftLocation = await db.query<{ active: boolean }>(
      "SELECT active FROM attendance_work_locations WHERE id = $1",
      [schedule.workLocation.id],
    );
    if (shiftLocation.rows[0]?.active) {
      return { location: schedule.workLocation, source: "shift", inheritedFromNodeKey: null };
    }
  }
  if (schedule.state === "configuration_error") return none;
  // One snapshot load per call; only reached when the shift names no location.
  const snapshot = await new PostgresOrganizationRepository(db).loadEffectiveSnapshot(workDate);
  if (!snapshot) return none;
  const resolved = resolveEmployeeWorkLocation(snapshot, employeeId, workDate, new Map());
  if (!resolved) return none;
  const row = await db.query<{
    id: string; name: string; latitude: number | null; longitude: number | null; radiusMeters: number | null;
  }>(
    `SELECT id, name, latitude, longitude, radius_meters AS "radiusMeters"
     FROM attendance_work_locations
     WHERE id = $1 AND active = true`,
    [resolved.id],
  );
  const location = row.rows[0];
  if (!location || location.latitude === null || location.longitude === null || location.radiusMeters === null) {
    return none;
  }
  return {
    location: {
      id: location.id,
      name: location.name,
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      radiusMeters: Number(location.radiusMeters),
    },
    source: "unit",
    inheritedFromNodeKey: resolved.inheritedFromNodeKey,
  };
}
