// Sign-in state for the active IronClaw gateway.
//
// Rune-based singleton. Holds the latest `UserProfile` returned by
// GET /api/profile and a coarse `status` that the Settings page + Sidebar
// read to render the dot + label.
//
// Lifecycle:
//   unknown    → we haven't asked the gateway yet (initial, or just after a
//                profile switch).
//   signed-in  → /api/profile returned 200 with a non-empty body.
//   signed-out → /api/profile returned 401/403 — the gateway is reachable
//                but the user has not completed NEAR sign-in (or the bearer
//                we sent is rejected). Same surface used for remote-mode
//                "auth required".
//   error      → unreachable / 5xx / parse failure. The Settings page
//                surfaces `lastError` next to a Retry button.
//
// Auto-refresh: an effect inside the store watches `connection.status`. When
// the connection flips into `'connected'`, we kick a refresh and start a
// 60-second poller that keeps `profile` fresh while the gateway stays up.
// The poller is torn down on any other connection state so we don't fire
// 401s every minute against a disconnected sidecar.
//
// Toasts are emitted on meaningful state changes (sign-in completed, sign-out
// observed) so the user gets visible feedback after they wrap up the web-UI
// flow without having to read the Settings dot.

import { connection } from './connection.svelte';
import { toasts } from './toasts.svelte';
import type { UserProfile } from '$lib/api/types';

export type SignInStatus = 'unknown' | 'signed-in' | 'signed-out' | 'error';

const POLL_INTERVAL_MS = 60_000;

class SignInStore {
  profile = $state<UserProfile | null>(null);
  status = $state<SignInStatus>('unknown');
  /** Human-readable error string when `status === 'error'`. */
  lastError = $state<string | null>(null);
  /** True while a refresh is in flight — drives the "Checking…" UI. */
  inflight = $state(false);

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastConnectionStatus: string | null = null;

  constructor() {
    // Auto-refresh wiring lives inside an effect so it picks up live
    // changes to the connection store without manual subscription
    // bookkeeping. Svelte 5 runs the effect once Svelte's effect graph is
    // active (i.e. on the first read by a mounted component), which means
    // the store is inert until a UI surface starts watching it — that's
    // the desired behaviour.
    $effect.root(() => {
      $effect(() => {
        const s = connection.status;
        if (s === 'connected') {
          if (this.lastConnectionStatus !== 'connected') {
            void this.refresh();
            this.startPolling();
          }
        } else {
          this.stopPolling();
          // Don't wipe `profile`/`status` immediately on a brief
          // disconnect — UI looks calmer when the chip just freezes.
          // A full clear happens on the next successful refresh.
        }
        this.lastConnectionStatus = s;
      });
    });
  }

  /**
   * One-shot refresh against the active client. Updates `profile`, `status`
   * and `lastError` in place. Safe to call repeatedly; concurrent calls
   * collapse via `inflight`.
   */
  async refresh(): Promise<void> {
    if (this.inflight) return;
    const client = connection.client;
    if (!client) {
      // Without a client there's nothing useful to report — keep status
      // at `unknown` so the Settings page shows "Checking…" rather than a
      // misleading "Not signed in".
      this.status = 'unknown';
      this.lastError = null;
      return;
    }
    this.inflight = true;
    try {
      const profile = await client.getProfile();
      const prev = this.status;
      if (profile === null) {
        this.profile = null;
        this.status = 'signed-out';
        this.lastError = null;
        if (prev === 'signed-in') {
          toasts.show('Signed out from NEAR.AI', 'info');
        }
      } else {
        this.profile = profile;
        this.status = 'signed-in';
        this.lastError = null;
        if (prev !== 'signed-in') {
          const label =
            profile.near_account ?? profile.display_name ?? profile.user_id ?? 'NEAR.AI';
          toasts.show(`Signed in as ${label}`, 'success');
        }
      }
    } catch (err) {
      this.status = 'error';
      this.lastError = (err as Error).message ?? String(err);
    } finally {
      this.inflight = false;
    }
  }

  /**
   * Explicit reset — used when a profile is switched / the sidecar is
   * stopped, so the next refresh starts from a clean slate rather than
   * surfacing stale identity data.
   */
  reset(): void {
    this.stopPolling();
    this.profile = null;
    this.status = 'unknown';
    this.lastError = null;
    this.lastConnectionStatus = null;
  }

  private startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.refresh();
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** Global singleton — import this anywhere. */
export const signIn = new SignInStore();
