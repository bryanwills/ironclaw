# Swimming Lanes — Codex × Claude parallel build

Two streams build the v0.3.0 roadmap concurrently. **The only thing
that keeps it from being a merge nightmare is file ownership.** Each
lane below claims exclusive write access to a set of files for the
duration of its task. No two active tasks may share any file in their
"Owned" column.

If a Codex agent needs to touch a file outside its lane (typical
example: registering a new Tauri command in `src-tauri/src/lib.rs`),
it MUST open a tiny "registration PR" first that adds the registration
plumbing in isolation, get it merged, then proceed with the feature
work in its own lane.

## Lane registry

### Stream A — Codex (Rust + isolated TS, no design judgment)

| Lane | Task | Owned files | Forbidden | Touches gateway? |
|------|------|-------------|-----------|------------------|
| **A1** | R49 lazy-load routes | `src/routes/*/+page.svelte` (modify the script header only — `import` → dynamic) + `vite.config.js` + `scripts/check-bundle-size.sh` + `scripts/bundle-baseline.json` | any logic in `+page.svelte`, all `src/lib/**`, all `src-tauri/**` | no |
| **A2** | R50 native TTS Tauri command | `src-tauri/src/tts.rs` (new) + `src-tauri/src/lib.rs` (register only — append 4 lines) + `src-tauri/Cargo.toml` (deps only) + `src/lib/utils/tts.ts` (new wrapper) | any UI / route, any other Tauri module | no |
| **A3** | R53 Mermaid + Plotly + LaTeX renderer | `src/lib/components/MarkdownView.svelte` + `src/lib/components/markdown-renderers/` (new dir) + `src/lib/components/MarkdownView.test.ts` + `package.json` (deps only) | other components, any route | no |
| **A4** | R54 thread sync long-poll | `src/lib/stores/thread-sync.svelte.ts` (new) + `src/lib/stores/thread-sync.test.ts` (new) + `src/routes/+layout.svelte` (mount only — 3 lines) | other stores, components, Rust | yes — `/api/chat/threads/poll` |
| **A5** | R56 sub-agent dispatch wire | `src/lib/api/ironclaw.ts` (append new methods) + `src/lib/api/types.ts` (append types) + `src/lib/stores/sub-agents.svelte.ts` (new) + `src/lib/stores/sub-agents.test.ts` (new) | routes, components | yes — `/api/v1/tasks/*` |
| **A6** | R59 time-travel events wire | `src/lib/api/ironclaw.ts` (append) + `src/lib/api/types.ts` (append) + `src/lib/stores/replay.svelte.ts` (new) + `src/lib/stores/replay.test.ts` (new) | routes, components, Rust | yes — `/api/threads/<id>/events` |
| **A7** | R60 Spotlight indexing | `src-tauri/src/spotlight.rs` (new) + `src-tauri/src/lib.rs` (register only) + `src/lib/stores/threads.svelte.ts` (subscribe + emit — 8 lines max) | UI, other stores | no |
| **A8** | R61 Apple Notes export | `src-tauri/src/notes_export.rs` (new) + `src-tauri/src/lib.rs` (register only) + `src/lib/api/files.ts` (append `exportToNotes`) | UI surfaces, route files | no |
| **A9** | R62 IndexedDB cache | `src/lib/stores/messages.svelte.ts` (wrap read paths only) + `src/lib/util/idb-cache.ts` (new) + `src/lib/util/idb-cache.test.ts` (new) | routes, Rust | no |
| **A10** | R66 Python REPL exec | `src-tauri/src/sandbox_exec.rs` (new) + `src-tauri/src/lib.rs` (register) + `src-tauri/capabilities/default.json` (add scope) + `src/lib/components/markdown-renderers/PythonBlock.svelte` (new) | other components, routes | no |
| **A11** | R67 `/imagine` slash | `src/lib/stores/slash-commands.svelte.ts` (append) + `src/lib/api/ironclaw.ts` (append `generateImage`) + `src/lib/api/types.ts` (append) | routes, components | yes — `/api/llm/image` |
| **A12** | R68 auto-summarization | `src/lib/util/summarize.ts` (new) + `src/lib/stores/messages.svelte.ts` (wrap context-window check — 1 site) + `src/lib/util/summarize.test.ts` (new) | routes, Rust | yes — reuses existing send |
| **A13** | R70 workspace files mount | `src-tauri/src/fs_mount.rs` (new) + `src-tauri/src/lib.rs` (register) + `src/routes/memory/+page.svelte` (single "Mount in Finder" button — 6 lines) | other surfaces | no |
| **A14** | R72 E2E expansion | `tests/e2e/<new-spec>.spec.ts` files only (new files) + `playwright.config.ts` (if needed) | source code | no |

