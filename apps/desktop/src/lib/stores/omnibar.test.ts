import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./connection.svelte', () => ({
  connection: { client: null }
}));
vi.mock('./threads.svelte', () => ({
  threads: { threads: [] }
}));
vi.mock('./thread-rename.svelte', () => ({
  threadRename: { displayTitle: (_id: string, title: string) => title }
}));

import { omnibar, type OmniCommand } from './omnibar.svelte';

beforeEach(() => {
  omnibar.hide();
  // The store's commands array is internal; clear by re-registering
  // empty list via toggling. Since we can't reach in directly, we
  // unregister anything that might have been registered globally.
  ['cmd:a', 'cmd:b', 'cmd:c', 'cmd:d', 'cmd:e', 'cmd:f', 'cmd:settings', 'cmd:nav'].forEach(
    (id) => {
      omnibar.unregisterCommand(id);
    }
  );
  omnibar.setQuery('');
});

afterEach(() => {
  omnibar.hide();
});

describe('omnibar store', () => {
  it('starts closed with no results', () => {
    expect(omnibar.open).toBe(false);
    expect(omnibar.query).toBe('');
  });

  it('toggle / show / hide flip the open flag', () => {
    omnibar.toggle();
    expect(omnibar.open).toBe(true);
    omnibar.toggle();
    expect(omnibar.open).toBe(false);
    omnibar.show();
    expect(omnibar.open).toBe(true);
    omnibar.hide();
    expect(omnibar.open).toBe(false);
  });

  it('register + unregister command', () => {
    const cmd: OmniCommand = { id: 'cmd:a', title: 'Action A', action: () => {} };
    omnibar.registerCommand(cmd);
    omnibar.show();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Empty query — commands appear with positive bias score.
        const titles = omnibar.results.map((r) => r.title);
        expect(titles).toContain('Action A');
        omnibar.unregisterCommand('cmd:a');
        omnibar.setQuery('action a');
        setTimeout(() => {
          expect(omnibar.results.find((r) => r.id === 'cmd:cmd:a')).toBeUndefined();
          resolve();
        }, 120);
      }, 120);
    });
  });

  it('substring query ranks prefix > word-boundary > anywhere', () => {
    omnibar.registerCommand({ id: 'cmd:a', title: 'ApplePay receipts', action: () => {} });
    omnibar.registerCommand({ id: 'cmd:b', title: 'Banking · apple stuff', action: () => {} });
    omnibar.registerCommand({ id: 'cmd:c', title: 'Maps with mapples', action: () => {} });
    omnibar.show();
    return new Promise<void>((resolve) => {
      omnibar.setQuery('apple');
      setTimeout(() => {
        const ids = omnibar.results.map((r) => r.id);
        // Prefix match first ('ApplePay receipts').
        expect(ids[0]).toBe('cmd:cmd:a');
        // Word-boundary match second ('Banking · apple stuff').
        expect(ids[1]).toBe('cmd:cmd:b');
        // Substring-only match ('Maps with mapples') last.
        expect(ids[2]).toBe('cmd:cmd:c');
        resolve();
      }, 120);
    });
  });

  it('moveActive wraps around the result list', () => {
    omnibar.registerCommand({ id: 'cmd:a', title: 'Alpha', action: () => {} });
    omnibar.registerCommand({ id: 'cmd:b', title: 'Beta', action: () => {} });
    omnibar.show();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(omnibar.activeIdx).toBe(0);
        omnibar.moveActive(1);
        expect(omnibar.activeIdx).toBe(1);
        omnibar.moveActive(1);
        expect(omnibar.activeIdx).toBe(0);
        omnibar.moveActive(-1);
        expect(omnibar.activeIdx).toBe(1);
        resolve();
      }, 120);
    });
  });

  it('invokeActive calls the active result action and hides', () => {
    const fn = vi.fn();
    omnibar.registerCommand({ id: 'cmd:a', title: 'Trigger', action: fn });
    omnibar.show();
    return new Promise<void>((resolve) => {
      setTimeout(async () => {
        await omnibar.invokeActive();
        expect(fn).toHaveBeenCalledOnce();
        expect(omnibar.open).toBe(false);
        resolve();
      }, 120);
    });
  });

  it('fuzzy fallback surfaces a subsequence match', () => {
    omnibar.registerCommand({ id: 'cmd:d', title: 'GitHub Dashboard', action: () => {} });
    omnibar.show();
    return new Promise<void>((resolve) => {
      omnibar.setQuery('ghd');
      setTimeout(() => {
        const ids = omnibar.results.map((r) => r.id);
        expect(ids).toContain('cmd:cmd:d');
        resolve();
      }, 120);
    });
  });

  it('fuzzy never outranks a substring match', () => {
    omnibar.registerCommand({ id: 'cmd:settings', title: 'Settings', action: () => {} });
    omnibar.registerCommand({ id: 'cmd:e', title: 'Secure Tunnel', action: () => {} });
    omnibar.show();
    return new Promise<void>((resolve) => {
      omnibar.setQuery('set');
      setTimeout(() => {
        const ids = omnibar.results.map((r) => r.id);
        const settingsIndex = ids.indexOf('cmd:cmd:settings');
        const tunnelIndex = ids.indexOf('cmd:cmd:e');
        expect(settingsIndex).toBeGreaterThanOrEqual(0);
        expect(tunnelIndex).toBeGreaterThanOrEqual(0);
        expect(settingsIndex).toBeLessThan(tunnelIndex);
        resolve();
      }, 120);
    });
  });

  it('non-subsequence query drops the item', () => {
    omnibar.registerCommand({ id: 'cmd:f', title: 'Knowledge', action: () => {} });
    omnibar.show();
    return new Promise<void>((resolve) => {
      omnibar.setQuery('zzz');
      setTimeout(() => {
        const ids = omnibar.results.map((r) => r.id);
        expect(ids).not.toContain('cmd:cmd:f');
        resolve();
      }, 120);
    });
  });
});
