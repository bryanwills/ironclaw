import { React, html } from '../../lib/html.js';
import { useT } from '../../lib/i18n.js';
import { AutomationsList } from './components/automations-list.js';
import { AutomationsSummaryStrip } from './components/automations-summary-strip.js';
import { useAutomations } from './hooks/useAutomations.js';

export function AutomationsPage() {
  const t = useT();
  const [filter, setFilter] = React.useState('all');
  const automationsState = useAutomations();
  const showErrorOnly =
    automationsState.error &&
    !automationsState.isLoading &&
    automationsState.automations.length === 0;

  return html`
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="v2-page-entrance flex-1 p-4 sm:p-6">
        <div className="space-y-5">
          ${automationsState.error &&
          html`
            <div
              className="rounded-xl border border-[color-mix(in_srgb,var(--v2-danger-text)_36%,var(--v2-panel-border))] bg-[var(--v2-danger-soft)] px-4 py-3 text-sm text-[var(--v2-danger-text)]"
            >
              ${t('automations.error.loadFailed')}
            </div>
          `}
          ${showErrorOnly
            ? null
            : html`
                <${AutomationsSummaryStrip} summary=${automationsState.summary} />

                ${automationsState.isLoading
                  ? html`
                      <div className="space-y-4">
                        ${[1, 2, 3].map(
                          (index) =>
                            html`<div key=${index} className="v2-skeleton h-28 rounded-[18px]" />`
                        )}
                      </div>
                    `
                  : html`
                      <${AutomationsList}
                        automations=${automationsState.automations}
                        filter=${filter}
                        onFilterChange=${setFilter}
                        onRefresh=${automationsState.refetch}
                        isRefreshing=${automationsState.isRefreshing}
                      />
                    `}
              `}
        </div>
      </div>
    </div>
  `;
}
