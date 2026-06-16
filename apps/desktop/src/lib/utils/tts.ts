// Native macOS TTS wrapper. Calls into the Tauri `say_text` /
// `stop_tts` / `list_voices` commands. No-ops gracefully when not
// running inside Tauri (browser dev, vitest).

import { invoke } from '@tauri-apps/api/core';
import { inTauri } from './runtime';

export interface SpeakOptions {
  voice?: string;
  rate?: number;
}

export async function speak(text: string, options: SpeakOptions = {}): Promise<void> {
  if (!inTauri()) return;
  if (!text.trim()) return;
  try {
    await invoke('say_text', {
      text,
      voice: options.voice ?? null,
      rate: options.rate ?? null
    });
  } catch (err) {
    // Don't spam toasts here - the caller decides whether to surface.
    console.warn('[tts] speak failed', err);
    throw err;
  }
}

export async function stopSpeaking(): Promise<void> {
  if (!inTauri()) return;
  try {
    await invoke('stop_tts');
  } catch (err) {
    console.warn('[tts] stop failed', err);
  }
}

export async function listVoices(): Promise<string[]> {
  if (!inTauri()) return [];
  try {
    return (await invoke('list_voices')) as string[];
  } catch (err) {
    console.warn('[tts] list_voices failed', err);
    return [];
  }
}
