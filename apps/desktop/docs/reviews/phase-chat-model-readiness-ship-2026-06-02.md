## Handoff: Phase Chat Model Readiness Ship - 2026-06-02

Status: YELLOW
Owner lane: Static UI | Runtime | Hostile QA

### Goal
Stop IronClaw Desktop from accepting WebChat turns when the local Reborn gateway reports a configured but unverified model, remove misleading local OpenRouter picker affordances, and deploy a rebuilt app locally with a sidecar that can actually serve the WebUI.

### Changed
- crates/ironclaw_webui_v2_static/static/js/lib/model-readiness.js: configured/unverified model execution now blocks send and renders "Execution not verified".
- crates/ironclaw_webui_v2_static/static/js/pages/chat/components/chat-input.js: composer fallback readiness now fails closed and the static chat model control remains NEAR.AI-only for local desktop.
- crates/ironclaw_webui_v2_static/static/js/main.bundle.js: regenerated from the shared static WebUI.
- src/lib/util/model-readiness.ts: legacy Svelte readiness contract now also blocks unverified model execution.
- src/lib/components/ChatModelSelector.svelte: local sidecar chat model selector now filters provider choices to NEAR.AI only.
- scripts/smoke-webui-static.mjs: rendered smoke now asserts unverified model execution blocks sends, then verifies typed prompt plus PDF attachment payload after the mocked gateway becomes verified.
- Adjacent Reborn worktree, not committed here: `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw` has local patches for WebChat runner wake/alive hooks and driver timeout failure projection.

### Verified
- `npm run check`: passed, 0 Svelte diagnostics.
- `npm run verify:static-frontend`: passed.
- `node --test crates/ironclaw_webui_v2_static/static/js/lib/model-readiness.test.mjs`: passed, 6/6.
- `npx vitest run src/lib/util/model-readiness.test.ts src/lib/components/ChatModelSelector.test.ts`: passed, 10/10.
- `npm run smoke:webui-static`: passed after updating the smoke to the corrected fail-closed contract.
- `cargo check -p ironclaw_reborn -p ironclaw_reborn_composition -p ironclaw_product_workflow --lib`: passed in adjacent Reborn, with pre-existing product-auth dead-code warnings.
- `cargo build --release -p ironclaw_reborn_cli --features webui-v2-beta --bin ironclaw-reborn`: passed in adjacent Reborn.
- `src-tauri/binaries/ironclaw-reborn-aarch64-apple-darwin serve --help`: passed and proved the copied sidecar exposes the `serve` command.
- `npm run tauri -- build`: passed and produced `src-tauri/target/release/bundle/macos/IronClaw.app` plus `src-tauri/target/release/bundle/dmg/IronClaw_0.4.157_aarch64.dmg`.
- `bash scripts/smoke-packaged-app.sh --bundle src-tauri/target/release/bundle/macos/IronClaw.app --webview-smoke --wait 30`: passed with 12 WebView checks, healthy Reborn gateway, and no orphaned sidecar.

### Evidence
- Packaged smoke evidence: `/tmp/ironclaw-packaged-webview-smoke-20260602-153916.json`.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260602-153916.log`.
- Installed app sidecar SHA: `864cb70efe6a94f5d2c48ea8e52e764e89ba3279bbf1c41dddeb1e88db0bcce3`.
- Installed app health: `GET http://127.0.0.1:3000/api/health` returned `200 {"channel":"webui-v2","status":"ok"}`.
- Installed gateway status still truthfully reports `model_execution_verified:false` for `NEAR.AI / auto`; this should now block send in the installed UI instead of accepting a broken run.

### Still RED
- The live model is not execution-verified. User-visible chat will remain blocked until the gateway has working NEAR.AI credentials/model execution or reports a verified route.
- Reborn backend patches are local to `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw`, whose branch is behind upstream and has many unrelated dirty files. They are compiled into the installed local app sidecar but are not pushed from this desktop repo.
- Connectors are not proven green by this phase. This pass only prevents false-positive chat sends and stale local model choices.

### Risks
- Because `src-tauri/binaries/*` is git-ignored, a fresh checkout will need to rebuild/copy `ironclaw-reborn` with `--features webui-v2-beta` before packaging.
- A verified NEAR.AI route may still fail for account/provider reasons; the intended behavior is now to show a terminal/backend reason instead of silently losing the turn.

### Next Agent Should Start Here
1. In Reborn: isolate the local runner wake/timeout patch onto a clean branch from current `origin/reborn-integration`.
2. In Desktop: rerun packaged smoke after copying the clean Reborn sidecar into `src-tauri/binaries/ironclaw-reborn-aarch64-apple-darwin`.
3. Acceptance gate: live installed app can either send with a verified model and render an assistant reply, or clearly block with model/auth evidence before any POST.

### Do Not Touch
- Do not reintroduce OpenRouter/deepseek choices into the local static chat picker.
- Do not change unverified model readiness back to a send-enabled state.
- Do not commit or push the ignored sidecar binary from the desktop repo.