### Stream B — Claude (UX surfaces, design judgment)

| Lane | Task | Owned files | Forbidden | Touches gateway? |
|------|------|-------------|-----------|------------------|
| **B1** | R51 voice answer UI | `src/lib/components/VoiceAnswerBar.svelte` (new) + `src/routes/+page.svelte` (single button + mount block — append only at fixed marker) | shared utilities except `tts.ts` | no |
| **B2** | R52 chat tabs | `src/lib/components/ChatTabs.svelte` (new) + `src/lib/stores/chat-tabs.svelte.ts` (new) + `src/routes/+page.svelte` (header region) | composer area, thread rail | no |
| **B3** | R55 Omnibar | `src/lib/components/Omnibar.svelte` (new) + `src/lib/stores/omnibar.svelte.ts` (new) + `src/routes/+layout.svelte` (mount overlay) | route files except layout | yes — read-only, reuses existing search |
| **B4** | R57 sub-agent inline UI | `src/lib/components/SubAgentChip.svelte` (new) + `src/routes/+page.svelte` (kebab + render integration) | data stores, Rust | no — consumes A5's store |
| **B5** | R58 time-travel UI | `src/lib/components/ReplayBar.svelte` (new) + `src/routes/+page.svelte` (insertion in chat shell) | data stores, Rust | no — consumes A6's store |
| **B6** | R63 vibrancy + title bar | `src-tauri/tauri.conf.json` (window config) + `src/routes/+layout.svelte` (CSS class on root) + `src/app.css` (vibrancy rules) | nothing else | no |
| **B7** | R64 mini-mode | `src/lib/components/MiniPanel.svelte` (new) + `src/lib/stores/mini-mode.svelte.ts` (new) + `src-tauri/src/lib.rs` (window creation — append only) | other windows / routes | no |
| **B8** | R65 inline tool authoring | `src/lib/components/SkillEditorModal.svelte` (new) + `src/lib/stores/skill-editor.svelte.ts` (new) + `src/routes/+page.svelte` (right-click handler) | skills route | no |
| **B9** | R69 markdown live edit | `src/lib/components/EditableBubble.svelte` (new) + `src/routes/+page.svelte` (bubble swap) | MarkdownView core | no |
| **B10** | R71 a11y v2 | scan-only; small edits across many files — coordinated case-by-case via mini-PRs | no big edits | no |

## Hard rules

1. **One lane per branch.** Branch naming: `codex/r<NN>-<slug>` for
   codex, `claude/r<NN>-<slug>` for claude. Never mix.
2. **No squash-merge except for lane completion.** Each PR's commits
   carry their own context; merging fast-forward preserves the trail.
3. **Tests stay green on every merge.** `npm run check && npm run test`
   are pre-push hooks already. If a lane is failing CI, fix in the
   lane's branch, never on main.
4. **No cross-lane refactors without an explicit "registration PR".**
   If A2 needs to change `src-tauri/src/lib.rs` (which B6, B7, A7, A8,
   A10 also touch), the lane opens a small registration PR FIRST,
   waits for it to merge, then proceeds. Lock duration: 30 minutes
   max for a registration PR.
5. **The `src/routes/+page.svelte` chat file is touched by 5 lanes**
   (B1, B2, B4, B5, B8, B9). To keep this manageable:
   - Each lane defines a NAMED INSERTION MARKER (a comment) and only
     adds blocks at its marker. Markers:
     - `<!-- LANE B1 — voice-answer mount -->`
     - `<!-- LANE B2 — chat tabs header -->`
     - `<!-- LANE B4 — sub-agent chip render -->`
     - `<!-- LANE B5 — replay bar -->`
     - `<!-- LANE B8 — skill editor mount -->`
     - `<!-- LANE B9 — editable bubble swap -->`
   - Lane lands its marker FIRST as a no-op comment in main, before
     filling it. Reduces conflict surface.
