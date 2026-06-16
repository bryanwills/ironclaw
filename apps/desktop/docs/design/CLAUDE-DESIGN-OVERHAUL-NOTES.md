# Claude Design Overhaul Notes

Date: 2026-06-12

Audience: Claude or another implementation agent working on IronClaw Desktop.

Purpose: provide a concrete product/design direction for a serious overhaul of
the shipped static desktop UI. This is not a mood board request. It is a design
contract for turning IronClaw into an agentic chief-of-staff desktop product.

## Product Frame

IronClaw Desktop is not a generic chat client. It should feel like a prepared
desk: it opens with the state of the user's work, names what needs permission,
shows what it already handled, and keeps files, approvals, connector state, and
generated work product findable.

The user should never wonder:

- What did I ask IronClaw to do?
- Did it actually send or modify anything?
- Which file did it read?
- Where did the output go?
- Is Notion/Gmail/Calendar/Slack really connected?
- Which model is being used?
- Can I copy/export this?

If the answer is not visible in the product, the design has failed.

## Current Visual Problem

The current surface is cleaner than earlier versions, but still reads like a
well-arranged developer shell rather than an elite desktop chief of staff. The
attached note-field screenshot is a useful anti-example: huge low-contrast gray
placeholder text, vague "Any other notes?" copy, swollen card radius, and a
generic SaaS prompt. That pattern makes the product feel cheap because it asks
the user to provide taste instead of expressing taste itself.

IronClaw should not ask for "warm earthy palette" style notes. It should have a
clear design point of view.

## Visual Direction

Use the language of a macOS work instrument:

- Calm dark neutral base, not black void and not beige/warm SaaS.
- One bright blue action color per screen.
- Gold only for agent agency, receipts, provenance, and "IronClaw handled this."
- Small, dense, readable typography with hierarchy from weight, spacing, and
  structure rather than oversized display text.
- Surfaces should feel machined and precise: 6-8px radius, crisp borders,
  quiet panels, clear focus rings.
- Avoid nested card piles. A page can have full-width bands, rows, split panes,
  rails, tables, cards for repeated objects, and drawers. It should not become
  cards inside cards inside cards.
- Use real app logos and file-type icons where they communicate function. Do
  not use decorative blobs, mascot-led product screens, or generic AI sparkle.

Typography guidance:

- Prefer a macOS-first stack: `-apple-system`, `BlinkMacSystemFont`,
  `Inter Variable`, `Inter`, `SF Pro Text`, `sans-serif`.
- Body/UI text should usually sit around 13-15px.
- Metadata can be 11-12px with sufficient contrast.
- Page headings should be restrained, usually 20-28px, except true onboarding.
- Placeholder text should never dominate the control. Use short, specific
  prompts around 14-15px, not giant gray prose.
- Do not use negative letter spacing. Do not scale font size with viewport.

## Interaction Direction

The first screen should answer, "what needs me?" before it asks, "what do you
want to do?"

The ideal home/chat composition:

1. Needs You strip: pending approvals, blocked connectors, failed runs, and
   documents waiting for user context.
2. Handled receipts: a compact feed of what IronClaw completed, with artifact
   links and undo/reopen when real.
3. Chat composer: ready for the next ask, but not the only object on the page.
4. Work artifacts: generated DOCX/PDF/XLSX/MD/JSON/PPTX should appear as
   artifacts with preview/copy/export, not buried in chat text.

The app should behave like a chief of staff:

- Ask clarifying questions when context is missing.
- Preserve user text in the visible thread.
- Show uploaded files and extracted text state.
- Show tool activity as compact rows, not long workflow sludge.
- Use inline approval/auth gates, not modal interruptions.
- Name exactly what will leave the machine before any risky action.
- Keep blocked states useful: one exact blocker, one next action.

## Surface-Specific Notes

### Onboarding

Goal: connect NEAR AI Cloud quickly and explain why.

Do:

- Lead with "Connect NEAR AI Cloud" and a one-sentence promise.
- Use GitHub, Google, and NEAR Wallet as the normal options when real.
- Keep API key/token paths quiet and advanced.
- Show honest gateway unavailable state when the sidecar cannot prove providers.
- Make "run the Tauri app, not a bare browser preview" obvious in docs, not in
  user-facing product copy.

Do not:

- Show OpenRouter, Anthropic, Claude, ChatGPT subscription imagery, or provider
  marketplace language as normal first-run setup.
- Persist onboarding as a permanent settings dashboard after setup.

### Chat / Prepared Desk

Goal: make chat feel like the operating surface for work, not an empty prompt.

Do:

