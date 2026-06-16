// Inline skill-editor store (R65 — Lane B8).
//
// Right-click a skill tool-call output in chat → "Edit this skill…" pops
// this modal pre-filled with the skill's current source; Save hot-reloads
// the new source back into the gateway via a future
// `client.updateSkillScript(name, script)` endpoint. The trigger side of
// the chain (right-click context menu on tool output) lands in a later
// patch — this store + the modal + the Cmd+Shift+E shortcut are the
// authoring surface; the consumer wires the right-click → `show(skill)`
// call when that lane catches up.
//
// Gateway contract:
//
//  - `Skill.script` is NOT in the type today (see `src/lib/api/types.ts`),
//    because the wire only emits metadata for installed skills. We accept
//    the field at the consume site with a structural cast and default to
//    empty when the gateway didn't send one — saving against an empty
//    draft is equivalent to "use the bundled default", which is the
//    intended UX when the wire grows the field.
//  - `IronClawClient.updateSkillScript(name, script)` is also not on the
//    client yet. The store probes for it defensively and routes to a
//    localStorage stash when the gateway can't accept the write —
//    pending the server lighting up the endpoint, the user's draft
//    survives a reload and re-appears the next time they open the
//    editor on that skill (see `stashLocally` below).
//  - Hide cycle prompts on a dirty buffer (via the shared in-app
//    confirmation dialog) so the user never loses unsaved edits by an
//    accidental backdrop click / Esc.

import type { IronClawClient } from '$lib/api/ironclaw';
import type { Skill } from '$lib/api/types';
import { confirmDialog } from './confirm.svelte';
import { connection } from './connection.svelte';

/** localStorage key prefix for per-skill draft stash. Suffixed with the
 *  skill name so each skill carries its own stash. */
const STASH_KEY_PREFIX = 'ironclaw-skill-editor-stash:';

/** Pull the (optional) `script` field off a `Skill` without modifying the
 *  shared `Skill` interface. The wire may or may not surface it today. */
function readScript(skill: Skill | null): string {
  if (!skill) return '';
  return (skill as Skill & { script?: string }).script ?? '';
}

/** Per-skill localStorage key. */
function stashKey(name: string): string {
  return `${STASH_KEY_PREFIX}${name}`;
}

class SkillEditorStore {
  /** True when the modal is mounted. Toggled via `show()` / `hide()`. */
  open = $state(false);

  /** Skill the editor is currently bound to. `null` when the user opened
   *  the modal via the keyboard chord without a skill context — Save is
   *  inert in that case (no `name` to PUT to). */
  skill = $state<Skill | null>(null);

  /** Live textarea contents. Diverges from `skill.script` as the user
   *  types; reconciled on Save. */
  draft = $state('');

  /** True while a Save request is in flight. The UI disables the Save
   *  button + shows a spinner. */
  saving = $state(false);

  /** Most recent error message from Save (or load). Rendered as a red
   *  banner above the footer when non-null. Cleared on the next attempt. */
  error = $state<string | null>(null);

  /** True when `draft` differs from the skill's persisted script. Drives
   *  the dirty-confirm prompt on hide() and the "*" affordance on the
   *  modal title. Computed so the consumer never has to manually flip a
   *  flag in lockstep with typing. */
  dirty = $derived(this.draft !== readScript(this.skill));

  /**
   * Open the modal. Pass a skill to pre-fill the editor; omit to open
   * with an empty draft (used by the Cmd+Shift+E keyboard chord when
   * the user wants to fish around or hand-write a fresh script). The
   * keyboard-chord path is intentionally tolerant — it's the QA hook,
   * not the primary entry point.
   */
  show(skill?: Skill | null): void {
    this.error = null;
    if (skill) {
      this.load(skill);
    } else {
      // Keyboard-only open with no skill context.
      this.skill = null;
      this.draft = '';
    }
    this.open = true;
  }

