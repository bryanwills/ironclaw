// Thread list + current-thread selection for the chat surface.
//
// Uses Svelte 5 runes — singleton instance imported as `threads`. Wraps the
// /api/chat/threads endpoint via the connection-store's client. The chat page
// is responsible for calling `init()` once and `refresh()` after any mutation
// (send, new thread, rename) so the sidebar list stays current.

import type { Thread } from '$lib/api/types';
import { connection } from './connection.svelte';
import { telemetry } from './telemetry.svelte';

// -- recently-selected thread tracking (localStorage) -----------------------
//
// The Cmd+T quick switcher (`ThreadSwitcher.svelte`) leans on a "last 10
// selected" list to bias its sort order. The store records every
// `selectThread(id)` call here so the switcher reads from a single source of
// truth (no DOM listeners, no duplicate plumbing). Persisted across launches
// in `localStorage` under a stable key.
//
// Shape: `Array<{ id: string; ts: number }>`, most-recent-first, capped at
// `RECENT_MAX`. Defensive read — corrupt/legacy values fall back to an
// empty array.

const RECENT_KEY = 'ironclaw-thread-recent';
const RECENT_MAX = 10;

export interface RecentThreadEntry {
  id: string;
  /** Unix epoch ms when the thread was selected. */
  ts: number;
}

function loadRecentThreads(): RecentThreadEntry[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is RecentThreadEntry =>
          typeof e === 'object' &&
          e !== null &&
          typeof e.id === 'string' &&
          typeof e.ts === 'number' &&
          Number.isFinite(e.ts)
      )
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function persistRecentThreads(entries: RecentThreadEntry[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(entries));
  } catch {
    // Quota / private mode / disabled — non-fatal; the in-memory list still
    // works for the duration of this session.
  }
}

/**
 * Push a thread id to the front of the recents list, dedup on id, cap at
 * `RECENT_MAX`. Exported so the switcher can read it directly without going
 * through a derived rune (it lives on the store instance below).
 */
function recordRecentThread(id: string): RecentThreadEntry[] {
  const entry: RecentThreadEntry = { id, ts: Date.now() };
  const prev = loadRecentThreads();
  const next = [entry, ...prev.filter((e) => e.id !== id)].slice(0, RECENT_MAX);
  persistRecentThreads(next);
  return next;
}

class ThreadStore {
  threads = $state<Thread[]>([]);
  currentId = $state<string | null>(null);
  loading = $state<boolean>(false);
  error = $state<string | null>(null);
  /** Recently-selected threads, most-recent-first. Hydrated from
   *  localStorage on construction so the Cmd+T switcher sees prior-session
   *  selections immediately. Mutated only via `selectThread()`. */
  recent = $state<RecentThreadEntry[]>(loadRecentThreads());

  /** Sorted by updated_at desc — what the left rail renders. */
  sorted = $derived(
    [...this.threads].sort((a, b) => {
      const ta = a.updated_at ? Date.parse(a.updated_at) : 0;
      const tb = b.updated_at ? Date.parse(b.updated_at) : 0;
      return tb - ta;
    })
  );

  current = $derived<Thread | null>(
    this.currentId ? (this.threads.find((t) => t.id === this.currentId) ?? null) : null
  );

  async loadThreads(): Promise<void> {
    if (!connection.client) {
      this.threads = [];
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      this.threads = await connection.client.listThreads();
      for (const thread of this.threads) void this.indexInSpotlight(thread.id);
      // If the previously-selected thread is gone, drop the selection so the
      // composer auto-creates on next send rather than 404'ing.
      if (this.currentId && !this.threads.some((t) => t.id === this.currentId)) {
        this.currentId = null;
      }
    } catch (err) {
      this.error = (err as Error).message;
      this.threads = [];
    } finally {
      this.loading = false;
    }
  }

  /** Alias of loadThreads; reads as intent in caller code. */
  async refresh(): Promise<void> {
    await this.loadThreads();
  }

  selectThread(id: string | null): void {
    this.currentId = id;
    // Recording is idempotent and dedupes — calling selectThread() with the
    // current id (e.g. clicking the already-active row) just moves the
    // timestamp forward. Null clears selection but doesn't touch recents.
    if (id) {
      this.recent = recordRecentThread(id);
    }
  }

  /**
   * Create a new server-side thread, refresh, and select it. Returns the new
   * thread id so the caller can immediately send a message into it.
   */
  async createThread(title?: string): Promise<string | null> {
    if (!connection.client) return null;
    try {
      const { id } = await connection.client.newThread(title);
      if (!id) return null;
      await this.loadThreads();
      this.currentId = id;
      void this.indexInSpotlight(id);
      // Mirror selectThread's recent-tracking so a freshly-created thread
      // shows up at the top of the Cmd+T switcher's Recent section.
      this.recent = recordRecentThread(id);
      // Opt-in telemetry — no thread id or title on the wire, just a count.
      telemetry.recordEvent('chat:thread_created');
      return id;
    } catch (err) {
      this.error = (err as Error).message;
      return null;
    }
  }

  /**
   * Local-only optimistic rename. The gateway does not expose a thread-rename
   * endpoint as of v0.29.0; the new title vanishes on next refresh(). Wire up
   * the persisted variant once the server adds PATCH /api/chat/threads/{id}.
   */
  renameLocal(id: string, title: string): void {
    this.threads = this.threads.map((t) => (t.id === id ? { ...t, title } : t));
    void this.indexInSpotlight(id);
  }

  private async indexInSpotlight(threadId: string): Promise<void> {
    if (typeof window === 'undefined') return;
    if (!('__TAURI_INTERNALS__' in window)) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const messages = (await import('./messages.svelte')).messages
        .get(threadId)
        .slice(-50)
        .map((m) => ({ role: m.role, content: m.content }));
      const thread = this.threads.find((t) => t.id === threadId);
      if (!thread) return;
      await invoke('spotlight_index_thread', {
        snapshot: {
          id: threadId,
          title: thread.title ?? '(untitled)',
          created_at: thread.created_at,
          updated_at: thread.updated_at,
          messages
        }
      });
    } catch {
      // Spotlight indexing is best-effort.
    }
  }
}

export const threads = new ThreadStore();
