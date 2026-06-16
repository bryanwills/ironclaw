// Omnibar — universal search + action launcher.
//
// Cmd+Space opens an overlay that federates across every navigable
// surface in the app: threads (by title), memory docs (by path +
// content snippet preview), skills (by name + description), and
// commands (the sidebar actions + kebab actions registered elsewhere).
//
// Distinct from the Cmd+K command palette (R27) — the palette is a
// curated list of system actions; the omnibar is fuzzy federated
// search that lands the user inside content. They co-exist because
// the muscle memory is different: ⌘K for "what can I do?",
// ⌘Space for "where's the thing I'm thinking about?".
//
// This store owns:
//   - Open/closed state (Cmd+Space toggles).
//   - The query string + debounced search across sources.
//   - The result list (typed) + active-index for keyboard navigation.
//   - A pluggable "commands provider" so other modules can register
//     navigable actions without taking a dep on the omnibar component.

import type { IronClawClient } from '$lib/api/ironclaw';
import type { Skill } from '$lib/api/types';
import { fuzzyMatch } from '$lib/util/fuzzy';
import { getMessages, listCachedThreadIds } from '$lib/util/idb-cache';
import { searchCachedMessages, type SearchableMessage } from '$lib/util/message-search';
import { connection } from './connection.svelte';
import { threads as threadsStore } from './threads.svelte';
import { threadRename } from './thread-rename.svelte';

export type OmniResultKind = 'thread' | 'memory' | 'skill' | 'command' | 'message';

export interface OmniResult {
  id: string;
  kind: OmniResultKind;
  title: string;
  /** One-line subtitle for context (e.g. "23 messages · 2h ago"). */
  subtitle?: string;
  /** Optional matching snippet (memory content excerpt). */
  snippet?: string;
  /** Numeric score for ranking. Higher = better. */
  score: number;
  /** Invoked when the user picks this result. */
  action: () => void | Promise<void>;
}

/**
 * Register a navigable command (sidebar nav, kebab action, etc.) so
 * it surfaces alongside content results. Modules call this once on
 * mount; the omnibar reads the registry on every search.
 */
export interface OmniCommand {
  id: string;
  title: string;
  subtitle?: string;
  /** Keywords to match against (lowercase). The title is added
   *  automatically; this is for synonyms / hidden aliases. */
  keywords?: string[];
  action: () => void | Promise<void>;
}

const SEARCH_DEBOUNCE_MS = 80;
const MAX_RESULTS_PER_KIND = 8;
const MAX_RESULTS_TOTAL = 24;

class OmnibarStore {
  open = $state<boolean>(false);
  query = $state<string>('');
  results = $state<OmniResult[]>([]);
  activeIdx = $state<number>(0);
  loading = $state<boolean>(false);
  /** Last error from a memory/skill fetch — not surfaced as a toast,
   *  but the omnibar shows a tiny inline note when present. */
  error = $state<string | null>(null);

