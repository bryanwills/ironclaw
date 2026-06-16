// Real AgentUiHost adapter — a factory over injected capabilities.
//
// Kept PURE on purpose: it imports neither `$app/navigation` nor any store, so
// it unit-tests without the SvelteKit runtime or a DOM and carries no
// transitive-import weight. The integration point supplies the two
// capabilities, e.g.:
//
//   import { goto } from '$app/navigation';
//   import { rebornThreads } from '$lib/stores/reborn-threads.svelte';
//   const host = createAgentUiHost({
//     goto,
//     selectThread: (id) => rebornThreads.select(id)
//   });
//
// `navigate` → goto(path); `openThread(id)` → selectThread(id);
// `newChat()` → selectThread(null) (rebornThreads.select(null) starts a fresh
// conversation). Errors thrown by the injected deps are not swallowed here —
// dispatchAction() already wraps action.run() in try/catch and surfaces a
// failed result, so a goto/select failure degrades into a readable tool error.

import type { AgentUiHost } from './actions';

export interface AgentUiHostDeps {
  /** Navigate to a route path (SvelteKit `goto`). */
  goto: (path: string) => unknown;
  /** Select a chat thread by id, or null for a new chat (`rebornThreads.select`). */
  selectThread: (id: string | null) => void;
}

/** Build a real {@link AgentUiHost} from injected capabilities. */
export function createAgentUiHost(deps: AgentUiHostDeps): AgentUiHost {
  return {
    navigate: (path: string) => {
      void deps.goto(path);
    },
    openThread: (id: string) => {
      deps.selectThread(id);
    },
    newChat: () => {
      deps.selectThread(null);
    }
  };
}
