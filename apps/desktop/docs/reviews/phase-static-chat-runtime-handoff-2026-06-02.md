## Handoff: Phase 1 - Static Chat and Runtime Deploy

Status: YELLOW
Owner lane: Static UI

### Goal
Make the canonical static Reborn WebUI usable enough for the desktop chat path: the user can type a message, see it remain visible, receive the assistant result after live Reborn completion, see/change the default model affordance, attach/drop files at the composer, and run the freshly built app from `/Applications/IronClaw.app` with the local Reborn sidecar.

### Changed
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/hooks/useChat.js`: added timeline polling fallback after send, preserved optimistic user bubbles, serialized composer attachments into the message POST body, and refetched timeline after terminal run completion.
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/hooks/useHistory.js`: accepted both live `messages` and older/mocked `records` timeline payloads.
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/history-messages.js`: deduped optimistic user bubbles against returned timeline rows, kept pending user text when terminal timelines lag, and parsed durable `<attachments>` transcript blocks into normal attachment chips so raw base64 does not render in chat.
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/hooks/useSSE.js`: avoided rendering hard `Disconnected` after a finite event stream had already opened.
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/components/chat-input.js`: added a visible model selector, accessible send/attach controls, drag/drop state, and attachment-only send fallback text.
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/components/message-bubble.js`: added assistant/work-product actions for copy, Markdown, HTML, PDF, DOCX, JSON, save, full-thread Markdown, and full-thread JSON exports.
- `crates/ironclaw_webui_v2_static/static/js/lib/api.js`: added GLM default model persistence, Tauri settings/save/start-sidecar integration, attachment posting support, and gateway-status fallback for static/Tauri runtime.
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/work-product-export.js`: added local export builders for Markdown, HTML, JSON, minimal valid DOCX, and minimal valid PDF so chat output is not trapped as unstructured text.
- `crates/ironclaw_webui_v2_static/static/js/components/sidebar.js`: lowered the logo/header spacing to avoid macOS traffic-light collision.
- `crates/ironclaw_webui_v2_static/static/js/i18n/en.js`: updated chat placeholder copy to `Message IronClaw…`.
- `src-tauri/src/sidecar.rs`: defaulted NEAR.AI to `z-ai/glm-4.5`, preferred port 3000, and launched `ironclaw-reborn serve`.
- `src-tauri/src/lib.rs`: passed model id into sidecar startup and auto-started the Reborn sidecar with the GLM default.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_reborn_composition/src/webui_serve.rs`: added real Reborn v2 `/api/health` and `/api/gateway/status` routes so the installed sidecar no longer returns 404 for desktop readiness probes.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_reborn_composition/tests/webui_v2_serve.rs`: added a router-level regression proving those probe routes return JSON without dispatching into the Reborn services facade.
- `tests/history-messages.test.ts`: added eight focused tests for timeline mapping, optimistic dedupe, lagging timeline preservation, durable attachment parsing, attachment dedupe, capability preview rendering, and tool-result reference filtering.
- `tests/e2e/work-product-actions.spec.ts`: validates visible assistant copy/export actions, real DOCX/PDF downloads, structured table export, full-thread Markdown/JSON export, and promotion into a Work artifact.
- `scripts/smoke-webui-static.mjs`: mocked `/api/gateway/status` so static desktop smoke covers the new model/status surface without console errors.

### Verified
- `npm run check`: passed, `svelte-check found 0 errors and 0 warnings`.
- `npx vitest run tests/history-messages.test.ts src/lib/util/work-product-export.test.ts src/lib/util/work-product-normalize.test.ts`: passed, 3 files / 19 tests.
- `npx playwright test tests/e2e/chat.spec.ts --project=chromium --grep "user can send|sent Reborn message stays visible|active provider|attaches files|dropped files|draft-from-attachment"`: passed, 5 tests.
- `npx playwright test tests/e2e/work-product-actions.spec.ts --project=chromium --grep "Reborn chat assistant responses|Reborn chat exports tables|Reborn chat exports the full visible thread"`: passed, 8 tests covering copy, Markdown, DOCX, PDF, structured HTML/DOCX, full-thread Markdown, full-thread JSON, and Work artifact promotion.
- Live rendered static UI against real local Reborn on `127.0.0.1:3000`: passed; sent `marker-1780351918973`, navigated to `/chat/3a65e65b-30bc-5479-a413-1042e4b4d0ed`, rendered the user marker and assistant reply `ok echo marker-1780351918973`, model label `Running: NEAR.AI / z-ai/glm-4.5`, and no hard `Disconnected`.
- `npm run prepare:webui-static`: passed.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `npm run smoke:webui-static`: passed after gateway-status mock.
- `cargo test -p ironclaw_reborn_composition --features webui-v2-beta gateway_probe_routes_are_public_and_report_v2_status --test webui_v2_serve -- --exact`: passed in Reborn.
- `npm run tauri -- build`: produced release binary, `.app`, DMG, and updater tarball; final command exited nonzero only because `TAURI_SIGNING_PRIVATE_KEY` is unset for updater signing.
- `bash scripts/smoke-packaged-app.sh --wait 8 --bundle src-tauri/target/release/bundle/macos/IronClaw.app`: passed; Reborn gateway healthy on port 3000 and no sidecar remained after smoke termination.
- Deployed built bundle to `/Applications/IronClaw.app`, launched it, and verified installed app process plus Reborn child on port 3000.
- Authenticated curl to `http://127.0.0.1:3000/api/webchat/v2/threads` with the desktop local gateway token returned live threads.
- `cargo test -p ironclaw_product_workflow --test webui_inbound_contract send_message_accepts_static_webui_attachment_payload_and_appends_durable_block -- --exact`: passed in Reborn.
- `cargo test -p ironclaw_product_workflow --test webui_inbound_contract send_message_accepts_legacy_desktop_attachment_aliases -- --exact`: passed in Reborn.
- Rebuilt `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/target/release/ironclaw-reborn`, copied it to `src-tauri/binaries/ironclaw-reborn-aarch64-apple-darwin`, rebuilt/redeployed `/Applications/IronClaw.app`, and verified the deployed sidecar binary SHA `bb92bed049db028b54b01796bca872d201fbf7157c73103e08515cfd72b1e912`.
- Live installed-sidecar attachment API proof: `POST /api/webchat/v2/threads/:thread/messages` with `probe-services-template.pdf` returned 200 and timeline preserved `<attachments>`, filename, MIME type, and base64 on thread `ee524e01-2c8c-5ae8-84f2-5a12fb1576a2`.
- Live rendered static UI attachment proof: file-picker upload of `live-ui-attachment-fixture.pdf` posted one attachment, timeline preserved the durable block, and screenshot captured the rendered result.
- Live rendered static UI clean-render proof after parser fix: marker count `1`, `rawAttachmentBlockVisible: false`, attachment chip visible, POST contained one PDF attachment, thread `b3e6bfb6-1837-5765-b003-18b5f24cf17e`.
- Final packaged smoke after refreshed sidecar/UI bundle: `SMOKE_LOG_PATH=/tmp/ironclaw-packaged-smoke-final-20260602-0033.log bash scripts/smoke-packaged-app.sh --wait 8 --bundle src-tauri/target/release/bundle/macos/IronClaw.app`: passed.
- Post-export packaged smoke after rebuilding/redeploying the latest static bundle: `SMOKE_LOG_PATH=/tmp/ironclaw-packaged-smoke-post-export-20260602-004524.log bash scripts/smoke-packaged-app.sh --wait 8 --bundle src-tauri/target/release/bundle/macos/IronClaw.app`: passed; isolated smoke used fallback port 3100 because the visible installed app was already holding port 3000, then terminated with no sidecar orphan.
- Replaced `/Applications/IronClaw.app` with the rebuilt bundle after export changes, reopened it, and verified active installed process `ironclaw-desktop` PID `37657` with child `ironclaw-reborn serve --host 127.0.0.1 --port 3000` PID `37666`.
- Rebuilt Reborn after the gateway probe route patch, copied the sidecar into `src-tauri/binaries/ironclaw-reborn-aarch64-apple-darwin`, rebuilt/redeployed `/Applications/IronClaw.app`, and verified installed sidecar SHA `73942a69feb1c56f2de677976d6a091a54a43ef31931c2f5c1203121b4000eed`.
- Installed gateway proof after redeploy: `GET http://127.0.0.1:3000/api/health` returned 200 `{"channel":"webui-v2","status":"ok"}`; `GET http://127.0.0.1:3000/api/gateway/status` returned 200 with `engine_v2_enabled:true`, `llm_backend:"NEAR.AI"`, and `llm_model:"z-ai/glm-4.5"`; authenticated `GET /api/webchat/v2/threads` still returned 200.
- Final packaged smoke after gateway-status route fix: `SMOKE_LOG_PATH=/tmp/ironclaw-packaged-smoke-gateway-status-20260602-005246.log bash scripts/smoke-packaged-app.sh --wait 8 --bundle src-tauri/target/release/bundle/macos/IronClaw.app`: passed; isolated smoke sidecar terminated with no orphan.

### Evidence
- Live chat screenshot: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/live-static-chat-proof-after-sse-patch.png`.
- Live UI attachment raw-transport screenshot: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/live-ui-attachment-send-proof.png`.
- Live UI attachment clean-render screenshot: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/live-ui-attachment-clean-render-proof.png`.
- Installed app screenshot: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/installed-ironclaw-after-deploy.png`.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260602-001551.log`.
- Final packaged smoke log: `/tmp/ironclaw-packaged-smoke-final-20260602-0033.log`.
- Post-export packaged smoke log: `/tmp/ironclaw-packaged-smoke-post-export-20260602-004524.log`.
- Gateway-status packaged smoke log: `/tmp/ironclaw-packaged-smoke-gateway-status-20260602-005246.log`.
- Installed authenticated threads probe body: `/tmp/ironclaw-installed-threads-after-gateway-status.json`.
- Built app artifact: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/src-tauri/target/release/bundle/macos/IronClaw.app`.
- Deployed app artifact: `/Applications/IronClaw.app`.
- Active installed process snapshot after deploy: `/Applications/IronClaw.app/Contents/MacOS/ironclaw-desktop` with child `/Applications/IronClaw.app/Contents/MacOS/ironclaw-reborn serve --host 127.0.0.1 --port 3000`.

### Still RED
- Sync lane is RED: `crates/ironclaw_webui_v2_static/static` is not a clean byte-for-byte sync from Reborn static; source files diverge and must either be upstreamed to Reborn or intentionally reconciled.
- Work-product generation from attached source files is still RED/YELLOW: attachment transport and exported assistant/thread artifacts are now proven through rendered tests, but model understanding of PDF/DOCX/XLSX templates and high-fidelity generation from those attachments is not proven through the native packaged webview.
- Live connector completion is RED/YELLOW: Gmail/Calendar/Notion setup request construction is improving, but actual OAuth/login/readiness/tool-call proof is not complete; Slack must remain unavailable or explicitly blocked until a real bundled lifecycle exists.
- Native webview chat send is YELLOW: the installed app was launched and sidecar/API were proven, but the actual native webview send was not automated end to end; the end-to-end send proof used the same static UI served by the local static server against live Reborn.
- Runtime cleanup is YELLOW: packaged smoke now repeatedly proves no orphan for isolated bundle launches, but native manual quit/reopen cleanup should still be part of the full installed-app gauntlet.

### Risks
- The desktop static tree is currently untracked in git, so broad sync or cleanup commands can overwrite active agent work.
- The app is now using a strong default model label/config (`z-ai/glm-4.5`), but there is not yet a server-side execution proof that every model switch is honored by Reborn for all providers.
- The current app still has product gaps outside chat: workspace routes, missions, connectors, native-webview work-product generation, and full hostile surface coverage are not green.
- Tauri updater signing is not configured locally; release build artifacts exist, but updater signing fails without `TAURI_SIGNING_PRIVATE_KEY`.

### Next Agent Should Start Here
1. Run `diff -qr -x main.bundle.js -x tailwind.generated.css -x vendor /Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_webui_v2_static/static /Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static` and decide which desktop static deltas must be upstreamed to Reborn versus reverted/reconciled.
2. Start from the proven attachment transport and export-control path and implement real work-product generation: attached PDF/DOCX/XLSX/CSV/JSON/PPTX fixtures must be parsed or summarized, produce user-visible artifacts, export parseable files, and survive reload.
3. Acceptance gate: installed `/Applications/IronClaw.app` native webview sends a real chat message with an attached PDF/DOCX/XLSX fixture, renders user text and assistant result, exports a parseable work product, reload preserves it, and leaves no orphan Reborn process after quit.

### Do Not Touch
- Do not reset/stash/revert the dirty desktop repo or the dirty Reborn repo.
- Do not overwrite untracked `crates/ironclaw_webui_v2_static/static` without a deliberate sync/upstream decision.
- Do not mark connectors connected from localStorage or optimistic UI state.
- Do not claim file support from attachment chips or request payload tests alone.

## Handoff: Phase 1.1 - Live Status UI Heartbeat Recheck

Status: YELLOW
Owner lane: Runtime

### Goal
Verify the next runtime-readiness promise after the gateway-status patch: the rendered static desktop UI, served from the current static bundle and pointed at the installed Reborn sidecar on `127.0.0.1:3000`, consumes the real `/api/gateway/status` response and authenticated thread list rather than falling back to fabricated `todo` readiness.

### Changed
- No product source changed in this heartbeat pass.
- `output/playwright/heartbeat-live-status-ui-proof.json`: captured Playwright evidence for live gateway status, authenticated thread list, rendered model label, and composer visibility.
- `output/playwright/heartbeat-live-status-ui-proof.png`: captured rendered static UI screenshot.
- `docs/reviews/phase-static-chat-runtime-handoff-2026-06-02.md`: appended this handoff packet.

### Verified
- `git status --short && git branch --show-current`: confirmed still on `main` with a large dirty tree; no reset/stash/revert performed.
- `ps -axo pid,ppid,command | rg -i '/Applications/IronClaw.app|ironclaw-reborn.*--port (3000|3100)'`: installed app still open as PID `39357`, Reborn child PID `39364`, bound to port `3000`.
- `lsof -nP -iTCP:3000 -sTCP:LISTEN`: confirmed Reborn sidecar listening on `127.0.0.1:3000`.
- `PORT=1420 IRONCLAW_GATEWAY_ORIGIN=http://127.0.0.1:3000 npm run dev:webui-static`: started a temporary static server/proxy, then stopped it after the proof.
- Playwright live-status probe: passed. It injected the local desktop bearer token, opened `http://127.0.0.1:1420/v2/chat`, observed `GET /api/gateway/status` returning 200 with no `todo` field, observed authenticated `GET /api/webchat/v2/threads` returning 200, rendered `NEAR.AI / z-ai/glm-4.5`, and found the chat composer.

### Evidence
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/heartbeat-live-status-ui-proof.json`.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/heartbeat-live-status-ui-proof.png`.
- Live status body: `{"engine_v2_enabled":true,"llm_backend":"NEAR.AI","llm_model":"z-ai/glm-4.5","enabled_channels":["webchat-v2"],...}`.
- Active process snapshot during proof: `/Applications/IronClaw.app/Contents/MacOS/ironclaw-desktop` PID `39357`; `/Applications/IronClaw.app/Contents/MacOS/ironclaw-reborn serve --host 127.0.0.1 --port 3000` PID `39364`.

### Still RED
- Native packaged WebView interaction remains YELLOW/RED: this pass used Chromium against the current static bundle and live installed sidecar, not direct automation inside the macOS WebView.
- Connector completion remains RED/YELLOW: Gmail/Calendar/Notion setup names are truthful, but OAuth/login/readiness/tool-call proof is not complete; Slack remains unsupported/blocked.
- Work-product generation from attached PDF/DOCX/XLSX templates remains RED/YELLOW: export controls are proven for rendered assistant/thread content, but high-fidelity model generation from real attached templates inside the native packaged app is not proven.
- Sync lane remains RED: desktop static source still diverges from Reborn static source and must be upstreamed/reconciled deliberately.