  private commands: OmniCommand[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private searchAbort: AbortController | null = null;
  /** Per-open snapshot of the IndexedDB message cache, built once on the
   *  first content search after the omnibar opens (R90 P1: the read used
   *  to fan out across every cached thread on *every* keystroke). Cleared
   *  on show()/hide() so each open reflects the latest cache. */
  private cachedMsgIndex: Record<string, SearchableMessage[]> | null = null;

  /**
   * Register a static command. Idempotent — re-registering the same
   * id replaces the entry. The registration order is preserved so
   * static commands have a stable display order when scores tie.
   */
  registerCommand(cmd: OmniCommand): void {
    const idx = this.commands.findIndex((c) => c.id === cmd.id);
    if (idx >= 0) {
      this.commands[idx] = cmd;
    } else {
      this.commands.push(cmd);
    }
  }

  unregisterCommand(id: string): void {
    this.commands = this.commands.filter((c) => c.id !== id);
  }

  show(): void {
    this.open = true;
    // Fresh message-cache snapshot for this open.
    this.cachedMsgIndex = null;
    // Re-run search so the latest threads / memory state is reflected.
    void this.runSearch(this.query);
  }

  hide(): void {
    this.open = false;
    this.cachedMsgIndex = null;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.searchAbort?.abort();
  }

  toggle(): void {
    if (this.open) {
      this.hide();
    } else {
      this.show();
    }
  }

  setQuery(q: string): void {
    this.query = q;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      void this.runSearch(q);
    }, SEARCH_DEBOUNCE_MS);
  }

  moveActive(delta: number): void {
    if (this.results.length === 0) {
      this.activeIdx = 0;
      return;
    }
    const n = this.results.length;
    this.activeIdx = (this.activeIdx + delta + n) % n;
  }

  setActive(idx: number): void {
    if (idx < 0 || idx >= this.results.length) return;
    this.activeIdx = idx;
  }

  async invokeActive(): Promise<void> {
    const r = this.results[this.activeIdx];
    if (!r) return;
    this.hide();
    try {
      await r.action();
    } catch (err) {
      console.warn('[omnibar] action failed', err);
    }
  }

  private async runSearch(rawQuery: string): Promise<void> {
    const q = rawQuery.trim().toLowerCase();
    this.searchAbort?.abort();
    const abort = new AbortController();
    this.searchAbort = abort;

    this.loading = true;
    this.error = null;
    const merged: OmniResult[] = [];

    // 1) Commands — always included so the omnibar can launch
    //    "Settings", "Knowledge", etc. even with an empty query.
    for (const cmd of this.commands) {
      const score = scoreText(q, cmd.title, cmd.keywords ?? []);
      if (q === '' || score > 0) {
        merged.push({
          id: `cmd:${cmd.id}`,
          kind: 'command',
          title: cmd.title,
          subtitle: cmd.subtitle,
          score: score + 0.5, // commands get a small base bias when q is empty
          action: cmd.action
        });
      }
    }

    // 2) Threads — title match on the loaded set. The threads store
    //    is hydrated whenever the user has visited the chat surface;
    //    on a cold open of the omnibar, this falls through to whatever
    //    happens to be in memory.
    for (const t of threadsStore.threads) {
      const title = threadRename.displayTitle(t.id, t.title);
      const score = scoreText(q, title);
      if (score > 0 || q === '') {
        const turns = t.message_count ?? 0;
        merged.push({
          id: `thread:${t.id}`,
          kind: 'thread',
          title,
          subtitle: turns > 0 ? `${turns} turn${turns === 1 ? '' : 's'}` : 'New thread',
          score,
          action: async () => {
            // R45 codex P1: use the SvelteKit `goto` so we don't blow
            // away every store in memory (chat tabs, broadcast channel,
            // etc.) on every omnibar pick. Lazy-imported to avoid a
            // cycle through `$app/navigation` in vitest.
            const { goto } = await import('$app/navigation');
            await goto(`/chat?thread=${encodeURIComponent(t.id)}`);
          }
        });
      }
    }

    // 3) Memory + skills are network calls — only run when q is at
    //    least 2 chars so the empty-open is fast.
    const client: IronClawClient | null = connection.client;
    if (client && q.length >= 2) {
      try {
        const [memHits, skillHits, msgHits] = await Promise.all([
          fetchMemoryHits(client, q, abort.signal),
          fetchSkillHits(client, q, abort.signal),
          this.messageHits(rawQuery)
        ]);
        merged.push(...memHits, ...skillHits, ...msgHits);
      } catch (err) {
        if (!abort.signal.aborted) {
          this.error = (err as Error).message;
        }
      }
    }

    if (abort.signal.aborted) return;

    // Per-kind cap, then sort by score desc, then truncate to total.
    const byKind = new Map<OmniResultKind, OmniResult[]>();
    for (const r of merged) {
      const slot = byKind.get(r.kind) ?? [];
      slot.push(r);
      byKind.set(r.kind, slot);
    }
    const capped: OmniResult[] = [];
    for (const slot of byKind.values()) {
      slot.sort((a, b) => b.score - a.score);
      capped.push(...slot.slice(0, MAX_RESULTS_PER_KIND));
    }
    capped.sort((a, b) => b.score - a.score);

    this.results = capped.slice(0, MAX_RESULTS_TOTAL);
    this.activeIdx = 0;
    this.loading = false;
  }

  /** Search the offline IndexedDB message cache (R62) via the pure R86
   *  ranking util. The cache snapshot is built once per omnibar-open
   *  (`cachedMsgIndex`) and reused across keystrokes — R90 P1 fixed the
   *  original per-keystroke IDB fan-out. Best-effort: any failure yields
   *  no message hits rather than breaking the rest of the search. */
  private async messageHits(rawQuery: string): Promise<OmniResult[]> {
    try {
      if (this.cachedMsgIndex === null) {
        this.cachedMsgIndex = await buildMessageIndex();
      }
      const hits = searchCachedMessages(rawQuery, this.cachedMsgIndex, {
        limit: MAX_RESULTS_PER_KIND
      });
      const titleFor = (id: string): string => {
        const t = threadsStore.threads.find((x) => x.id === id);
        return t ? threadRename.displayTitle(t.id, t.title) : 'Conversation';
      };
      return hits.map((h, i) => ({
        id: `message:${h.threadId}:${h.messageId}`,
        kind: 'message' as const,
        title: h.snippet,
        subtitle: `${h.role} · ${titleFor(h.threadId)}`,
        // Slot content matches at the "word-boundary" tier, preserving the
        // util's relevance+recency order via a tiny per-rank decrement.
        score: 1.6 - i * 0.001,
        action: async () => {
          const { goto } = await import('$app/navigation');
          await goto(`/chat?thread=${encodeURIComponent(h.threadId)}`);
        }
      }));
    } catch {
      return [];
    }
  }
}

