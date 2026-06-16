# Agent Handoff Protocol

This protocol is for overnight / multi-agent execution of the IronClaw Desktop
refactor. The goal is to make `crates/ironclaw_webui_v2_static/static` the
canonical desktop UI, package it directly in Tauri, and prove it works in the
installed app with the real local Reborn sidecar.

The core rule:

> A phase is not complete until the next agent can start from its handoff
> without guessing what changed, what was tested, what failed, or what still
> needs to be protected.

## Non-Negotiables

- Do not reset, stash, or overwrite dirty work unless the user explicitly asks.
- Do not treat mocked Svelte tests as proof of the shipped desktop app.
- Do not report green from API curls alone; the packaged/static UI must be
  exercised when the phase touches user-visible behavior.
- Do not mark connectors connected from localStorage or optimistic UI state.
- Do not hide failures behind "ready", "connected", or "model ready" copy.
- Do not duplicate the Reborn static UI into a desktop-only fork.
- Do not expand giant files when a focused helper/module can own the behavior.
- Do not start the next phase until the previous phase has a written handoff.

## Canonical Paths

- Desktop repo: `/Users/abhishekvaidyanathan/openclaw-knowledge/ironclaw-desktop`
- Reborn source repo: `/Users/abhishekvaidyanathan/Documents/Playground/ironclaw`
- Canonical static UI inside desktop:
  `crates/ironclaw_webui_v2_static/static`
- Tauri app shell:
  `src-tauri`
- Legacy/reference Svelte shell:
  `src`
- Packaged app target:
  `/Applications/IronClaw.app`

## Agent Roles

Use narrow agents. Each agent owns one lane and leaves a compact handoff.

### Sync Agent

Purpose: pull latest `reborn-integration` and update the static WebUI source.

Owns:

- upstream branch status
- static asset sync
- conflict notes
- generated bundle diffs

Must not:

- redesign UI
- change Tauri runtime behavior
- declare product readiness

Exit proof:

- exact upstream commit SHA
- exact files copied/updated
- diff summary
- build/static smoke result

### Static UI Agent

Purpose: make the static Reborn WebUI usable as the desktop product surface.

Owns:

- `crates/ironclaw_webui_v2_static/static`
- CSS/fonts/assets bundling
- chat UI behavior
- visible model controls
- attachment UI payload handling
- truthful empty/error/loading states

Must not:

- add desktop-only behavior that cannot live in the shared static UI
- rely on CDN assets
- make route stubs look real

Exit proof:

- rendered screenshots or Playwright traces
- no external static asset requests unless explicitly approved
- chat send test through static UI

### Runtime Agent

Purpose: make the Tauri app launch and supervise the Reborn sidecar.

Owns:

- `src-tauri`
- sidecar launch/restart/stop
- port selection
- token bootstrap
- gateway readiness
- native commands exposed to static UI

Must not:

- patch static UI to paper over backend failures
- kill unrelated user processes

Exit proof:

- `cargo check --manifest-path src-tauri/Cargo.toml`
- packaged app smoke
- process snapshot before/after
- no orphaned Reborn sidecar after app exit

### Connector Agent

Purpose: make connector setup truthful and functional.

Owns:

- Product Auth route calls
- extension lifecycle projection
- Gmail / Calendar / Notion setup
- unsupported connector handling

Must not:

- show Slack as usable until a real bundled lifecycle exists
- report "connected" unless backend state proves it

Exit proof:

- setup route sequence
- backend lifecycle response
- one read-only tool call where possible
- blocked state rendered correctly where not possible

### Work Product Agent

Purpose: make files and generated outputs actually useful.

Owns:

- attachments reaching Reborn
- PDF/DOCX/XLSX/CSV/JSON/PPTX dummy scenarios
- copy/export/save controls
- downloaded artifact validation

Must not:

- claim file support from chip rendering alone
- treat a one-page generic answer as document generation success

Exit proof:

- uploaded file payload evidence
- rendered assistant result
- downloaded export parsed and checked
- reload preserves the work product

### Hostile QA Agent

Purpose: attack fake proof, dead routes, and product lies.

Owns:

- installed-app verification
- route contract audit
- accessibility smoke
- screenshots
- "RED/YELLOW/GREEN" surface table

Must not:

- fix issues unless explicitly assigned
- soften RED status because other agents made progress

Exit proof:

- surface table
- top blockers
- exact repro steps
- evidence paths

## Phase Handoff Packet

Every agent must end with this exact structure:

