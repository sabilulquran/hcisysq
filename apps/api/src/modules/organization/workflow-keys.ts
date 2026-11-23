/**
 * ORG-004: satu-satunya daftar kunci workflow yang dikenal saklar rollout.
 *
 * Sebelum ini, route admin `PATCH /admin/organization/rollout` menulis kunci apa pun yang
 * diketik operator (bahkan memberinya default `"LEAVE"`), sementara runtime mencari
 * `leave.annual`, `LOAN`, `OVERTIME`, dan seterusnya. Kolom `workflow_key` tidak punya batasan,
 * jadi baris dengan kunci yang tidak cocok dengan apa pun tetap tersimpan dan
 * `resolveRolloutSetting` jatuh diam-diam ke `LEGACY`. Operator mengira satu unit sudah
 * dipindahkan padahal tidak — kegagalan diam pada saklar kewenangan.
 *
 * Karena itu daftar di bawah dibaca oleh tiga tempat sekaligus:
 *
 * 1. route admin, lewat `z.enum(ORGANIZATION_WORKFLOW_KEYS)`;
 * 2. setiap modul runtime, lewat anotasi `: OrganizationWorkflowKey` pada konstanta kuncinya,
 *    sehingga salah ketik gagal pada typecheck;
 * 3. database, lewat constraint `organization_rollout_settings_workflow_key_known`
 *    (migrasi 0182) — jalur penulisan lain pun ditolak.
 *
 * Menambah workflow baru berarti menambah satu entri di sini **dan** satu migrasi yang
 * memperbarui constraint itu. `workflow-keys.test.ts` menjaga keduanya tetap sama.
 */

/** Kunci kebijakan cuti yang punya rantai approval sendiri; lihat `planned-leave-policy.ts`. */
export const LEAVE_WORKFLOW_POLICY_KEYS = [
  "annual",
  "employee_marriage",
  "child_marriage",
  "child_circumcision",
  "hajj",
  "unpaid",
] as const;

export type LeaveWorkflowPolicyKey = (typeof LEAVE_WORKFLOW_POLICY_KEYS)[number];

/**
 * Kunci yang benar-benar dipakai runtime saat meminta mode rollout. Diurutkan: cuti dahulu
 * (dibentuk dari `LEAVE_WORKFLOW_POLICY_KEYS`), lalu workflow lain menurut abjad.
 */
export const ORGANIZATION_WORKFLOW_KEYS = [
  "leave.annual",
  "leave.employee_marriage",
  "leave.child_marriage",
  "leave.child_circumcision",
  "leave.hajj",
  "leave.unpaid",
  "LOAN",
  "OVERTIME",
  "PERF",
  "REIMBURSEMENT",
  "TRAINING",
  "TRIP",
  "WORK_ARRANGEMENT",
] as const;

export type OrganizationWorkflowKey = (typeof ORGANIZATION_WORKFLOW_KEYS)[number];

/**
 * Penjaga waktu-kompilasi: setiap kunci kebijakan cuti wajib punya kunci workflow `leave.<key>`
 * pada daftar di atas. Menambah kebijakan cuti tanpa menambah kuncinya gagal di sini.
 */
type _EveryLeavePolicyHasAWorkflowKey =
  `leave.${LeaveWorkflowPolicyKey}` extends OrganizationWorkflowKey ? true : never;
const _everyLeavePolicyHasAWorkflowKey: _EveryLeavePolicyHasAWorkflowKey = true;
void _everyLeavePolicyHasAWorkflowKey;

/** Kunci workflow untuk satu kebijakan cuti. Dipakai runtime cuti, bukan string literal. */
export function leaveWorkflowKey(policyKey: LeaveWorkflowPolicyKey): OrganizationWorkflowKey {
  return `leave.${policyKey}`;
}

export function isOrganizationWorkflowKey(value: unknown): value is OrganizationWorkflowKey {
  return typeof value === "string"
    && (ORGANIZATION_WORKFLOW_KEYS as readonly string[]).includes(value);
}
