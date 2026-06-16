# R87 — Self-contained HTML transcript export util

**Lane**: A17 (codex)
**Branch**: `codex/r87-html-transcript-export`
**Depends on**: nothing. Pure TS + Vitest.

## Context

Conversation export today emits Markdown + JSON. A shareable,
double-click-to-open **self-contained HTML** transcript (inline CSS,
dark theme, no external assets) is missing. This task ships the pure
string-builder. Claude wires an "Export as HTML" item into the
existing export menu after merge.

## Owned files (exclusive write access)

- `src/lib/util/html-export.ts` — NEW.
- `src/lib/util/html-export.test.ts` — NEW.

## Forbidden files

- `src/lib/api/files.ts` (existing export lives there — do NOT touch it).
- Every store, route, component, the API client, `types.ts`, all Rust.
- Define a local structural `TranscriptMessage` interface inside
  `html-export.ts` (`{ role: 'user' | 'assistant' | 'tool'; content:
  string; created_at?: string }`).

## API to implement

```ts
export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  created_at?: string; // ISO
}

export interface HtmlExportOptions {
  title: string;
  messages: TranscriptMessage[];
  generatedAt?: string; // ISO; defaults to new Date().toISOString()
}

/**
 * Render a complete, standalone HTML document string:
 * - Starts with `<!DOCTYPE html>`, has <head> with <meta charset>, a
 *   <title> = the (escaped) title, and a <style> block (dark theme:
 *   navy/black bg, light text, cyan accent on the user role label).
 * - One block per message: role label + escaped content in a <pre>-style
 *   wrap that preserves newlines (white-space: pre-wrap). Timestamp shown
 *   when present.
 * - A footer line with the generatedAt timestamp.
 *
 * SECURITY: every piece of caller-supplied text (title, content,
 * timestamps) MUST be HTML-escaped (`& < > " '`). No raw interpolation.
 * The output must be safe to open in any browser even if a message
 * contains `<script>` or `</style>` or an onerror attribute.
 */
export function exportThreadHtml(opts: HtmlExportOptions): string;

/** Escape the five HTML-significant chars. Exported for the tests. */
export function escapeHtml(s: string): string;
```

## Acceptance

- `npx vitest run src/lib/util/html-export.test.ts` green with at least:
  - Output starts with `<!DOCTYPE html>` and contains `</html>`.
  - `escapeHtml('<script>&"\'')` returns the fully escaped form (no raw
    `<`, `>`, `&` other than entities, `"` → `&quot;`, `'` → `&#39;`).
  - A message whose content is `<script>alert(1)</script>` appears
    ESCAPED in the output — assert the literal `<script>alert(1)` does
    NOT appear but `&lt;script&gt;` does.
  - The (escaped) title appears in both `<title>` and a visible heading.
  - Each message's content is present (escaped) and in order.
  - Footer contains the generatedAt value.
- `npm run check` clean. No `any`, no `console.log`, no non-stdlib imports.

## Out of scope

- Markdown→HTML rendering of message bodies (keep them as escaped
  pre-wrap text this round; rich rendering is a follow-up).
- Writing the file to disk / Tauri save dialog (Claude wires that).
- Embedding images/attachments.
