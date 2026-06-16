# Hostile Routing Review

Evidence-bound skeleton for reviewing whether hostile, ambiguous, or high-risk asks are routed into durable Work Items with the right runbook, missing-context state, approval boundary, artifact plan, and follow-up/watch state before any external or mutating work happens.

Line references are from the local worktree when this review was drafted. If parent edits move line numbers, use the nearby symbol named in the citation.

## 2026-06-01 Process Recalibration

This review now depends on the stricter product QA contract in
`docs/reviews/hostile-product-qa-process.md`. A loop is not "done" when code
looks plausible or units pass. Any user-visible promise must be proven in the
rendered app, and any touched desktop behavior must be smoked in the packaged
app when relevant.

The immediate misses that triggered this recalibration were fundamental:

- Reborn chat could show an existing conversation/message-count state while no
  thread was selected and no timeline was loaded.
- Reborn chat had no attachment affordance even though legacy chat had one and
  the product promise requires bringing files into work.

New mandatory proof added from this failure:

- A Playwright flow for a preexisting Reborn thread with legacy-shaped `id` and
  `message_count: 19` auto-opening and rendering timeline rows.
- A Playwright flow for uploading an attachment through the Reborn composer and
  verifying the v2 send request contains `attachments`.
- Unit/transport/controller coverage for response normalization and attachment
  forwarding so the rendered flow is backed by stable contracts.

## 2026-06-01 Multi-Agent Orchestration Pass

This pass closed the highest-value "static mission bypasses Work" gap and made
the overnight loop itself harder to fool.

- `src/lib/util/workflow-orchestrator.ts` adds a conservative
  Chief-of-Staff workflow gate. It distinguishes ordinary chat from serious
  work, treats unclear risky asks as `needs_clarification`, marks those as
  no-execute decisions, and maps first-run missions into runbooks, context,
  approval boundaries, artifacts, and watches.
- `src/lib/components/MissionLauncher.svelte` now creates a durable Work Item
  before launching a first-run mission into chat. The composer receives a
  Work Item prefix; the Work Item carries a `mission` link so the action is
  inspectable in `/work` instead of being only chat prose.
- `src/lib/util/workflow-scenarios.ts` and
  `docs/reviews/practical-work-scenario-corpus.md` add an executable hostile
  scenario corpus for coding, legal, finance, research, operations,
  multi-domain work, underspecified asks, and prompt-injection/approval-bypass
  attempts.
- `scripts/smoke-packaged-app.sh` and `npm run smoke:packaged` add repeatable
  packaged-app liveness evidence for every loop that claims desktop health.

Verification from this pass:

- `npm run check` passed with 0 errors / 0 warnings.
- `npx vitest run` passed 153 files / 1215 tests.
- `npm run test:e2e -- tests/e2e/chat.spec.ts tests/e2e/extensions-reborn.spec.ts tests/e2e/onboarding.spec.ts tests/e2e/command-palette-connectors.spec.ts tests/e2e/desk-generated-missions.spec.ts tests/e2e/work.spec.ts --project=chromium` passed 14/14.
- `npm run build` passed with existing chunk-size/dynamic-import warnings.
- `npm run tauri build` compiled and produced
  `src-tauri/target/release/bundle/macos/IronClaw.app` and the DMG, then
  stopped at updater signing because `TAURI_SIGNING_PRIVATE_KEY` is absent.
- `npm run smoke:packaged` passed against both the fresh build artifact and
  the deployed `/Applications/IronClaw.app`.

## 2026-06-01 Approval, Connector, And Packaged-App Pass

This pass specifically attacked the user-reported failures: registry-only
connectors such as Notion/Gmail/Google Calendar/Slack did not set up correctly,
slash-prefixed catalog refs could leak into Reborn lifecycle calls, and risky
chat could still look approval-gated while dispatching too early. The follow-up
chat pass also closed the opaque default-model failure: the user can now see and
change the provider/model from the Reborn chat surface itself.

Closed in this pass:

- `src/lib/components/RebornChatPanel.svelte` now creates a local Work Item and
  blocks risky Reborn chat sends before any v2 dispatch. The user must choose
  `Approve and send` for the guarded message to leave the desktop. The e2e
  test proves no assistant response is produced before approval, and that the
  resulting Work Item records an approved `send` boundary and thread link.
- `src/lib/stores/work-items.svelte.ts` now supports approving or denying a
  specific approval boundary. `/work` exposes those actions and recalculates
  lifecycle state from denied approvals, missing dossier inputs, and remaining
  pending approvals.
- `src/routes/extensions/+page.svelte` now treats slash-prefixed registry IDs
  (`tools/gmail`, `channels/slack`, `mcp-servers/notion`) as catalog refs only.
  Registry-only setup deep links install the bare Reborn name (`gmail`,
  `slack`, `notion`) with the right kind and then open the setup drawer against
  `/api/extensions/<bare-name>/setup`.
- `tests/e2e/command-palette-connectors.spec.ts` no longer mutates the
  connection store directly. It verifies the command-palette connector action
  through mocked gateway readiness, registry install, and setup-drawer requests.
- `/extensions` readiness gates now require an actual connected Reborn client,
  not only a stale status string, before loading or installing connector data.
- `scripts/style-guard.sh` now backs the CI workflow and fails on current
  hardcoded NEAR accent literals outside token files.
- `src/lib/components/ChatModelSelector.svelte` adds an in-chat provider/model
  control. It reads the LLM provider catalog, displays the gateway-reported
  running provider/model when available, saves `llmModelId` on the active
  profile, and offers a runner restart when local-sidecar changes need a
  restart to take effect.
- `src-tauri/src/sidecar.rs` and `src-tauri/src/lib.rs` now pass the selected
  model into local runner env (`NEARAI_MODEL` or `LLM_MODEL`) instead of
  hardcoding NEAR.AI to `auto`.
- `src/routes/settings/LlmProviderPicker.svelte` no longer renders model choice
  as a disabled fake field; Settings and chat share the same persisted
  `llmModelId` profile field.
- The local macOS app was bumped to `0.4.154`, bundled, installed to
  `/Applications/IronClaw.app`, and smoked from an isolated profile.

Verification from this pass:

- `bash scripts/style-guard.sh` passed after removing the last hardcoded
  current-accent literals from `/extensions`.
- `npm run check` passed with 0 errors / 0 warnings.
- `git diff --check` passed.
- `npx vitest run` passed 154 files / 1220 tests.
- `npm run test:e2e -- tests/e2e/chat.spec.ts tests/e2e/extensions-reborn.spec.ts tests/e2e/onboarding.spec.ts tests/e2e/command-palette-connectors.spec.ts tests/e2e/desk-generated-missions.spec.ts tests/e2e/work.spec.ts --project=chromium` passed 18/18 using one Chromium worker.
- `npm run build` passed with existing Vite dynamic-import/chunk-size warnings.
- `npm run tauri build` produced
  `src-tauri/target/release/bundle/macos/IronClaw.app`,
  `src-tauri/target/release/bundle/dmg/IronClaw_0.4.154_aarch64.dmg`, and the
  updater tarball, then exited at updater signing because this machine does not
  provide `TAURI_SIGNING_PRIVATE_KEY`.
- `npm run smoke:packaged` passed against the fresh build artifact.
- `bash scripts/smoke-packaged-app.sh --bundle /Applications/IronClaw.app`
  passed after deployment.
- `/Applications/IronClaw.app` now reports version `0.4.154` and launches.

## 2026-06-01 Chat Reality Check

The local gateway running on this machine reports Engine v2 but returns 404 for
`/api/webchat/v2/threads`, while legacy `/api/chat/threads` returns real
conversations. The previous desktop build treated a missing profile
`apiVersion` as v2 and could therefore mount a broken Reborn chat surface even
though the gateway had a working legacy chat contract.

Closed in this pass:

- `src/lib/api/ironclaw.ts` adds `probeWebChatV2`, a cheap route-existence
  check for `/api/webchat/v2/threads?limit=1`.
- `src/lib/stores/connection.svelte.ts` now records live WebChat v2 capability
  after health checks and makes `connection.apiVersion` fall back to `v1` when
  v2 routes are absent.
- `tests/e2e/chat.spec.ts` now proves the failure mode directly: when mocked
  Reborn v2 routes return 404, the rendered app does not strand the user in
  Reborn chat and a legacy chat send still produces an assistant reply.
- The local macOS app was bumped to `0.4.155`, bundled, installed to
  `/Applications/IronClaw.app`, smoked, and relaunched.

Verification from this pass:

- Live probe against `http://127.0.0.1:3000`: `/api/webchat/v2/threads` returns
  404, `/api/chat/threads` returns existing threads, and `/api/gateway/status`
  reports gateway `0.27.0` with model `Qwen/Qwen3.5-122B-A10B`.
- `npm run test -- src/lib/api/reborn-transport.test.ts` passed 21/21.
- `npm run test:e2e -- tests/e2e/chat.spec.ts --project=chromium` passed 8/8.
- `npm run check` passed with 0 errors / 0 warnings.
- `npm run test -- src/lib/api/reborn-transport.test.ts src/lib/components/ChatModelSelector.test.ts src/lib/components/RebornChatPanel.test.ts`
  passed 43/43.
- `npm run build` passed with existing Vite dynamic-import/chunk-size warnings.
- `npm run tauri build` produced
  `src-tauri/target/release/bundle/macos/IronClaw.app`,
  `src-tauri/target/release/bundle/dmg/IronClaw_0.4.155_aarch64.dmg`, and the
  updater tarball, then exited at updater signing because
  `TAURI_SIGNING_PRIVATE_KEY` is absent.
- `bash scripts/smoke-packaged-app.sh --bundle /Applications/IronClaw.app`
  passed after deployment.
- `/Applications/IronClaw.app` now reports version `0.4.155` and launches.

## 2026-06-01 Reaudit Result

Verdict: the app now has a real partial spine, not just chat copy. The shipped path is still not a finished autonomous chief-of-staff system, but the primitives are concrete: generated missions can create durable Work Items, Work is visible in the primary IA, Today surfaces live matters, and unknown/low-confidence classifications clarify instead of guessing.

Highest-risk remaining collapse: approval boundaries now block the risky Reborn
chat path and can be approved/denied from `/work`, but they are not yet a
universal middleware across every send/write/export/delete/push/trade execution
path. Artifacts and watches are still planning/audit state; watches do not
proactively run.

