import { React, html } from '../../../lib/html.js';
import { Icon } from '../../../design-system/icons.js';

const toneCss = {
  success:
    'border-[color-mix(in_srgb,var(--v2-positive-text)_34%,var(--v2-panel-border))] bg-[var(--v2-positive-soft)] text-[var(--v2-positive-text)]',
  error:
    'border-[color-mix(in_srgb,var(--v2-danger-text)_36%,var(--v2-panel-border))] bg-[var(--v2-danger-soft)] text-[var(--v2-danger-text)]',
  info: 'border-[color-mix(in_srgb,var(--v2-accent)_34%,var(--v2-panel-border))] bg-[color-mix(in_srgb,var(--v2-accent)_10%,transparent)] text-[var(--v2-accent-text)]'
};

export function ActionToast({ result, onDismiss }) {
  React.useEffect(() => {
    if (!result) return;
    const timer = setTimeout(onDismiss, 4000);
    return () => clearTimeout(timer);
  }, [result, onDismiss]);

  if (!result) return null;

  return html`
    <div
      className=${[
        'flex items-center gap-3 rounded-xl border px-4 py-3 text-sm',
        toneCss[result.type] || toneCss.info
      ].join(' ')}
    >
      <${Icon}
        name=${result.type === 'success' ? 'check' : result.type === 'error' ? 'close' : 'bolt'}
        className="h-4 w-4 shrink-0"
      />
      <span className="min-w-0 flex-1">${result.message}</span>
      <button onClick=${onDismiss} className="shrink-0 opacity-70 hover:opacity-100">
        <${Icon} name="close" className="h-3.5 w-3.5" />
      </button>
    </div>
  `;
}
