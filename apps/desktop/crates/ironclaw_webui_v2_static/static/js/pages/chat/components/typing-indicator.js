import { html } from '../../../lib/html.js';

// Shown while a run is in flight (chat.js mounts it on isProcessing). The user
// must be able to SEE that IronClaw is working — silent dots alone read as a
// hung app — so this says "thinking…" in words, on the v2 light surface (the
// prior iron-* dark bubble was off-theme). Live reasoning and tool rows render
// separately as they stream in; this is the always-on "it's working" signal
// that shows even before the first delta arrives.
export function TypingIndicator() {
  return html`
    <div
      className="flex items-center gap-2.5 px-1 py-1.5 text-sm text-[var(--v2-text-muted)]"
      role="status"
      aria-live="polite"
      aria-label="IronClaw is thinking"
    >
      <span className="inline-flex items-center gap-1" aria-hidden="true">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--v2-text-faint)] opacity-40" />
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--v2-text-faint)] opacity-70" />
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--v2-text-faint)]" />
      </span>
      <span>IronClaw is thinking…</span>
    </div>
  `;
}
