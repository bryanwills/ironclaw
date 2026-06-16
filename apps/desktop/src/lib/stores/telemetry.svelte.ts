// Opt-in anonymous-usage telemetry.
//
// Off by default. The store only buffers events when both `enabled` and
// `endpoint` are set; when either is empty/false, `recordEvent` is a no-op
// (the buffer never grows). Callsites can fire `recordEvent` unconditionally
// — gating happens here so the surface code stays clean.
//
// Wire shape (POST body, JSON):
//   {
//     batch_id: string,           // uuid-ish, generated per flush
//     sent_at: string,            // ISO-8601 of the flush call
//     app_version: string,        // CARGO_PKG_VERSION at build time
//     events: TelemetryEvent[],   // up to MAX_QUEUE per flush
//   }
//
// What's collected (per event): event name (e.g. `palette:opened`), an
// ISO timestamp, and a flat properties bag the caller may supply with
// scalar values. Crash counts are tracked via the same `crash:captured`
// event the crash reporter fires alongside the Rust write — the network
// post never carries crash detail (no stack, no message).
//
// What's NOT collected:
//   - Message content, thread titles, search queries.
//   - User identifiers, IP addresses (no client-side capture; the server
//     decides whether to log a connecting IP, and the JS layer can't
//     surface one anyway).
//   - File paths, profile names, API keys.
// The Settings UI surfaces this list verbatim so the user can see what
// rides on the wire before flipping the toggle.
//
// For v1 the endpoint defaults to the empty string — no actual
// transmission. The plumbing is here so a real endpoint can be baked in
// (or supplied by an admin) later without touching every callsite. When
// `endpoint` is empty the toggle still gates buffering, but `flush` is a
// no-op even if events somehow ended up queued — the queue is then
// discarded so it can't grow unbounded.

const LS_ENABLED = 'ironclaw-telemetry-enabled';
const LS_ENDPOINT = 'ironclaw-telemetry-endpoint';

/** Maximum events held in memory before the next flush. Older events get
 *  dropped if the queue is hit faster than the 5-minute flush cadence —
 *  the buffer must stay bounded so a runaway loop in `recordEvent` can't
 *  exhaust memory. */
const MAX_QUEUE = 500;

/** Auto-flush cadence (ms). Five minutes per the brief. */
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * One queued event. `properties` is intentionally a permissive bag —
 * surface code stays one-line. We document above what's safe to attach
 * (counts, durations, enum-like strings) and what isn't (anything that
 * could identify the user or surface message content).
 */
export interface TelemetryEvent {
  name: string;
  /** ISO-8601 stamp of when `recordEvent` was called. */
  ts: string;
  properties?: Record<string, unknown>;
}

/** SSR/missing-storage-safe localStorage helper. */
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
    // ignore quota / private-mode failures
  }
}

/** Generate a coarse batch identifier. We don't pull in a uuid library
 *  for this; the server-side endpoint, if any, treats the field as
 *  opaque and the only deduping signal that matters is `sent_at`. */
function makeBatchId(): string {
  const a = Math.floor(Math.random() * 0xffff_ffff).toString(16);
  const b = Date.now().toString(16);
  return `b_${b}_${a}`;
}

class TelemetryStore {
  /** Opt-in toggle. Persisted to localStorage so it survives reloads. */
  enabled = $state<boolean>(false);

  /** POST target. Empty string disables transmission even when
   *  `enabled` is true. Persisted to localStorage so a configured
   *  endpoint survives reloads. */
  endpoint = $state<string>('');

  /** In-memory buffer. Drained on flush; capped at MAX_QUEUE to keep
   *  memory bounded. Exposed (read-only intent) so the Settings UI can
   *  show "N events pending" if we add that affordance later. */
  queue = $state<TelemetryEvent[]>([]);

  /** Timestamp of the last successful flush (epoch ms). `null` until
   *  the first flush completes; the Settings UI can render a "Last sent"
   *  hint off it if we want. */
  lastFlushAt = $state<number | null>(null);

  /** Whether init() ran so re-entry is cheap. */
  private hydrated = false;
  /** Active flush timer handle. */
  private timerId: ReturnType<typeof setInterval> | null = null;

  /**
   * Hydrate from localStorage and arm the auto-flush timer. Idempotent —
   * the layout calls this on mount and individual consumers can call it
   * defensively before recording. No IPC happens here; safe outside Tauri.
   */
  init(): void {
    if (this.hydrated) return;
    this.hydrated = true;

    const rawEnabled = lsGet(LS_ENABLED);
    if (rawEnabled === 'true') this.enabled = true;

    const rawEndpoint = lsGet(LS_ENDPOINT);
    if (rawEndpoint) this.endpoint = rawEndpoint;

    this.armTimer();
  }

