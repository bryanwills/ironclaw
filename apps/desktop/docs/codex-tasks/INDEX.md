# Codex task briefs — index

Each `<NN>-<slug>.md` here is a self-contained brief for one Stream-A
lane. Codex has no project memory between sessions, so the brief
repeats: lane, owned files, forbidden files, wire contract, and
acceptance criteria.

See [`../SWIMMING-LANES.md`](../SWIMMING-LANES.md) for the lane map,
[`../ROADMAP-ELITE.md`](../ROADMAP-ELITE.md) for the wave order, and
[`../WORKSPACE-OS.md`](../WORKSPACE-OS.md) for the Wave 2.5 architectural
shift (Dashboard, Streams, Widgets, Council v2, Canvas).

## Detailed briefs (write code from these directly)

| Brief | Lane | Wave | Title |
|-------|------|------|-------|
| [49](./49-lazy-load-routes.md) | A1 | 1 | Lazy-load all SvelteKit routes |
| [50](./50-tts-tauri-command.md) | A2 | 1 | Native macOS TTS Tauri command |
| [53](./53-multimodal-renderers.md) | A3 | 1 | Mermaid + Plotly + KaTeX in MarkdownView |
| [54](./54-thread-sync-longpoll.md) | A4 | 1 | Background thread sync long-poll |
| [56](./56-sub-agent-dispatch.md) | A5 | 2 | Sub-agent dispatch wire (`/api/v1/tasks`) |
| [59](./59-time-travel-wire.md) | A6 | 2 | Time-travel replay events wire |
| [60](./60-spotlight-indexing.md) | A7 | 2 | Spotlight indexing of threads |
| [62](./62-idb-message-cache.md) | A9 | 2 | IndexedDB message cache (offline reads) |
| [79](./79-reply-thread-wire.md) | W2 | 2.5 | Reply-thread wire (Slack-style threads) |
| [81](./81-streams-route.md) | W4 | 2.5 | Streams (activity feed) route |
| [82](./82-generative-widgets.md) | W5 | 2.5 | Generative widget framework |

## Stub briefs (expand before dispatch)

These have file-ownership + acceptance criteria but not yet the full
Rust/TS scaffolding. Expand by porting the pattern from the detailed
briefs above before sending to Codex.

### 61 — Apple Notes export (A8, Wave 2)
**Owned**: `src-tauri/src/notes_export.rs` (new), `src-tauri/src/lib.rs`
(register only — 4 lines), `src/lib/api/files.ts` (append
`exportToNotes(title, body)`).
**Approach**: AppleScript via `osascript`. Pass title + body, the
script creates a new note in Apple Notes' default account. `osascript`
is available via the existing `tauri-plugin-shell` (no new permission
needed if we exec from the Rust side via tokio::process). The body is
HTML — let the model emit HTML for rich Notes; markdown otherwise gets
converted via a tiny `marked` round-trip in the renderer (already
loaded for MarkdownView, no extra bundle).
**Probe**: `osascript -e 'tell application "Notes" to make new note
with properties {name:"smoke", body:"hello"}'`. If that creates a note
in Notes.app, the wire works.

### 66 — Python REPL block runner (A10, Wave 3)
**Owned**: `src-tauri/src/sandbox_exec.rs` (new), `src-tauri/src/lib.rs`
(register), `src-tauri/capabilities/default.json` (add narrow
shell:execute scope), `src/lib/components/markdown-renderers/PythonBlock.svelte`
(new — replaces `python` code blocks in MarkdownView).
**Approach**: shell out to `/usr/bin/python3 -c <stdin>` inside a
fresh tmpdir with `PYTHONDONTWRITEBYTECODE=1`, 30s timeout, capture
stdout/stderr. Stream output via a Tauri event channel. The component
shows a "Run" button next to every `python` code block; clicking
streams output below the block.
**Security**: hardcoded allowlist — only `python3` from `/usr/bin`,
no shell expansion, no inherited env. Document the threat model.

### 67 — `/imagine` slash command (A11, Wave 3)
**Owned**: `src/lib/stores/slash-commands.svelte.ts` (append), `src/lib/api/ironclaw.ts`
(append `generateImage(prompt, options) → ImageGenerationResult`),
`src/lib/api/types.ts` (append types).
**Probe**: `POST /api/llm/image` with `{prompt, size, n}`. Likely
returns `{image_url, image_base64}`. Verify against baremetal3.
**UI hook**: composer parses `/imagine <prompt>` and short-circuits
the chat send — instead, calls `generateImage`, attaches the result
as a `data:image/png;base64,...` user message, optionally also adds
the model's reflection on it.

### 68 — Auto-summarization (A12, Wave 3)
**Owned**: `src/lib/util/summarize.ts` (new), `src/lib/stores/messages.svelte.ts`
(wrap context-window check — one site), `src/lib/util/summarize.test.ts` (new).
**Approach**: when `estimateTokens(history) > THRESHOLD` (say 60k),
send a meta-prompt to the gateway: "Summarize messages 1..N for
context handoff." The response replaces messages 1..N in the local
view with a `SummaryStub` rendered as a disclosure ("47 earlier
messages summarized · click to expand"). The original messages stay
on the server; the local cache (R62) also keeps them for restore.

### 70 — Workspace files mount in Finder (A13, Wave 3)
**Owned**: `src-tauri/src/fs_mount.rs` (new), `src-tauri/src/lib.rs`
(register), `src/routes/memory/+page.svelte` (single "Mount in Finder"
button — 6 lines, at a clear marker).
**Approach**: Option A (light): write the memory tree contents to a
real folder under `~/Documents/IronClaw/` on demand, open in Finder.
Two-way sync via filesystem watcher → gateway PUT on change. Option B
(deep): macFUSE userspace driver — much more powerful, but adds a
~1 MB native dep and triggers a kext approval dialog. **Pick Option A
for v0.3.0**; ship Option B as a "Power tools" toggle in Settings
after v0.4.

### 72 — E2E expansion to cover Wave 1+2+3 surfaces (A14, Wave 4)
**Owned**: New `tests/e2e/*.spec.ts` files only. May modify
`playwright.config.ts` (browser pool, timeouts).
**Approach**: one new spec per major surface added in Waves 1-3:
- `voice-answer.spec.ts` — clicks voice toggle, asserts a TTS-style
  spinner appears.
- `chat-tabs.spec.ts` — opens 3 tabs, drags reorder, closes.
- `omnibar.spec.ts` — Cmd+Space, types "memory test", picks an
  action.
- `sub-agent.spec.ts` — right-click assistant msg → delegate → assert
  chip rendered.
- `replay.spec.ts` — scrubs back, asserts only earlier turns visible.
- `multimodal-render.spec.ts` — sends a message with Mermaid + math +
  Plotly, asserts each rendered.
Reuse the `IronClawClient.prototype` mocking pattern from
`smoke-r46.spec.ts`.
