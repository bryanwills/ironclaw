// Tests for the Workspace Presets store (R20a/R115 — capture/restore layout
// snapshots). The store reads/writes localStorage directly and, on apply(),
// drives goto() + a couple of public store setters. We mock $app/navigation
// and spy on the cross-store setters; the panel-width localStorage keys are
// module-private, so we mirror the literal key strings here (the store's own
// header flags that these must stay in sync with the route files).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', () => ({ goto: vi.fn().mockResolvedValue(undefined) }));

import { goto } from '$app/navigation';
import { presets, presetsModal, type WorkspacePreset } from './presets.svelte';
import { threads } from './threads.svelte';
import { notifications } from './notifications.svelte';
import { toasts } from './toasts.svelte';

// Mirror of the module-private storage keys.
const PRESETS_LS_KEY = 'ironclaw-presets';
const CHAT_RAIL_LS_KEY = 'ironclaw-chat-rail-width';
const SIDEBAR_COLLAPSED_LS_KEY = 'ironclaw-sidebar-collapsed';
const STATUSBAR_VISIBLE_LS_KEY = 'ironclaw-statusbar-visible';

// jsdom's localStorage shape varies across vitest versions (getItem/setItem
// aren't reliably callable on the global). Install a Map-backed shim — same
// pattern the pins/council tests use — so the storage assertions are robust.
function installLocalStorageShim(): void {
  const store = new Map<string, string>();
  const shim = {
    get length() {
      return store.size;
    },
    key(i: number) {
      return Array.from(store.keys())[i] ?? null;
    },
    getItem(k: string) {
      return store.has(k) ? (store.get(k) as string) : null;
    },
    setItem(k: string, v: string) {
      store.set(String(k), String(v));
    },
    removeItem(k: string) {
      store.delete(k);
    },
    clear() {
      store.clear();
    }
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: shim });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: shim });
  }
}

function reset(): void {
  installLocalStorageShim();
  presets.presets = [];
  presetsModal.open = false;
  presetsModal.focusTarget = null;
  threads.currentId = null;
  vi.mocked(goto).mockClear();
}

describe('presets store — save', () => {
  beforeEach(reset);
  afterEach(() => {
    vi.restoreAllMocks();
    reset();
  });

  it('captures pane widths + toggles from localStorage and prepends newest-first', () => {
    localStorage.setItem(CHAT_RAIL_LS_KEY, '320');
    localStorage.setItem(SIDEBAR_COLLAPSED_LS_KEY, '1');
    localStorage.setItem(STATUSBAR_VISIBLE_LS_KEY, 'true');

    const p = presets.save('My Layout');
    expect(p.name).toBe('My Layout');
    expect(p.chatRailWidth).toBe(320);
    expect(p.sidebarCollapsed).toBe(true);
    expect(p.statusBarVisible).toBe(true);
    // jsdom default location is '/'.
    expect(p.activePath).toBe('/');
    expect(presets.presets[0].id).toBe(p.id);

    // Persisted to the presets blob.
    const raw = JSON.parse(localStorage.getItem(PRESETS_LS_KEY) as string);
    expect(raw[0].name).toBe('My Layout');
  });

  it('trims the name to 80 chars and falls back to "Untitled preset"', () => {
    expect(presets.save('x'.repeat(200)).name).toHaveLength(80);
    expect(presets.save('   ').name).toBe('Untitled preset');
  });

  it('captures the current thread id when one is selected', () => {
    threads.currentId = 'thread-42';
    expect(presets.save('with thread').currentThreadId).toBe('thread-42');
  });

  it('orders newest save at the front', () => {
    presets.save('first');
    presets.save('second');
    expect(presets.presets.map((p) => p.name)).toEqual(['second', 'first']);
  });
});

describe('presets store — rename / delete', () => {
  beforeEach(reset);
  afterEach(() => {
    vi.restoreAllMocks();
    reset();
  });

  it('rename updates the name; no-ops on unknown id and unchanged name', () => {
    const p = presets.save('Old');
    presets.rename(p.id, 'New');
    expect(presets.presets[0].name).toBe('New');

    presets.rename('missing', 'X');
    expect(presets.presets).toHaveLength(1);

    // No-op rename to the same name preserves the array reference.
    const before = presets.presets;
    presets.rename(p.id, 'New');
    expect(presets.presets).toBe(before);
  });

  it('delete removes by id and no-ops on unknown id', () => {
    const a = presets.save('A');
    presets.save('B');
    presets.delete(a.id);
    expect(presets.presets.map((p) => p.name)).toEqual(['B']);
    presets.delete('missing');
    expect(presets.presets).toHaveLength(1);
  });
});

describe('presets store — apply', () => {
  beforeEach(reset);
  afterEach(() => {
    vi.restoreAllMocks();
    reset();
  });

  it('errors and does not navigate when the id is unknown', async () => {
    const showSpy = vi.spyOn(toasts, 'show');
    await presets.apply('nope');
    expect(showSpy).toHaveBeenCalledWith('Preset no longer exists.', 'error');
    expect(goto).not.toHaveBeenCalled();
  });

  it('writes widths back, applies tray badge + thread selection, and navigates', async () => {
    const preset: WorkspacePreset = {
      id: 'p1',
      name: 'Knowledge layout',
      createdAt: new Date().toISOString(),
      activePath: '/knowledge',
      chatRailWidth: 280,
      sidebarCollapsed: true,
      trayBadgeEnabled: false,
      currentThreadId: 'th-9'
    };
    presets.presets = [preset];

    const traySpy = vi.spyOn(notifications, 'setTrayBadgeEnabled');
    const selectSpy = vi.spyOn(threads, 'selectThread');

    await presets.apply('p1');

    expect(localStorage.getItem(CHAT_RAIL_LS_KEY)).toBe('280');
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_LS_KEY)).toBe('1');
    expect(traySpy).toHaveBeenCalledWith(false);
    expect(selectSpy).toHaveBeenCalledWith('th-9');
    expect(goto).toHaveBeenCalledWith('/knowledge');
  });
});

describe('presetsModal', () => {
  beforeEach(reset);
  afterEach(reset);

  it('show carries the focus target; close clears it', () => {
    presetsModal.show('save');
    expect(presetsModal.open).toBe(true);
    expect(presetsModal.focusTarget).toBe('save');
    presetsModal.close();
    expect(presetsModal.open).toBe(false);
    expect(presetsModal.focusTarget).toBeNull();
  });

  it('toggle flips open state', () => {
    presetsModal.toggle();
    expect(presetsModal.open).toBe(true);
    presetsModal.toggle();
    expect(presetsModal.open).toBe(false);
  });
});
