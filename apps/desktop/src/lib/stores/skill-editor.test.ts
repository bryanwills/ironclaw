// Tests for the inline skill-editor store (R65 — Lane B8).
//
// The store is a `$state`-driven singleton with localStorage stash for
// the no-endpoint fallback path. We exercise the full public API:
// open/close lifecycle, dirty tracking, load() hydration, save() with
// both the present-endpoint and absent-endpoint paths, and the dirty-
// hide confirm gate.
//
// Mock surface:
//   - `connection.svelte` is mocked at the module level; each test
//     re-assigns `connection.client` to swap between "no client",
//     "client without updateSkillScript", and "client with a mocked
//     updateSkillScript".
//   - `confirmDialog.ask` is mocked for the dirty-hide cases.
//   - `localStorage` is shimmed per pins.test.ts's pattern because the
//     jsdom path Vitest 4 picks here is missing standard Storage
//     methods.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./connection.svelte', () => ({
  connection: { client: null as unknown }
}));

vi.mock('./confirm.svelte', () => ({
  confirmDialog: {
    ask: vi.fn(async () => true)
  }
}));

import type { Skill } from '$lib/api/types';
import { confirmDialog } from './confirm.svelte';
import { connection } from './connection.svelte';
import { skillEditor } from './skill-editor.svelte';

const STASH_KEY_PREFIX = 'ironclaw-skill-editor-stash:';

function installLocalStorageShim() {
  const store = new Map<string, string>();
  const shim = {
    get length() {
      return store.size;
    },
    key(i: number) {
      return Array.from(store.keys())[i] ?? null;
    },
    getItem(k: string) {
      return store.has(k) ? (store.get(k) as string) : null;
    },
    setItem(k: string, v: string) {
      store.set(String(k), String(v));
    },
    removeItem(k: string) {
      store.delete(k);
    },
    clear() {
      store.clear();
    }
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: shim });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: shim });
  }
}

function makeSkill(overrides: Partial<Skill & { script?: string }> = {}): Skill {
  return {
    name: 'echo',
    description: 'Test skill',
    version: '1.0.0',
    installed: true,
    ...overrides
  } as Skill;
}

function resetEditor() {
  // The store is a singleton; reset its observable fields directly so
  // a previous case's state doesn't bleed in.
  skillEditor.open = false;
  skillEditor.skill = null;
  skillEditor.draft = '';
  skillEditor.error = null;
  skillEditor.saving = false;
}

describe('skillEditor store', () => {
  beforeEach(() => {
    installLocalStorageShim();
    resetEditor();
    vi.mocked(confirmDialog.ask).mockResolvedValue(true);
    (connection as { client: unknown }).client = null;
  });

  afterEach(() => {
    resetEditor();
  });

  it('show() opens with no skill leaves draft empty + open true', () => {
    skillEditor.show();
    expect(skillEditor.open).toBe(true);
    expect(skillEditor.skill).toBeNull();
    expect(skillEditor.draft).toBe('');
    expect(skillEditor.dirty).toBe(false);
  });

  it('show(skill) loads draft from skill.script', () => {
    const skill = makeSkill({ name: 'translator', script: 'print("hola")' });
    skillEditor.show(skill);
    expect(skillEditor.open).toBe(true);
    // `$state`-wrapped objects come back as proxies, so identity (`.toBe`)
    // breaks; deep-equality on the structural shape is the right check.
    expect(skillEditor.skill).toEqual(skill);
    expect(skillEditor.draft).toBe('print("hola")');
    expect(skillEditor.dirty).toBe(false);
  });

  it('dirty is true when draft differs from skill.script', () => {
    const skill = makeSkill({ script: 'a' });
    skillEditor.load(skill);
    expect(skillEditor.dirty).toBe(false);
    skillEditor.draft = 'b';
    expect(skillEditor.dirty).toBe(true);
  });

  it('dirty is false after load() with matching content', () => {
    const skill = makeSkill({ script: 'pristine' });
    skillEditor.load(skill);
    expect(skillEditor.draft).toBe('pristine');
    expect(skillEditor.dirty).toBe(false);
  });

  it('hide() while dirty + confirm-returns-false leaves state intact', async () => {
    const skill = makeSkill({ script: 'orig' });
    skillEditor.show(skill);
    skillEditor.draft = 'modified';
    expect(skillEditor.dirty).toBe(true);

    // Decline the discard prompt.
    vi.mocked(confirmDialog.ask).mockResolvedValueOnce(false);

    await skillEditor.hide();
    expect(skillEditor.open).toBe(true);
    expect(skillEditor.skill).toEqual(skill);
    expect(skillEditor.draft).toBe('modified');
    expect(confirmDialog.ask).toHaveBeenCalledWith({
      title: 'Discard changes to echo?',
      body: 'Discards the unsaved skill source.',
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      tone: 'danger'
    });
  });

  it('hide() not dirty clears all state', async () => {
    const skill = makeSkill({ script: 'pristine' });
    skillEditor.show(skill);
    expect(skillEditor.open).toBe(true);
    expect(skillEditor.dirty).toBe(false);

    await skillEditor.hide();
    expect(skillEditor.open).toBe(false);
    expect(skillEditor.skill).toBeNull();
    expect(skillEditor.draft).toBe('');
    expect(skillEditor.error).toBeNull();
    expect(skillEditor.saving).toBe(false);
  });

  it('save() calls the client method when present', async () => {
    const updateSkillScript = vi.fn(async (_name: string, _script: string) => undefined);
    (connection as { client: unknown }).client = { updateSkillScript };

    const skill = makeSkill({ name: 'doc-writer', script: 'old' });
    skillEditor.show(skill);
    skillEditor.draft = 'new';

    await skillEditor.save();

    expect(updateSkillScript).toHaveBeenCalledTimes(1);
    expect(updateSkillScript).toHaveBeenCalledWith('doc-writer', 'new');
    expect(skillEditor.saving).toBe(false);
    expect(skillEditor.error).toBeNull();
    // dirty should reset because the skill's script was rolled forward.
    expect(skillEditor.dirty).toBe(false);
  });

  it('save() stashes to localStorage when gateway throws', async () => {
    // Client present but missing the updateSkillScript method — same
    // observable failure as the no-endpoint path.
    (connection as { client: unknown }).client = {};

    const skill = makeSkill({ name: 'stasher', script: 'before' });
    skillEditor.show(skill);
    skillEditor.draft = 'after';

    await expect(skillEditor.save()).rejects.toThrow(/Gateway does not support skill editing/);

    const stash = localStorage.getItem(`${STASH_KEY_PREFIX}stasher`);
    expect(stash).toBe('after');
    expect(skillEditor.error).toMatch(/Gateway does not support skill editing/);
    expect(skillEditor.saving).toBe(false);
  });

  it('save() with no skill loaded sets error and is a no-op', async () => {
    skillEditor.show();
    await skillEditor.save();
    expect(skillEditor.error).toMatch(/No skill loaded/);
  });

  it('load() prefers a localStorage stash over the wire script', () => {
    // Simulate a prior failed save that landed in the stash.
    localStorage.setItem(`${STASH_KEY_PREFIX}cached`, 'stashed-draft');
    const skill = makeSkill({ name: 'cached', script: 'wire-script' });
    skillEditor.load(skill);
    expect(skillEditor.draft).toBe('stashed-draft');
    // Still considered dirty vs the wire skill — user has unsaved
    // edits relative to what the gateway last shipped.
    expect(skillEditor.dirty).toBe(true);
  });
});
