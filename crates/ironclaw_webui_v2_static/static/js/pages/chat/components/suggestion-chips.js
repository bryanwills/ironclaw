import { html } from '../../../lib/html.js';

export function SuggestionChips({ suggestions, onSelect }) {
  if (!suggestions || suggestions.length === 0) return null;

  return html`
    <div className="px-4 pb-3 sm:px-5 lg:px-8">
      <div className="mx-auto flex max-w-5xl flex-wrap gap-2">
        ${suggestions.map(
          (text) => html`
            <button
              key=${text}
              onClick=${() => onSelect(text)}
              className="v2-button rounded-full border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] px-3 py-1.5 text-xs text-[var(--v2-text-muted)] hover:border-[var(--v2-accent)] hover:text-[var(--v2-accent-text)]"
            >
              ${text}
            </button>
          `
        )}
      </div>
    </div>
  `;
}
