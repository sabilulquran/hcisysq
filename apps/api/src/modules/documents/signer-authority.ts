// Signer authority shared by issued HCIS documents.
//
// The rule comes from PAYSLIP-005 (`docs/domain/payslip-a4-signer-authority.md`):
// Kepala Human Capital Management first, Direktur as fallback, and never a
// self-signed document. DOC-001 reuses it unchanged (`docs/domain/hr-documents.md` D-05).
// Moved here from modules/payslips/routes.ts; behaviour is identical.

import type { Pool, PoolClient } from "pg";

type QueryTarget = Pool | PoolClient;

export type SignerTitle = "Kepala Human Capital Management" | "Direktur";

export interface SignerCandidate {
  employeeId: string;
  name: string;
}

async function findDynamicSignerCandidate(
  database: QueryTarget,
  role: "hcm" | "director",
): Promise<SignerCandidate | null> {
  const result = await database.query<SignerCandidate>(
    `WITH latest AS (
       SELECT id
         FROM organization_change_sets
        WHERE status = 'PUBLISHED'
          AND effective_on <= current_date
        ORDER BY effective_on DESC, published_at DESC NULLS LAST, created_at DESC, id DESC
        LIMIT 1
     )
     SELECT employee.id AS "employeeId", employee.full_name AS name
       FROM latest
       JOIN organization_positions position
         ON position.change_set_id = latest.id
       JOIN organization_nodes node
         ON node.change_set_id = position.change_set_id
        AND node.stable_key = position.node_key
       JOIN organization_incumbencies incumbent
         ON incumbent.change_set_id = position.change_set_id
        AND incumbent.position_key = position.stable_key
       JOIN employees employee
         ON employee.id = incumbent.employee_id
      WHERE (
        (
          $1 = 'hcm'
          AND (
            lower(regexp_replace(btrim(position.title), '\\s+', ' ', 'g')) = 'kepala human capital management'
            OR (
              lower(regexp_replace(btrim(position.title), '\\s+', ' ', 'g')) = 'kepala'
              AND lower(regexp_replace(btrim(node.name), '\\s+', ' ', 'g')) = 'human capital management'
            )
          )
        )
        OR (
          $1 = 'director'
          AND lower(regexp_replace(btrim(position.title), '\\s+', ' ', 'g')) = 'direktur'
        )
      )
        AND position.active = true
        AND node.active = true
        AND position.effective_from <= current_date
        AND (position.effective_to IS NULL OR position.effective_to >= current_date)
        AND node.effective_from <= current_date
        AND (node.effective_to IS NULL OR node.effective_to >= current_date)
        AND incumbent.effective_from <= current_date
        AND (incumbent.effective_to IS NULL OR incumbent.effective_to >= current_date)
        AND incumbent.employee_id IS NOT NULL
        AND employee.status = 'active'
      ORDER BY CASE incumbent.kind WHEN 'PRIMARY' THEN 0 ELSE 1 END,
               incumbent.effective_from DESC,
               employee.full_name ASC
      LIMIT 1`,
    [role],
  );
  return result.rows[0] ?? null;
}

async function findLegacySignerCandidate(
  database: QueryTarget,
  role: "hcm" | "director",
): Promise<SignerCandidate | null> {
  const result = await database.query<SignerCandidate>(
    `SELECT employee.id AS "employeeId", employee.full_name AS name
       FROM employees employee
       LEFT JOIN positions position ON position.id = employee.position_id
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
      WHERE employee.status = 'active'
        AND (
          (
            $1 = 'hcm'
            AND (
              lower(regexp_replace(btrim(coalesce(position.name, '')), '\\s+', ' ', 'g')) = 'kepala human capital management'
              OR lower(regexp_replace(btrim(coalesce(employee.structural_position, '')), '\\s+', ' ', 'g')) = 'kepala human capital management'
              OR (
                lower(regexp_replace(btrim(coalesce(position.name, '')), '\\s+', ' ', 'g')) = 'kepala'
                AND lower(regexp_replace(btrim(coalesce(unit.name, '')), '\\s+', ' ', 'g')) = 'human capital management'
              )
            )
          )
          OR (
            $1 = 'director'
            AND (
              lower(regexp_replace(btrim(coalesce(position.name, '')), '\\s+', ' ', 'g')) = 'direktur'
              OR lower(regexp_replace(btrim(coalesce(employee.structural_position, '')), '\\s+', ' ', 'g')) = 'direktur'
            )
          )
        )
      ORDER BY employee.full_name ASC
      LIMIT 1`,
    [role],
  );
  return result.rows[0] ?? null;
}

async function findSignerCandidate(
  database: QueryTarget,
  role: "hcm" | "director",
): Promise<SignerCandidate | null> {
  return (
    (await findDynamicSignerCandidate(database, role))
    ?? (await findLegacySignerCandidate(database, role))
  );
}

export async function resolveDocumentSigner(
  database: QueryTarget,
  ownerEmployeeId: string,
): Promise<{ title: SignerTitle; name: string | null }> {
  const hcm = await findSignerCandidate(database, "hcm");
  if (hcm && hcm.employeeId !== ownerEmployeeId) {
    return { title: "Kepala Human Capital Management", name: hcm.name };
  }

  const director = await findSignerCandidate(database, "director");
  if (director && director.employeeId !== ownerEmployeeId) {
    return { title: "Direktur", name: director.name };
  }

  if (hcm?.employeeId === ownerEmployeeId || !hcm) {
    return { title: "Direktur", name: null };
  }

  return { title: "Kepala Human Capital Management", name: null };
}