## Phase 0 Inventory

| Surface / primitive            | Current evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Review note                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work Item data model           | `WorkItem` carries `domain`, `runbookIds`, `dossier`, `approvalBoundaries`, `artifacts`, `watches`, `openApprovals`, `followUps`, and `nextAction` in `src/lib/data/work-item.ts:87` near `export interface WorkItem`. `createWorkItem` defaults empty routing state in `src/lib/data/work-item.ts:187` near `createWorkItem`.                                                                                                                                                                                                                                                                                                                                                                                                                                | Durable object shape exists; it can represent both safe routing state and "not enough context yet" state.                                         |
| Work Item local store          | Store persists under `ironclaw-work-items`, hydrates defensively, supports per-boundary approval/denial through `updateApprovalBoundary`, and is local-only for now in `src/lib/stores/work-items.svelte.ts` near the file header and `LS_KEY`. Server persistence is explicitly TODO near `TODO(gateway)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Persistence is good enough for local review and local approval-gate proofs; cross-device/server-backed matters remain out of scope.               |
| Runbook catalog                | Five runbooks (`coding`, `legal`, `finance`, `research`, `operations`) are pure data in `src/lib/data/runbooks.ts:8` near `RunbookDomain` and `src/lib/data/runbooks.ts:31` near `RUNBOOKS`. Each declares required inputs, steps with gates, artifacts, verification, and constraints.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Domain coverage is finite and auditable. No `general` runbook exists.                                                                             |
| Approval gates in runbooks     | Coding gates `Open PR` with `approval-required` in `src/lib/data/runbooks.ts:61` near the coding runbook. Legal gates `Send or file` in `src/lib/data/runbooks.ts:97`. Finance gates `Execute` in `src/lib/data/runbooks.ts:136`. Operations gates `Send` in `src/lib/data/runbooks.ts:208`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Covers common push/send/trade/write/send-action classes at the runbook-step level.                                                                |
| Router classification input    | `WorkRouteClassification` accepts `domain`, `confidence`, optional `domains`, `context`, `riskyActions`, `expectedArtifacts`, `watches`, and `nextAction` in `src/lib/util/work-router.ts:41` near `WorkRouteClassification`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Router currently trusts a supplied classification object; classifier/model adversarial robustness is outside this primitive.                      |
| Router clarification behavior  | `clarificationReason` rejects `unknown`, confidence below `0.55`, or no valid runbook in `src/lib/util/work-router.ts:249` near `clarificationReason`; `planWorkAsk` returns `needs_clarification` instead of routing in `src/lib/util/work-router.ts:256` near `planWorkAsk`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Prevents silent guesses for unknown / low-confidence / invalid-domain routes.                                                                     |
| Required-context normalization | Router appends missing entries for runbook `required_inputs` in `src/lib/util/work-router.ts:121` near `normalizeContext`. Routed item is `blocked` when any dossier entry is `missing` in `src/lib/util/work-router.ts:270` near the `missingContext` branch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Good primitive for "do not proceed until inputs exist"; needs scenario coverage for hostile omission.                                             |
| Approval-boundary synthesis    | Router adds approval boundaries from runbook `approval-required` steps and caller-supplied `riskyActions` in `src/lib/util/work-router.ts:158` near `approvalBoundaries`. Routed output copies boundaries into `openApprovals` in `src/lib/util/work-router.ts:292`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Covers explicit risky actions and runbook-driven gates, but it is only as complete as classification/runbook data.                                |
| Artifact/watch synthesis       | Router merges caller artifacts with runbook expected artifacts in `src/lib/util/work-router.ts:193` near `artifacts`, and validates watches in `src/lib/util/work-router.ts:228` near `watches`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Supports evidence-bound deliverables and monitoring intents, not execution.                                                                       |
| Generated missions integration | Mission proposals request strict JSON fields for `domain`, `domains`, `context`, `risky_actions`, `expected_artifacts`, and `watches` in `src/lib/util/mission-generator.ts:81` near `SYSTEM`. `generatedMissions.run` converts a mission into a route plan and creates a Work Item before inserting chat text in `src/lib/stores/generated-missions.svelte.ts:81` near `run`.                                                                                                                                                                                                                                                                                                                                                                                | The Desk path can create routed matters from generated actions, then still sends the final instruction through the chat composer for user review. |
| First-run mission workflow     | `planFirstRunMissionWorkflow` in `src/lib/util/workflow-orchestrator.ts` maps static first-run missions into routed Work. `launchMission` in `src/lib/components/MissionLauncher.svelte` creates the Work Item before inserting the mission prompt into chat.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Static mission launches no longer collapse directly into chat-only work.                                                                          |
| User-facing Work surface       | `/work` shows runbooks, links, context dossier, approval boundaries, artifacts, watches, open approvals, and follow-ups in `src/routes/work/+page.svelte` near the `Runbooks` section through the `Follow-ups` section. It can now approve/deny pending approval boundaries. Sidebar nav includes `/work` in `src/lib/components/Sidebar.svelte`; Today includes a Work Queue tile in `src/lib/components/dashboard/tiles/WorkQueueTile.svelte`; command palette, omnibar, and agent UI navigation include Work.                                                                                                                                                                                                                                              | Inspection, discovery, and local approval disposition are now first-class. The surface is still local and does not execute plans by itself.       |
| Current tests                  | Runbook data tests cover unique domains, required fields, gates, and legal/finance disclaimers in `src/lib/data/runbooks.test.ts:4`. Router tests cover coding, low-confidence clarification, finance missing context/trade/watch, and multi-domain routing in `src/lib/util/work-router.test.ts:4`. Workflow tests cover ordinary chat, legal/risky asks, unclear risky asks, Notion mission routing, and blocked contract review in `src/lib/util/workflow-orchestrator.test.ts`. Scenario corpus tests cover hostile practical-work fixtures in `src/lib/util/workflow-scenarios.test.ts`. Work route e2e now covers approval disposition; chat e2e covers local approval blocking before Reborn dispatch; extensions e2e covers bare-name registry setup. | Strong unit and rendered coverage for current primitives; universal execution middleware and real artifact/watch execution still need expansion.  |

## Scenario Rubric

| Scenario                                                                         | Expected hostile-routing behavior                                                                                      | Current status                                                                                                                            | Evidence to verify / extend                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown or low-confidence ask: "Handle this somehow."                            | Do not pick a domain; ask for clarification before external work.                                                      | Covered by router primitive and test.                                                                                                     | `clarificationReason` in `src/lib/util/work-router.ts:249`; test in `src/lib/util/work-router.test.ts:49`.                                                                                                                                   |
| Coding ask that requests push/PR                                                 | Route to `coding`, create a Work Item, record PR/push approval before anything leaves local tree.                      | Covered for planned route output; actual push enforcement is outside this primitive.                                                      | Coding runbook approval in `src/lib/data/runbooks.ts:61`; router test includes `kind: 'push'` in `src/lib/util/work-router.test.ts:23`.                                                                                                      |
| Legal review that tries to send/file a markup                                    | Route to `legal`, keep legal-output caveat, record send/file approval boundary.                                        | Partially covered. Runbook covers the boundary and caveat; no hostile test asserts "send now" is blocked.                                 | Legal runbook in `src/lib/data/runbooks.ts:75`; approval step in `src/lib/data/runbooks.ts:97`; constraints in `src/lib/data/runbooks.ts:108`; generated mission test uses `kind: 'send'` in `src/lib/stores/generated-missions.test.ts:53`. |
| Finance ask that implies trading or fund movement                                | Route to `finance`, require holdings, mark item blocked if holdings are missing, gate trades/funds.                    | Covered for missing holdings, trade boundary, and watch creation.                                                                         | Finance runbook in `src/lib/data/runbooks.ts:114`; router test in `src/lib/util/work-router.test.ts:60`.                                                                                                                                     |
| Operations ask that sends replies or mutates task/calendar state                 | Route to `operations`, keep drafts dry-run, require approval before send/state change.                                 | Runbook-covered; no dedicated router hostile test yet.                                                                                    | Operations runbook gates `Send` in `src/lib/data/runbooks.ts:208`; constraints in `src/lib/data/runbooks.ts:216`.                                                                                                                            |
| Research ask with unsupported claims or weak source provenance                   | Route to `research`, require cited brief, mark unsupported claims/open questions rather than fabricating.              | Runbook-covered only. No parser/router hostile test asserts provenance or primary-source discipline.                                      | Research runbook verification in `src/lib/data/runbooks.ts:181`; router artifact provenance fallback in `src/lib/util/work-router.ts:193`.                                                                                                   |
| Multi-domain matter, e.g. acquisition review spanning research/legal/finance/ops | Create one parent matter with selected sub-runbooks; aggregate required inputs, approval gates, and artifacts.         | Covered by router test for selected runbooks; needs conflict and duplicate-context tests.                                                 | Multi-domain path in `src/lib/util/work-router.ts:109`; test in `src/lib/util/work-router.test.ts:103`.                                                                                                                                      |
| Missing required context in otherwise confident route                            | Route as `blocked`, add missing dossier entries from selected runbook, set next action to request first missing input. | Covered by primitive and finance test; needs per-domain scenario expansion.                                                               | `normalizeContext` in `src/lib/util/work-router.ts:121`; status/next action in `src/lib/util/work-router.ts:290`; finance test in `src/lib/util/work-router.test.ts:97`.                                                                     |
| Model emits invalid or hostile mission JSON                                      | Parser should discard malformed elements, default unsafe unknowns conservatively, and avoid crashes.                   | Partially covered. Parser tolerates malformed JSON and unknown mode; tests do not yet assert domain/risky-action/artifact/watch coercion. | Parser in `src/lib/util/mission-generator.ts:240`; existing parser tests in `src/lib/util/mission-generator.test.ts:24`.                                                                                                                     |
| Generated mission with no domain                                                 | Do not create a Work Item; insert a routing note asking for missing domain/context before external work.               | Covered by generated-mission store test.                                                                                                  | `generatedMissions.run` fallback in `src/lib/stores/generated-missions.svelte.ts:100`; test in `src/lib/stores/generated-missions.test.ts:89`.                                                                                               |
| User manually creates a `/work` matter with no runbook                           | Allow local tracking but visibly show no runbook selected; do not imply the matter has been safety-routed.             | Covered in UI shape and route smoke; not safety-enforced.                                                                                 | Manual create only sets title/objective/domain in `src/routes/work/+page.svelte:66`; empty runbook copy in `src/routes/work/+page.svelte:265`; e2e create/status smoke in `tests/e2e/work.spec.ts:24`.                                       |
| Persisted hostile/corrupt localStorage blob                                      | Coerce enums/lists, drop unusable entries, cap item count.                                                             | Covered by store primitive and test.                                                                                                      | Coercion in `src/lib/stores/work-items.svelte.ts:195`; test in `src/lib/stores/work-items.test.ts:240`; cap in `src/lib/stores/work-items.svelte.ts:37`.                                                                                     |

## Covered Now By Work Item / Runbook / Router Primitives

- Durable route state can be represented without relying on chat prose: Work Item stores domains, runbooks, dossier entries with provenance, approval boundaries, artifacts, watches, approvals, follow-ups, and next action (`src/lib/data/work-item.ts:87`).
- The runbook catalog gives a finite approval-gated operating model for coding, legal, finance, research, and operations (`src/lib/data/runbooks.ts:31`).
- Low-confidence, unknown-domain, and invalid-runbook asks return `needs_clarification` instead of being silently routed (`src/lib/util/work-router.ts:249`).
- Required runbook inputs become missing dossier entries with `runbook:<id>` provenance, and missing dossier state blocks the Work Item with a next action (`src/lib/util/work-router.ts:121`, `src/lib/util/work-router.ts:290`).
- Approval boundaries are synthesized from both runbook approval-required steps and explicit risky actions (`src/lib/util/work-router.ts:158`).
- Planned artifacts and watches survive into the Work Item rather than staying only in the generated chat instruction (`src/lib/util/work-router.ts:193`, `src/lib/util/work-router.ts:228`).
- Generated missions now call the router and create a durable Work Item before pushing text into the chat composer (`src/lib/stores/generated-missions.svelte.ts:81`).
- First-run missions now call the workflow orchestrator and create a durable
  Work Item before pushing text into the chat composer
  (`src/lib/util/workflow-orchestrator.ts`, `src/lib/components/MissionLauncher.svelte`).
- Risky Reborn chat asks now create a Work Item and block locally before
  dispatch. Approval sends only after `evaluateApprovalBoundary` accepts the
  approved `send` boundary (`src/lib/components/RebornChatPanel.svelte`,
  `src/lib/util/approval-enforcement.ts`).
- `/work` can approve or deny pending approval boundaries and persists the
  resulting lifecycle state (`src/routes/work/+page.svelte`,
  `src/lib/stores/work-items.svelte.ts`).
- The `/work` route can inspect the resulting runbooks, dossier, approval boundaries, artifacts, watches, approvals, follow-ups, and next action (`src/routes/work/+page.svelte:260` through nearby `Follow-ups` section).
- Work is discoverable from the sidebar, command palette, omnibar, and agent UI navigation, and Today now carries a Work Queue tile summarizing live matters, approvals, blocked work, active watches, and ready artifacts.
- Registry-only connector setup deep links install and set up Reborn extensions
  with bare names, while slash-prefixed IDs remain catalog refs only
  (`src/routes/extensions/+page.svelte`,
  `tests/e2e/extensions-reborn.spec.ts`,
  `tests/e2e/command-palette-connectors.spec.ts`).
- Chat now exposes the active provider/model selector and local runner model
  plumbing (`src/lib/components/ChatModelSelector.svelte`,
  `src/routes/settings/LlmProviderPicker.svelte`,
  `src-tauri/src/sidecar.rs`,
  `tests/e2e/chat.spec.ts`).

## Remaining Gaps

| Gap                                                                                                                                                                                                                | Risk                                                                                                                                                        | Evidence / nearby symbol                                                                                                                                                                                                                                          | Proposed follow-up                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The local workflow gate is conservative but not a real classifier. `planWorkAsk` still receives a prebuilt `WorkRouteClassification`; hostile prompt-injection resistance depends on whoever supplies that object. | Adversarial text could under-report risk or misclassify if the upstream classifier/model is weak.                                                           | `WorkRouteClassification` in `src/lib/util/work-router.ts:41`; `orchestrateChiefOfStaffAsk` in `src/lib/util/workflow-orchestrator.ts`; `generatedMissions.run` maps model output directly to classification in `src/lib/stores/generated-missions.svelte.ts:81`. | Add classifier contract tests with adversarial prompts and require conservative defaults when model output omits domain, required inputs, or risky actions. |
| Approval enforcement is real for risky Reborn chat but not universal middleware.                                                                                                                                   | Source paths outside the guarded chat lane that execute writes/exports/deletes/pushes/trades could bypass Work Item approval state unless separately wired. | Chat uses `evaluateApprovalBoundary` in `src/lib/components/RebornChatPanel.svelte`; inventory lives in `src/lib/util/approval-enforcement.ts`; broader extension/routine/job/native execution paths still need per-path guards.                                  | Insert a shared approval-boundary check before every mutating desktop execution path and add rendered exploit tests per action class.                       |
| Watch state is still inert.                                                                                                                                                                                        | A Work Item can promise monitoring/follow-up but nothing proactively wakes, checks, or notifies.                                                            | Router preserves watches in `src/lib/util/work-router.ts:228`; `/work` and Today display them; no scheduler dispatches them.                                                                                                                                      | Add a local scheduler behind capability probes, then test due watches with fake timers and packaged smoke.                                                  |
| Ordinary chat/free-form asks can still bypass Work Items.                                                                                                                                                          | Users can still start real work in chat without a durable matter, dossier, or approval boundary.                                                            | Generated missions and first-run missions create Work Items, but normal chat sends through the chat pipeline unless a surface explicitly calls the workflow gate.                                                                                                 | Add an explicit "turn this into Work" affordance and/or a conservative planner pass before high-risk chat execution.                                        |
| Manual Work Item creation can pick a domain without selecting runbooks.                                                                                                                                            | A domain chip may look routed even though no runbook/approval/dossier state exists.                                                                         | Manual create call in `src/routes/work/+page.svelte:66`; empty runbook copy in `src/routes/work/+page.svelte:265`.                                                                                                                                                | Either select default runbook on manual create for non-general domains or label manual matters as unrouted until planner runs.                              |
| No server-backed Work Item persistence/sync.                                                                                                                                                                       | Durable routing is local to one browser/app profile; reviews, approvals, and audit trail do not cross devices.                                              | Store TODO in `src/lib/stores/work-items.svelte.ts:15`; localStorage key in `src/lib/stores/work-items.svelte.ts:35`.                                                                                                                                             | Define `/api/work-items` contract, sync semantics, and conflict handling before relying on Work Items as audit objects.                                     |
| Research provenance guarantees are aspirational.                                                                                                                                                                   | "Cited brief" can be planned, but nothing enforces primary-source quality or claim-level citations.                                                         | Research verification in `src/lib/data/runbooks.ts:181`; artifact provenance fallback in `src/lib/util/work-router.ts:207`.                                                                                                                                       | Add research-specific tests and artifact validators for claim/source mapping.                                                                               |
| Multi-domain conflict handling is not modeled.                                                                                                                                                                     | Legal/finance/ops constraints could conflict, duplicate approvals could accumulate, or required inputs could be semantically duplicated.                    | Multi runbook selection in `src/lib/util/work-router.ts:109`; duplicate handling only exact-matches labels/artifact titles in `src/lib/util/work-router.ts:145` and `src/lib/util/work-router.ts:214`.                                                            | Add conflict rubric and dedupe by normalized semantic keys for required inputs and approval actions.                                                        |

## Tests To Run

Focused current primitive checks:

```sh
npm run test -- src/lib/data/runbooks.test.ts src/lib/util/work-router.test.ts src/lib/stores/work-items.test.ts src/lib/stores/generated-missions.test.ts
```

Parser/schema checks to add or extend:

```sh
npm run test -- src/lib/util/mission-generator.test.ts
```

Type and Svelte integration checks:

```sh
npm run check
npm run test
```

Existing UI smoke for the direct `/work` route:

```sh
npm run test:e2e -- tests/e2e/work.spec.ts
```

Last local audit notes:

- `npm run check` passed with 0 errors / 0 warnings.
- Full Vitest passed after the final IA/Today pass: 147 test files, 1,142 tests.
- Focused Playwright for `/work`, Today/dashboard, and the a11y sweep passed: 18 tests.
- A full Playwright sweep exposed unrelated stale browser specs around old chat labels and Tauri HTTP mock coverage; those are documented as test-suite debt, not hidden as product-green.
- Tauri local packaging passed for `.app` and `.dmg` with updater artifacts disabled. The normal updater-artifact build produced the app and DMG but exited at signing because this machine did not provide `TAURI_SIGNING_PRIVATE_KEY`.

2026-06-01 follow-up implementation pass:

- Today is now the root front door (`/` redirects to `/dashboard`) and Chat lives at `/chat`; sidebar/agent/UI navigation, mission launch, command paths, and snapshots were updated to match.
- Today no longer uses gold agency language in the empty state. Gold "Agent prepared" is reserved for a real first decision; the empty state is neutral "Standing by" and points disconnected users to runner setup.
- The first-decision gate now states action, touched payload, what leaves the machine, and reversibility. The right rail is a ranked `Brief Queue` (max five items) instead of a raw metric tile cluster.
- Client-local watches now have receipts and a scheduler. `workItems.runDueWatches()` fires due active watches, posts handled receipts, re-arms recurring cadences, completes one-shot watches, and the layout runs it at startup plus a 60s interval.
- Monitor/watch asks no longer create inert watches: the workflow orchestrator assigns a scheduler-compatible cadence and an initial `next_check`.
- The legacy `/chat` fallback path now routes risky asks through Work before optimistic append or `/api/chat/send`; a hostile e2e forces Reborn v2 unavailable and asserts no legacy send happens before approval.
- Connector setup was re-verified through command palette and extension deep-link e2e; Gmail, Google Calendar, Notion, and Slack catalog refs normalize to Reborn bare extension names before lifecycle calls.
- 0.4.156 was built and installed at `/Applications/IronClaw.app`. The bundle and DMG were produced; the Tauri command exited after bundle creation because updater signing still lacks `TAURI_SIGNING_PRIVATE_KEY`.

Evidence from this pass:

```sh
npm run check
npx vitest run
npm run test:e2e -- tests/e2e/dashboard.spec.ts tests/e2e/chat.spec.ts tests/e2e/work.spec.ts tests/e2e/onboarding.spec.ts --project=chromium
npm run test:e2e -- tests/e2e/extensions-reborn.spec.ts tests/e2e/command-palette-connectors.spec.ts --project=chromium
bash scripts/style-guard.sh
npm run build
npm run tauri -- build # produced app/dmg, then failed updater signing without TAURI_SIGNING_PRIVATE_KEY
npm run smoke:packaged
```

Results: `npm run check` 0/0; full Vitest 154 files / 1,227 tests passed; targeted Playwright 23 tests passed; style guard passed; packaged smoke passed.

2026-06-01 work-product recovery pass:

- Hostile finding: Generated Desk actions still treated chat as the execution surface. A "Run" action could leave the user staring at internal planning text or raw structured output instead of a durable, inspectable work product.
- Fix: `generatedMissions.run()` now creates a Work Item, attaches source/mission links, preserves approval boundaries, and creates expected artifacts in Work. It no longer pushes generated mission instructions into the chat composer.
- Fix: when a gateway client is connected, running the generated action asks for a Markdown work-product draft and stores it on the primary Work artifact. Unsafe/internal-prompt-looking output is rejected into a failed receipt instead of being rendered as the user deliverable.
- UI: Desk now says `Create in Work` and routes to `/work?item=...`; `/work` renders artifact Markdown inline so the user can see where the work product landed.
- Version/deploy: bumped to 0.4.157, built the unsigned macOS app/DMG, installed `/Applications/IronClaw.app`, and launched the installed app.

Evidence from this pass:

```sh
npm run test -- src/lib/util/mission-generator.test.ts src/lib/stores/generated-missions.test.ts src/lib/components/GeneratedMissionsPanel.test.ts
npm run test:e2e -- tests/e2e/desk-generated-missions.spec.ts --project=chromium
npm run check
npx vitest run
npm run build
npm run tauri -- build # produced 0.4.157 app/dmg, then failed updater signing without TAURI_SIGNING_PRIVATE_KEY
npm run smoke:packaged
```

Results: focused Vitest 3 files / 21 tests passed; focused Desk-to-Work Playwright passed; `npm run check` 0/0; full Vitest 154 files / 1,230 tests passed; Vite build passed with the existing chunk warnings; packaged smoke passed.

Reviewer-driven corrections on the work-product pass:

- Design-hostile finding: `/work?item=...` could still land above the generated artifact, so the work product existed but was not immediately visible. Fix: Desk now navigates with `&artifact=...`, and `/work` scrolls/focuses the artifact row on arrival.
- Design-hostile finding: `Create in Work` waited on a hidden second model call. Fix: generated runs now return as soon as the Work Item/artifact shell exists; drafting happens asynchronously inside the Work item.
- Capability-hostile finding: blocked/unknown generated missions could still draft. Fix: clarification routes create a blocked Work Item and planned artifact only; no work-product draft call runs until routing is clarified.
- Capability-hostile finding: malformed model output could create Work with no artifact. Fix: generated missions always create at least a fallback `work-product` artifact.
- Capability-hostile finding: explicit runbook approval gates with `kind: other` were present but not blocking. Fix: pending approval boundaries now block dispatch regardless of action kind, while dispatch-specific approval evaluation still applies to risky send/write/export/etc. boundaries.
- UX cleanup: generated receipts no longer surface `generated-mission:*` and raw status enums as primary user-facing copy in `/work`.

Evidence after reviewer corrections:

```sh
npm run test -- src/lib/stores/generated-missions.test.ts src/lib/components/GeneratedMissionsPanel.test.ts src/lib/stores/work-items.test.ts src/lib/components/RebornChatPanel.test.ts
npm run test:e2e -- tests/e2e/desk-generated-missions.spec.ts --project=chromium
npm run check
npx vitest run
npm run tauri -- build # produced 0.4.157 app/dmg, then failed updater signing without TAURI_SIGNING_PRIVATE_KEY
npm run smoke:packaged
```

Results: focused Vitest 4 files / 55 tests passed; focused Desk-to-Work Playwright passed and verifies the artifact is visible in the Work viewport; `npm run check` 0/0; full Vitest 154 files / 1,233 tests passed; packaged smoke passed; `/Applications/IronClaw.app` 0.4.157 relaunched.

2026-06-01 rendered contract heartbeat pass:

- User promises verified this pass: Reborn chat renders historical messages,
  attachments post payloads, risky chat creates durable Work before dispatch,
  Work approval resumes the held chat dispatch, connector lifecycle calls use
  bare Reborn names, generated mission work lands in `/work`, command palette
  and omnibar routes are rendered, onboarding/dashboard/missions surfaces still
  mount, and `/extensions` setup remains catalog-ref safe for Gmail, Google
  Calendar, Notion, and Slack.
- Capability-hostile RED fixed: `Review in Work` used to approve only the Work
  boundary and lose the held chat dispatch. `src/lib/util/work-dispatch-resume.ts`
  now persists the held Reborn send envelope; `RebornChatPanel.svelte` stores a
  resume token before navigating to Work and consumes it only after all
  boundaries are approved; `/work` redirects back to `/chat?resumeWorkDispatch=...`
  once the last pending boundary is approved.
- Rendered proof added:
  `tests/e2e/chat.spec.ts` now covers risky chat -> `Review in Work` -> approve
  every Work boundary -> return to chat -> exactly one
  `/api/webchat/v2/threads/:id/messages` request with the approved Work Item
  prefix -> resume storage cleared.
- Design-hostile RED fixed: Cmd+K advertised `/missions` even when the sidebar
  hid Missions behind `engineV2Enabled`. `CommandPalette.svelte` now applies the
  same gate as `Sidebar.svelte`, and `tests/e2e/command-palette-connectors.spec.ts`
  proves Missions is hidden with Engine v2 disabled and visible when enabled.

Evidence from this pass:

```sh
npm run test:e2e -- tests/e2e/onboarding.spec.ts tests/e2e/dashboard.spec.ts tests/e2e/chat.spec.ts tests/e2e/chat-tabs.spec.ts tests/e2e/multimodal-render.spec.ts --project=chromium
npm run test:e2e -- tests/e2e/extensions-reborn.spec.ts tests/e2e/command-palette-connectors.spec.ts tests/e2e/omnibar.spec.ts tests/e2e/work.spec.ts tests/e2e/desk-generated-missions.spec.ts --project=chromium
npm run test:e2e -- tests/e2e/onboarding.spec.ts tests/e2e/dashboard.spec.ts tests/e2e/chat-tabs.spec.ts tests/e2e/multimodal-render.spec.ts tests/e2e/missions-guard.spec.ts --project=chromium
npm run test:e2e -- tests/e2e/chat.spec.ts tests/e2e/command-palette-connectors.spec.ts --project=chromium
npm run test:e2e -- tests/e2e/work.spec.ts tests/e2e/extensions-reborn.spec.ts tests/e2e/omnibar.spec.ts tests/e2e/desk-generated-missions.spec.ts --project=chromium
npm run check
npx vitest run src/lib/stores/work-items.test.ts src/lib/components/RebornChatPanel.test.ts src/lib/stores/generated-missions.test.ts src/lib/components/GeneratedMissionsPanel.test.ts
npx vitest run
```

Results: first chat gauntlet 9/9 after tightening the multi-boundary approval
expectation; connector/work/generated-mission gauntlet 11/11; onboarding,
dashboard, chat-tabs, multimodal, and missions-guard gauntlet 9/9; patched
chat/command-palette gauntlet 13/13; work/extensions/omnibar/generated-missions
rerun 10/10; `npm run check` 0/0; focused Vitest 4 files / 55 tests passed;
full Vitest 154 files / 1,233 tests passed. Packaging was not touched in this
heartbeat, so the latest packaged smoke remains the prior 0.4.157
`/Applications/IronClaw.app` smoke above.

Reviewer RED carry-forward:

- Generated Desk "connected source" actions are still not proven to inspect
  real connectors. Current e2e proves the prompt and source-shaped result, not
  observable Gmail/Calendar/Notion read-tool evidence or source provenance.
- Narrow/mobile shell layout is still RED. Design review screenshot evidence
  showed the expanded sidebar and fixed rails collapsing a 390px viewport.
- Attachment UX is proven as payload plumbing, but not yet as durable sent-file
  chips/previews, remove/drop/paste/rejection-state polish.
- Generated mission Work artifact drafting is now asynchronous and eventual;
  the empty/loading/failure state during the drafting gap still needs rendered
  screenshot/e2e evidence.
- The loop should formalize these rendered checks into stable shards instead of
  relying on ad hoc command batches.

2026-06-01 global-search contract pass:

- User promises verified this pass: global search opens from the rendered app,
  groups six surfaces, keyboard-opens a Reborn thread deep link with visible
  historical timeline content, persists recent searches, and routes extension
  results into setup without leaking slash-prefixed catalog refs into Reborn
  lifecycle calls.
- Rendered proof added: `tests/e2e/global-search.spec.ts` covers Cmd+Shift+F,
  grouped Knowledge/Threads/Jobs/Skills/Routines/Extensions results, filter-tab
  narrowing, Enter activation into `/chat?thread=...`, recent-search rendering,
  and Gmail registry setup from a `tools/gmail` catalog row with bare
  `gmail` install/setup requests.
- Capability-hostile early finding that global-search proof failed was
  superseded by the later patched run: global-search 2/2 and the combined
  capability chunk 24/24.

Evidence from this pass:

```sh
npm run test:e2e -- tests/e2e/global-search.spec.ts --project=chromium
npm run test:e2e -- tests/e2e/global-search.spec.ts tests/e2e/chat.spec.ts tests/e2e/extensions-reborn.spec.ts tests/e2e/command-palette-connectors.spec.ts tests/e2e/work.spec.ts tests/e2e/desk-generated-missions.spec.ts --project=chromium
npm run test:e2e -- tests/e2e/onboarding.spec.ts tests/e2e/dashboard.spec.ts tests/e2e/chat-tabs.spec.ts tests/e2e/multimodal-render.spec.ts tests/e2e/missions-guard.spec.ts tests/e2e/omnibar.spec.ts --project=chromium
npm run check
npx vitest run src/lib/components/RebornChatPanel.test.ts src/lib/stores/work-items.test.ts src/lib/stores/generated-missions.test.ts src/lib/components/GeneratedMissionsPanel.test.ts
npx vitest run
git diff --check
npm run build
```

Results: global-search 2/2; combined chat/extensions/command-palette/work/Desk/global-search
gauntlet 24/24; onboarding/dashboard/chat-tabs/multimodal/missions/omnibar
gauntlet 10/10; `npm run check` 0/0; focused Vitest 4 files / 55 tests
passed; full Vitest 154 files / 1,233 tests passed; `git diff --check`
passed; production build passed with the existing dynamic-import and chunk-size
warnings. Packaging was not touched, so packaged smoke remains the prior
0.4.157 evidence.

Reviewer RED carry-forward after this pass:

- Generated Desk "connected source" actions are still not proven to inspect
  real connectors. Current e2e proves prompt/result shape, not observable
  Gmail/Calendar/Notion/Slack read-tool execution or source provenance.
- Narrow/mobile shell layout is still RED. Fresh design review screenshots show
  a 390px dashboard with only 166px of main content after the fixed sidebar,
  and chat with app sidebar plus Reborn rail leaving effectively no composer
  width.
- Onboarding mobile still buries `Set up later` below the first viewport.
- Attachment UX is proven for picker-to-Reborn-payload, but not yet for
  clipboard paste, drag/drop payloads, or durable sent-file chips/previews.
- Generated mission Work artifact drafting is asynchronous and eventual; the
  empty/loading/failure state during the drafting gap still needs rendered
  screenshot/e2e evidence.
- Rendered status/readiness mapping is partial: onboarding mission readiness is
  proven, but `/extensions` or dashboard readiness states for ready/auth/setup/
  unavailable still need e2e.

2026-06-01 work-product portability pass:

- User promises verified this pass: Reborn chat output is no longer trapped as
  rendered-only chat text; assistant responses can be copied, exported as
  Markdown, exported as a real `.docx` ZIP document, and promoted into a durable
  `/work` artifact. `/work` artifacts also expose copy/export controls. Reborn
  v2 regained full visible-thread export so the current conversation can leave
  chat as a usable file.
- Product patch: `WorkProductActions` centralizes copy/export/save-to-Work
  controls; `work-product-export.ts` provides browser clipboard fallback,
  Markdown/HTML downloads, and minimal DOCX generation; `RebornChatPanel`
  renders per-response actions plus full-thread actions; `/work` renders the
  same artifact actions and a pending-state message when an artifact has no
  draft content yet.
- Multi-agent review findings addressed: the design reviewer caught an invalid
  `toasts.success/error` API usage and missing `pageerror` assertions; this was
  fixed with `toasts.show(...)` and page/console-error guards in the rendered
  portability shard. The capability reviewer called out that output needed a
  route into Work, not only copy/download; the pass added "Save to Work" for
  assistant responses and rendered proof that it opens `/work?item=...&artifact=...`
  with the saved content visible.
- Rendered proof added: `tests/e2e/work-product-actions.spec.ts` now covers
  chat assistant copy, chat assistant Markdown export, chat assistant DOCX
  export, full-thread Markdown export, promoting a chat response into a Work
  artifact, Work artifact copy, and Work artifact DOCX export. The DOCX checks
  assert browser download events, `PK` ZIP bytes, `word/document.xml`, and
  user-visible content.

Evidence from this pass:

```sh
npm run check
npm run test:e2e -- tests/e2e/work-product-actions.spec.ts --project=chromium
npm run test:e2e -- tests/e2e/work-product-actions.spec.ts tests/e2e/chat.spec.ts tests/e2e/work.spec.ts tests/e2e/desk-generated-missions.spec.ts --project=chromium
npm run test -- tests/design-tokens.test.ts
npm run test
npm run build
```

Results: `npm run check` 0/0; new work-product rendered shard 7/7; combined
chat/work/Desk portability gauntlet 20/20; design-token shard 4/4; full Vitest
154 files / 1,233 tests passed; production build passed with existing
dynamic-import and chunk-size warnings. Packaging was not touched.

Reviewer RED carry-forward after this pass:

- DOCX export is intentionally minimal. It creates a valid Word package for
  portable review, but it does not yet preserve tables, nested lists, code
  blocks, link relationships, or rich document styling.
- Work Items remain local-only localStorage state. "Save to Work" makes output
  visible and exportable in the app, but it is not synced durable backend state.
- Reborn approved risky work still sends the approved prompt to chat; this pass
  added an explicit user action to save assistant output into Work, not an
  automatic final-output-to-primary-artifact writeback.
- Mobile/narrow layout, paste/drop attachment payloads, connector read-tool
  provenance, and full readiness-state rendering remain RED/YELLOW from the
  prior pass.

2026-06-01 chat/model/connectors hostile fix pass:

- User promises verified this pass: sent Reborn chat messages stay visible even
  when terminal-success timeline refetches lag the user row; existing threads
  with nonzero counts still render their messages; attachments still post to
  Reborn; model selection is no longer a permanent full-width settings form in
  chat; Gmail/Notion/Calendar/Slack setup paths continue to use bare Reborn
  extension names instead of slash-prefixed catalog refs.
- Product patch: `reborn-chat.svelte.ts` now reconciles optimistic pending user
  bubbles against confirmed timeline user rows instead of clearing them before
  refetch. `ChatModelSelector.svelte` renders a compact model pill with an
  opened popover for provider/model edits and human fallback copy when provider
  or model catalogs are unavailable. `ExtensionCard.svelte`,
  `SetupDrawer.svelte`, and `extensions/+page.svelte` replace plumbing copy
  (`Set up`, `OAuth`, `WASM tool`, `setup fields`, raw categories) with
  user-facing connector language such as `Log in with Gmail`, `Connect Notion`,
  `Mail`, `Calendar`, `Knowledge`, and `Team chat`.
- Design patch: `app.css` now prefers native macOS/SF system typography before
  the bundled Inter fallback, reducing the cheap webfont feel in desktop chrome.
- Multi-agent review findings addressed: capability review identified the exact
  pending-clear bug in `openStream()` and the Reborn lifecycle canonicalization
  trap; design review identified the permanent model form and connector
  implementation copy. Both findings were patched and covered by tests.

Evidence from this pass:

```sh
npm run test -- src/lib/stores/reborn-chat.test.ts src/lib/components/ChatModelSelector.test.ts src/routes/extensions/ExtensionCard.test.ts src/lib/util/work-product-export.test.ts
npm run test
npm run test:e2e -- tests/e2e/chat.spec.ts tests/e2e/extensions-reborn.spec.ts tests/e2e/command-palette-connectors.spec.ts tests/e2e/global-search.spec.ts --project=chromium
npm run check
npm run build
npm run tauri build
npm run smoke:packaged -- --wait 8 --bundle src-tauri/target/release/bundle/macos/IronClaw.app
```

Results: focused Vitest 31/31; full Vitest 155 files / 1,240 tests passed;
rendered Playwright connector/chat gauntlet 23/23; `svelte-check` 0 errors / 0 warnings; production build passed with
existing chunk/dynamic-import warnings; Tauri produced
`src-tauri/target/release/bundle/macos/IronClaw.app` and
`src-tauri/target/release/bundle/dmg/IronClaw_0.4.157_aarch64.dmg` then failed
only updater signing because `TAURI_SIGNING_PRIVATE_KEY` was absent; packaged
smoke passed for the produced `.app`. Installed app was replaced at
`/Applications/IronClaw.app` with backup
`/Applications/IronClaw.app.backup-20260601-161229`.

Reviewer RED carry-forward after this pass:

- The real external OAuth providers still require backend/provider support; the
  UI now starts and polls login with bare Reborn names, but this pass does not
  execute live Gmail/Notion/Google Calendar/Slack account authorization.
- Model catalog failures are contained in the selector, but broader connection
  toasts can still surface raw gateway request errors elsewhere.
- Connector cards still depend on server readiness semantics; richer ready vs
  auth vs setup screenshots across every installed connector state should be
  added to the recurring QA loop.
- Packaged app smoke proves launch/liveness, not a full packaged UI click
  walkthrough through chat send and connector auth.

2026-06-01 live connector auth correction pass:

- Gateway truth verified against the running Reborn gateway at
  `http://127.0.0.1:3000`: `POST /api/extensions/{name}/login/start` is not
  implemented, but `POST /api/extensions/{name}/activate` returns usable
  browser OAuth `auth_url` values for `gmail` and `google_calendar`
  (`accounts.google.com`) and `notion` (`mcp.notion.com`). The desktop
  device-login path was therefore a client contract mismatch, not a provider
  mystery.
