// Workspace Presets — capture/restore "layout state" snapshots.
//
// A preset records the user-visible workspace context: the active route,
// the currently-selected chat thread, the persisted pane widths for the
// three resizable surfaces (chat rail / chat inspector / knowledge tree /
// missions projects), the sidebar collapsed state, the menu-bar badge
// master toggle, and the bottom status-bar visibility flag.
//
// Saving captures the *current* values directly off the live stores +
// localStorage; applying writes the values back into the same storage
// keys, calls the public store setters we own (`threads.selectThread`,
// `notifications.setTrayBadgeEnabled`), then navigates to `activePath`
// via `goto`. Cross-route navigations remount the destination page, so
// pane widths and sidebar collapsed state pick up the restored
// localStorage on next mount. Same-route applies dispatch a synthetic
// `storage` event so any component subscribed to storage (none today)
// can re-read; for the existing chat/knowledge/missions pages — which
// hydrate on `onMount` only — same-route width restoration takes effect
// on next visit. The toast surfaced by `apply()` reflects this.
//
// Persistence: a single JSON array under localStorage key
// `ironclaw-presets`. Defensive load coerces unknown shapes into an empty
// list rather than crashing on corrupt input. Mutations rewrite the
// whole blob (small, low-frequency — saving/applying happens manually).
//
// Constraints: store deliberately reads `localStorage`, `window.location`,
// and a handful of public store fields directly rather than introducing
// new cross-store plumbing. The four panel-width storage keys are
// duplicated as constants here to keep the store decoupled from the
// route files that own them (changing a key there must mirror here —
// flagged with a TODO).

import { goto } from '$app/navigation';
import { threads } from './threads.svelte';
import { notifications } from './notifications.svelte';
import { toasts } from './toasts.svelte';

// ---- storage keys ---------------------------------------------------------

const PRESETS_LS_KEY = 'ironclaw-presets';
const SIDEBAR_COLLAPSED_LS_KEY = 'ironclaw-sidebar-collapsed';
const STATUSBAR_VISIBLE_LS_KEY = 'ironclaw-statusbar-visible';

// Panel-width storage keys. These mirror the constants defined in the
// route components that own each surface:
//   THREAD_RAIL_STORAGE_KEY  → src/routes/+page.svelte
//   INSPECTOR_STORAGE_KEY    → src/routes/+page.svelte
//   TREE_RAIL_STORAGE_KEY    → src/routes/knowledge/+page.svelte
//   PROJECTS_RAIL_STORAGE_KEY→ src/routes/missions/+page.svelte
// TODO(presets): collapse the duplication by exporting these from a
// shared module the routes also import. Out of scope for v1 because the
// constraint set forbids touching the route files beyond +layout.svelte.
const CHAT_RAIL_LS_KEY = 'ironclaw-chat-rail-width';
const CHAT_INSPECTOR_LS_KEY = 'ironclaw-chat-inspector-width';
const KNOWLEDGE_TREE_LS_KEY = 'ironclaw-knowledge-tree-width';
const MISSIONS_PROJECTS_LS_KEY = 'ironclaw-missions-projects-width';

// ---- shape ----------------------------------------------------------------

export interface WorkspacePreset {
  /** UUID-ish id. Stable across renames; used as the React-style key. */
  id: string;
  /** User-supplied name. Trimmed to 80 chars on save/rename. */
  name: string;
  /** ISO timestamp of creation. Not updated on rename — the modal renders
   *  this as "saved <relative> ago" so the user can scan recency. */
  createdAt: string;
  /** Route path the user was on at save time. Used as the goto target on
   *  apply. Falls back to "/" if unset (legacy presets). */
  activePath: string;
  /** Selected chat thread id, if any. Restored via
   *  `threads.selectThread()` post-navigate so the chat surface lands on
   *  the right conversation. */
  currentThreadId?: string;
  /** Per-surface pane widths in pixels. Only fields that had a saved
   *  value when the preset was captured are present; unknown surfaces
   *  fall through to their route-level defaults on apply. */
  chatRailWidth?: number;
  chatInspectorWidth?: number;
  knowledgeTreeWidth?: number;
  missionsProjectsWidth?: number;
  /** Sidebar collapsed state at save time. */
  sidebarCollapsed?: boolean;
  /** Menu-bar tray badge master toggle. */
  trayBadgeEnabled?: boolean;
  /** Bottom status-bar visibility. Stored as a boolean even though the
   *  underlying localStorage key serializes the string "true"/"false". */
  statusBarVisible?: boolean;
}

// ---- helpers --------------------------------------------------------------

