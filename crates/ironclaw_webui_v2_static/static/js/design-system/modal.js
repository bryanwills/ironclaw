/**
 * Modal
 *
 * Accessible dialog with backdrop.  Pure Tailwind — no app.css classes.
 * Renders into a portal-like fixed overlay; body scroll is locked while open.
 *
 * Props
 *   open      boolean
 *   onClose   () => void  — called on backdrop click or Escape key
 *   title     string
 *   size      "sm" | "md" (default) | "lg" | "xl" | "full"
 *   className string — applied to the dialog panel
 *   children
 *
 * Sub-components (all optional)
 *   <ModalHeader>  — renders title + close button row
 *   <ModalBody>    — scrollable content area
 *   <ModalFooter>  — action button row with top divider
 */
import { React, html } from '../lib/html.js';
import { cn } from '../utils/cn.js';
import { Icon } from './icons.js';

/* ─── Size ────────────────────────────────────────────────────────── */

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)]'
};

/* ─── Modal ───────────────────────────────────────────────────────── */

export function Modal({ open, onClose, title, size = 'md', className = '', children }) {
  const panelRef = React.useRef(null);
  const restoreFocusRef = React.useRef(null);

  /* Lock body scroll when open */
  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  /* Move focus into the dialog on open and return it to the opener on close,
     so keyboard users are never stranded behind the modal or on <body>. */
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

  /* Esc closes from anywhere while open, even if focus has not landed inside
     the panel yet (e.g. the modal was opened by mouse). A document listener is
     more robust than relying on the keydown bubbling to the dialog root. */
  React.useEffect(() => {
    if (!open) return undefined;
    const onDocKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose?.();
      }
    };
    document.addEventListener('keydown', onDocKeyDown);
    return () => document.removeEventListener('keydown', onDocKeyDown);
  }, [open, onClose]);

  /* Tab/Shift-Tab stay trapped in the panel. */
  const onKeyDown = React.useCallback((event) => {
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(
      panel.querySelectorAll(
        'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
    if (items.length === 0) {
      // No tabbable controls — keep focus pinned to the panel itself.
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
  }, []);

  if (!open) return null;

  return html`
    <!-- Backdrop -->
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
      aria-modal="true"
      role="dialog"
      onKeyDown=${onKeyDown}
    >
      <!-- Dim layer -->
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick=${onClose}
        aria-hidden="true"
      />

      <!-- Panel -->
      <div
        ref=${panelRef}
        tabindex=${-1}
        className=${cn(
          'relative z-10 w-full outline-none',
          'bg-[var(--v2-card-bg)] border border-[var(--v2-panel-border)]',
          'shadow-[0_24px_60px_rgba(0,0,0,0.35)]',
          'rounded-[1.5rem]',
          'flex flex-col max-h-[90dvh] overflow-hidden',
          SIZES[size] ?? SIZES.md,
          className
        )}
      >
        ${title ? html`<${ModalHeader} onClose=${onClose}>${title}<//>` : null} ${children}
      </div>
    </div>
  `;
}

/* ─── ModalHeader ─────────────────────────────────────────────────── */

export function ModalHeader({ children, onClose, className = '' }) {
  return html`
    <div
      className=${cn(
        'flex shrink-0 items-center justify-between gap-4',
        'px-5 py-4 md:px-7 md:py-5',
        'border-b border-[var(--v2-panel-border)]',
        className
      )}
    >
      <h2
        className="text-[1.1rem] font-semibold tracking-[-0.02em] text-[var(--v2-text-strong)] md:text-[1.2rem]"
      >
        ${children}
      </h2>
      ${onClose &&
      html`
        <button
          type="button"
          onClick=${onClose}
          aria-label="Close"
          className="grid min-h-[44px] min-w-[44px] shrink-0 place-items-center rounded-[10px]
              border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)]
              text-[var(--v2-text-muted)]
              hover:bg-[var(--v2-surface-muted)] hover:text-[var(--v2-text-strong)]"
        >
          <${Icon} name="close" className="h-4 w-4" />
        </button>
      `}
    </div>
  `;
}

/* ─── ModalBody ───────────────────────────────────────────────────── */

export function ModalBody({ children, className = '' }) {
  return html`
    <div className=${cn('flex-1 overflow-y-auto px-5 py-4 md:px-7 md:py-5', className)}>
      ${children}
    </div>
  `;
}

/* ─── ModalFooter ─────────────────────────────────────────────────── */

export function ModalFooter({ children, className = '' }) {
  return html`
    <div
      className=${cn(
        'shrink-0 flex items-center justify-end gap-3 flex-wrap',
        'px-5 py-4 md:px-7 md:py-5',
        'border-t border-[var(--v2-panel-border)]',
        className
      )}
    >
      ${children}
    </div>
  `;
}
