// Tests for the agent-UI action registry. Pure module (host is injected), so
// no Svelte/Tauri/navigation imports are needed — a fake host records calls.

import { describe, expect, it } from 'vitest';
import { actionSchemas, dispatchAction, NAV_SURFACES, type AgentUiHost } from './actions';

function fakeHost(): {
  host: AgentUiHost;
  calls: string[];
  opened: string[];
  rec: { newChats: number };
} {
  const calls: string[] = []; // navigate paths
  const opened: string[] = [];
  const rec = { newChats: 0 };
  const host: AgentUiHost = {
    navigate: (p) => calls.push(p),
    openThread: (id) => opened.push(id),
    newChat: () => {
      rec.newChats += 1;
    }
  };
  return { host, calls, opened, rec };
}

describe('agent-ui action registry', () => {
  it('exposes a navigate tool schema enumerating only the safe surfaces', () => {
    const nav = actionSchemas().find((s) => s.name === 'navigate');
    expect(nav).toBeTruthy();
    const params = nav!.parameters as { properties: { surface: { enum: string[] } } };
    const surfaces = params.properties.surface.enum;
    expect(surfaces).toContain('knowledge');
    expect(surfaces).toContain('work');
    expect(surfaces).toContain('chat');
    expect(surfaces).not.toContain('dev'); // internal surfaces excluded
    expect(surfaces).not.toContain('onboarding');
    expect(surfaces).toHaveLength(Object.keys(NAV_SURFACES).length);
  });

  it('navigates to a known surface through the injected host', async () => {
    const { host, calls } = fakeHost();
    const res = await dispatchAction('navigate', { surface: 'knowledge' }, host);
    expect(res.ok).toBe(true);
    expect(calls).toEqual(['/knowledge']);
  });

  it('maps the chat surface to the dedicated chat path', async () => {
    const { host, calls } = fakeHost();
    await dispatchAction('navigate', { surface: 'chat' }, host);
    expect(calls).toEqual(['/chat']);
  });

  it('rejects an unknown surface without navigating', async () => {
    const { host, calls } = fakeHost();
    const res = await dispatchAction('navigate', { surface: 'bogus' }, host);
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('returns an error result (not a throw) for an unknown action name', async () => {
    const { host } = fakeHost();
    const res = await dispatchAction('frobnicate', {}, host);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Unknown action/);
  });

  it('exposes open_thread and new_chat in the catalog', () => {
    const names = actionSchemas().map((s) => s.name);
    expect(names).toContain('open_thread');
    expect(names).toContain('new_chat');
  });

  it('open_thread opens the given thread via the host', async () => {
    const { host, opened } = fakeHost();
    const res = await dispatchAction('open_thread', { thread_id: 't-42' }, host);
    expect(res.ok).toBe(true);
    expect(opened).toEqual(['t-42']);
  });

  it('open_thread rejects an empty/missing thread_id without opening', async () => {
    const { host, opened } = fakeHost();
    const res = await dispatchAction('open_thread', { thread_id: '  ' }, host);
    expect(res.ok).toBe(false);
    expect(opened).toEqual([]);
  });

  it('new_chat starts a fresh chat via the host', async () => {
    const { host, rec } = fakeHost();
    const res = await dispatchAction('new_chat', {}, host);
    expect(res.ok).toBe(true);
    expect(rec.newChats).toBe(1);
  });
});