- Product patch: `IronClawClient.activateExtension()` and
  `submitExtensionSetup()` now preserve `auth_url`, `message`,
  `instructions`, and `activated`; empty `{}` activation responses no longer
  count as connected. `SetupDrawer.svelte` falls back from missing device-login
  routes to the current Reborn activate-auth-url flow, opens the browser,
  leaves a visible `Finish sign-in in your browser` handoff, and lets the user
  check the connection afterward. Setup-submit auth URLs get the same visible
  handoff instead of silently closing.
- Product patch: the setup drawer is keyed by extension name so navigating from
  `channels/slack` to `tools/slack_tool` cannot reuse stale setup state. Secret
  field types (`secret`, token-like keys/labels) are masked, Google Calendar
  uses provider-safe `Log in with Google` copy, and card readiness distinguishes
  `Needs sign-in`, `Needs setup`, and `Error` without putting raw gateway text
  in the visible label.
- Reborn connector rule remains enforced: slash-prefixed catalog refs
  (`tools/gmail`, `tools/google_calendar`, `mcp-servers/notion`,
  `channels/slack`, `tools/slack_tool`) are still normalized to bare lifecycle
  names before any setup/activate/login request.

Evidence from this pass:

```sh
npx vitest run src/lib/api/ironclaw.test.ts src/routes/extensions/ExtensionCard.test.ts
npm run test:e2e -- tests/e2e/extensions-reborn.spec.ts --project=chromium
npm run check
git diff --check
npm run build
npm run tauri build
npm run smoke:packaged -- --wait 8 --bundle src-tauri/target/release/bundle/macos/IronClaw.app
```

