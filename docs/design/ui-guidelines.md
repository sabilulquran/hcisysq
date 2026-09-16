# UI and Design Guidelines

**Status:** ACTIVE FOUNDATION

## Canonical ownership

Reviewed product UI now lives in `apps/web` in this repository. The earlier `imadjinasi/hcis-ysq-foundation` repository is design/reference history only.

GitHub `sabilulquran/hcisysq` is the source of truth for product UI, domain rules, API contracts, and engineering work.

## Current MVP screens

1. Login/recovery foundation.
2. Employee app shell and dashboard.
3. Leave request form and preview.
4. Approval task detail/timeline.
5. Payslip read-only list/detail from imported data.
6. Foundation Board read-only statistics/report panel.
7. Super Admin access/audit minimum panel.
8. Empty, loading, error, forbidden, offline/slow, and mobile states.

## Brand

Follow `docs/design/brand-guideline.md`.

## Design tokens

Define and reuse:

- typography scale;
- spacing scale;
- radius;
- elevation;
- semantic colors;
- focus ring;
- breakpoints;
- motion duration;
- density for table/form layouts.

Do not hardcode status meaning per page. Status needs label/icon/text and may use semantic color as secondary reinforcement.

## Interaction principles

- One obvious primary action per task.
- Destructive action requires confirmation appropriate to risk.
- Validation error stays close to the field.
- Tables support practical filter/sort/pagination when data volume needs it.
- Approval view shows requester, request summary, policy context, history, and decision consequence.
- Do not reveal restricted data that is unnecessary for a decision.
- Payslip employee views are read-only.

## Accessibility

- Target minimum WCAG 2.1 AA.
- Keyboard navigation and visible focus.
- Semantic HTML and form labels.
- Status not conveyed by color alone.
- Dialog focus management.
- Adequate touch targets on mobile.
- Respect reduced motion.

## Responsive strategy

- Mobile-first for employee self-service and quick approval.
- Desktop-efficient for administration, import, reconciliation, and reporting.
- Do not squeeze desktop tables onto mobile; use detail/card patterns when more appropriate.

## Mock data

All prototypes and fixtures use synthetic data. Production employee/payroll data must never be placed in prompts, screenshots, fixtures, or public repository history.
