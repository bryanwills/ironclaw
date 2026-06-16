# Hostile Product QA Process

This is the operating contract for IronClaw Desktop review loops. It exists
because code-only review missed fundamental UX failures: chat could report an
existing thread/message count while rendering no messages, and the Reborn chat
surface had no attachment path even though the product promise requires users
to bring files into work.

## Non-Negotiable Rule

A user-visible promise is not reviewed until it is exercised in the rendered
app.

Unit tests, type checks, and code inspection are necessary, but they are not
product proof. For any touched surface, the reviewer must capture one of:

- A Playwright/e2e flow that clicks/types/uploads through the actual UI.
- A browser/manual rendered-app smoke with the visible result described.
- A packaged-app smoke when packaging, Tauri shell behavior, keychain, or
  desktop-only behavior is involved.

If none of those exists, the surface is RED.

## Mandatory Red Conditions

Mark the pass RED and patch the process/test gap before calling the loop done
when any of these are true:

- A counter, badge, or list says data exists, but the detail surface is blank.
- A control is visible but has no working action behind it.
- A core affordance exists in one app mode but disappears in Reborn mode.
- An API request sends a catalog ref where the backend expects a lifecycle
  name.
- Onboarding, Get Started, or setup copy claims readiness that is not proven by
  a rendered click path.
- A reviewer says "seems" or "should" without a URL/request/test/screenshot
  citation.
- A mocked e2e path cannot distinguish a working user flow from a no-op.

## Product Contract Gauntlet

Each hostile loop must explicitly verify these surfaces against IronClaw Reborn
contracts:

| Surface             | Required proof                                                                         |
| ------------------- | -------------------------------------------------------------------------------------- |
| Onboarding          | Fresh-user path reaches the correct mode, not a stale wizard state.                    |
| Get Started         | Runner health gates connector setup; broken clients do not unlock.                     |
| Home / Reborn chat  | Empty chat, send flow, preexisting history, stream, and errors render.                 |
| Chat history        | A preexisting thread with nonzero count auto-opens and shows timeline rows.            |
| Chat attachments    | Picker/paste/drop creates chips and posts `attachments` in v2 send payload.            |
| Dashboard tiles     | Tiles reflect actual stores and navigate to working detail surfaces.                   |
| Missions            | Static and generated missions create or route durable work as claimed.                 |
| Extensions registry | Installed/registry tabs render, filter, and open setup correctly.                      |
| Setup drawer        | Notion/Gmail/GCal/Slack/workspace setup executes through canonical names.              |
| Deep links          | `tools/*`, `channels/*`, and `mcp-servers/*` URLs never hit lifecycle APIs raw.        |
| Command palette     | Connector/setup/search commands reach the same working paths as direct UI.             |
| Global search       | Search results navigate without stale refs or blank details.                           |
| Sidebar/nav         | Every first-level nav target loads and has a meaningful ready/empty/error state.       |
| Approvals/gates     | Approval UI can be reached, approved/denied, and correlated to the right run.          |
| Packaged app        | Fresh `.app` launches long enough to render; signing failure is called out separately. |

## Required Commands For A Touched UI Surface

Run the smallest meaningful set first, then broaden when the change touches
shared contracts:

```sh
npm run check
npx vitest run <focused unit files>
npm run test:e2e -- <focused Playwright specs> --project=chromium
npm run build
```

When Tauri or desktop behavior is touched:

```sh
npm run tauri build
npm run smoke:packaged
```

If updater signing fails locally because `TAURI_SIGNING_PRIVATE_KEY` is absent,
that is a packaging-signing blocker, not proof that the app failed to compile.
Still smoke-run the produced `.app` binary and record the result.

`npm run smoke:packaged` is mandatory overnight-loop evidence whenever a pass
claims packaged desktop health. It discovers the newest built
`src-tauri/target/**/bundle/macos/IronClaw.app`, launches the embedded binary
without installing it, captures logs under `/tmp`, verifies that it stays alive,
and terminates it cleanly. By default it runs with an isolated temporary `HOME`
and a smoke-only profile, so it does not use real connector tokens or perform
real external actions. Use `--use-current-profile` only for an explicitly
requested connected-machine smoke.

## Chat Regression Tests Added From This Failure

The current baseline includes rendered-app coverage for the two missed failures:

- `tests/e2e/chat.spec.ts` verifies an existing Reborn thread with legacy-shaped
  `id` and `message_count: 19` auto-opens and renders timeline `items`.
- `tests/e2e/chat.spec.ts` verifies `/?thread=<older-v2-thread>` opens that
  requested Reborn thread instead of blindly selecting the newest thread.
- `tests/e2e/chat.spec.ts` verifies a selected existing Reborn thread whose
  timeline fails shows a retryable load error instead of starter empty-state
  copy.
- `tests/e2e/chat.spec.ts` verifies the Reborn composer accepts `notes.md` and
  posts a v2 message body containing `attachments` after clicking the visible
  attach button.
- `src/lib/components/RebornChatPanel.test.ts` verifies auto-selecting the first
  thread, timeline load-error rendering, and sending attachment-only content
  through the controller.
- `src/lib/api/reborn.test.ts` verifies thread/timeline response normalizers
  tolerate Reborn and legacy wrapper shapes.
- `src/lib/api/reborn-transport.test.ts` and
  `src/lib/stores/reborn-chat.test.ts` verify v2 attachment payload forwarding.

## Active RED Backlog From 2026-06-01 Reviewers

These are not closed by this document; they are the next loop's test/patch
targets.

