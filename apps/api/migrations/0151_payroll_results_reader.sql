-- PAY-003: a read permission of its own for per-person payroll figures.
-- Spec: docs/domain/payroll-calculation-v1.md §2 and §7.3.
--
-- Until now the per-person results, the period inputs and the period comparison were readable by
-- anyone holding payroll.periods.manage, which hcis_module_admin carries to run the lifecycle, and
-- after approval by anyone holding any payroll permission at all. Running a period, approving it or
-- confirming its payment is not a licence to read each person's pay. From this migration on the
-- per-person figures need payroll.results.read.organization, or one of the two permissions whose
-- holders build those figures (payroll.calculate, payroll.inputs.manage).
--
-- DRAFT (default agent 2026-11-17): the key goes to the two roles that read per-person figures
-- today through payroll.reports.read.organization and need them for their decision — Direktur
-- (approves the period, reviews per person) and Kepala Keuangan (confirms payment against the
-- transfer list). Kepala Human Capital already reads them through payroll.calculate and
-- payroll.inputs.manage. hcis_module_admin, finance_officer and the Foundation Board receive nothing.
-- Super Admin does not receive it through legacy compatibility (ADR-0003).
--
-- Deployment order (OPS-MI8-REL-001 §4.5): between migrate and cutover the old build sees a key it
-- does not check; nothing widens and the window ends at cutover, when the module administrator
-- loses the per-person read it should never have had.
--
-- Down: DELETE FROM role_permissions WHERE permission_key = 'payroll.results.read.organization';
--       DELETE FROM permissions WHERE permission_key = 'payroll.results.read.organization';
--       and redeploy the previous build, whose guards do not know the key.
INSERT INTO permissions (permission_key, description) VALUES
  ('payroll.results.read.organization',
   'PAY-003: membaca angka payroll per orang (hasil, input periode, perbandingan, PPh21) setelah periode disahkan')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT role.id, 'payroll.results.read.organization'
FROM roles role
WHERE role.role_key IN ('director', 'finance_lead')
ON CONFLICT DO NOTHING;
