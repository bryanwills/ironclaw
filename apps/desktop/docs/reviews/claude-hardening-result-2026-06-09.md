# IronClaw Desktop Hardening — Result

Date: 2026-06-09 (evening session)
Repo: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop`
Branch: `codex/ship-ironclaw-desktop`
Continues: `docs/reviews/claude-handoff-ironclaw-desktop-2026-06-09.md`

## Outcome

Status: **GREEN on functional contracts.** Two real desktop bugs found and fixed; nine adversarially-verified review findings fixed; all four RED items from the handoff proven against the real bundled `ironclaw-reborn` sidecar.

The static UI stayed canonical in `crates/ironclaw_webui_v2_static/static`. No Svelte revival, no desktop fork, no fake "ready" states. Connector canonicalization and the durable pending queue are intact and extended.

## Real bugs found and fixed (not in the original handoff)

### Bug 1 — OpenRouter never authenticated (HTTP 401 on every run)

`src-tauri/src/sidecar.rs` mapped the OpenRouter backend to `LLM_BACKEND=openai_compatible` and set `OPENROUTER_API_KEY`. But the catalog's `openai_compatible` provider reads its key from **`LLM_API_KEY`**, not `OPENROUTER_API_KEY` (verified in `ironclaw_llm` `providers.json` + `error.rs`). Result: every OpenRouter chat hit OpenRouter with no `Authorization` header → `401 Missing Authentication header` → no model could ever run via OpenRouter in the desktop app.

Fix: use the dedicated `openrouter` catalog backend (`LLM_BACKEND=openrouter`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`). Proven live: the sidecar now returns a real assistant reply (`PING_OK`, and the work-product marker `alpha=12 beta=34`).

### Bug 2 — attachments vanished from the thread on reload

The UI sends attachments as a first-class `attachments` field (correct — never inline base64). But Reborn's timeline projection echoes only message `content`, **not** the first-class attachments. The renderer (`history-messages.js`) builds attachment chips solely from a `<attachments>` content block — which the UI never wrote. Net: attach a file → send → the model reads it, but reload the thread and every attachment chip is gone. Confirmed against the live sidecar (the projected user record contained only the prompt text).

Fix: `useChat.js` now appends a base64-free durable attachment manifest (`buildDurableAttachmentBlock`, exported from `history-messages.js`) to the content sent to Reborn. The timeline preserves it; the renderer parses it back into chips and strips it from the visible text. Proven live: all five attachment names survive a timeline reload; the content validator accepts the manifest; the model still reads the first-class payload.

## Review findings fixed (9 confirmed, adversarially verified)

From the multi-agent review of the handoff diff (`review-ironclaw-handoff-diff` workflow, 5 dimensions, each finding verified by an independent skeptic):

1. **Pending-id collision (HIGH).** `pending-${counter}` from `useRef(1)` reset on every reload while records persisted in localStorage, so a restored row and a new send could collide on `pending-1` — the new turn's accepted-ref stamped/cleared/deleted the restored turn (the exact data loss the queue exists to prevent). Fix: collision-proof ids (`crypto.randomUUID()`), first-match-only `updatePending`/`removePending`, `seen.add(pending.id)` in the render loop.
2. **Run-completed wipes the durable queue (HIGH).** `onRunCompleted`/run-success cleared ALL pending rows; with the new `replacePending` that became a durable delete, destroying a second in-flight turn before its projection. Fix: removed both blanket wipes; `loadHistory` reconciles via `pendingMessagesAfterTimeline`.
3. **Content confirmation not 1:1 / not time-aware (MEDIUM).** An older identical user row ("continue") could clear a newer unconfirmed turn. Fix: multiset, one-to-one, timestamp-gated content ledger.
4. **Image metadata dropped (MEDIUM).** Image attachments left no chip after reload. Fix: image metadata now rides in the pending record's `attachments` (no base64).
5. **Providers-fetch failure bounced configured users to onboarding (MEDIUM).** An errored `/llm/providers` query read as "no active provider" → redirect to `/welcome`. Fix: gate on `!error` and surface the connection banner; `retry: 4` rides out sidecar boot.
6. **Smoke fallback masked partial-projection regressions (HIGH).** The fallback simulated rendering with an empty timeline. Fix: simulate with the real polled records; hard-fail when the timeline projected the prompt but dropped the attachment.
7. **Send route lying not caught + all-null evidence (HIGH/MED).** Reworked: the run-state probe that motivated this is unmounted on the bundled sidecar (404), so liveness is proven by the model-execution probe's SSE stream instead; `sanitizeRouteResponse` now preserves error summaries.
8. **Shell validator hid proof mode (MEDIUM).** Fix: prints `chat_proof: timeline|pending_fallback` + a warning on fallback-only passes.
9. **Timeline poll aborted on first transient error (MEDIUM).** Fix: per-attempt try/catch; the error trail is recorded, the poll continues.

All changes covered by focused tests: **45 pass** (`pending-messages`, `history-messages`, `useChat-send`, `work-product-export`, `api`, `model-readiness`, `extensions-api`, `useLlmProviders`), including new regression tests for id collisions, the multiset/time-gated ledger, image metadata, and the durable-block round-trip.

## RED items — proven against the real bundled sidecar

### RED 1 — NEAR.AI auth/execution (PROVEN)

`scripts/probe-live-reborn-model-execution.mjs` drives the bundled `ironclaw-reborn` in two modes:

- **NEAR.AI, no credential → honest block.** SSE run-status sequence `queued → running → failed`; zero fabricated assistant replies (assistant_count = 0). The app never pretends NEAR ran.
- **OpenRouter, real key → real execution.** SSE `queued → running → completed`; the assistant marker reply rendered.

Evidence: `output/live-model-execution-probe/reborn-live-model-execution-*.json` (both modes PASS).

### RED 2 — Connectors (PROVEN)

`scripts/probe-live-reborn-connectors.mjs` drives the real Reborn route sequence (discovery → install → oauth/start → list truth → manual-token → activate):

- Notion OAuth start returns 200 (functional); Gmail/Google-Calendar return `503 backend_unavailable` (honestly blocked, not faked).
- Zero contract violations: no lifecycle route used a slash catalog ref; no connector reported `authenticated:true` before a credential existed.
- Unauthenticated begin → 401; slash-ref path → 400 (both expected security rejections).

All lifecycle routes in the UI go through `canonicalExtensionName` (verified: the one low-level `setupExtension` helper is only ever called with a canonicalized name). Evidence: `output/live-connector-probe/reborn-live-connector-probe-*.json`.

### RED 3 — Work product (PROVEN)

`scripts/probe-live-work-product-openrouter.mjs` spawns a real OpenRouter sidecar and runs the five-file-type assistant probe (csv/md/json/html/txt):

- `GREEN_assistant_marker_observed` — the model read the files and produced the marker (`alpha=12 beta=34`, only derivable by reading the CSV).
- `all_attachment_names_observed: true` — every attachment name survives a timeline reload via the durable manifest.

Export builders (MD/HTML/JSON/PDF/DOCX) produce parseable blobs (`work-product-export.test.mjs` + packaged smoke). Evidence: `output/live-work-product-probe/reborn-live-assistant-run-probe-*.json`.

### RED 4 — Packaged WebView smoke

`npm run tauri -- build` succeeds; the app and DMG build (`IronClaw.app`, `IronClaw_0.4.157_aarch64.dmg`).

