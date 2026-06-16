// Render smoke tests for VoiceAnswerBar.svelte (R51 — voice-answer status
// bar). Self-gating on voiceAnswer.enabled; shows speaking state + Stop /
// turn-off controls. We drive the real voiceAnswer singleton's $state fields
// and spy its stop()/setEnabled() methods (importing a sibling store is fine;
// only vi.mock-ing one breaks the rune transform).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/svelte';
import { tick } from 'svelte';

import VoiceAnswerBar from './VoiceAnswerBar.svelte';
import { voiceAnswer } from '$lib/stores/voice-answer.svelte';

function reset(): void {
  voiceAnswer.enabled = false;
  voiceAnswer.speaking = false;
  voiceAnswer.error = null;
}

beforeEach(() => {
  reset();
  vi.spyOn(voiceAnswer, 'stop').mockResolvedValue(undefined);
  vi.spyOn(voiceAnswer, 'setEnabled').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  reset();
});

const statusBar = (c: HTMLElement) => c.querySelector('[role="status"]');

describe('VoiceAnswerBar component', () => {
  it('renders nothing when voice-answer is disabled', async () => {
    voiceAnswer.enabled = false;
    const { container } = render(VoiceAnswerBar);
    await tick();
    expect(statusBar(container)).toBeNull();
    expect((container.textContent ?? '').trim()).toBe('');
  });

  it('enabled (idle): shows the "on" label + Stop and turn-off controls', async () => {
    voiceAnswer.enabled = true;
    const { container } = render(VoiceAnswerBar);
    await tick();
    expect(statusBar(container)?.getAttribute('aria-live')).toBe('polite');
    expect(container.textContent).toContain('Voice answer on');
    expect(container.querySelector('button[aria-label="Stop speaking"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Turn off voice answer"]')).toBeTruthy();
  });

  it('enabled (speaking): shows the speaking label', async () => {
    voiceAnswer.enabled = true;
    voiceAnswer.speaking = true;
    const { container } = render(VoiceAnswerBar);
    await tick();
    expect(container.textContent).toContain('Speaking…');
  });

  it('surfaces an error chip with the message as a title', async () => {
    voiceAnswer.enabled = true;
    voiceAnswer.error = 'tts bridge failed';
    const { container } = render(VoiceAnswerBar);
    await tick();
    const chip = [...container.querySelectorAll('span')].find((s) =>
      s.textContent?.includes('(error)')
    );
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute('title')).toBe('tts bridge failed');
  });

  it('Stop calls voiceAnswer.stop()', async () => {
    voiceAnswer.enabled = true;
    const { container } = render(VoiceAnswerBar);
    await tick();
    await act(async () => {
      await fireEvent.click(container.querySelector('button[aria-label="Stop speaking"]')!);
    });
    expect(voiceAnswer.stop).toHaveBeenCalledTimes(1);
  });

  it('turn-off calls voiceAnswer.setEnabled(false)', async () => {
    voiceAnswer.enabled = true;
    const { container } = render(VoiceAnswerBar);
    await tick();
    await act(async () => {
      await fireEvent.click(container.querySelector('button[aria-label="Turn off voice answer"]')!);
    });
    expect(voiceAnswer.setEnabled).toHaveBeenCalledWith(false);
  });
});