- Open to a prepared brief when data exists.
- Use bubble-less assistant output with quiet section structure.
- Keep user messages visible and intact.
- Collapse tool calls into one-line rows: searched, read, drafted, exported,
  waited for approval.
- Promote files and generated outputs into artifact chips.
- Provide copy/export actions near outputs.

Do not:

- Render long workflow traces as the answer.
- Hide the user's submitted message.
- Let model selector chrome dominate the composer.
- Put many permanent suggestion chips around the composer.

### Work Product

Goal: every useful answer can become a usable file.

Do:

- Use artifact chips for generated outputs: type icon, title, source, size or
  page/sheet count, preview, copy, export, save.
- Make render equal export. Lists, tables, links, blockquotes, diagrams, and
  citations should survive export.
- Keep reload persistence visible: artifacts reappear when reopening a thread.
- Provide whole-thread export separately from artifact export.

Do not:

- Return unstructured JSON as final work product.
- Generate a one-page summary when the user asked for a real document based on
  an attached template.
- Claim DOC/PPT/XLS binary support when only OOXML formats are supported.

### Connections

Goal: connecting tools should feel obvious and honest.

Do:

- Use recognizable logos and plain user value: "Search Notion pages", "Read
  calendar availability", "Draft Gmail replies."
- Show exact readiness: Connected, Needs sign-in, Needs client ID, Blocked by
  gateway, Not available on this gateway.
- One primary action per connector card.
- Never show Connected from `success: true` alone. Require credential or
  readiness proof.

Do not:

- Send slash-prefixed catalog refs as lifecycle names.
- Pretend OAuth works when backend/provider setup is missing.
- Make users choose from registry jargon before showing app value.

### Settings / Inference

Goal: make model setup boring and trustworthy.

Do:

- Keep NEAR AI Cloud as the normal model path.
- Show active model and execution verification in plain language.
- Let configured-but-unverified models send the first verification run.
- Put advanced provider fallbacks behind disclosure.

Do not:

- Reintroduce Anthropic/OpenAI/OpenRouter as normal desktop setup.
- Disable Send just because the first successful run has not happened yet.
- Use model-provider jargon in the main chat surface.

## Copy Direction

Use short, accountable copy:

- "Needs sign-in" over "Authentication unavailable."
- "Connect Notion" over "Configure MCP server."
- "Nothing sent yet" on approvals.
- "This will read 3 calendar events" before a tool call.
- "Save as DOCX and reattach" for unsupported `.doc`.
- "Gateway has not exposed this connector yet" for backend-blocked cards.

Avoid:

- "Operator", "console", "gateway v2", "attestation", "TEE", "enclave",
  "endpoint", "hash", "provider marketplace", "workflow execution trace."
- Triads and marketing-ish AI copy.
- Big friendly placeholders that explain the product instead of helping the
  user act.

## Design Documents Claude Should Produce Before Code

Claude should produce these documents before implementation:

1. Current Surface Truth Map
   - Every visible route, what it promises, what backend data proves it, and
     which promises are currently false or weak.
2. Visual System Spec
   - Type scale, color roles, radius, border, focus, spacing, icon rules,
     density rules, and examples of correct/incorrect components.
3. Prepared Desk IA
   - Home/chat layout, Needs You, Handled Receipts, artifact rail, and composer.
4. Flow Specs
   - First run, first real ask with attachment, connector setup, approval,
     generated document export, returning user, and failure recovery.
5. Component Grammar
   - Artifact chip, approval gate, connector card, tool row, receipt card,
     model source chip, file preview drawer, and blocked-state callout.
6. Acceptance Harness
   - Screenshot matrix, accessibility checks, static tests, e2e tests, and
     hostile user scenarios.

## Build Priority

Build in this order:

1. Typography and density pass over the shipped surfaces.
2. Prepared desk shell on Chat: Needs You, Handled Receipts, composer hierarchy.
3. Artifact chip and preview/export drawer.
4. Connector card truth and one-click setup polish.
5. Approval gate visual grammar.
6. Settings/inference simplification.
7. Empty/loading/failure states across the app.

## Acceptance

A design pass is not done until:

- `npm run prepare:webui-static` completes.
- `CAPTURE_MODE=chat CAPTURE_READY=1 node scripts/capture-readme-shots.mjs`
  refreshes screenshots.
- `output/readme-shots/contact-sheet.png` is reviewed.
- `npm run verify:static-frontend` passes.
- `npm run smoke:webui-static` passes.
- Focused static tests exist for changed components.
- The screenshots show no text overlap, no giant placeholder text, no generic
  provider sprawl, no fake connector readiness, and no artifact stuck only in
  chat prose.

