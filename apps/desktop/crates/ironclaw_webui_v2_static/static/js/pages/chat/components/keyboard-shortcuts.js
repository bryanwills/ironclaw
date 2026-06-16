import { React, html } from '../../../lib/html.js';
import { useT } from '../../../lib/i18n.js';
import { Icon } from '../../../design-system/icons.js';

const SHORTCUTS = [
  { keys: ['Enter'], descKey: 'shortcuts.send' },
  { keys: ['Shift', 'Enter'], descKey: 'shortcuts.newline' },
  { keys: ['?'], descKey: 'shortcuts.help' },
  { keys: ['Esc'], descKey: 'shortcuts.close' }
];

export function KeyboardShortcuts({ open, onClose }) {
  const t = useT();
  const panelRef = React.useRef(null);
  const restoreFocusRef = React.useRef(null);

  // Move focus into the dialog on open and return it to the opener on close, so
  // keyboard users are never stranded behind the modal or on <body>.
  React.useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const target = panel.querySelector(
        'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])'
      );
      (target instanceof HTMLElement ? target : panel).focus();
    });
    return () => {
      window.cancelAnimationFrame(id);
      restoreFocusRef.current?.focus?.();
      restoreFocusRef.current = null;
    };
  }, [open]);

  // Esc closes from anywhere inside; Tab/Shift-Tab stay trapped in the panel.
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(
      panel.querySelectorAll(
        'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
    if (items.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const activeEl = document.activeElement;
    if (event.shiftKey && (activeEl === first || activeEl === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && activeEl === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  return html`
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label=${t('shortcuts.title')}
      onKeyDown=${onKeyDown}
    >
      <button
        type="button"
        aria-label=${t('shortcuts.close')}
        onClick=${onClose}
        className="absolute inset-0 bg-black/50"
      ></button>
      <div
        ref=${panelRef}
        tabindex=${-1}
        className="relative w-full max-w-md rounded-2xl border border-[var(--v2-panel-border)] bg-[var(--v2-surface)] p-5 shadow-[0_30px_60px_-20px_rgba(0,0,0,0.8)] outline-none"
      >
        <div className="mb-4 flex items-center gap-2">
          <span
            className="grid h-8 w-8 place-items-center rounded-md border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] text-[var(--v2-text-muted)]"
          >
            <${Icon} name="bolt" className="h-4 w-4" />
          </span>
          <h2 className="text-base font-semibold text-[var(--v2-text-strong)]">
            ${t('shortcuts.title')}
          </h2>
          <button
            type="button"
            onClick=${onClose}
            aria-label=${t('shortcuts.close')}
            className="ml-auto grid h-7 w-7 place-items-center rounded-md text-[var(--v2-text-faint)] hover:bg-[var(--v2-surface-soft)] hover:text-[var(--v2-text-strong)]"
          >
            <${Icon} name="close" className="h-4 w-4" />
          </button>
        </div>
        <ul className="flex flex-col gap-2">
          ${SHORTCUTS.map(
            (shortcut, index) => html`
              <li
                key=${index}
                className="flex items-center justify-between gap-3 text-sm text-[var(--v2-text)]"
              >
                <span>${t(shortcut.descKey)}</span>
                <span className="flex items-center gap-1">
                  ${shortcut.keys.map(
                    (key, keyIndex) =>
                      html`<kbd
                        key=${keyIndex}
                        className="rounded-md border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] px-2 py-0.5 font-mono text-[11px] text-[var(--v2-text-muted)]"
                        >${key}</kbd
                      >`
                  )}
                </span>
              </li>
            `
          )}
        </ul>
      </div>
    </div>
  `;
}