Results: focused Vitest 37/37; full Vitest 155 files / 1,244 tests passed;
rendered Playwright connector gauntlet 11/11; `svelte-check` 0 errors /
0 warnings; whitespace diff clean; production build passed; Tauri built the
release binary and `.app`, then failed only at DMG bundling; packaged `.app`
smoke passed. The new app bundle was installed to `/Applications/IronClaw.app`
with backup `/Applications/IronClaw.app.backup-20260601-164052` and relaunched
as PID `70426`.

2026-06-01 chat routing correction pass:

- User promise being verified: a normal chat ask stays visible in chat, the
  exact prompt is sent to the model, files can be attached by picker or
  drag/drop, and draft/review/summarize work is not hijacked into a prebuilt
  Work/runbook shell. Work routing is now reserved for explicit external
  side effects (`send`, `write`, `delete`, `export`, `push`/PR, `trade`) or
  watch/monitor work.
- Product patch: `RebornChatPanel.svelte` now only treats pending approval
  boundaries as local gates when `requiresApproval(kind)` is true. Future
  runbook steps like legal `Send or file` no longer block or rewrite a pure
  draft request. The legacy chat route uses the same shared policy.
- Product patch: new `chat-work-routing.ts` centralizes the chat policy:
  routed read/draft/analysis/missing-context work stays in the conversation;
  real external-action boundaries and watches still leave chat for approval or
  durable tracking.
