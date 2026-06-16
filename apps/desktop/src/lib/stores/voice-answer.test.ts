import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/tts', () => ({
  speak: vi.fn(async () => undefined),
  stopSpeaking: vi.fn(async () => undefined)
}));

function installLocalStorageShim(): void {
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

import { voiceAnswer, stripMarkdownForSpeech } from './voice-answer.svelte';
import * as tts from '$lib/utils/tts';

beforeEach(() => {
  installLocalStorageShim();
  voiceAnswer.setEnabled(false);
  vi.clearAllMocks();
});

afterEach(() => {
  voiceAnswer.setEnabled(false);
});

describe('voiceAnswer store', () => {
  it('starts disabled when nothing is persisted', () => {
    expect(voiceAnswer.enabled).toBe(false);
  });

  it('toggle flips and persists', () => {
    voiceAnswer.toggle();
    expect(voiceAnswer.enabled).toBe(true);
    expect(localStorage.getItem('ironclaw-voice-answer-enabled')).toBe('1');
    voiceAnswer.toggle();
    expect(voiceAnswer.enabled).toBe(false);
    expect(localStorage.getItem('ironclaw-voice-answer-enabled')).toBe('0');
  });

  it('speakIfEnabled no-ops when disabled', async () => {
    voiceAnswer.setEnabled(false);
    await voiceAnswer.speakIfEnabled('hello');
    expect(tts.speak).not.toHaveBeenCalled();
  });

  it('speakIfEnabled forwards to tts.speak when enabled', async () => {
    voiceAnswer.setEnabled(true);
    await voiceAnswer.speakIfEnabled('hello world');
    expect(tts.speak).toHaveBeenCalledOnce();
    expect(vi.mocked(tts.speak).mock.calls[0][0]).toBe('hello world');
  });

  it('speakIfEnabled skips empty + whitespace-only input', async () => {
    voiceAnswer.setEnabled(true);
    await voiceAnswer.speakIfEnabled('');
    await voiceAnswer.speakIfEnabled('   \n  ');
    expect(tts.speak).not.toHaveBeenCalled();
  });

  it('setEnabled(false) while speaking calls stop', async () => {
    voiceAnswer.setEnabled(true);
    await voiceAnswer.speakIfEnabled('a sentence');
    voiceAnswer.setEnabled(false);
    expect(tts.stopSpeaking).toHaveBeenCalled();
  });

  it('stop() resets the speaking flag', async () => {
    voiceAnswer.setEnabled(true);
    await voiceAnswer.speakIfEnabled('hi');
    await voiceAnswer.stop();
    expect(voiceAnswer.speaking).toBe(false);
  });
});

describe('stripMarkdownForSpeech', () => {
  it('drops fenced code blocks', () => {
    const out = stripMarkdownForSpeech('Look at this:\n```js\nconst x = 1;\n```\nDone.');
    expect(out).toContain('code block');
    expect(out).not.toContain('const x');
  });

  it('keeps inline code text without backticks', () => {
    expect(stripMarkdownForSpeech('Use `foo()` to do it.')).toBe('Use foo() to do it.');
  });

  it('drops heading hashes', () => {
    expect(stripMarkdownForSpeech('# Title\nbody')).toBe('Title\nbody');
  });

  it('strips bold + italic markers', () => {
    expect(stripMarkdownForSpeech('this is **bold** and *italic*.')).toBe(
      'this is bold and italic.'
    );
  });

  it('keeps link text, drops URL', () => {
    expect(stripMarkdownForSpeech('Click [here](https://example.com) please.')).toBe(
      'Click here please.'
    );
  });

  it('truncates very long content', () => {
    const huge = 'a'.repeat(2000);
    const out = stripMarkdownForSpeech(huge);
    expect(out.length).toBeLessThanOrEqual(1600);
    expect(out).toContain('truncated');
  });
});
