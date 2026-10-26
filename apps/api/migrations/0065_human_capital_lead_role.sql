-- ORG-008-8 (decision O-1) and AUTH-011: the Kepala HC role.
-- docs/domain/organization-designer-ux-spec.md 2, 8; docs/domain/hcis-authorization-modernization.md.
--
-- Owner decisions:
--   2026-10-16 (O-1): HC administrators compose every part of a change set; publishing stays with a
--     second person who holds approvals.policy.manage.
--   2026-10-24: that second person is a new Kepala HC role, holding approvals.policy.manage in full
--     as AUTH-011 defines it — publishing structure, changing direct managers and unit leave
--     approvers, authority bindings, reporting exceptions, incumbencies, and resolver rollout.
--
-- Until now no role held approvals.policy.manage at all; the only holder was legacy Super Admin
-- compatibility, which also carries every other administrative permission. This role gives the
-- second pair of eyes exactly what that job needs and nothing else.
--
-- It also carries organization.manage, because the person who approves a structure has to be able
-- to open and read it. It deliberately carries nothing from the HC operational bundle: an account
-- that also does day-to-day HC work holds human_capital_admin alongside it.
--
-- Additive vocabulary only. No account is assigned here and no real identity appears. Only Super
-- Admin grants roles (owner decision 2026-10-16), with organization scope and a stated mandate.
-- Idempotent: rerunning changes nothing further.
--
-- Rollback/recovery:
--   1. Remove every assignment of this role through the reviewed route
--      DELETE /admin/access/role-assignments/:assignmentId (writes role.assignment.removed).
--   2. DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE role_key = 'human_capital_lead');
--      DELETE FROM roles WHERE role_key = 'human_capital_lead';
--   Publishing then falls back to legacy Super Admin compatibility, as before this migration.
--   Audit rows are never deleted.

INSERT INTO roles (id, role_key, name, description, is_system) VALUES
  ('10000000-0000-4000-8000-000000000011', 'human_capital_lead', 'Kepala Human Capital',
   'ORG-008-8 (O-1): pemeriksa kedua yang menerbitkan struktur organisasi dan mengelola kebijakan persetujuan (atasan langsung, penyetuju cuti unit, kewenangan, rollout). Hanya Super Admin yang memberikan; scope organisasi dan alasan penugasan wajib.', true)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY[
  'organization.manage',
  'approvals.policy.manage'
]::text[]) AS permission_key
WHERE role.role_key = 'human_capital_lead'
ON CONFLICT DO NOTHING;