```md
## Handoff: Phase N - Name

Status: GREEN | YELLOW | RED
Owner lane: Static UI | Runtime | Connector | Work Product | Hostile QA | Sync

### Goal
One paragraph describing the phase objective.

### Changed
- file/path: what changed and why

### Verified
- command or rendered test: result

### Evidence
- screenshot path, trace path, log path, curl response, process snapshot, or test result

### Still RED
- blocker with exact file/route/repro

### Risks
- residual uncertainty or unproven behavior

### Next Agent Should Start Here
1. exact first command or file to inspect
2. exact next failing behavior to reproduce
3. exact acceptance gate to satisfy

### Do Not Touch
- unrelated dirty files, user work, or known fragile area
```

If the agent cannot provide this packet, the phase is not done.

## Phase Status Rules

Use strict status.

- `GREEN`: implemented, tested through the relevant real surface, and ready for
  the next phase.
- `YELLOW`: useful progress, but missing installed-app proof, external service
  proof, or full route coverage.
- `RED`: user-facing behavior is broken, fake, stubbed, or unproven.

Never call a phase GREEN when:

- the installed app was not launched for a desktop-runtime change
- chat was not tested by sending a real message through UI
- connector "connected" state came from localStorage
- attachments were not observed in the request payload
- exports were not downloaded and parsed
- the model selector was only visually present
- the sidecar route was tested only with mocks

## Overnight Execution Loop

Run phases in loops, not one giant agent.

1. Supervisor writes the active phase objective and lane.
2. Worker agent makes the smallest coherent set of changes.
3. Worker runs the phase-specific proof.
4. Worker writes the handoff packet.
5. Hostile QA agent reviews the handoff and either marks it accepted or sends it
   back with exact RED blockers.
6. Supervisor starts the next lane only after the handoff is accepted.

If a worker gets stuck for more than one hour:

- stop broad exploration
- write a RED handoff
- include the exact failing command/repro
- let the next agent attack that blocker directly

## Evidence Requirements By Phase

### Reborn Sync

Required:

- upstream branch and SHA
- desktop diff summary
- static smoke result

Recommended commands:

```bash
git -C /Users/abhishekvaidyanathan/Documents/Playground/ironclaw status --short --branch
git -C /Users/abhishekvaidyanathan/Documents/Playground/ironclaw rev-parse HEAD
npm run smoke:webui-static
```

### Static UI Packaging

Required:

- no CDN requests during static render
- first screen screenshot
- direct `/v2/chat` screenshot
- console errors captured

Acceptance:

- app renders without Tailwind browser compiler
- logo/assets have correct packaged paths
- no blank screen offline

### Chat Send

Required:

- installed or static UI sends message
- backend accepts turn
- user message remains visible
- assistant reply renders
- reload preserves timeline

Acceptance:

- first send from empty chat works
- SSE missing/late completion does not strand the UI
- timeline supports live `messages` and older `records` shapes

### Model Selection

Required:

- active provider/model visible
- model dropdown/control opens
- selected model persists
- native sidecar restart command runs in Tauri when needed

Acceptance:

- default is not vague `auto`
- NEAR.AI model such as `z-ai/glm-4.5` can be selected
- failures block send with useful recovery text

### Attachments And Work Products

Required:

- PDF, DOCX, XLSX, CSV, JSON, image, PPTX dummy coverage
- request payload contains attachment metadata and content/reference
- assistant output uses the file
- export controls produce parseable files

Acceptance:

- no "chip only" file support
- no generic one-page output for detailed document prompts
- exported artifacts contain expected clauses/tables/content

### Connectors

Required:

- Gmail, Calendar, Notion setup route sequence
- lifecycle state comes from backend
- unsupported connectors render as unavailable

Acceptance:

- no Slack card unless real runtime exists
- no "connected" without backend proof
- read-only tool call proven where credentials/OAuth allow

### Packaged App

Required:

- build or existing bundle path
- launched app PID
- Reborn sidecar PID and port
- gateway probe
- app termination check

Acceptance:

- no orphan sidecar
- exact active port known
- local network prompt/recovery documented
- `/Applications/IronClaw.app` can perform a real chat turn

## Branch And Dirty Worktree Discipline

Before every phase:

```bash
git status --short --branch
```

Rules:

- Treat existing dirty files as user/parallel-agent work.
- Do not stage everything blindly.
- Do not revert unrelated files.
- If a file is already dirty and the phase must touch it, inspect the diff first.
- If concurrent changes appear mid-phase, mention them in the handoff.

## Final Supervisor Summary

At the end of the overnight run, the supervisor must produce:

- phase table with GREEN/YELLOW/RED
- commits or uncommitted diff summary
- installed app status
- sidecar process status
- exact top 5 next blockers
- tests passed/failed
- evidence paths

Use this rule for the final claim:

> If a sleeping user wakes up, opens `/Applications/IronClaw.app`, types a
> message, selects a model, attaches a file, and tries a connector, the summary
> must honestly predict what will happen.
