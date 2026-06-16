// Dashboard tile layout + persistence (R77 / lane W1).
//
// Drives the `/dashboard` ("Today") surface — a 4-column grid of widget
// tiles (recent threads, active routines, recent skills, plus any
// future custom widgets). Tiles are user-rearrangeable; their order
// and per-tile metadata persist to localStorage so the layout sticks
// across reloads and process restarts.
//
// Storage shape: a single JSON array under
// `ironclaw-dashboard-layout`. Each entry is a `TileConfig` (id, kind,
// optional title override, optional grid span). On hydrate we
// defensively shape the loaded blob — bad shapes fall back to
// DEFAULT_LAYOUT so a hand-edited or corrupt file can't put the UI in
// an unrenderable state.
//
// Storage isn't keyed per profile in v1 — the Today surface is the
// same shape regardless of which profile is active. The roadmap
// (docs/WORKSPACE-OS.md §198) calls out per-profile tile sets via
// settings.json down the line; this store leaves room for that via a
// `bindProfile` analog when the field actually lands on the wire.
//
// localStorage guard mirrors `chat-tabs.svelte.ts`: we DO NOT pull in
// `$app/environment` since vitest currently throws on the `browser`
// import under jsdom — checking for `window.localStorage` directly
// keeps the store testable.

/** Kinds the dashboard knows how to render natively. Custom widgets
 *  promoted from chat (R57b) use the `'custom'` kind and supply their
 *  own title; the route falls through to a generic placeholder until
 *  the widget framework lands the matching renderer. */
export type TileKind =
  | 'work-queue'
  | 'recent-threads'
  | 'active-routines'
  | 'recent-skills'
  | 'open-loops'
  | 'custom';

/** Grid-relative column span (out of 4). 1 = narrow, 2 = half, 4 = wide. */
export type TileSpan = 1 | 2 | 4;

export interface TileConfig {
  /** Stable id — used as the Svelte `{#each}` key AND as the drag
   *  handle id. The built-in tiles use the kind as the id; custom
   *  tiles get a generated id from the widget framework. */
  id: string;
  kind: TileKind;
  /** Optional title override. Falls back to the kind's default label
   *  when omitted. */
  title?: string;
  /** Optional grid span; defaults to 2 (half-width). */
  span?: TileSpan;
}

const STORAGE_KEY = 'ironclaw-dashboard-layout';

/** Spans we accept off-disk. Anything outside this set falls back to
 *  the default (2) rather than rendering an arbitrary col-span. */
const VALID_SPANS: readonly TileSpan[] = [1, 2, 4] as const;

/** Kinds we accept off-disk. */
const VALID_KINDS: readonly TileKind[] = [
  'work-queue',
  'recent-threads',
  'active-routines',
  'recent-skills',
  'open-loops',
  'custom'
] as const;

const DEFAULT_LAYOUT: TileConfig[] = [
  { id: 'work-queue', kind: 'work-queue', span: 4 },
  { id: 'open-loops', kind: 'open-loops', span: 2 },
  { id: 'recent-threads', kind: 'recent-threads', span: 2 },
  { id: 'active-routines', kind: 'active-routines', span: 2 },
  { id: 'recent-skills', kind: 'recent-skills', span: 2 }
];

/** Safe `localStorage` probe. Same shape as `chat-tabs.svelte.ts` so
 *  the store is friendly to vitest under jsdom (where the
 *  `$app/environment` import would otherwise throw). */
const isBrowser = (): boolean =>
  typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

/**
 * Shape an arbitrary JSON blob into a `TileConfig[]`. Drops entries
 * missing the required fields, coerces unknown kinds → `'custom'`, and
 * normalizes invalid spans → 2. Deduplicates by id so a stale or
 * hand-edited file can't render the same tile twice.
 */
