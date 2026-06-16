# Workspace OS — beyond the chat-list framing

The current IronClaw Desktop puts the thread list in the sidebar and a
chat surface as `/`. That mirrors a 2023 chat client. Real agent work
in 2026 is concurrent — three watchers running, two briefings posted
this morning, a council debate in flight, two research jobs in the
background — and "scroll through threads in order" is the wrong primary
view.

This doc lands the architectural shift that the mobile mockups (Daily
briefing, Streams, Council, Dashboard, Generative widgets, Spatial
canvas) made obvious: **chat is one surface among many, not the home.**
Desktop has 3× the real estate; we get to show many of them at once.

This sits between Wave 2 and Wave 3 in
[`ROADMAP-ELITE.md`](./ROADMAP-ELITE.md). New lane block: **W**
(Workspace OS, lanes W1–W8). Eight lanes, four Codex + four Claude.

## The shift in one line

```
Before: sidebar(threads) + main(chat)
After:  sidebar(workspaces) + main(dashboard) — chat is one surface
```

Concretely, the default `/` route becomes a Dashboard. Threads live at
`/chat` (preserved, no behavior change there). Sidebar nav swaps Chat
out as the top entry; the new top entry is "Today" (the Dashboard).

## Six new surfaces

Numbers match the mobile mockup so the design intent stays paired.

### 1. Threaded chat (intra-message threads)

Slack-style. Hover any message in `/chat`, get a "Reply in thread"
link. Replies open a sub-conversation panel that doesn't displace the
main thread. The model addresses replies in-thread; the parent thread
sees a `↳ N replies` chip.

Distinct from the existing "thread" (which is a whole conversation).
We call the new one a **reply-thread** in code; the existing one stays
a **thread**.

Why on desktop: replies-in-thread is the only way to ask "what's the
impact on oil?" without losing the briefing context. Today's flat
chat forces a new thread or a derail.

### 2. Streams (feed)

Activity feed across the workspace. Cards for: briefings posted,
watchers triggered, research jobs completed, council debates, skill
runs, knowledge writes. Filterable (All / Briefings / Watchers /
Chats). Chronological.

This is what was historically the Jobs surface, but rebuilt as a
first-class home-tier surface with rich cards (preview + sources +
"Ask follow-up" CTA per card).

### 3. Dashboard (Today)

The new `/`. Tile grid. Live + scheduled. Tiles are widgets — each
one knows how to refresh itself. Each tile owns its own composer
("Ask anything…"). Drag to rearrange. Pin from anywhere.

Default tile set on fresh install:

- Daily news brief
- ETH watcher
- Active council debate (if any)
- Scheduled (next 5 routines)

Fresh installs also render the dashboard-level **Get Started** tracker
above the tile grid. It is profile-scoped and advances through: runner
connected, workspace pack ready, and first approval-mode mission
launched. Workspace pack readiness comes from Extensions; missions are
disabled until their required connector pack is ready and link to
`/extensions?focus=<extension>` for completion.

User-added tiles: anything pinned from chat, council, or research.

### 4. Generative widgets

The framework: when the assistant emits structured output (table,
chart, comparison, checklist), render it as a first-class widget
instead of inline markdown. Widget = card with title + canonical
source + refresh + pin-to-dashboard + share.

Foundational primitive: Mermaid + Plotly + KaTeX (R53) renderers
already exist as a side effect. R57b makes them PROMOTABLE — right
click → "Pin as widget" → it gets a stable id and shows up on the
dashboard with auto-refresh.

### 5. Council (group chat)

Already exists as `/council` (R40). Rebuild with:

- Live presence strip: `Claude · thinking`, `Gemini · ready`,
  `GLM · reasoning` — colored chips per model, animated dots while
  generating.
