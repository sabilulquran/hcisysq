# Organization Designer Visual Ranking

**Status:** IMPLEMENTED/DEPLOYED CODE+SCHEMA — REAL STRUCTURE/STRUCTURE ACTIVATION/PILOT VALIDATION PENDING
**Specification:** ORG-004 visual-layout addendum  
**Related:** ORG-002, ORG-004, APR-001  
**Decision date:** 2026-08-22

## Current-state note

This document originated as an ORG-004 design requirement and records the historical design rationale below. The visual-ranking behavior and Organization Designer implementation now exist in the deployed ORG-004 software/schema at the inspected production baseline.

Deployment does not make the modeled structure authoritative. Codex Local evidence reports no `organization_rollout_settings` rows at the inspected production SHA, so `LEGACY` remains authoritative. Real YSQ structure configuration, selected-unit `SHADOW` comparison, explicit `STRUCTURE` activation, and production pilot validation remain pending.

Visual rank continues to have **zero authority semantics** regardless of rollout mode.

## Purpose

The HCIS Organization Designer must allow YSQ administrators to communicate **relative organizational rank visually** without falsifying the actual reporting or authority structure.

A structural child does not always belong on the immediately next visual row of an organization chart. For example, a bureau may report directly to a Head of Education Affairs while being intentionally displayed at the same visual rank as vice principals rather than school heads.

HCIS must support this without creating fake intermediate positions and without changing approval resolution.

The implemented renderer uses a deterministic top-down hierarchy: children are placed below their structural parent, siblings share a horizontal peer row, and explicit connector metadata/lines retain the real parent across skipped bands. Node and position visual offsets add actual vertical layout distance and visual-band depth; they are not presentation badges alone. Member populations remain summarized on group cards rather than expanded into one chart box per employee.

## Core invariant

> **Structural relationship and visual rank are different concepts.**

The organization structure answers:

> Who is structurally responsible for this item?

The visual layout answers:

> At what apparent rank should this item be displayed on the chart?

Workflow and authority resolution must use the structural relationship, never the visual row/depth.

## Example

Assume this real structure:

```text
Head of Education Affairs
|
+-- Head of SDIT
|   +-- SDIT Vice Principal
|
+-- Head of SMPIT
|   +-- SMPIT Vice Principal
|
+-- Al-Qur'an Bureau
```

`Al-Qur'an Bureau` reports directly to `Head of Education Affairs`, but YSQ wants the chart to communicate that its relative organizational rank is closer to a vice principal than to a school head.

The admin may therefore configure:

```text
Al-Qur'an Bureau
structural parent = Head of Education Affairs
visual offset     = +1
```

The chart may render approximately as:

```text
                 Head of Education Affairs
                          |
             +------------+------------+
             |                         |
        Head of SDIT               Head of SMPIT
             |                         |
      SDIT Vice Principal       SMPIT Vice Principal
             |
             +----------- Al-Qur'an Bureau
                         [same visual band]
```

The connector from `Head of Education Affairs` to `Al-Qur'an Bureau` must still represent the true direct structural relationship even when its box is rendered lower.

## Do not create fake vacant positions

Visual spacing must **not** be represented by invented empty organizational positions.

Do not model this:

```text
Head of Education Affairs
|
+-- [FAKE VACANT POSITION]
    |
    +-- Al-Qur'an Bureau
```

A `VACANT` position has real domain meaning: an actual position exists but currently has no effective incumbent.

Using fake vacant positions for layout would corrupt:

- direct-manager traversal;
- vacancy fallback;
- acting/temporary authority behavior;
- approval resolution;
- organization history;
- vacancy reporting.

Visual layout metadata must therefore be separate from structural entities and vacancy state.

## Visual offset

The implementation uses layout metadata whose semantics remain:

```text
render depth = structural depth + visual offset
```

Illustrative values:

```text
visual offset = 0
-> render at the normal structural depth

visual offset = 1
-> render one visual band lower

visual offset = 2
-> render two visual bands lower
```

Negative offsets should not be introduced unless a real reviewed YSQ case requires them, because rendering a structural child above its structural parent can make the chart misleading.

## Example with multiple offsets

```text
Head of Education Affairs
|
+-- Head of SDIT                 visual offset 0
|   +-- Vice Principal           visual offset 0
|       +-- Teachers             visual offset 0
|
+-- Al-Qur'an Bureau             visual offset 1
|
+-- Supporting Team X            visual offset 2
```

This allows:

- `Head of SDIT` to appear at the school-head visual band;
- `Al-Qur'an Bureau` to appear at the vice-principal visual band;
- `Supporting Team X` to appear at the teacher/staff visual band;

while all three may still have the same structural parent when that reflects YSQ's actual organization.

## Approval and authority behavior

Visual ranking must have **zero authority semantics**.

Approval code must never contain logic such as:

```text
approver = item at visual level - 1
```

or:

