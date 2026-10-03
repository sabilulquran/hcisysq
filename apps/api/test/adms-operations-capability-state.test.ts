import { describe, expect, it } from "vitest";

import {
  deliveryCapabilitySummary,
  operationsCapabilities,
  projectPhysicalCapability,
  type PhysicalCapabilitySnapshot,
} from "../src/modules/attendance/adms/operations-capability-state.js";
import type { PhysicalCapabilityKey } from "../src/modules/attendance/adms/physical-parity-protocol.js";

function snapshots(...rows: PhysicalCapabilitySnapshot[]) {
  return new Map<PhysicalCapabilityKey, PhysicalCapabilitySnapshot>(rows.map((row) => [row.capabilityKey, row] as const));
}

describe("ATT-005 operations capability state projection", () => {
  it("treats missing physical evidence as not verified and fail-closed", () => {
    const items = operationsCapabilities(snapshots());
    expect(items.find((item) => item.key === "time_sync")).toMatchObject({
      state: "not_verified",
      execution: "blocked",
    });
    expect(items.find((item) => item.key === "clear_attendance")).toMatchObject({
      state: "not_verified",
      execution: "blocked",
    });
    for (const key of ["user_profile_upsert", "user_enable_disable", "ntp_config"]) {
      expect(items.find((item) => item.key === key)).toMatchObject({
        state: "not_verified",
        execution: "blocked",
      });
    }
  });

  it("makes only verified physical evidence device-executable", () => {
    const items = operationsCapabilities(snapshots({
      capabilityKey: "time_sync",
      state: "verified",
      lastResultCode: 0,
      verifiedAt: new Date("2026-09-04T02:00:00.000Z"),
    }));
    expect(items.find((item) => item.key === "time_sync")).toMatchObject({
      state: "available",
      execution: "device",
    });
  });

  it("keeps pending and failed canaries non-executable", () => {
    const pending = projectPhysicalCapability({
      key: "time_sync",
      physicalKey: "time_sync",
      label: "Sinkron waktu/timezone",
      unverifiedReason: "not verified",
    }, snapshots({
      capabilityKey: "time_sync",
      state: "canary_pending",
      lastResultCode: null,
      verifiedAt: null,
    }));
    expect(pending).toMatchObject({ state: "not_verified", execution: "blocked" });

    const failed = projectPhysicalCapability({
      key: "time_sync",
      physicalKey: "time_sync",
      label: "Sinkron waktu/timezone",
      unverifiedReason: "not verified",
    }, snapshots({
      capabilityKey: "time_sync",
      state: "failed",
      lastResultCode: -7,
      verifiedAt: null,
    }));
    expect(failed).toMatchObject({ state: "not_verified", execution: "blocked" });
    expect(failed.reason).toContain("RC -7");
  });

  it("maps unsupported and explicitly blocked evidence to blocked", () => {
    const unsupported = deliveryCapabilitySummary(snapshots({
      capabilityKey: "work_code_delivery",
      state: "unsupported",
      lastResultCode: 13,
      verifiedAt: null,
    }), "work_code_delivery", "Work Code");
    expect(unsupported.state).toBe("blocked");

    const blocked = deliveryCapabilitySummary(snapshots({
      capabilityKey: "message_delivery",
      state: "blocked",
      lastResultCode: null,
      verifiedAt: null,
    }), "message_delivery", "Pesan perangkat");
    expect(blocked.state).toBe("blocked");
  });

  it("exposes Work Code and message delivery as available only after verification", () => {
    const work = deliveryCapabilitySummary(snapshots({
      capabilityKey: "work_code_delivery",
      state: "verified",
      lastResultCode: 0,
      verifiedAt: new Date("2026-09-04T02:00:00.000Z"),
    }), "work_code_delivery", "Work Code");
    expect(work.state).toBe("available");

    const message = deliveryCapabilitySummary(snapshots(), "message_delivery", "Pesan perangkat");
    expect(message.state).toBe("not_verified");
  });
});
