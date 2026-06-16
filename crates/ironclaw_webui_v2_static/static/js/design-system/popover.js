import { React, html } from '../lib/html.js';
import { cn } from '../utils/cn.js';

// Anchored floating panel: renders relative to its trigger's wrapper,
// closes on outside click and Escape. Geometry per DESIGN.md: panels use
// 12px radius, hairline border, quiet shadow.
//
// Usage:
//   <${Popover}
//     open=${open}
//     onClose=${() => setOpen(false)}
//     trigger=${html`<button onClick=${() => setOpen(!open)}>…</button>`}
//     align="end"            // "start" | "end" (horizontal)
//     side="top"             // "top" | "bottom"
//   >…panel content…<//>
export function Popover({
  open,
  onClose,
  trigger,
  align = 'end',
  side = 'top',
  children,
  className,
  ariaLabel = 'Popover'
}) {
  const rootRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) onClose?.();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  const position = [
    'absolute z-50 min-w-[260px] max-w-[340px]',
    side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
    align === 'end' ? 'right-0' : 'left-0'
  ].join(' ');

  return html`
    <div ref=${rootRef} className="relative inline-flex">
      ${trigger}
      ${open &&
      html`
        <div
          role="dialog"
          aria-label=${ariaLabel}
          className=${cn(
            position,
            'rounded-[12px] border border-[var(--v2-panel-border)] bg-[var(--v2-card-bg)] shadow-[var(--v2-card-shadow)]',
            className
          )}
        >
          ${children}
        </div>
      `}
    </div>
  `;
}
