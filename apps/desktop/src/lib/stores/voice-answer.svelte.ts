// Voice answer mode — auto-speak assistant responses as they complete.
//
// Two states the user toggles between:
//   - off: nothing speaks
//   - on:  every assistant message that arrives gets piped through
//          macOS's `say` binary via the Tauri TTS bridge (R50)
//
// Per-window setting; persisted to localStorage so opening a fresh
// thread or restarting the app preserves the toggle. The actual
// speaking happens when the chat surface calls `voiceAnswer.speakIfEnabled(text)`
// after each completed assistant turn. The store also tracks "currently
// speaking" so the UI can show a stop button + the bar can pulse.

import { speak as ttsSpeak, stopSpeaking as ttsStop } from '$lib/utils/tts';

const STORAGE_KEY = 'ironclaw-voice-answer-enabled';

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readPersisted(): boolean {
  if (!isBrowser()) return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

class VoiceAnswerStore {
  /** True when the user has voice-answer mode armed. */
  enabled = $state<boolean>(readPersisted());
  /** True between speak() being called and the OS finishing/killing the
   *  spoken audio. The latter is fire-and-forget so we toggle off when
   *  the user manually stops; otherwise it stays on for the duration. */
  speaking = $state<boolean>(false);
  /** Last error surfaced from the TTS bridge — the UI shows a small
   *  inline hint when set, then clears on the next successful speak. */
  error = $state<string | null>(null);

  toggle(): void {
    this.enabled = !this.enabled;
    this.persist();
    if (!this.enabled) {
      // Turning off mid-speech — kill the current utterance.
      void this.stop();
    }
  }

  setEnabled(next: boolean): void {
    if (this.enabled === next) return;
    this.enabled = next;
    this.persist();
    if (!next) void this.stop();
  }

  /**
   * Speak the given text only if voice-answer mode is enabled. No-op
   * when disabled, when text is empty, or when running outside Tauri.
   * Truncates very long text to a reasonable spoken length so the
   * user doesn't get stuck listening to a 5-minute monologue.
   */
  async speakIfEnabled(text: string): Promise<void> {
    if (!this.enabled) return;
    const cleaned = stripMarkdownForSpeech(text);
    if (!cleaned) return;
    this.error = null;
    this.speaking = true;
    try {
      await ttsSpeak(cleaned);
    } catch (err) {
      this.error = (err as Error).message;
      this.speaking = false;
    }
    // We don't await the OS playback — `say` returns immediately after
    // spawn. The "speaking" flag stays true until the user toggles off,
    // navigates to another thread (caller resets), or hits stop(). A
    // future enhancement: pipe an "utterance finished" event through a
    // Tauri channel and auto-clear this.
  }

  async stop(): Promise<void> {
    this.speaking = false;
    await ttsStop();
  }

  private persist(): void {
    if (!isBrowser()) return;
    try {
      localStorage.setItem(STORAGE_KEY, this.enabled ? '1' : '0');
    } catch {
      // quota / private mode — accept the loss; the toggle still works
      // in-memory for the current session.
    }
  }
}

/**
 * Strip markdown formatting so the TTS pipeline doesn't read out
 * literal asterisks, backticks, table pipes, etc. Conservative: we
 * remove the chrome, keep the words. Anything that doesn't have an
 * obvious spoken equivalent (link URLs, image embeds) gets dropped.
 *
 * Exposed for unit tests; not part of the public store API.
 */
export function stripMarkdownForSpeech(text: string): string {
  if (!text) return '';
  let s = text;
  // Code fences — drop their contents wholesale. A spoken JSON blob
  // is gibberish; the user is better served by knowing one is there.
  s = s.replace(/```[\s\S]*?```/g, ' (code block) ');
  // Inline code — drop backticks but keep the word.
  s = s.replace(/`([^`]+)`/g, '$1');
  // Headings — drop leading #s.
  s = s.replace(/^#{1,6}\s+/gm, '');
  // Bold / italic — drop the markers.
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/(\*|_)(.*?)\1/g, '$2');
  // Strikethrough.
  s = s.replace(/~~(.*?)~~/g, '$1');
  // Links — keep text, drop the URL.
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Images — replace with a brief mention.
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, ' (image: $1) ');
  // Blockquote markers.
  s = s.replace(/^>\s?/gm, '');
  // Horizontal rules.
  s = s.replace(/^-{3,}|^_{3,}|^\*{3,}$/gm, '');
  // Tables — the visual structure doesn't speak well; collapse to a
  // mention plus the cell contents.
  s = s.replace(/\|/g, ' ');
  // Bullet markers.
  s = s.replace(/^[\s]*[-*+]\s+/gm, '');
  // Numbered lists — keep the number for pacing.
  s = s.replace(/^[\s]*(\d+)\.\s+/gm, '$1. ');
  // Cap the spoken length so a 5000-token answer doesn't lock the
  // speaker for 10 minutes. 1500 chars is roughly 30 seconds of
  // speech at the default rate.
  if (s.length > 1500) {
    s = s.slice(0, 1500) + '… [truncated for speech]';
  }
  return s.trim();
}

export const voiceAnswer = new VoiceAnswerStore();
