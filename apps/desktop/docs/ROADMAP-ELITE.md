# Elite Roadmap — IronClaw Desktop (v0.2.11 → v0.3.0)

**Vision.** Take a chat client built around a remote agent and turn it
into the desktop tool people leave running all day. Three pillars: deep
macOS integration (Spotlight, TTS, Notes, vibrancy), inline agent
superpowers (sub-agent dispatch, time-travel replay, code execution),
multi-modal output (Mermaid, Plotly, LaTeX, image gen). All shipped
incrementally so the app never regresses.

Two streams run in parallel: **Stream A — Codex agents** (Rust + isolated
TS, no design judgment, file-locked lanes) and **Stream B — me / Claude**
(visual surfaces, cross-route UX, design judgment). The lane discipline
is in [`SWIMMING-LANES.md`](./SWIMMING-LANES.md) — every task says
which lane it belongs to and which files it owns. **No two tasks may
touch the same file at the same time.** Period.

## State at the starting line

- **HEAD**: `66598ce` (v0.2.10 tag pushed, v0.2.11 commit pending tag).
- **Local app**: `.app` rebuild in progress (bash task `bp5byhhs9`).
  Running app PID 86267 connected to baremetal3 via tunnel 18789.
- **Tests**: 257/257 vitest passing, 0 svelte-check errors.
- **Bundle budget**: 344 / 360 KB gzipped (95.6%) per R47. R49 lazy-loads
  will buy back ~40 KB.
- **GitHub Actions**: blocked on billing — fix at github.com/settings/billing
  before any tag-triggered release builds run.

## Waves

### Wave 1 — In flight today (24h)

| # | Task | Lane | Owner | Status |
|---|------|------|-------|--------|
| R49 | Lazy-load all routes (bundle savings) | A1 | codex | pending |
| R50 | Native macOS TTS (`say_text` Tauri command) | A2 | codex | pending |
| R51 | Voice answer mode UI (uses R50) | B1 | claude | blocked on R50 |
| R52 | Tabs in chat header (Chrome-style) | B2 | claude | pending |
| R53 | Mermaid + Plotly + LaTeX in MarkdownView | A3 | codex | pending |
| R54 | Background thread sync long-poll | A4 | codex | pending |

### Wave 2 — This week (3–7d)

| # | Task | Lane | Owner | Status |
|---|------|------|-------|--------|
| R55 | Omnibar (Cmd+Space, semantic search + actions) | B3 | claude | pending |
| R56 | Sub-agent dispatching (`/api/v1/tasks` wire) | A5 | codex | pending |
| R57 | Sub-agent inline UI (uses R56) | B4 | claude | blocked on R56 |
| R58 | Time-travel replay (UI) | B5 | claude | pending |
| R59 | Time-travel replay (wire — events table) | A6 | codex | pending |
| R60 | Spotlight indexing (`~/Library/Metadata/IronClaw`) | A7 | codex | pending |
| R61 | Apple Notes export (AppleScript via shell plugin) | A8 | codex | pending |
| R62 | IndexedDB message cache (offline reads) | A9 | codex | pending |

### Wave 3 — Next sprint (2 weeks)

| # | Task | Lane | Owner | Status |
|---|------|------|-------|--------|
| R63 | Vibrancy + native title bar inset | B6 | claude | pending |
| R64 | Mini-mode (Cmd+Shift+M floating panel) | B7 | claude | pending |
| R65 | Inline tool authoring modal | B8 | claude | pending |
| R66 | Python REPL block runner (sandboxed exec) | A10 | codex | pending |
| R67 | Image generation slash command (`/imagine`) | A11 | codex | pending |
| R68 | Auto-summarization of long threads | A12 | codex | pending |
| R69 | Markdown live edit per bubble | B9 | claude | pending |
| R70 | Workspace files (mount memory tree as Finder dir) | A13 | codex | pending |

### Wave 4 — Polish + release v0.3.0

