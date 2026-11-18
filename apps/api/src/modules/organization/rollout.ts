import type {
  OrganizationRolloutMode,
  ResolvedAuthority,
  ResolvedLineAuthorities,
  RolloutAuthorityInput,
  RolloutAuthorityResult,
} from "./domain.js";
import { OrganizationResolutionError } from "./domain.js";
import { effectiveDateOrToday } from "./jakarta-date.js";
import type { OrganizationAuthorityResolver } from "./resolver.js";

export interface OrganizationRolloutReader {
  getRolloutMode(
    workflowKey: string,
    employeeId: string,
    effectiveDate: string,
  ): Promise<OrganizationRolloutMode>;
}

export class OrganizationRolloutService {
  constructor(
    private readonly repository: OrganizationRolloutReader,
    private readonly resolver: OrganizationAuthorityResolver,
  ) {}

  async resolveAuthorities(input: RolloutAuthorityInput): Promise<RolloutAuthorityResult> {
    const effectiveDate = effectiveDateOrToday(input.effectiveDate);
    const mode = await this.repository.getRolloutMode(
      input.workflowKey,
      input.requesterEmployeeId,
      effectiveDate,
    );
    const legacy = this.legacyAuthorities(input);
    if (mode === "LEGACY") {
      return {
        mode,
        authoritativeSource: "LEGACY",
        authorities: legacy,
      };
    }

    if (mode === "STRUCTURE") {
      const structure = await this.resolveStructure(input, effectiveDate);
      return {
        mode,
        authoritativeSource: "STRUCTURE",
        authorities: structure.authorities,
        structure,
      };
    }

    try {
      const structure = await this.resolveStructure(input, effectiveDate);
      const mismatchReasons = compareAuthorities(legacy, structure.authorities);
      return {
        mode,
        authoritativeSource: "LEGACY",
        authorities: legacy,
        structure,
        shadow: {
          matches: mismatchReasons.length === 0,
          mismatchReasons,
          structural: structure,
        },
      };
    } catch (error) {
      const diagnostic = error instanceof OrganizationResolutionError
        ? { code: error.code, message: error.message }
        : { code: "STRUCTURE_RESOLUTION_FAILED", message: "Structural authority resolution failed." };
      return {
        mode,
        authoritativeSource: "LEGACY",
        authorities: legacy,
        shadow: {
          matches: false,
          mismatchReasons: [diagnostic.code],
          error: diagnostic,
        },
      };
    }
  }

  private async resolveStructure(
    input: RolloutAuthorityInput,
    effectiveDate: string,
  ): Promise<ResolvedLineAuthorities> {
    return this.resolver.resolveLineAuthorities(
      { ...input, effectiveDate },
      input.authorityRequirement ?? "LINE_AND_UNIT",
      input.approvalSeats ?? [],
    );
  }

  private legacyAuthorities(input: RolloutAuthorityInput): ResolvedAuthority[] {
    const result: ResolvedAuthority[] = [];
    const add = (employeeId: string | null, source: "DIRECT_MANAGER" | "UNIT_APPROVER") => {
      if (!employeeId || employeeId === input.requesterEmployeeId) return;
      const existing = result.find((item) => item.employeeId === employeeId);
      if (existing) {
        const sources = existing.sources ?? [existing.source];
        if (!sources.includes(source)) existing.sources = [...sources, source];
        return;
      }
      result.push({
        employeeId,
        source,
        sources: [source],
        path: ["legacy"],
        incumbentKind: "OVERRIDE",
        positionKey: null,
      });
    };
    // LOAN-002: `UNIT_AND_APPROVAL_SEATS` takes this branch too, on purpose. LEGACY knows nothing
    // about seats — it has only the two columns — so a workflow on the new chain keeps resolving
    // exactly as it did before while its rollout mode is LEGACY.
    if (input.authorityRequirement !== "UNIT_ONLY") {
      add(input.legacy.directManagerEmployeeId, "DIRECT_MANAGER");
    }
    add(input.legacy.unitApproverEmployeeId, "UNIT_APPROVER");
    return result;
  }
}

function compareAuthorities(
  legacy: ResolvedAuthority[],
  structural: ResolvedAuthority[],
): string[] {
  const reasons: string[] = [];
  const legacyIds = legacy.map((item) => item.employeeId);
  const structuralIds = structural.map((item) => item.employeeId);
  if (legacyIds.length !== structuralIds.length) reasons.push("APPROVER_COUNT_MISMATCH");
  const length = Math.max(legacyIds.length, structuralIds.length);
  for (let index = 0; index < length; index += 1) {
    if (legacyIds[index] !== structuralIds[index]) {
      reasons.push(`APPROVER_${index + 1}_MISMATCH`);
    }
  }
  return reasons;
}
