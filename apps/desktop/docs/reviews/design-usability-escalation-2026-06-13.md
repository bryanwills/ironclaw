# IronClaw Desktop Design + Usability Escalation

Date: 2026-06-13
Branch under review: `codex/design-system-usability-push`
Design system source: `/Users/abhishekvaidyanathan/Downloads/IronClaw Desktop Design System.zip`

## User Promises Verified

- IronClaw Desktop should feel like a serious agentic chief-of-staff product, not a generic chat wrapper.
- Normal users should see NEAR AI Cloud as the model path; ChatGPT, OpenRouter, Anthropic, Claude, and Codex-specific setup should not leak into the default product surface.
- Chat should start from a prepared desk: visible readiness, document/file affordances, and useful work prompts.
- Connectors should be easy but honest: Gmail, Google Calendar, Slack, Notion, and workspace flows may not pretend to be connected when OAuth/setup is unavailable.
- Generated work product and attachments should remain first-class product commitments, not hidden JSON.
- Rendered UI evidence is required before declaring product progress.

## Evidence

- Fresh rendered capture: `CAPTURE_MODE=chat CAPTURE_READY=1 node scripts/capture-readme-shots.mjs`
  - `output/readme-shots/contact-sheet.png`
  - `output/readme-shots/chat.png`
  - `output/readme-shots/extensions.png`
  - `output/readme-shots/extensions-registry.png`
  - `output/readme-shots/settings-inference.png`
  - `output/readme-shots/onboarding-welcome.png`
  - Console errors: none.
- In-app browser sanity: `http://127.0.0.1:1420/v2/` on the raw static server redirects to first-run welcome without Tauri settings; screenshot/DOM text show `IronClaw Desktop`, NEAR AI Cloud setup, and the honest `Static preview needs a gateway` state; console warnings/errors: none.
- Rendered copy sweep: in-app browser against `http://127.0.0.1:17668` covered `/v2/welcome`, `/v2/extensions/channels?token=render-copy-token`, `/v2/jobs?token=render-copy-token`, `/v2/routines?token=render-copy-token`, and `/v2/projects?token=render-copy-token`.
  - Console warnings/errors: none.
  - Banned visible-copy hits: none for OpenRouter, Anthropic, Claude, ChatGPT, Codex login, provider marketplace, `operator` copy, `without leaving v2`, or developer-console framing.
- Static contract: `npm run verify:static-frontend`
- Static bundle-size gate: `npm run check:static-bundle`
  - Status: passed.
  - Measures the shipped Tauri static WebUI, not the legacy Svelte build.
  - Current gzipped tracked assets: cold start 359.8 KB / 400 KB; `main.bundle.js` 323.9 KB / 350 KB; boot vendor 22.3 KB / 35 KB; lazy code highlighting 52.0 KB / 60 KB; lazy diagrams 858.5 KB / 950 KB; document/PDF lazy assets 516.3 KB / 600 KB; OCR lazy assets 2501.5 KB / 2800 KB; all tracked assets 4288.1 KB / 4900 KB.
  - Largest tracked asset is OCR lazy glue (`ocr/tesseract-core-simd-lstm.wasm.js`) at 1427.3 KB / 1500 KB; the gate reports WARN but remains under budget.
  - `.github/workflows/check.yml` now runs this gate directly instead of the legacy Svelte bundle-size script.
- Static markdown lazy-renderer proof: `node --test crates/ironclaw_webui_v2_static/static/js/pages/chat/components/markdown-renderer.test.mjs`
  - Status: passed.
  - `index.html` now boots `purify -> marked -> main.bundle` and exposes the shared static asset loader.
  - Highlight.js is no longer on the cold-start path; `MarkdownRenderer` requests `vendor/highlight.min.js` through the same loader only when a rendered code block exists, and coalesces concurrent requests.
  - Mermaid is also off the cold-start path; `MarkdownRenderer` requests `vendor/mermaid.min.js` only after the user clicks `Render diagram`, initializes Mermaid with `securityLevel: strict`, sanitizes returned SVG, and recovers already-enhanced Mermaid blocks.
- Static token lint: `npm run lint:static-tokens`
  - Status: passed.
  - Scans 230 shipped static JS files and fails if raw red/yellow/amber/orange/green/lime status utilities return outside generated bundles/tests.
