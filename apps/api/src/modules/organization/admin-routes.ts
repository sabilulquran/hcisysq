import type { AdminPermission } from "../auth/permissions.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { requirePermissionsFromCookie } from "../auth/authorization.js";
import { AuthError, AuthService, type AuthPrincipal } from "../auth/service.js";
import type {
  AuthorityBindingType,
} from "./domain.js";
import { OrganizationDraftService } from "./draft-service.js";
import { OrganizationAuthorityResolver } from "./resolver.js";
import { PostgresOrganizationRepository, type OrganizationQueryable } from "./repository.js";
import { assertIsoDate, jakartaBusinessDate } from "./jakarta-date.js";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const draftParams = z.object({ draftId: uuid });
const itemParams = z.object({ draftId: uuid, itemId: uuid });
const vacancyPolicy = z.enum(["CLIMB_TO_PARENT", "REQUIRE_ACTING_OR_BLOCK", "BLOCK"]);

const draftInput = z.object({
  name: z.string().trim().min(1).max(160),
  effectiveOn: date,
});
const nodeInput = z.object({
  name: z.string().trim().min(1).max(160),
  nodeType: z.string().trim().min(1).max(80),
  parentNodeKey: uuid.nullable().default(null),
  visualRankOffset: z.number().int().min(0).max(10).default(0),
  integrationCode: z.string().trim().min(1).max(100).nullable().optional(),
});
const nodePatch = nodeInput.partial().extend({ active: z.boolean().optional() });
const positionInput = z.object({
  nodeKey: uuid,
  title: z.string().trim().min(1).max(160),
  parentPositionKey: uuid.nullable().default(null),
  singleIncumbent: z.boolean().default(true),
  vacancyPolicy: vacancyPolicy.default("CLIMB_TO_PARENT"),
  visualRankOffset: z.number().int().min(0).max(10).default(0),
});
const positionPatch = positionInput.partial().extend({ active: z.boolean().optional() });
const membershipInput = z.object({
  nodeKey: uuid,
  employeeIds: z.array(uuid).max(500),
  effectiveFrom: date,
  effectiveTo: date.nullable().optional(),
});
const incumbencyInput = z.object({
  positionKey: uuid,
  primaryEmployeeId: uuid.nullable().optional(),
  actingEmployeeId: uuid.nullable().optional(),
  actingFrom: date.nullable().optional(),
  actingTo: date.nullable().optional(),
  effectiveFrom: date,
});
const bindingType = z.enum([
  "SUPERVISORY_PARENT",
  "LEADER",
  "UNIT_APPROVER",
  "GOVERNANCE_APPROVER",
  "OVERSIGHT_PARENT",
]);
const bindingInput = z.object({
  sourceType: z.enum(["NODE", "POSITION"]),
  sourceKey: uuid,
  authorityType: bindingType,
  targetPositionKey: uuid,
  vacancyPolicy,
  effectiveFrom: date,
  effectiveTo: date.nullable().optional(),
});
const overrideInput = z.object({
  employeeId: uuid,
  managerPositionKey: uuid,
  reason: z.string().trim().min(1).max(500),
  effectiveFrom: date,
  effectiveTo: date.nullable().optional(),
});
const resolutionInput = z.object({
  employeeId: uuid,
  workflowKey: z.string().trim().min(1).max(100),
  effectiveDate: date,
});
const rolloutInput = z.object({
  mode: z.enum(["LEGACY", "SHADOW", "STRUCTURE"]),
  workflowKey: z.string().trim().min(1).max(100).default("LEAVE"),
  organizationalNodeKey: uuid.nullable().optional(),
  effectiveFrom: date.optional(),
  effectiveTo: date.nullable().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

function invalid(reply: FastifyReply, code: string, message: string) {
  return reply.status(400).send({ code, message });
}

async function insertAuditEvent(
  db: OrganizationQueryable,
  principal: AuthPrincipal,
  action: string,
  entityType: string,
  entityId: string | null,
  changeSetId: string | null,
  payload: Record<string, unknown> = {},
) {
  await db.query(
    `INSERT INTO organization_audit_events
      (id, actor_account_id, action, entity_type, entity_id, change_set_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [randomUUID(), principal.id, action, entityType, entityId, changeSetId, JSON.stringify(payload)],
  );
}

interface OrganizationMutationContext {
  client: PoolClient;
  repository: PostgresOrganizationRepository;
  draftService: OrganizationDraftService;
  audit(
    action: string,
    entityType: string,
    entityId: string | null,
    changeSetId: string | null,
    payload?: Record<string, unknown>,
  ): Promise<void>;
}

async function atomicOrganizationMutation<T>(
  pool: Pool,
  principal: AuthPrincipal,
  operation: (context: OrganizationMutationContext) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const repository = new PostgresOrganizationRepository(client);
    const result = await operation({
      client,
      repository,
      draftService: new OrganizationDraftService(repository),
      audit: (action, entityType, entityId, changeSetId, payload = {}) =>
        insertAuditEvent(client, principal, action, entityType, entityId, changeSetId, payload),
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function registerOrganizationAdminRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required");
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );
  const repository = new PostgresOrganizationRepository(pool);
  const draftService = new OrganizationDraftService(repository);

  async function authenticate(request: FastifyRequest, reply: FastifyReply,
    permission: AdminPermission | readonly AdminPermission[],
  ) {
    try {
      return await requirePermissionsFromCookie(auth, request.headers.cookie, permission);
    } catch (error) {
      if (error instanceof AuthError) {
        await reply.status(error.statusCode).send({ code: error.code, message: error.message });
        return null;
      }
      throw error;
    }
  }

  async function editableSnapshot(
    draftId: string,
    reply: FastifyReply,
    activeRepository: PostgresOrganizationRepository = repository,
  ) {
    const snapshot = await activeRepository.loadChangeSetSnapshot(draftId);
    if (!snapshot) {
      await reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND", message: "Draft not found." });
      return null;
    }
    if (snapshot.changeSet.status !== "DRAFT") {
      await reply.status(409).send({
        code: "ORGANIZATION_DRAFT_NOT_EDITABLE",
        message: "Only a draft that has not been validated or published can be edited.",
      });
      return null;
    }
    return snapshot;
  }

  app.get("/admin/organization/designer", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    const query = z.object({ effectiveDate: date.optional(), draftId: uuid.optional() }).safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_ORGANIZATION_VIEW", "Invalid date or draft identifier.");
    const viewDate = query.data.effectiveDate ?? jakartaBusinessDate();
    const snapshot = query.data.draftId
      ? await repository.loadChangeSetSnapshot(query.data.draftId)
      : await repository.loadEffectiveSnapshot(viewDate);
    if (query.data.draftId && !snapshot) {
      return reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND", message: "Draft not found." });
    }
    if (!snapshot) {
      return reply.send({
        viewDate,
        mode: viewDate < jakartaBusinessDate() ? "HISTORICAL" : viewDate > jakartaBusinessDate() ? "FUTURE" : "CURRENT",
        draft: null,
        nodes: [], positions: [], memberships: [], assignments: [], bindings: [], reportingOverrides: [],
      });
    }
    const employeeIds = [...new Set([
      ...snapshot.memberships.map((item) => item.employeeId),
      ...snapshot.incumbencies.map((item) => item.employeeId),
    ])];
    const employees = employeeIds.length === 0 ? { rows: [] as Array<{ id: string; employeeNumber: string; fullName: string }> }
      : await pool.query<{ id: string; employeeNumber: string; fullName: string }>(
        `SELECT id, employee_number AS "employeeNumber", full_name AS "fullName"
         FROM employees WHERE id = ANY($1::uuid[])`, [employeeIds]);
    const employeeById = new Map(employees.rows.map((item) => [item.id, item]));
    const assignments = snapshot.incumbencies.map((item) => ({
      assignmentId: item.id,
      positionKey: item.positionKey,
      employeeId: item.employeeId,
      employeeNumber: employeeById.get(item.employeeId)?.employeeNumber,
      employeeName: employeeById.get(item.employeeId)?.fullName ?? "Unknown employee",
      effectiveFrom: item.effectiveFrom,
      effectiveTo: item.effectiveTo,
      assignmentType: item.kind,
    }));
    return reply.send({
      viewDate,
      mode: snapshot.changeSet.status === "PUBLISHED"
        ? viewDate < jakartaBusinessDate() ? "HISTORICAL" : viewDate > jakartaBusinessDate() ? "FUTURE" : "CURRENT"
        : "DRAFT",
      draft: snapshot.changeSet,
      nodes: snapshot.nodes.map((item) => ({
        ...item,
        memberCount: snapshot.memberships.filter((member) => member.nodeKey === item.stableKey).length,
        leaderPositionKey: snapshot.authorityBindings.find((binding) =>
          binding.subjectKind === "NODE" && binding.subjectKey === item.stableKey && binding.bindingType === "LEADER")
          ?.targetPositionKey ?? null,
      })),
      positions: snapshot.positions.map((item) => ({
        ...item,
        primaryIncumbent: assignments.find((assignment) =>
          assignment.positionKey === item.stableKey && assignment.assignmentType === "PRIMARY") ?? null,
        actingIncumbent: assignments.find((assignment) =>
          assignment.positionKey === item.stableKey && assignment.assignmentType === "ACTING") ?? null,
      })),
      memberships: snapshot.memberships.map((item) => ({
        ...item,
        employeeName: employeeById.get(item.employeeId)?.fullName,
      })),
      assignments,
      bindings: snapshot.authorityBindings.map((item) => ({
        id: item.id,
        sourceType: item.subjectKind,
        sourceKey: item.subjectKey,
        authorityType: item.bindingType,
        targetPositionKey: item.targetPositionKey,
        vacancyPolicy: item.vacancyPolicy,
        effectiveFrom: item.effectiveFrom,
        effectiveTo: item.effectiveTo,
      })),
      reportingOverrides: snapshot.reportingOverrides.map((item) => ({
        id: item.id,
        employeeId: item.employeeId,
        managerPositionKey: item.managerPositionKey,
        managerEmployeeId: item.managerEmployeeId,
        reason: item.reason,
        effectiveFrom: item.effectiveFrom,
        effectiveTo: item.effectiveTo,
      })),
    });
  });

  app.get("/admin/organization/designer/employees", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    const result = await pool.query(
      `SELECT e.id, e.employee_number AS "employeeNumber", e.full_name AS "fullName",
        e.status, u.name AS "unitName", p.name AS "positionName"
       FROM employees e
       LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
       LEFT JOIN positions p ON p.id = e.position_id
       ORDER BY (e.status = 'active') DESC, e.full_name`,
    );
    return reply.send({ items: result.rows });
  });

  app.post("/admin/organization/designer/drafts", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const parsed = draftInput.safeParse(request.body);
    if (!parsed.success) return invalid(reply, "INVALID_ORGANIZATION_DRAFT", "Draft name and effective date are required.");
    try { assertIsoDate(parsed.data.effectiveOn); } catch { return invalid(reply, "INVALID_EFFECTIVE_DATE", "Invalid effective date."); }
    const changeSet = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await transaction.repository.createDraft({ ...parsed.data, actorAccountId: principal.id });
      await transaction.audit("organization.draft.created", "organization_change_set", snapshot.changeSet.id, snapshot.changeSet.id, {
        effectiveOn: snapshot.changeSet.effectiveOn,
        baseChangeSetId: snapshot.changeSet.baseChangeSetId,
      });
      return snapshot.changeSet;
    });
    return reply.status(201).send(changeSet);
  });

  app.get("/admin/organization/designer/drafts/:draftId", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    const parsed = draftParams.safeParse(request.params);
    if (!parsed.success) return invalid(reply, "INVALID_DRAFT_ID", "Invalid draft identifier.");
    const snapshot = await repository.loadChangeSetSnapshot(parsed.data.draftId);
    return snapshot ? reply.send(snapshot.changeSet) : reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND" });
  });

  app.post("/admin/organization/designer/drafts/:draftId/nodes", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params); const body = nodeInput.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_ORGANIZATION_NODE", "Invalid organization group.");
    const item = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository); if (!snapshot) return null;
      const created = { id: randomUUID(), stableKey: randomUUID(), ...body.data, integrationCode: body.data.integrationCode ?? null,
        active: true, effectiveFrom: snapshot.changeSet.effectiveOn, effectiveTo: null };
      snapshot.nodes.push(created); await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.node.created", "organization_node", created.id, snapshot.changeSet.id, { stableKey: created.stableKey });
      return created;
    });
    if (!item) return;
    return reply.status(201).send({ ...item, memberCount: 0, leaderPositionKey: null });
  });

  app.patch("/admin/organization/designer/drafts/:draftId/nodes/:itemId", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = itemParams.safeParse(request.params); const body = nodePatch.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_ORGANIZATION_NODE", "Invalid organization group update.");
    const result = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository); if (!snapshot) return null;
      const item = snapshot.nodes.find((entry) => entry.id === params.data.itemId);
      if (!item) { await reply.status(404).send({ code: "ORGANIZATION_NODE_NOT_FOUND" }); return null; }
      Object.assign(item, body.data); await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.node.updated", "organization_node", item.id, snapshot.changeSet.id, { fields: Object.keys(body.data) });
      return { item, snapshot };
    });
    if (!result) return;
    const { item, snapshot } = result;
    return reply.send({ ...item, memberCount: snapshot.memberships.filter((member) => member.nodeKey === item.stableKey).length,
      leaderPositionKey: snapshot.authorityBindings.find((binding) => binding.subjectKind === "NODE" && binding.subjectKey === item.stableKey && binding.bindingType === "LEADER")?.targetPositionKey ?? null });
  });

  app.post("/admin/organization/designer/drafts/:draftId/positions", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params); const body = positionInput.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_ORGANIZATION_POSITION", "Invalid organization position.");
    const item = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository); if (!snapshot) return null;
      const created = { id: randomUUID(), stableKey: randomUUID(), ...body.data, active: true,
        effectiveFrom: snapshot.changeSet.effectiveOn, effectiveTo: null };
      snapshot.positions.push(created); await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.position.created", "organization_position", created.id, snapshot.changeSet.id, { stableKey: created.stableKey });
      return created;
    });
    if (!item) return;
    return reply.status(201).send({ ...item, primaryIncumbent: null, actingIncumbent: null });
  });

  app.patch("/admin/organization/designer/drafts/:draftId/positions/:itemId", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = itemParams.safeParse(request.params); const body = positionPatch.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_ORGANIZATION_POSITION", "Invalid position update.");
    const item = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository); if (!snapshot) return null;
      const updated = snapshot.positions.find((entry) => entry.id === params.data.itemId);
      if (!updated) { await reply.status(404).send({ code: "ORGANIZATION_POSITION_NOT_FOUND" }); return null; }
      Object.assign(updated, body.data); await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.position.updated", "organization_position", updated.id, snapshot.changeSet.id, { fields: Object.keys(body.data) });
      return updated;
    });
    if (!item) return;
    return reply.send({ ...item, primaryIncumbent: null, actingIncumbent: null });
  });

  app.put("/admin/organization/designer/drafts/:draftId/memberships", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params); const body = membershipInput.safeParse(request.body);
    if (!params.success || !body.success || (body.data.effectiveTo && body.data.effectiveTo < body.data.effectiveFrom))
      return invalid(reply, "INVALID_ORGANIZATION_MEMBERSHIP", "Invalid membership assignment.");
    const mutated = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository); if (!snapshot) return false;
      snapshot.memberships = snapshot.memberships.filter((item) => item.nodeKey !== body.data.nodeKey);
      snapshot.memberships.push(...body.data.employeeIds.map((employeeId) => ({ id: randomUUID(), employeeId,
        nodeKey: body.data.nodeKey, jobProfileKey: null, isPrimary: true,
        effectiveFrom: body.data.effectiveFrom, effectiveTo: body.data.effectiveTo ?? null })));
      await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.memberships.replaced", "organization_node", null, snapshot.changeSet.id,
        { nodeKey: body.data.nodeKey, memberCount: body.data.employeeIds.length });
      return true;
    });
    if (!mutated) return;
    return reply.status(204).send();
  });

  app.put("/admin/organization/designer/drafts/:draftId/incumbencies", async (request, reply) => {
    const principal = await authenticate(request, reply, "approvals.policy.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params); const body = incumbencyInput.safeParse(request.body);
    if (!params.success || !body.success || (body.data.actingEmployeeId && (!body.data.actingFrom || !body.data.actingTo))
      || (body.data.actingFrom && body.data.actingTo && body.data.actingTo < body.data.actingFrom))
      return invalid(reply, "INVALID_ORGANIZATION_INCUMBENCY", "Invalid primary or acting assignment.");
    const mutated = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository); if (!snapshot) return false;
      snapshot.incumbencies = snapshot.incumbencies.filter((item) => item.positionKey !== body.data.positionKey);
      if (body.data.primaryEmployeeId) snapshot.incumbencies.push({ id: randomUUID(), positionKey: body.data.positionKey,
        employeeId: body.data.primaryEmployeeId, kind: "PRIMARY", effectiveFrom: body.data.effectiveFrom,
        effectiveTo: null, reason: null });
      if (body.data.actingEmployeeId) snapshot.incumbencies.push({ id: randomUUID(), positionKey: body.data.positionKey,
        employeeId: body.data.actingEmployeeId, kind: "ACTING", effectiveFrom: body.data.actingFrom!,
        effectiveTo: body.data.actingTo!, reason: "Explicit acting mandate" });
      await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.incumbencies.replaced", "organization_position", null, snapshot.changeSet.id,
        { positionKey: body.data.positionKey, vacant: !body.data.primaryEmployeeId, hasActing: Boolean(body.data.actingEmployeeId) });
      return true;
    });
    if (!mutated) return;
    return reply.status(204).send();
  });

  app.post("/admin/organization/designer/drafts/:draftId/authority-bindings", async (request, reply) => {
    const principal = await authenticate(request, reply, "approvals.policy.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params); const body = bindingInput.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_AUTHORITY_BINDING", "Invalid authority relationship.");
    const item = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository); if (!snapshot) return null;
      const created = { id: randomUUID(), subjectKind: body.data.sourceType, subjectKey: body.data.sourceKey,
        bindingType: body.data.authorityType as AuthorityBindingType, targetPositionKey: body.data.targetPositionKey,
        vacancyPolicy: body.data.vacancyPolicy, effectiveFrom: body.data.effectiveFrom, effectiveTo: body.data.effectiveTo ?? null };
      snapshot.authorityBindings.push(created); await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.authority_binding.created", "organization_authority_binding", created.id,
        snapshot.changeSet.id, { subjectKind: created.subjectKind, subjectKey: created.subjectKey, bindingType: created.bindingType, targetPositionKey: created.targetPositionKey });
      return created;
    });
    if (!item) return;
    return reply.status(201).send({ id: item.id, sourceType: item.subjectKind, sourceKey: item.subjectKey,
      authorityType: item.bindingType, targetPositionKey: item.targetPositionKey, vacancyPolicy: item.vacancyPolicy,
      effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo });
  });

  app.post("/admin/organization/designer/drafts/:draftId/reporting-overrides", async (request, reply) => {
    const principal = await authenticate(request, reply, "approvals.policy.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params); const body = overrideInput.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_REPORTING_OVERRIDE", "Invalid reporting override.");
    const item = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository); if (!snapshot) return null;
      const created = { id: randomUUID(), ...body.data, managerEmployeeId: null, effectiveTo: body.data.effectiveTo ?? null };
      snapshot.reportingOverrides.push(created); await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.reporting_override.created", "organization_reporting_override", created.id,
        snapshot.changeSet.id, { employeeId: created.employeeId, managerPositionKey: created.managerPositionKey, reason: created.reason,
          effectiveFrom: created.effectiveFrom, effectiveTo: created.effectiveTo });
      return created;
    });
    if (!item) return;
    return reply.status(201).send(item);
  });

  app.post("/admin/organization/designer/drafts/:draftId/validate", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params); if (!params.success) return invalid(reply, "INVALID_DRAFT_ID", "Invalid draft identifier.");
    const report = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await transaction.repository.loadChangeSetSnapshot(params.data.draftId);
      if (!snapshot || snapshot.changeSet.status === "PUBLISHED") {
        await reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND" });
        return null;
      }
      const result = await transaction.draftService.validateDraft(snapshot.changeSet.id, principal.id);
      await transaction.audit("organization.draft.validated", "organization_change_set", snapshot.changeSet.id,
        snapshot.changeSet.id, { valid: result.valid, issueCodes: result.issues.map((issue) => issue.code) });
      return result;
    });
    if (!report) return;
    return reply.send({ valid: report.valid, issues: report.issues.map((issue) => ({ ...issue, severity: "ERROR", itemKey: issue.entityId ?? null })) });
  });

  app.get("/admin/organization/designer/drafts/:draftId/impact", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    const params = draftParams.safeParse(request.params); if (!params.success) return invalid(reply, "INVALID_DRAFT_ID", "Invalid draft identifier.");
    const snapshot = await repository.loadChangeSetSnapshot(params.data.draftId);
    if (!snapshot) return reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND" });
    const impact = await draftService.previewImpact(snapshot.changeSet.id);
    const pureVisual = impact.visualOnly;
    return reply.send({ directManagerChanges: impact.directManagerChanges, unitApproverChanges: impact.unitApproverChanges,
      authorityPathsAffected: impact.affectedAuthorityPaths.map((path) => ({ path })),
      vacantAuthorities: impact.vacantPositionKeys.map((positionKey) => ({ positionKey })),
      unresolvedEmployees: impact.unresolvedEmployeeIds.map((employeeId) => ({ employeeId })),
      visualOnlyChanges: pureVisual ? [{ change: "VISUAL_RANK_ONLY", approvalRoutingImpact: "NONE" }] : [],
      noApprovalRoutingImpact: pureVisual });
  });

  app.post("/admin/organization/designer/drafts/:draftId/resolution-preview", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    const params = draftParams.safeParse(request.params); const body = resolutionInput.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_RESOLUTION_PREVIEW", "Invalid resolution preview input.");
    const snapshot = await repository.loadChangeSetSnapshot(params.data.draftId);
    if (!snapshot) return reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND" });
    const resolver = new OrganizationAuthorityResolver({ loadEffectiveSnapshot: async () => snapshot }, { eligibilityValidator: repository });
    try {
      const result = await resolver.resolveLineAuthorities({ requesterEmployeeId: body.data.employeeId,
        effectiveDate: body.data.effectiveDate, workflowKey: body.data.workflowKey, requiredCapability: "leave.approve" });
      const ids = [...new Set([body.data.employeeId, ...result.authorities.map((item) => item.employeeId)])];
      const employees = await pool.query<{ id: string; employeeNumber: string; fullName: string }>(
        `SELECT id, employee_number AS "employeeNumber", full_name AS "fullName" FROM employees WHERE id = ANY($1::uuid[])`, [ids]);
      const byId = new Map(employees.rows.map((item) => [item.id, item]));
      return reply.send({ employee: byId.get(body.data.employeeId) ?? { id: body.data.employeeId, fullName: "Unknown employee" },
        effectiveDate: result.effectiveDate, workflowKey: body.data.workflowKey,
        steps: result.authorities.map((item) => ({ authorityType: (item.sources ?? [item.source]).join(" + "), employeeId: item.employeeId,
          employeeName: byId.get(item.employeeId)?.fullName ?? "Unknown employee",
          positionTitle: snapshot.positions.find((position) => position.stableKey === item.positionKey)?.title ?? null,
          source: item.incumbentKind })), oversight: null, warnings: [] });
    } catch (error) {
      const item = error as { code?: string; message?: string };
      return reply.status(409).send({ code: item.code ?? "ORGANIZATION_RESOLUTION_FAILED", message: item.message ?? "Authority cannot be resolved." });
    }
  });

  app.post("/admin/organization/designer/drafts/:draftId/publish", async (request, reply) => {
    const principal = await authenticate(request, reply, "approvals.policy.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params); if (!params.success) return invalid(reply, "INVALID_DRAFT_ID", "Invalid draft identifier.");
    const changeSet = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await transaction.repository.loadChangeSetSnapshot(params.data.draftId);
      if (!snapshot) { await reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND" }); return null; }
      if (snapshot.changeSet.status !== "VALIDATED") {
        await reply.status(409).send({ code: "ORGANIZATION_DRAFT_NOT_VALIDATED", message: "Validate the draft before publishing." });
        return null;
      }
      await transaction.draftService.publish(snapshot.changeSet.id, principal.id);
      await transaction.audit("organization.draft.published", "organization_change_set", snapshot.changeSet.id,
        snapshot.changeSet.id, { effectiveOn: snapshot.changeSet.effectiveOn });
      return (await transaction.repository.loadChangeSetSnapshot(snapshot.changeSet.id))!.changeSet;
    });
    if (!changeSet) return;
    return reply.send(changeSet);
  });

  app.get("/admin/organization/rollout", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    const result = await pool.query(
      `SELECT mode, workflow_key AS "workflowKey", node_key AS "organizationalNodeKey",
        effective_from AS "effectiveFrom", effective_to AS "effectiveTo", reason, updated_at AS "updatedAt"
       FROM organization_rollout_settings ORDER BY created_at DESC LIMIT 1`,
    );
    return reply.send(result.rows[0] ?? { mode: "LEGACY", workflowKey: "LEAVE", organizationalNodeKey: null });
  });

  app.patch("/admin/organization/rollout", async (request, reply) => {
    const principal = await authenticate(request, reply, "approvals.policy.manage"); if (!principal) return;
    const body = rolloutInput.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_ORGANIZATION_ROLLOUT", "Invalid rollout configuration.");
    const item = { id: randomUUID(), ...body.data, organizationalNodeKey: body.data.organizationalNodeKey ?? null,
      effectiveFrom: body.data.effectiveFrom ?? jakartaBusinessDate(), effectiveTo: body.data.effectiveTo ?? null,
      reason: body.data.reason ?? "Organization Designer rollout update" };
    await atomicOrganizationMutation(pool, principal, async (transaction) => {
      await transaction.client.query(
        `INSERT INTO organization_rollout_settings
          (id, workflow_key, node_key, mode, effective_from, effective_to, reason, changed_by_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [item.id, item.workflowKey, item.organizationalNodeKey, item.mode, item.effectiveFrom, item.effectiveTo, item.reason, principal.id],
      );
      await transaction.audit("organization.rollout.changed", "organization_rollout_setting", item.id, null,
        { workflowKey: item.workflowKey, organizationalNodeKey: item.organizationalNodeKey, mode: item.mode,
          effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo, reason: item.reason });
    });
    return reply.send({ ...item, updatedAt: new Date().toISOString() });
  });
}
