# Codex Workplan Pre-Push Review — 2026-06-11

Branch: `codex/ship-ironclaw-desktop`

## Scope

This pass reviewed `docs/CODEX-WORKPLAN.md` and pushed the safest first tranche from the
critical path before publication:

- SEC-1 / DEBT-6 / SEC-5: keep the native security guard alive in the shipped static UI test
  harness and remove the insecure `img-src http://*` wildcard.
- APPR-3: carry legacy approval action kinds into the static UI risk classifier.
- Publication hygiene: keep generated PDF xref bytes valid without emitting literal trailing
  whitespace in source or generated static bundles.
- Thermonuclear structural cleanup: decompose the 1k+ line attachment extractor introduced in
  the current branch before pushing.
- NEAR.AI/Reborn review: verify the branch keeps NEAR.AI as the default local sidecar path,
  preserves configured/unverified execution truth, and guards canonical connector lifecycle
  routing for slash-prefixed catalog refs.

## Thermonuclear Review Result

Finding: `extract-attachment-text.js` had grown to 1,163 production lines and mixed five
responsibilities: attachment policy, PDF loading, OCR worker setup, ZIP parsing, and OOXML
document extraction. That violated the "do not normalize 1k+ blobs" review bar.

Fix:

- `extract-attachment-text.js` is now the attachment policy and format orchestration layer.
- `pdf-text-extract.js` owns pdf.js and Tesseract/OCR asset loading.
- `ooxml-zip.js` owns ZIP central-directory parsing, capped inflation, and XML decoding.

Post-split production line counts:

- `extract-attachment-text.js`: 678
- `ooxml-zip.js`: 321
- `pdf-text-extract.js`: 175

## Publication Hygiene Result

Finding: the PDF export builders need the PDF xref line ending `space + newline`, but literal
source strings for that byte sequence caused `git diff --check` to fail after static bundle
generation.

Fix:

- Browser work-product PDF export appends xref line endings as raw bytes (`Uint8Array([32, 10])`)
  instead of string literals.
- Packaged smoke PDF fixtures use the same byte-safe path where they write binary chunks.
- `git diff --check` is clean after regenerating `main.bundle.js`.

## Additional Thermonuclear Pass — 2026-06-11 (Current)

Follow-up review on the final push tranche (`DEBT-1`/`DEBT-2` and related helpers):

- Structural check:
  - Refactored failure-message merge into `message-upsert.js` (single responsibility).
  - Split export payload construction into `thread-export.js` (single responsibility).
  - Message rendering no longer depends on DOM scraping for export.
- Maintainability signal:
  - No file in this tranche crosses the 1k-line threshold.
  - No new ad-hoc conditionals in shared routing/state files; behavior moved into pure helpers.
- NEAR.AI/reborn routing truth:
  - Canonical lifecycle guard remains in `lifecycle extension calls use canonical bare names in route paths`.
  - Tests continue to assert slash-prefixed refs remain catalog refs.
- Risk introduced: none blocking.

## NEAR.AI / Reborn Review Result

Confirmed in code and tests:

- `src-tauri/src/lib.rs` defaults sidecar boot to `BackendConfig::Nearai` when no provider is
  explicitly configured.
- BYO providers are constrained to the explicitly wired providers (`nearai`, `openai`,
  `anthropic`) instead of silently falling through to unrelated catalog providers.
- `gatewayStatus` static tests preserve the product truth: NEAR.AI can be configured/sendable
  while execution remains unverified until a live run succeeds.
- Extension lifecycle routes use canonical bare extension names; slash-prefixed ids such as
  `tools/gmail`, `tools/google_calendar`, `mcp-servers/notion`, and `channels/slack` remain
  catalog refs only.

Still not claimed:

- Real hosted connector login success without live credentials.
- Signed/notarized release artifacts without Apple and updater signing secrets.
- Completion of the full multi-phase workplan. This push lands the first safety/structure
  tranche plus the current ahead commit.

## Verification Evidence

Final post-change commands:

- `npm run verify:static-frontend` — pass.
- `npm run test:static` — 206/206 pass.
- `npm run smoke:webui-static` — pass.
- `npm run check` — 0 errors, 0 warnings.
- `npm run test` — 161 files / 1294 tests pass.
- `cargo check` in `src-tauri` — pass.
- `npm run tauri -- build` — pass; produced `IronClaw.app` and `IronClaw_0.4.158_aarch64.dmg`.
- `npm run smoke:packaged` — pass; app stayed alive, Reborn gateway healthy on port 3000,
  sidecar terminated cleanly; log `/tmp/ironclaw-packaged-smoke-20260611-110348.log`.
- `git diff --check` — pass.

Local release-build caveat:

- `TAURI_SIGNING_PRIVATE_KEY` is not set on this machine, so the local build intentionally
  skipped updater signing artifacts. This does not invalidate the app/DMG package smoke, but
  release signing remains dependent on CI secrets.