- Streaming side-by-side, NOT sequential (R40's gateway gap is the
  blocker; W3 below addresses it OR ships a degraded multi-window
  variant if the gateway doesn't land per-call provider override).
- Per-message addressing: `@gemini say more on the proof gap` sends
  ONLY to that model.
- "Dissents" badge — when one model disagrees with the consensus,
  surface it.
- "Synthesize" button after N rounds — meta-model produces a
  consensus summary.

### 6. Spatial canvas

The big swing. Infinite canvas (tldraw embed). Threads / widgets /
sub-agent results become nodes. Drag to connect with arrows. Each
node has its own composer ("Ask this node…") that runs with the
node's context as system prompt.

Use case: research mode. Open a question as a root node. Connect
sub-agent results as children. Build a graph of how ideas branched.
Export as PNG / SVG / JSON.

## New lanes in `SWIMMING-LANES.md`

### Stream W — split across Codex and Claude

| Lane   | Task                                                | Owned files                                                                                                                                                                                                                                            | Forbidden                  | Owner  |
| ------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | ------ |
| **W1** | Dashboard (`/dashboard` route + tile framework)     | `src/routes/dashboard/+page.svelte` (new) + `src/lib/components/dashboard/` (new dir) + `src/lib/stores/dashboard.svelte.ts` (new) + `src/lib/components/Sidebar.svelte` (item reorder — 4 lines max)                                                  | other routes, other stores | claude |
| **W2** | Reply-thread store + wire                           | `src/lib/stores/reply-threads.svelte.ts` (new) + `src/lib/api/ironclaw.ts` (append `postReplyThread`, `streamReplyThread`) + `src/lib/api/types.ts` (append)                                                                                           | route files, components    | codex  |
| **W3** | Reply-thread UI                                     | `src/lib/components/ReplyThreadPanel.svelte` (new) + `src/routes/+page.svelte` (mount under named marker) + `src/lib/components/MessageBubble.svelte` (hover affordance — uses A3 split)                                                               | data stores                | claude |
| **W4** | Streams route                                       | `src/routes/streams/+page.svelte` (new) + `src/lib/stores/streams.svelte.ts` (new) + `src/lib/components/Sidebar.svelte` (item add — 4 lines max)                                                                                                      | other routes               | codex  |
| **W5** | Generative widget framework                         | `src/lib/components/widgets/` (new dir — Widget.svelte base + ChartWidget, TableWidget, TextWidget, MermaidWidget subclasses) + `src/lib/stores/widgets.svelte.ts` (new) + `src/lib/components/MarkdownView.svelte` (promote handlers — uses A3 split) | other components           | codex  |
| **W6** | Council v2 (live presence + streaming side-by-side) | `src/routes/council/+page.svelte` (replace contents) + `src/lib/stores/council.svelte.ts` (rewrite) + `src/lib/components/ModelPresenceStrip.svelte` (new) + `src/lib/components/CouncilColumn.svelte` (new)                                           | other routes               | claude |
| **W7** | Spatial canvas                                      | `src/routes/canvas/+page.svelte` (new) + `src/lib/components/canvas/` (new dir) + `src/lib/stores/canvas.svelte.ts` (new) + `package.json` (add `tldraw` dep)                                                                                          | other routes               | claude |
| **W8** | Tiles + drag-to-rearrange                           | `src/lib/components/dashboard/Tile.svelte` (new) + `src/lib/components/dashboard/TileGrid.svelte` (new) + drag-drop helper at `src/lib/util/dnd-grid.ts` (new)                                                                                         | non-dashboard files        | claude |

## Anti-collision matrix

W1 + W8 both touch the dashboard subtree but W1 owns the route +
framework and W8 owns the tile components. They land in this order:
W8 (tile components) merges first as a self-contained set; W1 then
imports them. No file overlap because W1 doesn't write to
`Tile.svelte` / `TileGrid.svelte`, and W8 doesn't write to the route
file or the dashboard store.

W2 + W3 are the reply-thread pair, W2 (wire) lands first. W3 (UI)
imports W2's store. Insertion marker in `+page.svelte` for W3 is
`<!-- LANE W3 — reply-thread mount -->`.

W5 sits on top of A3 (Mermaid/Plotly/KaTeX renderers). A3 must land
first. W5 then adds a thin "promote to widget" layer over those
renderers without modifying their guts.

W6 rewrites `/council` — coordinate with R40's existing test suite
(`council.test.ts` — confirm it lives at that path and update for the
new shape).

W7 has the biggest new dep (`tldraw` is ~600 KB minified). It MUST
ship lazy-loaded behind the route — verify in the bundle check.

## Updated wave order

Insert Wave 2.5 between Wave 2 (R56–R62) and Wave 3 (R63–R70):

### Wave 2.5 — Workspace OS (3–5 days)

| #   | Task                                | Lane | Owner  | Notes                                              |
| --- | ----------------------------------- | ---- | ------ | -------------------------------------------------- |
| R77 | Dashboard route + tile framework    | W1   | claude | new `/` default after onboarding                   |
| R78 | Tile components + drag-to-rearrange | W8   | claude | lands first, W1 imports                            |
| R79 | Reply-thread wire                   | W2   | codex  | brief: `docs/codex-tasks/79-reply-thread-wire.md`  |
| R80 | Reply-thread UI                     | W3   | claude | mounts under W3 marker                             |
| R81 | Streams route                       | W4   | codex  | brief: `docs/codex-tasks/81-streams-route.md`      |
| R82 | Generative widget framework         | W5   | codex  | brief: `docs/codex-tasks/82-generative-widgets.md` |
| R83 | Council v2 (live presence)          | W6   | claude | rewrites `/council`                                |
| R84 | Spatial canvas                      | W7   | claude | tldraw embed, lazy-loaded                          |

Wave 3 (R63–R70) stays as-is and runs AFTER Wave 2.5 since the
mini-mode / vibrancy / inline tool authoring all benefit from the
Dashboard + widget framework being in place.

## What this changes about "elite"

Updated bar (replaces §"What 'elite' means concretely" in the main
roadmap):

1. **The home is a Dashboard, not a chat list.** "Today" shows the
   user what's live, what's scheduled, what's new.
2. **Concurrent work is visible.** Multi-model council shows
   `Claude · thinking` / `Gemini · ready` chips. Watchers show
   triggered alerts on the dashboard. Research jobs stream progress
   into Streams.
3. **Structured output is first-class.** Tables, charts, comparisons
   render as widgets — pinnable, refreshable, exportable, shareable.
4. **Chat is one surface among many.** Threaded replies, council
   debates, sub-agent dispatches all work, but the user navigates by
   workspace surface, not by thread.
5. **Spatial canvas exists.** For research-mode users, freeform
   layout beats linear scroll.

The earlier "elite" bullets (TTFC <60s, Cmd+Space, native macOS, real
work without leaving the app, time-travel replay) still apply. This
addendum is additive.

## Migration / backwards compat

- `/` redirects to `/dashboard` AFTER user has completed onboarding.
  Pre-onboarding still goes to `/onboarding`.
- Successful local or hosted onboarding routes directly to
  `/dashboard`, not raw chat. The explicit setup-later path also lands
  on `/dashboard` so Get Started remains visible.
- First-run missions keep side effects behind approval mode. Launching a
  mission inserts a source-marked mission prompt into the chat surface;
  connector requirements gate launch before the prompt is available.
- `/chat` (or `/threads`) takes over the current `+page.svelte`. The
  existing chat surface stays byte-identical at the new path. Cmd+1
  shortcut still maps to chat for users who memorize it.
- Sidebar reorders to: Today (new) → Streams (new) → Chat → Council
  → Memory → Skills → Routines → Jobs → Logs → Extensions → Engine
  → Settings.
- Settings keeps the existing Chat-default toggle: power users can
  set `/chat` as their landing route, dashboard as secondary.
- The dashboard tile set is per-profile, persisted in
  `settings.json` under `profiles[i].dashboard = { tiles: [...] }`.
  Existing profiles without that field get the default tile set on
  first render (no migration needed).

## Tests we add

- `dashboard.test.ts` — tile grid renders, drag rearranges, pins
  persist to settings.
- `reply-threads.test.ts` — wire store, SSE handling.
- `streams.test.ts` — feed pagination, filter chips.
- `widgets.test.ts` — promote-to-widget happy path, refresh cycle.
- `council.test.ts` — model presence transitions, side-by-side
  streaming.
- `canvas.test.ts` — node creation, connection arrows, ask-this-node
  composer wires to gateway.
- E2E: one Playwright spec per Wave 2.5 surface, mocking pattern from
  `smoke-r46.spec.ts`.
