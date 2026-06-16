// Prompt Templates — saved composer prompts the user can recall by
// chord (Cmd+Shift+T), via the command palette, or via the slash
// autocomplete dropdown alongside skills.
//
// A template captures a reusable prompt body that may contain
// `{variable}` placeholders parsed out of the body string. On
// "insert" the modal substitutes user-supplied values via `render()`
// and the chat composer page wires the rendered text into its
// textarea (same pipeline as the slash-pick handler).
//
// Persistence: a single JSON array under localStorage key
// `ironclaw-templates`. Capped at MAX_TEMPLATES (50) — older entries
// roll off in least-recently-created order so the persisted blob
// stays bounded. A first-run seed (`maybeSeedSamples`) plants three
// useful starter prompts so the empty-state isn't a blank wall.
//
// Like the other layout-level rune stores (`presets`, `pins`,
// `slashUsage`, `threadRename`), `init()` is idempotent and called
// once from the root layout's `onMount` so the modal/palette/slash
// autocomplete render against already-hydrated state.

// ---- types ---------------------------------------------------------------

export interface PromptTemplate {
  /** UUID-ish id. Stable across renames; used as the keyed-each key. */
  id: string;
  /** User-visible label. Trimmed to 80 chars on save/update; falls
   *  back to "Untitled template" when empty. */
  name: string;
  /** The prompt body. May contain `{variable}` placeholders that
   *  `render()` substitutes at insertion time. */
  body: string;
  /** Variable names extracted from the body via `parseVariables`.
   *  Always re-derived on add/update so we don't drift from the
   *  body — the field is convenient for the modal so it doesn't
   *  have to re-parse on every render. */
  variables: string[];
  /** ISO timestamp of creation. Used for least-recently-created
   *  rollover when the cap kicks in. */
  createdAt: string;
  /** ISO timestamp of the most recent insertion. Surfaced as a
   *  relative-time label in the modal so the user can scan recency. */
  lastUsedAt?: string;
  /** Total insertions across the lifetime of the template. Surfaced
   *  in the modal so frequently-used templates float to the top of
   *  the list visually. */
  useCount: number;
}

// ---- constants -----------------------------------------------------------

const TEMPLATES_LS_KEY = 'ironclaw-templates';
const SEED_LS_KEY = 'ironclaw-templates-seeded';

/** Hard cap on the number of templates retained. Bounds the persisted
 *  blob size — entries beyond the cap are dropped on `add()` in
 *  least-recently-created order. */
export const MAX_TEMPLATES = 50;

/** Match `{variable_name}` placeholders. We accept `\w+` (letters,
 *  digits, underscore) so users can pick descriptive names without
 *  worrying about escaping. Duplicates inside one body collapse to a
 *  single variable entry — the modal renders one input per unique
 *  name and `render()` substitutes every occurrence. */
const VARIABLE_RX = /\{(\w+)\}/g;

// ---- helpers -------------------------------------------------------------

/**
 * Extract the ordered set of variable names referenced by a body
 * string. Returns names in first-occurrence order so the modal can
 * render inputs in the order the user wrote them — which matches
 * intent better than alphabetical.
 */
export function parseVariables(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // `matchAll` returns a global iterator; we don't need to reset
  // VARIABLE_RX.lastIndex because we're not using `.exec` directly.
  for (const match of body.matchAll(VARIABLE_RX)) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Generate a stable opaque id. Prefers `crypto.randomUUID()` when
 * available (modern browsers + Tauri's webview), falls back to a
 * Math.random-seeded hex string so the store still works in the rare
 * runtime that doesn't expose crypto (older jsdom, certain SSR
 * fallbacks). Mirrors `presets.svelte.ts`'s helper exactly.
 */
function makeId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the seeded fallback.
  }
  return 't_' + Math.random().toString(16).slice(2, 10) + '_' + Date.now().toString(36);
}

/**
 * Defensive parse of an unknown JSON blob into a typed template list.
 * Drops malformed rows rather than throwing so a single corrupt entry
 * doesn't take down the whole list — same defensive shape as the
 * presets store.
 */
