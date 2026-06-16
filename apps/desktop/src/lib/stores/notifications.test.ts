// Tests for the notifications store. Two pure surfaces exercised:
//
//   1. `isInQuietHours` — exported helper, no rune state, just the
//      hour-math (overnight wrap, disabled toggle, start==end edge).
//
//   2. The `notifications` rune singleton's setters + the
//      `unseenCount` / `markAllSeen` plumbing. We poke `triggers`
//      indirectly through a manual rune-level mutation (the
//      `recordTrigger` path is private but the only public
//      accumulator — `notify()` — pulls in the Tauri permission
//      probe, which we don't want to fight here).
//
//   3. Cross-window broadcast on `markAllSeen` — we spy on the
//      `broadcast` singleton's `send()` and assert the right kind
//      lands on the bus.
//
// Vitest 4's localStorage shim is patched per-file (see the pins
// test for the same trick); the notifications module reads/writes
// under `ironclaw:notifications:v1` via `persist()`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { composeGroupedBody, isInQuietHours, notifications } from './notifications.svelte';
import { broadcast } from './broadcast.svelte';
import { windowFocus } from './window-focus.svelte';
import { sendNotification } from '@tauri-apps/plugin-notification';

function installLocalStorageShim() {
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

/** Quiet-hours block. Hour 12 (noon) is the neutral fixed point. */
function qh(enabled: boolean, startHour: number, endHour: number) {
  return { enabled, startHour, endHour };
}

function atHour(h: number): Date {
  const d = new Date(2026, 0, 15, h, 0, 0);
  return d;
}

describe('isInQuietHours', () => {
  it('returns false when the block is disabled', () => {
    expect(isInQuietHours(qh(false, 22, 7), atHour(23))).toBe(false);
    expect(isInQuietHours(qh(false, 22, 7), atHour(5))).toBe(false);
  });

  it('handles an overnight window (22 → 7)', () => {
    // 23:00 is inside [22, 24) part of the wrap.
    expect(isInQuietHours(qh(true, 22, 7), atHour(23))).toBe(true);
    // 05:00 is inside [0, 7) part of the wrap.
    expect(isInQuietHours(qh(true, 22, 7), atHour(5))).toBe(true);
  });

  it('returns false outside an overnight window', () => {
    expect(isInQuietHours(qh(true, 22, 7), atHour(12))).toBe(false);
    // 21:59 is just before the start.
    expect(isInQuietHours(qh(true, 22, 7), atHour(21))).toBe(false);
    // 07:00 is the exclusive end.
    expect(isInQuietHours(qh(true, 22, 7), atHour(7))).toBe(false);
  });

  it('handles a same-day window (9 → 17)', () => {
    expect(isInQuietHours(qh(true, 9, 17), atHour(12))).toBe(true);
    expect(isInQuietHours(qh(true, 9, 17), atHour(8))).toBe(false);
    // 17:00 is the exclusive end.
    expect(isInQuietHours(qh(true, 9, 17), atHour(17))).toBe(false);
  });

  it('treats start == end as an empty window (use master toggle for 24h mute)', () => {
    expect(isInQuietHours(qh(true, 0, 0), atHour(12))).toBe(false);
    expect(isInQuietHours(qh(true, 12, 12), atHour(12))).toBe(false);
    expect(isInQuietHours(qh(true, 22, 22), atHour(22))).toBe(false);
  });
});

describe('notifications store — quiet-hours setters', () => {
  beforeEach(() => {
    installLocalStorageShim();
    // Reseed the relevant state so cases don't leak.
    notifications.setQuietHoursEnabled(true);
    notifications.setQuietHoursStart(22);
    notifications.setQuietHoursEnd(7);
  });

  afterEach(() => {
    notifications.setQuietHoursEnabled(false);
    notifications.setQuietHoursStart(22);
    notifications.setQuietHoursEnd(7);
  });

  it('setQuietHoursStart + setQuietHoursEnd compose into the same wrap window', () => {
    notifications.setQuietHoursStart(22);
    notifications.setQuietHoursEnd(7);
    expect(notifications.quietHours).toEqual({ enabled: true, startHour: 22, endHour: 7 });
    expect(isInQuietHours(notifications.quietHours, atHour(23))).toBe(true);
    expect(isInQuietHours(notifications.quietHours, atHour(5))).toBe(true);
    expect(isInQuietHours(notifications.quietHours, atHour(12))).toBe(false);
  });

  it('persists quiet-hours setters to localStorage under the prefs blob', () => {
    notifications.setQuietHoursStart(23);
    notifications.setQuietHoursEnd(6);
    const raw = localStorage.getItem('ironclaw:notifications:v1');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as {
      quietHours: { enabled: boolean; startHour: number; endHour: number };
    };
    expect(parsed.quietHours.startHour).toBe(23);
    expect(parsed.quietHours.endHour).toBe(6);
  });
});

describe('notifications store — unseenCount + markAllSeen', () => {
  beforeEach(() => {
    installLocalStorageShim();
    // Wipe any latent triggers from prior describes. The field is
    // private but svelte runes leave the property visible on the
    // instance; we cast through `any` for the reset.
    (notifications as unknown as { triggers: number[] }).triggers = [];
  });

  afterEach(() => {
    (notifications as unknown as { triggers: number[] }).triggers = [];
    vi.restoreAllMocks();
  });

  it('unseenCount reflects recorded triggers within the rolling window', () => {
    const now = Date.now();
    (notifications as unknown as { triggers: number[] }).triggers = [now, now - 1000, now - 2000];
    expect(notifications.unseenCount).toBe(3);
  });

  it('unseenCount drops triggers older than the rolling 5-minute window', () => {
    const now = Date.now();
    const sixMinAgo = now - 6 * 60 * 1000;
    (notifications as unknown as { triggers: number[] }).triggers = [now, sixMinAgo];
    expect(notifications.unseenCount).toBe(1);
  });

  it('markAllSeen() resets the count and emits a broadcast', () => {
    const now = Date.now();
    (notifications as unknown as { triggers: number[] }).triggers = [now, now - 500];
    expect(notifications.unseenCount).toBe(2);

    const sendSpy = vi.spyOn(broadcast, 'send').mockImplementation(() => {});
    notifications.markAllSeen();
    expect(notifications.unseenCount).toBe(0);
    expect(sendSpy).toHaveBeenCalledWith({ kind: 'notification-seen' });
  });

  it('markAllSeen({ broadcast: false }) clears without emitting', () => {
    (notifications as unknown as { triggers: number[] }).triggers = [Date.now()];
    const sendSpy = vi.spyOn(broadcast, 'send').mockImplementation(() => {});
    notifications.markAllSeen({ broadcast: false });
    expect(notifications.unseenCount).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('markAllSeen() is a no-op (no broadcast) when there is nothing to clear', () => {
    (notifications as unknown as { triggers: number[] }).triggers = [];
    const sendSpy = vi.spyOn(broadcast, 'send').mockImplementation(() => {});
    notifications.markAllSeen();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('windowFocus singleton exists with a focused boolean (consumed by notify())', () => {
    // Sanity guard for the consumer surface — `notify()` reads
    // `windowFocus.focused` and only records triggers when unfocused.
    expect(typeof windowFocus.focused).toBe('boolean');
  });
});

describe('composeGroupedBody', () => {
  it('returns the original body when count is 1', () => {
    expect(composeGroupedBody('Routine finished', 1)).toBe('Routine finished');
    // Defensive: 0 / negative shouldn't show a "(+ -1 more)" tail.
    expect(composeGroupedBody('x', 0)).toBe('x');
  });

  it('appends "(+ N more)" with N = count - 1', () => {
    expect(composeGroupedBody("Routine 'daily-report' completed", 3)).toBe(
      "Routine 'daily-report' completed (+ 2 more)"
    );
    expect(composeGroupedBody('msg', 2)).toBe('msg (+ 1 more)');
  });

  it('renders only the suffix when the first body was empty', () => {
    expect(composeGroupedBody('', 4)).toBe('(+ 3 more)');
  });
});

describe('notifications store — grouping', () => {
  beforeEach(() => {
    installLocalStorageShim();
    // Force the Tauri-runtime guard inside notify() to pass — the
    // store short-circuits on `__TAURI_INTERNALS__` and we want the
    // sendNotification mock to actually fire. Set on `globalThis` and
    // `window` separately because the store's `inTauri()` reads from
    // `window`.
    (globalThis as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    if (typeof window !== 'undefined') {
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    }
    notifications.setGroupingEnabled(true);
    notifications.activeGroups = {};
    (notifications as unknown as { triggers: number[] }).triggers = [];
    // Pretend the window is blurred so badge counting (which gates on
    // `windowFocus.focused === false`) actually engages. Without this
    // the unseen-count assertions would all read 0 because the test
    // harness defaults focus to true.
    windowFocus.focused = false;
    vi.mocked(sendNotification).mockClear();
  });

  afterEach(() => {
    delete (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    if (typeof window !== 'undefined') {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
    notifications.activeGroups = {};
    notifications.setGroupingEnabled(true);
    (notifications as unknown as { triggers: number[] }).triggers = [];
    windowFocus.focused = true;
    vi.restoreAllMocks();
  });

  it('3 same-category notifications within 30s fire 1 banner per event but bump unseen count by 3', async () => {
    await notifications.notify({
      title: 'Routine completed',
      body: "Routine 'daily-report' completed",
      category: 'routine'
    });
    await notifications.notify({
      title: 'Routine completed',
      body: "Routine 'health-check' completed",
      category: 'routine'
    });
    await notifications.notify({
      title: 'Routine completed',
      body: "Routine 'cleanup' completed",
      category: 'routine'
    });

    // Three IPC calls — the first is the fresh banner, the next two
    // reuse the same numeric id so macOS replaces in place. Spec
    // ("DON'T send a second OS notification") is satisfied at the OS
    // level by id-coalescing rather than by skipping the IPC call —
    // skipping would lose the body update.
    expect(vi.mocked(sendNotification)).toHaveBeenCalledTimes(3);
    const callIds = vi.mocked(sendNotification).mock.calls.map((c) => {
      const arg = c[0];
      return typeof arg === 'string' ? undefined : arg.id;
    });
    expect(callIds[0]).toBeDefined();
    expect(callIds[1]).toBe(callIds[0]);
    expect(callIds[2]).toBe(callIds[0]);

    // Second + third calls carry the running "(+ N more)" suffix
    // anchored to the FIRST body, not the most recent one.
    const secondArg = vi.mocked(sendNotification).mock.calls[1][0] as {
      body?: string;
    };
    expect(secondArg.body).toBe("Routine 'daily-report' completed (+ 1 more)");
    const thirdArg = vi.mocked(sendNotification).mock.calls[2][0] as {
      body?: string;
    };
    expect(thirdArg.body).toBe("Routine 'daily-report' completed (+ 2 more)");

    // Unseen count tracks raw event volume, NOT banner count. Spec:
    // "if 3 routine completions group into 1 banner, unseen count
    // goes up by 3."
    expect(notifications.unseenCount).toBe(3);

    // Active group should reflect the final count.
    expect(notifications.activeGroups.routine?.count).toBe(3);
  });

  it('expired groups close after 30s of silence and the next event starts a fresh banner', async () => {
    await notifications.notify({
      title: 'Routine completed',
      body: 'first',
      category: 'routine'
    });
    expect(notifications.activeGroups.routine?.count).toBe(1);

    // Force the active group to look stale (lastTs older than the
    // 30s window) and run the GC pass — same path the 5s interval
    // takes in production.
    const grp = notifications.activeGroups.routine!;
    notifications.activeGroups = {
      ...notifications.activeGroups,
      routine: { ...grp, lastTs: Date.now() - 31_000 }
    };
    notifications.gcExpiredGroups();
    expect(notifications.activeGroups.routine).toBeUndefined();

    await notifications.notify({
      title: 'Routine completed',
      body: 'second',
      category: 'routine'
    });

    // Two banners total (one before expiry, one after). The second
    // is a fresh banner, NOT a "(+ N more)" update — its body is the
    // raw caller body and the group count is back to 1.
    const lastArg = vi.mocked(sendNotification).mock.calls.at(-1)?.[0] as {
      body?: string;
    };
    expect(lastArg.body).toBe('second');
    expect(notifications.activeGroups.routine?.count).toBe(1);
  });

  it('grouping can be disabled — each notify() fires its own banner with no group state', async () => {
    notifications.setGroupingEnabled(false);
    await notifications.notify({
      title: 'Routine completed',
      body: 'one',
      category: 'routine'
    });
    await notifications.notify({
      title: 'Routine completed',
      body: 'two',
      category: 'routine'
    });

    expect(vi.mocked(sendNotification)).toHaveBeenCalledTimes(2);
    // Both calls should be a fresh banner with the raw caller body —
    // no "(+ 1 more)" tail, no shared id.
    const first = vi.mocked(sendNotification).mock.calls[0][0] as {
      body?: string;
      id?: number;
    };
    const second = vi.mocked(sendNotification).mock.calls[1][0] as {
      body?: string;
      id?: number;
    };
    expect(first.body).toBe('one');
    expect(second.body).toBe('two');
    expect(first.id).toBeUndefined();
    expect(second.id).toBeUndefined();
    // No group tracked when grouping is off.
    expect(notifications.activeGroups.routine).toBeUndefined();
  });

  it('different categories do not group together — each gets its own banner', async () => {
    await notifications.notify({ title: 'Chat', body: 'c', category: 'chat' });
    await notifications.notify({ title: 'Routine', body: 'r', category: 'routine' });
    await notifications.notify({ title: 'Chat', body: 'c2', category: 'chat' });

    expect(vi.mocked(sendNotification)).toHaveBeenCalledTimes(3);
    // Chat group has count=2 (the third call coalesced), routine has count=1.
    expect(notifications.activeGroups.chat?.count).toBe(2);
    expect(notifications.activeGroups.routine?.count).toBe(1);
    // Chat's third banner should carry the "(+ 1 more)" tail anchored
    // to the first chat body ("c"), not the routine body in between.
    const lastArg = vi.mocked(sendNotification).mock.calls[2][0] as { body?: string };
    expect(lastArg.body).toBe('c (+ 1 more)');
  });
});
