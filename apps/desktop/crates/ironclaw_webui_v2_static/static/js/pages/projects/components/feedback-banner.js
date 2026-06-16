import { html } from '../../../lib/html.js';

const tone = {
  success:
    'border-[color-mix(in_srgb,var(--v2-positive-text)_36%,var(--v2-panel-border))] bg-[var(--v2-positive-soft)] text-[var(--v2-positive-text)]',
  error:
    'border-[color-mix(in_srgb,var(--v2-danger-text)_36%,var(--v2-panel-border))] bg-[var(--v2-danger-soft)] text-[var(--v2-danger-text)]',
  info: 'border-[color-mix(in_srgb,var(--v2-accent-text)_32%,var(--v2-panel-border))] bg-[var(--v2-accent-soft)] text-[var(--v2-accent-text)]'
};

export function FeedbackBanner({ result, onDismiss }) {
  if (!result) return null;

  return html`
    <div
      className=${[
        'flex items-center gap-3 rounded-xl border px-4 py-3 text-sm',
        tone[result.type] || tone.info
      ].join(' ')}
    >
      <span className="min-w-0 flex-1">${result.message}</span>
      <button onClick=${onDismiss} className="shrink-0 opacity-70 hover:opacity-100">
        Dismiss
      </button>
    </div>
  `;
}