### Risks
- `npm run dev:webui-static` runs `prepare:webui-static`, so generated static artifacts may be refreshed even though no product source was intentionally edited.
- The live UI proof is stronger than mocked Playwright but still not a native WebView automation.
- The local bearer token was used only against `127.0.0.1`; do not paste or log the token.

### Next Agent Should Start Here
1. Inspect `output/playwright/heartbeat-live-status-ui-proof.json` and verify `statusFromRealGateway:true`, `renderedModelLabel:true`, `composerVisible:true`, and `threadListAuthenticated:true`.
2. Build the next installed-app proof path: automate or manually smoke the native WebView chat composer so a real packaged UI send with attachment can be marked GREEN instead of Chromium-static/live-sidecar YELLOW.
3. Acceptance gate: installed `/Applications/IronClaw.app` native WebView shows real gateway status, sends a message with an attached PDF/DOCX/XLSX fixture, renders the user text and assistant result, exports a parseable artifact, reload preserves it, and app quit leaves no orphan Reborn sidecar.

### Do Not Touch
- Do not kill PID `39357` or Reborn PID `39364` unless the next runtime smoke explicitly requires it and records before/after process evidence.
- Do not reset/stash/revert the dirty desktop or Reborn repositories.
- Do not mark connector or work-product generation green from this status/readiness proof.

## Handoff: Phase 1.2 - Native UI and Live Work Product Heartbeat Recheck

Status: RED
Owner lane: Hostile QA

### Goal
Advance the next unresolved acceptance gate after live status/readiness: attempt native packaged WebView proof, and if the display/session blocks it, run the strongest available live static UI proof against the installed sidecar for file-backed work-product generation and exportability.

### Changed
- No product source changed in this heartbeat pass.
- `output/playwright/heartbeat-native-window-current.png`: captured the current macOS screen during native UI probing.
- `output/playwright/heartbeat-live-1780356570958-board.csv`: created a small CSV fixture for the live file-backed ask.
- `output/playwright/heartbeat-native-and-live-workproduct-red.json`: recorded native UI blocker evidence plus live sidecar timeline/run evidence for the file-backed turn.
- `docs/reviews/phase-static-chat-runtime-handoff-2026-06-02.md`: appended this handoff packet.

### Verified
- `ps -axo pid,ppid,command | rg -i '/Applications/IronClaw.app|ironclaw-reborn.*--port (3000|3100)'`: installed app still open as PID `39357`, Reborn child PID `39364`, bound to port `3000`.
- macOS accessibility probe for `ironclaw-desktop`: process exists but `windows=0`.
- `screencapture -x output/playwright/heartbeat-native-window-current.png`: screenshot is black in this heartbeat session, so native WebView automation is blocked by the display/session state rather than a usable app window.
- Non-destructive `open -a /Applications/IronClaw.app` did not create an accessibility-visible window; `ironclaw-desktop:windows=0` remained true.
- Live static UI fallback against installed sidecar sent prompt `Use the attached CSV only as context. Reply exactly: ok echo heartbeat-live-1780356570958. Do not send, file, email, or use tools.` with attached `heartbeat-live-1780356570958-board.csv`.
- Live timeline lookup found thread `59ae270d-4e0c-51a2-9236-e62c4b68c883` with one persisted user message containing the CSV attachment block and run id `66908cc3-e52c-4068-a442-1b56cea62576`.
- `GET /api/webchat/v2/threads/59ae270d-4e0c-51a2-9236-e62c4b68c883/runs/66908cc3-e52c-4068-a442-1b56cea62576` returned `404 Not Found`.

### Evidence
- Native UI blocker screenshot: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/heartbeat-native-window-current.png`.
- Consolidated RED evidence: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/heartbeat-native-and-live-workproduct-red.json`.
- Live timeline response: `/tmp/ironclaw-heartbeat-workproduct-timeline.json`.
- Run-state response headers: `/tmp/ironclaw-heartbeat-run-headers.txt`.
- File-backed thread: `59ae270d-4e0c-51a2-9236-e62c4b68c883`.
- File-backed run id: `66908cc3-e52c-4068-a442-1b56cea62576`.

### Still RED
- Native packaged WebView automation remains blocked in this heartbeat environment: the process is alive, but System Events reports zero windows and the screenshot is black.
- Live file-backed work-product generation is RED: the user message and attachment persist, but no assistant message/exportable work product appears in the timeline.
- Live run-state observability is RED/YELLOW: the captured run id returns 404 from the apparent run-state route, so the UI has no obvious way to explain whether the run is queued, failed, blocked, or still processing.
- The export-control path is not the failure here; export buttons never appear because there is no assistant/work-product message to export.

### Risks
- `npm run dev:webui-static` runs `prepare:webui-static`, so generated static artifacts may be refreshed.
- The live run may still be processing outside the 30-second export-control wait, but the timeline had only the user message at inspection time and the run-state route was unavailable.
- This pass used a constrained CSV test fixture, not the full PDF services-agreement template; it is still enough to prove the live file-backed turn completion path is not green.

### Next Agent Should Start Here
1. Inspect `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/heartbeat-native-and-live-workproduct-red.json`.
2. Reproduce the backend/UI gap with thread `59ae270d-4e0c-51a2-9236-e62c4b68c883`: timeline has the submitted user message plus attachment but no assistant result; run id `66908cc3-e52c-4068-a442-1b56cea62576` returns 404 from `/runs/{run_id}`.
3. Acceptance gate: live sidecar file-backed turns must either render an assistant/work-product result with export controls or render a truthful pending/failed/blocked state tied to a working run-status endpoint.

### Do Not Touch
- Do not kill PID `39357` or Reborn PID `39364` unless a runtime smoke explicitly requires it and records before/after process evidence.
- Do not mark work-product generation green from attachment persistence alone.
- Do not reset/stash/revert the dirty desktop or Reborn repositories.

## Handoff: Phase 1.3 - Run-State Route and Failure Visibility

Status: YELLOW
Owner lane: Runtime

### Goal
Close the live run-state observability hole from Phase 1.2: a submitted file-backed turn returned a `run_id`, but the WebChat v2 route for that run returned 404, so the UI could only hang or invent a generic failure. The acceptance target for this pass was not to claim full work-product generation; it was to make submitted runs observable and make failures visible in chat.

### Changed
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_webui_v2/src/descriptors.rs`: added `webui.v2.get_run_state` as `GET /api/webchat/v2/threads/{thread_id}/runs/{run_id}` with bearer auth, no body, per-caller read limits, user-action audit class, and `AllowedEffectPath::TurnCoordinator`.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_webui_v2/src/router.rs`: mounted the new route against the WebChat v2 router.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_webui_v2/src/handlers.rs`: added `get_run_state` handler that forwards path `thread_id` and `run_id` through `RebornServicesApi::get_run_state`.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_webui_v2/src/lib.rs`: exported the new route constant and handler.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_webui_v2/tests/webui_v2_descriptors_contract.rs`: locked the new descriptor policy surface.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_webui_v2/tests/webui_v2_handlers_contract.rs`: added a caller-level handler test proving path IDs reach the facade and a stable run-state DTO is returned.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_reborn_composition/tests/webui_v2_serve.rs`: added a composed-gateway regression proving the JavaScript client path reaches the facade instead of returning route 404.
- `crates/ironclaw_webui_v2_static/static/js/lib/api.js`: added `getRunState({ threadId, runId })`.
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/hooks/useChat.js`: after the post-send timeline polling window, reads run state and renders a concrete failed/cancelled/recovery error bubble instead of the blind generic missing-assistant fallback.
- `scripts/smoke-webui-static.mjs`: added a rendered static smoke scenario where send is accepted, timeline has no assistant reply, run state returns `Failed` with `driver_protocol_violation`, and the chat must render `The run failed: driver protocol violation.`
- `src-tauri/binaries/ironclaw-reborn-aarch64-apple-darwin`: refreshed with the rebuilt Reborn sidecar SHA `27159382645a3de399d9f7afd121ce0e0325ad6d9563cb85c11ee7f4d1bb10f5`.

### Verified
- `cargo fmt -p ironclaw_webui_v2 -p ironclaw_reborn_composition`: passed.
- `cargo test -p ironclaw_webui_v2 --features webui-v2-beta --tests`: passed, including descriptor and handler route contracts.
- `cargo test -p ironclaw_reborn_composition --features webui-v2-beta js_client_get_run_state_path_shape_reaches_facade --test webui_v2_serve -- --exact`: passed.
- `cargo test -p ironclaw_reborn_composition --features webui-v2-beta every_webui_v2_descriptor_is_mounted_on_composed_app --test webui_v2_serve -- --exact`: passed.
- `cargo build --release -p ironclaw_reborn_cli --features webui-v2-beta --bin ironclaw-reborn`: passed.
- `node --check crates/ironclaw_webui_v2_static/static/js/lib/api.js`: passed.
- `node --check crates/ironclaw_webui_v2_static/static/js/pages/chat/hooks/useChat.js`: passed.
- `node --check scripts/smoke-webui-static.mjs`: passed.
- `npm run prepare:webui-static`: passed.
- `npm run smoke:webui-static`: passed, including the new run-state failure visibility scenario and screenshot capture.
- `npm run tauri -- build`: produced the release binary, `.app`, DMG, and updater tarball; exited nonzero only at updater signing because `TAURI_SIGNING_PRIVATE_KEY` is absent.
- Replaced `/Applications/IronClaw.app` with the rebuilt bundle and relaunched it. Active installed app after deploy: PID `50302` with Reborn child PID `50309` on `127.0.0.1:3000`.
- Installed sidecar checksum matches desktop binary: `27159382645a3de399d9f7afd121ce0e0325ad6d9563cb85c11ee7f4d1bb10f5`.
- Live installed `/api/health`: 200 `{"channel":"webui-v2","status":"ok"}`.
- Live installed `/api/gateway/status`: 200 with `engine_v2_enabled:true`, `llm_backend:"NEAR.AI"`, and `llm_model:"z-ai/glm-4.5"`.
- Live authenticated run-state repro route for Phase 1.2 now returns 200 with typed state: thread `59ae270d-4e0c-51a2-9236-e62c4b68c883`, run `66908cc3-e52c-4068-a442-1b56cea62576`, status `Failed`, failure category `driver_protocol_violation`.
- `SMOKE_LOG_PATH=/tmp/ironclaw-packaged-smoke-run-state-route-20260602-0049.log bash scripts/smoke-packaged-app.sh --wait 8 --bundle src-tauri/target/release/bundle/macos/IronClaw.app`: passed; isolated sidecar used port 3100 and left no orphan.

### Evidence
- Live run-state route proof: `/tmp/ironclaw-run-state-old-thread-after-ui-route.txt`.
- Expanded static smoke run-state failure screenshot: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/static-run-state-failure-visible.png`.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-run-state-route-20260602-0049.log`.
- Active installed process after deploy: `/Applications/IronClaw.app/Contents/MacOS/ironclaw-desktop` PID `50302`; `/Applications/IronClaw.app/Contents/MacOS/ironclaw-reborn serve --host 127.0.0.1 --port 3000` PID `50309`.

### Still RED
- Full work-product generation remains RED/YELLOW: this pass proves failure observability and rendered failure UI, not that the agent can generate a high-fidelity services agreement from a PDF/DOCX/XLSX template.
- Native WebView automation remains YELLOW/RED in this heartbeat context: installed process and live API are proven, but direct macOS WebView interaction is still blocked by the session/window-capture issue from Phase 1.2.
- Connector completion remains RED/YELLOW: route naming and truthful setup surfaces are improving, but live OAuth/login/readiness/tool-call proof is not complete.
- Sync lane remains RED: desktop static source still diverges from Reborn static source and must be upstreamed or reconciled deliberately.

### Risks
- `get_run_state` now exposes the real failure category, but the underlying `driver_protocol_violation` still means the agent execution path failed before producing useful output.
- The UI now tells the user about terminal failure after the timeline polling window; it does not yet stream immediate run-state failure if the event bridge fails to emit projection updates.
- Tauri updater signing remains unavailable locally without `TAURI_SIGNING_PRIVATE_KEY`.

### Next Agent Should Start Here
1. Inspect `/tmp/ironclaw-run-state-old-thread-after-ui-route.txt` and `output/playwright/static-run-state-failure-visible.png` to see the now-observable failure path.
2. Attack the underlying `driver_protocol_violation` in the Reborn planned/default run profile or driver protocol: a simple file-backed ask must produce either an assistant message/work-product or a specific recoverable gate, not just a failed run.
3. Acceptance gate: installed `/Applications/IronClaw.app` native UI sends an attached PDF/DOCX/XLSX fixture, preserves the user text, renders either a useful assistant/work-product result or an immediate truthful failure, exports parseable output, reload preserves it, and quit leaves no orphan sidecar.

### Do Not Touch
- Do not reset/stash/revert the dirty desktop or Reborn repositories.
- Do not mark work-product generation green because the failure is now visible.
- Do not hide `driver_protocol_violation` behind generic success/progress copy.
- Do not overwrite the divergent static tree without a deliberate upstream/sync plan.

## Handoff: Phase 1.4 - Default Chat Runtime and Connector Lifecycle Actions

Status: YELLOW
Owner lane: Runtime | Connector

### Goal
Close the next high-impact runtime and connector gaps from the hostile loop: default chat should not silently route ordinary user prompts into the planned workflow driver, model failures should preserve their real failure category when durable final-checkpoint evidence exists, and Gmail/Google Calendar/Notion setup actions should reach the Reborn lifecycle facade instead of returning projection-only `discovered` states.

### Changed
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_reborn/src/planned_driver_factory.rs`: added `reborn-text-only-default` and made implicit interactive chat resolve to the text-only driver while preserving explicit `reborn-planned-default`.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_reborn/src/loop_exit_applier.rs`: failure evidence now verifies a durable final loop checkpoint instead of always failing closed to `driver_protocol_violation`.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_product_workflow/src/reborn_services/lifecycle_setup.rs`: setup route now dispatches typed lifecycle actions for `install`, `activate`, `auth`, `configure`, and `remove`; `begin/setup/status` remain idempotent projection/readiness checks; Google Calendar maps to lifecycle package id `google-calendar`.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/pages/extensions/lib/extensions-api.js`: install action now sends `action:"install"` instead of ambiguous `begin`.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_product_workflow/tests/reborn_services_contract.rs`: added connector lifecycle action, Calendar package-ref, and unknown-action rejection tests.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/src-tauri/binaries/ironclaw-reborn-aarch64-apple-darwin`: refreshed Reborn sidecar, final SHA `9ade9d939074040be7f8fbcab278dec937d9dbd3ccf12580c14973103eb259bf`.

### Verified
- `cargo test -p ironclaw_reborn thread_checkpoint_evidence_rejects_failure --lib`: passed.
- `cargo test -p ironclaw_reborn text_only_default_profile_resolves_to_text_only_driver --lib`: passed.
- `cargo test -p ironclaw_reborn planned_driver_explicit_profile_smoke --test planned_driver_e2e`: passed.
- `cargo test -p ironclaw_reborn_composition stub_gateway_send_cancels_recovery_required_and_releases_conversation --test runtime`: passed.
- `cargo test -p ironclaw_reborn_composition adapter_bundle_satisfies_product_live_runtime_readiness_gate --test product_live_adapters`: passed.
- `cargo test -p ironclaw_product_workflow setup_extension_action_executes_configured_lifecycle_facade --test reborn_services_contract`: passed.
- `cargo test -p ironclaw_product_workflow setup_extension_google_calendar_action_uses_lifecycle_package_id --test reborn_services_contract`: passed.
- `cargo test -p ironclaw_product_workflow setup_extension_rejects_unknown_action_before_lifecycle_execution --test reborn_services_contract`: passed.
- `node --check crates/ironclaw_webui_v2_static/static/js/pages/extensions/lib/extensions-api.js && npm run prepare:webui-static && npm run smoke:webui-static`: passed.
- `cargo build --release -p ironclaw_reborn_cli --features webui-v2-beta --bin ironclaw-reborn`: passed.
- `npm run tauri -- build`: produced the `.app`, DMG, and updater tarball; exited only because `TAURI_SIGNING_PRIVATE_KEY` is absent.
- `SMOKE_LOG_PATH=/tmp/ironclaw-packaged-smoke-connector-final-20260602-0310.log bash scripts/smoke-packaged-app.sh --wait 8 --bundle src-tauri/target/release/bundle/macos/IronClaw.app`: passed; no orphan sidecar.
- Replaced `/Applications/IronClaw.app`, relaunched, and verified live installed app PID `64433` with Reborn child PID `64448` on port `3000`.
- Live installed API: `/api/health` returned 200; `/api/gateway/status` returned `NEAR.AI / z-ai/glm-4.5`.
- Live installed connector actions: Gmail, Google Calendar, and Notion `activate` returned `phase:"active"`; Calendar returned `package_ref.id:"google-calendar"`; slash-prefixed `tools%2Fgmail` still returned `400 invalid_id`.
- Live installed idempotent setup: Gmail, Google Calendar, and Notion `begin` returned current `phase:"active"` instead of failing once already active.

