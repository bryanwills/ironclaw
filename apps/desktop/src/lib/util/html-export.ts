export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  created_at?: string;
}

export interface HtmlExportOptions {
  title: string;
  messages: TranscriptMessage[];
  generatedAt?: string;
}

const ROLE_META: Record<TranscriptMessage['role'], { className: string; label: string }> = {
  assistant: { className: 'message-assistant', label: 'Assistant' },
  tool: { className: 'message-tool', label: 'Tool' },
  user: { className: 'message-user', label: 'User' }
};

/** Escape the five HTML-significant chars. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderMessage(message: TranscriptMessage): string {
  const roleMeta = ROLE_META[message.role];
  const role = escapeHtml(roleMeta.label);
  const timestamp = message.created_at
    ? `<time class="message-time" datetime="${escapeHtml(message.created_at)}">${escapeHtml(message.created_at)}</time>`
    : '';

  return `      <article class="message ${roleMeta.className}">
        <header class="message-header">
          <span class="role-label">${role}</span>
          ${timestamp}
        </header>
        <pre class="message-content">${escapeHtml(message.content)}</pre>
      </article>`;
}

/**
 * Render a complete, standalone HTML document string.
 */
export function exportThreadHtml(opts: HtmlExportOptions): string {
  const title = escapeHtml(opts.title);
  const generatedAt = escapeHtml(opts.generatedAt ?? new Date().toISOString());
  const messages = opts.messages.map(renderMessage).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #050814;
        --panel: #0b1224;
        --panel-border: #24324d;
        --text: #e7edf7;
        --muted: #9aa8bd;
        --accent: #22d3ee;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.5;
      }

      main {
        width: min(960px, calc(100% - 32px));
        margin: 0 auto;
        padding: 40px 0 24px;
      }

      h1 {
        margin: 0 0 24px;
        font-size: clamp(1.75rem, 4vw, 2.75rem);
        font-weight: 700;
        letter-spacing: 0;
      }

      .message {
        margin: 0 0 18px;
        padding: 18px;
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 8px;
      }

      .message-header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 10px;
      }

      .role-label {
        color: var(--muted);
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .message-user .role-label {
        color: var(--accent);
      }

      .message-time {
        color: var(--muted);
        font-size: 0.82rem;
      }

      .message-content {
        margin: 0;
        color: var(--text);
        font: 0.95rem/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }

      footer {
        color: var(--muted);
        font-size: 0.86rem;
        padding: 12px 0 24px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
${messages}
      <footer>Generated at ${generatedAt}</footer>
    </main>
  </body>
</html>`;
}