```text
if visual_offset == 1 then use school head
```

Instead, approval resolution uses semantic structural relationships defined by ORG-004, for example:

- structural/supervisory parent;
- configured leader position;
- unit approver authority;
- governance approver authority;
- effective incumbent;
- vacancy policy;
- employee-level reporting override where explicitly configured.

Example:

```text
Al-Qur'an Bureau
structural parent = Head of Education Affairs
visual offset = +1
```

Then when `STRUCTURE` is authoritative for the applicable workflow/scope:

```text
DIRECT_MANAGER
-> Head of Education Affairs incumbent
```

The system must **not** choose a school head merely because `Al-Qur'an Bureau` is visually aligned with vice principals.

## Vacancy behavior remains structural

If a real authority-bearing parent position is vacant, vacancy resolution follows ORG-004 vacancy rules. Visual offset does not add, remove, or skip authority steps.

```text
visual skip != vacancy skip
```

These are unrelated concepts.

## Organization Designer UX

Administrators should not need to understand an internal field named `visual_offset`.

The Organization Designer exposes a user-facing visual control equivalent to:

```text
Display position
(*) Normal structural level
( ) Lower by 1 visual level
( ) Lower by 2 visual levels
```

The UI copy must make clear that this changes **chart presentation only**.

Suggested explanation:

> Adjust visual rank without changing reporting or approval relationships.

## Add-below and add-sibling actions

The visual builder preserves the administration model accepted for ORG-004:

- **Add below** creates a new structural child of the selected item.
- **Add alongside** creates a sibling under the same structural parent.
- **Adjust visual rank** changes only the rendered vertical band of the selected item.

These actions must remain conceptually separate.

## Rendering requirements

The chart renderer must draw a connector across skipped visual bands so users can still see the true parent-child relationship.

A visually offset item must not appear disconnected or incorrectly attached to an item on its displayed row.

The renderer supports or must preserve:

- compact and expanded organization views;
- vacant positions remaining visible;
- occupied position labels;
- collapsed member counts for non-leadership employees;
- historical/current/future effective-date views from ORG-004;
- visual offsets stable for the selected effective structure.

## Effective dating

Visual rank may change as part of a scheduled restructure.

Example:

```text
2026
Al-Qur'an Bureau visual offset = +1

2027
Al-Qur'an Bureau moved structurally under a new directorate
visual offset = 0
```

The implemented organization snapshot model treats layout-affecting configuration as part of effective-dated structure history. Historical chart rendering must remain correct rather than destructively overwriting prior structure.

## Draft / impact preview

A draft restructure preview must show both:

1. visual changes to the chart; and
2. structural/authority changes that affect workflow resolution.

A pure visual-rank change is identified as **no approval-routing impact**.

Example preview:

```text
Change:
Al-Qur'an Bureau visual rank +1

Structural parent changed: NO
Authority binding changed: NO
Approval routing impact: NONE
```

Conversely, moving the same bureau to a different structural parent must be identified as an authority-impacting change when the structural parent participates in approval resolution.

## API / model boundary

Organization APIs consumed by workflow code must expose structural/authority relationships independently from layout metadata.

Conceptually:

```text
Organization Designer read model
= structure + assignments + authority + layout metadata

Approval resolver model
= structure + assignments + authority
```

This keeps future workflow modules independent of chart aesthetics.

## Acceptance criteria

- ORG-004-VIS-A: an organization item can be rendered below its immediate structural depth without inserting a fake position.
- ORG-004-VIS-B: visual rank changes do not alter direct-manager, unit-approver, governance-approver, or oversight resolution.
- ORG-004-VIS-C: a visually skipped structural relationship is rendered with a connector that still identifies the true parent.
- ORG-004-VIS-D: real vacant positions remain distinct from visual spacing and continue to participate in vacancy policy.
- ORG-004-VIS-E: approval code never resolves authority from numeric/display level or visual offset.
- ORG-004-VIS-F: the Organization Designer provides a user-friendly way to lower visual rank without exposing database terminology.
- ORG-004-VIS-G: draft impact preview distinguishes pure layout changes from structural/authority changes.
- ORG-004-VIS-H: historical/future chart views preserve the visual layout appropriate to the selected effective structure.
- ORG-004-VIS-I: future workflow modules can consume organization authority without depending on visualization metadata.

## Historical implementation boundary and current operational boundary

At the 2026-08-22 design checkpoint this file was a **design requirement only** and explicitly did not describe deployed behavior. That historical checkpoint is preserved here so implementation history is not rewritten.

Current state is different: ORG-004 code/schema and the Organization Designer implementation are deployed at the inspected production baseline. However, the real YSQ structure has not been validated for the pilot, `SHADOW` evidence has not been completed, and `STRUCTURE` is not activated. The current production contract therefore remains `LEGACY` until an authorized rollout setting says otherwise.

No visual-ranking implementation fact is permission to infer, seed, or activate a real authority relationship.