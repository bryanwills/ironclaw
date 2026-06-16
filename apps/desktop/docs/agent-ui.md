# Agent-controlled UI

The goal: let the IronClaw agent **see and drive the desktop app** the way a
person does — read what's on screen, navigate, open a thread, start a new chat
— by exposing the app's own actions to the model as **client-executed tools**.
This is **gated on gateway support and is not active today** (see Status): the
client half ships, but the server cannot yet hand a tool call back to the
desktop, so the app does not claim the agent can operate it.

## Status

The **client half is complete and shipped** (v0.4.93–v0.4.97), under
`src/lib/agent-ui/`:

| Module        | Role                   | Key exports                                                                                                               |
| ------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `actions.ts`  | the registry ("drive") | `NAV_SURFACES`, `AgentUiHost`, `AgentAction`, `AgentActionResult`, `AGENT_ACTIONS`, `actionSchemas()`, `dispatchAction()` |
| `state.ts`    | the reader ("see")     | `UiStateSource`, `UiState`, `readUiState()`, `surfaceForPath()`, `redactSecrets()`                                        |
| `host.ts`     | real adapter           | `AgentUiHostDeps`, `createAgentUiHost()`                                                                                  |
| `delegate.ts` | the server seam        | `ClientToolCall`, `ClientToolResult`, `handleClientToolCall()`                                                            |

All four are pure (dependencies injected) and unit-tested. **What's missing for
end-to-end is server-side**: IronClaw's Responses API executes tools on the
server today, so it has no way to hand a tool call back to the client to run.
That extension is specified at the end of this doc; it needs the live backend
and is not built here.

**Readiness is gated in the app.** `src/lib/agent-ui/readiness.svelte.ts` is the
single source of truth: `agentUiReadiness({ clientToolDelegation })` maps a
gateway capability to a Supported / Not-supported verdict, and **Settings →
Advanced** renders it as an "Agent-controlled UI" diagnostics row. Nothing sets
`clientToolDelegation` true yet, so the app honestly reports the feature as
unavailable and exposes no affordance implying the agent can drive the desktop.
When the server seam ships, the connection layer flips that one flag and every
gated surface updates through `readiness`.

## Principle: semantic actions, not DOM control

The agent never touches the DOM or pixels. It calls a **curated catalog of
named, typed, app-native actions** (`navigate`, `open_thread`, `new_chat`, …),
each with a JSON-Schema parameter shape. This is the deliberate opposite of
computer-use/`querySelector().click()`:

