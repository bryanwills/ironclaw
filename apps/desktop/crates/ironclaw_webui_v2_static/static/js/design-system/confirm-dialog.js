/**
 * ConfirmDialog — a design-system replacement for window.confirm/alert.
 *
 * Native OS dialogs break the app's frame (wrong chrome, wrong fonts, jarring
 * on macOS overlay windows). This renders the request inside the design-system
 * Modal: title, one-line body, a dominant action and a quiet Cancel.
 *
 * Usage (declarative, no global provider):
 *   const [confirm, setConfirm] = React.useState(null);
 *   // open:
 *   setConfirm({ message: 'Delete this chat?', tone: 'danger', confirmLabel: 'Delete',
 *               onConfirm: () => doDelete() });
 *   // render once in the component tree:
 *   html`<${ConfirmDialog} request=${confirm} onClose=${() => setConfirm(null)} />`
 *
 * `onConfirm` may be async; the confirm button shows a pending state and the
 * dialog closes on resolve, or surfaces the error inline on reject.
 */
import { React, html } from '../lib/html.js';
import { Modal, ModalBody, ModalFooter } from './modal.js';
import { Button } from './button.js';

/**
 * @param {{
 *   request: null | {
 *     message: string,
 *     title?: string,
 *     confirmLabel?: string,
 *     cancelLabel?: string,
 *     tone?: 'danger' | 'primary'
 *   },
 *   onClose: () => void
 * }} props
 */
export function ConfirmDialog({ request, onClose }) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState('');

  // Reset transient state whenever a new request opens.
  React.useEffect(() => {
    setPending(false);
    setError('');
  }, [request]);

  if (!request) return null;

  const {
    message,
    title = 'Are you sure?',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    tone = 'primary',
    onConfirm
  } = request;

  const runConfirm = async () => {
    setError('');
    setPending(true);
    try {
      await onConfirm?.();
      onClose?.();
    } catch (err) {
      setError(err?.message || 'Something went wrong.');
      setPending(false);
    }
  };

  return html`
    <${Modal} open=${true} onClose=${pending ? () => {} : onClose} size="sm" title=${title}>
      <${ModalBody}>
        <p className="text-sm leading-relaxed text-[var(--v2-text)]">${message}</p>
        ${error && html`<p className="mt-3 text-xs text-[var(--v2-danger-text)]">${error}</p>`}
      <//>
      <${ModalFooter}>
        <${Button} variant="ghost" size="md" disabled=${pending} onClick=${onClose}>
          ${cancelLabel}
        <//>
        <${Button}
          variant=${tone === 'danger' ? 'danger' : 'primary'}
          size="md"
          disabled=${pending}
          onClick=${runConfirm}
        >
          ${pending ? '…' : confirmLabel}
        <//>
      <//>
    <//>
  `;
}