- Rendered regression added: `tests/e2e/chat.spec.ts` now verifies attaching
  `services.md`, typing `draft me a services agreement based on this`, and
  clicking Send posts exactly that content plus the attachment to
  `/api/webchat/v2/threads/:id/messages`, shows the user bubble, creates no
  Work item, shows no local approval gate, and never sends a `Work item:`
  prefix.
- Rendered drag/drop regression added: dropping `dragged.md` onto the Reborn
  composer attaches it, shows the drop affordance, sends it, and captures the
  posted attachment payload.
- Adversarial template-pack regression added: rendered chat now covers the
  exact user failure class with a PDF services-agreement template plus five
  adjacent attachment/update scenarios: Word SOW, CSV pricing schedule, JSON
  client requirements, XLSX renewal calculator, and Markdown MSA template. Each
  case asserts the prompt remains visible in chat, the original prompt is posted
  unchanged to
  `/api/webchat/v2/threads/:id/messages`, attachment bytes and MIME type are
  posted, no local Work item is created, no local approval gate appears, and no
  `Work item:` prefix pollutes the model prompt.
- Product patch: `workflow-orchestrator.ts` no longer treats ordinary
  "update this attached template" language as an external write. The write-risk
  detector now requires an external target such as Notion, Gmail, Calendar,
  Slack, CRM, GitHub, Drive, Sheets, Docs, database, ticket, page, workspace,
  file, or disk, and it ignores negated requests such as "Do not send".
  Explicit external mutations such as "Update Notion CRM..." are still
  approval-gated.

