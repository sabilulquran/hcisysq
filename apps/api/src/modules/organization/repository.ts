import { randomUUID } from "node:crypto";

import type { QueryResult, QueryResultRow } from "pg";

import type {
  AuthorityEligibilityContext,
  AuthorityEligibilityResult,
  OrganizationAuthorityBinding,
  OrganizationChangeSet,
  OrganizationIncumbency,
  OrganizationJobProfile,
  OrganizationMembership,
  OrganizationNode,
  OrganizationPosition,
  OrganizationReportingOverride,
  OrganizationRolloutMode,
  OrganizationSnapshot,
  OrganizationValidationReport,
} from "./domain.js";
import { assertIsoDate, jakartaBusinessDate } from "./jakarta-date.js";

export interface OrganizationQueryable {
  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

interface OrganizationTransactionClient extends OrganizationQueryable {
  release(): void;
}

interface OrganizationTransactionPool extends OrganizationQueryable {
  connect(): Promise<OrganizationTransactionClient>;
}

interface ChangeSetRow {
  id: string;
  name: string;
  effectiveOn: string | Date;
  status: OrganizationChangeSet["status"];
  baseChangeSetId: string | null;
  validationReport: OrganizationValidationReport;
  createdByAccountId: string;
  createdAt: Date;
  validatedAt: Date | null;
  publishedAt: Date | null;
}

interface NodeRow extends Omit<OrganizationNode, "effectiveFrom" | "effectiveTo"> {
  effectiveFrom: string | Date;
  effectiveTo: string | Date | null;
}

interface JobProfileRow extends Omit<OrganizationJobProfile, "effectiveFrom" | "effectiveTo"> {
  effectiveFrom: string | Date;
  effectiveTo: string | Date | null;
}

interface PositionRow extends Omit<OrganizationPosition, "effectiveFrom" | "effectiveTo"> {
  effectiveFrom: string | Date;
  effectiveTo: string | Date | null;
}

interface MembershipRow extends Omit<OrganizationMembership, "effectiveFrom" | "effectiveTo"> {
  effectiveFrom: string | Date;
  effectiveTo: string | Date | null;
}

interface IncumbencyRow extends Omit<OrganizationIncumbency, "effectiveFrom" | "effectiveTo"> {
  effectiveFrom: string | Date;
  effectiveTo: string | Date | null;
}

interface BindingRow extends Omit<OrganizationAuthorityBinding, "effectiveFrom" | "effectiveTo"> {
  effectiveFrom: string | Date;
  effectiveTo: string | Date | null;
}

interface OverrideRow extends Omit<OrganizationReportingOverride, "effectiveFrom" | "effectiveTo"> {
  effectiveFrom: string | Date;
  effectiveTo: string | Date | null;
}

function dateText(value: string | Date): string {
  return typeof value === "string" ? value.slice(0, 10) : jakartaBusinessDate(value);
}

function nullableDateText(value: string | Date | null): string | null {
  return value === null ? null : dateText(value);
}

function mapPeriod<T extends { effectiveFrom: string | Date; effectiveTo: string | Date | null }>(
  row: T,
): Omit<T, "effectiveFrom" | "effectiveTo"> & { effectiveFrom: string; effectiveTo: string | null } {
  return {
    ...row,
    effectiveFrom: dateText(row.effectiveFrom),
    effectiveTo: nullableDateText(row.effectiveTo),
  };
}

function mapChangeSet(row: ChangeSetRow): OrganizationChangeSet {
  return {
    ...row,
    effectiveOn: dateText(row.effectiveOn),
    createdAt: row.createdAt.toISOString(),
    validatedAt: row.validatedAt?.toISOString() ?? null,
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}

export interface CreateOrganizationDraftInput {
  name: string;
  effectiveOn: string;
  actorAccountId: string;
  baseChangeSetId?: string | null | undefined;
}

export class PostgresOrganizationRepository {
  constructor(public readonly db: OrganizationQueryable) {}

  async loadEffectiveSnapshot(effectiveDate: string): Promise<OrganizationSnapshot | null> {
    assertIsoDate(effectiveDate);
    const result = await this.db.query<ChangeSetRow>(
      `
        SELECT id, name, effective_on AS "effectiveOn", status,
          base_change_set_id AS "baseChangeSetId", validation_report AS "validationReport",
          created_by_account_id AS "createdByAccountId", created_at AS "createdAt",
          validated_at AS "validatedAt", published_at AS "publishedAt"
        FROM organization_change_sets
        WHERE status = 'PUBLISHED' AND effective_on <= $1::date
        ORDER BY effective_on DESC, published_at DESC, created_at DESC, id DESC
        LIMIT 1
      `,
      [effectiveDate],
    );
    const row = result.rows[0];
    return row ? this.loadSnapshotRows(mapChangeSet(row)) : null;
  }

  async loadChangeSetSnapshot(changeSetId: string): Promise<OrganizationSnapshot | null> {
    const result = await this.db.query<ChangeSetRow>(
      `
        SELECT id, name, effective_on AS "effectiveOn", status,
          base_change_set_id AS "baseChangeSetId", validation_report AS "validationReport",
          created_by_account_id AS "createdByAccountId", created_at AS "createdAt",
          validated_at AS "validatedAt", published_at AS "publishedAt"
        FROM organization_change_sets WHERE id = $1
      `,
      [changeSetId],
    );
    const row = result.rows[0];
    return row ? this.loadSnapshotRows(mapChangeSet(row)) : null;
  }

  async listChangeSets(): Promise<OrganizationChangeSet[]> {
    const result = await this.db.query<ChangeSetRow>(
      `
        SELECT id, name, effective_on AS "effectiveOn", status,
          base_change_set_id AS "baseChangeSetId", validation_report AS "validationReport",
          created_by_account_id AS "createdByAccountId", created_at AS "createdAt",
          validated_at AS "validatedAt", published_at AS "publishedAt"
        FROM organization_change_sets
        ORDER BY effective_on DESC, created_at DESC, id DESC
      `,
    );
    return result.rows.map(mapChangeSet);
  }

  async createDraft(input: CreateOrganizationDraftInput): Promise<OrganizationSnapshot> {
    if (hasTransactionPool(this.db)) {
      return this.inTransaction((repository) => repository.createDraft(input));
    }
    assertIsoDate(input.effectiveOn);
    const changeSetId = randomUUID();
    let base = input.baseChangeSetId
      ? await this.loadChangeSetSnapshot(input.baseChangeSetId)
      : await this.loadEffectiveSnapshot(input.effectiveOn);
    if (base?.changeSet.status !== "PUBLISHED") base = null;

    const created = await this.db.query<ChangeSetRow>(
      `
        INSERT INTO organization_change_sets (
          id, name, effective_on, status, base_change_set_id, created_by_account_id
        ) VALUES ($1, $2, $3, 'DRAFT', $4, $5)
        RETURNING id, name, effective_on AS "effectiveOn", status,
          base_change_set_id AS "baseChangeSetId", validation_report AS "validationReport",
          created_by_account_id AS "createdByAccountId", created_at AS "createdAt",
          validated_at AS "validatedAt", published_at AS "publishedAt"
      `,
      [changeSetId, input.name.trim(), input.effectiveOn, base?.changeSet.id ?? null, input.actorAccountId],
    );
    const changeSet = mapChangeSet(created.rows[0]!);
    const snapshot: OrganizationSnapshot = base
      ? {
          changeSet,
          nodes: base.nodes.map((item) => ({ ...item, id: randomUUID() })),
          jobProfiles: base.jobProfiles.map((item) => ({ ...item, id: randomUUID() })),
          positions: base.positions.map((item) => ({ ...item, id: randomUUID() })),
          memberships: base.memberships.map((item) => ({ ...item, id: randomUUID() })),
          incumbencies: base.incumbencies.map((item) => ({ ...item, id: randomUUID() })),
          authorityBindings: base.authorityBindings.map((item) => ({ ...item, id: randomUUID() })),
          reportingOverrides: base.reportingOverrides.map((item) => ({ ...item, id: randomUUID() })),
        }
      : {
          changeSet,
          nodes: [],
          jobProfiles: [],
          positions: [],
          memberships: [],
          incumbencies: [],
          authorityBindings: [],
          reportingOverrides: [],
        };
    await this.replaceDraftSnapshot(snapshot);
    return snapshot;
  }

  async replaceDraftSnapshot(snapshot: OrganizationSnapshot): Promise<void> {
    if (hasTransactionPool(this.db)) {
      return this.inTransaction((repository) => repository.replaceDraftSnapshot(snapshot));
    }
    const state = await this.db.query<{ status: OrganizationChangeSet["status"] }>(
      "SELECT status FROM organization_change_sets WHERE id = $1 FOR UPDATE",
      [snapshot.changeSet.id],
    );
    if (state.rows[0]?.status !== "DRAFT") {
      throw new Error("Only DRAFT organization change sets can be replaced.");
    }

    for (const table of [
      "organization_reporting_overrides",
      "organization_authority_bindings",
      "organization_incumbencies",
      "organization_memberships",
      "organization_positions",
      "organization_job_profiles",
      "organization_nodes",
    ]) {
      await this.db.query(`DELETE FROM ${table} WHERE change_set_id = $1`, [snapshot.changeSet.id]);
    }
    // Parent references and polymorphic subjects are deferred by the migration, allowing full-graph insertion.
    for (const item of parentFirst(snapshot.nodes, (entry) => entry.stableKey, (entry) => entry.parentNodeKey)) {
      await this.db.query(
        `INSERT INTO organization_nodes
          (id, change_set_id, stable_key, name, node_type, parent_node_key, active,
           effective_from, effective_to, visual_rank_offset, integration_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [item.id, snapshot.changeSet.id, item.stableKey, item.name, item.nodeType,
          item.parentNodeKey, item.active, item.effectiveFrom, item.effectiveTo,
          item.visualRankOffset, item.integrationCode],
      );
    }
    for (const item of snapshot.jobProfiles) {
      await this.db.query(
        `INSERT INTO organization_job_profiles
          (id, change_set_id, stable_key, name, active, effective_from, effective_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [item.id, snapshot.changeSet.id, item.stableKey, item.name, item.active,
          item.effectiveFrom, item.effectiveTo],
      );
    }
    for (const item of parentFirst(
      snapshot.positions,
      (entry) => entry.stableKey,
      (entry) => entry.parentPositionKey,
    )) {
      await this.db.query(
        `INSERT INTO organization_positions
          (id, change_set_id, stable_key, node_key, title, parent_position_key,
           single_incumbent, vacancy_policy, active, effective_from, effective_to, visual_rank_offset)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [item.id, snapshot.changeSet.id, item.stableKey, item.nodeKey, item.title,
          item.parentPositionKey, item.singleIncumbent, item.vacancyPolicy, item.active,
          item.effectiveFrom, item.effectiveTo, item.visualRankOffset],
      );
    }
    for (const item of snapshot.memberships) {
      await this.db.query(
        `INSERT INTO organization_memberships
          (id, change_set_id, employee_id, node_key, job_profile_key, is_primary,
           effective_from, effective_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [item.id, snapshot.changeSet.id, item.employeeId, item.nodeKey,
          item.jobProfileKey, item.isPrimary, item.effectiveFrom, item.effectiveTo],
      );
    }
    for (const item of snapshot.incumbencies) {
      await this.db.query(
        `INSERT INTO organization_incumbencies
          (id, change_set_id, position_key, employee_id, kind, effective_from, effective_to, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [item.id, snapshot.changeSet.id, item.positionKey, item.employeeId,
          item.kind, item.effectiveFrom, item.effectiveTo, item.reason],
      );
    }
    for (const item of snapshot.authorityBindings) {
      await this.db.query(
        `INSERT INTO organization_authority_bindings
          (id, change_set_id, subject_kind, subject_key, binding_type,
           target_position_key, vacancy_policy, effective_from, effective_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [item.id, snapshot.changeSet.id, item.subjectKind, item.subjectKey,
          item.bindingType, item.targetPositionKey, item.vacancyPolicy,
          item.effectiveFrom, item.effectiveTo],
      );
    }
    for (const item of snapshot.reportingOverrides) {
      await this.db.query(
        `INSERT INTO organization_reporting_overrides
          (id, change_set_id, employee_id, manager_position_key, manager_employee_id,
           reason, effective_from, effective_to, created_by_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [item.id, snapshot.changeSet.id, item.employeeId, item.managerPositionKey,
          item.managerEmployeeId, item.reason, item.effectiveFrom, item.effectiveTo,
          snapshot.changeSet.createdByAccountId],
      );
    }
    await this.db.query(
      "UPDATE organization_change_sets SET validation_report = '{}'::jsonb, updated_at = now() WHERE id = $1",
      [snapshot.changeSet.id],
    );
  }

  async markValidated(
    changeSetId: string,
    actorAccountId: string,
    report: OrganizationValidationReport,
  ): Promise<void> {
    await this.db.query(
      `UPDATE organization_change_sets
       SET status = CASE WHEN $3::boolean THEN 'VALIDATED' ELSE 'DRAFT' END,
           validation_report = $4::jsonb,
           validated_by_account_id = CASE WHEN $3::boolean THEN $2::uuid ELSE NULL::uuid END,
           validated_at = CASE WHEN $3::boolean THEN now() ELSE NULL END,
           updated_at = now()
       WHERE id = $1 AND status IN ('DRAFT', 'VALIDATED')`,
      [changeSetId, actorAccountId, report.valid, JSON.stringify(report)],
    );
  }

  async publishValidated(changeSetId: string, actorAccountId: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE organization_change_sets
       SET status = 'PUBLISHED', published_by_account_id = $2::uuid, published_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'VALIDATED'`,
      [changeSetId, actorAccountId],
    );
    if (result.rowCount !== 1) throw new Error("Organization change set is not validated.");
  }

  async getRolloutMode(
    workflowKey: string,
    employeeId: string,
    effectiveDate: string,
  ): Promise<OrganizationRolloutMode> {
    const snapshot = await this.loadEffectiveSnapshot(effectiveDate);
    const nodeKey = snapshot?.memberships.find(
      (item) => item.employeeId === employeeId && item.isPrimary
        && item.effectiveFrom <= effectiveDate
        && (item.effectiveTo === null || item.effectiveTo >= effectiveDate),
    )?.nodeKey ?? null;
    const result = await this.db.query<{ mode: OrganizationRolloutMode }>(
      `SELECT mode
       FROM organization_rollout_settings
       WHERE workflow_key = $1
         AND effective_from <= $2::date
         AND (effective_to IS NULL OR effective_to >= $2::date)
         AND (node_key = $3::uuid OR node_key IS NULL)
       ORDER BY CASE WHEN node_key = $3::uuid THEN 0 ELSE 1 END, effective_from DESC
       LIMIT 1`,
      [workflowKey, effectiveDate, nodeKey],
    );
    return result.rows[0]?.mode ?? "LEGACY";
  }

  async validate(
    employeeId: string,
    context: AuthorityEligibilityContext,
  ): Promise<AuthorityEligibilityResult> {
    const result = await this.db.query<{
      employeeActive: boolean;
      accountActive: boolean;
      capabilityValid: boolean;
    }>(
      `SELECT
         (e.status = 'active') AS "employeeActive",
         EXISTS (
           SELECT 1 FROM accounts a
           WHERE a.employee_id = e.id AND a.principal_type = 'EMPLOYEE' AND a.status = 'active'
         ) AS "accountActive",
         CASE WHEN $3::text IS NULL THEN true ELSE EXISTS (
           SELECT 1
           FROM accounts a
           JOIN account_role_assignments ara ON ara.account_id = a.id
           JOIN role_permissions rp ON rp.role_id = ara.role_id
           WHERE a.employee_id = e.id
             AND a.principal_type = 'EMPLOYEE' AND a.status = 'active'
             AND rp.permission_key = $3
             AND (ara.starts_on IS NULL OR ara.starts_on <= $2::date)
             AND (ara.ends_on IS NULL OR ara.ends_on >= $2::date)
         ) END AS "capabilityValid"
       FROM employees e WHERE e.id = $1`,
      [employeeId, context.effectiveDate, context.requiredCapability ?? null],
    );
    const row = result.rows[0];
    if (!row?.employeeActive) return { eligible: false, reason: "EMPLOYEE_NOT_ACTIVE" };
    if (!row.accountActive) return { eligible: false, reason: "ACCOUNT_NOT_ACTIVE" };
    if (!row.capabilityValid) return { eligible: false, reason: "CAPABILITY_MISSING" };
    return { eligible: true, reason: null };
  }

  /**
   * Structural incumbency only requires a real, active employee. Login and
   * workflow capability checks belong to authority resolution, not chart publication.
   */
  async validateStructuralIncumbent(employeeId: string): Promise<AuthorityEligibilityResult> {
    const result = await this.db.query<{ employeeActive: boolean }>(
      `SELECT (status = 'active') AS "employeeActive"
       FROM employees
       WHERE id = $1`,
      [employeeId],
    );
    return result.rows[0]?.employeeActive
      ? { eligible: true, reason: null }
      : { eligible: false, reason: "EMPLOYEE_NOT_ACTIVE" };
  }

  private async loadSnapshotRows(changeSet: OrganizationChangeSet): Promise<OrganizationSnapshot> {
    const id = changeSet.id;
    const [nodes, jobProfiles, positions, memberships, incumbencies, bindings, overrides] =
      await Promise.all([
        this.db.query<NodeRow>(
          `SELECT id, stable_key AS "stableKey", name, node_type AS "nodeType",
            parent_node_key AS "parentNodeKey", active, effective_from AS "effectiveFrom",
            effective_to AS "effectiveTo", visual_rank_offset AS "visualRankOffset",
            integration_code AS "integrationCode"
           FROM organization_nodes WHERE change_set_id = $1`, [id]),
        this.db.query<JobProfileRow>(
          `SELECT id, stable_key AS "stableKey", name, active,
            effective_from AS "effectiveFrom", effective_to AS "effectiveTo"
           FROM organization_job_profiles WHERE change_set_id = $1`, [id]),
        this.db.query<PositionRow>(
          `SELECT id, stable_key AS "stableKey", node_key AS "nodeKey", title,
            parent_position_key AS "parentPositionKey", single_incumbent AS "singleIncumbent",
            vacancy_policy AS "vacancyPolicy", active, effective_from AS "effectiveFrom",
            effective_to AS "effectiveTo", visual_rank_offset AS "visualRankOffset"
           FROM organization_positions WHERE change_set_id = $1`, [id]),
        this.db.query<MembershipRow>(
          `SELECT id, employee_id AS "employeeId", node_key AS "nodeKey",
            job_profile_key AS "jobProfileKey", is_primary AS "isPrimary",
            effective_from AS "effectiveFrom", effective_to AS "effectiveTo"
           FROM organization_memberships WHERE change_set_id = $1`, [id]),
        this.db.query<IncumbencyRow>(
          `SELECT id, position_key AS "positionKey", employee_id AS "employeeId", kind,
            effective_from AS "effectiveFrom", effective_to AS "effectiveTo", reason
           FROM organization_incumbencies WHERE change_set_id = $1`, [id]),
        this.db.query<BindingRow>(
          `SELECT id, subject_kind AS "subjectKind", subject_key AS "subjectKey",
            binding_type AS "bindingType", target_position_key AS "targetPositionKey",
            vacancy_policy AS "vacancyPolicy", effective_from AS "effectiveFrom",
            effective_to AS "effectiveTo"
           FROM organization_authority_bindings WHERE change_set_id = $1`, [id]),
        this.db.query<OverrideRow>(
          `SELECT id, employee_id AS "employeeId", manager_position_key AS "managerPositionKey",
            manager_employee_id AS "managerEmployeeId", reason,
            effective_from AS "effectiveFrom", effective_to AS "effectiveTo"
           FROM organization_reporting_overrides WHERE change_set_id = $1`, [id]),
      ]);
    return {
      changeSet,
      nodes: nodes.rows.map((row) => mapPeriod(row) as OrganizationNode),
      jobProfiles: jobProfiles.rows.map((row) => mapPeriod(row) as OrganizationJobProfile),
      positions: positions.rows.map((row) => mapPeriod(row) as OrganizationPosition),
      memberships: memberships.rows.map((row) => mapPeriod(row) as OrganizationMembership),
      incumbencies: incumbencies.rows.map((row) => mapPeriod(row) as OrganizationIncumbency),
      authorityBindings: bindings.rows.map((row) => mapPeriod(row) as OrganizationAuthorityBinding),
      reportingOverrides: overrides.rows.map((row) => mapPeriod(row) as OrganizationReportingOverride),
    };
  }

  private async inTransaction<T>(
    operation: (repository: PostgresOrganizationRepository) => Promise<T>,
  ): Promise<T> {
    if (!hasTransactionPool(this.db)) return operation(this);
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(new PostgresOrganizationRepository(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function hasTransactionPool(
  db: OrganizationQueryable,
): db is OrganizationTransactionPool {
  return !("release" in db)
    && "connect" in db
    && typeof (db as { connect?: unknown }).connect === "function";
}

function parentFirst<T>(
  items: T[],
  keyOf: (item: T) => string,
  parentOf: (item: T) => string | null,
): T[] {
  const remaining = [...items];
  const result: T[] = [];
  const inserted = new Set<string>();
  while (remaining.length > 0) {
    const index = remaining.findIndex((item) => {
      const parent = parentOf(item);
      return parent === null || inserted.has(parent) || !items.some((candidate) => keyOf(candidate) === parent);
    });
    if (index < 0) return items; // cycle: let the database/service validation fail closed.
    const [item] = remaining.splice(index, 1);
    result.push(item!);
    inserted.add(keyOf(item!));
  }
  return result;
}
