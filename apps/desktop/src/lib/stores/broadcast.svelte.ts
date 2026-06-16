// Cross-window state synchronization for the IronClaw desktop client.
//
// Multi-window users (introduced in R15b) get a separate webview process
// per window, which means each window has its own copy of every Svelte
// store — settings changes in one window don't auto-propagate to the
// others. This singleton uses the browser's `BroadcastChannel` API
// (available inside Tauri webviews on macOS WebKit) to fan small,
// typed messages out to every sibling window so the relevant stores
// can refresh their local view.
//
// ---- Channel ----------------------------------------------------------
//
// One channel name shared by every window: `ironclaw:state-sync`. The
// `BroadcastChannel` ctor is idempotent across same-origin documents,
// so opening a second window just attaches another listener to the
// same logical bus — no handshake needed.
//
// ---- Message protocol --------------------------------------------------
//
// All messages carry a `senderId` (the unique per-window id allocated
// at module load) so the receiving handler can short-circuit messages
// it broadcast itself — without that guard, calling `markAllSeen()`
// from a receive handler would echo back through `send('notification-
// seen')` and ping-pong forever.
//
// Five message kinds, mapped to their triggers:
//
//   - `settings-changed` — fired after any window's `saveSettings(...)`.
//     Receivers call `connection.reloadSettings()` so their `settings`
//     rune picks up new profiles / toggles / tints. The receive path
//     is deliberately the lightweight `reloadSettings` (not `refresh`)
//     so a cosmetic change in one window doesn't churn the gateway
//     connection or sidecar lifecycle in every other window.
//
//   - `profile-switched` — fired when the main window persists a new
//     active profile (via `setActiveProfile`). Profile-pinned windows
//     (opened with `?profile=<id>`) ignore this since each pinned
//     window has its own context. Currently the `settings-changed`
//     fanout covers this because the active-profile id lives in
//     settings.json — this message kind is reserved for future logic
//     that wants to react to a profile pivot without re-reading the
//     full settings blob.
//
//   - `notification-seen` — fired when any window focuses and calls
//     `notifications.markAllSeen()`. Receivers also call
//     `markAllSeen()` locally so every window's unseen counter and
//     tray badge clear together. The receive path deliberately does
//     NOT re-broadcast (else the loop-prevention `senderId` check is
//     the only thing stopping a storm); the local `markAllSeen()`
//     path here is the one in `notifications.svelte.ts` that knows
//     not to re-emit.
//
//   - `connection-event` — fired on connection-status transitions. The
//     intent was symmetry across windows, but in practice each window
//     owns its own gateway connection (different profiles, different
//     remotes), so receivers IGNORE this message today. The kind is
//     kept in the union so future "show last-known status from peer
//     window" UX doesn't need a protocol bump.
//
//   - `sidecar-status` — same shape and rationale as `connection-event`.
//     Each window manages its own sidecar lifecycle (or none, in
//     remote mode), so receivers ignore this. Kept in the union for
//     a future "another window already has the sidecar up, link to
//     it" UX.
//
//   - `thread-rename` — fired when any window sets / clears a custom
//     thread title in the local-only `threadRename` store. The gateway
//     does not expose a rename endpoint (404 as of v0.29.0); the
//     override is purely client-side. `title === null` means "unset
//     the override on this thread, fall back to the server's title".
//     Receivers apply the change to their own `threadRename` store
//     without re-emitting so multi-window users see the rename
//     everywhere within the channel's delivery latency.

import type { ConnectionStatus, SidecarStatus } from './connection.svelte';

/** Channel name shared across every IronClaw webview in this install. */
export const CHANNEL_NAME = 'ironclaw:state-sync';

/**
 * Tagged union of every message the bus carries. Every message also
 * carries a `senderId` once it hits the wire (see `WireMessage`), but
 * call sites pass the un-stamped variant to `send()` — the singleton
 * adds the id so consumers don't have to thread it through every
 * caller.
 */
export type SyncMessage =
  | { kind: 'settings-changed' }
  | { kind: 'profile-switched'; profileId: string }
  | { kind: 'notification-seen' }
  | { kind: 'connection-event'; status: ConnectionStatus }
  | { kind: 'sidecar-status'; status: SidecarStatus }
  | {
      kind: 'thread-rename';
      threadId: string;
      /** Post-mutation title for the override, or `null` to clear the
       *  override and revert to the server's title. */
      title: string | null;
    };

/** What actually goes over the wire — `SyncMessage` plus the sender id
 *  used for loop prevention. */
type WireMessage = SyncMessage & { senderId: string };

/**
 * Generate a stable per-window id. Webview environments expose
 * `crypto.randomUUID()` (Tauri 2 ships WebKit ≥ 16.4 on macOS); the
 * fallback covers the jsdom test environment and any future runtime
 * that lacks it.
 */
function newWindowId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