Evidence from this pass:

```sh
npm run test -- src/lib/util/chat-work-routing.test.ts src/lib/components/RebornChatPanel.test.ts src/lib/util/workflow-orchestrator.test.ts src/lib/util/attachment-risk.test.ts
npm run test:e2e -- tests/e2e/chat.spec.ts --project=chromium
npm run check
git diff --check
npm run build
npm run test
npm run tauri build
npm run smoke:packaged -- --wait 8 --bundle src-tauri/target/release/bundle/macos/IronClaw.app
npm run smoke:packaged -- --wait 8 --bundle /Applications/IronClaw.app
```

Results: focused Vitest 4 files / 37 tests passed; rendered chat Playwright
gauntlet 19/19 passed, including PDF services agreement plus the five
template/update attachment variants; `svelte-check` 0 errors / 0 warnings;
whitespace diff clean; production build passed with existing Vite
dynamic-import/chunk-size warnings; full Vitest passed 158 files / 1,266
tests; Tauri produced the macOS `.app`, DMG, and updater tarball then failed
only updater signing because `TAURI_SIGNING_PRIVATE_KEY` is absent; packaged
smoke passed for both the build artifact and installed
`/Applications/IronClaw.app`. Installed app backup:
`/Applications/IronClaw.app.backup-20260601-174024`. Relaunched installed app
as PID `4458`.

2026-06-02 static export and installed-app refresh pass:

- User promise being verified: useful assistant work product must not be trapped
  as uncopyable chat text. A user needs visible copy/export controls, downloaded
  artifacts must be parseable, full-thread export must include the visible
  conversation, and the installed app must be refreshed after static patches.
- Product patch: static Reborn chat assistant bubbles now expose copy,
  Markdown, HTML, PDF, DOCX, JSON, save, full-thread Markdown, and full-thread
  JSON actions via `message-bubble.js` and `work-product-export.js`.
- Export behavior now builds local Markdown/HTML/JSON files plus minimal valid
  DOCX/PDF artifacts. The DOCX path includes structured handling for headings,
  bullets, tables, and code-style blocks so table-heavy work product is not
  flattened into one useless paragraph.
- Runtime correction: after regenerating the static bundle, the Tauri app was
  rebuilt, `/Applications/IronClaw.app` was replaced with the new bundle, and
  the installed app was relaunched with its Reborn sidecar on port 3000.
- Honest remaining gap: this pass proves export controls for rendered assistant
  and thread content, not high-fidelity model generation from a real attached
  PDF/DOCX/XLSX template inside the native webview. That remains an acceptance
  gate, not something to hand-wave.

Evidence from this pass:

```sh
npm run prepare:webui-static
npm run check
npx vitest run tests/history-messages.test.ts src/lib/util/work-product-export.test.ts src/lib/util/work-product-normalize.test.ts
npx playwright test tests/e2e/work-product-actions.spec.ts --project=chromium --grep "Reborn chat assistant responses|Reborn chat exports tables|Reborn chat exports the full visible thread"
npx playwright test tests/e2e/chat.spec.ts --project=chromium --grep "user can send|sent Reborn message stays visible|active provider|attaches files|dropped files|draft-from-attachment"
npm run smoke:webui-static
npm run tauri -- build
SMOKE_LOG_PATH=/tmp/ironclaw-packaged-smoke-post-export-20260602-004524.log bash scripts/smoke-packaged-app.sh --wait 8 --bundle src-tauri/target/release/bundle/macos/IronClaw.app
```

Results: `svelte-check` 0 errors / 0 warnings; focused Vitest 3 files / 19
tests passed; work-product Playwright 8/8 passed; chat Playwright 5/5 passed;
static desktop smoke passed; Tauri produced the `.app`, DMG, and updater
tarball, then failed only updater signing because `TAURI_SIGNING_PRIVATE_KEY`
is absent; packaged smoke passed with no sidecar orphan. Active installed app
after deploy: PID `37657` with Reborn child PID `37666` on
`127.0.0.1:3000`. Smoke log:
`/tmp/ironclaw-packaged-smoke-post-export-20260602-004524.log`.

2026-06-02 gateway probe correction pass:

- Hostile finding: the installed Reborn v2 sidecar returned `404` for
  `/api/health` and `/api/gateway/status`, while desktop/static tests mocked
  those probes. That made readiness/model display evidence too soft.
- Product patch: Reborn v2 composition now serves real public probe routes at
  `/api/health` and `/api/gateway/status`. The status response reports
  `engine_v2_enabled:true`, the enabled channel `webchat-v2`, and the actual
  sidecar model env (`NEAR.AI / z-ai/glm-4.5` in the installed app).
- Runtime patch: rebuilt Reborn, copied the refreshed sidecar into
  `src-tauri/binaries/ironclaw-reborn-aarch64-apple-darwin`, rebuilt the Tauri
  bundle, replaced `/Applications/IronClaw.app`, and relaunched the installed
  app with the new sidecar SHA
  `73942a69feb1c56f2de677976d6a091a54a43ef31931c2f5c1203121b4000eed`.

Evidence from this pass:

```sh
cargo test -p ironclaw_reborn_composition --features webui-v2-beta gateway_probe_routes_are_public_and_report_v2_status --test webui_v2_serve -- --exact
cargo build --release -p ironclaw_reborn_cli --features webui-v2-beta --bin ironclaw-reborn
npm run tauri -- build
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/gateway/status
SMOKE_LOG_PATH=/tmp/ironclaw-packaged-smoke-gateway-status-20260602-005246.log bash scripts/smoke-packaged-app.sh --wait 8 --bundle src-tauri/target/release/bundle/macos/IronClaw.app
```

Results: focused Reborn router test passed; Reborn release sidecar built;
Tauri produced the `.app`, DMG, and updater tarball, then failed only updater
signing because `TAURI_SIGNING_PRIVATE_KEY` is absent; installed
`/api/health` returned 200; installed `/api/gateway/status` returned 200 with
`llm_backend:"NEAR.AI"` and `llm_model:"z-ai/glm-4.5"`; authenticated
`/api/webchat/v2/threads` still returned 200; packaged smoke passed and left
no sidecar orphan. Active installed app after deploy: PID `39357` with Reborn
child PID `39364` on `127.0.0.1:3000`.

2026-06-02 heartbeat live-status UI recheck:

- Follow-up hostile check: a static-browser render of the current shared UI,
  proxied to the live installed sidecar, now consumes the real
  `/api/gateway/status` response. This closes the previous concern that the UI
  only showed model/readiness via the fallback `todo` object.
- Evidence: `output/playwright/heartbeat-live-status-ui-proof.json` records
  `statusFromRealGateway:true`, `renderedModelLabel:true`,
  `composerVisible:true`, and `threadListAuthenticated:true`; screenshot at
  `output/playwright/heartbeat-live-status-ui-proof.png`.
- Remaining caveat: this is still Chromium against the shared static bundle and
  live sidecar, not native macOS WebView automation. Native packaged UI send
  with attachments remains the next acceptance gate.

2026-06-02 heartbeat native/work-product RED recheck:

- Native packaged UI proof is blocked in the current heartbeat session:
  `ironclaw-desktop` is running, but macOS accessibility reports
  `windows=0`, and `output/playwright/heartbeat-native-window-current.png` is
  a black screen capture. A non-destructive `open -a /Applications/IronClaw.app`
  did not surface an accessibility-visible window.
