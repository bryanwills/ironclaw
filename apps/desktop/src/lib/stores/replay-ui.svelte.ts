// Replay UI state — per-thread "is the replay bar currently visible?"
// flag. Separate from the data store (`replay.svelte.ts`) so the bar
// can hide independently of whether the events are loaded.
//
// The chat surface mounts ReplayBar conditionally on
// `replayUI.isOpenFor(threadId)`. Cmd+. toggles, Esc closes.

const STORAGE_KEY = 'ironclaw-replay-ui-open';

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

class ReplayUIStore {
  /** Per-thread open flag. Not persisted — replay is a transient state
   *  the user opens on demand; reopening the app should NOT trip the
   *  user into a replay view. We do, however, remember a global
   *  "last-used speed" so user preferences carry. */
  private openByThread = $state<Record<string, boolean>>({});

  isOpenFor(threadId: string | null): boolean {
    if (!threadId) return false;
    return !!this.openByThread[threadId];
  }

  open(threadId: string): void {
    this.openByThread[threadId] = true;
  }

  close(threadId: string): void {
    this.openByThread[threadId] = false;
  }

  toggle(threadId: string): void {
    if (this.openByThread[threadId]) this.close(threadId);
    else this.open(threadId);
  }

  /** Read the persisted speed preference. */
  readSpeed(): number {
    if (!isBrowser()) return 1;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return 1;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : 1;
    } catch {
      return 1;
    }
  }

  writeSpeed(s: number): void {
    if (!isBrowser()) return;
    try {
      localStorage.setItem(STORAGE_KEY, String(s));
    } catch {
      /* ignore */
    }
  }
}

export const replayUI = new ReplayUIStore();