class BroadcastStore {
  /** Unique id for THIS window. Stamped on every outgoing message and
   *  compared against the incoming `senderId` to short-circuit self
   *  echoes. Generated lazily so the module load is side-effect-free
   *  outside the browser. */
  readonly windowId: string = newWindowId();

  private channel: BroadcastChannel | null = null;
  private initialized = false;
  /** Bound handler reference so `init()` can pair with `teardown()`
   *  without leaking a listener on hot reloads or layout remounts. */
  private boundHandler: ((ev: MessageEvent<WireMessage>) => void) | null = null;

  /**
   * Open the channel and start listening. Safe to call repeatedly —
   * subsequent calls short-circuit so a layout remount (HMR, route
   * pivot) doesn't stack listeners. No-ops in environments without
   * `BroadcastChannel` (older jsdom, SSR), so the test harness can
   * import this module without crashing.
   */
  init(): void {
    if (this.initialized) return;
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
    } catch (err) {
      // Some webview locked-down origins reject the constructor; the
      // sync is best-effort, so swallow + log rather than killing
      // store init in every window.
      console.warn('broadcast: BroadcastChannel constructor failed', err);
      return;
    }
    this.boundHandler = (ev) => this.handle(ev);
    this.channel.addEventListener('message', this.boundHandler);
    this.initialized = true;
  }

  /**
   * Detach the listener and close the channel. Idempotent — calling
   * before init() or after a previous teardown() is a safe no-op so
   * the layout's `onMount` cleanup can fire unconditionally.
   */
  teardown(): void {
    if (!this.initialized) return;
    if (this.channel && this.boundHandler) {
      this.channel.removeEventListener('message', this.boundHandler);
      try {
        this.channel.close();
      } catch (err) {
        // close() can throw on already-closed channels in some
        // environments; non-fatal.
        console.warn('broadcast: channel close failed', err);
      }
    }
    this.channel = null;
    this.boundHandler = null;
    this.initialized = false;
  }

  /**
   * Broadcast a message to every other window on the channel. The
   * `senderId` is stamped automatically. No-ops when the channel is
   * not open (pre-init() or in an unsupported environment) so call
   * sites don't have to guard.
   */
  send(msg: SyncMessage): void {
    if (!this.channel) return;
    const wire: WireMessage = { ...msg, senderId: this.windowId };
    try {
      this.channel.postMessage(wire);
    } catch (err) {
      // postMessage can throw on serialization failures; the payloads
      // here are all primitive-only so this is mostly a defensive
      // guard against future schema drift.
      console.warn('broadcast: postMessage failed', err);
    }
  }

  /**
   * Dispatch an incoming message into the right store. Self-sent
   * messages are ignored (loop prevention). Imports are dynamic to
   * dodge the circular dependency that would otherwise form —
   * `connection.svelte` and `notifications.svelte` may both import
   * this module via the layout, so we resolve the targets at message
   * time instead of import time.
   */
  private async handle(ev: MessageEvent<WireMessage>): Promise<void> {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') return;
    // Loop prevention: ignore anything WE put on the bus. The
    // BroadcastChannel spec already filters out the sender's own
    // posts in most engines, but the explicit check is portable and
    // covers the test-harness shim where the polyfill may not.
    if (msg.senderId === this.windowId) return;

    switch (msg.kind) {
      case 'settings-changed': {
        try {
          const mod = await import('./connection.svelte');
          await mod.connection.reloadSettings();
        } catch (err) {
          console.warn('broadcast: settings-changed handler failed', err);
        }
        return;
      }
      case 'profile-switched': {
        // Reserved for future use — settings-changed already covers
        // the active-profile pivot via the settings.json round-trip.
        // No-op here so a future producer can wire a richer handler
        // without a protocol bump.
        return;
      }
      case 'notification-seen': {
        try {
          const mod = await import('./notifications.svelte');
          // Pass broadcast:false so the local clear does NOT re-emit
          // onto the bus — belt-and-braces with the senderId loop
          // guard above.
          mod.notifications.markAllSeen({ broadcast: false });
        } catch (err) {
          console.warn('broadcast: notification-seen handler failed', err);
        }
        return;
      }
      case 'connection-event':
      case 'sidecar-status': {
        // Each window owns its own gateway/sidecar lifecycle; peers
        // do not mirror these. Kept reachable so a future cross-
        // window status indicator has a hook ready.
        return;
      }
      case 'thread-rename': {
        try {
          const mod = await import('./thread-rename.svelte');
          // `applyRemote` is deliberately separate from `set` / `unset`
          // so the receive path doesn't re-broadcast — belt-and-braces
          // with the senderId loop guard above.
          mod.threadRename.applyRemote(msg.threadId, msg.title);
        } catch (err) {
          console.warn('broadcast: thread-rename handler failed', err);
        }
        return;
      }
    }
  }
}

/** Global singleton — import this anywhere a store needs to fan a
 *  change out to sibling windows. */
export const broadcast = new BroadcastStore();
