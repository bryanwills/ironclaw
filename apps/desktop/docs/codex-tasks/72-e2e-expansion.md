# R72 — E2E expansion for the v0.2.13–v0.2.19 surfaces (lane A14)

**Branch**: `codex/r72-e2e-expansion`
**Depends on**: nothing

## Context

Eight tags shipped new surfaces with zero Playwright coverage. Add one
focused spec per surface, reusing the `IronClawClient.prototype`
mocking pattern from `tests/e2e/smoke-r46.spec.ts` (READ IT FIRST —
it patches the client via the Vite module graph under the e2e Tauri
shim).

## Owned files (exclusive write)

- `tests/e2e/*.spec.ts` — NEW files only.
- `playwright.config.ts` — only if a timeout / project tweak is
  genuinely needed; prefer leaving it alone.

## Forbidden

- Any `src/**` file. Tests must pass against the CURRENT app — if a
  surface has a bug, file it in the summary, don't patch the source.

## Specs to add (one file each)

1. `omnibar.spec.ts` — Cmd+Space opens the overlay; typing filters;
   Esc closes. Assert the listbox role + at least one command row.
2. `chat-tabs.spec.ts` — seed two threads via the client mock; assert
   two tabs render; clicking the second sets aria-selected; the close
   button removes a tab.
3. `replay-bar.spec.ts` — open a thread with mocked events; Cmd+.
   reveals the replay bar; the range input + play button exist.
4. `dashboard.spec.ts` — navigate to `/dashboard`; assert the tile
   grid renders the default tiles (Recent threads / Active routines /
   Recent skills).
5. `streams.spec.ts` — navigate to `/streams`; assert filter chips +
   at least one card after the mocked aggregator resolves.
6. `voice-answer.spec.ts` — toggle the composer speaker button; assert
   the VoiceAnswerBar appears with the "Voice answer on" label.
7. `multimodal-render.spec.ts` — render a message containing a
   `mermaid` fence + `$x^2$` math + a `plotly` block; assert each
   renderer mounts (the renderers are mocked at the module level, so
   assert the placeholder/promote affordance shows).

## Mocking contract

The e2e Tauri shim throws on `plugin:http|fetch`, so every spec must
patch `IronClawClient.prototype` methods via Vite's dev module graph
exactly like `smoke-r46.spec.ts` does — do NOT modify `_helpers.ts`
(other specs depend on the current behavior). Copy the
`page.addInitScript` / prototype-patch block from smoke-r46 verbatim
and adjust the per-method return values.

## Acceptance

```bash
npx playwright test tests/e2e/omnibar.spec.ts tests/e2e/chat-tabs.spec.ts \
  tests/e2e/replay-bar.spec.ts tests/e2e/dashboard.spec.ts \
  tests/e2e/streams.spec.ts tests/e2e/voice-answer.spec.ts \
  tests/e2e/multimodal-render.spec.ts
```

All 7 specs green. If a surface genuinely can't be driven headless
(e.g. needs a real Tauri window), document why + ship the specs that
do pass.

## Ship

Standard codex commit + push to `codex/r72-e2e-expansion`.

## Failure modes

- Playwright browsers not installed: run `npx playwright install
  chromium` first.
- A spec flakes on async render: use `await expect(locator).toBeVisible()`
  with the default timeout, not arbitrary `waitForTimeout`.
- If the dev server won't boot in the sandbox, document + ship what
  compiles; the specs are still valuable as a landing target.
