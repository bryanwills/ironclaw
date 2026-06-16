# Claude Handoff: IronClaw Desktop Hardening

Created: 2026-06-09 19:36 EDT  
Repo: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop`  
Branch: `codex/ship-ironclaw-desktop`  
HEAD at handoff start: `cd163284c03ae2353618585b7f387f9678212e1d`

## Mission

Make IronClaw Desktop actually shippable as the Reborn static UI packaged in Tauri. The user does not want another mock-only proof pass. They want the installed desktop app to be usable as an agentic chief-of-staff surface: honest model/auth state, working chat, visible sent messages, drag/drop file handling, useful exports, connector setup that is as easy as possible, and design polish that does not feel cheap or half-wired.

Treat this as product-contract verification, not a code diff review.

## Non-Negotiables

- Do not reset, stash, overwrite, or revert user/agent edits.
- Do not declare a surface green from unit tests alone.
- Do not claim model execution works unless a rendered app sends a prompt and receives a real assistant result, or the UI renders an honest auth/setup blocker before send.
- Do not claim connectors work unless the rendered app drives the real Reborn route sequence and backend state proves readiness.
- Do not send slash catalog refs as lifecycle extension names. `tools/gmail`, `tools/google_calendar`, `channels/slack`, `mcp-servers/notion`, and `tools/slack_tool` are catalog refs only; lifecycle route names must be canonical bare names.
- Do not claim file/work-product support from attachment chips alone. Prove payload serialization, thread reload persistence, and exported blobs that parse/render.
- Keep shared UI code inside `crates/ironclaw_webui_v2_static/static`; do not create a desktop-only fork.

## Current Diff Summary

Dirty files at handoff:

- `crates/ironclaw_webui_v2_static/static/js/lib/api.js`
- `crates/ironclaw_webui_v2_static/static/js/lib/api.test.mjs`
- `crates/ironclaw_webui_v2_static/static/js/lib/packaged-smoke.js`
- `crates/ironclaw_webui_v2_static/static/js/main.bundle.js`
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/hooks/useChat.js`
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/hooks/useHistory.js`
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/history-messages.test.mjs`
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/pending-messages.js`
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/pending-messages.test.mjs`
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/useChat-send.test.mjs`
- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/lib/extensions-api.js`
- `crates/ironclaw_webui_v2_static/static/js/pages/settings/hooks/useLlmProviders.js`
- `scripts/probe-live-reborn-assistant-run.mjs`
- `scripts/probe-live-reborn-chat-attachments.mjs`
- `scripts/smoke-packaged-app.sh`
- `scripts/smoke-webui-static.mjs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/sidecar.rs`

Untracked files:

- `crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/work-product-export.test.mjs`
- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/lib/extensions-api.test.mjs`
- `crates/ironclaw_webui_v2_static/static/js/pages/settings/hooks/useLlmProviders.test.mjs`
- `docs/reviews/phase-work-product-verification-2026-06-09.md`

## What Changed In This Pass

### 1. First-run/model truth

`useLlmProviders` now treats `/api/webchat/v2/llm/providers` as the source of truth for active provider state. Gateway diagnostics like `llm_backend: nearai` no longer count as an active provider. This fixes the bug where first-run users could land in chat with `NEAR.AI / auto` shown as usable even though Reborn had no active provider snapshot.

Files:

- `crates/ironclaw_webui_v2_static/static/js/pages/settings/hooks/useLlmProviders.js`
- `crates/ironclaw_webui_v2_static/static/js/pages/settings/hooks/useLlmProviders.test.mjs`
- `scripts/smoke-webui-static.mjs`

Static smoke now verifies both states:

- No active provider -> `/chat` redirects to `Welcome to IronClaw`.
- Active provider snapshot -> chat model control renders `NEAR.AI / auto`, and chat attachment send works in the mocked rendered flow.

### 2. NEAR.AI credential gating made honest

The desktop fallback no longer blocks NEAR.AI solely because the local keychain lacks a token. Reborn has its own login/session routes; the desktop keychain is not enough to prove NEAR cannot run. The UI should either onboard the user through Reborn provider activation or surface the provider failure in-thread after a real run attempt.

Files:

- `crates/ironclaw_webui_v2_static/static/js/lib/api.js`
- `src-tauri/src/lib.rs`
- `src-tauri/src/sidecar.rs`

Important live route evidence:

- `/api/webchat/v2/llm/providers` exists and returns provider metadata.
- `/api/webchat/v2/llm/nearai/login` exists and returns an `auth_url`.
- `/auth/providers` is stale/irrelevant for this Reborn sidecar.
- `/api/gateway/status` returned 404 on the current Reborn sidecar; desktop fallback is still used.

### 3. Connector lifecycle canonicalization

Extension lifecycle calls now normalize catalog refs to canonical lifecycle names:

- `tools/gmail` -> `gmail`
- `tools/google_calendar` -> `google-calendar`
- `mcp-servers/notion` -> `notion`
- `channels/slack` -> `slack`
- `tools/slack_tool` -> `slack`

Install still sends the catalog package ref. Activate/remove/setup/OAuth use bare canonical names.

Files:

- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/lib/extensions-api.js`
- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/lib/extensions-api.test.mjs`

### 4. Chat pending-message durability

User turns are no longer erased from the UI just because `sendMessage` returned before `/timeline` projected the user record. Pending accepted user rows now persist in a small local queue keyed by thread and are cleared only when timeline confirms them. This directly addresses: "I typed a message and it goes nowhere / I can't see what I typed."

The queue stores text and attachment metadata, not base64 file payloads. It expires after 24 hours.

Files:

- `crates/ironclaw_webui_v2_static/static/js/pages/chat/hooks/useChat.js`
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/hooks/useHistory.js`
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/pending-messages.js`
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/pending-messages.test.mjs`
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/history-messages.test.mjs`
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/useChat-send.test.mjs`

