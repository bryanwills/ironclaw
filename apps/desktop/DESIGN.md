# IronClaw Desktop Design System

IronClaw is not a chat app with better chrome. The front door is a prepared
chief-of-staff desk: the day is triaged, the agent's work is visible, and the
first decision that belongs to the user is already at the top.

## Product Laws

1. **Anticipation over interrogation.** No primary surface should open to a
   blank prompt when the app has local, gateway, or connector state that can
   prepare a brief.
2. **Legible agency.** Autonomous work must be visible, attributed to the
   agent, and reversible or explicitly irreversible.
3. **One surface in focus.** One dominant action per screen. Command/search
   entry points should converge into one Bridge surface.
4. **Discreet density.** Prefer rows, ledgers, gates, and compact metrics over
   decorative dashboard mosaics.
5. **Native to the Mac.** Keyboard-first, restrained motion, crisp typography,
   and quiet material hierarchy.
6. **Honest by construction.** Never render a capability as ready until the
   gateway or local contract proves it.

## Color Meaning

- `#0091fd` / `--v2-accent`: the user's hand. Primary actions, links, focus,
  selected states. Keep one dominant blue action per screen.
- `#fbbf24` / `accent-gold`: the agent's hand. Generated work, proposed
  actions, approval context. Never use gold as decoration.
- `#20d29a`, `#f5c15b`, `#ff6480`: success, warning, danger. Status must route
  through semantic tokens rather than raw Tailwind colors.

## Type And Geometry

- Font: self-hosted Inter Variable first, with system fallbacks.
- Display: 28/600. Title: 20/600. Section: 16/600. Body: 14/450. Label:
  12/500. Micro caps: 11/600.
- Numbers use tabular figures by default.
- Controls use `6px`, cards/panels use `12px`, shell/modals use `16px`.
  `rounded-full` is reserved for true circles.

## Surface Archetypes

- **Today:** Morning Brief first, then active matters and handled receipts.
  Tiles are secondary signals, not the first impression.
- **Desk:** approval inbox and handled feed. Gates must block risky actions.
- **Work:** durable dossiers: objective, context, approvals, artifacts,
  watches, receipts.
- **Chat:** direct conversation instrument. Risky asks should create Work and
  Desk state rather than staying buried in transcript text.
- **Canvas:** thinking annex, not the lobby.

## North-Star Test

A new user opens IronClaw cold and can answer within sixty seconds:

- What needs me?
- What did the agent do on its own?
- What can I approve, deny, undo, or open next?
