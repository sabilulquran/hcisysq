-- ADMS-R2d (ATT-014 §20.13): "Ganti pegawai" corrects a PIN mapped to the wrong employee, and the
-- legacy daily projection removes the ADMS row of a day whose scans all left that employee.
-- Additive: the old release never writes these actions, so it runs unchanged on the new constraints.
-- Rollback: re-add the 0067 list and the 0022 list once no row uses the new actions.
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
      'mapping_aligned_to_start_date', 'mapping_alignment_reverted',
      'mapping_reassigned'
    ));

ALTER TABLE attendance_adms_projection_audit_events
  DROP CONSTRAINT IF EXISTS attendance_adms_projection_audit_events_action_check;
ALTER TABLE attendance_adms_projection_audit_events
  ADD CONSTRAINT attendance_adms_projection_audit_events_action_check
    CHECK (action IN (
      'created', 'updated', 'skipped_manual_conflict', 'skipped_foreign_integration', 'cleared'
    ));
