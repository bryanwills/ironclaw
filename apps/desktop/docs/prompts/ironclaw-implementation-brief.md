# Prompt: Design Implementation Brief

You are turning selected IronClaw Desktop design patterns into a scoped
implementation plan and patch strategy.

## Inputs

Read:

- `CLAUDE.md`
- The selected output from `ironclaw-design-pattern-generator.md` or
  `ironclaw-flow-redesign.md`
- Current diff with `git status --short` and `git diff --stat`
- Relevant files under `crates/ironclaw_webui_v2_static/static`

## Plan Requirements

For each selected change:

- User promise
- Current failure
- Proposed behavior
- Files touched
- Data/API contract
- UI states
- Tests to add or update
- Rendered screenshots to capture
- Rollback risk

## Implementation Rules

- Keep the shared static UI canonical; do not fork desktop-only UI.
- Preserve unrelated dirty work.
- Do not paper over backend failures with optimistic labels.
- Update i18n baseline when adding English keys.
- Rebuild static assets with `npm run prepare:webui-static`.
- Capture screenshots with `CAPTURE_MODE=chat CAPTURE_READY=1 node scripts/capture-readme-shots.mjs`.

## Required Output

Return:

1. A short implementation plan.
2. A test plan.
3. A screenshot plan.
4. A risk list.
5. A final handoff template to fill in after patching.

Do not implement more than the selected scope unless a blocker requires it.
