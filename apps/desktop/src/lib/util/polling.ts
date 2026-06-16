// Shared polling-refresh lifecycle. Several route surfaces (jobs, routines,
// missions, engine detail, admin usage) repeat the same `setInterval` +
// `clearInterval` shape in onMount/onDestroy (audit R200 P1). This wraps that
// pattern and adds in-flight suppression: if the previous tick's async work
// hasn't resolved, the next tick is skipped rather than piling up overlapping
// requests on a slow gateway.
//
// The poll callback stays consumer-owned (each surface has its own guards,
// e.g. "skip while a detail panel is open"); this util only owns the timer
// and the overlap guard. Framework-agnostic + synchronous start/stop so it's
// trivially unit-testable with fake timers.

export interface PollingHandle {
  /** Start ticking. Idempotent — a second call while running is a no-op. */
  start(): void;
  /** Stop ticking + clear the timer. Idempotent. */
  stop(): void;
  /** True while a tick's async work is in flight (exposed for tests). */
  readonly running: boolean;
}

/**
 * Create a polling handle that invokes `fn` every `intervalMs`, skipping a
 * tick whenever the previous invocation's promise is still pending. Errors
 * thrown by `fn` are swallowed (a transient refresh failure must not kill the
 * poll loop) — surface them inside `fn` if they matter.
 */
export function createPollingRefresh(
  fn: () => unknown | Promise<unknown>,
  intervalMs: number
): PollingHandle {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      await fn();
    } catch {
      // Transient failure — keep polling.
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => void tick(), intervalMs);
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    get running() {
      return inFlight;
    }
  };
}
