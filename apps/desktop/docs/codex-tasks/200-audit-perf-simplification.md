# R200 — fulsome audit + perf/latency/simplification pass (codex, broad)

**Lane**: codex, isolated worktree `codex/r200-audit-perf`. Unlike the small
util briefs, this is a BROAD pass — you may read the whole repo. Bound the
WRITES tightly (see Safety).

This is a Tauri v2 + SvelteKit 2 + Svelte 5 (runes) desktop app for the
IronClaw agent. ~850 source files, 541 vitest tests, `npm run check`
(svelte-check) clean. Rust proxy in `src-tauri/`.

## Deliverables (in this order of priority)

1. **`docs/AUDIT-perf.md`** — a prioritized report. This is the PRIMARY
   deliverable. Sections:
   - **Latency / runtime hotspots**: render-path costs (large `$derived`
     recomputes, unkeyed/!large `{#each}`, effects that over-fire, sync work
     on the chat stream path), IPC/`invoke` round-trips, SSE handling, IDB
     reads on hot paths. Cite `file:line`, estimate impact (H/M/L), give the
     fix.
   - **Startup / bundle**: heavy imports not code-split (hljs, marked,
     mermaid, plotly, katex, tldraw), eager work in `+layout` boot, route
     bundle sizes. Each with a concrete reduction.
   - **Dead / duplicated code**: unused exports, copy-pasted logic that
     should be one helper, stores/components with no consumer.
   - **Simplification**: over-abstracted or needlessly complex spots where a
     smaller shape is equivalent.
   Rank everything P0/P1/P2 with one-line fixes.

2. **Apply ONLY the safe, mechanical, behavior-preserving wins** from the
   report — the kind that obviously can't change behavior (dead-code
   removal, an unnecessary re-derive, a missing `{#each}` key, a lazy import
   for a heavy module, collapsing duplicated literals into a const). Leave
   anything that changes behavior, public shape, or needs judgment for the
   report only (the maintainer applies those after review).

## Safety / constraints (hard)

- **Do NOT touch**: anything under `src-tauri/` (Rust), `src/lib/api/*`
  (gateway wire shapes — fragile), the CoS files shipped in v0.4.x
  (`src/lib/{stores,util,components,data}/{briefing,triage,draft,open-loops,personas}*`
  and the panels) — they were just reviewed. No version bumps, no CHANGELOG,
  no `package.json` dependency changes.
- **Must stay green**: run `npm run check` AND `npx vitest run` after your
  changes; if anything fails, revert that change. Do not weaken or delete
  tests to make them pass.
- No `any`, no `console.log`, no new non-stdlib deps.
- Keep each applied change small and independently revertible; the
  maintainer cherry-picks. Prefer fewer, certain wins over many speculative
  ones.

## Output
Commit the report + applied changes on the worktree branch. Summarize at the
end: what you changed (file list) vs. what you left in the report for review.
