// Tests for the agent-UI delegation seam. Pure (host injected) — a fake host
// records calls; we assert the function_call_output envelope across the ok,
// unknown-action, object-args, JSON-string-args, and bad-JSON paths, plus
// tool_call_id passthrough.

import { describe, expect, it } from 'vitest';
import { handleClientToolCall } from './delegate';
import type { AgentUiHost } from './actions';

function fakeHost(): { host: AgentUiHost; navs: string[]; selects: (string | null)[] } {
  const navs: string[] = [];
  const selects: (string | null)[] = [];
  const host: AgentUiHost = {
    navigate: (p) => navs.push(p),
    openThread: (id) => selects.push(id),
    newChat: () => selects.push(null)
  };
  return { host, navs, selects };
}

describe('handleClientToolCall', () => {
  it('runs a valid action and returns a non-error output with the tool_call_id', async () => {
    const { host, navs } = fakeHost();
    const res = await handleClientToolCall(
      { tool_call_id: 'call-1', name: 'navigate', arguments: { surface: 'knowledge' } },
      host
    );
    expect(res).toEqual({
      tool_call_id: 'call-1',
      output: 'Navigated to knowledge',
      is_error: false
    });
    expect(navs).toEqual(['/knowledge']);
  });

  it('parses arguments supplied as a JSON string', async () => {
    const { host, navs } = fakeHost();
    const res = await handleClientToolCall(
      { name: 'navigate', arguments: '{"surface":"desk"}' },
      host
    );
    expect(res.is_error).toBe(false);
    expect(navs).toEqual(['/desk']);
    expect(res.tool_call_id).toBe(''); // defaulted when omitted
  });

  it('flags an error (no throw) for an unknown action', async () => {
    const { host } = fakeHost();
    const res = await handleClientToolCall({ name: 'frobnicate', arguments: {} }, host);
    expect(res.is_error).toBe(true);
    expect(res.output).toMatch(/Unknown action/);
  });

  it('flags an error for arguments that are not valid JSON', async () => {
    const { host, navs } = fakeHost();
    const res = await handleClientToolCall({ name: 'navigate', arguments: '{not json' }, host);
    expect(res.is_error).toBe(true);
    expect(res.output).toMatch(/not valid JSON/);
    expect(navs).toEqual([]); // never dispatched
  });

  it('flags an error when JSON arguments are not an object', async () => {
    const { host } = fakeHost();
    const res = await handleClientToolCall({ name: 'navigate', arguments: '[1,2,3]' }, host);
    expect(res.is_error).toBe(true);
    expect(res.output).toMatch(/must be an object/);
  });

  it('surfaces an action-level failure (bad surface) as is_error', async () => {
    const { host, navs } = fakeHost();
    const res = await handleClientToolCall(
      { name: 'navigate', arguments: { surface: 'nope' } },
      host
    );
    expect(res.is_error).toBe(true);
    expect(res.output).toMatch(/Unknown surface/);
    expect(navs).toEqual([]);
  });
});
