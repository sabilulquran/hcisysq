-- ORG-011: Kepala Human Capital also manages the classification and grade catalogs.
-- Spec: docs/domain/job-classification-grade.md §5 and §8. ADR: ADR-0004.
--
-- Owner decision 2026-10-30. Migration 0110 granted job_classifications.read/.manage to
-- human_capital_admin only, recorded there as a DRAFT default that the owner had not yet
-- ruled on. The owner has now ruled: Kepala HC manages the catalog as well.
--
-- This is a classification catalog, not an approval: ORG-011 carries no money and no
-- authority (ADR-0004 §2-3), so granting it does not widen what Kepala HC can approve or
-- publish. Both keys stay organization-scoped and are still never reached through legacy
-- Super Admin compatibility.
--
-- Deployment order, as for 0110: the build that knows these keys must already be running
-- when this migration applies, or the old build briefly refuses to assign human_capital_lead.
-- See docs/development/mi8vps-hcis-release.md §4.5.
--
-- Down:
--   DELETE FROM role_permissions
--    WHERE permission_key IN ('job_classifications.read', 'job_classifications.manage')
--      AND role_id IN (SELECT id FROM roles WHERE role_key = 'human_capital_lead');
--   (The permissions themselves and the human_capital_admin grant belong to 0110.)

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role
CROSS JOIN unnest(ARRAY['job_classifications.read', 'job_classifications.manage']::text[]) AS permission_key
WHERE role.role_key = 'human_capital_lead'
ON CONFLICT DO NOTHING;