6. **Worktrees, not branches in-place.** Every lane works in a separate
   `git worktree add .codex-worktrees/r<NN>` so multiple lanes can build
   simultaneously without `cargo target/` thrashing. The `.codex-worktrees/`
   path is already in `.gitignore` (verify before kicking off Wave 1).
7. **A4, A5, A6, A11, A12 touch the gateway.** They MUST probe the
   real endpoint against baremetal3 (tunnel 18789, token
   `62c807bdfa3d40fa7b3b0d141c38e5a6edc0d8839669678c293c9497e821bc3f`)
   before writing a TS wrapper. The brief includes the curl command.
   If the endpoint returns 404, the lane is BLOCKED and the brief gets
   converted into "file an upstream issue" instead of a wire impl.

## Daily merge cadence

Morning: I (claude) rebase main, audit the Codex PR queue, merge any
green ones in lane order. Codex agents open PRs continuously; they
don't wait for me. I batch-review in the 5-min window after each
landing.

Afternoon: I drop into Stream-B work in 90-min focused blocks. Each
block produces a PR with a single lane's worth of work.

Evening: Tag if 3+ PRs landed. Push notes to CHANGELOG. Status check.

## Conflict resolution

If a codex PR and a claude PR both touch the same file (should be
rare given lane discipline — but happens for `+page.svelte` and
`lib.rs`):

1. Whichever PR was OPENED FIRST has priority. The later one rebases.
2. If the rebase is mechanical (insertion markers, no logic overlap),
   the later PR auto-rebases.
3. If the rebase requires a design call, the later PR is paused; I
   resolve by either splitting the work or rewriting the brief.
4. Never resolve a conflict by reverting the earlier PR.

## What stays mine to coordinate

- Version bumps (`package.json`, `tauri.conf.json`, `Cargo.toml`) —
  always done by me, in a dedicated "version bump" commit per tag.
- CHANGELOG entries — I write them when tagging. Codex never edits
  the CHANGELOG.
- `docs/ROADMAP-ELITE.md` + `docs/SWIMMING-LANES.md` themselves —
  these two files are read-only to codex. Updates go through me.
- The Cargo.lock — landed only when I rebase, never carried in a
  lane PR.

## Codex agent launching

Three patterns, in order of preference:

**Pattern 1 — explicit foreground.** Use when you want to watch and
intervene:

```bash
cd ironclaw-desktop
git worktree add .codex-worktrees/r50 -b codex/r50-tts main
cat docs/codex-tasks/50-tts-tauri-command.md | \
  codex exec --cwd .codex-worktrees/r50 \
  --config model_reasoning_effort=high - 2>&1 | tee /tmp/r50.log
```

**Pattern 2 — background fan-out.** Use when several independent lanes
can build in parallel (verify their "Owned" columns don't intersect):

```bash
LANES="49 50 53 54"
for n in $LANES; do
  brief=$(ls docs/codex-tasks/${n}-*.md)
  slug=$(basename "$brief" .md)
  git worktree add ".codex-worktrees/r${n}" -b "codex/r${n}-${slug#*-}" main
  cat "$brief" | codex exec --cwd ".codex-worktrees/r${n}" \
    --config model_reasoning_effort=high - \
    > "/tmp/codex-r${n}.log" 2>&1 &
done
wait
echo "All ${LANES} dispatched. Open PRs:"
for n in $LANES; do
  cd ".codex-worktrees/r${n}" || continue
  gh pr create --title "R${n}" --body-file - <<< "$(cat /tmp/codex-r${n}.log | tail -100)" || true
  cd - > /dev/null
done
```

**Pattern 3 — review-only.** Cheaper, doesn't write code, useful for
audits between waves:

```bash
codex review --base main --title "Wave 2 audit" \
  --config model_reasoning_effort=high
```

## When to stop spawning

Hard cap: never have more than 6 codex agents running simultaneously.
Tauri builds are memory-hungry; 6 worktrees × `cargo build` will OOM
an M-series Mac. Watch `vmstat`; throttle if free memory drops below
4 GB.

Also: if main is broken (CI red on some merged PR), STOP all codex
fan-out. Codex doesn't know main is broken; it'll rebase onto bad
code and produce more bad code. Fix main first, then resume.