### Evidence
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-connector-final-20260602-0310.log`.
- Installed sidecar checksum: `9ade9d939074040be7f8fbcab278dec937d9dbd3ccf12580c14973103eb259bf`.
- Active installed process: `/Applications/IronClaw.app/Contents/MacOS/ironclaw-desktop` PID `64433`; `/Applications/IronClaw.app/Contents/MacOS/ironclaw-reborn serve --host 127.0.0.1 --port 3000` PID `64448`.
- Connector hostile sidecar baseline evidence before fix: `/tmp/ironclaw-connector-http-evidence-20260602-021604.jsonl`.

### Still RED
- Connector OAuth/account readiness is still not fully GREEN: lifecycle install/activate is now real for Gmail/Calendar/Notion, but no real external OAuth, token refresh, or read-only provider tool call was performed.
- Duplicate explicit `install` still returns 400 once a package is already installed/active because the underlying lifecycle service refuses overwrite of materialized files. The UI must avoid showing install for active packages and use `begin`/projection for idempotent readiness.
- Work-product generation remains RED/YELLOW: file transport, run-state observability, and export controls are improved, but high-fidelity model generation from PDF/DOCX/XLSX templates inside native WebView is still not proven.
- Sync lane remains RED: desktop static source and Reborn static source still diverge.

### Risks
- The installed app state now has Gmail/Calendar/Notion active from local lifecycle probes; this is local lifecycle activation, not proof of authenticated external data access.
- The text-only default removes planned-driver over-routing for default chat, but the next pass still needs a native-WebView chat send proving assistant output rather than just failure visibility.
- Tauri updater signing still requires `TAURI_SIGNING_PRIVATE_KEY`.

### Next Agent Should Start Here
1. In the installed app, open Extensions and verify the rendered Gmail/Calendar/Notion setup drawer reflects backend `phase:"active"` from the live setup route, not localStorage-only status.
2. Add a read-only connector canary for each provider that either reaches an authenticated tool call or renders an honest credentials-needed blocker with exact backend evidence.
3. Attack the remaining work-product gate: installed native WebView sends a PDF/DOCX/XLSX fixture, preserves visible user text, receives an assistant result or precise failure, exports parseable output, reload preserves it, and quit leaves no orphan sidecar.

### Do Not Touch
- Do not reset/stash/revert dirty desktop or Reborn repo work.
- Do not perform real OAuth or external provider actions without explicit approval.
- Do not mark connectors fully connected from lifecycle `active` alone; require auth/readiness/tool-call evidence.
- Do not hide duplicate-install 400s with optimistic UI; route the UI to projection/readiness once active.

## Handoff: Phase 1.5 - Rendered Connector Truth After Lifecycle Activation

Status: YELLOW
Owner lane: Connector | Static UI | Hostile QA

### Goal
Close the rendered-app connector truth gap left by Phase 1.4. The backend lifecycle route now reports Gmail, Google Calendar, and Notion packages as `active`, but the UI must not translate package lifecycle into account connection. It must use canonical bare extension names in lifecycle URLs, keep slash-prefixed catalog refs as metadata only, render Slack as blocked, and avoid duplicate install affordances for already installed connectors.

### Changed
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/pages/extensions/lib/extensions-api.js`: separated package lifecycle `active` from account readiness. Gmail/Calendar/Notion now show `auth needed` without explicit account-readiness proof, and stored token state can show `auth saved` rather than claiming connected/ready.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/scripts/smoke-webui-static.mjs`: strengthened connector smoke so mocked lifecycle projections return `phase:"active"` and the rendered UI must still show `auth needed` before credentials/account readiness are proven.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/main.bundle.js`: regenerated via `npm run prepare:webui-static`.
- `/Applications/IronClaw.app`: replaced with the freshly built Tauri app after the static connector correction.

### Verified
- `node --check crates/ironclaw_webui_v2_static/static/js/pages/extensions/lib/extensions-api.js`: passed.
- `node --check scripts/smoke-webui-static.mjs`: passed.
- `npm run prepare:webui-static`: passed.
- `npm run smoke:webui-static`: passed, including the new anti-lie connector assertion.
- Fresh rendered live-sidecar connector proof against installed Reborn sidecar: passed with `ok:true`.
- `npm run tauri -- build`: produced the release app, DMG, and updater tarball; exited only at updater signing because `TAURI_SIGNING_PRIVATE_KEY` is absent.
- `/Applications/IronClaw.app` replaced; installed checksum now matches the freshly built executable.
- `SMOKE_LOG_PATH=/tmp/ironclaw-packaged-smoke-connector-ui-truth-20260602-0115.log bash scripts/smoke-packaged-app.sh --wait 8 --bundle /Applications/IronClaw.app`: passed; no sidecar orphan.
- Reopened `/Applications/IronClaw.app`; live `/api/health` returned 200 and the app is running with Reborn sidecar on port `3000`.
- Live installed connector sanity: Gmail, Google Calendar, and Notion `begin` return package `phase:"active"`; Slack returns `unsupported_or_legacy`; encoded `tools%2Fgmail` returns `400 invalid_id`.

### Evidence
- Rendered connector proof JSON: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/connector-live-20260602-0105/connector-live-proof.json`.
- Rendered screenshots:
  - `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/connector-live-20260602-0105/01-extensions-installed-live.png`
  - `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/connector-live-20260602-0105/02-gmail-configure-live.png`
  - `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/connector-live-20260602-0105/03-gmail-slash-deeplink-live.png`
  - `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/connector-live-20260602-0105/04-slack-slash-deeplink-live.png`
  - `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/connector-live-20260602-0105/05-extensions-registry-live.png`
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-connector-ui-truth-20260602-0115.log`.
- Installed app checksum: `ironclaw-desktop` `7152bda365216a6259eb151dbac794d878153f2e7c6e235175a346fdc13627a8`; `ironclaw-reborn` `9ade9d939074040be7f8fbcab278dec937d9dbd3ccf12580c14973103eb259bf`.
- Active installed process after reopen: `/Applications/IronClaw.app/Contents/MacOS/ironclaw-desktop` PID `68998`; `/Applications/IronClaw.app/Contents/MacOS/ironclaw-reborn serve --host 127.0.0.1 --port 3000` PID `69010`.

### Still RED
- Connector account readiness is not fully GREEN: no real OAuth flow, token refresh, or read-only Gmail/Calendar/Notion provider call was performed. The UI now says `auth needed`, which is honest.
- Work-product end-to-end remains RED: the sidecar audit still points to the live file-backed turn where attachment payload persisted but no assistant/work-product result or export controls appeared.
- Native macOS WebView automation remains YELLOW/RED in this environment; static Chromium plus live sidecar and packaged smoke are proven, but not direct native UI click automation.
- Sync lane remains RED: static source is still a desktop-local copy until upstream reconciliation is done.

### Risks
- `payload.catalog_ref` still contains slash-prefixed refs by design; the lifecycle URL never does. Future tests must distinguish catalog metadata from `ExtensionName`.
- A future backend may add explicit `account_ready`/`credential_ready`/readiness fields. Until then, account connectors should not show `active` from lifecycle package state alone.
- Tauri updater signing still needs `TAURI_SIGNING_PRIVATE_KEY`.

### Next Agent Should Start Here
1. Inspect `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/connector-live-20260602-0105/connector-live-proof.json`.
2. Continue with Work Product lane: reproduce the live file-backed failure from `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/heartbeat-native-and-live-workproduct-red.json`.
3. Acceptance gate: installed/static UI sends a PDF/DOCX/XLSX fixture, receives either a useful assistant/work-product result or immediate truthful failure, export buttons appear only for real output, downloaded files parse, reload preserves the result.

### Do Not Touch
- Do not reset/stash/revert dirty desktop or Reborn repo work.
- Do not perform real external OAuth or provider actions without explicit approval.
- Do not mark Gmail/Calendar/Notion connected from lifecycle `phase:"active"` alone.
- Do not treat catalog refs in `payload.catalog_ref` as a lifecycle `ExtensionName` violation; only route/path names are lifecycle names.

## Handoff: Phase 1.6 - Work Product Attachment Context and Live Driver RED

Status: RED
Owner lane: Work Product | Runtime | Hostile QA

### Goal
Close the fake-proof gap where file attachments reached WebChat but were persisted as opaque base64 text and then produced no assistant/work-product output. The phase goal was to prove, in tests and in the installed app, whether an attached file becomes useful model-visible context, whether default chat still routes to the text-only profile, and whether live generation/export can honestly be marked green.

