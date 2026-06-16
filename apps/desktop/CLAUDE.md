# IronClaw Desktop Claude Guide

This repo is the desktop shell for IronClaw, an agentic chief-of-staff product.
Do not treat it as a generic chat client. The product should feel like a
prepared desk: it notices what moved, surfaces what needs the user, keeps work
product accessible, and asks for permission before risky actions.

## Read First

Before design or product work, read these files in order:

1. `docs/reviews/design-pass-research-synthesis-2026-06-10.md`
2. `docs/AGENT_HANDOFF_PROTOCOL.md`
3. `docs/reviews/hostile-product-review-2026-06-12.md`
4. `docs/reviews/practical-work-scenario-corpus.md`
5. Current screenshots in `output/readme-shots/` when present

If the task is specifically about design patterns or flows, use the prompt pack
in `docs/prompts/`.

## Product Thesis

IronClaw is not "better ChatGPT with connectors." It is a desktop chief of
staff.

The front door should answer:

- What changed while I was away?
- What needs my decision?
- What can IronClaw safely handle now?
- What work product exists and where can I open/export it?
- Which connectors are actually connected, blocked, or unavailable?

Chat is an instrument, not the lobby. The product should route work into
durable matters, approvals, receipts, attachments, and exports.

## Design Laws

- Prepared desk over blank prompt.
- One primary action per screen.
- Blue means the user's action. Gold means the agent's action.
- No fake readiness. A surface may not imply a capability the gateway cannot
  prove.
- No provider sprawl in normal desktop setup. NEAR AI Cloud is the default model
  path.
- No decorative trust wallpaper. Trust appears as specific receipts, approvals,
  sources, files, and exact data movement.
- No nested card piles. Dense, calm, bordered surfaces are preferred.
- No big chat bubbles for assistant prose. Assistant output should read like
  work on the desk, with quiet inline tool rows and artifact chips.
- Approval gates are sacred: action, target, destination, outbound data, risk,
  approve, deny.
- Work product must be copyable, previewable, exportable, reloadable, and
  findable later.

## Main Surfaces

When reviewing or redesigning, include these surfaces:

- Onboarding / first-run NEAR AI Cloud setup
- Chat / prepared desk / composer / model selector
- Attachments and generated work product
- Approval gate and auth gate
- Connections / apps registry / connector setup
- Settings / AI setup / advanced provider fallbacks
- Sidebar navigation and command palette
- Thread reload with visible message history
- Export and copy flows

## Strong Pattern Directions

Use these patterns as starting points:

- Morning Brief: ranked "what moved / what needs you / what is ready" stack.
- Needs You: approval inbox with gate cards and blocked connector cards.
- Handled Receipts: collapsed rows for completed agent actions with fields,
  linked artifacts, undo when real, and gold attribution.
- Work Dossier: one durable matter containing ask, plan, files, approvals,
  receipts, outputs, and next steps.
- Artifact Chip: file type icon, filename, source, extraction state, preview,
  copy, export, save.
- Model Source Chip: compact NEAR AI Cloud state, setup when disconnected, model
  choice only when active.
- Connector Card: app logo, value, readiness, exact blocker, one connect action.
- Bridge: one command surface for navigate, ask, find, run.

## Anti-Patterns To Kill

- "Ask me anything" as the entire product.
- Persistent chip soup around the composer.
- Fake connected / ready states.
- API key marketplaces in the first-run path.
- OpenRouter / ChatGPT / Claude subscription branding in normal IronClaw setup.
- Long workflow traces in chat that do not answer the user's ask.
- Unstructured JSON as final work product.
- One-page generic documents from rich source templates.
- Modal-heavy auth during mid-task work; use inline gates.
- Decorative gradients, giant marketing heroes, or mascot-led product surfaces.

## Evidence Rules

Do not call a design pass done from code inspection alone.

For UI work:

1. Rebuild static assets with `npm run prepare:webui-static`.
2. Capture screenshots with `CAPTURE_MODE=chat CAPTURE_READY=1 node scripts/capture-readme-shots.mjs`.
3. Review `output/readme-shots/contact-sheet.png` or the individual images.
4. Run at least:
   - `npm run verify:static-frontend`
   - `npm run smoke:webui-static`
   - focused tests for touched files
5. If runtime packaging changed, run packaged-app smoke too.

For proposed designs, include:

- Exact surface being changed.
- User promise being improved.
- Before/after interaction flow.
- Data/readiness truth contract.
- Acceptance tests and screenshot evidence.

## Handoff Format

End design or implementation passes with:

```md
## Claude Handoff: Design / Flow Pass

Status: GREEN | YELLOW | RED

### Goal
...

### Patterns Proposed Or Implemented
- ...

### Changed
- file/path: reason

### Verified
- command or screenshot: result

### Evidence
- screenshot path, test result, rendered route

### Still RED
- exact blocker and repro

### Next Agent Should Start Here
1. ...

### Do Not Touch
- unrelated dirty files / concurrent work
```
