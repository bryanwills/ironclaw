# Claude Design Deliverables

Use this checklist when asking Claude to run a full IronClaw Desktop design
overhaul. The goal is to force useful documents and implementation plans before
code changes begin.

## Required Output Files

Claude should create or update these files:

1. `docs/design/current-surface-truth-map.md`
   - Route or surface.
   - User promise.
   - Current UI evidence.
   - Backend/data proof required.
   - Current status: GREEN, YELLOW, RED.
   - Highest-value fix.

2. `docs/design/visual-system-spec.md`
   - Type scale.
   - Color roles.
   - Accent discipline.
   - Radius and border rules.
   - Spacing and density rules.
   - Component examples.
   - Anti-pattern examples.

3. `docs/design/prepared-desk-ia.md`
   - Home/chat IA.
   - Needs You strip.
   - Handled receipts.
   - Artifact rail.
   - Composer hierarchy.
   - Returning-user state.
   - Empty state.

4. `docs/design/core-flow-specs.md`
   - First run and NEAR AI Cloud sign-in.
   - First real ask with attachment.
   - Connector setup.
   - Approval gate.
   - Work-product preview/export.
   - Returning user.
   - Failure and blocked states.

5. `docs/design/component-grammar.md`
   - Artifact chip.
   - Approval gate.
   - Connector card.
   - Tool row.
   - Receipt card.
   - Model source chip.
   - File preview drawer.
   - Blocked-state callout.

6. `docs/design/design-acceptance-plan.md`
   - Screenshot matrix.
   - Static tests.
   - e2e flows.
   - Accessibility checks.
   - Hostile scenario corpus.
   - Required before/after evidence.

## Required Implementation Brief

After the docs above, Claude should select only the first implementation slice
and write:

- User promise.
- Exact current failure.
- Proposed behavior.
- Files touched.
- Data/API contract.
- UI states.
- Tests.
- Screenshot proof.
- Risk and rollback.

The first implementation slice should usually be one of:

- Typography and density pass across the shipped surfaces.
- Prepared desk shell on Chat.
- Artifact chip and preview/export drawer.
- Connector truth cards.

Do not implement all seven flows at once.

## Quality Bar

The design is acceptable only if:

- The app no longer opens like a blank chat box when useful state exists.
- The user can identify pending approvals and blocked connectors in under
  three seconds.
- A generated work product is visibly an artifact, not just assistant prose.
- Connector cards cannot show fake connected states.
- Model state is plain NEAR AI Cloud language, not provider-market jargon.
- The type scale feels native, dense, and expensive.
- The UI avoids huge placeholder prose, inflated card radius, and generic SaaS
  onboarding copy.

## Claude Stop Conditions

Claude should stop and document a blocker instead of faking progress when:

- Gateway data cannot prove a connector/model/work-product claim.
- Screenshots cannot be captured.
- A route is hidden because backend endpoints are missing.
- A design requires a backend contract that does not exist.
- The implementation would reintroduce old provider sprawl.

