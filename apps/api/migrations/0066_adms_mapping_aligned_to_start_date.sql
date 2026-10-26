-- ADMS-R2c (ATT-014 §20.5, D-14-20): audit action for "Sesuaikan dengan TMT".
-- Additive: the old release never writes this action, so it runs unchanged on the new constraint.
-- Rollback: re-add the previous list (0055) once no row uses the new action.
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
      'wdms_device_profile_updated', 'job_code_saved', 'device_retired',
      'mapping_aligned_to_start_date'
    ));