/**
 * Generate a stable opaque id. Prefers `crypto.randomUUID()` when
 * available (modern browsers + Tauri's webview), falls back to a
 * Math.random-seeded hex string so the store still works in the rare
 * runtime that doesn't expose crypto (older jsdom, certain SSR
 * fallbacks). Collisions would be silently survivable — the consumer
 * keys by id only inside the user's own presets list — but the UUID
 * path is the load-bearing one.
 */
function makeId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the seeded fallback.
  }
  return 'p_' + Math.random().toString(16).slice(2, 10) + '_' + Date.now().toString(36);
}

/** Read an integer from localStorage; null when missing/malformed. */
function readInt(key: string): number | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Write an integer to localStorage (no-op when storage unavailable). */
function writeInt(key: string, value: number): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // Quota / private-mode failures are non-fatal.
  }
}

/** Read a boolean stored as "true" / "false" or "1" / "0" / "". */
function readBool(key: string, encoding: '01' | 'truefalse'): boolean | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return undefined;
    if (encoding === '01') return raw === '1';
    return raw === 'true';
  } catch {
    return undefined;
  }
}

function writeBool(key: string, value: boolean, encoding: '01' | 'truefalse'): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (encoding === '01') {
      localStorage.setItem(key, value ? '1' : '0');
    } else {
      localStorage.setItem(key, value ? 'true' : 'false');
    }
  } catch {
    // ignore
  }
}

/**
 * Best-effort: dispatch a synthetic `storage` event so any component
 * that listens (none today, but a future surface could) re-reads.
 * Real `storage` events only fire cross-tab — same-window writes are
 * silent — so simulating one is the standard pattern for in-window
 * fan-out without coupling stores together. Safe in jsdom: the event
 * constructor + dispatch are both polyfilled.
 *
 * TODO(presets): once the chat/knowledge/missions pages subscribe to
 * the storage event in their respective `$effect.root` blocks, this
 * call propagates pane-width changes to live components without a
 * route remount. Today same-route applies require a route revisit to
 * pick up new pane widths — flagged in the apply() toast.
 */
function notifyStorage(key: string, value: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new StorageEvent('storage', {
        key,
        newValue: value,
        storageArea: window.localStorage
      })
    );
  } catch {
    // Older webviews may not support the StorageEvent constructor —
    // non-fatal, the localStorage write itself still landed.
  }
}

/**
 * Defensive parse of an unknown JSON blob into a typed preset list.
 * Drops malformed rows rather than throwing so a single corrupt entry
 * doesn't take down the whole list.
 */
function coercePresets(raw: unknown): WorkspacePreset[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkspacePreset[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' && e.id ? e.id : null;
    const name = typeof e.name === 'string' ? e.name : null;
    const createdAt = typeof e.createdAt === 'string' ? e.createdAt : null;
    const activePath = typeof e.activePath === 'string' ? e.activePath : '/';
    if (!id || !name || !createdAt) continue;
    const preset: WorkspacePreset = { id, name, createdAt, activePath };
    if (typeof e.currentThreadId === 'string') {
      preset.currentThreadId = e.currentThreadId;
    }
    if (typeof e.chatRailWidth === 'number' && Number.isFinite(e.chatRailWidth)) {
      preset.chatRailWidth = e.chatRailWidth;
    }
    if (typeof e.chatInspectorWidth === 'number' && Number.isFinite(e.chatInspectorWidth)) {
      preset.chatInspectorWidth = e.chatInspectorWidth;
    }
    if (typeof e.knowledgeTreeWidth === 'number' && Number.isFinite(e.knowledgeTreeWidth)) {
      preset.knowledgeTreeWidth = e.knowledgeTreeWidth;
    }
    if (typeof e.missionsProjectsWidth === 'number' && Number.isFinite(e.missionsProjectsWidth)) {
      preset.missionsProjectsWidth = e.missionsProjectsWidth;
    }
    if (typeof e.sidebarCollapsed === 'boolean') {
      preset.sidebarCollapsed = e.sidebarCollapsed;
    }
    if (typeof e.trayBadgeEnabled === 'boolean') {
      preset.trayBadgeEnabled = e.trayBadgeEnabled;
    }
    if (typeof e.statusBarVisible === 'boolean') {
      preset.statusBarVisible = e.statusBarVisible;
    }
    out.push(preset);
  }
  return out;
}