  /** Persist the toggle and re-arm the timer (so flipping off cancels
   *  the next scheduled flush). */
  setEnabled(v: boolean): void {
    this.enabled = v;
    lsSet(LS_ENABLED, v ? 'true' : 'false');
    if (!v) {
      // Drop any pending events the moment the user opts out so a
      // delayed flush can't sneak data through.
      this.queue = [];
    }
    this.armTimer();
  }

  /** Persist the endpoint URL. Empty string disables transmission. */
  setEndpoint(url: string): void {
    this.endpoint = url;
    lsSet(LS_ENDPOINT, url);
    this.armTimer();
  }

  /**
   * Record one event. Gated on `enabled && endpoint` so a fully-off
   * configuration never grows the queue. Callers can fire this
   * unconditionally — keeps surface code clean.
   *
   * Defensive against:
   *   - Reentry inside an error handler: try/catch around the array
   *     mutation means a malformed properties object can never bubble
   *     back to the caller (which is often itself inside a crash
   *     handler — see `+layout.svelte`).
   *   - Unbounded growth: hard cap at MAX_QUEUE, oldest entries drop.
   */
  recordEvent(name: string, properties?: Record<string, unknown>): void {
    if (!this.enabled || !this.endpoint) return;
    try {
      const event: TelemetryEvent = {
        name,
        ts: new Date().toISOString(),
        ...(properties && Object.keys(properties).length > 0 ? { properties } : {})
      };
      const next = [...this.queue, event];
      this.queue = next.length > MAX_QUEUE ? next.slice(next.length - MAX_QUEUE) : next;
    } catch {
      // Recording must never throw — the caller is often a crash handler.
    }
  }

  /**
   * POST the current queue to the configured endpoint, clearing on
   * success. On failure the queue is preserved so the next flush retries.
   *
   * The fetch is intentionally `keepalive: true` so a flush triggered
   * by a page-visibility change (or a future tab-close handler) still
   * gets a fair shot at completing.
   *
   * No-op when:
   *   - The toggle is off.
   *   - The endpoint is empty.
   *   - The queue is empty.
   */
  async flush(): Promise<void> {
    if (!this.enabled || !this.endpoint) return;
    if (this.queue.length === 0) return;

    // Snapshot + clear up-front so concurrent `recordEvent` calls land
    // in a fresh queue. We restore the snapshot on failure so retries
    // capture both old and new events together.
    const snapshot = this.queue;
    this.queue = [];

    const body = JSON.stringify({
      batch_id: makeBatchId(),
      sent_at: new Date().toISOString(),
      // CARGO_PKG_VERSION is baked into the app at build time; the
      // frontend reads it via the global the Tauri tooling injects.
      // Falling back to an empty string keeps the wire-shape stable
      // even when the global is missing (jsdom / non-Tauri preview).
      app_version: appVersion(),
      events: snapshot
    });

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        // Best-effort send even if the surrounding page is tearing
        // down. Most browsers cap keepalive payload size around 64 KB;
        // our batches are small (event names + scalar properties).
        keepalive: true
      });
      if (!res.ok) {
        // Restore the queue so a future flush retries. We splice the
        // snapshot in front of any events that landed during the in-
        // flight POST so chronological order is preserved.
        this.queue = [...snapshot, ...this.queue].slice(-MAX_QUEUE);
        return;
      }
      this.lastFlushAt = Date.now();
    } catch {
      // Network failure — restore the queue (oldest-first) so the next
      // tick retries.
      this.queue = [...snapshot, ...this.queue].slice(-MAX_QUEUE);
    }
  }

  /**
   * Arm (or re-arm) the flush timer based on current `enabled` /
   * `endpoint` state. Idempotent: any existing timer is cleared first
   * so a toggle off → on doesn't stack handles.
   */
  armTimer(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    if (!this.enabled || !this.endpoint) return;
    // setInterval in browsers returns a number; under node/vitest it's
    // a Timeout object — the ReturnType union above accommodates both.
    this.timerId = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  /** Tear down the flush timer. The singleton lives as long as the
   *  webview, so this is mostly for tests + future cleanup paths. */
  stopTimer(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }
}

/**
 * Read CARGO_PKG_VERSION from whatever surface the build pipeline
 * injects it on. Vite exposes import.meta.env.VITE_* but we don't have
 * one wired today — the package.json version is the closest stable
 * source. Falls back to "unknown" so the wire shape stays consistent.
 *
 * Kept private here (telemetry is the only consumer) rather than
 * promoted to a shared util — easier to swap once a proper Tauri-time
 * version injection lands.
 */
function appVersion(): string {
  try {
    // Vite replaces this at build time when the env var is set in
    // `.env`; without it, the fallback path returns 'unknown'.
    const v = (import.meta as { env?: Record<string, string> }).env?.VITE_APP_VERSION;
    if (v && typeof v === 'string') return v;
  } catch {
    // ignore — env may not exist in jsdom
  }
  return 'unknown';
}

/** Global singleton — import anywhere. */
export const telemetry = new TelemetryStore();
