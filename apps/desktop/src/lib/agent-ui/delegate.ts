// Agent-UI delegation seam — the boundary the IronClaw server will call once it
// can hand a tool call back to the client to execute.
//
// `handleClientToolCall(call, host)` is PURE: it normalizes the incoming call
// (arguments may arrive as an object or a JSON string, as OpenAI function-call
// args do), routes it through the action registry's `dispatchAction`, and
// serializes the result into the OpenAI `function_call_output` shape
// (`{ tool_call_id, output, is_error }`). It never throws — a bad action, bad
// JSON, or a host failure all surface as `is_error: true` with a readable
// `output` the model can recover from. Not wired to live IronClaw here; the
// server extension that emits these calls is gated on the backend.

import { dispatchAction, type AgentUiHost } from './actions';

/** An inbound client-tool call (mirrors an OpenAI function call). */
export interface ClientToolCall {
  /** Echoed back so the server can correlate the output with the call. */
  tool_call_id?: string;
  /** The action name (must match a registry action). */
  name: string;
  /** Arguments as an object, or a JSON string (as function-call args arrive). */
  arguments?: Record<string, unknown> | string;
}

/** The result envelope to submit back (OpenAI `function_call_output` shape). */
export interface ClientToolResult {
  tool_call_id: string;
  output: string;
  is_error: boolean;
}

type ParsedArgs = { args: Record<string, unknown> } | { error: string };

/** Normalize `arguments` to an object, parsing a JSON string defensively. */
function parseArgs(raw: ClientToolCall['arguments']): ParsedArgs {
  if (raw === undefined || raw === null) return { args: {} };
  if (typeof raw === 'object') return { args: raw as Record<string, unknown> };
  const text = raw.trim();
  if (text === '') return { args: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'arguments is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'arguments JSON must be an object' };
  }
  return { args: parsed as Record<string, unknown> };
}

/**
 * Execute a client-delegated tool call against the UI host and return the
 * submit-ready result envelope. Never throws.
 */
export async function handleClientToolCall(
  call: ClientToolCall,
  host: AgentUiHost
): Promise<ClientToolResult> {
  const tool_call_id = call.tool_call_id ?? '';
  const parsed = parseArgs(call.arguments);
  if ('error' in parsed) {
    return { tool_call_id, output: parsed.error, is_error: true };
  }
  const result = await dispatchAction(call.name, parsed.args, host);
  return {
    tool_call_id,
    output: result.ok ? result.detail : result.error,
    is_error: !result.ok
  };
}
