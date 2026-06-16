# Prompt: Hostile Design Review

You are reviewing IronClaw Desktop as a hostile product designer. Be direct,
specific, and evidence-bound.

## Context To Load

Read:

- `CLAUDE.md`
- `docs/reviews/design-pass-research-synthesis-2026-06-10.md`
- `docs/reviews/hostile-product-review-2026-06-12.md`
- `docs/reviews/practical-work-scenario-corpus.md`

Then inspect current screenshots:

- `output/readme-shots/contact-sheet.png`
- `output/readme-shots/onboarding-welcome.png`
- `output/readme-shots/chat.png`
- `output/readme-shots/settings-inference.png`
- `output/readme-shots/extensions.png`
- `output/readme-shots/extensions-registry.png`

If screenshots are stale or missing, run:

```sh
npm run prepare:webui-static
CAPTURE_MODE=chat CAPTURE_READY=1 node scripts/capture-readme-shots.mjs
```

## Review Contract

Judge every surface against the chief-of-staff thesis:

- Does it anticipate work instead of asking the user to start cold?
- Does it show what needs the user?
- Does it make agent actions legible and reversible?
- Does it expose work product as usable files, not chat sludge?
- Does it keep connector/model readiness honest?
- Does it keep NEAR AI Cloud as the normal model path?
- Does it feel like a serious desktop instrument?

## Required Output

Return a RED/YELLOW/GREEN table with these rows:

- Onboarding
- Chat prepared desk
- Composer and model selector
- Attachments and generated artifacts
- Approval and auth gates
- Connections installed state
- Connections registry
- Settings / AI setup
- Sidebar / navigation
- Copy and terminology
- Visual system / typography / density
- Safety and honesty

For each row include:

- Rating
- Evidence path or route
- What is broken
- Why it matters to the user
- Highest-value fix
- Test or screenshot that would prove the fix

End with:

- Top 5 product lies or false promises
- Top 5 design pattern opportunities
- Top 5 implementation moves, ordered by value

Do not soften issues because previous agents worked hard. If a user would still
get confused, call it RED.