  /**
   * Close the modal. If the draft is dirty, prompt for confirmation
   * first — declining cancels the close and leaves the editor state
   * intact (so the user can finish editing or copy the draft out).
   */
  async hide(): Promise<void> {
    if (this.dirty) {
      const label = this.skill?.name ?? 'this skill';
      const ok = await confirmDialog.ask({
        title: `Discard changes to ${label}?`,
        body: 'Discards the unsaved skill source.',
        confirmLabel: 'Discard changes',
        cancelLabel: 'Keep editing',
        tone: 'danger'
      });
      if (!ok) return;
    }
    this.open = false;
    this.skill = null;
    this.draft = '';
    this.error = null;
    this.saving = false;
  }

  /**
   * Bind the editor to a skill and rehydrate the draft. Used both
   * internally by `show(skill)` and by the right-click context-menu
   * consumer (the wired-later hook calls `load()` then `show()`).
   *
   * If a localStorage stash exists for this skill (left behind by a
   * previous Save that hit the no-endpoint fallback), prefer the stash
   * — the user's intent there was to save, and a re-open should let
   * them try again rather than silently dropping their edits.
   */
  load(skill: Skill): void {
    this.skill = skill;
    const stashed = readStash(skill.name);
    this.draft = stashed ?? readScript(skill);
    this.error = null;
  }

  /**
   * Save the current draft back to the gateway. Defensive path:
   *   1. If we don't have a bound skill, error out — Save with no name
   *      target is meaningless.
   *   2. If the client isn't ready (no token / no connection), surface
   *      that to the user via `error`.
   *   3. If the client doesn't expose `updateSkillScript`, stash the
   *      draft to localStorage and report the failure mode — the user's
   *      bytes survive a reload, and the right-click-tool-output lane
   *      can pick them up once the gateway grows the endpoint.
   */
  async save(): Promise<void> {
    if (!this.skill) {
      this.error = 'No skill loaded — nothing to save.';
      return;
    }
    const client = connection.client;
    if (!client) {
      this.error = 'Not connected to a gateway.';
      return;
    }
    this.saving = true;
    this.error = null;
    try {
      const c = client as unknown as IronClawClient & {
        updateSkillScript?: (name: string, script: string) => Promise<void>;
      };
      if (typeof c.updateSkillScript !== 'function') {
        // Gateway hasn't grown the endpoint yet. Stash locally so the
        // user's draft isn't lost, and surface the limitation.
        this.stashLocally();
        throw new Error('Gateway does not support skill editing');
      }
      await c.updateSkillScript(this.skill.name, this.draft);
      // Roll the in-memory skill's script forward so `dirty` flips back
      // to false after a successful save. The shared `Skill` type
      // doesn't carry `script` today, so we mutate via the same
      // structural cast we use everywhere else in this file.
      (this.skill as Skill & { script?: string }).script = this.draft;
      // Drop the stash — it only exists for the no-endpoint fallback. */
      clearStash(this.skill.name);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.saving = false;
    }
  }

  /**
   * Best-effort save the current draft to localStorage. Used as a
   * fallback when the gateway can't accept the write — the next
   * `load()` for this skill picks the stash up instead of the
   * (stale) wire script.
   */
  private stashLocally(): void {
    if (!this.skill) return;
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(stashKey(this.skill.name), this.draft);
    } catch {
      // Storage may be full or disabled — non-fatal. The in-memory
      // draft still lives until the user closes the modal.
    }
  }
}

/** Read a previously-stashed draft for `name`. Returns `null` when no
 *  stash exists (or storage is unavailable). */
function readStash(name: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(stashKey(name));
  } catch {
    return null;
  }
}

/** Drop the stash for a skill (called after a successful save). */
function clearStash(name: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(stashKey(name));
  } catch {
    // Non-fatal — the stash is a best-effort cushion.
  }
}

/** Global singleton — the modal mounts at the route level and the
 *  keyboard chord lives in `+layout.svelte`, so a single shared instance
 *  keeps the open-state coherent across surfaces. */
export const skillEditor = new SkillEditorStore();