- Static copy lint: `npm run lint:static-copy`
  - Status: passed.
  - Scans 194 shipped static JS files and fails if normal desktop copy leaks OpenRouter, Anthropic, Claude, ChatGPT, Codex login, provider marketplace framing, `operator`, generic `console`, or `Gateway v2`/route wording.
- Static DT-1..DT-6 design harness: `npm run test:design-static`
  - Status: passed.
  - Maps the design-test series to shipped static UI proof: cold-open prepared desk, flat primary action discipline, bicolor/semantic status tokens, calm motion/reduced-motion policy, empty/loading dignity, and approval-gate craft.
  - Wired into `simple-git-hooks` pre-push and `.github/workflows/check.yml`.
  - First run caught a real DT-5 gap: the knowledge-app empty state mentioned Browse but had no action. The MCP empty state now shows `Browse knowledge apps` and links inside `/v2/extensions/registry?setup=1&focus=notion`, guarded by the harness and the rendered `static a11y: connections knowledge apps` test.
- Rendered static smoke: `npm run smoke:webui-static`
- Static JS tests: `npm run test:static` -> 374 passed.
- Full test suite: `npm run test` -> 161 files / 1294 tests passed.
- Type/UI check: `npm run check` -> 0 errors / 0 warnings.
- Packaged build: `npm run tauri -- build`
  - App: `src-tauri/target/release/bundle/macos/IronClaw.app`
  - DMG: `src-tauri/target/release/bundle/dmg/IronClaw_0.4.158_aarch64.dmg`
  - Local artifact is unsigned because `TAURI_SIGNING_PRIVATE_KEY` is not set.
- Packaged WebView smoke: `npm run smoke:packaged -- --webview-smoke`
  - Status: passed.
  - Evidence: `/tmp/ironclaw-packaged-webview-smoke-20260613-113630.json`
  - 15 checks passed.
  - Chat proof: timeline.
  - Export proof: Markdown, HTML, JSON, PDF, DOCX blobs parse/render, and a saved file exists on disk.
- Live connector truth probe: `node scripts/probe-live-reborn-connectors.mjs`
  - Evidence: `output/live-connector-probe/reborn-live-connector-probe-2026-06-13T14-28-15-711Z.json`
  - Contract violations: none.
  - Gmail OAuth: 503 honest blocked.
  - Google Calendar OAuth: 503 honest blocked.
  - Notion OAuth: 200.
  - Upstream defect: raw `POST /activate` can still report `authenticated:true` without credential proof for Gmail, Google Calendar, and Notion; the desktop UI must keep guarding this.
- NEAR AI execution honesty probe: `IRONCLAW_PROBE_MODES=nearai node scripts/probe-live-reborn-model-execution.mjs`
  - Evidence: `output/live-model-execution-probe/reborn-live-model-execution-2026-06-13T14-28-51-559Z.json`
  - Send accepted, timeline projected the prompt, run lifecycle reached failed, assistant marker was not fabricated, assistant message count stayed 0.
- Calm-motion contract: `node --test crates/ironclaw_webui_v2_static/static/js/design-system/calm-motion.test.mjs`
  - Status: passed.
  - Guards committed source, generated `main.bundle.js`, and generated Tailwind CSS against `animate-pulse`, `animate-bounce`, default pulse/bounce keyframes, and skeleton shimmer.
  - Guards reduced-motion policy: all ambient animation/transition is suppressed, and live/running dots opt into `v2-breathing-dot` only under `prefers-reduced-motion: no-preference`.
  - `rg "animate-pulse|animate-bounce|animate-\\[v2-breathe|v2-skeleton-shimmer|@keyframes pulse|@keyframes bounce" crates/ironclaw_webui_v2_static/static/js crates/ironclaw_webui_v2_static/static/styles --glob '!vendor/**' --glob '!*.test.mjs'` returns no shipped UI hits.
- Static accessibility gate: `npm run test:a11y-static`
  - Status: passed.
  - Full static Playwright project now runs 34 rendered tests: 15 axe surfaces, 4 attachment ingress/thumbnail proofs, 3 connector proofs, 6 keyboard/approval flows, 1 hostile markdown geometry proof, 1 Mermaid diagram proof, 1 Desk-lite front-door proof, 1 completed-action receipt proof, and 2 saved/generated Work artifact reload proofs.
  - Covers 15 shipped static `/v2` surfaces with mocked Reborn API responses: onboarding, chat, connections registry/installed/channels/MCP, AI setup, language settings, automations, workspace, projects, jobs, routines, missions, and logs.
  - Fails on critical/serious axe violations and console/page errors; `color-contrast` remains excluded for the same token/opacity false-positive reason as the legacy a11y suite.
  - `.github/workflows/check.yml` now runs this rendered static gate, so saved-work, connector, attachment, keyboard, and axe regressions do not rely only on local pre-push.
  - The expanded run caught and fixed a critical Logs control-name violation; the Logs route now keeps its local-only empty state while exposing named select controls.
  - The gate now starts the static server on the same port it tests (`PORT=1420`), removing the fake-green dependency on a previously-running local server.