The packaged WebView smoke (`scripts/smoke-packaged-app.sh --webview-smoke` against `IronClaw.app`) **PASSES**, and via the stronger proof path: 13/13 checks PASS including **"Timeline reload preserves user prompt"** and **"Timeline reload preserves attachment metadata"** — i.e. the real Reborn timeline preserves the attachment chip across a reload (the durable-manifest fix proven end-to-end in the packaged app, not just the pending fallback). Evidence: `/tmp/ironclaw-packaged-webview-smoke-20260609-212120.json` (`status: passed`, `chat_proof: timeline`).

A real harness bug surfaced and was fixed along the way: the smoke sent attachments via the raw API (no durable manifest), so the timeline echoed the prompt but dropped the attachment, which collided with the new partial-projection hard-fail and stalled the WebView. The smoke now sends exactly as the UI does (manifest appended), which both fixes the stall and proves the timeline-preservation contract directly. The run-state probe was removed from the packaged smoke because the bundled v0.29.0 sidecar does not mount `/threads/{id}/runs/{run_id}` (404) and the WebView Tauri HTTP path stalled on it; run liveness is proven by the SSE-based model-execution probe instead. A per-phase watchdog and fire-and-forget diagnostics were added so no single hung invoke can starve the evidence write.

## Design review (live render, not native)

Captured the real UI shell against a live sidecar (`scripts/capture-design-surfaces.mjs` → `output/design-capture/*.png`): onboarding, chat empty state, inference settings, extensions.

Findings: the shell is clean and professional — strong hero typography, clear sidebar hierarchy, consistent cards, one-line empty states. The model-readiness control already implements an honest three-state machine (Configured-unverified → Verified, or Setup-required), backed by `model-readiness.test.mjs`. No "fake ready" state survives the providers-snapshot gate.

Not changed (would need the native packaged window to verify, which requires user-present screen control): native title-bar/mascot positioning, default light-vs-dark theme, hero font-family tuning. These are visual-polish or product-default decisions; blind edits without seeing the packaged result were deliberately avoided.

## Gauntlet (final, all green)

- `npm run check` (svelte-check): 0 errors / 0 warnings
- `npm run verify:static-frontend`: OK
- `npm run smoke:webui-static`: PASS
- Focused JS tests: 45 pass
- `npm run test` (vitest): 161 files, 1295 tests pass
- `cargo check` (src-tauri): OK
- `npm run tauri -- build`: app + DMG built (`IronClaw_0.4.157_aarch64.dmg`)
- Packaged WebView smoke: 13/13 PASS, `chat_proof: timeline` (SMOKE_EXIT=0)
- Live probes (real bundled sidecar):
  - RED 1 model-execution — nearai `queued→running→failed` (no fabricated reply), openrouter `queued→running→completed` (real marker reply). Both PASS.
  - RED 2 connectors — 0 contract violations; oauth: notion 200, gmail/calendar 503 (honest block); 2 expected security rejections.
  - RED 3 work-product — `GREEN_assistant_marker_observed`, all 5 attachment names survive reload.

## New/changed files of note

