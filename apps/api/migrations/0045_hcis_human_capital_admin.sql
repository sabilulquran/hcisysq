-- AUTH-011: additive role vocabulary only; never assign an account here.
INSERT INTO permissions (permission_key, description) VALUES
  ('organization.manage', 'AUTH-011: organization.manage'),
  ('access.manage', 'AUTH-011: access.manage'),
  ('access.roles.assign', 'AUTH-011: access.roles.assign'),
  ('leave.configuration.manage', 'AUTH-011: leave.configuration.manage'),
  ('attendance.records.manage', 'AUTH-011: attendance.records.manage'),
  ('access.roles.delegate', 'AUTH-011: access.roles.delegate'),
  ('access.governance.manage', 'AUTH-011: access.governance.manage'),
  ('approvals.policy.manage', 'AUTH-011: approvals.policy.manage'),
  ('attendance.devices.read', 'AUTH-011: attendance.devices.read'),
  ('attendance.devices.configure', 'AUTH-011: attendance.devices.configure'),
  ('attendance.devices.operate', 'AUTH-011: attendance.devices.operate'),
  ('attendance.devices.export', 'AUTH-011: attendance.devices.export'),
  ('attendance.devices.destructive', 'AUTH-011: attendance.devices.destructive'),
  ('attendance.devices.firmware', 'AUTH-011: attendance.devices.firmware'),
  ('attendance.devices.biometrics', 'AUTH-011: attendance.devices.biometrics')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO roles (id, role_key, name, description, is_system) VALUES
  ('10000000-0000-4000-8000-000000000006', 'human_capital_admin', 'Human Capital Administrator',
   'HCIS domain administration; explicit organization scope. Excludes technical and approval authority.', true)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role CROSS JOIN unnest(ARRAY[
  'employees.manage',
  'employees.read.all',
  'leave.validate',
  'leave.evidence.read',
  'attendance.resolution.read',
  'attendance.resolution.manage',
  'payslips.import',
  'payslips.publish',
  'organization.manage',
  'access.manage',
  'access.roles.assign',
  'leave.configuration.manage',
  'attendance.records.manage'
]::text[]) AS permission_key
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;