// Fuzzy-ish score: 3 if query is a prefix, 2 if it appears as a word
// boundary, 1 if it's a substring anywhere, 0 otherwise. Cheap +
// good enough for an 80ms debounced search.
function scoreText(query: string, title: string, extra: string[] = []): number {
  if (query === '') return 0;
  const hay = title.toLowerCase();
  if (hay.startsWith(query)) return 3;
  if (new RegExp(`\\b${escapeRegex(query)}`).test(hay)) return 2;
  if (hay.includes(query)) return 1;
  for (const e of extra) {
    if (e.toLowerCase().includes(query)) return 0.8;
  }
  // R94: subsequence fuzzy fallback — catches "gth" → "GitHub" that the
  // substring tiers above miss. Scored in a low band (<= 0.7) so a fuzzy
  // hit never outranks a real prefix/word-boundary/substring/extra match;
  // it only promotes items that would otherwise score 0.
  // fuzzyMatch is ~O(query × target²); titles here are short, but guard
  // against a pathologically long one lagging the per-keystroke search
  // (review P2). Anything over 200 chars skips the fuzzy tier.
  if (title.length > 200) return 0;
  const fz = fuzzyMatch(query, title);
  if (fz.matched && fz.score > 0) {
    return Math.min(0.7, 0.1 + fz.score / 1000);
  }
  return 0;
}

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

async function fetchMemoryHits(
  client: IronClawClient,
  q: string,
  signal: AbortSignal
): Promise<OmniResult[]> {
  if (signal.aborted) return [];
  try {
    const hits = await client.searchMemory(q, MAX_RESULTS_PER_KIND);
    if (signal.aborted) return [];
    return hits.map((h, i) => ({
      id: `mem:${h.path}`,
      kind: 'memory' as const,
      title: h.path,
      subtitle: `Memory · score ${h.score.toFixed(2)}`,
      snippet: h.snippet,
      score: Math.max(0.5, 2 - i * 0.1),
      action: () => {
        // R45 codex P1: SvelteKit-friendly nav (see thread action).
        void import('$app/navigation').then(({ goto }) =>
          goto(`/memory?path=${encodeURIComponent(h.path)}`)
        );
      }
    }));
  } catch {
    return [];
  }
}

// Session-scoped skills cache. The omnibar called `client.listSkills()` on
// every debounced query (≥2 chars) — a full network round-trip per
// keystroke-batch even though the catalog rarely changes mid-session (audit
// R200 P1). Cache it with a short TTL and search the cached list locally;
// a freshly installed skill still appears within the TTL window.
const SKILLS_CACHE_TTL_MS = 60_000;
let skillsCache: { at: number; skills: Skill[] } | null = null;

async function loadSkillsCached(client: IronClawClient): Promise<Skill[]> {
  const now = Date.now();
  if (skillsCache && now - skillsCache.at < SKILLS_CACHE_TTL_MS) {
    return skillsCache.skills;
  }
  const skills = await client.listSkills();
  skillsCache = { at: now, skills };
  return skills;
}

async function fetchSkillHits(
  client: IronClawClient,
  q: string,
  signal: AbortSignal
): Promise<OmniResult[]> {
  if (signal.aborted) return [];
  try {
    const skills = await loadSkillsCached(client);
    if (signal.aborted) return [];
    return skills
      .map((s) => ({
        skill: s,
        score: scoreText(q, s.name, [s.description ?? ''])
      }))
      .filter((row) => row.score > 0)
      .slice(0, MAX_RESULTS_PER_KIND)
      .map((row) => ({
        id: `skill:${row.skill.name}`,
        kind: 'skill' as const,
        title: row.skill.name,
        subtitle: row.skill.description?.slice(0, 80),
        score: row.score,
        action: () => {
          // R45 codex P1: SvelteKit-friendly nav (see thread action).
          void import('$app/navigation').then(({ goto }) =>
            goto(`/skills?id=${encodeURIComponent(row.skill.name)}`)
          );
        }
      }));
  } catch {
    return [];
  }
}

/**
 * Build a `{threadId -> messages}` snapshot from the IndexedDB message
 * cache (R62), bounded to the threads the app currently knows about and
 * capped, so a single build stays cheap. Called once per omnibar-open by
 * `OmnibarStore.messageHits`; the result is cached and reused across
 * keystrokes. Best-effort — any cache/parse failure yields an empty map.
 */
async function buildMessageIndex(): Promise<Record<string, SearchableMessage[]>> {
  const byThread: Record<string, SearchableMessage[]> = {};
  try {
    const cachedIds = await listCachedThreadIds();
    if (cachedIds.length === 0) return byThread;
    const known = new Set(threadsStore.threads.map((t) => t.id));
    const ids = (known.size > 0 ? cachedIds.filter((id) => known.has(id)) : cachedIds).slice(0, 40);
    await Promise.all(
      ids.map(async (id) => {
        const msgs = await getMessages(id);
        if (Array.isArray(msgs) && msgs.length > 0) {
          byThread[id] = msgs as SearchableMessage[];
        }
      })
    );
  } catch {
    // best-effort — return whatever we managed to load
  }
  return byThread;
}

export const omnibar = new OmnibarStore();
