// Agent-UI action registry — the semantic, typed catalog of UI actions the
// agent may invoke as client-executed tools.
//
// Design: app-native, BOUNDED actions (never raw DOM/pixel control). Each entry
// is a named, JSON-Schema'd operation dispatched through an injected
// `AgentUiHost`, so the registry stays pure and unit-testable; the real host
// (goto + stores) is a thin adapter wired in at the call site. The same catalog
// can drive the command palette for humans and client-executed tools for the
// agent once the IronClaw side can delegate a tool call to the client.
//
// Read actions (a redacted UI-state snapshot) live alongside in ./state.ts.
// This module is navigation/mutation actions; the seed set is intentionally
// SAFE-by-default — reversible, non-destructive. Anything destructive must be
// added behind the approval/gate path, never auto-run.

/**
 * Surfaces the agent may navigate to, mapped to their route paths. Only real,
 * user-facing routes are allowed — `dev`, `mini`, and `onboarding` are
 * deliberately excluded so the agent can't strand the user on an internal or
 * modal-only surface.
 */
export const NAV_SURFACES = {
  chat: '/chat',
  desk: '/desk',
  work: '/work',
  dashboard: '/dashboard',
  canvas: '/canvas',
  knowledge: '/knowledge',
  memory: '/memory',
  skills: '/skills',
  routines: '/routines',
  jobs: '/jobs',
  logs: '/logs',
  extensions: '/extensions',
  missions: '/missions',
  streams: '/streams',
  settings: '/settings',
  admin: '/admin'
} as const;

export type NavSurface = keyof typeof NAV_SURFACES;

/**
 * The minimal capability surface the registry needs from the app. Injected so
 * the registry stays pure: tests pass a fake, production passes a goto-backed
 * adapter.
 */
export interface AgentUiHost {
  navigate(path: string): void;
  /** Open an existing chat thread by id (real host: rebornThreads.select(id)). */
  openThread(threadId: string): void;
  /** Start a fresh chat (real host: rebornThreads.select(null)). */
  newChat(): void;
}

export type AgentActionResult = { ok: true; detail: string } | { ok: false; error: string };

export interface AgentAction {
  name: string;
  description: string;
  /** JSON Schema for the action's arguments (the shape registered as a tool). */
  parameters: Record<string, unknown>;
  run(
    args: Record<string, unknown>,
    host: AgentUiHost
  ): AgentActionResult | Promise<AgentActionResult>;
}

const navigate: AgentAction = {
  name: 'navigate',
  description:
    'Move the app to a top-level surface (e.g. show the user the Knowledge base, their Routines, or the chat).',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      surface: {
        type: 'string',
        enum: Object.keys(NAV_SURFACES),
        description: 'Which surface to navigate to.'
      }
    },
    required: ['surface']
  },
  run(args, host) {
    const surface = args.surface;
    if (typeof surface !== 'string' || !(surface in NAV_SURFACES)) {
      return { ok: false, error: `Unknown surface: ${String(surface)}` };
    }
    host.navigate(NAV_SURFACES[surface as NavSurface]);
    return { ok: true, detail: `Navigated to ${surface}` };
  }
};

const openThread: AgentAction = {
  name: 'open_thread',
  description: 'Open an existing chat thread by its id and show it to the user.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      thread_id: { type: 'string', description: 'The id of the thread to open.' }
    },
    required: ['thread_id']
  },
  run(args, host) {
    const threadId = args.thread_id;
    if (typeof threadId !== 'string' || threadId.trim().length === 0) {
      return { ok: false, error: 'open_thread requires a non-empty thread_id' };
    }
    host.openThread(threadId);
    return { ok: true, detail: `Opened thread ${threadId}` };
  }
};

const newChat: AgentAction = {
  name: 'new_chat',
  description: 'Start a fresh, empty chat conversation.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  run(_args, host) {
    host.newChat();
    return { ok: true, detail: 'Started a new chat' };
  }
};

/**
 * The registry. Keep entries SAFE-by-default (reversible, non-destructive);
 * gated/destructive actions must be added behind the approval path.
 */
export const AGENT_ACTIONS: readonly AgentAction[] = [navigate, openThread, newChat];

/** Tool catalog the agent sees — name/description/parameters per action. */
export function actionSchemas(): Array<Pick<AgentAction, 'name' | 'description' | 'parameters'>> {
  return AGENT_ACTIONS.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters
  }));
}

/**
 * Dispatch a named action. Unknown names resolve to an error result rather than
 * throwing, so a hallucinated or stale tool call from the agent degrades
 * gracefully into a result the model can read and recover from.
 */
export async function dispatchAction(
  name: string,
  args: Record<string, unknown>,
  host: AgentUiHost
): Promise<AgentActionResult> {
  const action = AGENT_ACTIONS.find((a) => a.name === name);
  if (!action) return { ok: false, error: `Unknown action: ${name}` };
  try {
    return await action.run(args ?? {}, host);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
