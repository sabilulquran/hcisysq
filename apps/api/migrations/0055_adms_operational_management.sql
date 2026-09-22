-- ATT-012: ADMS operational device lifecycle and retirement evidence.
-- Additive: no raw attendance or biometric evidence is deleted.

ALTER TABLE attendance_adms_devices
  DROP CONSTRAINT IF EXISTS attendance_adms_devices_lifecycle_check;

ALTER TABLE attendance_adms_devices
  ADD CONSTRAINT attendance_adms_devices_lifecycle_check
    CHECK (lifecycle IN ('active', 'disabled', 'quarantined', 'retired'));

ALTER TABLE attendance_adms_devices
  ADD COLUMN IF NOT EXISTS retired_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS retired_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retirement_note text NULL,
  ADD COLUMN IF NOT EXISTS replaced_by_device_id uuid NULL REFERENCES attendance_adms_devices(id) ON DELETE RESTRICT;

ALTER TABLE attendance_adms_devices
  DROP CONSTRAINT IF EXISTS attendance_adms_devices_retirement_shape_check,
  DROP CONSTRAINT IF EXISTS attendance_adms_devices_replacement_not_self_check;

ALTER TABLE attendance_adms_devices
  ADD CONSTRAINT attendance_adms_devices_retirement_shape_check
    CHECK (
      (
        lifecycle = 'retired'
        AND retired_at IS NOT NULL
        AND retirement_note IS NOT NULL
        AND char_length(retirement_note) BETWEEN 5 AND 500
      )
      OR (
        lifecycle <> 'retired'
        AND retired_at IS NULL
        AND retired_by_account_id IS NULL
        AND retirement_note IS NULL
        AND replaced_by_device_id IS NULL
      )
    ),
  ADD CONSTRAINT attendance_adms_devices_replacement_not_self_check
    CHECK (replaced_by_device_id IS NULL OR replaced_by_device_id <> id);

CREATE INDEX IF NOT EXISTS attendance_adms_devices_replacement_idx
  ON attendance_adms_devices (replaced_by_device_id)
  WHERE replaced_by_device_id IS NOT NULL;

ALTER TABLE attendance_adms_admin_audit_events
  DROP CONSTRAINT IF EXISTS attendance_adms_admin_audit_events_action_check;
ALTER TABLE attendance_adms_admin_audit_events
  ADD CONSTRAINT attendance_adms_admin_audit_events_action_check
    CHECK (action IN (
      'device_registered', 'device_updated', 'mapping_created', 'mapping_ended',
      'device_claimed', 'transfer_requested', 'command_requested', 'command_cancelled',
      'device_user_correction_planned', 'device_user_correction_cancelled',
      'device_user_correction_resolved',
      'work_code_saved', 'work_code_target_updated',
      'device_message_saved', 'device_message_target_updated',
      'offline_attlog_imported', 'saved_filter_saved', 'saved_filter_deleted',
      'pending_commands_cleared', 'physical_operation_requested',
      'physical_capability_updated', 'firmware_package_uploaded',
      'wdms_device_profile_updated', 'job_code_saved', 'device_retired'
    ));