function coerceTemplates(raw: unknown): PromptTemplate[] {
  if (!Array.isArray(raw)) return [];
  const out: PromptTemplate[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' && e.id ? e.id : null;
    const name = typeof e.name === 'string' ? e.name : null;
    const body = typeof e.body === 'string' ? e.body : null;
    const createdAt = typeof e.createdAt === 'string' ? e.createdAt : null;
    if (!id || name === null || body === null || !createdAt) continue;
    // Always re-derive `variables` from the persisted body — a hand-
    // edited file with a stale list is the most plausible drift mode.
    const variables = parseVariables(body);
    const useCount =
      typeof e.useCount === 'number' && Number.isFinite(e.useCount) && e.useCount >= 0
        ? Math.floor(e.useCount)
        : 0;
    const tpl: PromptTemplate = {
      id,
      name,
      body,
      variables,
      createdAt,
      useCount
    };
    if (typeof e.lastUsedAt === 'string' && !Number.isNaN(Date.parse(e.lastUsedAt))) {
      tpl.lastUsedAt = e.lastUsedAt;
    }
    out.push(tpl);
  }
  return out;
}

// ---- sample seed --------------------------------------------------------

/**
 * Starter templates planted on the very first hydrate of an empty
 * store. The seed flag is persisted under `SEED_LS_KEY` so a user
 * who deletes every seed doesn't see them respawn on next launch.
 * Bodies match the spec verbatim — variables follow the
 * `{lowercase_underscore}` convention.
 */
const SAMPLE_TEMPLATES: Array<Pick<PromptTemplate, 'name' | 'body'>> = [
  {
    name: 'Code review',
    body: 'Review this code for bugs, style issues, and potential improvements:\n\n```{language}\n{code}\n```'
  },
  {
    name: 'Summarize',
    body: 'Summarize the following in 3-5 bullet points:\n\n{content}'
  },
  {
    name: 'Explain',
    body: 'Explain {topic} as if to someone new to it. Include 2-3 examples.'
  },
  {
    name: 'Brainstorm',
    body: 'Generate 10 ideas for {topic}. Be creative.'
  }
];

// ---- store ---------------------------------------------------------------

class TemplateStore {
  /** Ordered list, newest-first. Replaced on every mutation so Svelte
   *  reactivity picks up the change. Hydrated once via `init()`. */
  templates = $state<PromptTemplate[]>([]);

  private hydrated = false;

  /**
   * Hydrate from localStorage. Idempotent — safe to call multiple
   * times. Wired from the root layout's `onMount` so the first render
   * of the templates modal sees the saved list. On a brand-new
   * install (empty list + no seed marker) plants the sample
   * templates so the empty state isn't a blank wall.
   */
  init(): void {
    if (this.hydrated || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(TEMPLATES_LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        this.templates = coerceTemplates(parsed);
      }
    } catch {
      // Corrupt JSON or unavailable storage — fall back to empty state.
    }
    this.hydrated = true;
    this.maybeSeedSamples();
  }

  /**
   * First-run seed. Runs once per browser profile: when the store is
   * empty AND the seed flag is unset, plants the SAMPLE_TEMPLATES
   * and marks the flag. A user who deletes every sample on first
   * launch doesn't see them respawn because the flag survives the
   * deletion. The seed itself goes through `add()` so the cap +
   * variables parsing pipeline is exercised.
   */
  private maybeSeedSamples(): void {
    if (typeof window === 'undefined') return;
    if (this.templates.length > 0) return;
    try {
      if (window.localStorage.getItem(SEED_LS_KEY) === 'true') return;
    } catch {
      // If we can't read the seed flag, err on the side of seeding —
      // the user gets the starter list, which is the friendlier
      // failure mode than a permanent blank state.
    }
    for (const sample of SAMPLE_TEMPLATES) {
      this.add(sample.name, sample.body);
    }
    try {
      window.localStorage.setItem(SEED_LS_KEY, 'true');
    } catch {
      // Non-fatal — worst case we'll re-seed on next launch, but only
      // if the user deletes every template AND the flag never
      // persists. Mild duplication beats a permanent blank state.
    }
  }

