# R97 — E2E: council overlay summoned from chat

**Lane**: A24 (codex). **Branch**: `codex/r97-council-panel-e2e`.
Playwright spec only. New file — conflict-free.

## Context
Council was refactored from a `/council` route into an in-chat overlay
(`CouncilPanel`, opened by typing `/council <prompt>` in the composer and
sending). The old route E2E was deleted. This restores coverage for the
new flow.

## Owned files (exclusive)
- `tests/e2e/council-panel.spec.ts` — NEW.

## Forbidden
Everything else.

## What to build
Model the harness on the EXISTING `tests/e2e/smoke-r46.spec.ts` — reuse
its helper imports (`mockTauri`, `mockGateway`, `mockGatewaySurfaces`,
`pinConnectionConnected`, `stubClientMethods`, and the `SETTINGS`
constant) exactly as that file does. Read smoke-r46.spec.ts first to copy
the setup boilerplate verbatim.

Test (one `test(...)`):
1. Standard connected setup (mockTauri + mockGateway + mockGatewaySurfaces
   + pinConnectionConnected).
2. `stubClientMethods(page, { listLlmProviders: [ {id:'nearai',name:'NEAR AI',configured:true,builtin:true}, {id:'openrouter',name:'OpenRouter',configured:true,builtin:true} ] })`.
3. `await page.goto('/')`.
4. Find the chat composer textarea (inspect +page.svelte for its
   placeholder/aria — likely `getByPlaceholder(...)`; if unsure use
   `page.locator('textarea').first()`), fill it with `/council compare two databases`, and press Enter (or click the send button).
5. Assert the council dialog appears: `await expect(page.getByRole('dialog', { name: /council/i })).toBeVisible({ timeout: 5000 })`.
6. Assert both provider names render as chips (`getByRole('button', { name: 'NEAR AI' })` and `'OpenRouter'` visible).
7. Assert the "Convene" button is present.

Keep it to ONE focused test. If the composer/send selectors are
uncertain, read `src/routes/+page.svelte` to confirm before guessing.

## Acceptance
- `npx tsc --noEmit` style: the spec must compile under the repo's
  Playwright + TS config (it won't be RUN here — CI is billing-blocked —
  but `npm run check` must stay clean and the file must be valid TS/Playwright).
- No `any`, no `.only`, no hardcoded sleeps > 5s.