- Static markdown layout gate: `npx playwright test --config playwright.static.config.ts tests/static/markdown-layout-static.spec.ts`
  - Status: passed.
  - Injects a deliberately oversized generated table and 2400px SVG into the real static app shell with the shipped CSS loaded.
  - Proves the page/canvas width stays bounded, table overflow is internal, and SVG/media are clamped to the message width.
- Static Mermaid diagram gate: `npx playwright test --config playwright.static.config.ts tests/static/mermaid-static.spec.ts`
  - Status: passed.
  - Mocks the real Reborn timeline, renders an assistant message with a `mermaid` fence in `/v2/chat/thread-mermaid`, verifies no Mermaid script is loaded before user intent, clicks `Render diagram`, then verifies `vendor/mermaid.min.js` loads once and the sanitized SVG appears with no embedded scripts.
- Static keyboard gate: `npx playwright test --config playwright.static.config.ts tests/static/keyboard-static.spec.ts`
  - Status: passed, 6 rendered tests.
  - Proves keyboard traversal through the chat composer reaches model settings, the `Add to message` plus sheet, and send controls in order.
  - Proves the plus sheet opens from keyboard, exposes the Attach files action and paste/drop guidance, and closes on Escape without breaking the send path.
  - Proves the model selector opens from keyboard, closes on Escape, and the NEAR AI Cloud setup escape hatch remains reachable.
  - Deliberately mocks ugly live model ids (`z-ai/glm-4.5`, `anthropic/claude-sonnet-4.5`, `openrouter/chatgpt-4o`) and verifies the rendered selector shows product labels (`GLM 4.5`, `NEAR premium reasoning`) without exposing raw provider/model plumbing.
  - Verifies `Active` / `Available models` grouping, hides the raw model-id input by default, reveals it only after `Use a model ID`, and guards duplicate friendly model labels (`NEAR premium reasoning` appears once even when multiple backend ids normalize to it).
  - Proves the command palette opens with Ctrl/Cmd+K, does not expose hidden work surfaces, and navigates to Connections.
  - Proves a streamed approval gate resolves through the real Reborn gate endpoint with Ctrl+Enter for approve and Escape for deny.
  - Caught and fixed a real `/v2` scope regression: the Connections empty-state `Browse apps` anchor previously jumped to `/extensions/registry` outside the Tauri static basename.
- Static gate-enforcement smoke: `npm run smoke:gate-enforcement`
  - Status: passed.
  - Starts a mock Reborn gateway and static WebUI server, posts a real chat prompt, streams a `send_email` approval gate over SSE, verifies the accessible approval card includes the Reborn reason/body, `Touches`, `What leaves the machine`, parameters, high-risk always-allow block, and controls, then approves the gate and verifies the exact `/threads/{thread}/runs/{run}/gates/{gate}/resolve` URL, bearer token, one-shot approval body, continuation message, and gate/resolved screenshots.
- Static attachment ingress gate: `npx playwright test --config playwright.static.config.ts tests/static/attachments-static.spec.ts`
  - Status: passed, 3 rendered tests.
  - Proves file picker, clipboard paste, and drag/drop each render a file chip, preserve the typed prompt, and send through the real Reborn `/messages` route via the Tauri bridge.
  - Captures the request body and verifies both channels the model depends on: first-class `attachments[0].base64` plus the readable `<attachments ic="1">` durable text block appended to `content`.
- Static DOCX export fidelity gate: `node --test crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/work-product-export.test.mjs`
  - Status: passed, 4 tests.
  - Proves DOCX exports are parseable stored OOXML packages with real `word/numbering.xml`, heading styles, editable bullet and ordered list numbering, table XML, and external hyperlink relationships instead of flattened markdown text.
  - Keeps Mermaid source preservation and byte-accurate PDF xref/startxref coverage green.