### Changed
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_product_workflow/Cargo.toml`: added `base64` for bounded attachment decoding.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_product_workflow/src/webui_inbound.rs`: replaced raw `data_base64` transcript dumping with bounded attachment normalization. Text/CSV/JSON/XML/YAML-style payloads now write extracted UTF-8 context, unsupported binaries write `unsupported_binary`, invalid/missing bytes write explicit statuses, and raw base64 is not included in model-visible content.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_product_workflow/tests/webui_inbound_contract.rs`: added/updated attachment tests for static CSV extraction, legacy aliases, PDF/XLSX unsupported-binary status, blank-field rejection, and too-many-attachments rejection.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_product_workflow/tests/reborn_services_contract.rs`: added a contract proving extracted attachment context persists in submitted user message content without raw base64.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_reborn_composition/tests/webui_v2_e2e.rs`: replaced the stale implicit-default `builtin.echo` e2e with a real WebChat v2 default text-path test. It creates a thread, sends a CSV attachment, asserts `reborn-text-only-default`, proves the model request sees extracted CSV text and no raw base64, and polls timeline for the assistant reply.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/src-tauri/binaries/ironclaw-reborn-aarch64-apple-darwin`: refreshed with the rebuilt Reborn sidecar SHA `935a770920fa67096384020d890541a3500c68493f0a826c911e994f7b78b366`.
- `/Applications/IronClaw.app`: replaced with the rebuilt Tauri app and reopened with the refreshed Reborn sidecar.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/workproduct-installed-installed-wp-20260602013007/*`: captured installed-app live API evidence for the file-backed run.

### Verified
- `cargo fmt -p ironclaw_reborn_composition -p ironclaw_product_workflow`: passed.
- `cargo test -p ironclaw_product_workflow --test webui_inbound_contract`: passed, 22 tests.
- `cargo test -p ironclaw_product_workflow submit_turn_persists_extracted_webui_attachment_context_in_user_message_content --test reborn_services_contract -- --exact`: passed.
- `cargo test -p ironclaw_reborn_composition --features webui-v2-beta,test-support webui_v2_http_default_text_path_with_attachment_context --test webui_v2_e2e -- --exact`: passed.
- `cargo build --release -p ironclaw_reborn_cli --features webui-v2-beta --bin ironclaw-reborn`: passed.
- `npm run tauri -- build`: built release binary, `.app`, DMG, and updater tarball; exited nonzero only at updater signing because `TAURI_SIGNING_PRIVATE_KEY` is absent.
- `SMOKE_LOG_PATH=/tmp/ironclaw-packaged-smoke-workproduct-context-20260602-032741.log bash scripts/smoke-packaged-app.sh --wait 8 --bundle src-tauri/target/release/bundle/macos/IronClaw.app`: passed; sidecar started on fallback port `3100` and left no orphan.
- `npm run smoke:webui-static`: passed after the rebuilt static bundle was prepared by the Tauri build.
- Installed app deploy proof: `/Applications/IronClaw.app/Contents/MacOS/ironclaw-reborn` SHA `935a770920fa67096384020d890541a3500c68493f0a826c911e994f7b78b366`; `/Applications/IronClaw.app/Contents/MacOS/ironclaw-desktop` SHA `7152bda365216a6259eb151dbac794d878153f2e7c6e235175a346fdc13627a8`.
- Installed sidecar health: `GET http://127.0.0.1:3000/api/health` returned 200 `{"channel":"webui-v2","status":"ok"}`; `GET /api/gateway/status` returned 200 with `llm_backend:"NEAR.AI"` and `llm_model:"z-ai/glm-4.5"`.
- Installed live work-product probe: authenticated `POST /api/webchat/v2/threads`, then `POST /api/webchat/v2/threads/{thread}/messages` with a CSV attachment. Response returned 200 and `resolved_run_profile_id:"reborn-text-only-default"`. Timeline user content included `extraction_status: extracted_text` and CSV row `Acme-installed-wp-20260602013007,Closing`, and did not include raw base64 or `data_base64:`.

### Evidence
- Installed live proof JSON: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/workproduct-installed-installed-wp-20260602013007/proof.json`.
- Installed live run state: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/workproduct-installed-installed-wp-20260602013007/run.json`.
- Installed live timeline: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/workproduct-installed-installed-wp-20260602013007/timeline.json`.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-workproduct-context-20260602-032741.log`.
- Active installed process after deploy: `/Applications/IronClaw.app/Contents/MacOS/ironclaw-desktop` PID `80132`; child `/Applications/IronClaw.app/Contents/MacOS/ironclaw-reborn serve --host 127.0.0.1 --port 3000` PID `80138`.

### Still RED
- Live work-product generation is still RED. The installed run `ebf1a2ed-edd8-4103-8915-d3d9384e9424` failed with `failure.category:"driver_unavailable"`, produced no assistant message, and therefore produced no exportable DOCX/PDF/XLSX/CSV/JSON/PPTX work product.
- `/api/gateway/status` is YELLOW/RED as a readiness signal: it reports the configured/default NEAR.AI model selection, but it does not prove that the runtime has a usable provider gateway or credentials. The live run failure proves status can look healthy while generation is unavailable.
- Native WebView interaction remains YELLOW: the installed app is open and the installed sidecar/API were tested, but this pass used authenticated installed API probes rather than direct macOS WebView clicks.
- Runtime cleanup is still YELLOW: quitting the installed app left an orphaned Reborn child on port `3000`; it was terminated before redeploy, but the app-exit cleanup needs a focused regression.
- Binary file understanding remains RED: PDF/DOCX/XLSX/PPTX payloads are now honestly marked `unsupported_binary` server-side instead of leaked as base64, but they are not extracted or used for high-fidelity drafting yet.

### Risks
- The visible model label can still overpromise. Until provider readiness is tied to runtime LLM construction and/or a safe model ping, the UI must not present `NEAR.AI / z-ai/glm-4.5` as proof that chat will work.
- `driver_unavailable` is too coarse for users. The next patch should expose a safe failure reason such as missing provider config, missing/expired NEAR session, network/provider failure, or model route unavailable.
- The desktop and Reborn repositories remain heavily dirty with multiple agent lanes; do not broad-sync or clean generated files.
- Tauri updater signing still requires `TAURI_SIGNING_PRIVATE_KEY`.

### Next Agent Should Start Here
1. Inspect `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/workproduct-installed-installed-wp-20260602013007/proof.json` and `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/workproduct-installed-installed-wp-20260602013007/run.json`.
2. Patch runtime/gateway truth: make `/api/gateway/status` report provider readiness from actual `ResolvedRebornLlm` / runtime gateway state, and make run-state failure include a safe diagnostic for why `driver_unavailable` happened.
3. Acceptance gate: installed `/Applications/IronClaw.app` sends a CSV/text fixture and gets an assistant reply; unsupported PDF/DOCX/XLSX fixtures render an immediate truthful unsupported-file state or are extracted by real parsers; exported artifacts only appear after real output and parse successfully.

### Do Not Touch
- Do not reset/stash/revert dirty desktop or Reborn repo work.
- Do not claim work-product generation is fixed from attachment extraction alone.
- Do not leak NEAR session tokens or gateway bearer tokens into docs/logs.
- Do not perform real external provider actions beyond safe local/localhost probes without explicit approval.
- Do not hide `driver_unavailable` behind generic chat copy; surface the exact safe blocker.

## Handoff: Phase 1.7 - Model Readiness Truth and Visible Provider Failure

Status: RED
Owner lane: Runtime | Static UI | Hostile QA

### Goal
Stop the installed desktop app from presenting configured model selection as proof that chat/work-product generation can execute. Gateway status now reports provider/model configuration as unverified until a successful WebChat run proves execution, model-stage driver failures are classified as `model_unavailable`, and the static UI renders configured/unverified model copy plus plain visible failure text.

### Changed
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_reborn_composition/src/webui_serve.rs`: added `model_execution_verified:false`, `model_readiness:"unverified"`, config-source fields, and a readiness reason to `/api/gateway/status`.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_reborn_composition/tests/webui_v2_serve.rs`: strengthened the public gateway-status probe so configuration-only status cannot masquerade as execution readiness.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_reborn/src/turn_runner.rs`: maps unavailable driver errors from the model/system-inference stage to sanitized failure category `model_unavailable`; other unavailable driver stages remain `driver_unavailable`.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_reborn/src/turn_runner/tests/mod.rs`: added focused category and runner failure tests for model-stage unavailability.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_reborn_composition/src/projection/turn_events.rs`: added user-facing summary for `model_unavailable`.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_reborn_composition/src/projection.rs`: added runtime projection summary for `model_unavailable`.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/lib/model-readiness.js`: added static UI readiness presenter; only explicit verified/GREEN fields mark model execution verified.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/pages/chat/components/chat-input.js`: model pill now says configured/unverified unless the gateway proves execution readiness.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/pages/settings/components/inference-tab.js`: settings model status now distinguishes execution verified from configured/unverified.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/failureMessages.js`: maps `driver_unavailable` and `model_unavailable` to plain visible chat failure copy.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/pages/chat/hooks/useChat.js`: send-message API failures use the safe failure-copy mapper.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/scripts/smoke-webui-static.mjs`: added rendered smoke assertions for configured/unverified model copy and unavailable-driver error bubble.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/src-tauri/binaries/ironclaw-reborn-aarch64-apple-darwin`: refreshed with Reborn sidecar SHA `36916c14ab362cba0d9ba129c2bb40f02787dd06043ff5e25935041f769c6a92`.
- `/Applications/IronClaw.app`: replaced with the rebuilt package containing the refreshed sidecar and static UI.

### Verified
- `cargo fmt -p ironclaw_reborn -p ironclaw_reborn_composition`: passed.
- `cargo test -p ironclaw_reborn turn_runner::tests::unavailable_driver_failure_category_classifies_model_stage --lib -- --exact`: passed.
- `cargo test -p ironclaw_reborn turn_runner::tests::worker_records_model_unavailable_for_model_driver_unavailable --lib -- --exact`: passed.
- `cargo test -p ironclaw_reborn_composition --features webui-v2-beta gateway_probe_routes_are_public_and_report_v2_status --test webui_v2_serve -- --exact`: passed.
- `node --test crates/ironclaw_webui_v2_static/static/js/lib/model-readiness.test.mjs crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/failureMessages.test.mjs`: passed, 11/11.
- `npm run smoke:webui-static`: passed, including configured/unverified model copy and visible unavailable-failure assertions.
- `cargo build --release -p ironclaw_reborn_cli --features webui-v2-beta --bin ironclaw-reborn`: passed.
- `npm run tauri -- build`: produced release `.app`, DMG, and updater tarball; exited nonzero only because `TAURI_SIGNING_PRIVATE_KEY` is absent.
- `SMOKE_LOG_PATH=/tmp/ironclaw-packaged-smoke-final-static-status-20260602-035238.log bash scripts/smoke-packaged-app.sh --wait 8 --bundle src-tauri/target/release/bundle/macos/IronClaw.app`: passed; sidecar started and left no orphan.
- Installed `/Applications/IronClaw.app` relaunched on port `3000`; `GET /api/gateway/status` now returns `model_execution_verified:false`, `model_readiness:"unverified"`, and the configuration-only readiness reason.
- Installed live WebChat API probe created a thread, sent a CSV attachment, persisted extracted CSV text without raw base64, resolved to `reborn-text-only-default`, and failed with `failure.category:"model_unavailable"`.

### Evidence
- Installed live proof JSON: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/status-truth-status-truth-1780365054058/proof.json`.
- Installed live run state: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/status-truth-status-truth-1780365054058/run.json`.
- Installed live timeline: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/status-truth-status-truth-1780365054058/timeline.json`.
- Static UI screenshots from smoke:
  - `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/static-work-product-attachment-chat.png`
  - `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/static-run-state-failure-visible.png`
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-final-static-status-20260602-035238.log`.
- Installed hashes: `ironclaw-reborn` `36916c14ab362cba0d9ba129c2bb40f02787dd06043ff5e25935041f769c6a92`; `ironclaw-desktop` `2f4d1fccaf1a6419a16ff80cba069f43221e9a3ec7e480f6d676126402b6c7cb`.
- Active installed process after relaunch: `/Applications/IronClaw.app/Contents/MacOS/ironclaw-desktop` PID `87375`; child `/Applications/IronClaw.app/Contents/MacOS/ironclaw-reborn serve --host 127.0.0.1 --port 3000` PID `87389`.

### Still RED
- Live chat/work-product generation is still RED. Installed run `8728bed8-bb06-4546-a600-a5227ff082b1` failed with `failure.category:"model_unavailable"` and produced no assistant message or exportable work product.
- Provider readiness remains unverified. `/api/gateway/status` is now honest configuration status, not a model ping or credential check.
- Native macOS WebView click-through remains YELLOW: static rendered smoke and installed local API probes are proven, but this pass did not automate a direct native WebView send.
- Runtime cleanup remains YELLOW: the prior installed app quit still left its sidecar orphaned; this pass terminated that exact orphan before deploy and packaged smoke proves clean shutdown for the newly built bundle.

### Risks
- The UI readiness helper supports explicit `model_execution_verified:true` and common GREEN readiness fields; if runtime later uses a new field name, add one mapping rather than changing copy semantics.
- Real provider execution may require NEAR session/credentials/model-route work outside this phase. Do not flip readiness to GREEN until a successful installed WebChat run proves it.
- Tauri updater signing still requires `TAURI_SIGNING_PRIVATE_KEY`.
- Reborn and desktop trees remain heavily dirty with active multi-agent work; do not broad-sync or clean.

### Next Agent Should Start Here
1. `cd /Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop && cat output/playwright/status-truth-status-truth-1780365054058/proof.json`
2. Reproduce the installed RED with a token-safe `POST /api/webchat/v2/threads/{thread_id}/messages` probe and confirm `failure.category:"model_unavailable"`.
3. Acceptance gate: fix the actual model provider/session route so an installed WebChat run completes with an assistant message; only then set `model_execution_verified:true` or equivalent GREEN readiness and prove exports parse/reload.

### Do Not Touch
- Do not reset/stash/revert dirty desktop or Reborn repo work.
- Do not print or persist gateway bearer tokens, NEAR session tokens, or provider secrets.
- Do not mark model execution verified from env/default config alone.
- Do not claim work-product generation is fixed until installed chat produces assistant output and parseable exports.
- Do not perform real external provider/OAuth actions without explicit approval.

## Handoff: Phase 1.8 - Provider Plan-Denial Truth and Static Shell Fix

Status: YELLOW
Owner lane: Runtime | Static UI | Hostile QA

### Goal
Preserve the actual NEAR provider outcome through Reborn and the static chat UI so the installed app no longer collapses a plan-denied model into vague "disconnected" or "model unavailable" copy. This phase also removed stale static-shell CDN/dead CSS references that were creating rendered console errors.

### Changed
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_llm/src/nearai_chat.rs`: mapped NEAR model plan/route denials on 400/403/404 to `LlmError::ModelNotAvailable` with the requested model attached.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_reborn/src/model_gateway.rs`: mapped session-renewal failure to `CredentialUnavailable` instead of policy denial.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_reborn/src/text_loop_driver.rs`: preserved host `PolicyDenied` as `policy_denied` and `CredentialUnavailable` as `model_credentials_unavailable`.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_reborn/src/turn_runner.rs`: allowlisted `model_credentials_unavailable` and `policy_denied` so run state carries precise failure categories.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_reborn_composition/src/projection.rs`: added user-facing summaries for model credential and model policy-denial categories.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_reborn_composition/src/projection/turn_events.rs`: added timeline summaries for model failure, credential failure, and model policy denial.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_webui_v2_static/static/index.html`: removed CDN/importmap/browser Tailwind/dead design-token stylesheet references and pointed the shell at bundled local assets.
- `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/failureMessages.js`: added specific static WebChat copy for provider credential failures and model plan denial.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/failureMessages.js`: mirrored the static failure-copy mapping and fixed ordering so `model_credentials_unavailable` is not swallowed by generic unavailable matching.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/src-tauri/binaries/ironclaw-reborn-aarch64-apple-darwin`: refreshed sidecar to SHA `e6e4c578e1035735000438d71a2ce82dc1930467a2ebf37131bd1ef322917e5b`.
- `/Applications/IronClaw.app/Contents/MacOS/ironclaw-reborn`: refreshed installed sidecar to SHA `e6e4c578e1035735000438d71a2ce82dc1930467a2ebf37131bd1ef322917e5b` and relaunched the installed app.

### Verified
- `cargo fmt -p ironclaw_llm -p ironclaw_reborn -p ironclaw_reborn_composition`: passed.
- `cargo test -p ironclaw_llm nearai_plan_denial_is_model_not_available_response --lib`: passed.
- `cargo test -p ironclaw_reborn text_loop_driver::tests --lib`: passed, 3/3.
- `cargo test -p ironclaw_reborn turn_runner::tests --lib`: passed, 22/22.
- `cargo test -p ironclaw_reborn --features root-llm-provider --test llm_gateway gateway_maps_`: passed, 3/3.
- `cargo test -p ironclaw_reborn_composition projection::turn_events::tests::failure_summary_names_model_plan_and_credential_categories --lib --features webui-v2-beta`: passed.
- `node --test crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/failureMessages.test.mjs` in the Reborn source repo: passed, 7/7.
- `node --test crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/failureMessages.test.mjs` in the desktop repo: passed, 9/9.
- `npm run prepare:webui-static`: passed.
- `npm run smoke:webui-static`: passed, including desktop bootstrap smoke.
- `cargo build --release -p ironclaw_reborn_cli --features webui-v2-beta --bin ironclaw-reborn`: passed.
- Installed rendered WebChat smoke through `http://127.0.0.1:3000/v2/chat`: user text visible, policy-denial copy visible, no generic missing-reply fallback, no `model_unavailable` copy, no console errors, and no external static requests.

### Evidence
- Rendered screenshot: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/final-render-policy-1780367973310/chat-policy-denial.png`.
- Render proof JSON: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/final-render-policy-1780367973310/render-proof.json`.
- Installed API proof JSON: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/plan-denial-1780367648827/proof.json`.
- Installed status route now reports `llm_backend:"NEAR.AI"`, `llm_model:"z-ai/glm-4.5"`, `model_execution_verified:false`, and `model_readiness:"unverified"`.
- Active installed processes after relaunch: `/Applications/IronClaw.app/Contents/MacOS/ironclaw-desktop` PID `1312`; child `/Applications/IronClaw.app/Contents/MacOS/ironclaw-reborn serve --host 127.0.0.1 --port 3000` PID `1319`.
- Installed and desktop sidecar hashes both equal `e6e4c578e1035735000438d71a2ce82dc1930467a2ebf37131bd1ef322917e5b`.

### Still RED
- Live chat/work-product generation is still RED for the selected `NEAR.AI / z-ai/glm-4.5` model because the active NEAR account returns 403: the model is not available in the current `starter` plan.
- Model selector is not yet execution-proof. It still lets a user pick or keep a configured model without proving that the account can run it.
- Work-product generation remains blocked until a runnable provider/model is selected or account credentials/plan are changed.
- The rendered UI currently waits for the run-state failure after the timeline polling window; next phase should poll run state earlier after send.
- One rendered body preview contained the user prompt twice; if manual WebView reproduces this, fix pending-message/composer clearing.

### Risks
- Do not silently replace GLM with another default unless a live probe proves that replacement can execute under the active account.
- Reborn and desktop trees are both heavily dirty with multi-agent work; broad sync or cleanup could overwrite unrelated agent changes.
- Provider catalog probes can be flaky; a successful model-list response is not execution proof.
- Static failure copy now names plan denial accurately, but it does not by itself make chat capable of answering.

### Next Agent Should Start Here
1. `cd /Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop && cat output/playwright/final-render-policy-1780367973310/render-proof.json`
2. Add an execution-proof model probe or selector flow that records whether the active provider/model can complete a tiny safe request without leaking secrets.
3. Acceptance gate: installed app WebChat blocks or clearly warns before send when the selected model is plan-denied, and a successful installed WebChat run with a runnable model produces an assistant message before work-product/export tests continue.

### Do Not Touch
- Do not reset/stash/revert dirty desktop or Reborn repo work.
- Do not print or persist gateway bearer tokens, NEAR session tokens, or provider secrets.
- Do not mark model execution verified from `/api/gateway/status` configuration alone.
- Do not claim chat or work-product generation is GREEN while `NEAR.AI / z-ai/glm-4.5` remains plan-denied.
- Do not perform real connector/OAuth/provider actions beyond safe local and read-only capability probes without explicit approval.

## Handoff: Phase 1.9 - Native Window False-Green Gate

Status: RED
Owner lane: Runtime | Hostile QA

### Goal
Stop treating packaged process liveness and sidecar health as proof that IronClaw Desktop actually launched. This phase tightened the packaged smoke gate so a bundle with a healthy Reborn sidecar but zero native macOS windows now fails, then attempted and rejected several runtime-window fixes because they did not produce a visible WebView.

### Changed
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/scripts/smoke-packaged-app.sh`: added a System Events native-window count for the launched app PID and fail the smoke when the app process and sidecar are alive but the native window count is below 1.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/src-tauri/src/lib.rs`: no lasting new runtime-window experiment from this pass; failed sidecar/external-window attempts were removed before handoff.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/src-tauri/tauri.conf.json`: no lasting new runtime-window experiment from this pass; failed manual-window config changes were removed before handoff.

### Verified
- `cargo fmt --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml`: passed after cleanup.
- `bash -n scripts/smoke-packaged-app.sh`: passed.
- `SMOKE_LOG_PATH=/tmp/ironclaw-packaged-window-before-fix-20260602-050232.log bash scripts/smoke-packaged-app.sh --wait 4 --bundle src-tauri/target/release/bundle/macos/IronClaw.app`: failed correctly with `packaged app process and sidecar are alive, but no native app window is visible`.
- `SMOKE_LOG_PATH=/tmp/ironclaw-packaged-window-after-fix-20260602-050354.log bash scripts/smoke-packaged-app.sh --wait 8 --bundle src-tauri/target/release/bundle/macos/IronClaw.app`: failed correctly with the same zero-window gate after a rebuilt bundle.
- `open -n /Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/src-tauri/target/release/bundle/macos/IronClaw.app` plus System Events probe: sidecar healthy on port 3000, but `IronClaw: windows=0` and `ironclaw-desktop: windows=0`.
- Foreground logged release runs showed `web content process terminated` immediately after Tauri attempted to create the WebView. This reproduced for the embedded custom-protocol window, a manually-created embedded window, and a sidecar-served external `http://127.0.0.1:3000/v2/chat?token=...` window.

### Evidence
- Packaged smoke app log: `/tmp/ironclaw-packaged-window-before-fix-20260602-050232.log`.
- Packaged smoke app log: `/tmp/ironclaw-packaged-window-after-fix-20260602-050354.log`.
- LaunchServices screenshot showing no visible app window: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/launchservices-window-1780369508/fresh-bundle-launch.png`.
- Main-thread sidecar-window screenshot showing no visible app window: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/playwright/native-window-current/main-thread-sidecar.png`.
- Live sidecar proof during the RED probe: `GET http://127.0.0.1:3000/api/health` returned `{"channel":"webui-v2","status":"ok"}` and `/api/gateway/status` reported `llm_backend:"NEAR.AI"`, `llm_model:"z-ai/glm-4.5"`, `model_execution_verified:false`.
- Cleanup proof: `ps -axo pid,ppid,command | rg 'ironclaw-desktop|ironclaw-reborn serve|IronClaw.app/Contents/MacOS'` returned no app/sidecar processes after the probe.

### Still RED
- Native macOS packaged UI is not usable in this session: the process and sidecar can be alive while System Events reports zero app windows and screenshots are black.
- The strongest repro is a foreground run of `src-tauri/target/release/ironclaw-desktop` with `RUST_LOG='ironclaw_desktop_lib=debug,ironclaw_window=debug,ironclaw_sidecar=info,tauri_runtime_wry=debug'`; it logs `web content process terminated` immediately after WebView creation.
- Chat send, model selector, attachments, connectors, and work-product export cannot be called GREEN in the packaged native app until the window exists and is clickable.

### Risks
- Prior packaged smoke passes in this doc are now known to be insufficient because they did not assert a user-visible native window.
- The WebKit termination may be Tauri/Wry/macOS runtime specific; do not paper over it by opening Chromium/Safari and calling that desktop proof.
- The static Chromium sidecar tests remain useful product evidence, but they are not a replacement for the packaged native WebView gauntlet.

### Next Agent Should Start Here
1. `cd /Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop && RUST_LOG='ironclaw_desktop_lib=debug,ironclaw_window=debug,ironclaw_sidecar=info,tauri_runtime_wry=debug' src-tauri/target/release/ironclaw-desktop`
2. Reproduce `web content process terminated` and `System Events` zero-window count before changing connector/chat/work-product behavior.
3. Acceptance gate: `bash scripts/smoke-packaged-app.sh --wait 8 --bundle src-tauri/target/release/bundle/macos/IronClaw.app` passes with `native app window count: 1` or higher, then LaunchServices `/Applications/IronClaw.app` shows a visible, screenshot-proven WebView.

### Do Not Touch
- Do not reset/stash/revert dirty desktop or Reborn repo work.
- Do not claim packaged app smoke is GREEN unless the new native-window count gate passes.
- Do not continue user-facing connector/chat/work-product claims from native app until the WebView exists and is visible.
- Do not print or persist gateway bearer tokens, NEAR session tokens, or provider secrets.

## Handoff: Phase 1.10 - CoreGraphics Native Window Gate

Status: YELLOW
Owner lane: Runtime | Hostile QA

### Goal
Replace the false-negative packaged native-window gate with a macOS window proof that can see Tauri/WKWebView windows in this environment, while keeping the stricter requirement that process liveness and sidecar health alone are not enough. Also remove the fragile transparent/vibrancy/private-API chrome path until the shipped WebView proves basic rendering and interaction.

### Changed
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/src-tauri/tauri.conf.json`: enabled `app.withGlobalTauri` so the static WebUI can use `window.__TAURI__`, and simplified the main window to a plain opaque resizable window.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/src-tauri/Cargo.toml`: removed the `macos-private-api` Tauri feature and removed the unused macOS-only `window-vibrancy` dependency.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/src-tauri/src/lib.rs`: removed setup-time vibrancy application from the main window and kept explicit show/focus plus WebContent termination logging/reload.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/scripts/smoke-packaged-app.sh`: changed native window detection from System Events as primary proof to CoreGraphics/Swift layer-0 window enumeration, with System Events only as fallback.

### Verified
- `bash -n scripts/smoke-packaged-app.sh`: passed.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `npm run tauri -- build --bundles app`: produced `src-tauri/target/release/bundle/macos/IronClaw.app`; command still exits nonzero at updater signing because `TAURI_SIGNING_PRIVATE_KEY` is not set locally.
- `SMOKE_LOG_PATH=/tmp/ironclaw-packaged-smoke-cgwindow-20260602.log RUST_LOG='ironclaw_desktop_lib=debug,ironclaw_window=debug,ironclaw_sidecar=info,tauri_runtime_wry=debug,ironclaw_diag=info' bash scripts/smoke-packaged-app.sh --wait 12 --bundle src-tauri/target/release/bundle/macos/IronClaw.app`: passed.
- `npm run smoke:webui-static`: passed.
- Live CoreGraphics probe during app launch found two windows for the app PID while System Events still reported zero windows, proving the previous gate was using the wrong macOS oracle.

### Evidence
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-cgwindow-20260602.log`.
- Live CoreGraphics probe log: `/tmp/ironclaw-cgwindow-probe-1780371840.log`.
- Prior false-negative packaged smoke log: `/tmp/ironclaw-packaged-smoke-plain-window-20260602.log`.
- Current package smoke output included `native app window count: 2`, `Reborn gateway healthy on port 3000`, `terminated cleanly`, and `Reborn sidecar pid(s) after termination: none`.
- Static bootstrap proof: `PASS webui static desktop bootstrap smoke`.

### Still RED
- Chat send/model selector/attachments/connectors/work-product export are still not proven through the packaged native WebView after this runtime gate.
- The current macOS screenshot captures are black in this automation session, so screenshot evidence is not a reliable native-window oracle here; use CGWindow for window existence and browser/Playwright/sidecar render checks for UI behavior unless a manual packaged-app smoke is available.
- `System Events` reports `windows=0` for this Tauri process even when CoreGraphics sees two layer-0 windows; do not reintroduce System Events as the primary native-window gate.
- The model path remains only truthfully unverified/blocked unless a runnable model can complete a safe live request.

### Risks
- Removing transparent/vibrant chrome may regress the intended visual polish, but it is a deliberate trade until the app can pass core desktop behavior reliably.
- `withGlobalTauri` is required by the static UI's current API bridge; if the static bridge is later rewritten to use bundled module imports, revisit this.
- The bundle build still cannot complete updater artifact signing without `TAURI_SIGNING_PRIVATE_KEY`; local `.app` smoke remains valid, release signing remains unproven.

### Next Agent Should Start Here
1. `cd /Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop && SMOKE_LOG_PATH=/tmp/ironclaw-next-packaged-smoke-$(date +%Y%m%d-%H%M%S).log bash scripts/smoke-packaged-app.sh --wait 12 --bundle src-tauri/target/release/bundle/macos/IronClaw.app`
2. Start the next Hostile QA pass from rendered chat behavior, not process liveness: prove user text stays visible after send, assistant result renders, model selector state is actionable/truthful, and attachment picker/paste/drop payload reaches Reborn.
3. Acceptance gate: no connector/work-product claim can move out of RED until rendered UI or packaged manual smoke proves the exact user-visible flow.

### Do Not Touch
- Do not reset/stash/revert dirty desktop or Reborn repo work.
- Do not restore `macos-private-api`, transparent main windows, or vibrancy until the opaque native app passes the chat/work-product gauntlet.
- Do not use System Events window count as the primary packaged native-window proof.
- Do not claim chat, connectors, or work-product generation are GREEN from this runtime smoke alone.

## Handoff: Phase 1.11 - Rendered Chat Connector Work-Product Gauntlet

Status: YELLOW
Owner lane: Hostile QA | Connector | Work Product

### Goal
Run the focused rendered browser gauntlet for the exact user-visible failures reported in this thread: chat messages disappearing, attachments not reaching the agent, connector setup leaking slash-prefixed catalog refs into lifecycle calls, and work-product output being trapped as unusable chat text instead of copyable/exportable artifacts.

### Changed
- No code changed in this phase. This phase collected focused rendered-app evidence against the current dirty tree after the runtime package smoke became trustworthy.

### Verified
- `npx playwright test tests/e2e/chat.spec.ts tests/e2e/extensions-reborn.spec.ts tests/e2e/file-generation-export.spec.ts tests/e2e/service-agreement-generation.spec.ts tests/e2e/work-product-actions.spec.ts --reporter=line`: passed, 48/48.
- The passing set includes chat send visibility, lagging-timeline sent-message preservation, preexisting/deep-linked threads, attachment picker payloads, dropped-file payloads, PDF/DOCX/CSV/JSON/XLSX/Markdown template prompts staying in chat, connector setup normalization for Gmail/Google Calendar/Notion/Slack, OAuth/device-login and auth_url handoff behavior, service-agreement generation from uploaded PDF template, and DOCX/PDF/HTML/Markdown/JSON export controls.

### Evidence
- Command result: `48 passed (25.4s)`.
- Test files exercised:
  - `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/tests/e2e/chat.spec.ts`
  - `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/tests/e2e/extensions-reborn.spec.ts`
  - `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/tests/e2e/file-generation-export.spec.ts`
  - `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/tests/e2e/service-agreement-generation.spec.ts`
  - `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/tests/e2e/work-product-actions.spec.ts`

### Still RED
- These rendered tests use the browser/Tauri shim and mocked gateway routes; they are not live connector OAuth proof and not native WKWebView interaction proof.
- The packaged native app still needs a manual or automatable click-through smoke for chat send/model selector/attachments once the macOS session can provide reliable visual/screenshot evidence.
- Live Gmail/Calendar/Notion connector auth remains blocked until Product Auth/OAuth routes are tested with real backend responses and without performing unauthorized external actions.

### Risks
- The tests prove UI contracts and request payloads, not provider execution quality. A plan-denied or unrunnable model can still make live work-product generation fail truthfully.
- The service-agreement PDF scenario is covered by mocked assistant output/export parsing; it does not prove the live model can preserve every clause from a real production PDF yet.
- Browser e2e evidence is necessary but not sufficient for the packaged WebView gauntlet.

### Next Agent Should Start Here
1. `cd /Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop && npx playwright test tests/e2e/command-palette-connectors.spec.ts tests/e2e/global-search.spec.ts tests/e2e/onboarding.spec.ts tests/e2e/dashboard.spec.ts tests/e2e/work.spec.ts --reporter=line`
2. Add live route-contract probes for Product Auth connector setup without taking real external actions; verify unsupported/needs-auth state is rendered honestly.
3. Acceptance gate: connector status cannot be GREEN until captured lifecycle/readiness/setup routes prove the UI never sends `tools/gmail`, `tools/google_calendar`, `channels/slack`, or `mcp-servers/notion` as lifecycle `ExtensionName`.

### Do Not Touch
- Do not replace these mocked rendered tests with API curls; keep both UI and route assertions.
- Do not mark live connectors connected from mocked e2e results.
- Do not claim service-agreement generation is live-model complete from this mocked PDF-template test alone.

## Handoff: Phase 1.12 - Full Rendered Gauntlet and Connector Configure Fix

Status: YELLOW
Owner lane: Hostile QA | Connector | Work Product | Runtime

### Goal
Close the next overnight loop by proving the rendered browser gauntlet beyond the focused chat/export subset, fixing any regressions it exposed, and resolving the connector sidecar's concrete lifecycle-action RED so static connector setup no longer sends a Reborn-unsupported `submit` action.

### Changed
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/tests/e2e/onboarding.spec.ts`: updated stale onboarding copy assertions to the current rendered first-run contract: `Connect, brief, approve` and `Step 1 - connect a runner`.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/src/routes/chat/+page.svelte`: restored action-oriented accessible labels/titles for the voice-answer toggle: `Voice answer off - click to turn on` and `Voice answer on - click to turn off`.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/pages/extensions/lib/extensions-api.js`: changed credential projection from lifecycle `action: "submit"` to Reborn-supported `action: "configure"` for stored-token refresh, new manual-token save, and direct setup projection.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/main.bundle.js`: regenerated/mechanically updated the packaged static bundle so shipped static UI also sends `configure`.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/scripts/smoke-webui-static.mjs`: added backend-style rejection for lifecycle `submit`, asserts Gmail setup includes a `configure` lifecycle request, and verifies the lifecycle payload carries `credential-google-smoke`.

### Verified
- `npx playwright test tests/e2e/onboarding.spec.ts --reporter=line`: passed, 1/1 after updating stale copy contract.
- `npx playwright test tests/e2e/voice-answer.spec.ts --reporter=line`: passed, 1/1 after restoring action-oriented accessible label.
- `npx playwright test tests/e2e/command-palette-connectors.spec.ts tests/e2e/global-search.spec.ts tests/e2e/onboarding.spec.ts tests/e2e/dashboard.spec.ts tests/e2e/work.spec.ts tests/e2e/desk-generated-missions.spec.ts tests/e2e/omnibar.spec.ts --reporter=line`: passed, 14/14.
- `npx playwright test tests/e2e/a11y.spec.ts --reporter=line`: passed, 16/16.
- `CI=1 npx playwright test --reporter=line`: passed, 91/91 runnable tests with 10 intentionally skipped.
- `npm run check`: passed with `svelte-check found 0 errors and 0 warnings`.
- `npx vitest run`: passed, 160/160 test files and 1285/1285 tests.
- `node --check scripts/smoke-webui-static.mjs && node --check crates/ironclaw_webui_v2_static/static/js/pages/extensions/lib/extensions-api.js && node --check crates/ironclaw_webui_v2_static/static/js/main.bundle.js`: passed.
- `npm run smoke:webui-static`: passed after the `configure` assertion was added.
- `npm run tauri -- build --bundles app`: produced `src-tauri/target/release/bundle/macos/IronClaw.app`; still exits nonzero at updater signing because `TAURI_SIGNING_PRIVATE_KEY` is not set.
- `SMOKE_LOG_PATH=/tmp/ironclaw-packaged-smoke-after-connector-configure-20260602.log RUST_LOG='ironclaw_desktop_lib=debug,ironclaw_window=debug,ironclaw_sidecar=info,tauri_runtime_wry=debug,ironclaw_diag=info' bash scripts/smoke-packaged-app.sh --wait 12 --bundle src-tauri/target/release/bundle/macos/IronClaw.app`: passed.

### Evidence
- Full rendered browser result: `91 passed`, `10 skipped`, duration `52.0s`; the run covered a11y routes, chat send/history/deep links, attachment picker/drop, PDF/DOCX/CSV/JSON/XLSX/Markdown template handling, connector setup normalization, global search, command palette, dashboard, Work, service-agreement generation/export, work-product copy/export, voice answer, and artifact actions.
- Static connector smoke result: `PASS webui static desktop bootstrap smoke`; the smoke now fails if any lifecycle request uses `action: "submit"` and requires Gmail credential projection to use `action: "configure"`.
- Packaged app smoke log: `/tmp/ironclaw-packaged-smoke-after-connector-configure-20260602.log`.
- Packaged smoke output included `process stayed alive for 12s`, `native app window count: 2`, `Reborn gateway healthy on port 3000`, `terminated cleanly`, and `Reborn sidecar pid(s) after termination: none`.
- Connector sidecar handoff identified Reborn's supported lifecycle actions in `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw/crates/ironclaw_product_workflow/src/reborn_services/lifecycle_setup.rs` and the broken static `submit` action before this patch.

### Still RED
- Live Gmail, Google Calendar, Notion, and Slack OAuth/read-only connector calls are still not proven. This pass proves static UI route names, Product Auth request shape, supported lifecycle action, Slack blocked state, and no catalog-ref lifecycle leaks under mocks.
- Static `/workspace` route/API remains TODO/stub territory per connector sidecar; do not present it as connected workspace truth.
- Packaged native app smoke proves process/window/sidecar lifecycle only. It does not prove native WKWebView click-through for chat send, model selector, attachments, connector setup, or export controls.
- Live model execution remains blocked/unverified for the configured `NEAR.AI / z-ai/glm-4.5` path unless a safe live completion succeeds with the active account. Rendered work-product tests use mocked assistant output and parse downloaded exports; they are not proof of live model quality.
- `npm run tauri -- build --bundles app` still cannot complete updater artifact signing without `TAURI_SIGNING_PRIVATE_KEY`.

### Risks
- The worktree is heavily dirty from multiple lanes. Do not normalize unrelated files or assume all modified files belong to this pass.
- `crates/ironclaw_webui_v2_static/static/js/main.bundle.js` must stay in sync with `pages/extensions/lib/extensions-api.js`; `npm run tauri -- build --bundles app` regenerated the static root after the source fix and the bundle now contains `action:"configure"`.
- Full Playwright without `CI=1` can reuse a stale local dev server; the owned-server `CI=1` run is the reliable full-suite evidence from this pass.
- Mocked browser tests intentionally avoid real external OAuth/provider actions; that is the right safety boundary, but it means live connector status remains RED.

### Next Agent Should Start Here
1. `cd /Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop && rg 'action:\s*"submit"|action:"submit"' crates/ironclaw_webui_v2_static/static/js/pages/extensions/lib/extensions-api.js crates/ironclaw_webui_v2_static/static/js/main.bundle.js scripts/smoke-webui-static.mjs`
2. Add a live-route Product Auth probe against a running sidecar that proves `/api/webchat/v2/extensions/{gmail,google-calendar,notion}/setup` accepts `configure` and renders honest `auth saved` or blocked states without claiming connected.
3. Acceptance gate: a safe live connector setup/readiness probe captures backend HTTP evidence, and native/manual packaged WebView smoke proves chat/model/attachment/connector/export controls are clickable in the shipped app.

### Do Not Touch
- Do not reset, stash, revert, or overwrite dirty user/agent work.
- Do not send real emails, calendar events, Slack messages, Notion writes, or external OAuth actions without explicit approval.
- Do not mark connectors GREEN from mocked static/browser smoke alone.
- Do not claim live service-agreement generation is complete from mocked PDF-template tests alone.
- Do not reintroduce lifecycle `action: "submit"`; Reborn treats it as unsupported.

## Handoff: Phase 1.13 - Live Connector Truth and Runtime-Blocked UI

Status: YELLOW
Owner lane: Connector | Hostile QA | Runtime

### Goal
Move connector verification from mocked rendered routes to the actual bundled Reborn sidecar, prove the Product Auth/setup sequence with an active bearer token, and make the static UI preserve backend connector blockers instead of offering fake activation after a credential is stored.

### Changed
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/scripts/probe-live-reborn-connectors.mjs`: added a live local Reborn probe that launches the bundled `ironclaw-reborn` sidecar in an isolated temp HOME, uses an env bearer token, probes Product Auth setup/secret-submit plus extension lifecycle begin/configure/activate for Gmail, Google Calendar, Notion, and Slack, writes redacted JSON evidence, and shuts the sidecar down.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/pages/extensions/lib/extensions-api.js`: stores backend lifecycle phase/blocker after connector configure, maps Reborn `extension_auth_and_configure_not_yet_wired` and `extension_lifecycle_package_unavailable` blockers to human-readable copy, prevents locally stored credentials from being treated as active connectors, and short-circuits Activate when the stored backend truth is runtime-blocked.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/pages/extensions/lib/extensions-schema.js`: added `runtime_blocked` tone/label so the UI can show a distinct blocked state instead of `auth saved`.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/extension-card.js`: hides the Activate button when backend state says a connector cannot activate.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/scripts/smoke-webui-static.mjs`: strengthened the connector smoke so configure returns the backend-style runtime blocker, the rendered UI must show `runtime blocked`, and the smoke fails if an Activate button remains available after blocked configure.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/main.bundle.js`: regenerated through `npm run prepare:webui-static` / Tauri build so the shipped static bundle includes the runtime-blocked connector mapping.

### Verified
- `node --check scripts/smoke-webui-static.mjs && node --check scripts/probe-live-reborn-connectors.mjs && node --check crates/ironclaw_webui_v2_static/static/js/pages/extensions/lib/extensions-api.js && node --check crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/extension-card.js && node --check crates/ironclaw_webui_v2_static/static/js/pages/extensions/lib/extensions-schema.js`: passed.
- `npm run prepare:webui-static`: passed and regenerated `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/main.bundle.js`.
- `npm run smoke:webui-static`: passed after requiring `runtime blocked` UI and no post-blocker Activate button.
- `node scripts/probe-live-reborn-connectors.mjs`: passed as a probe harness with live-sidecar evidence; latest summary was `total: 18`, `ok: 13`, `expected_security_rejections: 2`, `runtime_blocked_configures: 3`, `activation_rejections: 3`, `slack_blocked: true`.
- `npm run check`: passed with `svelte-check found 0 errors and 0 warnings`.
- `npm run tauri -- build --bundles app`: compiled release and wrote `src-tauri/target/release/bundle/macos/IronClaw.app`; still exits nonzero at updater signing because `TAURI_SIGNING_PRIVATE_KEY` is missing.
- `bash scripts/smoke-packaged-app.sh --bundle src-tauri/target/release/bundle/macos/IronClaw.app`: passed on the rebuilt app.

### Evidence
- Live connector probe artifact: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/live-connector-probe/reborn-live-connector-probe-2026-06-02T04-17-12-838Z.json`.
- Live sidecar health: `/api/health` returned `200` from the bundled `src-tauri/target/release/bundle/macos/IronClaw.app/Contents/MacOS/ironclaw-reborn` binary with env-bearer auth.
- Live connector route truth: unauthenticated extension setup was rejected with `401`; slash-prefixed lifecycle path `/api/webchat/v2/extensions/tools%2Fgmail/setup` was rejected with `400 invalid_request`.
- Live Product Auth truth: Gmail, Google Calendar, and Notion manual-token setup plus secret-submit returned `200` and produced redacted credential refs in the isolated sidecar session.
- Live runtime blocker truth: Gmail, Google Calendar, and Notion lifecycle `configure` returned `200` with `phase: unsupported_or_legacy` and blocker `extension_auth_and_configure_not_yet_wired`; Slack `begin` returned `unsupported_or_legacy` with `extension_lifecycle_package_unavailable`.
- Live activation truth: Gmail, Google Calendar, and Notion lifecycle `activate` returned `400 invalid_request`; the static UI now keeps those connectors in `runtime blocked` instead of offering Activate after stored credentials.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260602-061810.log`; output included `native app window count: 2`, `Reborn gateway healthy on port 3000`, `terminated cleanly`, and no orphaned sidecar.
- Post-smoke app run-state: relaunched `src-tauri/target/release/bundle/macos/IronClaw.app/Contents/MacOS/ironclaw-desktop` as pid `39505`; its Reborn sidecar is pid `39512` on port `3000`; `curl -fsS http://127.0.0.1:3000/api/health` passed and wrote `/tmp/ironclaw-open-health-20260602.json`.
- Cleanup note: killed stale probe sidecar pid `36641` from the earlier cleanup bug; no probe sidecar remains.

### Still RED
- Live Gmail, Google Calendar, and Notion connectors are not functionally connected. The current Reborn sidecar can store dummy credentials through Product Auth, but lifecycle configure reports `extension_auth_and_configure_not_yet_wired` and activation returns `400 invalid_request`.
- Slack is not usable in this build. Live sidecar reports `extension_lifecycle_package_unavailable`; the UI must continue to show it as blocked.
- No real OAuth callback or read-only provider tool call has been proven. Do not mark connectors GREEN until a safe live read-only Gmail/Calendar/Notion call succeeds or the backend explicitly reports connected/readiness.
- Packaged native click-through for connector setup/model selector/chat/attachments/exports is still not proven; packaged smoke remains process/window/sidecar lifecycle only.
- Updater signing is still RED without `TAURI_SIGNING_PRIVATE_KEY`.

### Risks
- The Product Auth probe uses dummy tokens inside an isolated temp HOME and intentionally performs no external provider action; it proves route wiring and backend blockers, not provider account access.
- The worktree is heavily dirty and includes multiple prior user/agent lanes. Do not infer ownership from `git status`.
- Static UI source and generated `main.bundle.js` must stay in sync; rerun `npm run prepare:webui-static` after any static source edit.

### Next Agent Should Start Here
1. `cd /Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop && node scripts/probe-live-reborn-connectors.mjs`
2. Inspect the live Reborn lifecycle implementation that returns `extension_auth_and_configure_not_yet_wired` and decide whether desktop can wire the missing runtime pieces locally or must keep the honest blocked state until Reborn lands it.
3. Acceptance gate: Gmail, Google Calendar, and Notion may only move from YELLOW/RED to GREEN when a live sidecar route proves configured/readiness/active state and the rendered packaged/static UI reflects that state without localStorage optimism.

### Do Not Touch
- Do not reset, stash, revert, or overwrite dirty user/agent work.
- Do not send real emails, create real calendar events, write Slack/Notion, or perform external OAuth without explicit approval.
- Do not remove the `runtime blocked` UI until live Reborn returns active/readiness proof.
- Do not treat dummy Product Auth credential refs as real connector connectivity.

## Handoff: Phase 1.14 - Live Attachment Route and Work Product Export Proof

Status: YELLOW
Owner lane: Work Product | Hostile QA | Runtime

### Goal
Prove that the running packaged app's local Reborn sidecar accepts real attachment payloads and re-exposes them through route reads, then pair that live route evidence with rendered export tests for DOCX/PDF/HTML/Markdown/JSON work-product controls. Also attempt native packaged click-through and document the exact automation blocker instead of pretending packaged UI interaction is proven.

### Changed
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/scripts/probe-live-reborn-chat-attachments.mjs`: added a live sidecar probe that reads the active app bearer token from the local token fallback, creates a harmless test thread, sends a small CSV attachment through `/api/webchat/v2/threads/{thread_id}/messages`, fetches `/timeline`, redacts payload bytes, and writes a JSON evidence artifact.

### Verified
- `node --check scripts/probe-live-reborn-chat-attachments.mjs`: passed.
- `node scripts/probe-live-reborn-chat-attachments.mjs`: passed against the running packaged app sidecar on port `3000`.
- `npx playwright test tests/e2e/file-generation-export.spec.ts tests/e2e/work-product-actions.spec.ts --reporter=line`: passed, 16/16.
- `curl -fsS http://127.0.0.1:3000/api/health`: passed after the probe and rendered tests; packaged app pid `39505` and sidecar pid `39512` remained alive.

### Evidence
- Live attachment route artifact: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/output/live-work-product-probe/reborn-live-chat-attachment-probe-2026-06-02T04-42-10-732Z.json`.
- Live send evidence: `POST /api/webchat/v2/threads/510f0579-d005-4716-8097-832b43cbf13e/messages` returned `200`, `outcome: submitted`, `accepted_message_ref: msg:64a2949a-5087-4dca-bd42-ec357d0d524e`, and `resolved_run_profile_id: reborn-text-only-default`.
- Live attachment evidence: `GET /api/webchat/v2/threads/510f0579-d005-4716-8097-832b43cbf13e/timeline?limit=50` returned `200`; the user message content included `<attachments>`, `filename: codex-live-route-probe.csv`, `mime_type: text/csv`, `size_bytes: 28`, `extraction_status: extracted_text`, and extracted CSV rows `alpha,12` / `beta,34`.
- Route truth: `GET /api/webchat/v2/threads/{thread_id}/messages?limit=50` returned `405`; timeline is the working read route for message reload proof in this sidecar.
- Rendered export proof: 16/16 focused Playwright tests passed for XLSX input to HTML table, CSV input to DOCX, DOCX input to PDF, PPTX input to Work plus Markdown, JSON input to thread JSON, assistant copy, assistant Markdown/DOCX/PDF/HTML exports, full thread Markdown/JSON exports, promotion to Work artifact, and Work artifact copy/DOCX/PDF exports.
- Client route audit: `rg` found production history/reload code using `/timeline`; `/messages` appears as the POST send route and test mocks, not as a production GET reload dependency.
- Native automation attempt evidence:
  - Full-screen capture `/tmp/ironclaw-native-current-20260602-0437.png` was black despite the app process being alive.
  - CGWindow inspection for pid `39505` found the main `IronClaw` window at `1200x800` plus a small `500x500` window.
  - `screencapture -x -l 142592 /tmp/ironclaw-native-window-142592-20260602-0437.png` failed with `could not create image from window`.
  - System Events saw process `ironclaw-desktop` but reported zero accessible windows; coordinate click/keystroke automation failed with macOS error `-25200`.

### Still RED
- Native packaged click-through remains unproven. The app/window/sidecar are alive, but this macOS session does not currently permit reliable screenshot or accessibility automation for the WebView.
- Live model work-product generation quality remains unproven. The live probe proves attachment acceptance/extraction/reload through Reborn routes, not that a live model generated a high-quality agreement, SOW, spreadsheet, or deck from it.
- Downloaded exports remain rendered-browser proof, not native WebView click proof. The UI code and exported bytes are tested, but the shipped WebView export buttons were not clicked under native automation.
- `/api/webchat/v2/threads/{thread_id}/messages` GET returns `405`; any client or test assuming that route reloads messages is wrong and should use `/timeline`.

### Risks
- The live probe creates a harmless test thread in the current local Reborn store because there is no delete route in the tested contract.
- The probe uses the active app token file but redacts it from artifacts. Do not print token contents.
- If native UI automation is required, the next phase needs macOS screen-recording/accessibility permission or a first-party Tauri test hook; coordinate guessing is not acceptable evidence.

### Next Agent Should Start Here
1. `cd /Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop && node scripts/probe-live-reborn-chat-attachments.mjs`
2. Add a first-party native automation hook or secure packaged-app test mode if macOS screenshot/accessibility permissions remain unavailable.
3. Acceptance gate: native packaged click-through can only turn GREEN with a readable screenshot/accessibility tree or an app-owned Tauri/WebView automation hook that proves chat send, attachment attach/drop, model selector, and export controls in the shipped app.

### Do Not Touch
- Do not reset, stash, revert, or overwrite dirty user/agent work.
- Do not delete user data or local Reborn stores to remove the harmless probe thread.
- Do not print bearer tokens or attachment base64 payloads.
- Do not claim live model generation or native export click-through from this route/browser evidence alone.

## Handoff: Phase 1.15 - Packaged WebView Smoke Evidence Hook

Status: YELLOW
Owner lane: Runtime | Work Product | Hostile QA

### Goal
Close the native screenshot/accessibility automation gap with an app-owned packaged smoke mode. The shipped static WebView now runs a gated self-test only when launched by the smoke harness, uses the real Tauri HTTP transport and local Reborn sidecar, sends a chat message with a CSV attachment, proves the prompt and extracted attachment text reload through `/timeline`, validates Markdown/HTML/JSON/PDF/DOCX export blobs, and writes a redacted JSON evidence file through a gated Tauri command.

### Changed
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/src-tauri/src/lib.rs`: added `packaged_smoke_request` and `packaged_smoke_report`, gated by `IRONCLAW_PACKAGED_WEBVIEW_SMOKE=1`, to let packaged smoke request/write evidence without exposing a normal user filesystem action.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/lib/packaged-smoke.js`: added the packaged WebView self-test for sidecar status, token bootstrap, health, thread create, message send with attachment, timeline reload, and export blob checks.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/main.js`: starts the packaged smoke hook after app render; it no-ops outside the Tauri smoke env gate.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/work-product-export.js`: split download actions into reusable blob builders so tests can validate export bytes without relying on blind download clicks.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/scripts/smoke-packaged-app.sh`: added `--webview-smoke`, evidence-file env wiring, JSON polling, and required check validation before terminating the packaged app.
- `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop/crates/ironclaw_webui_v2_static/static/js/main.bundle.js`: regenerated bundled static UI with `npm run prepare:webui-static`.

### Verified
- `node --check crates/ironclaw_webui_v2_static/static/js/lib/packaged-smoke.js`: passed.
- `node --check crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/work-product-export.js`: passed.
- `node --check crates/ironclaw_webui_v2_static/static/js/main.js`: passed.
- `bash -n scripts/smoke-packaged-app.sh`: passed.
- `cargo fmt --manifest-path src-tauri/Cargo.toml`: passed.
- `npm run prepare:webui-static`: passed and regenerated the shared static bundle.
- `rg -o "packaged_smoke_request|packaged-webview-smoke.csv|Timeline reload preserves attachment payload" crates/ironclaw_webui_v2_static/static/js/main.bundle.js`: confirmed the shipped bundle contains the smoke hook.
- `npm run smoke:webui-static`: passed.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `npm run check`: passed with 0 Svelte errors/warnings.
- `npx playwright test tests/e2e/file-generation-export.spec.ts tests/e2e/work-product-actions.spec.ts --reporter=line`: passed, 16/16.
- `npm run tauri -- build --bundles app`: produced `src-tauri/target/release/bundle/macos/IronClaw.app` and `.app.tar.gz`, then exited on the known missing `TAURI_SIGNING_PRIVATE_KEY`.
- `WEBVIEW_SMOKE_WAIT_SECONDS=60 bash scripts/smoke-packaged-app.sh --bundle src-tauri/target/release/bundle/macos/IronClaw.app --wait 15 --webview-smoke`: passed with WebView evidence validation.
- `curl -fsS http://127.0.0.1:3000/api/health`: passed after the packaged smoke; the user-visible app sidecar remained healthy.

### Evidence
- Final packaged WebView evidence: `/tmp/ironclaw-packaged-webview-smoke-20260602-072013.json`.
- Final packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260602-072013.log`.
- Evidence thread id: `77e14e29-cac2-46c0-8b6d-6e4ff0b5268a`.
- Evidence runtime gateway origin: `http://127.0.0.1:3100`.
- Evidence checks: 12/12 PASS, including runtime sidecar port, local bearer presence by length only, health `{"channel":"webui-v2","status":"ok"}`, thread create, submitted message with run id `0705ea5e-e05e-488e-a545-8bdcb7e0af79`, timeline prompt reload, timeline attachment reload with extracted CSV text, Markdown/HTML/JSON/PDF/DOCX blob validation.
- Smoke process proof: app pid `51888`, sidecar pid `51894`, native app window count `2`, gateway healthy on port `3100`, clean termination, no orphaned smoke sidecar.
- Current user-visible app proof after smoke: app pid `39505`, sidecar pid `39512`, sidecar listening on `127.0.0.1:3000`, `/api/health` returned `{"channel":"webui-v2","status":"ok"}`.
- Sidecar reviewer feedback incorporated: bundle freshness is now verified, the harness now sets/waits for WebView evidence, send requires submitted outcome and run id, and attachment proof requires extracted CSV text rather than filename-only.

### Still RED
- Live model-generated work-product quality is still not proven. This smoke proves packaged WebView transport, attachment extraction/reload, and export builders; it does not prove a model generated a good services agreement, SOW, spreadsheet, deck, or legal-quality artifact from the attachment.
- Physical native click-through remains unproven because macOS screenshot/accessibility automation still fails in this session. The first-party hook is stronger than blind coordinate automation, but it is not the same as clicking every visible button.
- Connector functionality remains RED: Gmail, Google Calendar, Notion, and Slack still require live readiness/active state and safe read-only provider proof before they can be called connected.
- Updater signing remains RED without `TAURI_SIGNING_PRIVATE_KEY`.

### Risks
- The packaged WebView smoke creates a harmless test thread inside an isolated smoke HOME. It does not delete that thread because no delete route is in the tested contract.
- The smoke intentionally records token length only and never writes bearer values or attachment base64 to evidence.
- The DOCX/PDF checks are structural envelope checks inside the WebView, not full visual render comparisons of downloaded files.
- If static source changes again, `npm run prepare:webui-static` must run before packaged smoke or the `.app` may embed stale JS.

### Next Agent Should Start Here
1. `cd /Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop && WEBVIEW_SMOKE_WAIT_SECONDS=60 bash scripts/smoke-packaged-app.sh --bundle src-tauri/target/release/bundle/macos/IronClaw.app --wait 15 --webview-smoke`
2. Extend the packaged smoke only if the next acceptance gate demands live assistant/run-state proof: poll run state, require assistant message/work-product content, reload the WebView, and re-prove export controls remain available.
3. Acceptance gate for the next phase: do not call live work-product generation GREEN until an attachment-derived assistant/work-product result is rendered, exportable, reload-preserved, and validated from the packaged app.

### Do Not Touch
- Do not reset, stash, revert, or overwrite dirty user/agent work.
- Do not remove the env gate from `packaged_smoke_request` / `packaged_smoke_report`.
- Do not print bearer tokens, Authorization headers, secrets, or attachment base64.
- Do not claim connectors, live model generation quality, or real external provider actions are proven by this packaged WebView smoke.

## Handoff: Phase 1.16 - Run-State Failure Surfacing and Live Work-Product Truth

Status: YELLOW
Owner lane: Static UI | Work Product | Hostile QA | Runtime

### Goal
Stop the chat UI from silently hanging after Reborn accepts a run that later fails, and prove the current live model/work-product state honestly. The user-facing fix is that `policy_denied` / provider-plan failures now become visible error copy, the spinner clears, the composer recovers, and the failed turn is not treated as assistant work product. The product truth remains RED for live generation because the active model still produces no assistant output.

### Changed
- `src/lib/api/reborn.ts`: added `RebornRunStateResponse`, terminal run-status helpers, provider/model failure copy, and `upsertRunFailureMessage`; projection `run_status` failures now use the same failure-message mapping.
- `src/lib/api/ironclaw.ts`: added `getRunStateV2(threadId, runId)` for `/api/webchat/v2/threads/{thread}/runs/{run}`.
- `src/lib/stores/reborn-chat.svelte.ts`: added deduped run-state polling after accepted sends and SSE active runs; terminal failures upsert an error bubble, clear processing, and recover the composer.
- `src/lib/stores/reborn-chat.test.ts`: added policy-denied polling coverage for accepted send -> `getRunStateV2` -> visible provider-plan denial -> `isProcessing=false`.
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/hooks/useChat.js`: added analogous static WebView run polling after send/SSE active-run adoption, plus first-thread pending adoption protection from the previous pass.
- `crates/ironclaw_webui_v2_static/static/js/main.bundle.js`: regenerated with `npm run prepare:webui-static`.
- `tests/e2e/chat.spec.ts`: added a rendered policy-denied gauntlet that correlates the same thread/run across POST `/messages`, SSE `/events`, `/timeline`, and `/runs/{run}`; it asserts the denial copy renders, no fake assistant reply appears, no missing-assistant fallback appears, Stop clears, the composer can send again, and no `Copy Assistant response` action is mounted for an error-only turn.

### Verified
- `npx vitest run src/lib/stores/reborn-chat.test.ts src/lib/api/reborn.test.ts`: passed, 50/50.
- `node --check crates/ironclaw_webui_v2_static/static/js/pages/chat/hooks/useChat.js`: passed.
- `npm run prepare:webui-static`: passed and regenerated the shared static bundle.
- `npm run check`: passed with `svelte-check found 0 errors and 0 warnings`.
- `npm run smoke:webui-static`: passed.
- `CI=1 npx playwright test tests/e2e/chat.spec.ts -g "failed Reborn run surfaces model denial" --reporter=line`: passed.
- `CI=1 npx playwright test tests/e2e/chat.spec.ts tests/e2e/work-product-actions.spec.ts --reporter=line`: passed, 32/32.
- `node scripts/probe-live-reborn-assistant-run.mjs`: completed with live RED evidence: send submitted, attachment extracted, run failed `policy_denied`, assistant count `0`.
- `npm run tauri -- build --bundles app`: produced `src-tauri/target/release/bundle/macos/IronClaw.app` and `.app.tar.gz`, then exited on the known missing `TAURI_SIGNING_PRIVATE_KEY`.
- `WEBVIEW_SMOKE_WAIT_SECONDS=60 bash scripts/smoke-packaged-app.sh --bundle src-tauri/target/release/bundle/macos/IronClaw.app --wait 15 --webview-smoke`: passed, 12/12 WebView checks.
- `curl -fsS http://127.0.0.1:3000/api/health`: passed after smoke; user-visible sidecar remained healthy on port `3000`.

### Evidence
- Live assistant/run artifact: `output/live-work-product-probe/reborn-live-assistant-run-probe-2026-06-02T06-16-50-068Z.json`.
- Live thread/run: thread `6aa58053-303c-4d53-8d46-cf1545b5d70c`, run `3508bd14-f611-491d-966d-72a4aec42061`.
- Live run truth: `send_status:200`, `send_outcome:"submitted"`, `run_status:"Failed"`, `failure_category:"policy_denied"`, `assistant_message_count:0`, `attachment_extracted_text_observed:true`, status `RED_no_assistant_work_product`.
- Rendered route proof: the new Playwright test requires same-thread/same-run correlation for message POST, SSE accepted, timeline reload, and run-state failure before accepting the denial UI.
- Packaged WebView evidence: `/tmp/ironclaw-packaged-webview-smoke-20260602-081816.json`.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260602-081816.log`.
- Packaged smoke thread: `0deea839-8852-405e-a62b-c3d26163f091`; gateway origin `http://127.0.0.1:3100`; 12/12 PASS; no orphaned smoke sidecar after termination.
- Current user-visible app proof: app pid `39505`, Reborn sidecar pid `39512`, sidecar listening on `127.0.0.1:3000`, `/api/health` returned `{"channel":"webui-v2","status":"ok"}`.
- Sidecar hostile reviewers agreed: the UI failure surfacing is useful and evidence-backed; live Work Product generation remains RED; next proof must use a plan-allowed live model and hidden attachment-derived facts.

### Still RED
- Live assistant/work-product generation remains RED. The actual local sidecar still returns `policy_denied` and zero assistant messages for the configured model path, so IronClaw cannot yet generate the services agreement/file output the user asked for from live chat.
- The model selector/preflight still allows a plan-denied model to be selected and sent; this pass surfaces the failure after the run, but it does not yet prevent the bad send up front.
- Connectors remain RED for real use: Gmail, Google Calendar, Notion, and Slack are not proven connected/read-only live.
- Packaged native-window click-through of the visible denial copy remains unproven; the packaged WebView smoke is first-party evidence, not a manual/window screenshot proof.
- Updater signing remains RED without `TAURI_SIGNING_PRIVATE_KEY`.

### Risks
- The live probe prompt still includes the expected marker facts. It proves live run availability/failure and attachment extraction, not attachment-derived reasoning quality.
- Static hook polling is covered by packaged smoke plus source checks, but not by a dedicated static hook-level unit test.
- The current UI truthfulness can become a comfort blanket: surfacing `policy_denied` is necessary, but the next product fix should preflight/block or strongly warn on models that cannot execute.
- The worktree contains many unrelated dirty files from user/agent lanes; do not infer ownership from `git status`.

### Next Agent Should Start Here
1. `cd /Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop && node scripts/probe-live-reborn-assistant-run.mjs`
2. Fix model readiness/preflight so `NEAR.AI / z-ai/glm-4.5` or any plan-denied model cannot silently enter a run as if it were usable; acceptance gate is a rendered model-selector warning/block plus live HTTP evidence.
3. Run a plan-allowed live model probe with hidden attachment-only facts; acceptance gate is an assistant message derived from the attachment, reload-preserved, exportable, and parsed as DOCX/PDF/JSON/HTML where relevant.
4. Add static hook-level coverage for `useChat` polling `getRunState` after accepted send, or extend packaged smoke to simulate a live run-state failure and assert visible denial copy.

### Do Not Touch
- Do not reset, stash, revert, or overwrite dirty user/agent work.
- Do not print bearer tokens, Authorization headers, secrets, or attachment base64.
- Do not claim live work-product generation is fixed until a live assistant result exists and exports parse.
- Do not claim connectors are connected without live readiness/active state plus a safe read-only provider call.
- Do not remove the packaged WebView smoke env gate.

## Handoff: Phase 1.17 - Live Model Readiness Block Proof and Svelte Parity

Status: YELLOW
Owner lane: Static UI | Work Product | Hostile QA

### Goal
Re-check the next product gate after Phase 1.16: neither the canonical shared static UI nor the Svelte legacy chat panel may let the user send into a model path that the live Reborn sidecar reports as unverified. This pass proves the real sidecar status for `NEAR.AI / z-ai/glm-4.5`, proves the static rendered UI blocks Send under that status, patches the Svelte parity gap, and keeps live work-product generation RED until a model can actually execute and produce attachment-derived assistant output.

### Changed
- `src/lib/util/model-readiness.ts`: added the TypeScript copy of the static model-readiness contract: configured/unverified blocks send until explicit execution proof or GREEN readiness.
- `src/lib/util/model-readiness.test.ts`: added focused readiness coverage.
- `src/lib/api/types.ts`: widened `GatewayStatus` with execution-readiness fields.
- `src/lib/api/ironclaw.ts`: preserves gateway execution-readiness fields instead of dropping them during normalization.
- `src/lib/components/ChatModelSelector.svelte`: shows unverified execution copy in the model popover.
- `src/lib/components/RebornChatPanel.svelte`: blocks Send/Enter before dispatch when the connected gateway does not verify model execution and renders a compact warning above the composer.
- `src/lib/components/ChatModelSelector.test.ts`: added model-readiness assertion and marks the default mock verified.
- `tests/e2e/_helpers.ts`: default mocked gateway status now explicitly reports verified execution; tests can override it.
- `tests/e2e/chat.spec.ts`: added a rendered regression that an unverified selected model preserves typed text, disables Send, Enter no-ops, and no WebChat message POST fires.
- `docs/reviews/phase-static-chat-runtime-handoff-2026-06-02.md`: added this handoff packet with live sidecar and rendered static UI evidence.
- `docs/reviews/hostile-routing-review.md`: added the model-readiness/preflight review update.

### Verified
- `curl -fsS -H "Authorization: Bearer [REDACTED]" http://127.0.0.1:3000/api/gateway/status`: passed and returned `model_execution_verified:false`, `model_readiness:"unverified"`, backend `NEAR.AI`, model `z-ai/glm-4.5`.
- `node --test crates/ironclaw_webui_v2_static/static/js/lib/model-readiness.test.mjs`: passed, 4/4.
- `npm run smoke:webui-static`: passed; rendered static smoke proves unverified model disables Send and no message POST occurs, then flips mocked readiness to GREEN and proves PDF attachment chat send/work-product render.
- Live rendered static probe against the active sidecar: passed; after typing into chat under the real unverified gateway status, Send was disabled and zero `/api/webchat/v2/threads/{thread}/messages` POSTs were observed.
- `npx vitest run src/lib/util/model-readiness.test.ts src/lib/components/ChatModelSelector.test.ts src/lib/components/RebornChatPanel.test.ts src/lib/api/ironclaw.test.ts`: passed, 63/63.
- `npx svelte-check --tsconfig ./tsconfig.json`: passed with 0 errors/warnings.
- `CI=1 npx playwright test tests/e2e/chat.spec.ts -g "chat blocks sends before dispatch|failed Reborn run surfaces model denial" --reporter=line`: passed, 2/2.
- `npm run check`: passed with `svelte-check found 0 errors and 0 warnings`.
- `CI=1 npx playwright test tests/e2e/chat.spec.ts tests/e2e/work-product-actions.spec.ts --reporter=line`: passed, 33/33.
- `curl -fsS http://127.0.0.1:3000/api/health`: still healthy from the user-visible sidecar.

### Evidence
- Live gateway status artifact: `output/live-work-product-probe/live-gateway-status-2026-06-02T06-24-43Z.json`.
- Live rendered static screenshot: `output/playwright/live-static-model-readiness-block.png`.
- Static smoke rendered screenshot from the verified-path branch: `output/playwright/static-work-product-attachment-chat.png`.
- Static smoke rendered screenshot from the failed-run branch: `output/playwright/static-run-state-failure-visible.png`.
- Live sidecar truth: `model_execution_verified:false`; `model_readiness:"unverified"`; `model_readiness_reason:"Gateway status reports configured provider/model only; execution is verified by a successful WebChat run."`
- Live static rendered UI truth: model control showed `Configured (unverified): NEAR.AI / z-ai/glm-4.5`; the unverified-model warning rendered; typed prompt was preserved in the composer; Send was disabled; no WebChat message POST fired.
- Svelte rendered parity truth: the new Playwright regression overrides `/api/gateway/status` to `model_execution_verified:false`, types into the Svelte chat composer, asserts Send is disabled, presses Enter, asserts zero WebChat message POSTs, and confirms the draft stays in the composer rather than becoming a sent bubble.
- Temporary static server on port `17631` was stopped after the live rendered probe.

### Still RED
- Live assistant/work-product generation remains RED because the active model is configured but not execution-verified, and the last live run failed `policy_denied` with zero assistant messages.
- No plan-allowed live model has produced attachment-derived content from hidden facts.
- Connectors remain RED for real Gmail, Google Calendar, Notion, and Slack usage.
- Updater signing remains RED without `TAURI_SIGNING_PRIVATE_KEY`.

### Risks
- The static smoke's successful services-agreement path is route-mocked after readiness is flipped to GREEN. It proves rendered plumbing and attachment POST shape, not live generation quality.
- The live rendered block proof protects users from doomed sends, but it does not solve the underlying provider/model account entitlement.
- Do not weaken the readiness gate just to make demo sends work. The next green gate must come from a successful live run, not an optimistic UI override.

### Next Agent Should Start Here
1. `cd /Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop && cat output/live-work-product-probe/live-gateway-status-2026-06-02T06-24-43Z.json`
2. Find or configure a live model/provider path that returns `model_execution_verified:true`, `model_readiness:"GREEN"`, or equivalent readiness proof from `/api/gateway/status`.
3. Acceptance gate: run a live sidecar probe with hidden attachment-only facts; the assistant result must derive from the attachment, reload from `/timeline`, and export/parse as DOCX, PDF, HTML, JSON, and Markdown before live work-product generation can move out of RED.

### Do Not Touch
- Do not reset, stash, revert, or overwrite dirty user/agent work.
- Do not print bearer tokens, Authorization headers, secrets, or attachment base64.
- Do not mark `NEAR.AI / z-ai/glm-4.5` usable while live gateway status reports execution unverified.
- Do not claim the route-mocked static services-agreement branch is live model generation.
- Do not claim connectors are connected without live readiness/active state plus a safe read-only provider call.

## Handoff: Phase 1.18 - Runtime Model Auth Defaults

Status: YELLOW
Owner lane: Runtime

### Goal
Make the packaged Tauri runtime stop booting the Reborn sidecar with a misleading hardcoded NEAR.AI `z-ai/glm-4.5` default when the provider cannot execute. Keep NEAR.AI Cloud as the default intent, but make sidecar bootstrapping read the active profile where available, pass through configured NEAR.AI credentials from env/keychain, fall back to `auto` when no credential exists, and surface actionable auth/readiness reasons to the UI.

### Changed
- `src-tauri/src/sidecar.rs`: expanded `BackendConfig` so NEAR.AI/OpenRouter/OpenAI/Anthropic all carry optional model ids; NEAR.AI now accepts optional `session_token` and `api_key`, passes `NEARAI_SESSION_TOKEN`/`NEARAI_API_KEY` into the child when available, sets `NEARAI_MODEL=auto` when auth is absent, and emits `IRONCLAW_DESKTOP_MODEL_READINESS_REASON` describing the missing credential state.
- `src-tauri/src/lib.rs`: `start_sidecar` now passes a vaulted nearai provider credential or `NEARAI_SESSION_TOKEN`/`NEARAI_API_KEY` env credentials into `BackendConfig::Nearai`; packaged auto-start now reads the active settings profile (`activeProfileId`, `llmProviderId`, `llmBackend`, `llmModelId`) instead of constructing a fixed NEAR.AI config by hand.
- `src-tauri/src/lib.rs`: added focused runtime unit coverage for active-profile sidecar boot selection and fresh-install NEAR.AI `auto` fallback intent.
- `src/lib/util/model-readiness.ts`: unverified model readiness now uses gateway-provided `model_readiness_reason` / failure summary/category when present, so the chat/model UI can say exactly why send is blocked.
- `src/lib/util/model-readiness.test.ts`: added regression coverage for missing NEAR.AI auth reason text.

### Verified
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `cargo test --manifest-path src-tauri/Cargo.toml runtime_model_auth_tests`: passed, 2/2.
- `npx vitest run src/lib/util/model-readiness.test.ts src/lib/components/ChatModelSelector.test.ts`: passed, 8/8.
- `npx vitest run src/lib/stores/settings.test.ts src/routes/settings/LlmProviderPicker.test.ts src/lib/util/model-readiness.test.ts src/lib/components/ChatModelSelector.test.ts`: passed, 35/35.
- `npm run check`: passed with `svelte-check found 0 errors and 0 warnings`.
- `rg -n "z-ai/glm-4\\.5|DEFAULT_NEARAI_MODEL|auto" src/lib/stores src/routes/settings src/lib/components tests/e2e/chat.spec.ts src/lib -g '*test.ts' -g '*.spec.ts'`: confirmed focused settings/model/chat expectations now use `auto` for NEAR.AI defaults, with `z-ai/glm-4.5` only remaining in explicit unverified-status regression fixtures.

### Evidence
- Runtime compile proof: `cargo check --manifest-path src-tauri/Cargo.toml` finished `dev` profile successfully.
- Runtime unit proof: `runtime_model_auth_tests::sidecar_boot_selection_uses_active_profile_provider_and_model` and `runtime_model_auth_tests::sidecar_boot_selection_falls_back_to_nearai_auto_intent` passed.
- JS readiness proof: focused Vitest suites passed and `npm run check` produced zero Svelte diagnostics.
- Current live truth before rebuild remains RED/YELLOW from Phase 1.17: the running installed sidecar reported `model_execution_verified:false` and missing/unverified NEAR.AI execution; this pass changes source behavior, not the already-running packaged binary.

### Still RED
- `/Applications/IronClaw.app` has not been rebuilt/redeployed from this exact source patch, so installed-app runtime behavior is not yet proven.
- Live model execution is still RED until a real NEAR.AI session token/API key or another configured provider produces a successful WebChat run and gateway status reports execution verified/GREEN.
- The Reborn sidecar still does not expose a working provider/model catalog endpoint in the installed build; model variety remains unproven at the real backend surface.
- Existing user settings may still contain an old persisted `llmModelId:"z-ai/glm-4.5"` from earlier defaults; this patch prevents unauthenticated NEAR.AI from exporting that as the child model env, but it does not rewrite user settings.

### Risks
- `IRONCLAW_DESKTOP_MODEL_READINESS_REASON` is passed to the child environment for honesty and future contract plumbing; if the Reborn gateway does not read this env yet, UI reason text still depends on gateway status fields already returned by Reborn.
- A vaulted `llm-nearai:<profile>` credential is treated as a NEAR.AI session token. If NEAR.AI later distinguishes session token vs API key in the settings UI, the credential-kind contract should be made explicit.
- This patch avoids the misleading concrete default; it does not create a working login/session-renewal flow.

### Next Agent Should Start Here
1. `cd /Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop && npm run tauri build`
2. Replace/relaunch `/Applications/IronClaw.app`, then capture `GET /api/health` and authenticated `GET /api/gateway/status` from the spawned sidecar; acceptance gate is `NEARAI_MODEL=auto` or the user-selected model only when NEAR.AI auth exists, plus a visible missing-auth reason in the rendered UI.
3. Configure a real `NEARAI_SESSION_TOKEN`, `NEARAI_API_KEY`, or vaulted `llm-nearai:<profile>` credential and run `node scripts/probe-live-reborn-assistant-run.mjs`; acceptance gate is a successful live WebChat run and gateway readiness moving to execution-verified/GREEN.

### Do Not Touch
- Do not reset, stash, revert, or overwrite dirty user/agent work.
- Do not print bearer tokens, Authorization headers, NEAR.AI credentials, or attachment base64.
- Do not remove the unverified-model send block to make demo chat appear to work.
- Do not claim model catalog/model variety is fixed until the real sidecar exposes and passes those endpoints.
- Do not rewrite the user's persisted settings file without an explicit migration/backup plan.

## Handoff: Phase 1.19 - Deployed Port Bootstrap and NEAR.AI Auto Default Proof

Status: YELLOW
Owner lane: Runtime | Static UI | Hostile QA

### Goal
Close the immediate shipped-app failure where the static WebUI could bootstrap from stale profile URLs (`127.0.0.1:3000`) while the real Tauri sidecar was running on a different port, and remove the misleading unauthenticated NEAR.AI `z-ai/glm-4.5` default from the desktop/static fallback path. Prove the fixed bundle in the packaged WebView, deploy it to `/Applications/IronClaw.app`, and leave the app running with an honest `NEAR.AI / auto` unverified state.

### Changed
- `crates/ironclaw_webui_v2_static/static/js/lib/api.js`: `bootstrapDesktopSession()` now asks Tauri `sidecar_status` first and stores the actual running sidecar origin before falling back to persisted profile URLs; default static chat model is now `auto`.
- `crates/ironclaw_webui_v2_static/static/js/main.bundle.js`: regenerated from the shared static source with `npm run prepare:webui-static`.
- `scripts/smoke-webui-static.mjs`: static smoke now seeds a deliberately stale `remoteBaseUrl` and requires the WebUI to follow the shimmed live sidecar port; expected NEAR.AI default copy changed to `auto`.
- `src-tauri/src/lib.rs`: integrated the runtime NEAR.AI credential fields at all `BackendConfig::Nearai` call sites and changed packaged auto-start to pass no concrete model when using unauthenticated NEAR.AI fallback.
- `src/lib/data/llm-defaults.ts`: NEAR.AI fallback default is now `auto`.
- `src/lib/components/ChatModelSelector.test.ts`, `src/lib/stores/settings.test.ts`, `tests/e2e/chat.spec.ts`: updated regressions so missing NEAR.AI model ids default to `auto`, while explicit unverified GLM fixtures still test gateway-reported failures.

### Verified
- `npm run prepare:webui-static`: passed and rebuilt `main.bundle.js`.
- `npm run smoke:webui-static`: passed; smoke uses stale profile `remoteBaseUrl: http://127.0.0.1:3000` and a runtime sidecar shim.
- `npx vitest run src/lib/components/ChatModelSelector.test.ts src/lib/stores/settings.test.ts src/lib/util/model-readiness.test.ts`: passed, 31/31.
- `npx svelte-check --tsconfig ./tsconfig.json`: passed, 0 errors/warnings.
- `CI=1 npx playwright test tests/e2e/chat.spec.ts -g "shows the active provider|chat blocks sends before dispatch" --reporter=line`: passed for the unverified-model block regression, 1/1 selected by Playwright grep.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `cargo test --manifest-path src-tauri/Cargo.toml runtime_model_auth_tests`: passed, 2/2.
- `npm run tauri build`: compiled the release app, produced `src-tauri/target/release/bundle/macos/IronClaw.app`, `IronClaw_0.4.157_aarch64.dmg`, and `.app.tar.gz`; final exit was the known updater-signing failure because `TAURI_SIGNING_PRIVATE_KEY` is unset.
- `npm run smoke:packaged -- --webview-smoke --wait 20`: passed, 12/12 WebView checks on the built bundle.
- `npm run smoke:packaged -- --webview-smoke --wait 20` while a dummy listener occupied port `3000`: passed, 12/12 WebView checks; runtime sidecar selected `3101`, and the WebView evidence used `http://127.0.0.1:3101`.
- Deployed built bundle to `/Applications/IronClaw.app` after moving the previous app to `/Applications/IronClaw.app.backup-20260602-091040`.
- `open /Applications/IronClaw.app`: launched deployed app; process `81296`, sidecar process `81308`.
- `curl http://127.0.0.1:3000/api/health`: passed with `{"channel":"webui-v2","status":"ok"}`.
- Authenticated `curl http://127.0.0.1:3000/api/gateway/status` using the local token file without printing the token: returned `llm_backend:"NEAR.AI"`, `llm_model:"auto"`, `model_execution_verified:false`, `model_readiness:"unverified"`.
- `npm run check`: passed, 0 Svelte errors/warnings.

### Evidence
- Static smoke result: terminal output `PASS webui static desktop bootstrap smoke`.
- Packaged smoke evidence, normal port path: `/tmp/ironclaw-packaged-webview-smoke-20260602-090604.json`; log `/tmp/ironclaw-packaged-smoke-20260602-090604.log`.
- Packaged smoke evidence, port-3000-blocked path: `/tmp/ironclaw-packaged-webview-smoke-20260602-090851.json`; log `/tmp/ironclaw-packaged-smoke-20260602-090851.log`.
- Port-blocked packaged evidence: gateway origin `http://127.0.0.1:3101`, 12/12 PASS, thread `34775f13-4f1e-4909-bd47-f078fbcae20d`, no orphaned smoke sidecar after termination.
- Deployed app proof: `/Applications/IronClaw.app` process `81296`; Reborn sidecar process `81308` listening on `127.0.0.1:3000`.
- Old orphan proof/cleanup: stale sidecar PID `72633` on `127.0.0.1:3100` was terminated after the deployed app launched on `3000`.
- Live deployed gateway truth: `NEAR.AI / auto`, `model_execution_verified:false`, `model_readiness:"unverified"`.

### Still RED
- Live assistant generation remains RED. The deployed app now truthfully blocks unverified model sends, but no NEAR.AI token/API key or alternate provider has produced a successful assistant run.
- Provider/model catalog remains RED. The live sidecar still lacks proven `/api/llm/providers`, model-list, and test-connection endpoints for real model variety.
- Existing persisted user settings may still contain old display values such as `llmModelId:"z-ai/glm-4.5"`; runtime sidecar boot now avoids exporting that concrete model when unauthenticated, but this pass did not rewrite user settings or localStorage.
- Updater signing remains RED until `TAURI_SIGNING_PRIVATE_KEY` is provided.

### Risks
- The deployed app is from the locally built `.app` bundle; the updater artifact was not signed because the private signing key is unavailable.
- `model_execution_verified:false` is the correct honest state, but it still feels like "chat does not work" until auth/model execution is fixed.
- The port-bootstrap fix is proven by first-party WebView smoke and static Playwright smoke, not manual clicking through every visible native surface.
- The old `/Applications` app was moved to a timestamped backup; keep that backup until the user confirms the deployed build is acceptable.

### Next Agent Should Start Here
1. `cd /Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop && curl -fsS http://127.0.0.1:3000/api/health`
2. Use the local token file only as a bearer source without printing it, then check `GET http://127.0.0.1:3000/api/gateway/status`; acceptance gate is `llm_model:"auto"` plus honest unverified readiness until credentials exist.
3. Configure a real `NEARAI_SESSION_TOKEN`, `NEARAI_API_KEY`, vaulted `llm-nearai:<profile>`, or a supported OpenRouter/OpenAI/Anthropic credential; then run `IRONCLAW_LIVE_PROBE_ORIGIN=http://127.0.0.1:3000 IRONCLAW_EXPECT_ASSISTANT=1 node scripts/probe-live-reborn-assistant-run.mjs`.
4. Do not move live Work Product out of RED until a successful assistant result is rendered, timeline-preserved, and export-validated from the deployed app.

### Do Not Touch
- Do not reset, stash, revert, or overwrite dirty user/agent work.
- Do not print bearer tokens, Authorization headers, NEAR.AI credentials, or attachment base64.
- Do not remove the unverified-model send block to make demo chat appear to work.
- Do not claim model catalog/model variety is fixed until the real sidecar exposes and passes those endpoints.
- Do not delete `/Applications/IronClaw.app.backup-20260602-091040` until the user approves.
