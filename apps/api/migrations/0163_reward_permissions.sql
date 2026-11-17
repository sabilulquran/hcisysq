-- REWARD-001 Package 1: permission vocabulary. Spec: docs/domain/rewards.md §7.
-- No account assignment is created here.
--
-- reward.read   — human_capital_admin and human_capital_lead.
-- reward.manage — human_capital_lead (Kepala HCM) only (DRAFT).
-- reward.import — human_capital_admin only (R-14 DRAFT): the manual snapshot is prepared by HC
--                 and decided by the Kepala HCM, so one account does not both supply and pick.
-- None of them reaches Super Admin through legacy compatibility.
--
-- Deployment order (OPS-MI8-REL-001 §4.5): between migrate and cutover the old build sees these
-- keys on two roles it cannot yet delegate; nothing widens and the window ends at cutover.
--
-- Down: DELETE FROM role_permissions WHERE permission_key LIKE 'reward.%';
--       DELETE FROM permissions WHERE permission_key LIKE 'reward.%';
INSERT INTO permissions (permission_key, description) VALUES
  ('reward.read', 'REWARD-001: read award rounds, candidates and the award audit'),
  ('reward.manage', 'REWARD-001: build, decide, publish, cancel award rounds and revoke awards'),
  ('reward.import', 'REWARD-001: import a monthly scoreboard snapshot from CSV while the Al-Qur''an source is not configured')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY['reward.read', 'reward.import']::text[]) AS permission_key
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY['reward.read', 'reward.manage']::text[]) AS permission_key
WHERE role.role_key = 'human_capital_lead'
ON CONFLICT DO NOTHING;
