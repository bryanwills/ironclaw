# IronClaw Desktop ↔ monorepo `ironclaw_webui_v2_static` — drift analysis

**Date:** 2026-06-16. **Baseline:** `nearai/ironclaw` main (webui crate) vs the
desktop app's vendored `crates/ironclaw_webui_v2_static/static`.

## TL;DR

The desktop app was scaffolded as a **separate repo** (no shared git history
with the monorepo). It vendors only the **`static/` frontend assets** of
`ironclaw_webui_v2_static` (not the crate's Rust `src/`, `build.rs`, or
`Cargo.toml`) and bundles a `src-tauri/` shell around them. Both the desktop's
copy and the monorepo's crate have evolved **independently and heavily** since
the fork point — this is a 3-way divergence, not a clean additive delta.

**Drift in `static/` (excluding generated `main.bundle.js` / `tailwind.generated.css`):**

| | count |
|---|---|
| files only in desktop | **91** (30 source + 61 tests) |
| files only in monorepo main | **31** |
| files present in both but differing | **234** |

The largest per-file churn: every `i18n/*.js` pack (~1,500 lines of difference
each — the desktop carries its own ~800-key set), `pages/chat/components/chat-input.js`
(~1,000), `message-bubble.js` (~890), `lib/api.js` (~840), `pages/chat/hooks/useChat.js`,
`pages/onboarding/onboarding-page.js`, `pages/extensions/components/*`.

**Conclusion:** merging the two frontends into one shared crate is a real,
conflict-heavy reconciliation — it must be done surgically, not by a blind
copy/merge. This branch therefore brings the desktop in **additively** (under
`apps/desktop/`, touching no existing monorepo file) so the app ships from one
repo/pipeline now, and this document is the map for converging the frontend onto
the shared crate as a follow-up.

## Desktop-only source (the product surface the monorepo crate lacks)

Work product & files: `pages/work/*`, `pages/chat/lib/work-product-export.js`,
`work-product-save.js`, `generated-file-artifacts.js`, `thread-export.js`,
`lib/save-file.js` (native WKWebView save), `pages/chat/lib/pdf-text-extract.js`,
`ooxml-zip.js`, `extract-attachment-text.js`, `ocr/` (offline OCR assets),
`vendor/`, `fonts/`.

Desktop UX/runtime: `lib/zoom.js`, `lib/app-path.js`, `lib/packaged-smoke.js`,
`lib/redact.js`, `lib/approval-enforcement.js`, `lib/model-readiness.js`,
`design-system/confirm-dialog.js`, `design-system/popover.js`,
`pages/chat/components/attachment-preview.js`, `thread-find-bar.js`,
`hooks/useComposerAttachments.js`, `useThreadFind.js`, `lib/thread-cache.js`,
`lib/frontdoor-data.js`, `lib/message-upsert.js`,
`pages/settings/components/google-oauth-card.js`, `settings-not-writable.js`,
`pages/extensions/lib/custom-mcp.js`. Plus 61 `.test.mjs` / `.contract.test.mjs`
specs and the `i18n-completeness` lock.

(The download-chip surface from nearai/ironclaw#4933 — `project-file-chips.js`,
`project-file-paths.js` — is already ported into the desktop frontend; the
desktop uses `save-file.js` rather than the monorepo's `lib/download.js`.)

## Monorepo-only source (main has these; desktop is behind)

`components/slack-channel-picker.js`, `lib/download.js` (#4933),
`lib/auth-scope.js`, `lib/onboarding-gate.js`, `lib/pin-store.js`,
`lib/slack-channels-api.js`, `pages/automations/components/automation-*`,
`pages/automations/hooks/useOutboundDeliveryDefaults.js`,
`pages/chat/components/{avatar,code-block}.js`, `pages/chat/lib/draft-store.js`,
`pages/extensions/components/extensions-tabs.js`, `pages/projects/components/project-widgets.js`,
`pages/settings/components/settings-toolbar.js`, `pages/settings/lib/api-result.js`,
`pages/logs/lib/*`, plus their tests.

## Recommended convergence path (the surgical follow-up)

1. Treat the monorepo's `crates/ironclaw_webui_v2_static` as the **single source
   of truth**. The desktop's value-adds are almost all `isDesktopRuntime()`-gated
   or additive (work-product export, OCR, native save, zoom), so they can land in
   the shared crate **without changing hosted/web behavior**.
2. Land desktop-only **source** files into the shared crate first (low conflict —
   they're new files).
3. Reconcile the **234 differing files** file-group by file-group, starting with
   the lowest-churn (design-system, hooks) and ending with i18n (mechanical: union
   the key sets, keep the completeness lock).
4. Once the shared crate carries the union, point `apps/desktop` at it and delete
   the vendored `static/` copy — then there is genuinely one frontend, one repo,
   one pipeline.

Until step 4, `apps/desktop` keeps its own `static/` snapshot (this branch), so
the desktop is shippable from the monorepo immediately while convergence proceeds.