- Remove or quarantine direct `page.evaluate` connection-store mutations from
  connector/onboarding e2e. Prove readiness through mocked health/profile/API
  paths instead.
- Expand attachment rendered flows: remove before send, paste, drop overlay,
  unsupported type, oversized file, max count, send failure restores draft/chips,
  and post-send timeline reconciliation.
- Add connector-specific setup/readiness matrices for Notion, Gmail, Google
  Calendar, Slack, Slack search, and workspace packs, including failure,
  denied/cancelled auth, and reconnect after runner recovery.
- Add generated-mission rendered flow: generate, run, Work Item created,
  composer filled, no network send until user sends, approvals preserved, and
  disconnected runner disables generation.
- Add approval-gate rendered flow from mocked SSE: banner appears, approve/deny
  hit the correct endpoint, and chat resumes or stays blocked as expected.
- Add mobile/layout screenshots for chat composer attachments, Get Started
  locked/ready, connector setup drawer, and mission grid states.
- Expand packaged-app smoke beyond boot/liveness when safe mocked desktop
  probes exist: first-window render marker, keychain fallback signal, tray IPC,
  and updater-signing report.

## Reviewer Output Format

Every hostile reviewer must produce:

1. Product promises checked.
2. Rendered-app evidence for each promise.
3. RED gaps with exact missing test names or file paths.
4. Any false-positive unit coverage that does not exercise the user flow.
5. Highest-value next patch, with the smallest proof command that would catch it.

No pass should end with only prose recommendations when a regression test can be
added in the same loop.

## 2026-06-02 Hostile QA: Packaged App Model/Connection Recheck

Scope: QA evidence only. No product code was changed in this lane. This pass
attacked the latest user-visible complaint: the installed app appears
disconnected/not working, the model selector implies a model choice that is not
actually backed by a catalog, NEAR.AI Cloud is the intended default but not
execution-ready, and chat sends do not produce useful assistant work.

| Surface / promise | Status | Evidence | Hostile finding |
| --- | --- | --- | --- |
| Installed app renders the static UI | YELLOW | `output/hostile-qa/current-packaged-main-window-20260602T070257Z.png`; `output/hostile-qa/current-packaged-main-window-20260602T070257Z.txt` | The packaged app is alive and renders the static UI, but the visible surface was Extensions/Channels, not a completed chat proof. |
| Sidecar connectivity | YELLOW | `output/hostile-qa/live-route-probes-20260602T070159Z.txt` | The live sidecar is healthy on `127.0.0.1:3100`, while `127.0.0.1:3000` is dead. Desktop bootstrap can discover the running sidecar, but saved settings still say `mode:"remote"`, profile name `Local IronClaw (:3000)`, and `remoteBaseUrl:"http://127.0.0.1:3000"`. This is confusing and can still surface as disconnected/stale config. |
| NEAR.AI Cloud default can execute | RED | `/private/tmp/ironclaw-packaged-smoke-20260602-081816.log`; `output/hostile-qa/live-route-probes-20260602T070159Z.txt` | Gateway status reports `llm_backend:"NEAR.AI"` and `llm_model:"z-ai/glm-4.5"`, but `model_execution_verified:false`. The packaged smoke log shows `Session renewal failed for provider nearai: interactive session renewal is unavailable in this build; set NEARAI_SESSION_TOKEN or NEARAI_API_KEY env var instead`, followed by `model_credentials_unavailable`. |
| Model selector / model catalog truth | RED | `output/hostile-qa/live-route-probes-20260602T070159Z.txt` | The live packaged sidecar returns 404 for `/api/llm/providers`, `/api/llm/providers/nearai/models`, `/api/llm/list_models`, and `/api/llm/test_connection`. A real variety of models is not exposed by this sidecar, so any selector implying a live catalog is product-fiction until those routes or an equivalent catalog contract exist. |
| Unauthenticated protected routes | GREEN | `output/hostile-qa/live-route-probes-20260602T070159Z.txt` | `GET /api/webchat/v2/threads` without the local bearer returns 401. The auth gate itself is not silently open. |
| Chat send preserves user prompt and attachment through live Reborn routes | GREEN for persistence; RED for assistant result | `output/live-work-product-probe/reborn-live-chat-attachment-probe-2026-06-02T07-01-59-854Z.json`; `/private/tmp/ironclaw-packaged-webview-smoke-20260602-081816.json` | The live route accepted a message with `codex-live-route-probe.csv`, and timeline reload preserved the exact prompt plus extracted CSV text. Packaged WebView smoke also passed prompt/attachment preservation and export envelope checks. This does not prove the assistant can answer. |
| Assistant produces useful work after send | RED | `output/live-work-product-probe/reborn-live-assistant-run-probe-2026-06-02T07-01-59-839Z.json` | The adversarial assistant-run probe submitted successfully, preserved extracted attachment text, then ended `run_status:"Failed"`, `failure_category:"policy_denied"`, `assistant_message_count:0`, `assistant_marker_observed:false`. No assistant work product was produced. |
| Browser/static chat model-readiness screenshot | RED as process evidence | Aborted subprocess; no screenshot counted | A headless browser probe against `http://127.0.0.1:3100/chat` hung and was terminated. This pass does not claim browser-static chat screenshot proof from that run. |

Hostile conclusion: the current installed/static app is not a shippable
assistant yet. Transport/persistence is meaningfully better than the earlier
"message disappears" failure, but the product is still RED where the user cares
most: a default model path that can actually execute, a truthful model catalog,
and assistant work-product generation from chat.
