// A fresh actor account owned by one integration suite.
//
// Test files run in parallel against one CI database. A suite that borrows "any
// existing account" (SELECT id FROM accounts LIMIT 1) can pick another suite's
// actor: its audit events then land in that suite's per-actor counts
// (payroll-initial-load asserts exactly its own events), and the owner may delete
// the account while the borrower still writes rows that reference it.

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export async function createSyntheticActor(pool: Pool, tag: string): Promise<string> {
  const employeeId = randomUUID();
  const accountId = randomUUID();
  await pool.query(
    "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Synthetic Actor', 'active')",
    [employeeId, `EMP-${tag}-ACTOR-${employeeId}`],
  );
  await pool.query(
    `INSERT INTO accounts(id, employee_id, email, principal_type, status)
     VALUES ($1, $2, $3, 'EMPLOYEE', 'active')`,
    [accountId, employeeId, `${tag.toLowerCase()}-${accountId}@example.invalid`],
  );
  return accountId;
}