function coerceLoaded(raw: unknown): TileConfig[] {
  if (!Array.isArray(raw)) return [...DEFAULT_LAYOUT];
  const out: TileConfig[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' && e.id.length > 0 ? e.id : null;
    if (!id || seen.has(id)) continue;
    const kindRaw = typeof e.kind === 'string' ? (e.kind as TileKind) : 'custom';
    const kind = (VALID_KINDS as readonly string[]).includes(kindRaw) ? kindRaw : 'custom';
    const spanRaw = e.span;
    const span = (VALID_SPANS as readonly number[]).includes(spanRaw as number)
      ? (spanRaw as TileSpan)
      : 2;
    const title = typeof e.title === 'string' && e.title.length > 0 ? e.title : undefined;
    out.push({ id, kind, span, ...(title ? { title } : {}) });
    seen.add(id);
  }
  return out.length > 0 ? out : [...DEFAULT_LAYOUT];
}

class DashboardStore {
  /** Current tile layout. Mutations always replace the array reference
   *  so Svelte's reactivity picks up the change (mirrors the
   *  `pins.svelte.ts` pattern). */
  tiles = $state<TileConfig[]>([]);

  private hydrated = false;

  constructor() {
    if (isBrowser()) {
      this.hydrate();
    } else {
      // SSR / vitest path before a shim is installed. Seed the default
      // so a read against `tiles` doesn't observe an empty array
      // pre-init.
      this.tiles = [...DEFAULT_LAYOUT];
    }
  }

  /**
   * Add a tile. No-op if a tile with the same id is already present —
   * we don't bump it to the end or replace the existing entry, since
   * the user's manual ordering should outrank a programmatic re-add.
   */
  add(tile: TileConfig): void {
    if (!tile?.id) return;
    if (this.tiles.some((t) => t.id === tile.id)) return;
    this.tiles = [...this.tiles, tile];
    this.persist();
  }

  /** Remove a tile by id. No-op if not present. */
  remove(id: string): void {
    if (!id) return;
    if (!this.tiles.some((t) => t.id === id)) return;
    this.tiles = this.tiles.filter((t) => t.id !== id);
    this.persist();
  }

  /**
   * Move the tile at `fromIdx` to `toIdx`. Both indices are clamped to
   * the current length so a stale drag event from the DnD layer can't
   * land out of bounds. No-op when source and destination collapse to
   * the same slot.
   */
  reorder(fromIdx: number, toIdx: number): void {
    const n = this.tiles.length;
    if (n < 2) return;
    const from = Math.max(0, Math.min(n - 1, fromIdx));
    const to = Math.max(0, Math.min(n - 1, toIdx));
    if (from === to) return;
    const next = [...this.tiles];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    this.tiles = next;
    this.persist();
  }

  /** Mutate the column span of a tile by id. No-op if not present. */
  setSpan(id: string, span: TileSpan): void {
    if (!id) return;
    if (!(VALID_SPANS as readonly number[]).includes(span)) return;
    const idx = this.tiles.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const next = [...this.tiles];
    next[idx] = { ...next[idx], span };
    this.tiles = next;
    this.persist();
  }

  /** Restore the default tile set. Used by the "Reset layout" action
   *  in the dashboard ⋮ menu. */
  reset(): void {
    this.tiles = [...DEFAULT_LAYOUT];
    this.persist();
  }

  private hydrate(): void {
    if (this.hydrated) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        this.tiles = [...DEFAULT_LAYOUT];
      } else {
        const parsed = JSON.parse(raw) as unknown;
        this.tiles = coerceLoaded(parsed);
      }
    } catch {
      // Corrupt JSON or unavailable storage — fall back to defaults.
      this.tiles = [...DEFAULT_LAYOUT];
    }
    this.hydrated = true;
  }

  private persist(): void {
    if (!isBrowser()) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.tiles));
    } catch {
      // Quota / private-mode failures are non-fatal.
    }
  }
}

/** Global singleton — consumed by the `/dashboard` route and the tile
 *  components. */
export const dashboard = new DashboardStore();

/** Default-label lookup for tile kinds. Lives next to the store so
 *  consumers don't reinvent it. */
export function defaultTitleForKind(kind: TileKind): string {
  switch (kind) {
    case 'work-queue':
      return 'Work queue';
    case 'recent-threads':
      return 'Recent threads';
    case 'active-routines':
      return 'Active routines';
    case 'recent-skills':
      return 'Recent skills';
    case 'open-loops':
      return 'Open loops';
    case 'custom':
    default:
      return 'Widget';
  }
}
