import { z } from "zod";

export const ORGANIZATION_DIRECTORY_SCHEMA_VERSION = "hcis-organization-directory.v1";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sha256Version = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const unitId = z.string().regex(/^hcis:org-node:[0-9a-f-]{36}$/);
const positionId = z.string().regex(/^hcis:org-position:[0-9a-f-]{36}$/);
const personId = z.string().regex(/^hcis:employee:[0-9a-f-]{36}$/);

export const organizationDirectoryUnitSchema = z.object({
  id: unitId,
  name: z.string().trim().min(1),
  nodeType: z.string().trim().min(1),
  parentUnitId: unitId.nullable(),
  active: z.boolean(),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable(),
}).strict();

export const organizationDirectoryPositionSchema = z.object({
  id: positionId,
  unitId,
  title: z.string().trim().min(1),
  parentPositionId: positionId.nullable(),
  active: z.boolean(),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable(),
}).strict();

export const organizationDirectoryIdentityRefSchema = z.object({
  issuer: z.string().url(),
  subject: z.string().min(1),
}).strict();

export const organizationDirectoryPersonSchema = z.object({
  id: personId,
  employeeNumber: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  active: z.boolean(),
  employmentStatus: z.string().nullable(),
  startedOn: isoDate.nullable(),
  endedOn: isoDate.nullable(),
  currentPrimaryUnitId: unitId.nullable(),
  structuralPositionIds: z.array(positionId),
  primaryStructuralPositionId: positionId.nullable(),
  identityRefs: z.array(organizationDirectoryIdentityRefSchema),
}).strict();

export const organizationDirectorySnapshotSchema = z.object({
  schemaVersion: z.literal(ORGANIZATION_DIRECTORY_SCHEMA_VERSION),
  source: z.object({
    system: z.literal("hcis"),
    snapshotId: z.string().uuid(),
    effectiveOn: isoDate,
    publishedAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  }).strict(),
  asOf: isoDate,
  version: sha256Version,
  generatedAt: z.string().datetime(),
  counts: z.object({
    units: z.number().int().nonnegative(),
    positions: z.number().int().nonnegative(),
    people: z.number().int().nonnegative(),
  }).strict(),
  units: z.array(organizationDirectoryUnitSchema),
  positions: z.array(organizationDirectoryPositionSchema),
  people: z.array(organizationDirectoryPersonSchema),
}).strict();

export type OrganizationDirectorySnapshot = z.infer<typeof organizationDirectorySnapshotSchema>;
export type OrganizationDirectoryUnit = z.infer<typeof organizationDirectoryUnitSchema>;
export type OrganizationDirectoryPosition = z.infer<typeof organizationDirectoryPositionSchema>;
export type OrganizationDirectoryPerson = z.infer<typeof organizationDirectoryPersonSchema>;
