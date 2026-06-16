// Auto-updater store, backed by @tauri-apps/plugin-updater.
//
// Wraps the JS plugin in a rune-based singleton so the layout banner and
// the settings page can share one source of truth. The Rust side just
// registers the plugin in `src-tauri/src/lib.rs` — all interaction
// happens here.
//
// Lifecycle:
//   idle      → nothing in flight
//   checking  → calling check()
//   available → an Update is in-hand, awaiting user consent
//   downloading → downloadAndInstall() in flight, `progress` is 0-100
//   installing  → bytes written, swap in progress
//   up-to-date  → check succeeded but no update
//   error       → any failure; `error` holds the message
//
// Notes on signing: the Tauri updater refuses to install bundles whose
// signature does not validate against `plugins.updater.pubkey` in
// tauri.conf.json. We ship with an empty pubkey by default (see TODO in
// `src-tauri/src/lib.rs`), which means `check()` itself will fail with a
// clear error rather than silently downloading an unsigned bundle. The
// error surfaces in the banner so the user sees something concrete.
//
// Persistence (2026-05 polish):
//   - `ironclaw-updater-skip` — version string the user chose to skip.
//     A future newer version unsets the suppression automatically.
//   - `ironclaw-updater-cadence` — one of UpdaterCadence; controls the
//     auto-recheck timer (re-arm on every set).
//   - `ironclaw-updater-last-check` — epoch ms of the last attempt.

export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'up-to-date'
  | 'error';

export type UpdaterCadence = 'never' | 'launch' | 'launch+6h' | 'launch+1h';

export interface UpdateInfo {
  version: string;
  notes?: string;
  date?: string;
}

import { inTauriFully } from '$lib/utils/runtime';
import { telemetry } from './telemetry.svelte';

const LS_SKIP = 'ironclaw-updater-skip';
const LS_CADENCE = 'ironclaw-updater-cadence';
const LS_LAST_CHECK = 'ironclaw-updater-last-check';

const DEFAULT_CADENCE: UpdaterCadence = 'launch+6h';

/** Cadence → recheck interval in ms. `launch` and `never` get no timer. */
function cadenceIntervalMs(c: UpdaterCadence): number | null {
  switch (c) {
    case 'launch+1h':
      return 60 * 60 * 1000;
    case 'launch+6h':
      return 6 * 60 * 60 * 1000;
    default:
      return null;
  }
}

