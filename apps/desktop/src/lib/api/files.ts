// Filesystem-facing IPC helpers + thread-export builders.
//
// The webview never sees the filesystem-write capability directly — the
// Rust side owns the save-file dialog AND the write. JS only learns the
// path the user picked (or `null` if they cancelled), so a malicious or
// buggy frontend can't scribble outside the chosen file.
//
// Export shapes (markdown + JSON) live here too so both the chat header
// button and the Settings → Data bulk-export speak the same vocabulary.
// See [PROMPT-CONTRACT] markers below for the exact spec carried over
// from the implementation brief.
//
// Mirrors the lightweight singleton pattern used by `settings.svelte.ts`:
// runtime-detect Tauri and no-op gracefully outside it so vite dev / SSR
// builds don't crash importing this module.

import { invoke } from '@tauri-apps/api/core';
import { exportThreadHtml } from '$lib/util/html-export';
import type { Message, Thread } from './types';

/** Tauri-runtime sentinel. Matches the check in `settings.svelte.ts`. */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Show a native save-file dialog, then write `contents` to the user's
 * chosen path.
 *
 * Returns the absolute path on success, or `null` if the user cancelled
 * the dialog. Throws on filesystem failure (disk full, permission denied,
 * etc.) — callers should surface the error via `toasts.show(..., 'error')`.
 *
 * `defaultFilename` is just the name shown in the save sheet; the user
 * may freely change it (and the extension), so callers should not rely
 * on the returned path matching the suggested extension.
 */
export async function saveTextDialog(
  defaultFilename: string,
  contents: string
): Promise<string | null> {
  if (!inTauri()) {
    console.warn('saveTextDialog called outside Tauri; no-op');
    return null;
  }
  const result = await invoke<string | null>('save_text_dialog', {
    defaultFilename,
    contents
  });
  return result ?? null;
}

/**
 * Backup the active `settings.json` to a user-chosen path.
 *
 * The Rust side reads the raw bytes from AppData and writes them through —
 * tokens / OpenRouter keys are NOT included (they live in the Keychain),
 * so the resulting file is safe to email or sync across machines.
 *
 * Returns the saved path, or `null` if the user cancelled the dialog.
 * Throws on filesystem failure.
 */
export async function exportSettings(): Promise<string | null> {
  if (!inTauri()) {
    console.warn('exportSettings called outside Tauri; no-op');
    return null;
  }
  // Date formatting lives in JS (todayStamp) so we don't pull a Rust date
  // crate just to build the suggested filename. The user can override in
  // the save sheet either way.
  const defaultFilename = `ironclaw-desktop-settings-${todayStamp()}.json`;
  const result = await invoke<string | null>('export_settings_dialog', {
    defaultFilename
  });
  return result ?? null;
}

/**
 * Prompt the user to pick a settings backup file, return its raw contents.
 *
 * Validation + persistence are the caller's responsibility — see
 * `validateImportedSettings` + `importSettingsFromString` in the settings
 * store. Returns `null` if the user cancelled.
 */
export async function importSettings(): Promise<string | null> {
  if (!inTauri()) {
    console.warn('importSettings called outside Tauri; no-op');
    return null;
  }
  const result = await invoke<string | null>('open_text_dialog');
  return result ?? null;
}

// ---- Export builders ------------------------------------------------------

/** Wire shape used inside a single-thread JSON export. Matches the
 *  [PROMPT-CONTRACT] spec from the implementation brief. */
export interface ThreadExportShape {
  thread: {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
  };
  messages: Array<{
    id: string;
    role: Message['role'];
    content: string;
    created_at: string;
  }>;
  exported_at: string;
}

/** Top-level shape for the Settings → Data "Export all conversations" blob. */
export interface BulkExportShape {
  exported_at: string;
  version: 1;
  threads: ThreadExportShape[];
}

/**
 * Sanitize a thread title into a filename stem. Keeps the user's chosen
 * label readable on disk while stripping characters that would break the
 * macOS save sheet (`/`, `:`, NUL) and trimming runaway titles.
 *
 * The save sheet itself lets the user override the suggestion, so this
 * is a hint, not a hard guarantee.
 */
