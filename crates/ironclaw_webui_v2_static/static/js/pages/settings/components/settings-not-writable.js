import { Card } from '../../../design-system/card.js';
import { Icon } from '../../../design-system/icons.js';
import { html } from '../../../lib/html.js';
import { useT } from '../../../lib/i18n.js';

// Shared honest state for settings sub-tabs whose only controls write through the
// v2 settings stub (`useSettings` status:'todo'). Rather than render editable
// fields that silently no-op, the tab shows this dignified explanation. Design
// Law: "No fake readiness — a surface may not imply a capability the gateway
// cannot prove."
export function SettingsNotWritable() {
  const t = useT();
  return html`
    <${Card} padding="lg">
      <div className="flex items-start gap-3">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] text-[var(--v2-text-faint)]"
        >
          <${Icon} name="lock" className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-[var(--v2-text-strong)]">
            ${t('settings.notWritable')}
          </h3>
          <p className="mt-2 max-w-md text-sm leading-6 text-[var(--v2-text-muted)]">
            ${t('settings.notWritableDesc')}
          </p>
        </div>
      </div>
    <//>
  `;
}
