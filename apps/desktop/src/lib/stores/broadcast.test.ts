// Tests for the cross-window sync bus (R17a — BroadcastChannel fan-out).
// We stub the global BroadcastChannel with a controllable fake so we can
// capture outgoing posts and dispatch inbound messages, then assert the
// send mechanics, senderId stamping, init/teardown lifecycle, and the
// loop-prevention guards in handle() (self-sent + malformed are ignored;
// a foreign message is handled without throwing or echoing back).
//
// We deliberately do NOT import the receiver stores (notifications, etc.):
// handle() resolves them via dynamic import wrapped in try/catch, so a
// foreign message degrades gracefully here without dragging the heavy
// Tauri-plugin dep chain into the test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { broadcast, CHANNEL_NAME } from './broadcast.svelte';

type Listener = (ev: { data: unknown }) => void;

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  name: string;
  posted: unknown[] = [];
  listeners: Listener[] = [];
  closed = false;

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
  }
  postMessage(m: unknown): void {
    this.posted.push(m);
  }
  addEventListener(_type: string, fn: Listener): void {
    this.listeners.push(fn);
  }
  removeEventListener(_type: string, fn: Listener): void {
    this.listeners = this.listeners.filter((f) => f !== fn);
  }
  close(): void {
    this.closed = true;
  }
  dispatch(data: unknown): void {
    for (const fn of this.listeners) fn({ data });
  }
}

function activeChannel(): FakeBroadcastChannel {
  return FakeBroadcastChannel.instances[FakeBroadcastChannel.instances.length - 1];
}

beforeEach(() => {
  broadcast.teardown();
  FakeBroadcastChannel.instances = [];
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
});

afterEach(() => {
  broadcast.teardown();
  vi.unstubAllGlobals();
});

describe('broadcast — lifecycle + send', () => {
  it('init opens one channel and is idempotent', () => {
    broadcast.init();
    broadcast.init();
    expect(FakeBroadcastChannel.instances).toHaveLength(1);
    expect(activeChannel().name).toBe(CHANNEL_NAME);
  });

  it('send is a no-op before init', () => {
    broadcast.send({ kind: 'settings-changed' });
    expect(FakeBroadcastChannel.instances).toHaveLength(0);
  });

  it('send stamps the senderId and posts the message', () => {
    broadcast.init();
    broadcast.send({ kind: 'profile-switched', profileId: 'p1' });
    expect(activeChannel().posted).toEqual([
      { kind: 'profile-switched', profileId: 'p1', senderId: broadcast.windowId }
    ]);
  });

  it('teardown closes the channel and stops further sends', () => {
    broadcast.init();
    const ch = activeChannel();
    broadcast.teardown();
    expect(ch.closed).toBe(true);
    broadcast.send({ kind: 'settings-changed' });
    expect(ch.posted).toHaveLength(0);
    expect(FakeBroadcastChannel.instances).toHaveLength(1);
  });

  it('init is a no-op when BroadcastChannel is unavailable', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    broadcast.teardown();
    broadcast.init();
    broadcast.send({ kind: 'settings-changed' });
    expect(FakeBroadcastChannel.instances).toHaveLength(0);
  });
});

describe('broadcast — handle (loop prevention)', () => {
  it('ignores a message it sent itself (senderId === windowId) without echoing', async () => {
    broadcast.init();
    activeChannel().dispatch({ kind: 'notification-seen', senderId: broadcast.windowId });
    await Promise.resolve();
    expect(activeChannel().posted).toHaveLength(0);
  });

  it('ignores malformed messages without throwing', async () => {
    broadcast.init();
    expect(() => activeChannel().dispatch(null)).not.toThrow();
    expect(() => activeChannel().dispatch({ noKind: true })).not.toThrow();
    await Promise.resolve();
    expect(activeChannel().posted).toHaveLength(0);
  });

  it('handles a foreign message gracefully (no throw, no re-broadcast)', async () => {
    broadcast.init();
    expect(() =>
      activeChannel().dispatch({ kind: 'notification-seen', senderId: 'other-window' })
    ).not.toThrow();
    // handle() awaits a dynamic import (wrapped in try/catch); flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(activeChannel().posted).toHaveLength(0);
  });
});
