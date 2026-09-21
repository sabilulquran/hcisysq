-- HCIS Human Capital Admin: standard non-destructive ADMS operations.
-- Destructive, firmware and biometric permissions remain separately privileged.

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, permission_key
FROM roles role
CROSS JOIN unnest(ARRAY[
  'attendance.devices.read',
  'attendance.devices.configure',
  'attendance.devices.operate',
  'attendance.devices.export'
]::text[]) AS permission_key
WHERE role.role_key = 'human_capital_admin'
ON CONFLICT DO NOTHING;