- **Robust** — survives UI refactors; the action is a contract, not a selector.
- **Bounded + safe** — the agent can only do what the catalog allows. `navigate`
  is restricted to real user-facing routes (`dev`/`mini`/`onboarding` excluded
  so the agent can't strand the user).
- **Explainable + testable** — each action is a small function with a result.
- **Reusable** — the same catalog can power the command palette for humans and
  client-executed tools for the agent. (The app already had this vocabulary in
  the palette + deep links; the registry formalizes it.)

The schemas double as the tool definitions the model sees (`actionSchemas()`).

## Data flow (end-to-end, once the server seam exists)

```
agent (server run) decides to call a UI tool
        │  (IronClaw must register the client tools on the run)
        ▼
IronClaw emits a `client_tool_call` event on the run's SSE stream and PAUSES
the run (same lifecycle as an approval gate)
        ▼
desktop client receives it →
  handleClientToolCall({ tool_call_id, name, arguments }, host)   [delegate.ts]
        │  parses object|JSON-string args; never throws
        ▼
  dispatchAction(name, args, host)                                [actions.ts]
        │  looks up the action; unknown → error result
        ▼
  action.run(args, host) → host.navigate / host.openThread / host.newChat
        │                                                         [host.ts]
        ▼
  goto(path) / rebornThreads.select(id|null)   (real app effects)
        ▼
delegate returns { tool_call_id, output, is_error }  (OpenAI function_call_output shape)
        ▼
desktop POSTs that envelope back → IronClaw resumes the run with the tool result
```

"See" works the same way or as auto-attached run context: the client builds a
`readUiState(source)` snapshot (current surface, active thread, open modal,
composer draft, connection status, profile) and hands it to the agent. It is
**redacted** — `redactSecrets()` masks bearer / `sk-` / GitHub / long-hex token
shapes (e.g. a token pasted into the composer), and `UiStateSource` has no
credential field by construction.

## Security model

- **Bounded catalog** — the agent can only invoke registered actions; the seed
  set is reversible/non-destructive (navigation, thread selection).
- **Graceful failure** — `dispatchAction` and `handleClientToolCall` never
  throw: an unknown action, bad JSON, non-object args, or an action-level
  failure all return `is_error: true` with a readable `output` the model can
  recover from.
- **Redacted reads** — secrets never ride in the state snapshot.
- **Future: gated mutations** — destructive actions (delete, send, settings
  changes) should route through the existing approval-gate / tool-policy system
  so they need a human tap; only safe, reversible actions auto-run.
- **No reentrancy** — UI tools manipulate the interface, never "send a message
  to myself" (the agent is already inside a run; that path is recursion).

## Wiring sketch (client, when the seam lands)

```ts
import { goto } from '$app/navigation';
import { rebornThreads } from '$lib/stores/reborn-threads.svelte';
import { createAgentUiHost } from '$lib/agent-ui/host';
import { handleClientToolCall } from '$lib/agent-ui/delegate';
import { actionSchemas } from '$lib/agent-ui/actions';

const host = createAgentUiHost({ goto, selectThread: (id) => rebornThreads.select(id) });

// register actionSchemas() as client tools when starting the run, then:
// on a `client_tool_call` SSE event:
const result = await handleClientToolCall(event, host);
// POST result back to IronClaw's submit-tool-output endpoint.
```

## IronClaw server extension (the remaining piece — for review)

Today (`/tmp/ironclaw-api.md` §Responses API, `POST /api/v1/responses`) the
Responses API accepts a `tools` array but **routes tool execution through
server-side agent middleware** — there is no caller-executed (function) tool
lifecycle exposed. To let the agent drive the _client_ UI, the run loop needs a
delegate-to-caller path. This mirrors OpenAI's function-call → `function_call_output`
loop and reuses IronClaw's existing gate (pause/resume) machinery:

1. **Register client tools on the run.** Accept caller-supplied tool definitions
   on run creation (or a session-scoped registration) and add them to the
   model's toolset, flagged as _client-executed_ (the server must not try to run
   them itself). The desktop sends `actionSchemas()`.
2. **Emit a pause event.** When the model calls a client tool, do **not**
   execute it. Emit an SSE event on the run stream —
   `{ type: "client_tool_call", run_id, tool_call_id, name, arguments }` — and
   **pause the run** exactly as a gate pauses it awaiting approval.
3. **Accept the tool output.** Add an endpoint to resume the run with the
   client's result, carrying delegate's envelope verbatim:
   `POST /api/.../runs/{run_id}/client-tool-output`
   `{ tool_call_id, output, is_error }`. Inject it as the tool result and
   continue the run.
4. **Timeout.** If the client never responds (disconnect, ignored), time the
   pause out and inject an error tool result so the run can't hang — same policy
   as a gate timeout.

If v0.29's "external tools in the Responses API" already supports a
function-call→submit-output round-trip, the desktop can use that directly and
this reduces to wiring; otherwise the WebChat v2 run loop needs the three
additions above (register / pause-event / submit-output), which the gate
lifecycle already models.

## Open questions

- **Read delivery**: a `get_ui_state` tool (agent pulls on demand) vs.
  auto-attaching a compact snapshot to each run as context. Hybrid likely best.
- **Action catalog growth**: `set_composer_text`, `open_settings_section`,
  `set_filter`, `pin_widget` — each verified against the real store API before
  adding, each classified safe vs. gated.
- **Command-palette reuse**: expose the same registry through the palette so
  humans exercise it now and the agent later (validates the catalog end-to-end
  without the server).