  /**
   * Create a new template. Trims `name` to 80 chars and falls back to
   * "Untitled template" when empty; `body` is taken as-is (allowing
   * intentional leading/trailing whitespace — the user controls the
   * exact prompt). Persists immediately and returns the new template
   * so the caller can route on it (e.g. the modal scrolls the new
   * row into view).
   *
   * Cap behavior: when the list is at MAX_TEMPLATES we drop the
   * oldest (by `createdAt`) entry. The new entry is always inserted
   * at the front of the list to match the newest-first display order.
   */
  add(name: string, body: string): PromptTemplate {
    const trimmedName = (name ?? '').trim().slice(0, 80) || 'Untitled template';
    const template: PromptTemplate = {
      id: makeId(),
      name: trimmedName,
      body: body ?? '',
      variables: parseVariables(body ?? ''),
      createdAt: new Date().toISOString(),
      useCount: 0
    };
    // Newest-first ordering so the modal renders top-down. When the
    // cap is reached we drop the LAST entry (oldest by createdAt
    // since the list is sorted newest-first by insertion).
    let next = [template, ...this.templates];
    if (next.length > MAX_TEMPLATES) next = next.slice(0, MAX_TEMPLATES);
    this.templates = next;
    this.persist();
    return template;
  }

  /**
   * Mutate fields of an existing template. Trims `name` and re-derives
   * `variables` whenever the body changes so consumers never see a
   * stale variable list. Patch fields that aren't supplied are left
   * intact. No-op when the id isn't in the list.
   */
  update(id: string, patch: Partial<PromptTemplate>): void {
    const idx = this.templates.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const current = this.templates[idx];
    const next: PromptTemplate = { ...current };
    if (patch.name !== undefined) {
      next.name = (patch.name ?? '').trim().slice(0, 80) || 'Untitled template';
    }
    if (patch.body !== undefined) {
      next.body = patch.body;
      // Always re-derive variables from the new body so the list
      // can't drift.
      next.variables = parseVariables(patch.body);
    }
    if (patch.useCount !== undefined && Number.isFinite(patch.useCount)) {
      next.useCount = Math.max(0, Math.floor(patch.useCount));
    }
    if (patch.lastUsedAt !== undefined) {
      next.lastUsedAt = patch.lastUsedAt;
    }
    // No-op when nothing actually changed — saves a rerender.
    if (
      next.name === current.name &&
      next.body === current.body &&
      next.useCount === current.useCount &&
      next.lastUsedAt === current.lastUsedAt
    ) {
      return;
    }
    const out = [...this.templates];
    out[idx] = next;
    this.templates = out;
    this.persist();
  }

  /** Drop a template. No-op when id isn't in the list. */
  delete(id: string): void {
    const idx = this.templates.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const next = [...this.templates];
    next.splice(idx, 1);
    this.templates = next;
    this.persist();
  }

  /**
   * Bump `useCount` and `lastUsedAt` for `id`. Called from the
   * chat composer / slash autocomplete on a successful insertion.
   * No-op when the id isn't in the list (template was deleted
   * between modal open and insert, which is rare but defensible).
   */
  recordUse(id: string): void {
    const idx = this.templates.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.update(id, {
      useCount: this.templates[idx].useCount + 1,
      lastUsedAt: new Date().toISOString()
    });
  }

  /**
   * Substitute `{variable}` placeholders with user-supplied values.
   * Unknown variables (in the body but missing from `values`) are
   * left as-is so the user sees what they need to fill in rather
   * than a silently empty span. The substitution is a single pass —
   * substituted text containing `{x}` won't trigger a second
   * substitution, which avoids surprise behavior when a value
   * legitimately contains curly braces.
   */
  render(template: PromptTemplate, values: Record<string, string>): string {
    return template.body.replace(VARIABLE_RX, (match, name: string) => {
      if (Object.prototype.hasOwnProperty.call(values, name)) {
        return values[name] ?? '';
      }
      return match;
    });
  }