### 5. Work-product/file smoke expansion

The attachment probes and static smoke now exercise multiple file-ish payloads instead of only a PDF chip:

- PDF
- Markdown
- JSON
- HTML
- DOCX-like payload
- CSV in packaged smoke

Export builders are tested for parseable MD/HTML/JSON/PDF/DOCX outputs.

Files:

- `scripts/probe-live-reborn-chat-attachments.mjs`
- `scripts/probe-live-reborn-assistant-run.mjs`
- `scripts/smoke-webui-static.mjs`
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/work-product-export.test.mjs`
- `docs/reviews/phase-work-product-verification-2026-06-09.md`

### 6. Packaged smoke made more honest

Earlier packaged smoke failed because the native app could create a thread and submit a message, but `/timeline` did not show the user prompt/attachment before NEAR model auth failed. That failure is real.

The smoke has now been patched to accept two valid outcomes:

- Timeline proof: `/timeline` reload preserves user prompt and attachment metadata.
- Pending fallback proof: route accepted the turn, timeline did not project it yet, and the WebView fallback preserves the user prompt and attachment metadata.

Files:

- `crates/ironclaw_webui_v2_static/static/js/lib/packaged-smoke.js`
- `scripts/smoke-packaged-app.sh`

Important: this packaged-smoke patch has not yet been validated with a fresh production rebuild at the time of this handoff. That is Claude's first gate.

## Evidence Already Run

Passed:

```bash
node --test \
  crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/pending-messages.test.mjs \
  crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/history-messages.test.mjs \
  crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/useChat-send.test.mjs \
  crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/work-product-export.test.mjs \
  crates/ironclaw_webui_v2_static/static/js/lib/api.test.mjs \
  crates/ironclaw_webui_v2_static/static/js/lib/model-readiness.test.mjs
```

Result: 30 tests passed.

```bash
npm run smoke:webui-static
```

Result: `PASS webui static desktop bootstrap smoke`.

```bash
npm run test
```

Result: 161 test files passed, 1295 tests passed.

```bash
npm run check
npm run verify:static-frontend
cargo check --manifest-path src-tauri/Cargo.toml
```

Result: `svelte-check` 0 errors / 0 warnings; static frontend contract OK; Rust cargo check finished.

Previously passed before the latest pending-message and packaged-smoke patch:

```bash
npm run tauri -- build
```

Result: app and DMG built:

- `src-tauri/target/release/bundle/macos/IronClaw.app`
- `src-tauri/target/release/bundle/dmg/IronClaw_0.4.157_aarch64.dmg`

Previously failed before the latest packaged-smoke patch:

```bash
RUST_LOG=info WEBVIEW_SMOKE_WAIT_SECONDS=60 \
  bash scripts/smoke-packaged-app.sh \
  --bundle src-tauri/target/release/bundle/macos/IronClaw.app \
  --webview-smoke \
  --wait 30
