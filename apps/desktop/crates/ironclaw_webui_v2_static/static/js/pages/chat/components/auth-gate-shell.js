/**
 * AuthGateShell — shared chrome for auth gates (Status Pill + Drawer pattern).
 *
 * Presentation only: renders a collapsible pill header and an expandable
 * drawer. It owns NO security logic and handles NO credentials — the action
 * area (CTA / token input / cancel) is supplied by the calling card via
 * `children`, so each card keeps its own form semantics and security guards.
 *
 * Props
 *   icon          design-system icon name for the header chip (default "lock")
 *   headline      bold pill title
 *   provider      optional provider name (subtitle)
 *   accountLabel  optional account label (subtitle; takes precedence)
 *   body          optional descriptive text shown at the top of the drawer
 *   expiresAt     optional ISO timestamp rendered as an expiry hint
 *   pillHint      short call-to-action text on the right of the pill
 *   defaultExpanded boolean (default true — active gates block the run)
 *   controlsId    id used for aria-controls / drawer id
 *   children      drawer action area (CTA, input, cancel)
 */
import { React, html } from '../../../lib/html.js';
import { useT } from '../../../lib/i18n.js';
import { Icon } from '../../../design-system/icons.js';

export function AuthGateShell({
  icon = 'lock',
  headline,
  provider,
  accountLabel,
  body,
  expiresAt,
  pillHint,
  defaultExpanded = true,
  children
}) {
  const t = useT();
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const controlsId = React.useId();
  const subtitle = accountLabel || provider || '';

  return html`
    <div
      className="mx-auto w-full max-w-xl rounded-[16px] border border-[color-mix(in_srgb,var(--v2-gold)_34%,var(--v2-panel-border))] bg-[color-mix(in_srgb,var(--v2-gold-soft)_58%,var(--v2-card-bg))]"
    >
      <button
        type="button"
        onClick=${() => setExpanded((v) => !v)}
        aria-expanded=${expanded ? 'true' : 'false'}
        aria-controls=${controlsId}
        className="flex w-full items-center gap-3 rounded-[16px] border-0 bg-transparent px-4 py-3 text-left"
      >
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-[color-mix(in_srgb,var(--v2-gold)_34%,var(--v2-panel-border))] bg-[var(--v2-gold-soft)] text-[var(--v2-gold-text)]"
        >
          <${Icon} name=${icon} className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-[var(--v2-text-strong)]">
            ${headline || t('authGate.title')}
          </span>
          ${subtitle &&
          html`<span className="mt-0.5 block truncate text-xs text-[var(--v2-text-muted)]"
            >${subtitle}</span
          >`}
        </span>
        <span
          className="ml-auto flex shrink-0 items-center gap-1.5 text-xs font-medium text-[var(--v2-gold-text)]"
        >
          ${pillHint && html`<span className="hidden sm:inline">${pillHint}</span>`}
          <${Icon}
            name="chevron"
            className=${['h-4 w-4', expanded ? 'rotate-180' : ''].join(' ')}
          />
        </span>
      </button>

      ${expanded &&
      html`
        <div
          id=${controlsId}
          className="border-t border-[color-mix(in_srgb,var(--v2-gold)_24%,var(--v2-panel-border))] px-4 pb-4 pt-3"
        >
          ${body &&
          html`<div className="mb-3 text-sm leading-6 text-[var(--v2-text-muted)]">${body}</div>`}
          ${children}
          ${expiresAt &&
          html`
            <p className="mt-2 text-xs text-[var(--v2-text-faint)]">
              ${t('authGate.expiresAt')}: ${new Date(expiresAt).toLocaleString()}
            </p>
          `}
        </div>
      `}
    </div>
  `;
}