| # | Task | Lane | Owner | Status |
|---|------|------|-------|--------|
| R71 | a11y deep pass v2 (new surfaces) | B10 | claude | pending |
| R72 | E2E expansion to cover R49–R70 | A14 | codex | pending |
| R73 | Codex elite review of v0.3.0 trail | — | codex review | pending |
| R74 | Fresh-user simulation v3 | — | claude | pending |
| R75 | Tag v0.3.0 + signed DMG | — | claude | pending |

## What "elite" means concretely

Five things that have to be true at v0.3.0 to merit the label:

1. **Time-to-first-chat < 60s on a fresh Mac.** OAuth or paste-token, no
   tunnel setup if NEAR.AI Cloud, threaded chat live in under a minute.
2. **Cmd+Space is the only thing you need to know.** Search across
   threads, knowledge, skills, memory; "Open thread X", "Run skill Y",
   "Show memory Z" actions; AI-ranked.
3. **The model can do real work without leaving the app.** Python
   blocks execute, files attach + parse, sub-agents dispatch, images
   generate, Mermaid renders, LaTeX renders.
4. **The replay button.** Scrub backward through a conversation, watch
   the tools the model considered and chose. Nothing else has this.
5. **Native everywhere it matters.** Spotlight finds threads. Notes
   exports work. TTS speaks. Vibrancy + traffic lights inset. No
   web-app uncanny valley.

## Codex invocation pattern

Each Stream-A task ships as a self-contained brief in
`docs/codex-tasks/<NN>-<slug>.md`. To dispatch one:

```bash
# Foreground (you watch it work)
cat docs/codex-tasks/49-lazy-load-routes.md | \
  codex exec --base main --config model_reasoning_effort=high -

# Background (you fire several at once)
for n in 49 50 53 54; do
  cat docs/codex-tasks/${n}-*.md | \
    codex exec --base main --config model_reasoning_effort=high - \
    > /tmp/codex-r${n}.log 2>&1 &
done
wait
```

**Critical**: every codex task creates its own worktree on a
`codex/r<NN>-<slug>` branch under `.codex-worktrees/`. Codex does not
push directly; it opens a PR. You review, then merge in roadmap order.
See [`SWIMMING-LANES.md`](./SWIMMING-LANES.md) for the worktree +
merge protocol.

## Task brief index

The brief for each Stream-A task lives at
`docs/codex-tasks/<NN>-<slug>.md`. Briefs are self-contained — codex
has no project memory, so each one repeats:

- **Lane**: which lane (e.g. A3, B2)
- **Owned files**: exclusive write access for the duration of the task
- **Forbidden files**: do not touch under any circumstance
- **Wire contract**: any new gateway endpoints, with curl probes
- **Acceptance**: how to know it's done (test commands, manual check)
- **Out of scope**: features that look related but aren't this task

Stream-B tasks (claude) do not get briefs — I keep state in this
session. They're listed in the waves table above so codex agents can
see what's coming and avoid stepping on me.

## Merge protocol

Daily, in this order:

1. Claude rebases `main` (always green tip).
2. Codex PRs get reviewed in lane order (A1, A2, A3 … A14). I review
   each, run the full test suite locally, merge fast-forward if green.
3. Claude streams (B-lanes) merge AFTER all Codex PRs that share a
   touched directory have landed. The lanes doc records which
   directories each lane touches.
4. Conflicts get resolved on the codex side — codex rebases its branch
   onto the new `main`. If the conflict is structural, the brief gets
   rewritten and re-dispatched.
5. Tag every 3–5 merged PRs (`v0.2.12`, `v0.2.13`, …). Tag `v0.3.0`
   when Wave 4 lands.

## Stretch — past v0.3.0

Not in the waves but worth tracking for next quarter:

- Real-time collaboration via WebRTC (two cursors on one thread).
- Continuity Camera attach (iPhone snap → desktop chat).
- macOS Shortcuts actions (App Intents).
- Universal Control / handoff to iPad client.
- WebGPU-accelerated MarkdownView for very large transcripts.

Run when the v0.3.0 dust settles.