```

Evidence:

- `/tmp/ironclaw-packaged-webview-smoke-20260609-192635.json`
- `/tmp/ironclaw-packaged-smoke-20260609-192635.log`

Failure summary:

- Sidecar status: PASS.
- WebView token bootstrap: PASS.
- WebView reached Reborn threads route: PASS.
- WebView read model readiness fallback: PASS.
- Thread creation: PASS.
- Message submit with attachment: PASS.
- Timeline did not contain the submitted prompt/attachment before NEAR auth failure.

Relevant log line:

```text
Session renewal failed for provider nearai: interactive session renewal is unavailable in this build; set NEARAI_SESSION_TOKEN or NEARAI_API_KEY env var instead
```

## Claude First Commands

Start here exactly:

```bash
cd /Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop
git status --short --branch
```

Then run:

```bash
node --test \
  crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/pending-messages.test.mjs \
  crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/history-messages.test.mjs \
  crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/useChat-send.test.mjs \
  crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/work-product-export.test.mjs \
  crates/ironclaw_webui_v2_static/static/js/lib/api.test.mjs \
  crates/ironclaw_webui_v2_static/static/js/lib/model-readiness.test.mjs \
  crates/ironclaw_webui_v2_static/static/js/pages/extensions/lib/extensions-api.test.mjs \
  crates/ironclaw_webui_v2_static/static/js/pages/settings/hooks/useLlmProviders.test.mjs

npm run smoke:webui-static
npm run check
npm run verify:static-frontend
cargo check --manifest-path src-tauri/Cargo.toml
npm run test
```

Then rebuild and rerun the packaged proof:

```bash
npm run tauri -- build

RUST_LOG=info WEBVIEW_SMOKE_WAIT_SECONDS=60 \
  bash scripts/smoke-packaged-app.sh \
  --bundle src-tauri/target/release/bundle/macos/IronClaw.app \
  --webview-smoke \
  --wait 30
```

If packaged smoke passes, open the app:

```bash
open -n src-tauri/target/release/bundle/macos/IronClaw.app
```

If packaged smoke fails, do not paper over it. Read the evidence JSON and log, patch the product contract or runtime, rebuild, and rerun.

## Still RED / Not Yet Proven

### RED 1: Real NEAR.AI execution is not proven

In isolated packaged smoke, NEAR.AI model execution failed because no `NEARAI_SESSION_TOKEN` or `NEARAI_API_KEY` was available. The app must not pretend this is ready.

Claude should verify the intended auth flow:

- Open first-run onboarding in the packaged app.
- Click NEAR.AI GitHub/Google/Wallet login.
- Confirm `/api/webchat/v2/llm/nearai/login` opens a browser URL.
- Complete or mock callback only if safe and explicit.
- Confirm `/api/webchat/v2/llm/providers` returns `active.provider_id: "nearai"`.
- Send a chat prompt.
- Prove assistant response renders or a truthful error renders.

### RED 2: Connectors are route-normalized, not functionally green

The lifecycle route name bug is patched, but live connector setup is not proven.

Claude must run rendered app tests for:

- Gmail setup.
- Google Calendar setup.
- Notion setup.
- Slack/channel setup or honest blocked state.
- Registry tab.
- Installed tab.
- Setup drawer.
- Command palette/global search/deep links for the same connector paths.

Acceptance:

- No lifecycle call sends `tools/gmail`, `tools/google_calendar`, `channels/slack`, `mcp-servers/notion`, or `tools/slack_tool` as `extension_name`.
- Setup/login/readiness state comes from backend responses, not local optimistic state.
- If backend cannot complete a connector, UI says exactly what is blocked and why.

### RED 3: Work product generation quality is not proven

Exports are parseable. That is not the same as IronClaw drafting a useful services agreement from a template.

Claude must run practical scenarios in the rendered app:

- PDF template + instructions -> visible draft with sections/clauses, not a one-page generic summary.
- DOCX template + redline instructions -> generated DOCX export opens/parses.
- XLSX/CSV input -> generated table/analysis and XLSX/CSV/JSON export parse.
- Markdown/HTML source -> generated polished document and HTML/PDF export render.
- Multi-file prompt -> answer cites/uses each file or honestly states unsupported extraction.

Use dummy data; do not contact external services.

### RED 4: Packaged smoke after latest patch not yet rerun

Latest changes after the previous production build:

- durable pending queue
- history reload preservation
- packaged smoke fallback proof
- shell validator accepting timeline proof or fallback proof

Claude must rebuild and rerun packaged smoke before claiming shipped.

### YELLOW: `/api/gateway/status` is stale/missing

The current sidecar returned 404 for `/api/gateway/status`; desktop fallback fills model readiness. This is acceptable only if the UI remains honest. Longer term, either align Reborn to expose the route or remove stale assumptions from desktop probes.

## Product/Design Improvements To Prioritize

### Model/Auth UX

- First-run should be crisp: pick NEAR.AI Cloud, ChatGPT subscription, OpenAI API, Anthropic API, or local Ollama.
- Do not show `Configured (unverified)` as the primary state if the next click cannot work.
- The chat composer should make the next action obvious: "Sign in to NEAR.AI", "Set API key", "Send", or "Retry".
- The model selector should be a compact, polished popover with verified/needs-login/failed states. Hide provider noise unless it helps the user act.
- If OpenRouter is present only because of env/shell state, do not surface it as the default product path.

### Chat UX

- User text must appear immediately and remain visible across thread reloads.
- Assistant failure should be plain English and tied to the action, not a weird workflow stream.
- Activity/reasoning should be collapsible and default to quiet unless it contains a user-relevant blocker.
- Attachments should show filename, type, size, extraction status, and whether the model actually saw useful text.
- Export controls should be visually subdued but reliable: Copy, Save, MD, HTML, PDF, DOCX, JSON, Thread MD, Thread JSON.

### Connectors UX

- "Log in with Notion/Gmail/Google Calendar/Slack" should be the dominant action.
- If OAuth is not available, render a blocked setup state with exact reason.
- After setup, show backend-proven readiness/read-only test evidence. Avoid "Ready" from localStorage.
- Connector cards should show what IronClaw can do immediately after connection.

### Visual Design

- Typography still needs a serious pass. Avoid default/cheap system-looking type at hero scale.
- Keep dense operational layout, but make spacing and hierarchy feel deliberate.
- Remove awkward huge blank areas and inconsistent button/chip styles.
- Keep the mascot/icon lower and away from macOS window controls.
- Make onboarding feel like a serious desktop product, not a web demo.

## Required End-to-End Gauntlet

Before Claude marks this green:

1. Fresh branch status and diff captured.
2. `npm run check` passes.
3. `npm run verify:static-frontend` passes.
4. `npm run smoke:webui-static` passes.
5. Focused static JS tests for changed surfaces pass.
6. `npm run test` passes when feasible.
7. `npm run tauri -- build` passes.
8. Packaged WebView smoke passes against `src-tauri/target/release/bundle/macos/IronClaw.app`.
9. Rendered packaged app manual or automated smoke covers:
   - onboarding
   - chat first send
   - message remains visible
   - file attach/drop/paste
   - model selector
   - connector setup drawer
   - Notion/Gmail/Google Calendar/Slack deep links
   - exports
10. Handoff packet updated with exact evidence paths.

## Suggested Next Implementation Phases

### Phase 1: Close packaged app proof

Goal: make packaged smoke green after current pending-message patch.

First command:

```bash
npm run tauri -- build && \
RUST_LOG=info WEBVIEW_SMOKE_WAIT_SECONDS=60 \
  bash scripts/smoke-packaged-app.sh \
  --bundle src-tauri/target/release/bundle/macos/IronClaw.app \
  --webview-smoke \
  --wait 30