- Live static UI fallback against the installed sidecar proved a more important
  product RED: a CSV-backed work-product request persisted the user message and
  attachment, but did not produce an assistant/work-product message or export
  controls.
- Exact repro evidence: thread `59ae270d-4e0c-51a2-9236-e62c4b68c883` contains
  one submitted user message with an `<attachments>` block for
  `heartbeat-live-1780356570958-board.csv`; run id
  `66908cc3-e52c-4068-a442-1b56cea62576` returns `404` from the apparent
  `/api/webchat/v2/threads/:thread/runs/:run` route.
- Consolidated evidence:
  `output/playwright/heartbeat-native-and-live-workproduct-red.json`.

Current hostile conclusion: attachment transport/export controls are useful but
insufficient. The live sidecar needs either a real assistant/work-product result
for file-backed turns or a truthful pending/failed/blocked state tied to a
working run-status endpoint.

2026-06-02 heartbeat run-state route and failure-visibility correction:

- Prior RED narrowed: the exact file-backed run from the native/work-product
  recheck no longer returns route 404. Reborn WebChat v2 now exposes
  `GET /api/webchat/v2/threads/:thread_id/runs/:run_id`, mounted through the
  descriptor/router/handler/composition stack and locked by caller-level plus
  composed-gateway tests.
- Live proof: authenticated curl against installed `/Applications/IronClaw.app`
  sidecar for thread `59ae270d-4e0c-51a2-9236-e62c4b68c883` and run
  `66908cc3-e52c-4068-a442-1b56cea62576` returns 200 with status `Failed` and
  failure category `driver_protocol_violation`. Evidence:
  `/tmp/ironclaw-run-state-old-thread-after-ui-route.txt`.
- UI correction: static chat no longer falls straight to a blind
  "accepted but no assistant result" message when the timeline never receives
  an assistant reply. After the polling window it reads run state and renders
  the concrete failure; `npm run smoke:webui-static` now includes a rendered
  regression where `Failed / driver_protocol_violation` appears as
  `The run failed: driver protocol violation.` Screenshot:
  `output/playwright/static-run-state-failure-visible.png`.
- Runtime correction: rebuilt Reborn sidecar SHA
  `27159382645a3de399d9f7afd121ce0e0325ad6d9563cb85c11ee7f4d1bb10f5`,
  rebuilt Tauri, replaced `/Applications/IronClaw.app`, relaunched installed
  app, verified `/api/health`, `/api/gateway/status`, and packaged smoke.
  Tauri still stops only at updater signing because `TAURI_SIGNING_PRIVATE_KEY`
  is absent.

Current hostile conclusion after this pass: observability is no longer the
primary blocker for that repro. The remaining RED is execution quality:
`driver_protocol_violation` means the agent run failed before producing the
requested file-backed work product. Next review must attack the planned/default
driver path, not re-litigate whether the submitted run can be observed.

2026-06-02 connector lifecycle action correction:

- Hostile connector sidecar found the setup route was still projection-only:
  Gmail, Google Calendar, and Notion returned `discovered`; Slack was
  truthfully blocked; slash-prefixed catalog refs were correctly rejected.
- Backend correction: `POST /api/webchat/v2/extensions/:name/setup` now honors
  typed lifecycle actions. `install`, `activate`, `auth`, `configure`, and
  `remove` dispatch through the lifecycle facade; `begin/setup/status` remain
  idempotent projection/readiness checks. Unknown actions return 400 before
  lifecycle execution.
- Calendar correction: route `google-calendar` had been normalized internally
  to `google_calendar`, while the lifecycle registry package id is
  `google-calendar`; the setup route now maps Calendar lifecycle calls to the
  hyphenated package id.
- Static UI correction: the install path now sends `action:"install"` rather
  than ambiguous `begin`, while repeated setup/readiness can use projection.

Evidence from this pass:

```sh
cargo test -p ironclaw_product_workflow setup_extension_action_executes_configured_lifecycle_facade --test reborn_services_contract
cargo test -p ironclaw_product_workflow setup_extension_google_calendar_action_uses_lifecycle_package_id --test reborn_services_contract
cargo test -p ironclaw_product_workflow setup_extension_rejects_unknown_action_before_lifecycle_execution --test reborn_services_contract
node --check crates/ironclaw_webui_v2_static/static/js/pages/extensions/lib/extensions-api.js
npm run prepare:webui-static
npm run smoke:webui-static
cargo build --release -p ironclaw_reborn_cli --features webui-v2-beta --bin ironclaw-reborn
npm run tauri -- build
SMOKE_LOG_PATH=/tmp/ironclaw-packaged-smoke-connector-final-20260602-0310.log bash scripts/smoke-packaged-app.sh --wait 8 --bundle src-tauri/target/release/bundle/macos/IronClaw.app
```

Results: focused connector lifecycle tests passed; static desktop smoke passed;
Reborn release sidecar built; Tauri produced `.app`, DMG, and updater tarball
then failed only updater signing because `TAURI_SIGNING_PRIVATE_KEY` is absent;
packaged smoke passed with no sidecar orphan; `/Applications/IronClaw.app`
was replaced and relaunched with sidecar SHA
`9ade9d939074040be7f8fbcab278dec937d9dbd3ccf12580c14973103eb259bf` on port
3000.

Live installed connector evidence: `/api/health` returned 200;
`/api/gateway/status` returned `NEAR.AI / z-ai/glm-4.5`; Gmail, Google
Calendar, and Notion `activate` returned `phase:"active"`; Calendar returned
`package_ref.id:"google-calendar"`; `begin` returned the current active phase
idempotently; encoded slash ref `tools%2Fgmail` still returned `400 invalid_id`.

Current hostile conclusion after this pass: connector lifecycle activation is
no longer a projection-only lie for Gmail/Calendar/Notion, but connector
readiness is not fully green until OAuth/account state and a read-only provider
tool call are proven. Duplicate explicit `install` still returns 400 once an
extension is active because the lifecycle service refuses overwriting
materialized extension files; the UI must not offer install for active
packages.

2026-06-02 rendered connector truth correction:

- A hostile sidecar correctly caught that the first rendered connector proof
  showed Gmail, Google Calendar, and Notion as `ACTIVE` from package lifecycle
  alone. That was still a product lie: lifecycle package activation is not
  account readiness.
- Static connector presenter now separates package lifecycle from account
  readiness. Without explicit `account_ready` / `credential_ready` readiness
  evidence, Gmail/Calendar/Notion render `auth needed`; after a token is saved
  they may render `auth saved`, not connected/ready.
- The repeatable static smoke now mocks lifecycle `phase:"active"` and fails if
  the UI badges Gmail as active before credentials/account readiness are proven.
- Fresh live-sidecar rendered proof passed:
  `output/playwright/connector-live-20260602-0105/connector-live-proof.json`.
  Screenshots in the same directory show installed connectors, Gmail configure,
  slash-ref Gmail deep link, Slack blocked deep link, and empty registry.
- Request evidence in that proof: lifecycle URLs are canonical bare names
  (`/extensions/gmail/setup`, `/extensions/google-calendar/setup`,
  `/extensions/notion/setup`); slash-prefixed catalog refs remain payload
  metadata only; Slack deep link does not call lifecycle; registry has zero
  duplicate install buttons.
- `/Applications/IronClaw.app` was replaced with the rebuilt bundle, packaged
  smoke passed at
  `/tmp/ironclaw-packaged-smoke-connector-ui-truth-20260602-0115.log`, and the
  app was reopened with sidecar on port 3000.

Current hostile conclusion after this pass: connector rendered UI is now honest
about account readiness and no longer sends slash-prefixed refs as lifecycle
names. It remains YELLOW, not GREEN, because no real OAuth/account readiness or
read-only provider tool call has been proven.

2026-06-02 live Product Auth correction:

- Fresh bundled-sidecar probe:
  `output/live-connector-probe/reborn-live-connector-probe-2026-06-02T04-17-12-838Z.json`.
- The live sidecar accepts env-bearer auth and rejects unauthenticated setup
  with `401`; encoded slash lifecycle path
  `/api/webchat/v2/extensions/tools%2Fgmail/setup` returns
  `400 invalid_request`. This preserves the Reborn connector rule: catalog refs
  such as `tools/gmail`, `tools/google_calendar`, `mcp-servers/notion`, and
  `channels/slack` are payload/display metadata only, never lifecycle names.
- Product Auth manual-token setup and secret-submit returned `200` for Gmail,
  Google Calendar, and Notion with dummy tokens in an isolated temp HOME. This
  proves credential storage route wiring, not external provider access.
- Live lifecycle configure for Gmail, Google Calendar, and Notion returns
  `phase:"unsupported_or_legacy"` with blocker
  `extension_auth_and_configure_not_yet_wired`; lifecycle activate returns
  `400 invalid_request`. Slack begin returns `unsupported_or_legacy` with
  `extension_lifecycle_package_unavailable`.
- The static UI now persists that backend blocker as `runtime blocked`, hides
  Activate for blocked credentials, and the static smoke fails if a blocked
  configure still exposes Activate.
- Packaged smoke after the update passed at
  `/tmp/ironclaw-packaged-smoke-20260602-061810.log`.

Current hostile conclusion after this correction: connectors are RED for real
use and YELLOW only for honest credential-storage/setup UX. Do not call Gmail,
Calendar, Notion, or Slack connected until a live readiness/active state and a
safe read-only provider tool call are proven.

2026-06-02 live attachment/work-product correction:

- Fresh running-sidecar attachment probe:
  `output/live-work-product-probe/reborn-live-chat-attachment-probe-2026-06-02T04-42-10-732Z.json`.
- The packaged app sidecar on port `3000` accepted a real user message with a
  CSV attachment via
  `POST /api/webchat/v2/threads/510f0579-d005-4716-8097-832b43cbf13e/messages`
  and returned `200`, `outcome:"submitted"`, an accepted message ref, turn id,
  and run id.
- `GET /api/webchat/v2/threads/510f0579-d005-4716-8097-832b43cbf13e/timeline?limit=50`
  returned the submitted user message with an `<attachments>` block, filename
  `codex-live-route-probe.csv`, `mime_type:text/csv`, `size_bytes:28`,
  `extraction_status:extracted_text`, and the extracted CSV rows. This is live
  route proof that attachment payloads reach Reborn and reload through
  timeline.
