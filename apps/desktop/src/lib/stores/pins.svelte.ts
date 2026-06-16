// Cross-surface pin / favorite store.
//
// Rune-based singleton (`pins`) tracking the user's pinned items per
// surface — skills, routines, knowledge docs, chat threads, and
// extensions. Each surface keeps its own ordered list of opaque string
// ids; the surface decides what those ids mean (skill.name, routine.id,
// extension.name, thread.id, knowledge path).
//
// The store deliberately doesn't know anything about the items it pins
// — it's a thin id-list keyed by surface. Surfaces consult `isPinned`
// to render a star indicator and call `pin` / `unpin` to toggle. The
// CommandPalette consumes `all()` to render a cross-surface "Pinned"
// section.
//
// Persistence: a single localStorage blob under `ironclaw-pins`,
// rewritten on every mutation. We cap each surface at MAX_PER_SURFACE
// pins so a runaway click on the star can't bloat the blob unbounded;
// the cap is enforced inside `pin()` (oldest entry drops off) and
// applied defensively on load too in case the on-disk blob predates
// the cap or was hand-edited.
//
// Knowledge note: /knowledge already ships its own dedicated bookmarks
// list under `ironclaw-knowledge-bookmarks`. We leave that store as the
// source of truth for the in-page UI (bookmarks vs pins is a
// distinction the spec preserves) — the cross-surface "Pinned" overview
// can either read both stores or treat knowledge bookmarks separately.
// For v1 the surfaces stay siloed: knowledge has bookmarks, the other
// four use this store. The palette section consults `all()` only, so
// any knowledge integration is opt-in via future calls to `pin('knowledge', path)`.

import { toasts } from './toasts.svelte';

/** Surfaces that participate in cross-surface pinning. */
export type PinSurface = 'skill' | 'routine' | 'knowledge' | 'thread' | 'extension';

/** Per-surface cap. Twenty is the spec; oldest entry rolls off when reached. */
export const MAX_PER_SURFACE = 20;

const LS_KEY = 'ironclaw-pins';

const SURFACE_KEYS: readonly PinSurface[] = [
  'skill',
  'routine',
  'knowledge',
  'thread',
  'extension'
] as const;

type PinsBySurface = Record<PinSurface, string[]>;

function emptyPins(): PinsBySurface {
  return {
    skill: [],
    routine: [],
    knowledge: [],
    thread: [],
    extension: []
  };
}

/**
 * Defensively shape an arbitrary JSON blob into a `PinsBySurface`.
 * Drops unknown surfaces, non-string ids, and enforces the per-surface
 * cap so a stale or hand-edited file can't put the in-memory state in
 * an invalid shape.
 */
function coerceLoaded(raw: unknown): PinsBySurface {
  const out = emptyPins();
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const surface of SURFACE_KEYS) {
    const arr = obj[surface];
    if (!Array.isArray(arr)) continue;
    const cleaned: string[] = [];
    const seen = new Set<string>();
    for (const v of arr) {
      if (typeof v !== 'string') continue;
      if (seen.has(v)) continue;
      seen.add(v);
      cleaned.push(v);
      if (cleaned.length >= MAX_PER_SURFACE) break;
    }
    out[surface] = cleaned;
  }
  return out;
}

class PinStore {
  /** Per-surface pinned id lists. Mutations always replace the array
   *  reference so Svelte's reactivity picks up the change. */
  pins = $state<PinsBySurface>(emptyPins());

  private hydrated = false;

  /**
   * Hydrate from localStorage. Idempotent — safe to call multiple times.
   * Call once during root-layout mount so the first render across every
   * surface sees the saved state.
   */
  init(): void {
    if (this.hydrated || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        this.pins = coerceLoaded(parsed);
      }
    } catch {
      // Corrupt JSON or unavailable storage — fall back to empty state.
    }
    this.hydrated = true;
  }

  /**
   * Add `id` to the pinned list for `surface`. No-op if already pinned.
   * When the surface is at the cap, the oldest entry rolls off so the
   * newest pin always lands. A success toast surfaces the action (the
   * star alone is subtle enough that users miss it).
   */
  pin(surface: PinSurface, id: string): void {
    if (!id) return;
    const current = this.pins[surface] ?? [];
    if (current.includes(id)) return;
    let next = [...current, id];
    if (next.length > MAX_PER_SURFACE) {
      // Drop the oldest entry (front of the list) so the freshest pin
      // is preserved. The cap is small (20) so a single splice is fine.
      next = next.slice(next.length - MAX_PER_SURFACE);
    }
    this.pins = { ...this.pins, [surface]: next };
    this.persist();
  }

  /**
   * Remove `id` from the pinned list for `surface`. No-op if not present.
   */
  unpin(surface: PinSurface, id: string): void {
    if (!id) return;
    const current = this.pins[surface] ?? [];
    if (!current.includes(id)) return;
    const next = current.filter((p) => p !== id);
    this.pins = { ...this.pins, [surface]: next };
    this.persist();
  }

  /**
   * Convenience toggle. Pins when not present, unpins when present.
   * Toasts the resulting state so the user gets a confirmation cue
   * regardless of which way the click went. Returns the post-toggle
   * pinned state (`true` if now pinned).
   */
  toggle(surface: PinSurface, id: string, label?: string): boolean {
    if (this.isPinned(surface, id)) {
      this.unpin(surface, id);
      toasts.show(`Unpinned${label ? `: ${label}` : ''}`, 'info');
      return false;
    }
    const wasAtCap = (this.pins[surface] ?? []).length >= MAX_PER_SURFACE;
    this.pin(surface, id);
    if (wasAtCap) {
      toasts.show(
        `Pinned${label ? `: ${label}` : ''} (oldest pin dropped — cap is ${MAX_PER_SURFACE})`,
        'info'
      );
    } else {
      toasts.show(`Pinned${label ? `: ${label}` : ''}`, 'success');
    }
    return true;
  }

  /** True when `id` is currently pinned on `surface`. */
  isPinned(surface: PinSurface, id: string): boolean {
    const arr = this.pins[surface];
    return Array.isArray(arr) && arr.includes(id);
  }

  /**
   * Flat list of every pinned item across every surface. Order: surfaces
   * iterated in declaration order (skill, routine, knowledge, thread,
   * extension), pins iterated in insertion order within each surface.
   * Consumed by the cross-surface Pinned section in CommandPalette.
   */
  all(): Array<{ surface: PinSurface; id: string }> {
    const out: Array<{ surface: PinSurface; id: string }> = [];
    for (const surface of SURFACE_KEYS) {
      const arr = this.pins[surface] ?? [];
      for (const id of arr) {
        out.push({ surface, id });
      }
    }
    return out;
  }

  /** Persist the current shape to localStorage. Best-effort — quota /
   *  private-mode failures are non-fatal (the pins still work
   *  in-memory and the next mutation re-attempts). */
  private persist(): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(this.pins));
    } catch {
      // Storage may be full or disabled — non-fatal.
    }
  }
}

/** Global singleton — import this anywhere. */
export const pins = new PinStore();