- Static whole-thread export gate: `node --test crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/message-bubble.test.mjs`
  - Status: passed, includes whole-thread export, generated-document header, generated-file chip, image thumbnail, and attachment-stack renderer contracts.
  - Proves the assistant export menu includes whole-conversation Thread DOCX and Thread PDF actions, and both route through the same tested whole-thread markdown plus DOCX/PDF artifact builders before native save.
  - Proves generated markdown/document work mounts an explicit `Generated document` artifact header and scopes copy/save/export controls to the artifact instead of a generic assistant response.
  - Proves generated file payloads mount a `Generated file` chip with Preview, Save, and Save to Work controls.
  - Proves plain assistant prose is borderless, non-gold, and document-like while user turns keep the restrained signal-blue bubble; generated work remains the separate gold artifact panel.
- Static artifact-header smoke: `npm run smoke:webui-static`
  - Status: passed.
  - Sends the mocked services-agreement prompt with PDF/DOCX/XLSX/MD/JSON/HTML attachments, verifies the wide assistant work-product panel, verifies the new `assistant-artifact-chip`, and exports MD/HTML/JSON/PDF/DOCX through the artifact-scoped export menu.
  - Caught and fixed a rendered menu placement bug: the new artifact export popover initially opened upward under the sticky header; generated-document export now opens downward and the rendered export click succeeds.
- Static saved/generated Work route gate: `npx playwright test --config playwright.static.config.ts tests/static/work-product-static.spec.ts`
  - Status: passed, 2 rendered tests.
  - Seeds the same `ironclaw-work-items` store used by chat `Save to Work`, opens `/v2/work?item=...&artifact=...`, proves the saved markdown artifact reloads visibly, verifies copy/DOCX/PDF controls, and proves the preserved source thread opens at `/v2/chat/<thread>`.
  - Mocks a Reborn timeline assistant message with a generated DOCX artifact, proves chat renders the `Generated file` chip with Preview and Save to Work, then saves/reloads the artifact through `/v2/work` as a binary file with original-byte save.
- Static tool-row copy gate: `node --test crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/activity-summary.test.mjs crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/tool-activity.test.mjs`
  - Status: passed, 3 focused tests; covered again inside `npm run test:static`.
  - Replaces generic `Activity - 2 tools`/`explored` wording with quiet one-line labels such as `Read 1 file`, `Searched 1 time`, `Checked 3 tool steps`, `Checking 1 tool step...`, and `1 tool failed`.
  - `ActivityRun` now exposes a stable `activity-summary-row` control with an accessible label that names the row and whether details will show/hide.
- Static composer sheet gate: `node --test crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/chat-input.test.mjs crates/ironclaw_webui_v2_static/static/js/i18n/i18n-completeness.test.mjs`
  - Status: passed, 14 focused tests; covered again inside `npm run test:static`.
  - Replaces the standalone attachment icon with a single `Add to message` plus sheet while preserving the existing hidden file input, paste, and drag/drop payload paths.
  - Keeps the new English copy honest in the i18n missing-key baseline instead of silently adding untranslated copy.
- Static grouped model-picker gate: focused `chat-input`/i18n tests + `npx playwright test --config playwright.static.config.ts tests/static/keyboard-static.spec.ts -g "model selector"` + in-app browser proof against `http://127.0.0.1:1422/` with a temporary mocked NEAR AI gateway.
  - Status: passed.
  - Chat model popover now shows one NEAR AI source, `Active` and `Available models` groups, cleaned labels, and a hidden-by-default `Use a model ID` expert override.
  - Browser proof: button settled to `NEAR AI Cloud · GLM 4.5`; dialog showed `GLM 4.5`, `Premium Reasoning`, `GPT OSS 120B`, and one `NEAR premium reasoning`; raw counts for `z-ai/glm`, `anthropic`, `claude`, `openrouter`, and `chatgpt` were zero; manual model placeholder count was 0 before the toggle and 1 after; console warnings/errors were empty.
- Static attachment-thumbnail gate: `node --test crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/message-bubble.test.mjs` + `npx playwright test --config playwright.static.config.ts tests/static/attachments-static.spec.ts`
  - Status: passed, 13 focused transcript-renderer tests plus 4 rendered attachment tests.
  - User image uploads now render as a rounded thumbnail strip above the user bubble instead of being buried inside the text bubble.
  - Image attachments with available payloads render as visible thumbnails; metadata-only reload images and other files remain as attachment chips so the transcript does not pretend bytes are present when only metadata is durable. The rendered PNG test proves a real image upload reaches Reborn as first-class payload while the transcript shows `message-image-thumbnails`.
