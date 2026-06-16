# Visual System Spec

Date: 2026-06-13

## Thesis

IronClaw Desktop is a serious macOS chief-of-staff instrument. It should feel
calm, dense, exact, and operational: prepared desk first, chat second.

## Type

- Primary family: self-hosted `Inter Variable`, then Inter and system fallbacks.
- Body/control text: 13-15px.
- Page headings: 20-32px, restrained.
- Metadata: 11-12px mono or compact sans.
- Numbers use tabular figures globally.
- No oversized placeholder prose.
- No negative letter-spacing in shipped UI; caps styling must not depend on
  letter spacing to remain legible.

## Color Roles

- Signal blue `#0091fd`: the user's hand. Use for the single primary action,
  focus, selected navigation, and direct user-controlled links.
- Gold `#fbbf24`: the agent's hand. Use only for generated work, proposals,
  provenance, receipts, and approval context.
- Success/warning/danger: semantic tokens only.
- Dark desk mode is the default. Light mode is opt-in.
- No warm beige, purple-blue gradient, decorative glow, or ornamental blobs.

## Accent Discipline

Each screen should have one dominant blue action. Secondary actions recede into
bordered or subtle variants. If two blue buttons compete, one must become
secondary, ghost, or a link.

## Radius, Border, Shadow

- Controls: 6-10px radius.
- Panels/cards: 8-12px radius.
- Modals/shells: 12-16px maximum.
- Hairline borders carry hierarchy.
- Shadows are mostly off; popovers/modals may use a functional shadow.
- Cards are for repeated objects, modals, and framed tools, not page sections.

## Spacing And Density

- Prefer rows, ledgers, split panes, and compact groups over dashboard mosaics.
- Default page padding: 16-24px.
- Keep scan lines tight; avoid hero-scale type inside operational panels.
- Avoid nested card piles. A card inside a card needs a clear interaction reason.

## Component Examples

- `Button`: flat signal-blue primary; secondary/ghost recede.
- `Card`: tokenized solid panel with hairline border.
- `Badge`: semantic pill with optional live dot; no fake readiness.
- `Input` / `Select`: dense controls, blue focus, readable placeholder.
- `ProviderLogo`: NEAR logo and connector marks only where they improve scanning.

## Anti-Patterns

- ChatGPT/Codex subscription buttons or provider marketplaces in normal setup.
- OpenRouter/Anthropic/Claude branding in normal desktop model setup.
- Fake connected/ready states.
- Huge gray prompt copy.
- Decorative mascot-led product surfaces.
- Long workflow sludge in chat.
- Unstructured JSON as final work product.
- Status color used as decoration.

## Lexicon

| Say | Avoid | Why |
| --- | --- | --- |
| `you`, `your workspace`, `your attention` | `operator` | The product serves a person, not an operations console persona. |
| `IronClaw Desktop`, `IronClaw` | `console`, `Gateway v2` | The app should feel like the product, not its transport or debug shell. |
| `Connections`, `apps`, `knowledge apps` | `provider marketplace`, `MCP Servers` in normal UI | Users connect work tools; backend categories stay below the glass. |
| `Scheduled work`, `routines`, `automations` | `execution loops` as default copy | Scheduled work should read as work management, not infrastructure. |
| `NEAR AI Cloud` | ChatGPT/OpenRouter/Anthropic/Claude as normal setup choices | Normal model access routes through IronClaw infrastructure. |
