-- AUTH-011 / ATT-004: reconcile Human Capital Administrator role description
-- with the non-destructive ADMS capabilities granted by migration 0050.
--
-- This changes descriptive metadata only. Permission semantics remain unchanged.

UPDATE roles
SET description = 'HCIS domain administration with organization scope, including standard non-destructive ADMS operations. Excludes workflow approval authority and destructive, firmware, or biometric device authority.',
    updated_at = now()
WHERE role_key = 'human_capital_admin';