/** Capture the current workspace state from live stores + localStorage. */
function captureCurrent(name: string): WorkspacePreset {
  const activePath =
    typeof window !== 'undefined' && window.location?.pathname ? window.location.pathname : '/';
  const preset: WorkspacePreset = {
    id: makeId(),
    name,
    createdAt: new Date().toISOString(),
    activePath
  };
  if (threads.currentId) preset.currentThreadId = threads.currentId;

  const chatRail = readInt(CHAT_RAIL_LS_KEY);
  if (chatRail !== undefined) preset.chatRailWidth = chatRail;
  const chatInspector = readInt(CHAT_INSPECTOR_LS_KEY);
  if (chatInspector !== undefined) preset.chatInspectorWidth = chatInspector;
  const knowledgeTree = readInt(KNOWLEDGE_TREE_LS_KEY);
  if (knowledgeTree !== undefined) preset.knowledgeTreeWidth = knowledgeTree;
  const missionsProjects = readInt(MISSIONS_PROJECTS_LS_KEY);
  if (missionsProjects !== undefined) {
    preset.missionsProjectsWidth = missionsProjects;
  }

  const sidebarCollapsed = readBool(SIDEBAR_COLLAPSED_LS_KEY, '01');
  if (sidebarCollapsed !== undefined) {
    preset.sidebarCollapsed = sidebarCollapsed;
  }
  const statusBarVisible = readBool(STATUSBAR_VISIBLE_LS_KEY, 'truefalse');
  if (statusBarVisible !== undefined) {
    preset.statusBarVisible = statusBarVisible;
  }
  // Read directly off the notifications store — already hydrated by
  // the layout's onMount, so this is always current.
  preset.trayBadgeEnabled = notifications.trayBadgeEnabled;
  return preset;
}

// ---- store ----------------------------------------------------------------

class PresetStore {
  /** Ordered list, newest-first. Replaced on every mutation so Svelte
   *  reactivity picks up the change. Hydrated once via `init()`. */
  presets = $state<WorkspacePreset[]>([]);

  private hydrated = false;

  /**
   * Hydrate from localStorage. Idempotent — safe to call multiple times.
   * Call once during root-layout mount so the first render of the
   * presets modal sees the saved list.
   */
  init(): void {
    if (this.hydrated || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(PRESETS_LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        this.presets = coercePresets(parsed);
      }
    } catch {
      // Corrupt JSON or unavailable storage — fall back to empty state.
    }
    this.hydrated = true;
  }

  /**
   * Capture current workspace state under `name`. Trims the name to 80
   * chars and falls back to "Untitled preset" if empty. Persists
   * immediately and returns the new preset so the caller can route on
   * it (the modal scrolls the new row into view).
   */
  save(name: string): WorkspacePreset {
    const trimmed = (name ?? '').trim().slice(0, 80) || 'Untitled preset';
    const preset = captureCurrent(trimmed);
    // Newest-first ordering — the modal renders top-down so users see
    // their freshest save at the top without an extra sort step.
    this.presets = [preset, ...this.presets];
    this.persist();
    return preset;
  }

