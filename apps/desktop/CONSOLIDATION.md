# IronClaw Desktop → monorepo consolidation

This branch brings the IronClaw macOS desktop app (formerly the standalone
`nearai/ironclaw-desktop-app` repo) into the monorepo under `apps/desktop/`, so
the desktop ships from **one repository with one delivery and release pipeline**
alongside the rest of IronClaw.

## What this branch does

- Adds the entire desktop app under `apps/desktop/` — the Tauri v2 shell
  (`src-tauri/`), the static WebUI it bundles, build/QA scripts, tests, and docs.
- **Purely additive.** It touches no existing monorepo file; `crates/`,
  workspace `Cargo.toml`, and CI are unchanged, so `main` builds exactly as
  before. (Confirm with `git diff --stat main` — only `apps/desktop/**`.)
- Wires the **sidecar build to the monorepo itself**: `scripts/build-reborn-sidecars.sh`
  now defaults `IRONCLAW_REPO_DIR` to the monorepo root, so the bundled
  `ironclaw-reborn` sidecar builds from this same tree — one source of truth.

## The one open item: frontend drift

The desktop was scaffolded as a separate repo and **vendors its own copy of the
`ironclaw_webui_v2_static` frontend** (`apps/desktop/crates/ironclaw_webui_v2_static/static`).
That copy and the monorepo's `crates/ironclaw_webui_v2_static` have diverged
heavily (91 desktop-only files, 31 monorepo-only, 234 differing — see
[`docs/DESKTOP-DRIFT-ANALYSIS.md`](docs/DESKTOP-DRIFT-ANALYSIS.md)).

Merging the two frontends into the single shared crate is a real,
conflict-heavy reconciliation, so it is **deliberately not attempted in this
branch** — a blind merge would be reckless. The drift analysis is the map for
doing it surgically. Until then `apps/desktop` keeps its own `static/` snapshot,
which means the app is shippable from the monorepo immediately while convergence
proceeds.

## Convergence plan (follow-up)

1. Make the monorepo's `crates/ironclaw_webui_v2_static` the single source of
   truth. Most desktop value-adds (work-product export, OCR, native save, zoom)
   are `isDesktopRuntime()`-gated or additive and can land there without changing
   hosted/web behavior.
2. Land desktop-only source files into the shared crate (low conflict).
3. Reconcile the 234 differing files lowest-churn first; i18n last (union the key
   sets, keep the completeness lock).
4. Point `apps/desktop` at the shared crate and delete the vendored copy — then
   there is genuinely one frontend, one repo, one pipeline.

## Building the desktop from here

```bash
cd apps/desktop
npm install
IRONCLAW_REBORN_TARGETS=aarch64-apple-darwin npm run build:reborn-sidecars  # builds reborn from the monorepo root
npm run tauri build
```

See [`README.md`](README.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md) for the
full desktop docs.
