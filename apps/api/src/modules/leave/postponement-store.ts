// LEAVE-008 read model: what the requester's leave history shows about a postponement.
// Spec: docs/domain/leave-postponement.md §9.

/** Latest proposal of a request, as one JSON column. `alias` is the leave_requests alias. */
export function postponementJoin(alias: string) {
  return `LEFT JOIN LATERAL (
      SELECT json_build_object(
        'id', proposal.id,
        'status', proposal.status,
        'proposedStartOn', proposal.proposed_start_on::text,
        'proposedEndOn', proposal.proposed_end_on::text,
        'proposedWorkingDays', proposal.proposed_working_days,
        'note', proposal.note,
        'proposedByName', CASE
          WHEN proposer.id IS NOT NULL THEN proposer.full_name
          ELSE 'Penyetuju Pengurus Yayasan'
        END,
        'proposedAt', proposal.created_at,
        'respondedAt', proposal.responded_at,
        'replacementRequestId', proposal.replacement_request_id
      ) AS item
      FROM leave_postponement_proposals proposal
      LEFT JOIN employees proposer ON proposer.id = proposal.proposed_by_employee_id
      WHERE proposal.leave_request_id = ${alias}.id
      ORDER BY proposal.created_at DESC
      LIMIT 1
    ) postponement ON true`;
}

export function postponementColumns(alias: string) {
  return `postponement.item AS "postponement",
      ${alias}.replaces_request_id AS "replacesRequestId",
      (${alias}.status = 'postponement_proposed') AS "canRespondToPostponement"`;
}

export interface PostponementView {
  id: string;
  status: "proposed" | "accepted" | "declined";
  proposedStartOn: string;
  proposedEndOn: string;
  proposedWorkingDays: number;
  note: string;
  proposedByName: string;
  proposedAt: string;
  respondedAt: string | null;
  replacementRequestId: string | null;
}