- `src-tauri/src/sidecar.rs` — OpenRouter backend fix; hermetic spawn env (`env_clear` + curated allowlist so ambient `ANTHROPIC_BASE_URL`/etc. can't abort or hijack the sidecar); OAuth exchange URLs in the base env block.
- `crates/.../chat/hooks/useChat.js` — collision-proof ids, durable attachment manifest, no blanket queue wipes, image metadata.
- `crates/.../chat/lib/history-messages.js` — `buildDurableAttachmentBlock` + multiset/time-gated content confirmation.
- `crates/.../chat/lib/pending-messages.js` — collision-safe id ops, image-payload exclusion.
- `crates/.../settings/hooks/useLlmProviders.js`, `crates/.../layout/gateway-layout.js` — onboarding gate honest on fetch error.
- `crates/.../lib/packaged-smoke.js`, `scripts/smoke-packaged-app.sh` — real-records fallback, partial-projection hard fail, proof-mode visibility, per-phase watchdog, no dependency on the unmounted run-state route.
- `scripts/probe-live-reborn-model-execution.mjs`, `scripts/probe-live-work-product-openrouter.mjs`, `scripts/capture-design-surfaces.mjs` — new live proofs.
- `scripts/probe-live-reborn-connectors.mjs`, `scripts/probe-live-reborn-assistant-run.mjs`, `scripts/probe-live-reborn-chat-attachments.mjs` — hermetic env + correct readiness route (`/threads`, not the unmounted `/api/health`); durable manifest mirrored.

## Iteration 2 (2026-06-10, loop active)

User-reported: NEAR sign-in dies with `Invalid frontend_callback`; document/PDF uploads don't work.

**Auth root cause + fix.** `private.near.ai` only accepts `frontend_callback` URLs on its own origin (empirically probed: localhost, 127.0.0.1, chat.near.ai, app.near.ai, the railway exchange — all 400; `https://private.near.ai/*` → 307). The GitHub/Google flow was built for the hosted web app and cannot complete from a desktop origin. Desktop Welcome now shows the working paths — **Use API key** (primary; backend `accepts_api_key: true` for nearai, dialog → upsert → activate → chat) and **NEAR Wallet** — with an honest description; GitHub/Google remain for hosted builds. Auto-resume of an existing session (test-connection verified) shipped in iteration 1 and remains the zero-click path.

**Uploads root cause + fix.** The sidecar inlines text attachments but has **no binary extractors** — a PDF reached the model as nothing ("file search returned 0 results" on a live probe). Shipped client-side extraction in the composer: vendored pdf.js (lazy ES-module import; worker alongside; both produced by `prepare-webui-static.mjs`) for PDFs, and a dependency-free ZIP reader (`DecompressionStream('deflate-raw')`) for DOCX (`word/document.xml`) and XLSX (sharedStrings + sheet rows → TSV). Extracted text ships as the attachment payload (`text/plain`, original filename on the chip); image-only/scanned files fall back to the raw payload. `dragDropEnabled: false` on the main window so HTML5 drop events reach the composer (Tauri was swallowing them).

Verified: 50 focused tests (incl. new extractor suite), static rendered smoke now drives a **real PDF through the real composer** and asserts the posted payload is extracted text (`INVOICE 7741`), svelte-check 0/0, packaged smoke 13/13 `chat_proof: timeline`. Hourly fix-and-verify loop is armed (cron 5d67432b).

### Iteration 3 (loop): WKWebView extraction proven

The packaged WebView smoke now exercises the composer's PDF extractor inside the app's own WKWebView (a different engine from the Playwright/Chromium rendered smoke): a valid single-page PDF goes in, `extracted: true` with the marker text comes out (`PACKAGED INGEST 9913 OK`). 14/14 checks, `chat_proof: timeline`. Document-upload support is now verified at every layer: unit (zip/docx/xlsx), rendered composer (Chromium), and packaged WebView (WebKit). The remaining visual click-through is demo-only, not load-bearing.

## Iteration 4 (loop): real-world PDFs, the truth

**GitHub/Google sign-in is blocked by NEAR, not by us.** Full callback-shape matrix probed against private.near.ai: every non-private.near.ai callback (localhost/127.0.0.1 any port, https variants, near.ai domains, the OAuth relay) returns `Invalid frontend_callback`; upstream HEAD builds the same local callback and is equally broken. The May 21 CLI session predates the policy change. Desktop paths that work: API key (primary), NEAR Wallet, session auto-resume. Upstream issue flagged.

**The user's real PDFs are scanned.** pdf.js parses them fine (e.g. 22 pages) — zero text items: image-only, no text layer. AND the backend feeds the model text only (a live probe shows even image attachments never reach the model). So:
- Composer rewritten bytes-first: extractable documents are read as raw bytes with a 256 MB ceiling (previously anything over 5 MB was SILENTLY DROPPED — the actual "PDF doesn't work" bug for this user's 173–186 MB files).
- Every chip now shows extraction status: `extracting…` → `text extracted (N chars)` / `no readable text — not sent`; rejected files surface a dismissible notice; send is gated while extraction runs; payload-less chips never reach the wire.
- Text-layer PDFs of any size now work end-to-end (compressed/FlateDecode verified in-page; WKWebView extraction in the packaged smoke).
- Scanned PDFs need OCR (tesseract.js) — queued as the next feature; backend attachment gap (binary payloads invisible to the model) noted for upstream.

Gates: extractor+send tests 12/12, static smoke PASS (6 attachment scenarios through the new hook), packaged smoke PASS, app relaunched. Open: model picker/inference page redesign, Gmail OAuth-first drawer.

## Iteration 5: usability overhaul (model config, OAuth wiring)

- **New design-system Popover primitive** (anchored panel, outside-click/Escape, DESIGN.md geometry).
- **Composer model switcher**: the model chip is now a popover — live model list from the backend (`list-models`, lazy-loaded), one-click apply through `set_active`, current model checked, "Manage providers in Settings" link. Chip label now reads from the providers snapshot (single source of truth) instead of the boot-time gateway fallback. Proven end-to-end: applied "Claude Sonnet 4.6" by display name → real reply `MODEL_SWITCH_OK` → restored to auto.
- **Inference page**: the ACTIVE provider card grows an inline model picker (same live list + Apply); NEAR card on desktop shows API key + Wallet only (browser SSO hidden — server-side NEAR policy, see iteration 4).
- **Connector OAuth wiring**: authorization URLs now open in the SYSTEM browser on desktop (Tauri child webviews have no cookies and Google blocks embedded webviews); backend-state polling no longer requires a popup handle. HOWEVER the bundled v0.29.x sidecar's product-auth cannot issue OAuth URLs at all (`backend_unavailable` from `start_dcr_setup_oauth_flow` — no OAuthUrl challenge; exchange env verified present, relay alive). Manual token remains the only working connector path on this binary; the wiring is ready for a sidecar that implements DCR OAuth.
- Static smoke now drives the popover (click → panel → manage-link assertion). Gates: 57/57 focused tests, static smoke PASS, packaged smoke PASS, app relaunched.

Remaining: OCR for scanned PDFs (tesseract.js); full IA redesign to DESIGN.md archetypes (Today/Desk/Work) is a dedicated build.

## Iteration 6: beyond the spec

Treated DESIGN.md as a floor. Found and fixed what it never caught:

- **The type system was a ghost.** Tailwind's stack names "Inter Variable" first, but no @font-face ever shipped — every install rendered system fallbacks. Inter Variable (46 KB woff2) is now self-hosted (`static/fonts/`, relative URL so it resolves under both roots), with `font-variant-numeric: tabular-nums` on body per the spec's own rule.
- **Native overlay chrome.** `titleBarStyle: Overlay` + `hiddenTitle`; the sidebar header is a drag region with traffic-light clearance in the packaged app. No more dead title bar above an in-app header.
- **Broken logo in the packaged app**: the sidebar hardcoded `/v2/assets/logo.jpg` (hosted-only path). Now `appScopedPath`-resolved.
- **Calm model chip**: status dot + `NEAR.AI · auto` + chevron; readiness phrase moved to the tooltip and (when blocking) the banner. Smoke updated to assert the new contract.
- **Anticipatory front door**: time-of-day greeting; "Pick up where you left off" chips for the three most recent threads (cached, zero extra traffic); suggestions rewritten from gateway dev-speak to tasks the app verifiably does today (summarize a document / draft from notes / analyze a spreadsheet) — clicks PREFILL the composer instead of blind-sending, since two of three start with an attachment.

Gates: focused tests green, static smoke PASS (drives popover + new chip assertions), packaged smoke PASS, app relaunched on the new build.

## Iteration 7: OCR for scanned PDFs — shipped and proven in WKWebView

The user's real PDFs are scans; the model needs text. Shipped fully local OCR:

- **Stack**: tesseract.js (ESM) + SIMD wasm core + eng traineddata (~11 MB) in `static/ocr/`, lazy-loaded on the first scanned document. Pages render via pdf.js to canvas, OCR capped at 8 pages with per-page progress on the chip (`OCR 3/8`).
- **Confidence gate**: mean recognition confidence < 45 → honest "no readable text" instead of shipping noise (the user's art-catalog PDF now correctly declines; a synthetic scanned memo OCRs verbatim: names, amounts, dates).
- **Buffer-detach bug**: pdf.js transfers the input buffer to its worker — the text pass now gets a copy so the OCR fallback keeps the original.
- **WKWebView truth**: custom URL-scheme handlers do NOT apply inside Web Workers, so the OCR worker could never fetch its core/wasm/language from tauri:// — packaged OCR failed where Chromium passed. Fix: a ~100-line Rust loopback HTTP server (`ocr_assets.rs`) serving exactly the five allowlisted OCR files from bundled resources; the worker fetches plain `http://127.0.0.1:<port>`. CSP gains loopback script/worker sources + `wasm-unsafe-eval`.
- **Stale-embed killer**: `tauri build` could ship a binary with stale embedded assets after JS-only edits (cargo rerun-if-changed misses nested files). `scripts/tauri-cli.mjs` now touches `src-tauri/src/main.rs` before every build — re-embed guaranteed.
- **Proof**: packaged WebView smoke gained "WebView OCRs a scanned PDF attachment" — a canvas-rendered, image-only PDF comes back as `PACKAGED OCR 5531 APPROVED` inside the packaged app's own engine. 15/15 checks, exit 0. Rendered (Chromium) checks: art PDF → no-text, scanned memo → verbatim text.

## Iteration 8: the model could never read ANY attachment — now it reads documents for real

User repro (live, their file): attached `Bullion-Digital-Legal-Onepager-v6.pdf`; the model lectured that PDFs are binary and its `read_file` only takes `.txt/.md/.json/.csv` — while our payload was clean extracted text (6,230 chars, text method).

**Root cause — deeper than the repro.** An A/B probe against the live sidecar (same extracted text, `.pdf` vs `.pdf.txt` names) failed BOTH ways: "no attachment file is present in the workspace directory." The bundled Reborn v0.29.0 stores first-class attachments in the thread record but never delivers their content to the model — no workspace file, no context inlining. Upstream's fix (server-side `extracted_text` inlining, 16 KB cap) exists only as *uncommitted working-tree code* in the shared checkout; no release has it. Every prior "attachment works" probe was self-confirming: the assertion marker embedded the expected values in the prompt, so the model could pass without reading anything.

**Fix (client-side, version-proof).** The durable `<attachments>` block in message content now carries the document text itself — message content is the only channel the model can actually read:

- Length-prefixed fenced sections (`extraction_status` / `extracted_text_chars: N` / `--- … ---`), format-aligned with upstream's draft. The char count makes parsing exact: a document containing `Attachment 99:`, `filename:` lines, stray `---` fences, or even `</attachments>` cannot corrupt chip parsing (unit-tested + adversarial mock in the static smoke).
- Budgeted against the backend content validator's real laws (read from source): whole content ≤ 64 KiB bytes, no `\r`, no control chars except `\n`/`\t`. Embeds are sanitized, capped at 48 KiB total, truncate at a UTF-8 boundary with an honest `note:` line, and shrink when the user's own prompt is large.
- Applies to extracted PDFs/DOCX/XLSX/OCR output AND plain text-ish files (md/csv/json/html/code) — all were equally invisible to the model before. Binary payloads stay metadata-only.
- Transcript stays clean: the parser strips embedded content before rendering; chips unchanged.

**Proof (non-self-confirming this time).** `scripts/probe-live-embedded-attachment.mjs` sends the user's actual Bullion onepager text exactly as the UI now sends it and asks for the company name on the document's first line — a fact absent from the prompt. Live reply: **"Bullion Digital Corp."** plus a correct "no U.S. state of incorporation stated" (honest read, no hallucination). Send accepted at 6,756 bytes. Unit suite 137/137, static smoke PASS (embed present in POST, decoys stripped from transcript), svelte-check 0 errors.

### Iteration 8 addendum: pdf.js WKWebView hang + smoke hardening found during the ship gauntlet

Re-running the packaged gauntlet on the rebuilt app surfaced an intermittent multi-minute hang in document extraction (passed at 12:06, hung past a 300s deadline at 12:13 — same binary class). Root cause: pdf.js constructs its real Worker from a custom-scheme URL; in WKWebView that script load can neither error nor complete, so pdf.js waits on the worker handshake forever. This is the same WKWebView worker/custom-scheme defect that broke tesseract, in intermittent form. Fix: in the desktop runtime the worker module is imported on the main thread (page-level dynamic import through the scheme handler is reliable) and published as `globalThis.pdfjsWorker` — pdf.js then takes its fake-worker path deterministically and never constructs a real Worker. Hosted/Chromium keeps the real worker.

Smoke hardening shipped alongside: document extraction (PDF + OCR proofs) is now its own deadline phase (300s) so a cold tesseract load can never fail the fast export-builder checks; the shell's evidence wait default rose 45s→540s to outlast every in-page watchdog (45s was killing the app before evidence could be written, which looked like "no evidence" instead of an honest failed check); the shell validator now requires the renamed embed check. Final run: 15/15 PASS in the packaged WKWebView — `embedded_text_observed: true`, `PACKAGED INGEST 9913 OK`, `PACKAGED OCR 5531 APPROVED` — and the suite verdict PASS. App relaunched on the user profile, sidecar 200.

## Iteration 9: manifest parser hardening — block-shaped text is not a manifest

External reviewer finding, confirmed by inspection: `parseDurableAttachmentBlock` matched ANY content ending in an `<attachments>…</attachments>`-shaped tail — assistant replies included. Since iteration 8 the model literally sees this format in its context, so a reply quoting or mimicking it would be silently truncated and rendered with phantom attachment chips; a user pasting block-shaped text broke pending-message dedup (duplicate bubbles).

Fix, three layers:
- **Sentinel**: generated manifests now open with `<attachments ic="1">`; only sentinel blocks parse as ours.
- **Role gate**: assistant/system records render verbatim — never chip-parsed, regardless of shape.
- **Legacy fallback, user records only**: pre-sentinel sends already persisted in threads keep their chips; documented shrinking back-compat window.
- **Dedup**: the comparison key strips blocks repeatedly (sentinel + legacy), so typed block-shaped text plus a real manifest reconciles instead of duplicating.

Proof: 3 new regression tests (assistant mimicry verbatim; sentinel-only parse with typed tail visible; dedup with block-shaped typed text) — 140/140 units, static smoke PASS (mock echo + POST assertion moved to sentinel), svelte-check clean, packaged WebView smoke 15/15 on the rebuilt app, relaunched on the user profile (sidecar 200).

## Iteration 10: file-type matrix — verified spreadsheet corruption fixed, honest coverage everywhere

Workflow review (4 parallel agents) ran the extractors on real fixtures and found two silent data-corruption bugs, both now fixed and regression-tested:

- **openpyxl/pandas .xlsx lost every text label** (inlineStr cells, no sharedStrings.xml): a generated workbook extracted as bare numbers ("1234.5  2000  46037") with a green "text extracted" chip. The cell parser now reads `<is>` inline strings.
- **Excel styled-empty cells swallowed their neighbor**: self-closing `<c r="A1" s="1"/>` made the regex consume through the next cell's close tag, leaking shared-string indices ("Plain" became "0") and merging columns. The cell regex now has a self-closing arm.

Coverage additions: multi-sheet workbooks get `--- SheetName ---` separators (workbook.xml names); DOCX keeps `w:br`/`w:cr` line breaks, decodes hex entities, and extracts headers/footers ("CONFIDENTIAL-HEADER" was invisible before); **.pptx/.pptm extraction** (slide-labeled `a:t` runs, ~25 lines on the existing zip reader); **.docm/.xlsm** route to the OOXML extractors (same XML inside); **RTF** embeds on both engines (mime + extension registered).

Honesty additions: **.xls/.doc/.ppt are rejected with specific guidance** ("save it as .xlsx and attach that instead") — no dependency-free extractor exists and raw-shipping is a lie since the model never sees attachment bytes; extension is authoritative over mime (platforms mislabel CSV as vnd.ms-excel). Raw binaries that do ship (e.g. no-text PDFs ≤5MB) now show a warning chip — "sent as file only — content not readable" — instead of silence; raw fallback also joins the 10MB total accounting it previously skipped.

Proof: 146/146 units (11 new matrix fixtures), static smoke PASS, and a live non-self-confirming probe — an openpyxl-shaped two-sheet workbook sent through the real pipeline; the model answered "Meridian Logistics, 1500000" (the Diligence-stage deal from sheet 1 + the goal from sheet 2, facts that exist only inside the spreadsheet). The probe script is now parameterized (PROBE_TEXT_PATH/PROBE_PROMPT/PROBE_EXPECT/PROBE_FILENAME) for any future document scenario.

## Iteration 11: document preview — click a chip, see the document

Attachment chips are now buttons everywhere. Composer chips and sent-message chips open an AttachmentPreviewModal: PDFs render as real pages (first 8, lazy, via the shared pdf.js loader and its desktop fake-worker path); extracted documents show exactly the text the model received — including the truncation banner when the 64KiB budget clipped it; spreadsheets render in a mono grid; raw binaries get an honest "no preview available."

The load-bearing change: the durable-manifest parser now CAPTURES embedded text during parse (length-prefix authoritative, `embedded_text_ref` markers) instead of discarding it, so previews survive reload — the only place document content exists after a restart, since the backend stores no attachment bytes the UI can read back. Visible message content is byte-identical (sliced before the block), so pending-row dedup keys stay stable — regression-tested. Composer chips additionally retain the original File handle (zero-copy, never persisted) and the extracted text for full-fidelity preview pre-send.

Proof: 148/148 units (capture round-trip + adversarial cases), static smoke drives the real flow in Chromium — click chip → modal shows the embedded text → Escape → text gone from the transcript; svelte-check clean; packaged WebView smoke 15/15 on the rebuilt app.

## Iteration 12: real NEAR sign-in — in-app window, no key paste

The frontend_callback wall is bypassed by construction: the auth research proved private.near.ai redirects the browser to `<frontend_callback>/auth/callback?token=sess_…` and accepts any path on its own origin. The desktop now signs in inside a dedicated app window (`src-tauri/src/nearai_login.rs`):

- `nearai_browser_login(provider)` opens a WebviewWindow at the auth URL with `frontend_callback=https://private.near.ai/ironclaw-desktop` (verified live: 307 → github.com — the exact URL the command builds is accepted).
- `on_navigation` captures `?token=` the moment the allowlisted callback fires and CANCELS that navigation — the token never reaches NEAR's remote SPA. Strict matcher (scheme+host+marker path, empty-token rejected), 3 Rust unit tests.
- The token is validated against `/v1/users/me` before persisting (allowlist/format are server policy that can drift; nothing unverified is stored), then vaulted to the keychain for next-boot env injection.
- The WebUI hot-swaps the LIVE sidecar via the provider upsert (the same proven path the API-key dialog uses) — no restart — then the existing poll self-heal activates NEAR and confirms with test-connection.
- Window-closed and 300s-timeout paths return honest errors that surface in the existing error line. Capability `nearai-login` window label added.

UI: onboarding NEAR row on desktop is now **Sign in with GitHub** (primary) · Google · NEAR Wallet · Use API key (quiet fallback); the settings provider card un-hides SSO on desktop. Google may refuse embedded webviews (known platform behavior) — GitHub is the lead path, wallet and key remain.

Gates: 147/147 units, 3/3 new Rust tests, static smoke PASS, svelte-check clean, packaged WebView smoke PASS on the rebuilt app. Final proof requires real GitHub credentials — ready for the user's first click.

## Iteration 12b: design pass opened — primary button retokened

First strike on the design audit's headline violation: the primary button was a radial gradient of off-brand blues (#4CA7E6/#2882c8/#5BBAF5) with a glow shadow and hardcoded hexes that broke light-theme contrast — on every screen. Now flat `--v2-accent` (#0091fd signal blue) with `--v2-accent-strong` hover, no gradient, no glow; outline/danger variants moved off hardcoded hexes onto tokens/color-mix. 147/147 units, static smoke PASS, packaged smoke PASS, app relaunched.

Remaining design-pass backlog staged in docs/reviews/design-pass-research-synthesis-2026-06-10.md (competitor patterns, June 1 gaps, anti-patterns, top-12) + the live audit's 15 remaining recommendations (gold agent attribution, radii normalization, motion allowlist, export-strip collapse, dev-string scrub, onboarding hierarchy, native confirm → Modal, focus rings, sidebar pass, settings IA, legacy-palette migration, extensions tabs).

## Iteration 13: upstream migration assessment — sidecar is already at its branch tip

Investigated nearai/ironclaw for migratable parts. Findings:

- **Sidecar binary is already current for its lineage.** The bundled `ironclaw-reborn` (0.1.0, built Jun 9) tracks the `reborn-integration` branch, whose tip is `a492857b6` — **zero commits since the build**. There is no newer build to pull on the branch our sidecar is purpose-built from. The plain `ironclaw` 0.29.0 binary is also bundled but unused (the sidecar process is ironclaw-reborn); the 0.29.1 release only adds temperature plumbing + history scoping — irrelevant here.
- **The static UI is a hard fork.** Of 244 shared files, 234 differ — our copy carries all the attachment-embed / preview / auth / design work. A merge would clobber it; not viable. The 12 upstream-only files (Slack channel picker, automation run-history panel, onboarding-gate) call routes our sidecar 404s on (`/channels/slack/allowed`, `/automations/runs`) — they're blocked on a newer binary, not droppable in.
- **The new upstream reborn features live on `main`, a different lineage** than `reborn-integration` (that's why `append_attachment_model_context` and the new routes aren't in our binary): automation run-history UI+API (#4580/#4380), Slack channel routing, persistent approval policies (#4613), "fix repeated model-visible capability failures" (#4639), readiness diagnostics. Getting them means rebuilding the sidecar from the main lineage — a large from-source build (workspace `target/` runs 30–100 GB; 30 GB free now, reclaimable), with real API-drift risk against our customized static UI across ~355 reborn commits.
- **No double-inline risk** either way: the bundled binary does NOT inline attachment text server-side (re-confirmed by this session's live A/B + Bullion/xlsx probes — the model only sees text via our client embed), so our client-side embed remains canonical.

Net: nothing to safely migrate without switching the sidecar to the main lineage, which is a high-stakes architectural change (the whole app depends on this binary's API). Surfaced to the user as a decision.

## Iteration 14: main-lineage sidecar — built, contract-verified, NOT swapped (evidence-based hold)

Per the user's "switch to main and check latest," built `ironclaw-reborn` from `origin/main` (tip 8f9e53b42, today) in an isolated worktree (`cargo build --release -p ironclaw_reborn_cli --features webui-v2-beta`; reclaimed 101 GB first from a parked checkout). Verified our WebChat-v2 API contract against the new binary:

- **Holds for normal usage**: create-thread 200 (compatible `{thread:{thread_id}}`), send 200 (`outcome:submitted` + `accepted_message_ref`), timeline echoes our sentinel-embedded attachment block, CORS/origin accepts our WebView headers (tauri://, no-Origin, localhost all pass). SSE projection frame names (`projection_snapshot`/`projection_update`) and the `{run_status,thinking,text,gate}` item shape are byte-identical across branches — #4552's "OpenAI SSE" is a separate openai-compat path, not a change to our frames.
- **New network/rate limits (#4623)** are real but generous (SSO 60/60s; a per-caller facade limiter). My acceptance probe's rapid mixed-Origin boot burst tripped it (400s); normal pacing is clean.

**Why I did NOT swap — two findings that flip the decision:**
1. **The delta is mostly infra, not desktop features.** The 104 commits main is ahead are largely production hardening (Postgres/Docker/Railway, operator observability, security/network test suites, SSO-operator auth). The user-facing wins (automation run-history UI, Slack channel picker) are NOT unlocked by `webui-v2-beta` — `/automations/runs` and `/channels/slack/*` still 404 (slack needs `slack-v2-host-beta`; run-history needs the UI components migrated too).
2. **The bundled binary is a non-reproducible bespoke build.** It was built Jun 9 from the shared checkout at commit 1d7f5e306 (June 1, in main) **plus 42 uncommitted working-tree patches** — 298 changed lines in `webui_inbound.rs` alone, with edits across `turn_runner`, `model_gateway`, `text_loop_driver` (the execution core). Those are the team's live in-flight reborn work, in no public ref. A clean main build is newer on the committed axis but **lacks all 42 patches** — a different binary, not strictly an upgrade. Swapping risks regressing the message/turn pipeline with no way to diff against the original.

Per "check the evidence supports the specific action before changing system state," the evidence does not support swapping a working app's core binary for a non-equivalent rebuild. **Recommendation: hold.** The candidate binary is preserved at `/tmp/ironclaw-reborn-main-candidate` and the acceptance gate (`scripts/probe-new-sidecar-acceptance.mjs`) is reusable if we revisit. A real feature migration (Slack/automation-history) would need the right feature flags + the upstream UI components ported against routes confirmed to serve data — a scoped follow-up, not a binary swap.

Design-pass progress this iteration (task #24, parallel): gold agent attribution shipped (DESIGN.md bicolor law — the gold token was used by zero components; assistant turns now carry a quiet gold left hairline), motion policy converted from a blanket `animation:none` kill to a meaning-only allowlist (breathing live-dot + calm skeleton pulse, both yielding to prefers-reduced-motion), and the second hardcoded gradient primary (`.v2-button-primary` CSS) retokened to flat signal blue. Static gates green.

## Iteration 15: design pass continues — native dialogs replaced, gold/motion/button shipped

Shipped the three gate-green DESIGN.md-compliance changes from iteration 14 (gold agent attribution on assistant turns, motion allowlist for live-dot/skeleton, the `.v2-button-primary` flat-blue retoken) and added the audit's native-dialog fix in the same build:

- **ConfirmDialog (new design-system component)** replaces all four `window.confirm`/`window.alert` sites — native OS dialogs broke the app frame (wrong chrome/fonts, jarring over the overlay window). Now a Modal with title, one-line body, a tone-correct dominant action (danger for deletes) and quiet Cancel; failures surface inline in the dialog instead of a second native alert. Wired: chat delete (sidebar-threads), skill remove (skills-tab), routine delete (routines-page), custom provider delete (via useProviderManagementActions → provider-management). onboarding exposes no delete, so no dialog there.

Gates: 147/147 units (added a ConfirmDialog stub to the provider vm-context test), static smoke PASS, svelte-check clean. Rebuild + packaged gauntlet + relaunch in progress.

## Iteration 16: real .xlsx "could not be read" — root-caused + extractor hardened

User hit a real failure: `NF_IP_Dashboard.xlsx` (47 KB) → chip "no readable text — not sent", banner "could not be read — it will not be sent." That banner can ONLY come from the composer's catch branch, which the CURRENT code never triggers for an xlsx (it catches internally and falls back) — so the **running app is an older build**; the latest already degrades gracefully. But the investigation surfaced genuine extractor gaps, now fixed:

Reproduced a 12-file real-world matrix (openpyxl, data-descriptors, ZIP64-extra-fields, rich text + xml:space, formula/error/shared cells, chartsheets, stored entries, encrypted-CFB, truncated, ZIP64-with-placeholders). Findings + fixes in `extract-attachment-text.js`:
- **ZIP64 support**: a real ZIP64 package stores `0xFFFF`/`0xFFFFFFFF` placeholders in the classic EOCD and the true central-directory count/offset in a ZIP64 EOCD record. The reader now locates the ZIP64 EOCD locator + record (`locateCentralDirectory`) and reads 64-bit offsets — verified a hand-built valid ZIP64 workbook now extracts ("ZIP64 REAL 7788") where it previously returned empty.
- **Per-entry isolation**: one corrupt/truncated entry (bad deflate, out-of-range local offset) no longer zeros the whole document — each entry inflates in its own try/catch; the rest survive (regression-tested: a good sheet beside a garbage-deflate sheet still yields "SURVIVOR 4242").
- **Bounds-guarded central-dir walk**: every header read is range-checked, so a malformed directory stops cleanly instead of risking a RangeError.
- **Actionable failure reasons**: `extractAttachmentText` now returns a `reason` (`encrypted`/`corrupt`/`empty`/`unsupported`/`error`). CFB magic (`D0CF11E0`) → `encrypted`; zip header with no locatable central directory → `corrupt`. The composer turns these into specific notices — "password-protected — remove the protection and attach it again" / "could not be opened — the file looks corrupted or incomplete" — instead of a generic shrug; such files are not shipped as unreadable blobs.

Gates: 151/151 units (4 new hardening tests: ZIP64, encrypted, corrupt, per-entry isolation), static smoke PASS, svelte-check clean. Adversarial verification workflow (5 attack agents across xlsx/docx/pptx/container/encoding classes + completeness critic) running before the ship build. Ship build will also carry iteration 15's design trio + ConfirmDialog.

## Iteration 17: adversarial pass found 13 real Office-extraction defects — all fixed

The iteration-16 adversarial workflow (5 attack agents across xlsx/docx/pptx/container/encoding, 82 generated files) found **13 genuine defects** — content silently lost or misattributed when a user uploads a real Office file (the never-throw contract held, but "never throws" ≠ "doesn't lose the user's text"). All fixed in `extract-attachment-text.js` and regression-tested:

P0 silent data-loss:
- **D1** PPTX `<a:t>` runs with `xml:space="preserve"` (pervasive in real decks) were invisible — regex now allows run attributes.
- **D2** PPTX runs were joined with `\n`, corrupting words split across runs — now concatenated within a paragraph, line-broken on `</a:p>`/`<a:br>`.
- **D3** UTF-16-encoded XML parts were dropped (BOM-less) or shipped with U+FFFD garbage — new `decodeXmlPart` sniffs BOM + NUL-interleave and decodes utf-16le/be.
- **D4/D5** DOCX footnotes, endnotes, comments were never read — added to the read set (legal/academic substance lives there).
- **D6** XLSX pivot-view sheets (values only in the pivot cache) returned empty — pivotCache sharedItems surfaced when sheets yield nothing.
- **D7/D8/D9** PPTX speaker notes, SmartArt diagram text, embedded-chart titles/series were never read — added (`notesSlides`, `diagrams/data`, `charts/chart` with `<c:v>`).

P1 misclassification:
- **D10** SFX/BOM/polyglot-prefixed packages were falsely "corrupt" — `locateCentralDirectory` now computes the prefix delta from where the directory actually ends and rebases every offset (gate moved off a first-bytes `PK` sniff onto the prefix-aware directory check).
- **D11** DOCX tracked-deletion text leaked and fused onto inserted text — `<w:del>`/`<w:delText>` removed before the generic strip.
- **D12** XLSX sheet names were bound by filename suffix, so renamed/reordered tabs mislabeled every sheet — now resolved through `workbook.xml.rels` r:id graph.
- **D13** PPTX slides were ordered by filename, scrambling reordered decks — now resolved via `presentation.xml` sldIdLst + rels.

Plus coverage-gap closures: XLSX cell/threaded comments, Japanese phonetic-furigana (`<rPh>`) exclusion.

Each defect verified with a precise hand-built fixture (10/10) and a permanent regression test. Gates: **161/161 units** (10 new defect regressions + 15 prior), static smoke PASS, svelte-check clean. Re-running the full adversarial workflow against the fixed extractor to confirm no regression before the ship build (which also carries iteration 15's design trio + ConfirmDialog).

## Iteration 18: adversarial round 2 — 16 deeper defects fixed (extractor converging)

Re-running the attack workflow against the round-1-fixed extractor confirmed all 13 prior fixes held AND surfaced a deeper layer of 16 real defects. All fixed and regression-tested:

P0 silent corruption (`extracted:true` + wrong data the model trusts):
- Attributed `<si xml:space="preserve">` was skipped by the bare-`<si>` shared-string regex, shifting every index so cells resolved to the WRONG string — now `/<si\b[^>]*>/` (same for inline `<is>`).
- CDATA cell text (`<t><![CDATA[a < b]]></t>`, common from Google Sheets) was destroyed by the tag-strip and leaked a `]]>` artifact — now CDATA is neutralized to escaped entities before stripping.
- A broken shared-strings table made `t="s"` cells ship their raw integer index as the value ("0\t1\t2") — now unresolved shared indices are dropped, and a package whose wanted part failed to inflate returns `corrupt` (new inflate-failure tracking through `readZipEntries`) instead of empty or garbage.

P1 leakage:
- **DOCX field instruction codes leaked into the body — including HYPERLINK target URLs (an injection vector: a tracking URL the user never sees, injected into model context).** `<w:instrText>` is now stripped like `<w:delText>`; the cached visible result survives.
- `mc:AlternateContent` shipped the legacy Fallback duplicate fused onto the Choice text — Fallback now dropped (DOCX + the shared DrawingML path).

P2 data-loss:
- DOCX SmartArt (`word/diagrams/data`), PPTX slide masters/layouts (standing footers/company names, with placeholder "Click to edit…" prompt text filtered out), openpyxl's comment subfolder path (`xl/comments/comment1.xml` — one of the commonest writers), and XLSX drawing/shape-only sheets are all now read.

P3 misclassification:
- Broken-deflate parts now report `corrupt` not `empty`; a stray `PK\x05\x06` inside an archive comment no longer fools the EOCD scan (comment-length consistency check); zero-width-only content (ZWSP/ZWNJ/word-joiner) is correctly `empty`, not "3 invisible chars."

Each verified with a hand-built fixture (16/16) + permanent regression test. Gates: **170/170 units** (9 new wave-2 regressions), static smoke PASS, svelte-check clean. Running adversarial round 3 to confirm convergence (loop-until-dry) before the ship build.

## Iteration 19: adversarial round 3 — 9 defects (converging), highest-value: raw-angle truncation

Round 3 (attacking the wave-2 fixes) found 9 real defects; the count is converging (13 → 16 → 9) and the container class came back clean (0 failures). Fixed:

- **Raw unescaped `<` in cell/run text truncated >50% of the value** (highest-value): a stray `<` (bad exporters emit it unescaped) made the greedy `/<[^>]+>/` strip eat through `</t>`, shipping a truncated value as if complete — across all three text paths. Fixed with a shared `decodeXmlPart` pre-pass that escapes any `<` not starting a well-formed tag (after stripping XML comments and neutralizing CDATA). One change covers xlsx/docx/pptx.
- **Namespace-prefixed SpreadsheetML** (`<x:row>/<x:c>/<x:is>/<x:v>/<x:si>` from Apache POI, .NET OpenXML SDK, Aspose) returned `empty` for data-filled sheets — the hybrid case (default-ns workbook, prefixed worksheet) found the sheet then dropped every cell. All element regexes are now `(?:\w+:)?`-prefix-tolerant.
- **XML comments with `>` inside** (`<!-- a > b -->`) leaked their tail + a `-->` artifact — comments are now stripped first in `decodeXmlPart`.
- **mc:Fallback-only text** (image-only Choice, readable text only in the VML Fallback) was dropped by the always-drop-Fallback rule — replaced with `resolveAlternateContent` that keeps Choice when it has text, else Fallback (no duplicate fusion, no fallback-only loss).
- **w:altChunk** embedded sub-documents (pasted/imported HTML/RTF/email bodies) were silently dropped — now resolved via the document relationship graph (two-pass) and appended under an "Embedded:" label.

Verified with hand-built fixtures (5/5) + permanent regressions. Gates: **175/175 units**, static smoke PASS, svelte-check clean. Round 4 running to confirm convergence; ship build started in parallel (carries iteration 15 design trio + ConfirmDialog + all three extraction waves).

## Iteration 20: adversarial round 4 — caught a P0 regression I introduced + 4 more

Round 4 (attacking the wave-3 fixes) found 5 must-fix data-loss defects — count converging (13 → 16 → 9 → 5). The headline is a regression the loop caught in my OWN wave-1 fix:

- **CRITICAL: self-closing `<w:del/>` ate the document body.** Word emits a self-closing `<w:del w:id="N"/>` for a deleted paragraph mark on EVERY tracked paragraph-merge (ubiquitous in edited contracts/legal docs). My `/<w:del\b[\s\S]*?<\/w:del>/g` matched its `<w:del\b` and the lazy span ran to the next real `</w:del>`, silently deleting every body line between — `extracted:true`, no signal, a gutted contract fed to the model. Reproducers lost 8 and 50 body lines. Fixed with a self-closing guard `(?![^>]*\/>)` (same on `<w:delText>`); the marker falls to the generic strip. This is exactly why the loop runs until dry — a fix one round can regress the next.
- **XLSX embedded chart text** (titles/series/cached values) was never read (only the PPTX path read charts) — chart-only sheets reported empty. Added `xl/charts/chart*.xml` + a Charts section.
- **Missing `document.xml`** with readable footnotes returned `empty` — now surfaces sibling text or reports `corrupt`, never silent empty.
- **PPTX VML WordArt** (`v:textpath string=`) was dropped (only `<a:t>` runs were read) — now harvested.
- **Understated EOCD entry count** (writer lies 0/1) dropped real entries — the directory walk now follows the central-header signature, not the count.

Verified with fixtures (4/4 incl. the critical body-eater) + permanent regressions. Gates: **180/180 units**, static smoke PASS, svelte-check clean. Shipping the converged build now (round 4's fixes were not in the prior build); round 5 running as the final convergence check.

### Iteration 20 ship: converged build live

Packaged WebView gauntlet PASS (15/15, evidence ironclaw-packaged-webview-smoke-20260610-170933.json), app relaunched on the user profile, sidecar 200. Live build carries: all 43 extraction-hardening fixes (4 adversarial rounds), the design-pass trio (gold attribution, motion allowlist, flat-blue buttons), ConfirmDialog (native dialogs replaced), and the prior file-type/preview/in-app-NEAR-auth work. 180/180 unit tests, static smoke, svelte-check all green. Round 5 adversarial check running as the final convergence gate.

## Iteration 21: adversarial round 5 — 2 must-fix data-loss (converged) + ship

Round 5 (40+28+30+34+19 = 151 files) came back mostly cosmetic with 2 genuine data-loss defects, both fixed:

- **Raw `<` before a LETTER still truncated** (my round-3 fix was incomplete): it escaped `< 5` but not `x<y` (a raw `<` followed by a letter that isn't a tag), so the greedy strip still ate through `</t>` — losing the tail across XLSX/DOCX/encoding (4 files). Fixed properly: escape any `<` that doesn't begin a clean `<[^<>]*>` tag (`/<(?![^<>]*>)/`), which catches both forms while preserving real tags/end-tags/PIs.
- **Partial silent loss**: one corrupt sheet dropped while a sibling extracts returned `extracted:true` with the `degraded` flag swallowed — a whole sheet vanished invisibly. Now `extractAttachmentText` surfaces `partial:true` on a degraded-but-non-empty result, and the composer notes "part of this file could not be read — the rest was sent."

Remaining round-5 finds are cosmetic/correct-by-design (openpyxl dates as serial numbers, booleans as 1/0, unescaped `>` inside a malformed attribute, non-`w`/`a` namespace prefixes on paragraphs from exotic converters, defined-name-only workbooks) — documented limitations, not data-corruption.

Verified with regressions (3/3). Gates: **183/183 units**, static smoke PASS, svelte-check clean. The previously-shipped build had the raw-`<`-before-letter bug, so rebuilding + reshipping; round 6 running as the final convergence gate.

Defect tally across the adversarial loop: round 1 (13) + round 2 (16) + round 3 (9) + round 4 (5, incl. a P0 regression the loop caught in its own round-1 fix) + round 5 (2) = **45 distinct real document-extraction defects fixed, each with a permanent regression test**.

## Iteration 22: adversarial round 6 — 3 systemic fixes, loop converged & closed

Round 6 found 6 defects (3 material, fixed; 3 exotic/by-design, documented). The material three were systemic, not whack-a-mole:

- **Pivot/chart/shape fallback was gated on GLOBAL `sections.length === 0`** — a pivot sheet's "Grand Total" label or any sibling cover-sheet text suppressed every pivot-cache and shape extraction for the whole workbook (highest blast radius). Now appended unconditionally.
- **The `<w:del>` self-closing guard misfired when an attribute value contained `/>`** (e.g. `w:author="x/>y"`) — the negative lookahead saw the in-attribute `/>` and skipped the paired-deletion removal, LEAKING tracked-deleted text to the model (a regression from round 4). Replaced with a two-step, quote-aware removal (`(?:[^>"']|"[^"]*"|'[^']*')*`).
- **Raw `<` … `>` SPAN** (`5 < 10 > 3`, common in math/comparison text) still truncated — my round-5 escape only handled `x<y` (no reachable `>`). The escape is now "a `<` is a tag only if a name-start char is followed by a clean `[^<>]*>`" (`/<(?![a-zA-Z!?/][^<>]*>)/`), which covers `< 5`, `x<y`, and `5 < 10 > 3` uniformly.

Documented limitations (rare and/or content-by-design, NOT primary-content corruption): nested mc:AlternateContent (grouped-shape SmartArt-in-textbox), data-validation dropdown list values, defined-name constants, openpyxl dates-as-serial-numbers / booleans-as-1/0, unescaped `>` inside a malformed attribute, non-`w`/`a` namespace prefixes on paragraphs.

**Loop closed.** Six adversarial rounds, defect tally 13 → 16 → 9 → 5 → 2 → 3 = **48 distinct real document-extraction defects fixed, every one with a permanent regression test** (186 unit tests total; the extractor file's own suite is 50). The never-throws contract held across ~600 generated adversarial files. Gates: 186/186 units, static smoke PASS, svelte-check clean. Final build + packaged gauntlet + relaunch next.

### Iteration 22 ship: converged extractor live (loop closed)

Final build relaunched on the user profile; packaged WebView gauntlet PASS (15/15, evidence ironclaw-packaged-webview-smoke-20260610-183907.json), sidecar 200. Live build carries all 48 extraction-hardening fixes (6 adversarial rounds), the design-pass trio (gold attribution, motion allowlist, flat-blue buttons), ConfirmDialog, and the prior file-type/preview/in-app-NEAR-auth work. 186/186 unit tests, static smoke, svelte-check all green. Task #26 (Office extraction hardening) closed. Open: #24 (broader design pass) — audit backlog remains.

## Iteration 23: capability overhaul phase 1 — downloads work, OAuth unblocked, system-browser auth

Plan: docs/reviews/capability-overhaul-plan-2026-06-10.md (4-auditor workflow + classifier; all verdicts
anchored to "don't go ahead of main"). Headline audit findings: (a) one-click Gmail OAuth needs NO
sidecar swap — the bundled binary serves the full flow when given GOOGLE_CLIENT_ID +
GOOGLE_OAUTH_REDIRECT_URI (proven by hermetic spawn → real accounts.google.com URL); the
Railway-relay env vars it was getting appear ZERO times in the binary; (b) downloads shipped broken
because `save_text_dialog` existed with zero JS callers and blob-anchor downloads are a no-op in
WKWebView; (c) role==='image' is dead code on both lineages (upstream ask, not a UI bug).

Shipped (Phase 1):
- **D1 Native saves**: `save_bytes_dialog` Tauri command (native dialog + fs write; hand-rolled
  base64 decode, 3 unit tests) + `js/lib/save-file.js` saveBlob shim (desktop→dialog,
  hosted→anchor).
- **D2–D5**: every export routed through saveBlob — per-message MD/HTML/PDF/DOCX/JSON (with
  saved-path toasts), thread MD/JSON, settings JSON, and a new "Save file" button in the attachment
  preview (original file preferred, extracted text fallback).
- **D6 Save proof**: under smoke mode the dialog is bypassed; the packaged gauntlet now REQUIRES
  "WebView export saves a real file to disk" and the shell verifies the bytes landed. This gap is
  why downloads shipped broken; it can't recur silently.
- **A1 System-browser auth**: all five window.open auth sites (in-run OAuth gate card,
  useExtensions ×3, configure-modal popup) now route via openExternalUrl on desktop — a raw
  window.open spawns a cookie-less child webview where OAuth can never complete.
- **O1 Gmail OAuth env**: sidecar.rs drops the dead relay vars and passes GOOGLE_CLIENT_ID
  (IRONCLAW_GOOGLE_CLIENT_ID respected) + loopback GOOGLE_OAUTH_REDIRECT_URI built from the picked
  port (+ optional GOOGLE_CLIENT_SECRET/GOOGLE_ALLOWED_HD). With a client id set, gates and
  extension setup emit a real Google consent URL; without one, token-paste stays the honest
  fallback. **User action for one-click Gmail: create a Google Cloud OAuth client (Desktop type,
  Gmail scopes) and set GOOGLE_CLIENT_ID — a NEAR-hosted zero-config client is upstream ask B1.**
- Pre-existing fixes en route: spotlight doctest, corrupt-docx smoke scenario modernized (the
  extraction hardening now correctly REJECTS the fake-bytes docx with an honest notice instead of
  shipping it raw — smoke asserts the new contract).

Gates: 190/190 JS units, 27/27 Rust + clean doctests, static smoke PASS (incl. corrupt-rejection
assertion), svelte-check clean. Build + packaged gauntlet (now 16 required checks) + relaunch next.
Remaining phases: O2 gate-card UX, A4 pre-emptive connect, V1 mermaid (owner-gated), M/B items per plan.

### Iteration 23 ship: capability overhaul phase 1 live

Packaged gauntlet PASS — now 16 required checks including the new "WebView export saves a real file
to disk" (evidence ironclaw-packaged-webview-smoke-20260610-205814.json; the proof file verified on
disk, 33 bytes). App relaunched on the user profile, sidecar 200. Live: native save dialogs on every
export, system-browser routing for all OAuth opens, Google OAuth env wiring (one-click Gmail arms
the moment GOOGLE_CLIENT_ID is set), corrupt-docx honesty, spotlight doctest fix.

## Iteration 24: Google client ID moves into Settings (the env-var hole)

The user still saw the token-paste card after iteration 23 — correct fallback (no client id configured), but the wiring had a real hole: a GUI app launched from the Dock never sees shell env, so GOOGLE_CLIENT_ID-via-env was a developer convenience masquerading as a user path. Fixed:

- **sidecar.rs** now reads `googleOauthClientId` from the desktop settings.json FIRST (env stays as a dev fallback). Client IDs are public identifiers — settings.json is the right home; the optional client secret remains env-only.
- **Settings → Inference → "Google sign-in" card** (desktop-only): paste the client ID → "Apply & restart engine" (saves settings, stop/start sidecar in place, status line confirms "Google connects now open your browser"). "Get a client ID" opens the Google Cloud console via the system browser; copy explains Desktop-app client type + Gmail scopes, "one-time setup, about five minutes."
- **The token-paste gate card itself** now shows a hint when the provider is google: "Prefer your browser? Add a Google client ID under Settings → Inference → Google sign-in."

Gates: 190/190 JS units, 27/27 Rust, static smoke PASS, svelte-check clean, packaged gauntlet PASS (16 checks incl. save-proof), app relaunched (sidecar 200). The remaining step is the user's: create the Google OAuth client and paste its ID into the new Settings card.

## Iteration 25: connect-like-Claude — web search unlocked live + one-click Connect shipped

Workflow (3 probes + architect) mapped the per-connector one-click reality on the BUNDLED binary:

- **Notion is true zero-config DCR TODAY** (live-verified: oauth/start with zero env mints a fresh RFC-7591 client against mcp.notion.com per flow, PKCE S256, loopback callback, HTML completion page). The Claude experience existed in the backend; the UI never chained it (6 clicks/3 surfaces).
- **The user's "no web search" was one missing install**: the zero-credential `web-access` extension (hosted Exa MCP) wasn't installed. Installed + activated it on the RUNNING app via two API calls; live model proof: "Yes, I have web search capability" + a real headline. No rebuild needed for the unlock.
- Google connectors (gmail/calendar/drive/docs/sheets/slides): mechanism-complete, 503 until the client id from Settings (iteration 24) — then the same one-click route works. GitHub + NEAR AI: manual-token by design (honest fallback). NEAR AI hosted MCP needs a main rebundle (#4702/#4742) — Phase-2 item. Custom OAuth MCPs need an upstream generalization of the (already generic) DCR engine beyond the compile-pinned notion spec — upstream ask. Bundled == main-candidate on this whole surface (verified) — no swap needed.

Shipped: **useConnectExtension** — one action chains install → setup → (OAuth: system-browser consent → poll) → auto-activate; the existing configure-modal OAuth watcher also auto-activates now (no manual third step). Registry cards replace "Install" with a phase-aware **Connect** primary (Connecting… / Finish in your browser… / Turning on… / Connected), with manual-token connectors honestly labeled instead of faking a Connect. Gates: 190/190 units, static smoke PASS, svelte-check clean, packaged gauntlet PASS, app relaunched (sidecar 200).