  /** Persist the full list. Best-effort — quota / private-mode
   *  failures are non-fatal (the in-memory list still works, the
   *  next mutation re-attempts). Mirrors `presets.persist()`. */
  private persist(): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(TEMPLATES_LS_KEY, JSON.stringify(this.templates));
    } catch {
      // Storage may be full or disabled — non-fatal.
    }
  }
}

/** Global singleton — import this anywhere. */
export const templates = new TemplateStore();

// ---- modal-visibility singleton ------------------------------------------

/**
 * Rune singleton that tracks the Templates modal visibility. Same
 * shape as `aboutStore` / `quickCapture` / `presetsModal` so the
 * layout-level shortcut and the palette action can wire it identically.
 *
 * `openForTemplate` carries an optional id hint so a per-template
 * palette action ("Template: Code review") can pre-route the modal
 * to a specific template's insert flow — the modal consults this on
 * open and resets to null after consuming.
 */
class TemplatesModalStore {
  open = $state<boolean>(false);
  /** When set on open, the modal pre-routes to the insert flow for
   *  this template id. Consumed once per open. */
  openForTemplate = $state<string | null>(null);

  show(templateId: string | null = null): void {
    this.openForTemplate = templateId;
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.openForTemplate = null;
  }

  toggle(templateId: string | null = null): void {
    if (this.open) {
      this.close();
    } else {
      this.show(templateId);
    }
  }
}

export const templatesModal = new TemplatesModalStore();

// ---- composer-insertion bus ---------------------------------------------

export interface ComposerInsertMeta {
  title?: string;
  source?: string;
  mode?: 'approval' | 'dry-run';
  autorun?: boolean;
}

/**
 * One-shot bus the templates modal uses to push rendered text into
 * the chat composer. The chat page (`src/routes/+page.svelte`)
 * subscribes via `$effect` and writes the payload into its textarea
 * the next time it mounts (cross-route navigation) or immediately
 * (same-route insertion).
 *
 * Why a bus and not the URL `?prefill=` param: the prefill route is
 * referenced elsewhere but isn't actually consumed by the chat page
 * today; layering a fresh path on top of that would be an ambient
 * trap. The bus is a deterministic one-shot — the chat page reads
 * the payload, calls `consume()` to clear it, and the next read
 * sees null. Cross-window propagation isn't needed (Tauri webview
 * is single-window for the chat surface).
 */
class ComposerInsertBus {
  /** Pending text to splice into the composer. The chat page reads
   *  this in its mount + `$effect` paths and consumes it after
   *  applying. */
  pending = $state<string | null>(null);
  /** Optional template id so the chat page can call
   *  `templates.recordUse()` on consumption. Cleared together with
   *  the pending text. */
  pendingTemplateId = $state<string | null>(null);
  /** Optional source metadata for mission/template launches. Existing
   *  consumers can ignore it; it drains with the text payload. */
  pendingMeta = $state<ComposerInsertMeta | null>(null);

  /** Push rendered text into the bus. The chat page will pick it up
   *  on its next mount/$effect cycle. */
  push(
    text: string,
    templateId: string | null = null,
    meta: ComposerInsertMeta | null = null
  ): void {
    this.pending = text;
    this.pendingTemplateId = templateId;
    this.pendingMeta = meta;
  }

  /** Drain the bus, returning the pending payload (or null when
   *  empty). Always clears both fields atomically so a second read
   *  returns null. */
  consume(): { text: string; templateId: string | null; meta?: ComposerInsertMeta } | null {
    const text = this.pending;
    const templateId = this.pendingTemplateId;
    const meta = this.pendingMeta;
    if (text === null) return null;
    this.pending = null;
    this.pendingTemplateId = null;
    this.pendingMeta = null;
    return meta ? { text, templateId, meta } : { text, templateId };
  }
}

export const composerInsert = new ComposerInsertBus();