- Static receipt-card gate: `node --test crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/activity-summary.test.mjs crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/activity-run.test.mjs crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/tool-activity.test.mjs` + `npx playwright test --config playwright.static.config.ts tests/static/activity-static.spec.ts`
  - Status: passed, 6 focused activity renderer tests plus 1 rendered receipt test.
  - Completed tool results now render as a gold `Agent action completed` receipt with Outcome/Steps/Result rows and an `Open result` link when Reborn supplies a URL, while running/error activity still uses the quieter expandable activity row.
  - The rendered test loads a real `capability_display_preview` timeline record and proves the chat surface renders the receipt rather than only asserting helper output.
- Static model-display gate: `node --test crates/ironclaw_webui_v2_static/static/js/pages/settings/lib/llm-providers.test.mjs crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/chat-input.test.mjs crates/ironclaw_webui_v2_static/static/js/pages/settings/components/provider-components.test.mjs`
  - Status: passed; covered again inside `npm run test:static`.
  - Raw model ids remain the values sent to `setActiveLlm`, but the chat chip, chat popover, Settings active-model panel, and provider detail row display NEAR-branded product labels.
  - Guards `auto -> Auto`, `z-ai/glm-4.5 -> GLM 4.5`, `gpt-oss-120b -> GPT OSS 120B`, `qwen/* -> NEAR fast model`, and provider-looking ids containing OpenRouter/Anthropic/Claude/ChatGPT -> `NEAR premium reasoning`.
  - In-app browser proof against `http://127.0.0.1:1422/v2/chat?token=browser-model-proof` with a temporary mocked gateway: chat loaded, model dialog opened, `GLM 4.5` and `NEAR premium reasoning` were visible, raw counts for `z-ai/glm-4.5`, `anthropic`, `claude`, `openrouter`, and `chatgpt` were all zero, and console warnings/errors were empty.
- Static connector lifecycle gate: `npx playwright test --config playwright.static.config.ts tests/static/connectors-static.spec.ts`
  - Status: passed, 5 rendered tests.
  - Clicks Gmail, Google Calendar, Notion, and Slack registry cards in the rendered app.
  - Verifies install payloads keep slash-prefixed catalog refs (`tools/gmail`, `tools/google_calendar`, `mcp-servers/notion`, `channels/slack`) while lifecycle/setup/activate URLs use canonical bare names (`gmail`, `google-calendar`, `notion`, `slack`).
  - Verifies the rendered Knowledge Apps custom MCP form is action-wired, posts `/api/webchat/v2/extensions/install` with `{ name:"team-docs", url:"https://docs.example.com/mcp", kind:"mcp_server" }`, does not send `package_ref`, and blocks insecure remote HTTP before a gateway call.
  - Verifies explicit chat setup prompts deep-link to `/v2/extensions/registry?setup=1&focus=notion` instead of submitting a dead model prompt.
  - Verifies a rendered Reborn SSE `projection_update` with a failed Notion run shows the real failure text plus the same setup recovery card, then opens the focused registry card.
  - Verifies blocked Google setup exits stay scoped to `/v2/settings/inference#google-oauth`; Slack reaches connected only after activation returns credential proof.
- Static approval-gate context gate: `node --test crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/gates.test.mjs crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/approval-card.test.mjs crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/useChatEvents.test.mjs`
  - Status: passed, 18 focused tests.
  - Typed Reborn approval gates now preserve structured `approval_context` into the approval card contract: `tool_name`, reason, action/method, scope, destination, and details become visible approval parameters instead of collapsing into a vague headline.
  - Sparse projection gates remain honest: the current Reborn projection schema only sends `gate_ref`, `headline`, and `allow_always`, so the client preserves `allow_always` and does not invent tool parameters.
- Logs design contract: `node --test crates/ironclaw_webui_v2_static/static/js/pages/logs/logs-design-contract.test.mjs`
  - Status: passed.
  - Guards the rendered Logs route against raw red/yellow/amber/orange/green status classes so warning and danger states keep using semantic desktop tokens.
- Chat design contract: `node --test crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/chat-design-contract.test.mjs`
  - Status: passed.
  - Guards primary chat failure, connection, composer-remove, and Slack pairing status states against raw red/yellow/amber/orange/green utility classes.
