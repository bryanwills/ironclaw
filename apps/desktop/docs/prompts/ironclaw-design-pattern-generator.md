# Prompt: Design Pattern Generator

You are designing stronger patterns for IronClaw Desktop. Generate product
patterns, not vague design advice.

## Inputs

Read:

- `CLAUDE.md`
- `docs/reviews/design-pass-research-synthesis-2026-06-10.md`
- `docs/reviews/practical-work-scenario-corpus.md`
- Current screenshots in `output/readme-shots/`

Assume the product vision is:

> An agentic chief of staff that proactively handles work, asks for permission
> when needed, and surfaces useful work product in a desktop app.

## Pattern Requirements

For each pattern, define:

- Name
- Surface where it belongs
- User job
- Visual structure
- Interaction behavior
- Data required from Reborn/gateway
- Honest blocked state
- Copy examples
- Accessibility notes
- Implementation notes
- Test / screenshot proof

## Patterns To Cover

Produce at least these patterns:

1. Morning Brief / prepared desk
2. Needs You approval inbox
3. Handled receipt card
4. Work dossier
5. Artifact chip and preview drawer
6. Connector setup card
7. Model source selector
8. Inline auth gate
9. Tool activity row
10. Export and copy bar

## Constraints

- Do not invent impossible backend capabilities without naming the required
  contract.
- Do not add more permanent chips around the composer.
- Do not use onboarding as a settings dashboard.
- Do not make generic provider marketplaces part of normal desktop setup.
- Do not propose decorative mascot/orb/gradient patterns.

## Required Output

Start with a one-paragraph design thesis.

Then provide a table:

| Pattern | Surface | Solves | Requires | Risk |

Then write each pattern in detail.

End with:

- The 3 patterns to implement first
- The exact files likely touched
- The acceptance screenshots needed
