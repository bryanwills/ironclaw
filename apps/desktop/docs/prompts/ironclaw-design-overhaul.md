# Prompt: IronClaw Design Overhaul

You are Claude, working on IronClaw Desktop. Your job is to prepare a proper
design overhaul, then implement only the first highest-value slice after the
documents are complete.

## Load First

Read these files:

1. `CLAUDE.md`
2. `docs/design/CLAUDE-DESIGN-OVERHAUL-NOTES.md`
3. `docs/design/CLAUDE-DESIGN-DELIVERABLES.md`
4. `docs/reviews/design-pass-research-synthesis-2026-06-10.md`
5. `docs/reviews/hostile-product-review-2026-06-12.md`
6. `docs/reviews/practical-work-scenario-corpus.md`
7. `docs/STATIC_WEBUI_SYNC.md`

Then inspect current screenshots:

- `output/readme-shots/contact-sheet.png`
- `docs/screenshots/github-page-onboarding.png`
- `docs/screenshots/github-page-chat.png`
- `docs/screenshots/github-page-connections.png`
- `docs/screenshots/github-page-settings.png`

If screenshots are stale or missing, run:

```sh
npm run prepare:webui-static
CAPTURE_MODE=chat CAPTURE_READY=1 node scripts/capture-readme-shots.mjs
```

## Design Thesis

IronClaw Desktop should feel like a serious macOS chief-of-staff instrument,
not a generic AI chat app. It should open to a prepared desk, show what needs
the user, expose handled receipts, make work product copyable/exportable, and
keep connector/model readiness honest.

## First Deliverable: Documents

Before changing code, create or update:

- `docs/design/current-surface-truth-map.md`
- `docs/design/visual-system-spec.md`
- `docs/design/prepared-desk-ia.md`
- `docs/design/core-flow-specs.md`
- `docs/design/component-grammar.md`
- `docs/design/design-acceptance-plan.md`

Follow `docs/design/CLAUDE-DESIGN-DELIVERABLES.md` exactly.

## Second Deliverable: Implementation Slice

After the documents are written, pick one highest-value implementation slice.
Prefer:

1. Typography and density pass.
2. Prepared desk shell on Chat.
3. Artifact chip and preview/export drawer.
4. Connector truth cards.

Do not implement unrelated cleanup. Do not touch the legacy Svelte UI unless a
test or build path requires it. The shipped UI is:

```text
crates/ironclaw_webui_v2_static/static
```

## Visual Rules

- No warm-earthy generic SaaS palette.
- No huge gray placeholder prose.
- No decorative gradient blobs or mascot-led product surfaces.
- No nested card piles.
- No fake connected or ready states.
- No OpenRouter/Anthropic/Claude/ChatGPT subscription branding in normal setup.
- One blue primary action per screen.
- Gold only marks agent agency, provenance, or receipts.
- Type should feel native, dense, and expensive.

## Output Format

Return:

1. Documents created.
2. First slice selected and why.
3. Files changed.
4. Tests run.
5. Screenshots captured.
6. Remaining RED items.
7. Next agent should start here.

## Verification Required

At minimum:

```sh
npm run verify:static-frontend
npm run smoke:webui-static
```

For UI/code changes also run focused static tests and refresh screenshots:

```sh
npm run prepare:webui-static
CAPTURE_MODE=chat CAPTURE_READY=1 node scripts/capture-readme-shots.mjs
```

If runtime packaging changes, run packaged smoke.