/** Cheap localStorage read with SSR/missing-storage guards. */
function lsGet(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function lsDel(key: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

// The plugin's Update object is opaque to us — we just need its
// `downloadAndInstall` method. Keeping it off the reactive surface so
// runes don't try to proxy a non-serializable object.
let pendingUpdate: { downloadAndInstall: (cb: (e: any) => void) => Promise<void> } | null = null;

class UpdaterStore {
  status = $state<UpdaterStatus>('idle');
  update = $state<UpdateInfo | null>(null);
  error = $state<string | null>(null);
  /** 0-100 during 'downloading'; null otherwise. */
  progress = $state<number | null>(null);
  /** Last-checked epoch ms (hydrated from localStorage). null = never. */
  lastCheckedAt = $state<number | null>(null);
  /** Current cadence (hydrated from localStorage). */
  cadence = $state<UpdaterCadence>(DEFAULT_CADENCE);
  /** Currently-skipped version string, if any. */
  skippedVersion = $state<string | null>(null);

  /** Active recheck timer handle (null = no timer). */
  private timerId: ReturnType<typeof setInterval> | null = null;
  /** Whether hydrate() ran so re-entry is cheap. */
  private hydrated = false;

  /** Hydrate localStorage-backed fields. Idempotent; safe to call from
   *  every consumer mount. */
  hydrate(): void {
    if (this.hydrated) return;
    this.hydrated = true;

    const rawCadence = lsGet(LS_CADENCE);
    if (
      rawCadence === 'never' ||
      rawCadence === 'launch' ||
      rawCadence === 'launch+6h' ||
      rawCadence === 'launch+1h'
    ) {
      this.cadence = rawCadence;
    }

    const skip = lsGet(LS_SKIP);
    if (skip) this.skippedVersion = skip;

    const last = lsGet(LS_LAST_CHECK);
    if (last) {
      const n = Number(last);
      if (Number.isFinite(n) && n > 0) this.lastCheckedAt = n;
    }
  }

  /**
   * One-shot check. Safe to call from layout mount — errors are captured
   * to `error` but never thrown, so a missing pubkey or network blip
   * won't kill the launch path. If an update is found, status flips to
   * `available` and `update` is populated.
   *
   * `respectSkip` lets the layout's auto-check honor the user's skipped
   * version (so a skipped update stays silent) while letting the manual
   * Settings button always surface what's out there.
   *
   * No-ops silently when running outside the full Tauri runtime — the
   * updater plugin dispatches through `__TAURI_INTERNALS__.transformCallback`
   * which the DEV-only `app.html` shim does NOT implement, and an
   * unguarded call there fires `plugin:updater|check` against the partial
   * shim and floods the console.
   */
  async check({ respectSkip = false }: { respectSkip?: boolean } = {}): Promise<void> {
    this.hydrate();
    if (!inTauriFully()) {
      // Browser dev / preview — no updater plugin to talk to. Park at
      // 'idle' so the banner stays hidden and Settings shows the
      // "never checked" hint.
      this.status = 'idle';
      this.error = null;
      this.progress = null;
      return;
    }
    this.status = 'checking';
    this.error = null;
    this.progress = null;
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const result = await check();
      // Stamp the timestamp regardless of outcome — the user wants to
      // know when we last successfully contacted the update server.
      const now = Date.now();
      this.lastCheckedAt = now;
      lsSet(LS_LAST_CHECK, String(now));

      if (result) {
        pendingUpdate = result as unknown as typeof pendingUpdate;
        this.update = {
          version: result.version,
          notes: result.body ?? undefined,
          date: result.date ?? undefined
        };
        // If the user has explicitly skipped this exact version AND we're
        // running an auto-check (respectSkip), keep status as up-to-date
        // and don't surface the banner. The update object is still
        // populated so Settings can show it if asked.
        if (respectSkip && this.skippedVersion && this.skippedVersion === result.version) {
          this.status = 'up-to-date';
          return;
        }
        // Any new (non-skipped) version reaching us clears a stale skip.
        if (this.skippedVersion && this.skippedVersion !== result.version) {
          this.skippedVersion = null;
          lsDel(LS_SKIP);
        }
        this.status = 'available';
        // Opt-in telemetry — the target version is interesting for
        // adoption-rate charts; no other context surfaces here.
        telemetry.recordEvent('update:available', { version: result.version });
      } else {
        pendingUpdate = null;
        this.update = null;
        this.status = 'up-to-date';
      }
    } catch (err) {
      pendingUpdate = null;
      this.status = 'error';
      this.error = (err as Error).message ?? String(err);
    }
  }

  /**
   * Download + write the update bundle. Tracks progress via the plugin's
   * event stream. On success, status moves to `installing`; the user
   * must restart the app manually to apply.
   *
   * Guarded against the dev shim: `pendingUpdate` only ever populates
   * via `check()`, which itself bails out under the shim, so a
   * download() call there finds nothing pending and returns the
   * "run check() first" path. The runtime probe is a belt-and-braces
   * second gate in case a future caller drops a fake `pendingUpdate`
   * onto the singleton directly.
   */
  async download(): Promise<void> {
    if (!inTauriFully()) {
      this.status = 'idle';
      this.error = null;
      this.progress = null;
      return;
    }
    if (!pendingUpdate) {
      this.status = 'error';
      this.error = 'No update available to download. Run check() first.';
      return;
    }
    this.status = 'downloading';
    this.error = null;
    this.progress = 0;
    let downloaded = 0;
    let contentLength = 0;
    try {
      await pendingUpdate.downloadAndInstall((event: any) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data?.contentLength ?? 0;
            this.progress = 0;
            break;
          case 'Progress':
            downloaded += event.data?.chunkLength ?? 0;
            if (contentLength > 0) {
              this.progress = Math.min(100, Math.round((downloaded / contentLength) * 100));
            }
            break;
          case 'Finished':
            this.progress = 100;
            this.status = 'installing';
            break;
        }
      });
      // downloadAndInstall resolves after the install completes. On
      // macOS the new bundle is in place but the user still has to
      // restart the running app — keep `installing` so the banner
      // renders the restart prompt.
      this.status = 'installing';
      this.progress = 100;
      // Opt-in telemetry — fires once per install completion. Same
      // version-only shape as `update:available` above.
      telemetry.recordEvent('update:installed', {
        version: this.update?.version ?? 'unknown'
      });
    } catch (err) {
      this.status = 'error';
      this.error = (err as Error).message ?? String(err);
      this.progress = null;
    }
  }

  /**
   * Convenience for one-tap "Install now" — alias of `download()` since
   * the plugin's downloadAndInstall handles both phases.
   */
  async install(): Promise<void> {
    return this.download();
  }

  /**
   * Dismiss the banner without forgetting the pending update. Useful for
   * "Later" — re-checking can be triggered manually from settings.
   */
  dismiss(): void {
    if (this.status === 'available' || this.status === 'up-to-date' || this.status === 'error') {
      this.status = 'idle';
      this.error = null;
    }
  }

  /**
   * Skip the current available version: persist the version string and
   * hide the banner for this session. Subsequent auto-checks that find
   * the same version will not surface; a newer version clears the skip
   * automatically inside check().
   */
  skipCurrent(): void {
    const v = this.update?.version;
    if (!v) {
      this.dismiss();
      return;
    }
    this.skippedVersion = v;
    lsSet(LS_SKIP, v);
    this.dismiss();
  }

  /**
   * Switch cadence. Persists to localStorage and re-arms the recheck
   * timer (cleared first so the old interval doesn't leak when the user
   * shortens it). `never` clears the timer outright; the layout's
   * launch-time check is the only call left.
   */
  setCadence(c: UpdaterCadence): void {
    this.hydrate();
    this.cadence = c;
    lsSet(LS_CADENCE, c);
    this.armTimer();
  }

  /**
   * Start the auto-recheck timer for the current cadence. Idempotent: any
   * existing timer is cleared first. Call after the initial launch-time
   * check so the loop starts cleanly.
   */
  armTimer(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    const intervalMs = cadenceIntervalMs(this.cadence);
    if (intervalMs === null) return;
    this.timerId = setInterval(() => {
      // Skip if a check is already in flight, or if the user is mid-
      // install — don't yank the carpet out from under their action.
      if (
        this.status === 'checking' ||
        this.status === 'downloading' ||
        this.status === 'installing'
      ) {
        return;
      }
      void this.check({ respectSkip: true });
    }, intervalMs);
  }

  /** Tear down the timer. Layout doesn't currently call this — the singleton
   *  lives as long as the webview — but kept for completeness/testing. */
  stopTimer(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }
}

/** Global singleton — import anywhere. */
export const updater = new UpdaterStore();

/**
 * Render a "Checked X ago" string for a given epoch ms timestamp. Lives
 * here rather than in a date utility because it's only used by the
 * updater UI; trivial enough to keep self-contained.
 */
export function relativeTime(epochMs: number | null): string {
  if (epochMs == null) return 'never';
  const delta = Math.max(0, Date.now() - epochMs);
  const sec = Math.round(delta / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec} seconds ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return min === 1 ? '1 minute ago' : `${min} minutes ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return hr === 1 ? '1 hour ago' : `${hr} hours ago`;
  const day = Math.round(hr / 24);
  return day === 1 ? '1 day ago' : `${day} days ago`;
}