- Settings design contract: `node --test crates/ironclaw_webui_v2_static/static/js/pages/settings/lib/settings-design-contract.test.mjs`
  - Status: passed.
  - Guards the NEAR AI/model setup path against raw status color utilities in save errors, provider login/test messages, restart feedback, and skill action results.
- Routed/admin design contract: `node --test crates/ironclaw_webui_v2_static/static/js/pages/deep-link-design-contract.test.mjs`
  - Status: passed.
  - Guards automations, jobs, missions, projects, routines, workspace, and admin delete/error states against raw red/yellow/amber/orange/green utility classes.
- Hostile usability sidecar fixes:
  - Bare backend readiness tokens (`needs_token`, `blocked`, `auth_required`, `credentials_unavailable`) now block chat send even without extra reason text.
  - `/v2/workspace` no longer selects a phantom `README.md`; backend-blocked workspace writes surface errors instead of success.
  - Google connector setup guidance now stays scoped to `/v2/settings/inference#google-oauth` when launched from hosted static routes.

## Escalated Findings

| Surface | State | Hostile finding | Decision |
| --- | --- | --- | --- |
| Onboarding | GREEN | The first-run screen now says `IronClaw Desktop`, explains NEAR AI Cloud native model access, approvals, and file continuity. It does not ask users to choose third-party LLM vendors before they can work. | Keep. Next proof should be a packaged OAuth smoke with a real token. |
| Chat front door | GREEN | The blank chat state is no longer an empty prompt box. It shows readiness, connector limits, approval behavior, file entry points, and practical prompts. | Keep. Add live pending-approval rows when gateway exposes them globally. |
| Model selector | GREEN | Normal desktop UI exposes NEAR AI Cloud and clean product model labels (`Auto`, `GLM 4.5`, `GPT OSS 120B`, `NEAR premium reasoning`) while preserving raw backend ids only as submitted values. The chat popover now groups Active and Available models, collapses duplicate friendly labels, and hides the raw model-id field behind `Use a model ID`. Non-NEAR providers are hidden from search/default setup, and rendered/browser tests prove provider-looking model ids do not leak into the selector. | Keep. Advanced provider management must remain deep-link/admin-only. |
| Provider copy | GREEN | A new desktop provider contract test prevents ChatGPT/Codex login paths and Codex-specific routes from returning to normal setup surfaces. | Keep as a release gate. |
| Connections installed state | GREEN | Empty installed state is clear and leads to Browse apps. A rendered keyboard test now proves the link stays inside `/v2/extensions/registry` instead of escaping the desktop basename. The knowledge-app empty state now also exposes a real `Browse knowledge apps` action instead of dead-end copy, and routes to `/v2/extensions/registry?setup=1&focus=notion`. | Keep. Add connected examples once live connector proofs exist. |
| Connections registry | YELLOW/GREEN | Gmail, Google Calendar, Slack, and Notion appear as easy primary actions with honest install/setup guidance. Live probe found no route-contract violations, and rendered connector tests now prove registry clicks keep slash-prefixed refs out of lifecycle URLs, explicit chat setup prompts deep-link to Connections, Reborn failed connector runs recover to a focused setup card, and the Knowledge Apps custom MCP form posts a real unauthenticated URL install payload while blocking insecure remote HTTP locally. | Keep UI credential-proof guard because backend raw activate still reports authenticated without credential proof. Custom MCP OAuth/sign-in remains upstream. |
| Chat prepared desk | YELLOW/GREEN | The chat cold open now renders a backed Desk-lite panel with `Needs you` and `Handled` sections. Source tests prove needs-you rows come from persisted thread gate/failure state and handled rows come from completed automations/recent work without faking failed automation receipts. Rendered `frontdoor-static.spec.ts` proves a cold open with a pending approval and completed automation shows both sections with real links; in-app browser smoke also proves the front-door shell renders cleanly with no console warnings. | Keep honest zero states until the gateway exposes a user-scoped cross-thread gate/recent-run feed. |
| Google OAuth | RED | The UI is honest: Gmail/Calendar need hosted OAuth/client-id support and the live probe returns 503 honest blocked. Blocked setup links now stay inside `/v2` and land on the AI setup target. | Product cannot claim Google OAuth works out of the box until gateway/desktop ships hosted OAuth or a preconfigured desktop client flow. |
| Notion OAuth | YELLOW | Notion is visible and setup-gated; live OAuth start returns 200. | Needs a rendered packaged connector flow that completes credential proof, not just OAuth start. |
| Workspace deep link | YELLOW | Workspace is still backend-blocked, but it no longer invents a README file or reports successful saves from `{ success:false }`. | Keep hidden/deep-link-only until real v2 workspace endpoints exist. |
| Work product exports | GREEN | Packaged WebView smoke proves attachment send, timeline chat proof, parseable MD/HTML/JSON/PDF/DOCX export blobs, and native saved-file bytes. Static rendered tests separately prove picker, paste, and drag/drop attachment ingress sends readable payloads to Reborn. DOCX exports now preserve headings, tables, editable lists, and clickable external links as OOXML structure. Whole-thread export now offers MD/JSON/PDF/DOCX instead of stopping at markdown and JSON. Generated markdown/document work now renders with an explicit `Generated document` artifact header, copy, Save to Work, and export controls; generated file payloads with available bytes now render as `Generated file` chips with Preview, Save original, and Save to Work. `work-product-static.spec.ts` proves a mocked Reborn DOCX artifact appears in chat, saves into `/v2/work`, reloads as a file artifact, preserves the thread link, and exposes original-byte save. | Keep. Deep OCR remains opt-in in packaged smoke; live NEAR/Reborn proof still needs a real assistant-generated binary payload, but the UI plumbing is now covered. |
| Generated markdown layout | GREEN | Wide generated tables and SVG/media are now bounded by markdown CSS. A source CSS contract plus rendered Playwright geometry test prove hostile tables scroll internally and 2400px SVGs cannot widen the chat canvas. | Keep. Next visualization push should finish export parity for tables, diagrams, and whole-thread artifacts. |
| Generated diagrams | GREEN/YELLOW | Mermaid fences now render as first-class diagram cards in chat, stay off the cold-start path, require explicit user click, initialize with strict Mermaid security, sanitize returned SVG, and are covered by both source tests and a rendered static Playwright proof. Exports preserve labeled Mermaid source across MD/HTML/JSON/PDF/DOCX instead of dropping it into anonymous fences. DOCX structure fidelity improved for headings/lists/links/tables. | Keep. Full VIZ-3 is still YELLOW until DOCX/PDF/HTML can embed the rendered diagram image from the same render path, not only the source. |
| Tool activity readability | GREEN | Grouped activity no longer reads as generic workflow machinery. Source/static tests prove quiet row labels for file reads, searches, mixed tool steps, running state, and failure state, and the row has a stable accessible expand affordance. Completed tool results now become gold agent-action receipts with outcome rows and a real Open-result link when supplied by Reborn. | Keep. Receipt cards should remain for completed agent actions only; running/error tool chatter stays collapsed or failure-visible. |
| Chat message grammar | GREEN | Plain assistant prose is now bubble-less and non-gold, so ordinary answers read like document text instead of another card or generated artifact. User turns remain a restrained signal-blue bubble, and generated markdown/document output remains a gold artifact panel with copy/save/export controls. | Keep. Receipt cards should be the next gold-marked agent-action pattern; do not reintroduce gold as generic assistant decoration. |
| Composer grammar | GREEN | Attachment entry now sits behind one `Add to message` plus sheet instead of a persistent standalone attachment chip. The sheet names the Attach files action, explains supported file types, and keeps paste/drop discoverability without changing the proven payload paths. The model chip now uses NEAR-branded labels instead of raw provider ids, and the advanced manual model-id field is behind an explicit expert affordance. Uploaded image evidence now renders as rounded thumbnails above the user bubble when bytes are available, while reload-only metadata stays as honest file chips. | Keep. Next composer pass should add richer generated-file previews/download chips without reintroducing chip soup. |
| Real assistant generation | RED | NEAR AI no-credential probe correctly fails without fabricating assistant work. | Needs a real NEAR AI Cloud token/session proof to produce assistant work from attachments. |
| Visual system | GREEN | Inter Variable, restrained dark desk, 8px cards, quiet tokens, and left-nav hierarchy are coherent across captured surfaces. Loading placeholders now use static `v2-skeleton` blocks, chat typing no longer bounces, live/running dots use a reduced-motion-aware semantic class, and primary chat/Settings/Logs/deep-link/admin status states now use warning/danger/positive tokens instead of raw Tailwind colors. | Keep. Avoid returning to marketing-card layouts, raw status palettes, or perpetual skeleton motion. |
| Static performance gate | GREEN | `npm run check:static-bundle` now measures the packaged static WebUI instead of the dead Svelte build and is part of `pre-push`. Highlight.js and Mermaid are lazy-loaded from markdown/code/diagram blocks instead of blocking app boot; cold start is 359.8 KB gzip after the hidden Work reader, model-display polish, grouped model picker, Desk-lite front door, receipts, image thumbnails, generated file chips, and custom MCP form. OCR lazy support is the closest budget pressure. | Keep. Next perf push should split never-visited routes and keep OCR under pressure watch. |
| Copy/product language | GREEN | Remaining visible `operator`, `without leaving v2`, and developer-console leaks in jobs/routines/channels/projects copy were removed. `npm run lint:static-copy` now blocks the normal setup/provider-brand leaks the user has repeatedly called out. | Keep Google Cloud Console allowed only as the proper external Google product name. |
| Packaged OCR asset bridge | GREEN | The Tauri OCR loopback server now returns a per-boot tokenized endpoint and rejects missing/wrong token paths, non-loopback Host headers, wrong ports, and non-GET requests. The static PDF OCR loader uses `/token/file` asset URLs while preserving legacy numeric-port compatibility for mixed local runs. | Keep. Verified by `cargo test --manifest-path src-tauri/Cargo.toml --lib ocr_assets --locked`, adjacent `gateway_ssrf_tests`/`base64_payload_tests`, and `node --test crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/pdf-text-extract.test.mjs`. |
| Secret storage boundary | GREEN | Provider credentials now remain keychain-only: `tokens/` denies `llm-*` accounts, LLM credential writes use keychain with timeout and no plaintext fallback, and the local sidecar bearer writes a fallback file only after keychain failure/timeout. `docs/ARCHITECTURE.md` records the threat model and accepted local/gateway bearer exception. | Keep. Verified by `cargo test --manifest-path src-tauri/Cargo.toml --lib keychain --locked`; full Rust/library and static guards should stay in pre-push evidence. |
| Accessibility gate | GREEN | The shipped static WebUI now has a dedicated Playwright/axe project for 15 onboarding/chat/connection/settings/deep-link surfaces plus rendered keyboard/focus gates for composer, plus-sheet, model selector, command palette, Connections, AI setup, streamed approval gates, attachment picker/paste/drop, connector lifecycle clicks, explicit connector setup prompts, failed-run connector recovery, custom MCP URL install, image-thumbnail transcript proof, completed-action receipt proof, Desk-lite front-door proof, saved Work artifact reload, and generated DOCX chip-to-Work reload. The current rendered static gate is 36 tests. These gates caught a Logs select-name violation, a `/v2` Browse-apps routing regression, test-harness cleanup flake, missing Knowledge-tab action wiring, and now assert the knowledge-app empty-state Browse action plus custom MCP payload. Raw status color regressions are blocked by `npm run lint:static-tokens`; jargon/provider copy regressions are blocked by `npm run lint:static-copy`; DT-1..DT-6 regressions are blocked by `npm run test:design-static` in pre-push and CI. | Keep expanding toward live connector-completion keyboard paths. |
| Screenshot process | GREEN | README/design capture now regenerates `contact-sheet.png` from current screenshots and does not leak proxy 502 console errors. | Keep as a review precondition. |