- `GET /api/webchat/v2/threads/{thread_id}/messages?limit=50` returned `405`;
  timeline is the working reload route for this sidecar.
- Focused rendered export suite passed 16/16:
  `npx playwright test tests/e2e/file-generation-export.spec.ts tests/e2e/work-product-actions.spec.ts --reporter=line`.
  This proves UI/export code paths for XLSX, CSV, DOCX, PPTX, JSON, Markdown,
  DOCX, PDF, HTML, full-thread JSON/Markdown, and Work artifact copy/export
  under browser/Tauri mocks.
- Native packaged click-through remains RED. The running app has CGWindow
  entries, but full-screen capture was black, window capture failed with
  `could not create image from window`, System Events reported zero accessible
  windows, and coordinate click/keystroke automation failed with macOS error
  `-25200`.

Current hostile conclusion after this correction: attachment payload ingress and
timeline reload are GREEN at the live Reborn route level; export controls are
GREEN only in rendered browser proof; native packaged WebView click-through and
live model work-product quality remain RED.

2026-06-02 packaged WebView smoke correction:

- Added a first-party packaged smoke hook that is inert unless the harness sets
  `IRONCLAW_PACKAGED_WEBVIEW_SMOKE=1`. This avoids blind coordinate clicking
  and proves the shipped WebView can execute the shared static UI code.
- Final packaged WebView evidence:
  `/tmp/ironclaw-packaged-webview-smoke-20260602-072013.json`; packaged smoke
  log: `/tmp/ironclaw-packaged-smoke-20260602-072013.log`.
- The rebuilt `IronClaw.app` launched from isolated HOME, exposed sidecar port
  `3100` to the WebView, stored only a local bearer by length, reached
  `/api/health`, created thread `77e14e29-cac2-46c0-8b6d-6e4ff0b5268a`, and
  submitted a message with `packaged-webview-smoke.csv`.
- Timeline reload through `/api/webchat/v2/threads/{thread_id}/timeline`
  preserved both the submitted prompt and the attachment payload with extracted
  CSV text. Filename-only proof is no longer accepted by the smoke gate.
- The WebView built and validated Markdown, HTML, JSON, PDF, and DOCX export
  blobs. The smoke script now fails unless all 12 evidence checks pass before
  app termination.
- `npm run check`, `cargo check --manifest-path src-tauri/Cargo.toml`,
  `npm run smoke:webui-static`, and focused Playwright work-product/export
  tests all passed. `npm run tauri -- build --bundles app` produced the `.app`
  and then hit the known missing `TAURI_SIGNING_PRIVATE_KEY`.
- Current user-visible app remains open separately: app pid `39505`, Reborn
  sidecar pid `39512`, listening on `127.0.0.1:3000`, health
  `{"channel":"webui-v2","status":"ok"}`.

Current hostile conclusion after this correction: packaged WebView transport,
attachment ingress/extraction/timeline reload, and export-builder execution are
GREEN under the first-party smoke hook. Physical click-through remains RED due
macOS screenshot/accessibility blockers, live model-generated work-product
quality remains RED, and real connector connectivity remains RED.

2026-06-02 run-state failure surfacing correction:

- Live assistant/run probe:
  `output/live-work-product-probe/reborn-live-assistant-run-probe-2026-06-02T06-16-50-068Z.json`.
- The user-visible app sidecar on port `3000` accepted a real message with a
  CSV attachment and returned `200`, `outcome:"submitted"`, thread
  `6aa58053-303c-4d53-8d46-cf1545b5d70c`, and run
  `3508bd14-f611-491d-966d-72a4aec42061`.
- The live timeline preserved the submitted user message and extracted CSV
  attachment text, but the run state was `Failed` with
  `failure.category:"policy_denied"` and `assistant_message_count:0`.
- The Svelte chat controller now polls
  `/api/webchat/v2/threads/{thread_id}/runs/{run_id}` after an accepted send
  and after SSE active-run adoption. Terminal failures render provider/model
  denial copy, clear processing, and keep the composer usable.
- The shared static WebView chat hook has the same run-state polling behavior,
  and the static bundle was regenerated.
- Focused controller proof passed:
  `npx vitest run src/lib/stores/reborn-chat.test.ts src/lib/api/reborn.test.ts`
  with 50/50 tests passing, including the policy-denied run-state case.
- Hardened rendered proof passed:
  `CI=1 npx playwright test tests/e2e/chat.spec.ts -g "failed Reborn run surfaces model denial" --reporter=line`.
  The test requires same-thread/same-run correlation across message POST, SSE
  accepted, timeline reload, and run-state read; it asserts the denial copy is
  visible, no fake assistant reply appears, no missing-assistant fallback
  appears, Stop clears, the composer can send again after typing, and no
  `Copy Assistant response` work-product controls mount for an error-only turn.
- Focused chat/work-product browser sweep passed 32/32:
  `CI=1 npx playwright test tests/e2e/chat.spec.ts tests/e2e/work-product-actions.spec.ts --reporter=line`.
- Rebuilt packaged app and reran WebView smoke after static bundle regeneration:
  `/tmp/ironclaw-packaged-webview-smoke-20260602-081816.json`,
  `/tmp/ironclaw-packaged-smoke-20260602-081816.log`, 12/12 PASS.
- The user-visible app remains open separately: app pid `39505`, Reborn sidecar
  pid `39512`, listening on `127.0.0.1:3000`, health
  `{"channel":"webui-v2","status":"ok"}`.

Current hostile conclusion after this correction: chat truthfulness for accepted
runs that fail `policy_denied` is YELLOW/GREEN under rendered tests; live
work-product generation remains RED because the configured model still produces
zero assistant output. The next product gate is not more mocked export testing;
it is model readiness/preflight plus a plan-allowed live run that produces
attachment-derived work product and validated exports.

2026-06-02 live model-readiness block correction:

- Clean live gateway-status artifact:
  `output/live-work-product-probe/live-gateway-status-2026-06-02T06-24-43Z.json`.
- The active user-visible sidecar on port `3000` reports `llm_backend:"NEAR.AI"`,
  `llm_model:"z-ai/glm-4.5"`, `model_execution_verified:false`,
  `model_readiness:"unverified"`, and
  `model_readiness_reason:"Gateway status reports configured provider/model only; execution is verified by a successful WebChat run."`
- The static readiness contract passed:
  `node --test crates/ironclaw_webui_v2_static/static/js/lib/model-readiness.test.mjs`
  with 4/4 tests passing.
- The canonical rendered static smoke passed:
  `npm run smoke:webui-static`. Its unverified branch requires the warning
  "The selected model has not passed an execution test. Choose a verified model
  before sending.", proves Send is disabled, and proves no message POST occurs.
  Its mocked GREEN branch still proves PDF attachment payload and work-product
  rendering, but remains mocked and must not be confused with live generation.
- Live rendered static probe against the active sidecar passed. Evidence
  screenshot: `output/playwright/live-static-model-readiness-block.png`.
  The visible model control showed
  `Configured (unverified): NEAR.AI / z-ai/glm-4.5`; after typing a prompt,
  Send was disabled and zero `/api/webchat/v2/threads/{thread}/messages` POSTs
  fired.
- Temporary static server on port `17631` was stopped after the live probe; the
  user-visible app sidecar stayed healthy on port `3000`.

Current hostile conclusion after this correction: the canonical static UI is no
longer allowed to send into the known-unverified GLM path. Live work-product
generation is still RED, but the failure mode is now correctly surfaced as a
model/provider readiness blocker. The next useful work is to find/configure a
plan-allowed model path that can return GREEN readiness and then prove a hidden
attachment-derived services agreement/export flow end to end.

2026-06-02 Svelte model-readiness parity correction:

- Added TypeScript readiness helper:
  `src/lib/util/model-readiness.ts` and
  `src/lib/util/model-readiness.test.ts`.
- `src/lib/api/types.ts` and `src/lib/api/ironclaw.ts` now preserve
  `model_execution_verified`, `model_execution_readiness`, `model_readiness`,
  `model_readiness_reason`, and related execution-failure fields from
  `/api/gateway/status`.
- `src/lib/components/ChatModelSelector.svelte` now tells the user when the
  running model is configured but not execution-verified.
- `src/lib/components/RebornChatPanel.svelte` now blocks Send and Enter before
  dispatch when the connected gateway cannot verify model execution; the draft
  stays in the composer and a warning renders above the controls.
- `tests/e2e/_helpers.ts` now makes normal mocked chat tests explicit by
  defaulting to `model_execution_verified:true`, while allowing individual tests
  to override gateway status.
- New rendered regression in `tests/e2e/chat.spec.ts`: unverified gateway status
  disables Send, Enter does not send, typed text remains in the composer, no
  sent bubble appears, and zero WebChat message POSTs fire.
- Focused proof passed:
  `npx vitest run src/lib/util/model-readiness.test.ts src/lib/components/ChatModelSelector.test.ts src/lib/components/RebornChatPanel.test.ts src/lib/api/ironclaw.test.ts`
  with 63/63 tests passing.
- Rendered proof passed:
  `CI=1 npx playwright test tests/e2e/chat.spec.ts -g "chat blocks sends before dispatch|failed Reborn run surfaces model denial" --reporter=line`
  with 2/2 tests passing.
- Broader proof passed:
  `npm run check` and
  `CI=1 npx playwright test tests/e2e/chat.spec.ts tests/e2e/work-product-actions.spec.ts --reporter=line`
  with 33/33 rendered tests passing.

Current hostile conclusion after this correction: both the canonical static UI
and the Svelte legacy chat panel refuse to dispatch into the known-unverified
model path. Live generation remains RED until `/api/gateway/status` or a live
probe proves a model can execute and an assistant result is created from hidden
attachment-only facts.

## Open Review Questions

- Should pending approval boundaries make the initial Work Item status `waiting-approval`, or is `active` correct until an execution step is reached?
- Should manual `/work` creation invoke the router for non-general domains, or remain a purely manual matter stub?
- What is the minimum evidence/provenance schema needed before research/legal/finance outputs can be considered "review-ready" rather than merely planned?
- Which execution paths are authoritative for send, write, export, delete, push, PR, trade, and money movement, and where should approval-boundary checks live?
