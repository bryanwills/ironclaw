# Design Acceptance Plan

Date: 2026-06-13

## Screenshot Matrix

Required after UI changes:

- `output/readme-shots/onboarding-welcome.png`
- `output/readme-shots/chat.png`
- `output/readme-shots/settings-inference.png`
- `output/readme-shots/extensions.png`
- `output/readme-shots/extensions-registry.png`
- `output/readme-shots/contact-sheet.png`

Capture command:

```sh
npm run prepare:webui-static
CAPTURE_MODE=chat CAPTURE_READY=1 node scripts/capture-readme-shots.mjs
```

## Static Tests

Required minimum:

```sh
npm run verify:static-frontend
npm run smoke:webui-static
npm run test:static
```

Focused tests for this design slice:

```sh
node --test crates/ironclaw_webui_v2_static/static/js/pages/settings/lib/desktop-provider-contract.test.mjs
node --test crates/ironclaw_webui_v2_static/static/js/pages/settings/components/provider-components.test.mjs
node --test crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/chat-input.test.mjs
node --test crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/extensions-design-contract.test.mjs
```

## Rendered UI Checks

For every captured surface:

- app is not blank.
- no framework overlay.
- no horizontal overflow at desktop and mobile widths.
- no ChatGPT/Codex/OpenRouter/Anthropic/Claude normal setup branding.
- one dominant blue primary action.
- blocked connectors/providers are honest.
- visible text fits buttons/cards.

## Accessibility Checks

- Keyboard access to sidebar, model popover, composer, setup actions.
- Focus ring visible.
- Buttons have labels or icon labels.
- Warning/blocked states do not rely on color alone.
- Modal/drawer close affordances are reachable.

## Hostile Scenario Corpus

Use `docs/reviews/practical-work-scenario-corpus.md` for product-flow review.
Legal/finance/operations asks must create approval boundaries and artifacts, not
just prose. Prompt-injection instructions from attached files must be rejected
or recorded as untrusted source text.

## Before/After Evidence

Any claim that the design is improved needs:

- route or screenshot path.
- user promise improved.
- exact command or browser interaction used.
- remaining RED item when live backend proof is missing.

## Stop Conditions

Stop and mark RED instead of claiming success when:

- screenshots cannot be captured.
- gateway data cannot prove connector/model/work-product state.
- a route renders only mocked/localStorage readiness.
- a generated export cannot be parsed.
- normal setup leaks third-party provider branding again.