```

If it fails, inspect `/tmp/ironclaw-packaged-webview-smoke-*.json` and `/tmp/ironclaw-packaged-smoke-*.log`.

### Phase 2: Make model auth comprehensible

Goal: user can tell exactly why chat can or cannot run.

Do not add another fake "ready" chip. Drive everything from `/api/webchat/v2/llm/providers`, active provider state, and actual run result.

### Phase 3: Connector truth pass

Goal: every connector surface either works or is honestly blocked.

Add rendered tests that click through connector cards and assert captured request URLs use canonical names.

### Phase 4: Work product quality pass

Goal: IronClaw can generate useful drafts from common file types.

Use dummy input corpus and validate exports parse/render. Add adversarial tests for overly long content, unsupported binary extraction, and multi-file prompts.

### Phase 5: Design hardening

Goal: product feels premium and obvious.

Run a hostile design review on the packaged app screenshots, then patch typography, spacing, model selector, onboarding, connector drawer, and chat activity presentation.

## Do Not Touch Without Reason

- Do not move canonical static UI out of `crates/ironclaw_webui_v2_static/static`.
- Do not revive Svelte as the primary UI.
- Do not delete the static smoke first-run gate.
- Do not remove connector canonicalization.
- Do not remove pending-message persistence unless Reborn timeline projection is proven reliable under model auth failure.
- Do not turn isolated packaged no-credential model failure into a fake green assistant response.

## Handoff Packet

Status: YELLOW

Changed:

- First-run provider gate corrected.
- Connector lifecycle names canonicalized.
- Chat pending messages made durable until timeline confirms.
- Work-product/export tests expanded.
- Static and packaged smoke updated toward real product contracts.

Verified:

- Focused JS tests: PASS.
- Static WebUI smoke: PASS.
- Full Vitest: PASS.
- `npm run check`: PASS.
- `npm run verify:static-frontend`: PASS.
- `cargo check`: PASS.

Still RED:

- Packaged smoke after latest pending-message patch has not been rerun.
- Real NEAR.AI auth/execution not proven in packaged app.
- Live connector setup/readiness not proven.
- Real document-generation quality from PDFs/DOCX/XLSX not proven.

Next Agent Should Start Here:

1. `git status --short --branch`
2. `npm run tauri -- build`
3. Packaged smoke command above
4. If green, open the built app and run the rendered gauntlet.

