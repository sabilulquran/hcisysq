import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  PostgresOrganizationRepository,
  type OrganizationQueryable,
} from "../src/modules/organization/repository.js";

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

describe("PostgresOrganizationRepository calendar dates", () => {
  it("preserves Jakarta DATE columns instead of drifting to the previous UTC day", async () => {
    const jakartaMidnight = new Date("2026-08-22T17:00:00.000Z");
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM organization_change_sets")) {
        return result([{
          id: "00000000-0000-4000-8000-000000000001",
          name: "Synthetic date regression",
          effectiveOn: jakartaMidnight,
          status: "DRAFT",
          baseChangeSetId: null,
          validationReport: {},
          createdByAccountId: "00000000-0000-4000-8000-000000000002",
          createdAt: new Date("2026-08-22T17:00:00.000Z"),
          validatedAt: null,
          publishedAt: null,
        }]);
      }
      if (sql.includes("FROM organization_nodes")) {
        return result([{
          id: "00000000-0000-4000-8000-000000000003",
          stableKey: "00000000-0000-4000-8000-000000000004",
          name: "Synthetic node",
          nodeType: "UNIT",
          parentNodeKey: null,
          active: true,
          effectiveFrom: jakartaMidnight,
          effectiveTo: null,
          visualRankOffset: 0,
          integrationCode: null,
        }]);
      }
      return result([]);
    });
    const repository = new PostgresOrganizationRepository({ query } as OrganizationQueryable);

    const snapshot = await repository.loadChangeSetSnapshot(
      "00000000-0000-4000-8000-000000000001",
    );

    expect(snapshot?.changeSet.effectiveOn).toBe("2026-08-23");
    expect(snapshot?.nodes[0]?.effectiveFrom).toBe("2026-08-23");
  });

  it("uses deterministic same-effective-date published revision ordering", async () => {
    let effectiveQuery = "";
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("status = 'PUBLISHED'")) effectiveQuery = sql.replace(/\s+/g, " ");
      return result([]);
    });
    const repository = new PostgresOrganizationRepository({ query } as OrganizationQueryable);

    await repository.loadEffectiveSnapshot("2026-08-23");

    expect(effectiveQuery).toContain(
      "ORDER BY effective_on DESC, published_at DESC, created_at DESC, id DESC",
    );
  });

  it("keeps rollout LEGACY when no rollout setting exists", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("organization_rollout_settings")) return result([]);
      if (sql.includes("status = 'PUBLISHED'")) return result([]);
      return result([]);
    });
    const repository = new PostgresOrganizationRepository({ query } as OrganizationQueryable);

    await expect(repository.getRolloutMode(
      "leave.annual",
      "00000000-0000-4000-8000-000000000010",
      "2026-08-23",
    )).resolves.toBe("LEGACY");
  });

  it("round-trips account-held and primary-structural fields without converting principals", async () => {
    const accountId = "00000000-0000-4000-8000-000000000090";
    const positionKey = "00000000-0000-4000-8000-000000000080";
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM organization_change_sets")) {
        return result([{
          id: "00000000-0000-4000-8000-000000000001",
          name: "Synthetic deployed-schema snapshot",
          effectiveOn: "2026-08-23",
          status: "DRAFT",
          baseChangeSetId: null,
          validationReport: {},
          createdByAccountId: "00000000-0000-4000-8000-000000000002",
          createdAt: new Date("2026-08-23T00:00:00.000Z"),
          validatedAt: null,
          publishedAt: null,
        }]);
      }
      if (sql.includes("FROM organization_positions")) {
        return result([{
          id: "00000000-0000-4000-8000-000000000070",
          stableKey: positionKey,
          nodeKey: "00000000-0000-4000-8000-000000000060",
          title: "Synthetic Governance Seat",
          parentPositionKey: null,
          singleIncumbent: true,
          vacancyPolicy: "BLOCK",
          active: true,
          effectiveFrom: "2026-08-23",
          effectiveTo: null,
          visualRankOffset: 0,
          holderSource: "ACCOUNT",
        }]);
      }
      if (sql.includes("FROM organization_incumbencies")) {
        return result([{
          id: "00000000-0000-4000-8000-000000000071",
          positionKey,
          employeeId: null,
          accountId,
          kind: "PRIMARY",
          isPrimaryStructural: false,
          effectiveFrom: "2026-08-23",
          effectiveTo: null,
          reason: null,
        }]);
      }
      return result([]);
    });
    const repository = new PostgresOrganizationRepository({ query } as OrganizationQueryable);
    const snapshot = await repository.loadChangeSetSnapshot(
      "00000000-0000-4000-8000-000000000001",
    );

    expect(snapshot?.positions[0]).toMatchObject({ holderSource: "ACCOUNT" });
    expect(snapshot?.incumbencies[0]).toMatchObject({
      employeeId: null,
      accountId,
      isPrimaryStructural: false,
    });

    const writeCalls: Array<{ sql: string; values?: unknown[] }> = [];
    const writeQuery = vi.fn(async (sql: string, values?: unknown[]) => {
      writeCalls.push({ sql, values });
      if (sql.includes("SELECT status FROM organization_change_sets")) {
        return result([{ status: "DRAFT" }]);
      }
      return result([]);
    });
    const writer = new PostgresOrganizationRepository({ query: writeQuery } as OrganizationQueryable);
    await writer.replaceDraftSnapshot(snapshot!);

    const positionInsert = writeCalls.find((call) => call.sql.includes("INSERT INTO organization_positions"));
    expect(positionInsert?.sql).toContain("holder_source");
    expect(positionInsert?.values?.at(-1)).toBe("ACCOUNT");

    const incumbencyInsert = writeCalls.find((call) => call.sql.includes("INSERT INTO organization_incumbencies"));
    expect(incumbencyInsert?.sql).toContain("account_id");
    expect(incumbencyInsert?.sql).toContain("is_primary_structural");
    expect(incumbencyInsert?.values?.[3]).toBeNull();
    expect(incumbencyInsert?.values?.[4]).toBe(accountId);
    expect(incumbencyInsert?.values?.[6]).toBe(false);
  });

});
