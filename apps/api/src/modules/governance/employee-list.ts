import type { Pool } from "pg";
import { z } from "zod";

import { pagination, pageOffset, pageQuerySchema } from "../../lib/pagination.js";

/** ORG-014 query: ENG-LIST-001 page/pageSize, a name or NIP search and a unit filter. */
export const employeeListQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().min(2).max(80).optional(),
  unitId: z.string().uuid().optional(),
});

export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>;

export interface OrganEmployeeRow {
  fullName: string;
  employeeNumber: string;
  unitName: string | null;
  position: string | null;
  employmentStatus: string | null;
  startedOn: string | null;
}

/**
 * ORG-014: active employees only, and only these six fields. Contact details, identity numbers,
 * education, documents, attendance, leave and pay never leave HCIS through this list.
 */
export async function loadOrganEmployeeList(pool: Pool, query: EmployeeListQuery) {
  const values = [query.q ?? null, query.unitId ?? null];
  const where = `
    WHERE e.status = 'active' AND e.removed_at IS NULL
      AND ($1::text IS NULL OR e.full_name ILIKE '%' || $1 || '%' OR e.employee_number ILIKE '%' || $1 || '%')
      AND ($2::uuid IS NULL OR e.organizational_unit_id = $2)`;
  const [items, count, units] = await Promise.all([
    pool.query<OrganEmployeeRow>(
      `SELECT e.full_name AS "fullName",
              e.employee_number AS "employeeNumber",
              u.name AS "unitName",
              COALESCE(NULLIF(btrim(e.structural_position), ''), NULLIF(btrim(e.functional_position), ''), p.name) AS position,
              e.employment_status AS "employmentStatus",
              to_char(e.started_on, 'YYYY-MM-DD') AS "startedOn"
       FROM employees e
       LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
       LEFT JOIN positions p ON p.id = e.position_id
       ${where}
       ORDER BY e.full_name ASC, e.employee_number ASC
       LIMIT $3 OFFSET $4`,
      [...values, query.pageSize, pageOffset(query)],
    ),
    pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM employees e ${where}`, values),
    pool.query<{ id: string; name: string }>(
      `SELECT DISTINCT u.id, u.name
       FROM organizational_units u
       JOIN employees e ON e.organizational_unit_id = u.id AND e.status = 'active' AND e.removed_at IS NULL
       ORDER BY u.name`,
    ),
  ]);
  return {
    items: items.rows,
    pagination: pagination(query, count.rows[0]?.total ?? 0),
    units: units.rows,
  };
}
