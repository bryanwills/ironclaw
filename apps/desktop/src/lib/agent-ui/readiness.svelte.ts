// Agent-UI readiness gating (review ICD-010).
//
// The agent-UI client modules (actions/state/host/delegate) are complete and
// pure, but the agent can only *drive* the desktop end to end once the SERVER
// can hand a client-tool call back to us to execute (the seam in delegate.ts).
// No IronClaw gateway advertises that capability yet, so the feature is GATED:
// the app reports it as unavailable and never claims the agent can operate the
// desktop until a connected gateway proves it can. This module is the single
// source of truth for that readiness, so product copy and any future
// affordance gate on the same signal rather than each guessing.

export type AgentUiReadiness = {
  /** True only when the connected gateway can execute client-delegated tools. */
  supported: boolean;
  /** Short status label for a diagnostics row. */
  label: string;
  /** One-line, plain-language explanation of the current state. */
  detail: string;
};

export interface AgentUiCapability {
  /** True once the connected gateway can hand client-tool calls back to the
   *  desktop to execute (the `delegate.ts` seam). Undefined or false means no
   *  support — IronClaw still runs tools server-side. */
  clientToolDelegation?: boolean;
}

/**
 * Map a gateway capability snapshot to a readiness verdict. Pure + total —
 * the same input always yields the same verdict, so it is trivially testable
 * for both the supported and unsupported gateway states.
 */
export function agentUiReadiness(cap: AgentUiCapability): AgentUiReadiness {
  if (cap.clientToolDelegation === true) {
    return {
      supported: true,
      label: 'Supported',
      detail: 'The agent can drive the app: navigate, open a thread, start a chat.'
    };
  }
  return {
    supported: false,
    label: 'Not supported by this gateway',
    detail:
      "This gateway runs tools server-side, so the agent can't drive the app. Needs client-tool delegation."
  };
}

class AgentUiReadinessStore {
  // Flipped to true ONLY when a connected gateway proves it supports
  // client-tool delegation (the delegate.ts seam). Nothing sets it yet, so it
  // stays false and readiness reports "not supported" — honest by default.
  // When the backend ships the lifecycle, the connection layer sets this and
  // every gated surface updates through `readiness`.
  clientToolDelegation = $state<boolean>(false);

  readiness = $derived(agentUiReadiness({ clientToolDelegation: this.clientToolDelegation }));
}

export const agentUiReadinessState = new AgentUiReadinessStore();