export function sanitizeFilenameStem(stem: string, fallback = 'conversation'): string {
  const cleaned = stem
    // Collapse OS-hostile characters to a hyphen — kept readable rather
    // than URL-encoded.
    .replace(/[\\/:*?"<>|\0\r\n\t]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : fallback;
}

/** ISO 8601 timestamp at second resolution — used in export filenames so
 *  multiple bulk exports on the same day don't collide. */
export function todayStamp(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Build the canonical single-thread JSON shape from a thread + its full
 * message history.
 */
export function buildThreadJsonShape(thread: Thread, messages: Message[]): ThreadExportShape {
  return {
    thread: {
      id: thread.id,
      title: thread.title,
      created_at: thread.created_at,
      updated_at: thread.updated_at
    },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      created_at: m.created_at
    })),
    exported_at: new Date().toISOString()
  };
}

/** Serialize the single-thread JSON shape with stable indentation. */
export function buildThreadJsonText(thread: Thread, messages: Message[]): string {
  return JSON.stringify(buildThreadJsonShape(thread, messages), null, 2);
}

/**
 * Build the markdown export for a single thread.
 *
 * [PROMPT-CONTRACT] format:
 *   # <title>
 *
 *   _Exported <ISO timestamp>_
 *
 *   ---
 *
 *   ## User · <created_at>
 *   ...
 *   ## Assistant · <created_at>
 *   ...
 *
 *   ---
 *
 * Tool calls + results render inline per assistant message as documented;
 * today the gateway doesn't persist tool turns to /api/chat/history, so
 * the heading is reserved for the future shape and we skip emitting it
 * when there are no tool rows. Code blocks inside message content are
 * passed through verbatim — they're already GFM-compatible.
 */
export function buildThreadMarkdown(thread: Thread, messages: Message[]): string {
  const lines: string[] = [];
  const title = thread.title?.trim() || 'Untitled conversation';
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`_Exported ${new Date().toISOString()}_`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const m of messages) {
    const stamp = m.created_at || '';
    switch (m.role) {
      case 'user':
        lines.push(`## User · ${stamp}`);
        lines.push('');
        lines.push(m.content);
        lines.push('');
        lines.push('---');
        lines.push('');
        break;
      case 'assistant':
        lines.push(`## Assistant · ${stamp}`);
        lines.push('');
        lines.push(m.content);
        lines.push('');
        lines.push('---');
        lines.push('');
        break;
      case 'tool':
        // The gateway doesn't currently emit tool rows in /api/chat/history,
        // but if a future version does, render them under the assistant
        // turn's heading shape from the prompt:
        //   ### Tool call · <name>
        //   `<args>`
        //   #### Result
        //   <result>
        // We only have a single content blob here, so render it as a
        // single tool block without separate args/result rows.
        lines.push(`### Tool · ${stamp}`);
        lines.push('');
        lines.push('```');
        lines.push(m.content);
        lines.push('```');
        lines.push('');
        lines.push('---');
        lines.push('');
        break;
    }
  }

  // Drop the trailing blank-line+divider to keep the file tight.
  while (lines.length > 0 && (lines.at(-1) === '' || lines.at(-1) === '---')) {
    lines.pop();
  }
  // Final newline so the file ends in a clean trailing \n.
  lines.push('');
  return lines.join('\n');
}

/**
 * Build a self-contained, dark-themed HTML transcript (R87 util). Every
 * message body is HTML-escaped by the util, so the output is safe to open
 * in any browser even if a message contains markup.
 */
export function buildThreadHtml(thread: Thread, messages: Message[]): string {
  return exportThreadHtml({
    title: thread.title?.trim() || 'Untitled conversation',
    messages
  });
}

export async function exportToNotes(title: string, body: string): Promise<void> {
  const { inTauri } = await import('$lib/utils/runtime');
  if (!inTauri()) throw new Error('Apple Notes export requires the desktop app');
  await invoke('export_to_notes', { title, body });
}

export async function exportMemoryTree(
  profileId: string,
  files: Array<{ path: string; content: string }>
): Promise<string> {
  if (!inTauri()) throw new Error('Workspace export requires the desktop app');
  return (await invoke('export_memory_tree', { profileId, files })) as string;
}