## Required Next Product Proofs

1. Real NEAR AI Cloud session proof: launch packaged app with a valid session/token, send chat with one of the proven attachment ingress paths, and receive an assistant result from attachment content.
2. Connector completion proof by app: Gmail, Google Calendar, Slack, Notion, and workspace files must either connect with credential/account proof or show a specific blocked setup state with exact HTTP evidence.
3. Real generated work-product proof: after a live NEAR AI assistant result, prove Reborn returns generated file bytes, render the file chip from the live timeline, save the original bytes, save to Work, and parse/render downloaded DOCX/PDF/HTML/MD/JSON outputs.
4. OAuth completion decision: either ship hosted Google/Notion OAuth through the gateway or keep the UI in explicit blocked setup state.
5. Browser-level regression: drive onboarding, chat, settings, and connections in a real packaged WebView after every static bridge/runtime change.

## Release Bar

This design push is shippable as a static UI/product-surface cleanup. It is not yet sufficient to claim connectors work out of the box. The correct public claim is:

> IronClaw Desktop now presents a coherent NEAR AI Cloud-first assistant surface, exposes connector setup honestly, builds into a packaged app, and has rendered/static/package proof for chat attachment persistence and work-product exports. Live connector completion and real NEAR AI assistant generation remain the next release blockers.
