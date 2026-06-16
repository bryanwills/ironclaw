// Chrome-style chat tabs.
//
// Each "tab" is an open thread the user wants to keep one keystroke
// away. Distinct from the sidebar's thread list — the thread list is
// the historical archive, tabs are the active set the user is moving
// between right now. Closing a tab does NOT delete the thread; it just
// drops the entry from the strip.
//
// Persistence: per-window localStorage under
// `ironclaw-chat-tabs-<profileId>`. Each profile has its own tab set
// (so a "trading" profile and a "research" profile don't share). On
// first hydration: if there are no stored tabs but the current thread
// is non-null, seed a single tab for it.
//
// Order: explicit. Drag-to-reorder updates the array in place; we
// preserve the order across reloads.

// Guarded against SSR / vitest runs that don't expose localStorage.
const isBrowser = (): boolean =>
  typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const STORAGE_PREFIX = 'ironclaw-chat-tabs-';
const MAX_TABS = 12;

interface PersistedState {
  openTabs: string[];
  activeTabId: string | null;
}

function storageKey(profileId: string | null): string {
  return `${STORAGE_PREFIX}${profileId ?? 'default'}`;
}

function read(profileId: string | null): PersistedState {
  if (!isBrowser()) return { openTabs: [], activeTabId: null };
  try {
    const raw = localStorage.getItem(storageKey(profileId));
    if (!raw) return { openTabs: [], activeTabId: null };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { openTabs: [], activeTabId: null };
    }
    // Defensive filter against prototype pollution + bad shapes.
    const openTabs = Array.isArray(parsed.openTabs)
      ? parsed.openTabs
          .filter((t: unknown): t is string => typeof t === 'string' && t.length > 0)
          .slice(0, MAX_TABS)
      : [];
    const activeTabId =
      typeof parsed.activeTabId === 'string' && openTabs.includes(parsed.activeTabId)
        ? parsed.activeTabId
        : (openTabs[0] ?? null);
    return { openTabs, activeTabId };
  } catch {
    return { openTabs: [], activeTabId: null };
  }
}

function write(profileId: string | null, state: PersistedState): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(storageKey(profileId), JSON.stringify(state));
  } catch {
    // Storage quota exhausted or disabled — skip.
  }
}

class ChatTabsStore {
  openTabs = $state<string[]>([]);
  activeTabId = $state<string | null>(null);
  private profileId: string | null = null;

  /**
   * Bind the store to a profile id. Subsequent operations persist to
   * that profile's localStorage slot. Safe to call multiple times; on
   * profile switch, the new tab set is loaded from disk.
   */
  bindProfile(profileId: string | null): void {
    if (this.profileId === profileId) return;
    this.profileId = profileId;
    const { openTabs, activeTabId } = read(profileId);
    this.openTabs = openTabs;
    this.activeTabId = activeTabId;
  }

  /**
   * Open (or focus, if already open) a thread as a tab. Returns the
   * tab id that ended up active. Caps at MAX_TABS — the oldest
   * inactive tab is evicted FIFO if the cap is hit.
   */
  open(threadId: string): string {
    if (!threadId) return threadId;
    if (!this.openTabs.includes(threadId)) {
      if (this.openTabs.length >= MAX_TABS) {
        // Evict the first non-active tab, keeping the active one.
        const evictIdx = this.openTabs.findIndex((t) => t !== this.activeTabId);
        if (evictIdx >= 0) {
          this.openTabs = [
            ...this.openTabs.slice(0, evictIdx),
            ...this.openTabs.slice(evictIdx + 1)
          ];
        }
      }
      this.openTabs = [...this.openTabs, threadId];
    }
    this.activeTabId = threadId;
    this.persist();
    return threadId;
  }

  /**
   * Close a tab. If the closed tab was active, focus shifts to the
   * neighbor on the right, falling back to the one on the left. If
   * the strip is now empty, activeTabId becomes null.
   */
  close(threadId: string): string | null {
    const idx = this.openTabs.indexOf(threadId);
    if (idx < 0) return this.activeTabId;
    const wasActive = this.activeTabId === threadId;
    this.openTabs = [...this.openTabs.slice(0, idx), ...this.openTabs.slice(idx + 1)];
    if (wasActive) {
      const next = this.openTabs[idx] ?? this.openTabs[idx - 1] ?? null;
      this.activeTabId = next;
    }
    this.persist();
    return this.activeTabId;
  }

  /**
   * Focus an already-open tab. No-op if the tab id isn't in the strip.
   */
  setActive(threadId: string): void {
    if (!this.openTabs.includes(threadId)) return;
    if (this.activeTabId === threadId) return;
    this.activeTabId = threadId;
    this.persist();
  }

  /**
   * Reorder tabs. Both indices are clamped to the current length.
   */
  reorder(fromIdx: number, toIdx: number): void {
    const n = this.openTabs.length;
    if (n < 2) return;
    const a = Math.max(0, Math.min(n - 1, fromIdx));
    const b = Math.max(0, Math.min(n - 1, toIdx));
    if (a === b) return;
    const next = [...this.openTabs];
    const [moved] = next.splice(a, 1);
    next.splice(b, 0, moved);
    this.openTabs = next;
    this.persist();
  }

  /**
   * Close every tab except the given one. If the surviving tab is
   * different from the current active tab, the surviving one becomes
   * active.
   */
  closeOthers(threadId: string): void {
    if (!this.openTabs.includes(threadId)) return;
    this.openTabs = [threadId];
    this.activeTabId = threadId;
    this.persist();
  }

  /**
   * Close every tab. activeTabId becomes null.
   */
  closeAll(): void {
    this.openTabs = [];
    this.activeTabId = null;
    this.persist();
  }

  /**
   * True if the given thread id is currently in the tab strip.
   */
  isOpen(threadId: string): boolean {
    return this.openTabs.includes(threadId);
  }

  private persist(): void {
    write(this.profileId, {
      openTabs: this.openTabs,
      activeTabId: this.activeTabId
    });
  }
}

export const chatTabs = new ChatTabsStore();
