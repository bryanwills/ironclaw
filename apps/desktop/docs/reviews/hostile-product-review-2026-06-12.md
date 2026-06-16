# Hostile Product Review - 2026-06-12

## Handoff: Phase 1 - Product Truth And Surface Polish

Status: YELLOW
Owner lane: Static UI / Connector / Hostile QA

### Goal

Run an escalating hostile review against the current Reborn static desktop surface, remove obvious user-facing product lies, and make the normal desktop path feel like a NEAR AI Cloud chief-of-staff app instead of a gateway/debug console.

### Changed

- `crates/ironclaw_webui_v2_static/static/js/layout/gateway-layout.js`: made gateway outage copy route-aware so Settings and Connections no longer claim "Chat is paused".
- `crates/ironclaw_webui_v2_static/static/js/lib/model-readiness.js`: changed unknown gateway status to a blocked "Checking gateway" state and softened unverified execution to "Verification pending".
- `crates/ironclaw_webui_v2_static/static/js/pages/settings/*`: marked offline NEAR fallback providers as synthetic/unavailable, kept them out of the ready bucket, and relabeled API-key fallback as "Use NEAR API key".
- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/*`: renamed visible tabs to My apps, Messaging, Knowledge, and Browse; disabled curated connector cards unless the gateway actually exposes installable registry entries; added honest gateway-offline messaging states.
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/components/*`: disabled first-run prompt suggestions while setup blocks execution.
- `crates/ironclaw_webui_v2_static/static/js/pages/**/**/*.test.mjs`: added regression coverage for synthetic connector and provider fallback truth states.

### Verified

- Rendered desktop routes in Browser: `/chat`, `/settings/inference`, `/extensions/registry`, `/extensions/installed`, `/extensions/channels`, `/extensions/mcp`.
- Rendered mobile routes at 390px in Browser: `/chat`, `/settings/inference`, `/extensions/registry`.
- `node --test` focused static suites: 34/34 passed.
- `npm run test:static`: 290/290 passed.
- `npm run verify:static-frontend`: passed.
- `npm run smoke:webui-static`: passed.
- `npm run check`: 0 errors, 0 warnings.
- `npm run test`: 161 files, 1294 tests passed.
- `npm run tauri -- build`: produced `IronClaw.app` and `IronClaw_0.4.158_aarch64.dmg`.
- `npm run smoke:packaged`: passed; Reborn gateway healthy, app terminated cleanly, no orphan sidecar.

### Evidence

- Browser desktop matrix showed no raw gateway internals, no OpenRouter/Anthropic/Claude/ChatGPT/Qwen/GLM leaks, no `Ready to use`/`Ready to verify`, and no visible `Inference`, `Registry`, or `MCP Servers` labels on the checked English desktop routes.
- Browser mobile matrix showed no horizontal overflow at 390px on Settings, Browse, or Chat.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260612-070657.log`.

### Still RED

- Live connector OAuth/read-only tool calls were not proven in this pass; offline and empty-catalog states are honest, but real Gmail/Google Calendar/Notion/Slack login success still needs active gateway/account evidence.
- Work-product generation with real attached PDF/DOCX/XLSX inputs was not re-run in this pass; existing static export/attachment tests are green, but hostile end-to-end app scenarios should continue.

### Risks

- Non-English locales still carry older terminology for some settings labels through the existing missing-key baseline.
- Legacy Svelte reference surfaces still contain old provider/test terminology; this pass stayed scoped to the canonical static desktop UI.
- The UI now correctly disables synthetic connector installs; if the gateway registry is empty in a real packaged build, users see product direction but cannot connect until backend catalog projection is fixed.

### Next Agent Should Start Here

1. Run a live gateway connector gauntlet with real auth-capable fixtures and capture the exact `/api/webchat/v2/extensions/*` request/response sequence.
2. Run hostile work-product scenarios inside the app: PDF-to-DOCX agreement draft, XLSX analysis, CSV export, MD/HTML export, and reload persistence.

### Do Not Touch

- Do not reintroduce OpenRouter/Anthropic/OpenAI/Claude as normal desktop setup paths.
- Do not make slash-prefixed catalog refs into lifecycle route names.
- Do not mark connectors connected or providers ready without gateway evidence.

## Handoff: Phase 2 - Gateway-Unavailable Onboarding Guardrail

Status: YELLOW
Owner lane: Static UI / Hostile QA

### Goal

Escalate first-run testing from "gateway outage copy looks sane" to the more subtle empty-provider case where the gateway responds successfully but exposes no actionable NEAR AI Cloud provider.

### Changed

- `crates/ironclaw_webui_v2_static/static/js/pages/onboarding/onboarding-page.js`: first-run access now distinguishes real provider rows from fallback/synthetic rows. Loading, errored, empty, and synthetic-only provider snapshots are non-actionable.
- `scripts/smoke-webui-static.mjs`: added a rendered mobile and desktop welcome gauntlet for `{ providers: [], active: null }` LLM provider snapshots. It asserts the outage copy, disabled GitHub/Google/Wallet/API-key actions, no stale `:3000` requests, no raw gateway text, no hidden provider leaks, and no horizontal overflow.
- `scripts/smoke-webui-static.mjs`: the empty connector registry smoke now asserts curated connector cards are disabled as `Not available` and cannot emit synthetic install calls.

### Verified

- Live Browser check at `http://127.0.0.1:1425/v2/welcome` with the gateway pointed at a dead port: mobile 390px and desktop 1440px rendered the outage copy, disabled all four auth/setup actions, showed no raw gateway text, showed no OpenRouter/Anthropic/Claude/ChatGPT/Qwen/GLM leaks, and had no horizontal overflow.
- `npm run smoke:webui-static`: passed with the new empty-provider welcome gauntlet and empty-registry connector gauntlet.
- `npm run test:static`: 290/290 passed.
- `npm run verify:static-frontend`: passed.
- `npm run check`: 0 errors, 0 warnings.
- `npm run test`: 161 files, 1294 tests passed.
- `npm run tauri -- build`: produced `IronClaw.app` and `IronClaw_0.4.158_aarch64.dmg`.
- `npm run smoke:packaged`: passed; Reborn gateway healthy, app terminated cleanly, no orphan sidecar.

### Evidence

- Rendered Browser DOM check proved `/v2/welcome` disables `Sign in with GitHub`, `Use Google`, `Use NEAR Wallet`, and `Use API key` when the local gateway/provider snapshot is unavailable.
- Static smoke now proves the same contract on both mobile and desktop without relying on manual observation.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260612-072156.log`.

### Still RED

- Live connector OAuth/read-only tool calls are still not proven with active accounts.
- Live model-quality generation from real PDF/DOCX/XLSX inputs still needs active gateway/account evidence; the rendered app mechanics are covered by the Phase 3 smoke below.

### Risks

- The first-run surface is now intentionally inert until provider truth resolves. If the gateway is slow but healthy, users may briefly see "Checking the local gateway" instead of immediately clickable auth buttons.

### Next Agent Should Start Here

1. Run live connector OAuth/read-only setup with active token evidence, or document exact backend blockers.
2. Run live model-quality work-product scenarios with active NEAR AI Cloud execution: PDF-to-DOCX agreement draft, XLSX analysis, CSV export, MD/HTML export, and reload persistence.

### Do Not Touch

- Do not make fallback/synthetic NEAR rows actionable before backend provider truth resolves.
- Do not allow empty registry connector cards to call install/activate lifecycle endpoints.
- Do not expose old BYO provider setup as the normal desktop onboarding path.

## Handoff: Phase 3 - Rendered Work-Product File Matrix

Status: YELLOW
Owner lane: Static UI / Work Product / Hostile QA

### Goal

Escalate work-product proof from unit-level extractors/export builders to rendered app behavior: real file inputs through the composer, reload-safe attachment metadata, hidden embedded text, preview, and desktop-native save bytes for every assistant export format.

### Changed

- `scripts/smoke-webui-static.mjs`: added dependency-free stored-ZIP DOCX/XLSX fixtures so the rendered composer ingests valid Office documents, not only text-ish payloads and a PDF.
- `scripts/smoke-webui-static.mjs`: the Tauri shim now implements `save_bytes_dialog`, records the exported base64 bytes, and verifies those bytes after clicking the actual assistant export menu.
- `scripts/smoke-webui-static.mjs`: expanded the chat/work-product smoke to assert extracted text from PDF, DOCX, and XLSX reaches the Reborn message payload, durable attachment manifests preserve filenames without base64, embedded document text stays out of the visible transcript, preview shows retained text on demand, and exports are parseable.

### Verified

- `npm run smoke:webui-static`: passed with rendered composer upload of PDF, valid DOCX, valid XLSX, Markdown, JSON, HTML, and corrupt DOCX rejection.
- The same smoke clicked the actual assistant `Export` menu and verified desktop-native save bytes for Markdown, HTML, PDF, DOCX, JSON, Thread MD, and Thread JSON.

### Evidence

- Rendered attachment proof includes `services-template.docx` extracted marker `MSA-CLAUSE-17` and `pricing-model.xlsx` extracted row `Enterprise\t42000` in the posted Reborn payload.
- Export proof checks include PDF `%PDF-1.4` + `startxref`, DOCX `PK` + `word/document.xml`, structured assistant JSON, whole-thread Markdown with attachment names, and whole-thread JSON without `data_base64`.

### Still RED

- Live connector OAuth/read-only tool calls are still not proven with active accounts.
- Live model-quality generation from the uploaded documents is still not proven; the smoke uses a deterministic mocked assistant response to prove the app surfaces and persistence/export mechanics.

### Risks

- The rendered smoke is heavier now because it exercises real PDF/DOCX/XLSX extraction and seven export actions. It is intentionally hostile but may need timeout tuning if CI hardware is slow.

### Next Agent Should Start Here

1. Run live connector OAuth/read-only setup with active token evidence, or document exact backend blockers.
2. Run live model-quality work-product scenarios with active NEAR AI Cloud execution and inspect the generated agreement/spreadsheet/document quality, not just the UI mechanics.

### Do Not Touch

- Do not reduce work-product proof back to attachment chips alone.
- Do not treat browser anchor downloads as desktop proof; desktop exports must traverse `save_bytes_dialog`.
- Do not allow exported thread JSON to include base64 file payloads.

## Handoff: Phase 4 - Connector Activation Truth Hardening

Status: YELLOW
Owner lane: Connector / Static UI / Hostile QA

### Goal

Escalate connector proof from route-canonicalization to false-positive defense: if the gateway says a lifecycle action "completed" without proving credentials/readiness, the app must not show Connected.

### Changed

- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/hooks/useExtensions.js`: one-click connect and the lower-level Activate mutation now require explicit active/ready/connected phase evidence or credential/account proof plus activation proof. Blockers and negative readiness/auth flags always win.
- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/hooks/useConnectExtension.test.mjs`: added regression coverage for weak activation success and blocker-bearing responses.
- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/hooks/useExtensions-activation.test.mjs`: added mutation-level coverage so installed-extension activation cannot show a success toast from weak lifecycle success.
- `crates/ironclaw_webui_v2_static/static/js/main.bundle.js`: regenerated static bundle for the desktop shell.

### Verified

- Focused connector tests: `node --test crates/ironclaw_webui_v2_static/static/js/pages/extensions/hooks/useConnectExtension.test.mjs` passed 10/10.
- Focused activation mutation tests: `node --test crates/ironclaw_webui_v2_static/static/js/pages/extensions/hooks/useExtensions-activation.test.mjs` passed 2/2.
- `npm run test:static`: passed 294/294.
- `npm run verify:static-frontend`: passed.
- `npm run smoke:webui-static`: passed rendered static desktop bootstrap smoke.
- `npm run check`: 0 errors, 0 warnings.
- `npm run test`: 161 files, 1294 tests passed.
- `npm run tauri -- build`: produced `IronClaw.app` and `IronClaw_0.4.158_aarch64.dmg`.
- `npm run smoke:packaged`: passed; packaged app stayed alive, Reborn gateway healthy on port 3000, sidecar terminated cleanly.
- `node scripts/probe-live-reborn-connectors.mjs`: passed with no contract violations, while preserving known upstream activation false positives as defects.
- `IRONCLAW_PROBE_MODES=nearai node scripts/probe-live-reborn-model-execution.mjs`: send path accepted and no fake assistant reply; NEAR execution still honestly failed without local session/API-key credentials.

### Evidence

- Connector live probe artifact: `output/live-connector-probe/reborn-live-connector-probe-2026-06-12T11-40-56-983Z.json`.
- Model execution live probe artifact: `output/live-model-execution-probe/reborn-live-model-execution-2026-06-12T11-40-56-998Z.json`.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260612-074247.log`.
- Live probe still reports known upstream defects for Gmail, Google Calendar, and Notion: `POST /activate` can succeed without credentials and later report `authenticated:true`; the static UI now refuses weak activation responses without credential/readiness proof.

### Still RED

- Live Gmail/Google Calendar/Notion/Slack OAuth plus read-only tool proof still requires working backend OAuth/configured accounts. Current live evidence shows honest blocked states or upstream false-positive lifecycle behavior, not successful account use.
- Live model-quality work-product generation still requires an active NEAR AI Cloud session/API key. The probe proves no fake success, but not high-quality generated output.

### Risks

- If the backend continues returning only generic lifecycle success for genuinely connected extensions, users may see an error until the backend includes explicit readiness/credential proof. That is preferable to showing fake Connected.
- The UI hardening guards weak activation responses but cannot repair backend list endpoints that misreport installed connector readiness; those need backend contract fixes.

### Next Agent Should Start Here

1. Fix backend activation/list readiness so Gmail, Google Calendar, Notion, and Slack cannot report authenticated/active without credentials.
2. Re-run `node scripts/probe-live-reborn-connectors.mjs` with real accounts and add read-only tool-call proof.
3. Re-run live NEAR model execution with `NEARAI_SESSION_TOKEN` or `NEARAI_API_KEY` set and inspect generated PDF/DOCX/XLSX work-product quality.

### Do Not Touch

- Do not loosen `activationProvedConnected` back to accepting `success: true` alone.
- Do not hide backend false positives by filtering probe output.
- Do not claim live connector success until rendered UI clicks and captured Reborn requests prove account-level readiness.

## Handoff: Phase 5 - First-Run Surface Polish And Mobile Access Regression

Status: YELLOW
Owner lane: Static UI / Design-hostile QA

### Goal

Escalate design review from "copy is honest" to "the first screen feels like a credible desktop product and the setup controls are immediately reachable." The hostile finding was that first-run looked like a generic dark panel on empty space, and mobile pushed the actual sign-in controls below proof-point content.

### Changed

- `crates/ironclaw_webui_v2_static/static/js/pages/onboarding/onboarding-page.js`: first-run now leads with `IronClaw Desktop`, uses NEAR AI Cloud as the access step, adds structured trust rows, introduces an explicit gateway status callout, and renders disabled gateway-blocked auth actions as secondary controls instead of a fake-primary button.
- `crates/ironclaw_webui_v2_static/static/js/pages/onboarding/onboarding-page.js`: mobile order now shows the NEAR AI Cloud access panel before trust rows so GitHub/Google/Wallet/API-key controls are visible in the first viewport.
- `crates/ironclaw_webui_v2_static/static/js/i18n/en.js`: tightened first-run copy around agentic chief-of-staff value and NEAR AI Cloud access.
- `scripts/smoke-webui-static.mjs`: gateway-unavailable welcome smoke now asserts all four auth controls are present, disabled, and inside the first viewport on both mobile and desktop.
- `crates/ironclaw_webui_v2_static/static/js/main.bundle.js`: regenerated static bundle for the desktop shell.

### Verified

- Browser visual QA at `http://127.0.0.1:1420/v2/welcome` desktop 1440x920: page title `IronClaw`, no console errors/warnings, no horizontal overflow, disabled auth controls visible in first viewport.
- Browser visual QA at `http://127.0.0.1:1420/v2/welcome` mobile 390x844: no console errors/warnings, no horizontal overflow, all four auth controls visible in the first viewport after the reorder.
- `npm run smoke:webui-static`: passed with the new first-viewport auth-control assertion.
- `npm run test:static`: passed 294/294.
- `npm run verify:static-frontend`: passed.
- `npm run check`: 0 errors, 0 warnings.
- `npm run test`: 161 files, 1294 tests passed.
- `npm run tauri -- build`: produced `IronClaw.app` and `IronClaw_0.4.158_aarch64.dmg`.
- `npm run smoke:packaged`: passed; packaged app stayed alive, Reborn gateway healthy on port 3000, sidecar terminated cleanly.

### Evidence

- Browser rendered desktop copy includes `IronClaw Desktop`, `Connect NEAR AI Cloud`, and `Checking local gateway`; auth controls are disabled and in view.
- Browser rendered mobile auth-control positions after the fix: GitHub top 512/bottom 552, Google/Wallet top 560/bottom 592, API key top 600/bottom 632 inside an 844px viewport.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260612-075236.log`.

### Still RED

- This pass improves first-run design and regression coverage only. It does not prove live connector OAuth/read-only account use.
- Live model-quality work-product generation still requires active NEAR AI Cloud credentials.

### Risks

- Only English copy was tightened in this pass; non-English locales still follow the existing missing-key baseline and may retain older phrasing.
- The visual polish is first-run focused. Chat, Connections, Settings, and Work surfaces still need the same rendered hostile pass once live gateway fixtures are available.

### Next Agent Should Start Here

1. Continue the design-hostile pass on authenticated/fixture-backed chat, Connections, Settings, and Work routes.
2. Add screenshot-backed regression checks for chat model picker, attachment composer, connector setup drawer, and work-product export menus.
3. Pair backend connector readiness fixes with rendered route proof so the app can show real connected states without lying.

### Do Not Touch

- Do not move first-run auth controls below trust/proof content on mobile.
- Do not style disabled gateway-blocked auth actions as bright primary actions.
- Do not replace the product headline with provider/debug terminology.

## Handoff: Phase 6 - Chat Work Product Becomes A First-Class Artifact

Status: YELLOW
Owner lane: Static UI / Work Product / Design-hostile QA

### Goal

Escalate from "the assistant reply exists" to "the generated work product is visible, usable, and not buried inside chat." The hostile finding was that a services-agreement-style output rendered as a narrow assistant bubble with export controls nearby, which reinforced the user's complaint that work product disappeared into the transcript.

### Changed

- `crates/ironclaw_webui_v2_static/static/js/pages/chat/components/message-bubble.js`: assistant responses that look like document work product now render as wide artifact panels with a real border/background/shadow treatment instead of the normal gold hairline reply.
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/components/message-bubble.js`: added explicit outer/shell/body sizing helpers so artifact panels claim available chat width instead of shrink-wrapping to their Markdown text.
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/message-bubble.test.mjs`: added regression coverage for work-product detection, width classes, and ordinary assistant replies staying lightweight.
- `scripts/smoke-webui-static.mjs`: rendered chat smoke now fails if the mocked services-agreement work product is not visible as a wide `assistant-work-product` panel with document content intact.
- `crates/ironclaw_webui_v2_static/static/js/main.bundle.js` and `crates/ironclaw_webui_v2_static/static/styles/tailwind.generated.css`: regenerated static artifacts for the desktop shell.

### Verified

- Focused component test: `node --test crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/message-bubble.test.mjs` passed 7/7.
- `npm run smoke:webui-static`: passed; the rendered browser test uploaded PDF/DOCX/XLSX/MD/JSON/HTML fixtures, sent the prompt, rendered the services-agreement reply, asserted the artifact panel width was at least 520px, previewed retained attachment text, and verified all export bytes.
- Rendered screenshot inspected: `output/playwright/static-work-product-attachment-chat.png` now shows the generated `Services agreement` output as a standalone document panel with visible Save to Work and Export controls beneath it.
- In-app Browser QA at `http://127.0.0.1:17630/v2/chat`: local static app loaded with no console errors/warnings and honestly redirected to the gateway-unavailable NEAR AI Cloud first-run screen when no gateway mock/session was present.
- `npm run test:static`: passed 295/295.
- `npm run verify:static-frontend`: passed.
- `npm run check`: 0 errors, 0 warnings.
- `npm run test`: 161 files, 1294 tests passed.
- `npm run tauri -- build`: produced `IronClaw.app` and `IronClaw_0.4.158_aarch64.dmg`.
- `npm run smoke:packaged`: passed; packaged app stayed alive, Reborn gateway healthy on port 3000, sidecar terminated cleanly.

### Evidence

- The first rendered attempt failed exactly as intended with `width: 446.734375`; after fixing outer and body sizing, `npm run smoke:webui-static` passed.
- Screenshot artifact: `output/playwright/static-work-product-attachment-chat.png`.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260612-080403.log`.
- In-app Browser screenshot showed `IronClaw Desktop`, `Connect NEAR AI Cloud`, disabled GitHub/Google/Wallet/API-key controls, and zero console warnings/errors in the no-gateway local render.

### Still RED

- First-run `Settings` copy/button is misleading without a session: it calls `/settings/inference`, but the unauthenticated local shell redirects back to `/welcome`. Next design pass should either make it a real reachable setup route or remove the button styling when it cannot navigate.
- Live connector OAuth/read-only account use is still not proven with active accounts.
- Live model-quality work-product generation from user documents still requires active NEAR AI Cloud credentials; this pass proves the rendered artifact surface and export mechanics, not model quality.

### Risks

- Work-product detection is intentionally heuristic: Markdown headings, lists, or tables become artifact panels. Plain conversational assistant replies remain lightweight.
- Artifact panel styling is now substantially better, but the lower composer can still overlap part of long transcript evidence in screenshots; a later chat-layout pass should review scroll anchoring, "Jump to latest", and composer docking together.

### Next Agent Should Start Here

1. Fix or remove the dead first-run Settings affordance in unauthenticated/gateway-offline state.
2. Continue hostile design review on authenticated chat, Connections, Settings, and Work with fresh rendered screenshots.
3. Add live NEAR AI Cloud model-quality tests for PDF/DOCX/XLSX work-product generation once credentials are available.

### Do Not Touch

- Do not collapse generated document work product back into the normal assistant hairline reply.
- Do not claim work-product support from chips alone; keep rendered upload, preview, reload, and export-byte proof.
- Do not weaken the smoke width assertion without replacing it with better visual artifact proof.

## Handoff: Phase 7 - Remove Dead First-Run Settings Affordance

Status: YELLOW
Owner lane: Static UI / Design-hostile QA

### Goal

Close the hostile-design RED found during the in-app Browser pass: gateway-offline first-run rendered a `Settings` button even though unauthenticated users were redirected back to `/welcome`, making the control look actionable while doing nothing useful.

### Changed

- `crates/ironclaw_webui_v2_static/static/js/pages/onboarding/onboarding-page.js`: changed the inline `Settings` affordance from a button to non-clickable emphasized text on the first-run page.
- `scripts/smoke-webui-static.mjs`: gateway-unavailable welcome smoke now fails if a dead `Settings` button appears on mobile or desktop.
- `crates/ironclaw_webui_v2_static/static/js/main.bundle.js` and `crates/ironclaw_webui_v2_static/static/styles/tailwind.generated.css`: regenerated static artifacts for the desktop shell.

### Verified

- `npm run smoke:webui-static`: passed with the new no-dead-Settings-button assertion.
- `npm run test:static`: passed 295/295.
- `npm run verify:static-frontend`: passed.
- `npm run check`: 0 errors, 0 warnings.
- `npm run test`: 161 files, 1294 tests passed.
- `npm run tauri -- build`: produced `IronClaw.app` and `IronClaw_0.4.158_aarch64.dmg`.
- `npm run smoke:packaged`: passed; packaged app stayed alive, Reborn gateway healthy on port 3000, sidecar terminated cleanly.

### Evidence

- The same rendered first-run smoke still verifies all four auth controls are disabled and visible in the first viewport while gateway is unavailable.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260612-081141.log`.

### Still RED

- Live connector OAuth/read-only account use still needs active account evidence.
- Live NEAR AI Cloud model-quality output from real documents still needs credentials and human/product-quality inspection.
- Authenticated Settings and Connections still need a fresh design-hostile pass with live or fixture-backed gateway state.

### Risks

- This intentionally removes one misleading shortcut instead of solving unauthenticated access to Settings. If product wants Settings reachable before auth, that should be built as a real public setup route with its own routing contract.

### Next Agent Should Start Here

1. Run an authenticated/fixture-backed design-hostile pass on Connections and Settings.
2. Prove connector OAuth/readiness with active accounts or record exact backend blockers.
3. Exercise live NEAR AI Cloud work-product generation quality once credentials are available.

### Do Not Touch

- Do not reintroduce a first-run `Settings` button unless the target route is reachable in the same auth/gateway state.
- Do not make disabled or unreachable setup controls look primary/actionable.

## Handoff: Phase 8 - Chat Transcript Safe Zone And Jump Control

Status: YELLOW
Owner lane: Static UI / Chat Layout / Design-hostile QA

### Goal

Close the next rendered chat-design defect: after the work-product artifact fix, the composer and `Jump to latest` control could still visually cover the lower transcript area in the services-agreement smoke screenshot. The goal was to give the transcript a real safe zone and pin the jump control to the transcript/composer boundary instead of floating over message content.

### Changed

- `crates/ironclaw_webui_v2_static/static/js/pages/chat/components/message-list.js`: added explicit scroll/content/jump class helpers, bottom padding for the message viewport, and stable rendered geometry test ids.
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/components/message-list.js`: moved `Jump to latest` to the transcript/composer boundary with `bottom-0 translate-y-1/2`.
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/components/chat-input.js`: added `data-testid="chat-composer"` to the composer shell for rendered geometry checks.
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/message-list.test.mjs`: added unit coverage for transcript bottom safe space, boundary jump positioning, and stable smoke-test hooks.
- `scripts/smoke-webui-static.mjs`: rendered work-product smoke now asserts the transcript viewport does not overlap the composer, bottom padding is at least 96px, and the jump control stays pinned to the transcript/composer boundary.
- `crates/ironclaw_webui_v2_static/static/js/main.bundle.js` and `crates/ironclaw_webui_v2_static/static/styles/tailwind.generated.css`: regenerated static artifacts for the desktop shell.

### Verified

- Focused tests: `node --test crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/message-list.test.mjs crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/message-bubble.test.mjs crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/chat-input.test.mjs` passed 18/18.
- `npm run smoke:webui-static`: passed; rendered chat smoke now includes the transcript/composer geometry assertions.
- Screenshot inspected: `output/playwright/static-work-product-attachment-chat.png` shows the work-product artifact with visible actions and the jump pill at the composer boundary instead of over the agreement panel.
- `npm run test:static`: passed 297/297.
- `npm run verify:static-frontend`: passed.
- `npm run check`: 0 errors, 0 warnings.
- `npm run test`: 161 files, 1294 tests passed.
- `npm run tauri -- build`: produced `IronClaw.app` and `IronClaw_0.4.158_aarch64.dmg`.
- `npm run smoke:packaged`: passed; packaged app stayed alive, Reborn gateway healthy on port 3000, sidecar terminated cleanly.

### Evidence

- Rendered screenshot artifact: `output/playwright/static-work-product-attachment-chat.png`.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260612-082137.log`.
- The smoke's geometry check reads `[data-testid="chat-message-scroll"]`, `[data-testid="chat-composer"]`, and `[data-testid="chat-jump-to-latest"]` from the rendered browser and fails if the composer overlaps the transcript viewport or if jump drifts back into message content.

### Still RED

- The jump control still slightly overlaps the top edge of the composer by design; a deeper chat redesign could move it into a dedicated composer toolbar, but it no longer sits over the work-product artifact or attachment text.
- Live connector OAuth/read-only account use still needs active account evidence.
- Live NEAR AI Cloud model-quality output from real documents still needs credentials and human/product-quality inspection.
- Authenticated Settings and Connections still need a fresh design-hostile pass with live or fixture-backed gateway state.

### Risks

- This fixes the chat transcript/composer safe zone but not the broader chat information architecture. Long attachment stacks can still dominate the viewport; a later pass should consider collapsing large attachment groups after send.

### Next Agent Should Start Here

1. Run a design-hostile pass on large attachment stacks and consider a compact sent-attachments treatment.
2. Run authenticated/fixture-backed design QA on Connections and Settings.
3. Prove connector OAuth/readiness with active accounts or record exact backend blockers.

### Do Not Touch

- Do not remove the rendered geometry smoke hooks without replacing them with stronger browser-visible proof.
- Do not collapse transcript bottom padding back to generic `py-6`.

## Handoff: Phase 9 - Compact Sent Attachment Stacks And Reject Truth

Status: YELLOW
Owner lane: Static UI / Chat Layout / Work Product / Design-hostile QA

### Goal

Escalate the chat-design review from "the composer no longer covers the transcript" to "a realistic services-agreement turn with many files stays readable and truthful." The hostile finding was that large sent attachment groups could dominate the viewport. The rendered rerun also exposed a deeper truth bug: rejected/corrupt files were filtered out of the Reborn payload but could still appear in the optimistic sent bubble.

### Changed

- `crates/ironclaw_webui_v2_static/static/js/pages/chat/components/message-bubble.js`: user messages with more than three attachments now render as a compact stack with a file-count summary, first three files, and explicit expand/collapse controls.
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/components/message-bubble.js`: sent attachment evidence labels now understand `modelReadable` metadata instead of downgrading readable optimistic chips to metadata-only copy.
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/hooks/useComposerAttachments.js`: corrupt, encrypted, unreadable-large, and failed extraction files are removed from composer attachment state after the rejection notice, so they cannot look sendable.
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/hooks/useChat.js`: optimistic user bubbles are now built from the same sendable attachment set that Reborn receives; empty-payload/rejected attachments are excluded from the transcript.
- `crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/message-bubble.test.mjs` and `crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/useChat-send.test.mjs`: added focused coverage for compact attachment stacks, `modelReadable` labels, and rejected attachments staying out of Reborn payloads and optimistic chips.
- `scripts/smoke-webui-static.mjs`: rendered work-product smoke now targets the newest sent attachment stack, asserts it is compact by default, asserts rejected corrupt DOCX is absent, expands the stack, and proves all valid files become visible.
- `crates/ironclaw_webui_v2_static/static/js/main.bundle.js` and `crates/ironclaw_webui_v2_static/static/styles/tailwind.generated.css`: regenerated static artifacts for the desktop shell.

### Verified

- Focused tests: `node --test crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/message-bubble.test.mjs` passed 8/8.
- Focused tests: `node --test crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/useChat-send.test.mjs` passed 7/7.
- `npm run smoke:webui-static`: passed; rendered chat smoke uploads PDF/DOCX/XLSX/MD/JSON/HTML plus corrupt DOCX, proves corrupt DOCX is rejected, proves the latest sent stack shows 7 valid files as 3 visible + `Show 4 more files`, expands to every valid file, previews retained text, and verifies export bytes.
- `npm run test:static`: passed 298/298.
- `npm run verify:static-frontend`: passed.
- `npm run check`: 0 errors, 0 warnings.
- `npm run test`: 161 files, 1294 tests passed.
- `npm run tauri -- build`: produced `IronClaw.app` and `IronClaw_0.4.158_aarch64.dmg`.
- `npm run smoke:packaged`: passed; packaged app stayed alive, Reborn gateway healthy on port 3000, sidecar terminated cleanly.

### Evidence

- Rendered collapsed screenshot artifact: `output/playwright/static-work-product-attachment-chat-collapsed.png`.
- Rendered expanded/preview/export screenshot artifact: `output/playwright/static-work-product-attachment-chat.png`.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260612-083736.log`.
- The first stricter rendered inspection caught the old bug: the optimistic bubble said `8 files attached` after the corrupt DOCX was rejected. The current smoke now fails if that rejected file appears in the newest sent stack, collapsed or expanded.

### Still RED

- Live connector OAuth/read-only account use still needs active account evidence.
- Live NEAR AI Cloud model-quality output from real documents still needs credentials and human/product-quality inspection.
- Authenticated Settings and Connections still need a fresh design-hostile pass with live or fixture-backed gateway state.
- Timeline-projected mocked attachment stacks can still show metadata-only summary copy when the fixture manifest does not carry embedded text; the payload path is proven, but richer backend projection would improve reload copy.

### Risks

- Hidden attachments require one click after send. This is the intended tradeoff for readability, but the expanded path and previews must remain tested.
- Rejected extractable files now disappear from the composer after the rejection notice. That is more truthful, but users only have the notice as the explanation; future polish could add a rejected-files drawer if repeated failures need history.

### Next Agent Should Start Here

1. Run authenticated/fixture-backed design QA on Connections and Settings.
2. Prove connector OAuth/readiness with active accounts or record exact backend blockers.
3. Run live NEAR AI Cloud work-product generation quality on real PDF/DOCX/XLSX prompts once credentials are available.

### Do Not Touch

- Do not show all large sent attachment stacks by default again.
- Do not render attachments in optimistic user bubbles unless they have a sendable payload.
- Do not weaken the rendered smoke to target the first historical attachment stack; it must test the newest sent turn.

## Handoff: Phase 10 - First-Class NEAR AI Model Selection

Status: YELLOW
Owner lane: Static UI / Settings / Design-hostile QA / Runtime

### Goal

Close the repeated product complaint that users cannot tell what model IronClaw is using or change it cleanly. The model selector must be first-class in AI setup, route through NEAR AI Cloud only, avoid hidden provider-key complexity, and keep chat in sync after applying a model.

### Changed

- `crates/ironclaw_webui_v2_static/static/js/pages/settings/components/provider-management.js`: added a first-class `active-model-panel` above provider rows, showing the current active NEAR AI Cloud model and exposing model selection through the same set-active route used by chat.
- `crates/ironclaw_webui_v2_static/static/js/pages/settings/components/provider-card.js`: moved model selection out of expanded provider rows, kept provider rows focused on status/details, and normalized the nearai provider label to `NEAR AI Cloud`.
- `crates/ironclaw_webui_v2_static/static/js/design-system/input.js`: added optional `wrapperClassName` support for `Select`, so compact Settings controls can keep select + action button inline.
- `crates/ironclaw_webui_v2_static/static/js/pages/settings/components/provider-components.test.mjs`: added coverage proving model selection lives in the first-class Settings panel and no longer leaks `onListModels`/`onApplyModel` into provider rows.
- `scripts/smoke-webui-static.mjs`: fixture-backed rendered smoke now visits `/settings/inference`, loads the active model panel, fetches NEAR AI Cloud models, applies `nearai:gpt-oss-120b`, asserts `/api/webchat/v2/llm/list-models` and `/api/webchat/v2/llm/active` request bodies, verifies OpenRouter/deepseek/Anthropic stay hidden, screenshots the Settings surface, and verifies chat shows the newly active model.
- `crates/ironclaw_webui_v2_static/static/js/main.bundle.js` and `crates/ironclaw_webui_v2_static/static/styles/tailwind.generated.css`: regenerated static artifacts for the desktop shell.

### Verified

- Focused component test: `node --test crates/ironclaw_webui_v2_static/static/js/pages/settings/components/provider-components.test.mjs` passed 9/9.
- `npm run smoke:webui-static`: passed; rendered Settings flow applies `nearai:gpt-oss-120b` and chat model chip reflects `NEAR AI Cloud · nearai:gpt-oss-120b`.
- Rendered screenshot inspected: `output/playwright/static-settings-active-model.png` shows the current model panel, inline model picker + Apply button, and no OpenRouter/Anthropic visible provider setup.
- In-app Browser QA at `http://127.0.0.1:1420/v2/settings/inference`: no-fixture local render loaded `IronClaw`, showed the honest first-run/gateway-checking NEAR AI Cloud state, and produced zero console warnings/errors.
- `npm run test:static`: passed 299/299.
- `npm run verify:static-frontend`: passed.
- `npm run check`: 0 errors, 0 warnings.
- `npm run test`: 161 files, 1294 tests passed.
- `npm run tauri -- build`: produced `IronClaw.app` and `IronClaw_0.4.158_aarch64.dmg`.
- `npm run smoke:packaged`: passed; packaged app stayed alive, Reborn gateway healthy on port 3000, sidecar terminated cleanly.

### Evidence

- Rendered Settings screenshot artifact: `output/playwright/static-settings-active-model.png`.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260612-085822.log`.
- Request evidence is in `scripts/smoke-webui-static.mjs`: the smoke records `llmListModelRequests` and `llmActiveRequests` and fails unless the active model request is `{ provider_id: "nearai", model: "nearai:gpt-oss-120b" }`.
- The first rendered smoke attempt caught a strict ambiguity between the model badge and native `<option>` text; the final smoke scopes to the visible badge and attached option, so the test proves the actual UI without flaky text matching.

### Still RED

- Authenticated Connections still need a fixture-backed or live design-hostile pass equivalent to this Settings pass.
- Live connector OAuth/read-only account use still needs active account evidence or exact backend blockers.
- Live NEAR AI Cloud model-quality output from real documents still needs credentials and human/product-quality inspection.
- The top `Model path` summary card still uses heavier mono styling than the rest of the surface; later design cleanup should rationalize Settings typography globally.

### Risks

- The model picker proves the lifecycle/request contract, not the quality of any specific model response.
- `wrapperClassName` on the shared `Select` is intentionally additive; future component cleanups should avoid turning it into a second styling API with conflicting size rules.

### Next Agent Should Start Here

1. Run the same hostile fixture-backed treatment on Connections: Gmail, Google Calendar, Notion, Slack, workspace, setup drawers, readiness, and canonical lifecycle route names.
2. Rationalize Settings typography and reduce mono overuse across `Model path`, Google sign-in, and provider detail rows.
3. Run live NEAR AI Cloud document-generation quality checks once credentials are available.

### Do Not Touch

- Do not bury the active model selector back inside expanded provider rows.
- Do not expose hidden provider-key surfaces such as OpenRouter/Anthropic in normal desktop Settings.
- Do not claim model-selection support without rendered request evidence through `/api/webchat/v2/llm/list-models` and `/api/webchat/v2/llm/active`.

## Handoff: Phase 11 - Connector Setup Modal Design Contract

Status: YELLOW
Owner lane: Static UI / Connections / Connector Setup / Design-hostile QA

### Goal

Escalate the Connections pass from route correctness to actual setup-surface quality. The Gmail setup drawer/modal is the first thing a user sees when trying to make connectors useful, so it must stop looking like a legacy dark-mode leftover, use the shared v2 input language, and remain covered by rendered connector-route evidence.

### Changed

- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/configure-modal.js`: replaced legacy `iron-*`, `white/*`, red utility, and generic `v2-panel` modal styling with v2 tokenized surfaces, shared `Input` fields, clearer label hierarchy, an accessible dialog shell, and a stable `connector-setup-modal` test id.
- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/configure-modal.test.mjs`: added a focused VM component test proving the modal uses the shared `Input` component and does not reintroduce modal-local `text-white`, `text-iron-*`, `border-white`, or `bg-white/*` classes.
- `scripts/smoke-webui-static.mjs`: extended the fixture-backed Gmail configure flow to open the rendered setup modal, assert no legacy dark-surface classes leak into the modal subtree, screenshot it, then continue proving manual token submission fails honestly instead of claiming a live connector.
- `crates/ironclaw_webui_v2_static/static/js/main.bundle.js` and `crates/ironclaw_webui_v2_static/static/styles/tailwind.generated.css`: regenerated static artifacts for the desktop shell.

### Verified

- Focused component test: `node --test crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/configure-modal.test.mjs` passed 1/1.
- `npm run smoke:webui-static`: passed; rendered Connections flow deep-links Gmail with a slash-prefixed catalog ref, confirms the lifecycle path stays bare, opens `Configure Gmail`, screenshots the modal, and proves failed setup remains an honest blocked state.
- Rendered screenshot inspected: `output/playwright/static-connector-setup-modal.png` shows a cleaner centered Gmail setup dialog with shared inputs, tokenized text colors, and no old translucent dark-form fields.
- In-app Browser sanity at `http://127.0.0.1:1420/v2/welcome`: title `IronClaw`, meaningful welcome content, zero console warnings/errors. This does not prove connector behavior because Browser cannot apply the smoke gateway fixture; connector behavior is proven by the fixture-backed Playwright smoke.
- `npm run test:static`: passed 300/300.
- `npm run verify:static-frontend`: passed.
- `npm run check`: 0 errors, 0 warnings.
- `npm run test`: 161 files, 1294 tests passed.
- `npm run tauri -- build`: produced `IronClaw.app` and `IronClaw_0.4.158_aarch64.dmg`.
- `npm run smoke:packaged`: passed; packaged app stayed alive, Reborn gateway healthy on port 3000, sidecar terminated cleanly.

### Evidence

- Rendered connector setup screenshot artifact: `output/playwright/static-connector-setup-modal.png`.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260612-091156.log`.
- Request evidence is in `scripts/smoke-webui-static.mjs`: the smoke fails unless Gmail and Slack deep links call bare lifecycle setup routes and no slash-prefixed catalog ref leaks into lifecycle requests.
- The first stricter rendered modal smoke failed on shared `Button` primary `text-white`; the final source-level modal test still bans modal-local `text-white`, while rendered smoke focuses on legacy extension-surface classes that should never appear inside the setup shell.

### Still RED

- Live connector OAuth/read-only account use still needs active account evidence or exact backend blockers.
- The wider Connections page behind the modal still looks too flat and low-confidence in fixture screenshots; registry cards, installed cards, setup guidance, and empty/blocked states need the same tokenized design pass.
- In-app Browser welcome still reads dark/heavy overall; it is functional and console-clean, but not yet at the visual quality bar for a product people should trust immediately.
- Live NEAR AI Cloud model-quality output from real documents still needs credentials and human/product-quality inspection.

### Risks

- This pass improves the setup modal shell, not the full connector auth backend. It deliberately preserves honest failed/blocked state after manual token submission.
- The shared `Button` primary variant still uses `text-white`, which is acceptable for accent buttons. The modal source test prevents local legacy white text from creeping back into headings and labels.

### Next Agent Should Start Here

1. Run the next hostile Connections pass on the full `/extensions/installed` and registry surfaces: card hierarchy, blocked-state copy, Gmail/GCal/Notion/Slack/workspace setup guidance, and empty catalog behavior.
2. Continue replacing compatibility styling in extension components with explicit v2 tokens and shared design-system controls, backed by rendered smoke screenshots.
3. Run live connector OAuth/readiness probes with active accounts if credentials become available; otherwise keep the UI in honest blocked/needs-auth states and cite exact HTTP evidence.

### Do Not Touch

- Do not weaken canonical connector routing: slash-prefixed catalog ids remain catalog refs only; lifecycle calls must use bare extension names.
- Do not claim connectors are connected from package-install success or weak activation responses.
- Do not remove the rendered modal class guard from `npm run smoke:webui-static`; it caught real product drift in the path users hit when trying to connect Gmail.

## Handoff: Phase 12 - Connections Surface Tokenization Pass

Status: YELLOW
Owner lane: Static UI / Connections / Design-hostile QA / Runtime

### Goal

Escalate the Connections review from one fixed setup modal to the surrounding product surface. The hostile finding was that Browse, My apps, Messaging, Knowledge, pairing, and toast states still carried old dark-era utility classes and `.v2-panel` compatibility styling, making the product look patched together even when routes were correct.

### Changed

- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/installed-tab.js`, `mcp-tab.js`, and `channels-tab.js`: replaced legacy `.v2-panel` sections with shared `Card`/`CardLabel` components and v2 tokenized text/border styling.
- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/registry-tab.js`: moved registry search to shared `Input`, tokenized result count and empty state, and kept core connector fallback cards honest when the catalog is unavailable.
- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/pairing-section.js`: moved Slack/manual pairing input to shared `Input`, replaced white translucent surfaces and red/emerald utility status text with v2 tokens, and kept pairing submit behavior unchanged.
- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/action-toast.js`, `extension-card.js`, and `extensions-page.js`: tokenized toast tones, connector guidance, and loading row separators.
- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/extensions-design-contract.test.mjs`: added a source-level contract test preventing legacy `text-iron-*`, `border-white`, `bg-white/*`, `text-signal`, `mint`, and red utility classes from returning to Connections surfaces.
- `scripts/smoke-webui-static.mjs`: extended the rendered Connections gauntlet to screenshot empty Browse and installed My apps, and to fail if either surface renders legacy Connections classes.
- `crates/ironclaw_webui_v2_static/static/js/main.bundle.js` and `crates/ironclaw_webui_v2_static/static/styles/tailwind.generated.css`: regenerated static artifacts for the desktop shell.

### Verified

- Focused Connections tests: `node --test ...extensions-design-contract.test.mjs ...pairing-section.test.mjs ...registry-tab.test.mjs ...channels-tab.test.mjs ...configure-modal.test.mjs` passed 12/12.
- `npm run smoke:webui-static`: passed; rendered smoke captured empty Browse and installed My apps, verified no legacy Connections classes, reopened Gmail setup, and rechecked canonical bare lifecycle setup routes.
- Rendered screenshot inspected: `output/playwright/static-connections-registry-empty.png` shows the Browse fallback with honest `Catalog unavailable` state and disabled curated cards.
- Rendered screenshot inspected: `output/playwright/static-connections-installed-polished.png` shows installed Gmail/GCal/Notion/Slack cards with tokenized setup guidance and no old translucent dark panels.
- `npm run test:static`: passed 301/301.
- `npm run verify:static-frontend`: passed.
- `npm run check`: 0 errors, 0 warnings.
- `npm run test`: 161 files, 1294 tests passed.
- `npm run tauri -- build`: produced `IronClaw.app` and `IronClaw_0.4.158_aarch64.dmg`.
- `npm run smoke:packaged`: passed; packaged app stayed alive, Reborn gateway healthy on port 3000, sidecar terminated cleanly.

### Evidence

- Rendered Browse screenshot artifact: `output/playwright/static-connections-registry-empty.png`.
- Rendered installed Connections screenshot artifact: `output/playwright/static-connections-installed-polished.png`.
- Rendered setup modal screenshot artifact remains: `output/playwright/static-connector-setup-modal.png`.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260612-092318.log`.
- Browser plugin sanity navigation to `http://127.0.0.1:1420/v2/extensions/registry` was attempted but blocked by the in-app browser with `ERR_BLOCKED_BY_CLIENT`; fixture-backed Playwright smoke remains the valid rendered evidence for this pass.

### Still RED

- Live connector OAuth/read-only account use still needs active account evidence or exact backend blockers.
- Connections is cleaner but still conservative and operational; it is not yet a premium first-run “connect everything in minutes” experience.
- The broader desktop visual system still leans too flat/light in authenticated surfaces and too dark/heavy in the unauthenticated welcome surface.
- Live NEAR AI Cloud model-quality output from real documents still needs credentials and human/product-quality inspection.

### Risks

- This pass intentionally avoids changing connector semantics. The UI still says blocked/unavailable when the gateway cannot prove catalog/auth readiness.
- The source contract is broad for Connections files. If future design-system work needs a one-off utility class, it should add an explicit tokenized replacement instead of weakening the guard.

### Next Agent Should Start Here

1. Escalate from tokenization to product hierarchy: make Connections explain what each app unlocks, what is blocked, and the fastest next action without dense card sameness.
2. Run live connector OAuth/readiness probes with active accounts if credentials become available; otherwise preserve honest blocked states and exact HTTP evidence.
3. Continue the design-hostile pass on Chat and Settings surfaces that still feel flat or confusing under real gateway states.

### Do Not Touch

- Do not reintroduce legacy dark-era classes to Connections surfaces; keep `extensions-design-contract.test.mjs` strict.
- Do not make synthetic core connector cards actionable when the registry is empty.
- Do not claim connector readiness from installed/package lifecycle success alone.

## Handoff: Phase 13 - Connections Card Hierarchy Polish

Status: YELLOW
Owner lane: Static UI / Connections / Design-hostile QA

### Goal

Escalate from token cleanup to product readability. The installed connector cards were technically cleaner after Phase 12, but still looked like dense admin tiles: repeated `No capabilities`, gray slabs, underlined setup links, and empty footers made the page feel lower-trust than the product promise.

### Changed

- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/extension-card.js`: card surfaces now use `--v2-card-bg` plus subtle shadow, with a lighter hover border instead of gray-heavy slabs.
- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/extension-card.js`: removed noisy `No capabilities` placeholder rows and hides empty footers when a connector has no capabilities and no primary action.
- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/extension-card.js`: connector setup guidance now uses a normal secondary CTA button instead of an underlined ghost-link treatment.
- `crates/ironclaw_webui_v2_static/static/js/main.bundle.js` and `crates/ironclaw_webui_v2_static/static/styles/tailwind.generated.css`: regenerated static artifacts for the desktop shell.

### Verified

- Focused tests: `node --test ...extensions-design-contract.test.mjs ...registry-tab.test.mjs ...configure-modal.test.mjs` passed 7/7.
- `npm run smoke:webui-static`: passed; rendered installed Connections screenshot refreshed with quieter cards, setup CTAs, no legacy Connections classes, and canonical connector route assertions still green.
- Rendered screenshot inspected: `output/playwright/static-connections-installed-polished.png` shows cleaner installed cards with less noise and no empty capability rows.
- `npm run test:static`: passed 301/301.
- `npm run verify:static-frontend`: passed.
- `npm run check`: 0 errors, 0 warnings.
- `npm run test`: 161 files, 1294 tests passed.
- `npm run tauri -- build`: produced `IronClaw.app` and `IronClaw_0.4.158_aarch64.dmg`.
- `npm run smoke:packaged`: passed; packaged app stayed alive, Reborn gateway healthy on port 3000, sidecar terminated cleanly.

### Evidence

- Rendered installed Connections screenshot artifact: `output/playwright/static-connections-installed-polished.png`.
- Rendered Browse screenshot artifact remains: `output/playwright/static-connections-registry-empty.png`.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260612-093045.log`.

### Still RED

- Live connector OAuth/read-only account use still needs active account evidence or exact backend blockers.
- Connections needs a deeper product flow pass: OAuth/client-id blockers should become a guided setup journey, not repeated warning panels.
- The broader desktop visual system still needs a proper top-down art direction pass, especially welcome, chat, and Settings.
- Live NEAR AI Cloud model-quality output from real documents still needs credentials and human/product-quality inspection.

### Risks

- Hiding `No capabilities` reduces noise but also removes an explicit absence marker. This is intentional for user-facing polish; backend/tool capability proof should come from real connector readiness, not filler text.
- The hover/focus border can appear in screenshots when the cursor lands on a card. That is acceptable, but future screenshot scripts can move the pointer away before capture if needed.

### Next Agent Should Start Here

1. Convert repeated connector blockers into a guided setup flow for Google, Notion, Slack, and workspace files.
2. Continue hostile design QA on welcome/chat/Settings using fresh rendered screenshots rather than source-only reviews.
3. Run live connector OAuth/readiness probes with active accounts if credentials become available.

### Do Not Touch

- Do not bring back fake `No capabilities` filler on user-facing connector cards.
- Do not weaken the no-legacy Connections design contract.
- Do not change connector readiness semantics without rendered route/request evidence.

## Handoff: Phase 14 - NEAR-Only Product Surface and GitHub Page Cleanup

Status: YELLOW
Owner lane: Static UI / Settings / Chat Model Surface / Product Docs / Design-hostile QA

### Goal

Escalate from Connections polish to the user-visible promise mismatch: normal desktop UI and public GitHub screenshots must not imply that IronClaw is a generic ChatGPT/OpenAI/Anthropic/OpenRouter provider manager. The normal product path is NEAR AI Cloud, with broader Reborn provider plumbing hidden until an explicit advanced mode exists.

### Changed

- `crates/ironclaw_webui_v2_static/static/js/pages/settings/components/provider-management.js`: added a defensive render-boundary NEAR AI Cloud filter before provider grouping, row rendering, and setup-dialog ID validation. This prevents hidden providers from leaking even if a caller hands the component a broader Reborn provider snapshot.
- `crates/ironclaw_webui_v2_static/static/js/pages/settings/components/provider-components.test.mjs`: changed the provider-management test contract from "renders OpenAI/Anthropic rows" to "hides non-NEAR providers at the render boundary" and added a search test proving hidden provider queries do not reveal hidden rows.
- `README.md`: rewrote the GitHub-facing setup/tour copy around NEAR AI Cloud, Connections, and focused model selection; removed ChatGPT/OpenAI/Anthropic/Ollama/OpenRouter as normal desktop setup paths.
- `docs/screenshots/*.png`: replaced stale GitHub/README screenshots that showed ChatGPT/Anthropic/OpenAI/provider soup with fresh current captures for NEAR-only onboarding, chat attachment/work-product flow, and NEAR-only AI setup.
- `crates/ironclaw_webui_v2_static/static/js/main.bundle.js`: regenerated static artifacts for the desktop shell.

### Verified

- Focused provider/chat tests: `node --test ...provider-components.test.mjs ...llm-providers.test.mjs ...useLlmProviders.test.mjs ...chat-input.test.mjs` passed 36/36.
- `npm run prepare:webui-static && npm run smoke:webui-static`: passed; the smoke fixture deliberately includes `OpenRouter`, and the rendered Settings/chat gauntlet fails if OpenRouter/deepseek/Anthropic leak into the normal product surface.
- README onboarding capture: `output/playwright/static-readme-onboarding.png` was rendered against a mock payload that included hidden OpenRouter data and failed on hidden-provider or blocked-gateway copy; final capture shows NEAR AI Cloud actions only.
- Rendered screenshot inspected: `output/playwright/static-settings-active-model.png` shows Settings -> AI setup with NEAR AI Cloud as the only visible model path.
- Rendered screenshot inspected: `output/playwright/static-work-product-attachment-chat-collapsed.png` shows chat preserving attachments, output, and export affordances with a NEAR AI Cloud model chip.
- `npm run test:static`: passed 301/301.
- `npm run verify:static-frontend`: passed.
- `npm run check`: 0 errors, 0 warnings.
- `npm run test`: 161 files, 1294 tests passed.
- `npm run tauri -- build`: produced `IronClaw.app` and `IronClaw_0.4.158_aarch64.dmg`.
- `npm run smoke:packaged`: passed; packaged app stayed alive, Reborn gateway healthy on port 3000, sidecar terminated cleanly.

### Evidence

- README screenshots now point at refreshed files under `docs/screenshots/`.
- Rendered onboarding proof: `output/playwright/static-readme-onboarding.png`.
- Rendered AI setup proof: `output/playwright/static-settings-active-model.png`.
- Rendered chat/work-product proof: `output/playwright/static-work-product-attachment-chat-collapsed.png`.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260612-094454.log`.

### Still RED

- Live NEAR AI Cloud OAuth/session and real model execution still need active account evidence; this pass proves the UI hides other provider paths and stays honest under fixture evidence.
- Google/Notion/Slack live connector OAuth remains backend/account dependent; UI shows setup/blocked states rather than claiming connected.
- The product still needs a deeper visual direction pass beyond cleanup: onboarding is clearer, but Settings remains dense and Connections needs a guided setup journey.

### Risks

- Hidden provider plumbing still exists in Reborn-compatible code and tests because the backend supports it. The desktop product boundary is enforced in normal UI, not deleted from lower-level helpers.
- README screenshots are 1400 x 950 fresh static captures instead of the older 2560 x 1720 assets. This is acceptable for GitHub rendering and removes misleading stale product imagery.

### Next Agent Should Start Here

1. Continue design-hostile QA on Settings density: reduce nested card feeling, make Google sign-in setup read as a guided path, and keep all blocked states honest.
2. Run live NEAR AI Cloud sign-in/model execution with credentials and document whether the UI reaches an active provider snapshot or an exact HTTP/auth blocker.
3. Convert repeated connector blockers into a guided setup flow for Google, Notion, Slack, and workspace files.

### Do Not Touch

- Do not reintroduce ChatGPT/OpenAI/Anthropic/OpenRouter/Ollama as normal desktop onboarding, chat model, Settings, README, or screenshot paths.
- Do not weaken the OpenRouter hidden-provider assertions in `scripts/smoke-webui-static.mjs`.
- Do not claim connector or model readiness without rendered request evidence or live account evidence.

## Handoff: Phase 15 - Issue 4775 Acceptance Surface and Connector Favicons

Status: YELLOW
Owner lane: Connections / Static UI / Settings / Product-contract QA

### Goal

Escalate the hostile product review from local UI polish to the canonical Reborn QA acceptance surface in [nearai/ironclaw#4775](https://github.com/nearai/ironclaw/issues/4775). The desktop product must visibly support the connector families behind the eight QA workflows, show recognizable app marks for real services, keep unavailable catalog entries honest, and simplify the AI setup surface so normal users see NEAR AI Cloud model control rather than provider-admin clutter.

### Changed

- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/extension-card.js`: added local inline connector app icons for Gmail, Google Calendar, Google Drive, Google Sheets, Notion, Slack, Telegram, GitHub, Web/HTTP, Routines, workspace files, and generic connector fallbacks; wired icons into installed and registry cards.
- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/registry-tab.js`: expanded `CORE_CONNECTIONS` to cover the issue-4775 acceptance primitives: Telegram, Gmail, Calendar, Drive, Slack, GitHub, Sheets, Web/HTTP, routines, and local workspace files; fixed category pills so Web and Routines do not appear as files.
- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/lib/extension-actions.js`: extended Google-family connector detection to Drive, Sheets, and Docs so those routes use the same honest Google OAuth setup guidance.
- `scripts/smoke-webui-static.mjs`: rendered smoke now fails unless the empty-catalog Browse surface shows all issue-4775 acceptance apps and all expected `data-connector-icon` kinds.
- `crates/ironclaw_webui_v2_static/static/js/pages/settings/components/inference-tab.js`: removed the nested "Connect NEAR AI Cloud" disclosure; NEAR AI Cloud model management is now first-class in AI setup.
- `crates/ironclaw_webui_v2_static/static/js/pages/settings/components/provider-management.js`: active NEAR AI Cloud no longer renders as a redundant provider row; the active state collapses into the model panel, with setup rows reserved for actual setup/repair states.
- `crates/ironclaw_webui_v2_static/static/js/i18n/en.js`: replaced debug-ish `Model path`/`Backend` copy with `AI runtime`, `Model access`, and `Active model`.
- `crates/ironclaw_webui_v2_static/static/js/main.bundle.js` and `static/styles/tailwind.generated.css`: regenerated shipped static artifacts.

### Verified

- Issue 4775 source reviewed via `gh issue view 4775 --repo nearai/ironclaw`; canonical acceptance workflows are the eight QA use cases listed in that issue.
- Focused tests passed: 34 component/lib tests covering issue-4775 surface mapping, connector icon mapping, Google-family setup, v2 Connections styling, and Settings/NEAR AI setup contracts.
- `npm run prepare:webui-static && npm run smoke:webui-static`: passed; rendered smoke now asserts Gmail, Calendar, Drive, Sheets, Notion, Slack, Telegram, GitHub, Web/HTTP, Routines, and Workspace files all appear with expected connector icon kinds and no fake install calls.
- `npm run test:static`: passed 307/307.
- `npm run verify:static-frontend`: passed.
- `npm run check`: 0 errors, 0 warnings.
- `npm run test`: 161 files, 1294 tests passed.
- `npm run tauri -- build`: produced `IronClaw.app` and `IronClaw_0.4.158_aarch64.dmg`.
- `npm run smoke:packaged`: passed; packaged app stayed alive, native windows were detected, Reborn gateway was healthy on port 3000, and sidecar terminated cleanly.

### Evidence

- Rendered Connections acceptance surface: `output/playwright/static-connections-registry-empty.png`.
- Rendered main work-product/chat surface: `output/playwright/static-work-product-attachment-chat-collapsed.png`.
- Rendered AI setup/model surface: `output/playwright/static-settings-active-model.png`.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260612-100740.log`.

### Still RED

- This pass proves the desktop UI acceptance surface, not live connector end-to-end behavior. Google OAuth, Slack install/pairing, Telegram, GitHub, Drive, Sheets, and external-service live paths still require backend/account evidence.
- Browser e2e against `ironclaw-reborn serve` for every issue-4775 use case remains an upstream Reborn test-project gap.
- Chat still needs a broader art-direction pass; the current surface is more functional and honest, but not yet the final "people want to live here" design quality.

### Risks

- New catalog refs such as `tools/google_drive`, `tools/google_sheets`, `channels/telegram`, and `tools/github` are shown only as disabled fallback catalog expectations when the registry is empty. They must not be sent as lifecycle `ExtensionName` values unless the gateway exposes canonical install/setup routes.
- Inline app marks are local approximations of familiar favicons. This avoids remote image dependencies in the packaged app, but future brand assets may need legal/design review before release marketing.

### Next Agent Should Start Here

1. Build real guided setup flows for Google-family connectors, Slack, Notion, Telegram, GitHub, Drive, and Sheets as the backend exposes routes.
2. Add a Reborn browser e2e project that drives issue-4775 workflows from rendered WebUI, not HTTP-only mocks.
3. Continue hostile design QA on Chat first-run and work-product layout with fresh screenshots; reduce remaining debug-ish badges and make the chief-of-staff loop feel intentional.

### Do Not Touch

- Do not remove the issue-4775 acceptance surface assertions from `registry-tab.test.mjs` or `scripts/smoke-webui-static.mjs`.
- Do not make synthetic/core connector cards actionable when the gateway catalog is unavailable.
- Do not send slash-prefixed catalog refs as extension lifecycle names.

## Handoff: Phase 16 - Chief-of-Staff Workflow Recipes

Status: YELLOW
Owner lane: Connections / Static UI / Product-contract QA

### Goal

Move the Connections Browse surface from a list of app tiles toward the product promise: users should immediately see the high-value chief-of-staff work loops IronClaw is meant to run. This phase maps the eight canonical issue-4775 QA workflows to visible workflow cards, shows the required app marks beside each workflow, and proves a recipe can safely prefill chat without pretending live connectors are already configured.

### Changed

- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/registry-tab.js`: added `ACCEPTANCE_WORKFLOWS` for the eight issue-4775 scenarios, plus a rendered "Chief-of-staff workflows" panel with required connector chips, honest gateway/catalog status, and `Draft prompt` links into chat.
- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/registry-tab.test.mjs`: added product-contract tests requiring every issue-4775 use case to have a workflow recipe, mapped connector surfaces, useful prompt draft, and honest offline/catalog status labels.
- `scripts/smoke-webui-static.mjs`: rendered smoke now asserts every workflow appears, captures `output/playwright/static-acceptance-workflows.png`, clicks `Draft prompt for Daily news digest`, proves the chat composer contains a Telegram/NEAR AI/routine draft, and captures `output/playwright/static-acceptance-workflow-chat-prefill.png`.
- `scripts/capture-readme-shots.mjs`: expanded the README screenshot harness to mock registry/provider routes and include an `extensions-registry` capture surface so public screenshots can cover the new Connections Browse experience.
- `crates/ironclaw_webui_v2_static/static/js/main.bundle.js` and `crates/ironclaw_webui_v2_static/static/styles/tailwind.generated.css`: regenerated shipped static artifacts.

### Verified

- Branch/main status checked after `git fetch --all --prune`: `codex/nearai-first-product-polish` is 16 commits ahead of `nearai/main` and 0 behind; `origin/main` is older than `nearai/main`.
- Issue 4775 source re-read via `gh issue view 4775 --repo nearai/ironclaw`; the canonical acceptance surface remains the same eight workflows.
- Focused test: `node --test crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/registry-tab.test.mjs` passed 11/11.
- `npm run prepare:webui-static && npm run smoke:webui-static`: passed; rendered workflow section and workflow-to-chat prefill are now part of the smoke.
- `npm run test:static`: passed 310/310.
- `npm run verify:static-frontend`: passed.
- `npm run check`: 0 errors, 0 warnings.
- `npm run test`: 161 files, 1294 tests passed.
- `npm run tauri -- build`: produced `src-tauri/target/release/bundle/macos/IronClaw.app` and `src-tauri/target/release/bundle/dmg/IronClaw_0.4.158_aarch64.dmg`.
- `npm run smoke:packaged`: passed; packaged app stayed alive, native windows were detected, Reborn gateway was healthy on port 3000, and sidecar terminated cleanly.
- Browser plugin attempted against `http://127.0.0.1:17660/v2/extensions/registry` and `http://localhost:17660/v2/extensions/registry`; the server was reachable by `curl`, but the in-app Browser landed on an internal `ERR_CONNECTION_REFUSED` interstitial and does not expose request interception/init-script hooks needed for the mocked gateway path.

### Evidence

- Rendered workflow section: `output/playwright/static-acceptance-workflows.png`.
- Rendered workflow chat prefill: `output/playwright/static-acceptance-workflow-chat-prefill.png`.
- Rendered Connections acceptance surface: `output/playwright/static-connections-registry-empty.png`.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260612-105920.log`.

### Still RED

- Live connector end-to-end behavior is still unproven. Google OAuth, Slack install/pairing, Telegram, GitHub, Drive, Sheets, and external-service execution still require backend/account evidence.
- The workflow recipes prefill chat; they do not yet run the issue-4775 workflows through live Reborn browser e2e or fixture-backed model execution.
- Browser plugin local-route verification is blocked in this environment despite shell reachability; rendered proof currently comes from the repo Playwright smoke.

### Risks

- Workflow recipes could feel aspirational if backend connector routes remain unavailable. The UI mitigates this by showing `Waiting on app catalog` and preserving disabled connector install states.
- The recipe prompts are deliberately concise; real production prompts may need localization, prompt-quality review, and backend affordances for scheduling/routine creation.
- README screenshot capture now includes a registry route with mocked entries. Keep it aligned with any future changes to the Connections Browse contract.

### Next Agent Should Start Here

1. Add a fixture-backed Reborn browser e2e harness that drives one of these workflow draft prompts through rendered chat and verifies the expected gate/tool sequence.
2. Build guided setup journeys for Google-family, Slack, Notion, Telegram, GitHub, Drive, and Sheets once backend setup/readiness routes are exposed.
3. Continue hostile design QA on the workflow panel below the first fold: validate mobile layout, all eight cards, and whether `Draft prompt` should become a stronger guided launch action.

### Do Not Touch

- Do not remove the issue-4775 workflow recipe assertions from `registry-tab.test.mjs` or `scripts/smoke-webui-static.mjs`.
- Do not make workflow cards claim they are runnable while the app catalog or live connector readiness is unavailable.
- Do not send slash-prefixed catalog refs as extension lifecycle names.

## Handoff: Phase 17 - Partial Catalog Workflow Truth

Status: YELLOW
Owner lane: Connections / Static UI / Product-contract QA

### Goal

Close the next hostile-review gap in the chief-of-staff workflow surface: a non-empty connector catalog is not the same as a complete catalog. The workflow panel must not imply a workflow is ready when one of its required app connectors is absent from the gateway registry.

### Changed

- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/registry-tab.js`: added catalog-aware workflow readiness. Each workflow now distinguishes `Gateway offline`, `Waiting on app catalog`, `Ready to connect`, and explicit missing-app counts.
- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/registry-tab.js`: missing workflow connector chips are now visually highlighted with warning styling and `data-workflow-surface-state="missing"` while available/built-in chips remain neutral.
- `crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/registry-tab.test.mjs`: added tests for partial-catalog workflow truth, including the important invariant that built-in Web/HTTP/Routines surfaces do not count as missing connector apps.
- `scripts/smoke-webui-static.mjs`: rendered smoke now drives both empty-catalog and partial-catalog registry states; it asserts ready workflows, missing-app workflow labels, missing chip states, page-wide core connector favicons, workflow-scoped issue-4775 favicons, and captures a dedicated partial-catalog screenshot.
- `crates/ironclaw_webui_v2_static/static/js/main.bundle.js`: regenerated shipped static artifact.

### Verified

- Focused test: `node --test crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/registry-tab.test.mjs` passed 13/13.
- `npm run smoke:webui-static`: passed after the workflow-scoped favicon assertion; rendered smoke now covers partial catalog truth, issue-4775 workflow connector marks, and workflow-to-chat prefill.
- `npm run test:static`: passed 312/312.
- `npm run verify:static-frontend`: passed.
- `npm run check`: 0 errors, 0 warnings.
- `npm run test`: 161 files, 1294 tests passed.
- `npm run tauri -- build`: produced `src-tauri/target/release/bundle/macos/IronClaw.app` and `src-tauri/target/release/bundle/dmg/IronClaw_0.4.158_aarch64.dmg`.
- `npm run smoke:packaged`: passed; packaged app stayed alive, native windows were detected, Reborn gateway was healthy on port 3000, and sidecar terminated cleanly.
- In-app Browser opened `http://127.0.0.1:17770/v2/`; route resolved to `/v2/welcome`, title was `IronClaw`, DOM contained the NEAR AI Cloud first-run surface, and console warnings/errors were empty. Browser-native screenshot capture timed out in this environment, so visible screenshot evidence remains the Playwright artifacts below.

### Evidence

- Rendered partial-catalog workflow truth: `output/playwright/static-acceptance-workflows-partial-catalog.png`.
- Rendered empty-catalog workflow section: `output/playwright/static-acceptance-workflows.png`.
- Rendered workflow chat prefill: `output/playwright/static-acceptance-workflow-chat-prefill.png`.
- Rendered main chat/work-product surface: `output/playwright/static-work-product-attachment-chat-collapsed.png`.
- Packaged smoke log: `/tmp/ironclaw-packaged-smoke-20260612-114518.log`.

### Still RED

- This pass proves catalog truth in the UI, not live connector setup/execution. Google OAuth, Slack install/pairing, Telegram, GitHub, Drive, Sheets, and external-service execution still need backend/account evidence.
- Workflow cards still use `Draft prompt` rather than a richer guided setup/run journey.
- The issue-4775 workflows are still not covered by a real Reborn browser e2e harness that approves gates and verifies tool sequences.

### Risks

- Catalog matching accepts both package refs and entry ids to tolerate gateway registry shape variations. If the gateway starts exposing a new canonical id scheme, extend `catalogKeys` and tests rather than weakening missing-app detection.
- Warning styling now appears inside workflow chips. Keep contrast readable in any future theme pass.

### Next Agent Should Start Here

1. Build a guided workflow launch path for one workflow: start with Daily news digest, show required apps, missing setup, and then route to chat only when the user explicitly chooses to draft/run.
2. Add a fixture-backed e2e route for one issue-4775 workflow from rendered chat through expected gate/tool sequence.
3. Run mobile visual QA for the workflow cards, especially the missing-app chip wrapping and bottom action row.

### Do Not Touch

- Do not collapse partial-catalog status back into generic `Connect required apps`.
- Do not count built-in Web/HTTP/Routines surfaces as missing connector apps.
- Do not make missing workflows look runnable or connected without backend readiness evidence.

## Handoff: Phase 18 - Preview Runtime Truth And README Screenshots

Status: YELLOW
Owner lane: Static UI / Docs / Product-contract QA

### Goal

Close the immediate user-confusion gap where `http://127.0.0.1:<port>/v2/welcome`
looked like the broken desktop app. The browser-only static preview must be
honest that it cannot start the Tauri sidecar or native auth bridge, and the
README must stop implying that static smoke proves live OAuth.

### Changed

- `crates/ironclaw_webui_v2_static/static/js/pages/onboarding/onboarding-page.js`:
  split gateway-unavailable onboarding copy between desktop runtime and browser
  preview runtime. Browser previews now say `Static preview needs a gateway`
  and tell users to run `npm run tauri dev` for sign-in.
- `scripts/smoke-webui-static.mjs`: added rendered coverage for browser-preview
  gateway truth, including disabled auth buttons and the absence of desktop
  retry copy.
- `README.md`: clarified `npm run tauri dev` versus `npm run dev:webui-static`,
  corrected the sidebar surface count, removed stale top-level Automations copy,
  and added the refreshed Connections/workflow screenshot.
- `docs/STATIC_WEBUI_SYNC.md`: documented the preview-versus-desktop runtime
  contract and explicitly bans claiming live OAuth, connector execution, or
  sidecar behavior from browser-only static preview.
- `docs/screenshots/connections-workflows.png` and
  `docs/screenshots/github-page-connections.png`: added refreshed Connections
  and workflow setup screenshots for docs/GitHub presentation.
- `crates/ironclaw_webui_v2_static/static/js/main.bundle.js`: regenerated the
  shipped static artifact.

### Verified

- `npm run prepare:webui-static`: passed and regenerated the static bundle.
- `npm run smoke:webui-static`: passed with the new browser-preview gateway
  assertion.
- Visual inspection confirmed the new static-preview screenshot shows the
  correct blocked state and copy, and the refreshed Connections screenshot shows
  the workflow/setup surface.

### Evidence

- Browser-preview truth screenshot:
  `output/playwright/static-preview-gateway-unavailable.png`.
- Refreshed Connections/workflow screenshot:
  `docs/screenshots/github-page-connections.png`.
- Rendered workflow smoke screenshot:
  `output/playwright/static-acceptance-workflows.png`.

### Still RED

- Live OAuth and external connector execution still require real desktop runtime
  evidence with a running sidecar, a valid NEAR AI Cloud session, and backend
  connector routes. This pass intentionally does not fake that.
- `npm run dev:webui-static` remains a deterministic UI preview and smoke-test
  target, not a product-auth proof.

### Risks

- A user can still confuse the preview for the app if they ignore the runtime
  copy and docs. The UI now states the limitation in the first-run surface
  itself, but product/auth verification still belongs in Tauri.

### Next Agent Should Start Here

1. Run `npm run tauri dev` or packaged smoke with a real NEAR AI Cloud session
   and record live auth/connector evidence.
2. Prove one connector setup/execution path end to end from the desktop runtime,
   including actual request URLs and readiness state.
3. Keep README screenshots synced whenever top-level navigation, onboarding, or
   Connections/workflow IA changes.

### Do Not Touch

- Do not claim live OAuth, connector execution, or sidecar readiness from static
  smoke.
- Do not re-add Automations as a top-level README surface unless it is visibly
  restored in the shipped sidebar.
- Do not remove the browser-preview truth copy unless the static preview gains a
  real sidecar/auth bridge.