  /**
   * Restore a preset. Order of operations:
   *   1. Write panel widths + sidebar collapsed + statusbar to
   *      localStorage so destination route mounts read them fresh.
   *   2. Dispatch synthetic `storage` events for each key so any
   *      same-window listener (none today) re-reads without a remount.
   *   3. Apply tray badge via `notifications.setTrayBadgeEnabled()` —
   *      reactive, no remount needed.
   *   4. Apply thread selection via `threads.selectThread()`.
   *   5. Navigate via `goto(activePath)`.
   *
   * Cross-route navigations remount the destination page, so pane
   * widths and sidebar state pick up the restored localStorage on next
   * mount. Same-route applies are best-effort: the storage write
   * lands but existing components that read only on `onMount` need a
   * route revisit to pick up new pane widths. The toast surfaces this
   * caveat when it matters.
   */
  async apply(id: string): Promise<void> {
    const preset = this.presets.find((p) => p.id === id);
    if (!preset) {
      toasts.show('Preset no longer exists.', 'error');
      return;
    }

    // Step 1 + 2 — write storage and notify any same-window listeners.
    if (preset.chatRailWidth !== undefined) {
      writeInt(CHAT_RAIL_LS_KEY, preset.chatRailWidth);
      notifyStorage(CHAT_RAIL_LS_KEY, String(Math.round(preset.chatRailWidth)));
    }
    if (preset.chatInspectorWidth !== undefined) {
      writeInt(CHAT_INSPECTOR_LS_KEY, preset.chatInspectorWidth);
      notifyStorage(CHAT_INSPECTOR_LS_KEY, String(Math.round(preset.chatInspectorWidth)));
    }
    if (preset.knowledgeTreeWidth !== undefined) {
      writeInt(KNOWLEDGE_TREE_LS_KEY, preset.knowledgeTreeWidth);
      notifyStorage(KNOWLEDGE_TREE_LS_KEY, String(Math.round(preset.knowledgeTreeWidth)));
    }
    if (preset.missionsProjectsWidth !== undefined) {
      writeInt(MISSIONS_PROJECTS_LS_KEY, preset.missionsProjectsWidth);
      notifyStorage(MISSIONS_PROJECTS_LS_KEY, String(Math.round(preset.missionsProjectsWidth)));
    }
    if (preset.sidebarCollapsed !== undefined) {
      writeBool(SIDEBAR_COLLAPSED_LS_KEY, preset.sidebarCollapsed, '01');
      notifyStorage(SIDEBAR_COLLAPSED_LS_KEY, preset.sidebarCollapsed ? '1' : '0');
    }
    if (preset.statusBarVisible !== undefined) {
      writeBool(STATUSBAR_VISIBLE_LS_KEY, preset.statusBarVisible, 'truefalse');
      notifyStorage(STATUSBAR_VISIBLE_LS_KEY, preset.statusBarVisible ? 'true' : 'false');
    }

    // Step 3 — tray badge via the public setter (reactive, no remount).
    if (preset.trayBadgeEnabled !== undefined) {
      notifications.setTrayBadgeEnabled(preset.trayBadgeEnabled);
    }

    // Step 4 — thread selection. Setting it BEFORE the navigation means
    // the chat surface's mount sees the right id and skips the
    // last-thread-auto-select path. `selectThread(null)` is a valid
    // signal too — restores the "no thread selected" state.
    threads.selectThread(preset.currentThreadId ?? null);

    // Step 5 — navigate. Same-route goto is a no-op for component
    // remount under SvelteKit, so we surface the limitation via toast.
    const currentPath =
      typeof window !== 'undefined' && window.location?.pathname ? window.location.pathname : '/';
    const sameRoute = currentPath === preset.activePath;
    try {
      await goto(preset.activePath);
    } catch (err) {
      toasts.show(`Navigation failed: ${(err as Error).message}`, 'error');
      return;
    }

    if (sameRoute) {
      toasts.show(`Applied "${preset.name}" — revisit the page to refresh pane widths.`, 'info');
    } else {
      toasts.show(`Applied "${preset.name}".`, 'success');
    }
  }

  /**
   * Rename a preset in place. Trims like save() and ignores no-op
   * renames so the list reference only changes when the name actually
   * changed (prevents needless modal re-renders).
   */
  rename(id: string, name: string): void {
    const trimmed = (name ?? '').trim().slice(0, 80) || 'Untitled preset';
    const idx = this.presets.findIndex((p) => p.id === id);
    if (idx < 0) return;
    if (this.presets[idx].name === trimmed) return;
    const next = [...this.presets];
    next[idx] = { ...next[idx], name: trimmed };
    this.presets = next;
    this.persist();
  }

  /** Drop a preset. No-op when id isn't in the list. */
  delete(id: string): void {
    const idx = this.presets.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const next = [...this.presets];
    next.splice(idx, 1);
    this.presets = next;
    this.persist();
  }

  /** Persist the full list. Best-effort — quota / private-mode failures
   *  are non-fatal (the in-memory list still works, the next mutation
   *  re-attempts). */
  private persist(): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(PRESETS_LS_KEY, JSON.stringify(this.presets));
    } catch {
      // Storage may be full or disabled — non-fatal.
    }
  }
}

/** Global singleton — import this anywhere. */
export const presets = new PresetStore();

// ---- modal-visibility singleton ------------------------------------------

/**
 * Rune singleton that tracks the Presets modal visibility. Same shape
 * as `aboutStore` / `quickCapture` so the layout-level shortcut and
 * the palette action can wire it identically.
 *
 * `openWithFocus` carries an optional hint so the palette's "Save
 * current as preset…" action can pre-focus the save input — the modal
 * consults this on open and resets to null after consuming.
 */
class PresetsModalStore {
  open = $state<boolean>(false);
  /** When set on open, the modal jumps focus to the save-name input
   *  rather than the list. Consumed once per open. */
  focusTarget = $state<'save' | null>(null);

  show(target: 'save' | null = null): void {
    this.focusTarget = target;
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.focusTarget = null;
  }

  toggle(target: 'save' | null = null): void {
    if (this.open) {
      this.close();
    } else {
      this.show(target);
    }
  }
}

export const presetsModal = new PresetsModalStore();
