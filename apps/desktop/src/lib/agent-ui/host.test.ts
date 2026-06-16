// Tests for the AgentUiHost factory. Pure (injected deps) — no $app/stores; we
// pass fakes and assert the wiring, plus one end-to-end dispatch through the
// real action registry to prove the factory output is a valid host.

import { describe, expect, it } from 'vitest';
import { createAgentUiHost, type AgentUiHostDeps } from './host';
import { dispatchAction } from './actions';

function fakeDeps(): {
  deps: AgentUiHostDeps;
  navs: string[];
  selects: (string | null)[];
} {
  const navs: string[] = [];
  const selects: (string | null)[] = [];
  const deps: AgentUiHostDeps = {
    goto: (p) => {
      navs.push(p);
    },
    selectThread: (id) => {
      selects.push(id);
    }
  };
  return { deps, navs, selects };
}

describe('createAgentUiHost', () => {
  it('navigate forwards the path to goto', () => {
    const { deps, navs } = fakeDeps();
    createAgentUiHost(deps).navigate('/knowledge');
    expect(navs).toEqual(['/knowledge']);
  });

  it('openThread selects the given thread id', () => {
    const { deps, selects } = fakeDeps();
    createAgentUiHost(deps).openThread('t-1');
    expect(selects).toEqual(['t-1']);
  });

  it('newChat selects null (fresh conversation)', () => {
    const { deps, selects } = fakeDeps();
    createAgentUiHost(deps).newChat();
    expect(selects).toEqual([null]);
  });

  it('drives dispatchAction end-to-end (navigate → goto path)', async () => {
    const { deps, navs } = fakeDeps();
    const host = createAgentUiHost(deps);
    const res = await dispatchAction('navigate', { surface: 'desk' }, host);
    expect(res.ok).toBe(true);
    expect(navs).toEqual(['/desk']);
  });

  it('drives dispatchAction end-to-end (new_chat → select null)', async () => {
    const { deps, selects } = fakeDeps();
    const host = createAgentUiHost(deps);
    const res = await dispatchAction('new_chat', {}, host);
    expect(res.ok).toBe(true);
    expect(selects).toEqual([null]);
  });
});
