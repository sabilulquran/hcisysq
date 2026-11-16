-- DOC-001 Package 2: activate the surat keterangan penghasilan (KETERANGAN_PENGHASILAN).
-- Spec: docs/domain/hr-documents.md §3 D-21..D-25, §14.
--
-- 0093 put the type in the catalog with available = false (DOC-001-I). Its figures now come from
-- the official published payslips (D-21), so the type opens for self request and HC issuance.
-- Only the flag changes: the code, label, number code SKP and the active-employment rule stay as
-- 0093 wrote them, and no letter, counter or payslip row is touched. Re-running is harmless.
--
-- Down (closes the type again; letters already issued keep their numbers and stay readable):
--   UPDATE hr_document_types SET available = false WHERE code = 'KETERANGAN_PENGHASILAN';
--   Requests still SUBMITTED or APPROVED for this type can then no longer be issued (the issue
--   route answers 409 DOCUMENT_TYPE_UNAVAILABLE); HC rejects them with a note.

UPDATE hr_document_types
   SET available = true
 WHERE code = 'KETERANGAN_PENGHASILAN';
