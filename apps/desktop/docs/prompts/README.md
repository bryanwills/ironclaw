# IronClaw Desktop Prompt Pack

These prompts are for Claude design and product-flow work. They are intended to
keep design passes grounded in the actual IronClaw Desktop product contract,
not generic AI-chat defaults.

Use them from the repo root after reading `CLAUDE.md`.

## Prompts

- `ironclaw-design-overhaul.md`: create the durable overhaul design docs, then
  select and implement one highest-value slice with screenshot and test proof.
- `ironclaw-hostile-design-review.md`: attack the current rendered UI and mark
  visual, flow, copy, safety, and honesty issues RED/YELLOW/GREEN.
- `ironclaw-design-pattern-generator.md`: synthesize better product patterns
  and component archetypes from the research and screenshots.
- `ironclaw-flow-redesign.md`: redesign the highest-value end-to-end flows,
  especially onboarding, connectors, work product, and approvals.
- `ironclaw-implementation-brief.md`: turn selected design patterns into a
  scoped implementation plan with tests and screenshot gates.

## Recommended Run Order

1. Run `ironclaw-design-overhaul.md` for the full Claude design/document pass.
2. Run `ironclaw-hostile-design-review.md` when you need a harsher current-state
   critique.
3. Run `ironclaw-design-pattern-generator.md` to expand pattern options.
4. Run `ironclaw-flow-redesign.md` to deepen specific end-to-end flows.
5. Pick the top 1-3 changes and run `ironclaw-implementation-brief.md`.

Every pass should cite screenshots, files, routes, and tests. Do not accept
"looks better" without rendered evidence.
