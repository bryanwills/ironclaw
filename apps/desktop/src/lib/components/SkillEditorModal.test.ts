// Render smoke tests for SkillEditorModal.svelte (R65 — inline skill
// editor). A thin presentation layer over the `skillEditor` singleton: we
// drive its public $state fields (open/skill/draft/saving/error) directly,
// derive `dirty` via draft-vs-script, and spy the `hide`/`save` methods
// (never vi.mock the .svelte.ts under test). The Icon child is mocked to a
// no-op so the test stays hermetic.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('./Icon.svelte', () => ({ default: () => null }));

import SkillEditorModal from './SkillEditorModal.svelte';
import { skillEditor } from '$lib/stores/skill-editor.svelte';
import type { Skill } from '$lib/api/types';

function skill(over: Record<string, unknown> = {}): Skill {
  return {
    name: 'MySkill',
    description: 'A test skill',
    script: 'old source',
    ...over
  } as unknown as Skill;
}

const buttons = (c: HTMLElement) => [...c.querySelectorAll('button')];
const byText = (c: HTMLElement, text: string) =>
  buttons(c).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const title = (c: HTMLElement) => c.querySelector('#skill-editor-title');

beforeEach(() => {
  vi.spyOn(skillEditor, 'hide').mockResolvedValue(undefined);
  vi.spyOn(skillEditor, 'save').mockResolvedValue(undefined);
  // Reset the shared singleton to an open, empty editor.
  skillEditor.open = true;
  skillEditor.skill = null;
  skillEditor.draft = '';
  skillEditor.saving = false;
  skillEditor.error = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  skillEditor.open = false;
});

describe('SkillEditorModal component', () => {
  it('renders nothing when the store is closed', async () => {
    skillEditor.open = false;
    const { container } = render(SkillEditorModal);
    await tick();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders the dialog with a generic title when no skill is loaded', async () => {
    const { container } = render(SkillEditorModal);
    await tick();
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(title(container)?.textContent).toContain('Edit skill');
    expect(title(container)?.textContent).not.toContain('—');
  });

  it('includes the skill name and description when a skill is loaded', async () => {
    skillEditor.skill = skill();
    skillEditor.draft = 'old source';
    const { container } = render(SkillEditorModal);
    await tick();
    expect(title(container)?.textContent).toContain('Edit skill — MySkill');
    expect(container.textContent).toContain('A test skill');
  });

  it('shows the dirty "*" marker when the draft differs from the script', async () => {
    skillEditor.skill = skill({ script: 'old' });
    skillEditor.draft = 'new';
    const { container } = render(SkillEditorModal);
    await tick();
    expect(skillEditor.dirty).toBe(true);
    expect(title(container)?.textContent).toContain('*');
  });

  it('omits the "*" marker when the draft matches the script', async () => {
    skillEditor.skill = skill({ script: 'same' });
    skillEditor.draft = 'same';
    const { container } = render(SkillEditorModal);
    await tick();
    expect(skillEditor.dirty).toBe(false);
    expect(title(container)?.textContent).not.toContain('*');
  });

  it('binds the textarea to the store draft', async () => {
    skillEditor.skill = skill();
    skillEditor.draft = 'console.log(1)';
    const { container } = render(SkillEditorModal);
    await tick();
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('console.log(1)');
  });

  it('renders the error banner only when an error is set', async () => {
    const a = render(SkillEditorModal);
    await tick();
    expect(a.container.querySelector('[role="alert"]')).toBeNull();

    skillEditor.error = 'Gateway does not support skill editing';
    const b = render(SkillEditorModal);
    await tick();
    const alert = b.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Gateway does not support skill editing');
  });

  it('disables Save and shows the spinner label while saving', async () => {
    skillEditor.saving = true;
    const { container } = render(SkillEditorModal);
    await tick();
    expect(container.textContent).toContain('Saving…');
    const save = byText(container, 'Saving…');
    expect(save.disabled).toBe(true);
  });

  it('shows an enabled Save button when not saving', async () => {
    const { container } = render(SkillEditorModal);
    await tick();
    const save = byText(container, 'Save');
    expect(save).toBeTruthy();
    expect(save.disabled).toBe(false);
  });

  it('clicking Save calls skillEditor.save()', async () => {
    skillEditor.skill = skill();
    skillEditor.draft = 'changed';
    const { container } = render(SkillEditorModal);
    await tick();
    await act(async () => {
      await fireEvent.click(byText(container, 'Save'));
    });
    expect(skillEditor.save).toHaveBeenCalledTimes(1);
  });

  it('clicking Cancel calls skillEditor.hide()', async () => {
    const { container } = render(SkillEditorModal);
    await tick();
    await act(async () => {
      await fireEvent.click(byText(container, 'Cancel'));
    });
    expect(skillEditor.hide).toHaveBeenCalledTimes(1);
  });

  it('clicking the header close button calls skillEditor.hide()', async () => {
    const { container } = render(SkillEditorModal);
    await tick();
    await act(async () => {
      await fireEvent.click(container.querySelector('button[aria-label="Close"]')!);
    });
    expect(skillEditor.hide).toHaveBeenCalledTimes(1);
  });

  it('clicking the backdrop calls skillEditor.hide()', async () => {
    const { container } = render(SkillEditorModal);
    await tick();
    await act(async () => {
      await fireEvent.click(container.querySelector('[aria-label="Close skill editor"]')!);
    });
    expect(skillEditor.hide).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the modal via skillEditor.hide()', async () => {
    render(SkillEditorModal);
    await tick();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(skillEditor.hide).toHaveBeenCalledTimes(1);
  });
});
