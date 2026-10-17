import type { Pool } from "pg";

// ORG-003 aggregates, shared by GET /board/dashboard and the ORG-010 governance summary.
// Aggregate only: no names, numbers, contact data or per-person rows leave this module.

export interface EmployeeStatusCounts {
  active: number;
  inactive: number;
  resigned: number;
  total: number;
}

export interface EntitlementCounts {
  education: number;
  nonEducation: number;
  unclassified: number;
}

export interface ReadinessCounts {
  activeEmployees: number;
  withDirectManager: number;
  withoutDirectManager: number;
  activeUnits: number;
  unitsWithApprover: number;
  unitsWithoutApprover: number;
}

export interface WorkflowCounts {
  leaveInReview: number;
  hcValidationPending: number;
  attendanceResolutionOpen: number;
}

export interface MovementCounts {
  startedThisYear: number;
  endedThisYear: number;
}

export interface UnitDistributionRow {
  unitName: string;
  employeeCount: number;
}

export interface EmploymentStatusRow {
  employmentStatus: string;
  employeeCount: number;
}

export interface BoardAggregates {
  generatedAt: string;
  employees: EmployeeStatusCounts;
  entitlementGroups: EntitlementCounts;
  approvalReadiness: ReadinessCounts;
  workflow: WorkflowCounts;
  movements: MovementCounts;
  unitDistribution: UnitDistributionRow[];
  employmentStatus: EmploymentStatusRow[];
}

export async function loadBoardAggregates(pool: Pick<Pool, "query">): Promise<BoardAggregates> {
  const [
    employeeStatus,
    entitlement,
    readiness,
    workflow,
    movements,
    unitDistribution,
    employmentStatus,
  ] = await Promise.all([
    pool.query<EmployeeStatusCounts>(
      `SELECT
        count(*) FILTER (WHERE status = 'active')::int AS active,
        count(*) FILTER (WHERE status = 'inactive')::int AS inactive,
        count(*) FILTER (WHERE status = 'resigned')::int AS resigned,
        count(*)::int AS total
      FROM employees`,
    ),
    pool.query<EntitlementCounts>(
      `SELECT
        count(*) FILTER (
          WHERE status = 'active' AND leave_entitlement_group = 'education'
        )::int AS education,
        count(*) FILTER (
          WHERE status = 'active' AND leave_entitlement_group = 'non_education'
        )::int AS "nonEducation",
        count(*) FILTER (
          WHERE status = 'active' AND leave_entitlement_group IS NULL
        )::int AS unclassified
      FROM employees`,
    ),
    pool.query<ReadinessCounts>(
      `WITH active_units AS (
        SELECT DISTINCT organizational_unit_id AS id
        FROM employees
        WHERE status = 'active' AND organizational_unit_id IS NOT NULL
      )
      SELECT
        (SELECT count(*)::int FROM employees WHERE status = 'active') AS "activeEmployees",
        (SELECT count(*)::int FROM employees WHERE status = 'active' AND direct_manager_employee_id IS NOT NULL) AS "withDirectManager",
        (SELECT count(*)::int FROM employees WHERE status = 'active' AND direct_manager_employee_id IS NULL) AS "withoutDirectManager",
        (SELECT count(*)::int FROM active_units) AS "activeUnits",
        (SELECT count(*)::int
           FROM organizational_units unit
           JOIN active_units active_unit ON active_unit.id = unit.id
          WHERE unit.leave_approver_employee_id IS NOT NULL) AS "unitsWithApprover",
        (SELECT count(*)::int
           FROM organizational_units unit
           JOIN active_units active_unit ON active_unit.id = unit.id
          WHERE unit.leave_approver_employee_id IS NULL) AS "unitsWithoutApprover"`,
    ),
    pool.query<WorkflowCounts>(
      `SELECT
        (SELECT count(*)::int FROM leave_requests WHERE status = 'in_review') AS "leaveInReview",
        (SELECT count(*)::int
           FROM leave_request_hc_tasks
          WHERE task_kind = 'validate' AND status = 'pending') AS "hcValidationPending",
        (SELECT count(*)::int
           FROM attendance_resolution_cases
          WHERE status IN ('open', 'awaiting_employee')) AS "attendanceResolutionOpen"`,
    ),
    pool.query<MovementCounts>(
      `SELECT
        count(*) FILTER (
          WHERE started_on >= date_trunc('year', current_date)::date
            AND started_on < (date_trunc('year', current_date) + interval '1 year')::date
        )::int AS "startedThisYear",
        count(*) FILTER (
          WHERE ended_on >= date_trunc('year', current_date)::date
            AND ended_on < (date_trunc('year', current_date) + interval '1 year')::date
        )::int AS "endedThisYear"
      FROM employees`,
    ),
    pool.query<UnitDistributionRow>(
      `SELECT
        coalesce(unit.name, 'Tanpa Unit') AS "unitName",
        count(*)::int AS "employeeCount"
      FROM employees employee
      LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
      WHERE employee.status = 'active'
      GROUP BY coalesce(unit.name, 'Tanpa Unit')
      ORDER BY count(*) DESC, coalesce(unit.name, 'Tanpa Unit') ASC`,
    ),
    pool.query<EmploymentStatusRow>(
      `SELECT
        coalesce(nullif(trim(employment_status), ''), 'Belum diklasifikasikan') AS "employmentStatus",
        count(*)::int AS "employeeCount"
      FROM employees
      WHERE status = 'active'
      GROUP BY coalesce(nullif(trim(employment_status), ''), 'Belum diklasifikasikan')
      ORDER BY count(*) DESC, coalesce(nullif(trim(employment_status), ''), 'Belum diklasifikasikan') ASC`,
    ),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    employees: employeeStatus.rows[0] ?? {
      active: 0,
      inactive: 0,
      resigned: 0,
      total: 0,
    },
    entitlementGroups: entitlement.rows[0] ?? {
      education: 0,
      nonEducation: 0,
      unclassified: 0,
    },
    approvalReadiness: readiness.rows[0] ?? {
      activeEmployees: 0,
      withDirectManager: 0,
      withoutDirectManager: 0,
      activeUnits: 0,
      unitsWithApprover: 0,
      unitsWithoutApprover: 0,
    },
    workflow: workflow.rows[0] ?? {
      leaveInReview: 0,
      hcValidationPending: 0,
      attendanceResolutionOpen: 0,
    },
    movements: movements.rows[0] ?? {
      startedThisYear: 0,
      endedThisYear: 0,
    },
    unitDistribution: unitDistribution.rows,
    employmentStatus: employmentStatus.rows,
  };
}
