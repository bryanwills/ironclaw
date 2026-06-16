import { Link } from 'react-router';
import { Button } from '../../../design-system/button.js';
import { Icon } from '../../../design-system/icons.js';
import { EmptyPanel, Panel, StatusPill } from '../../../design-system/primitives.js';
import { html } from '../../../lib/html.js';
import { useT } from '../../../lib/i18n.js';
import { cn } from '../../../utils/cn.js';
import { filterAutomations } from '../lib/automations-presenters.js';

const AUTOMATION_FILTERS = [
  { value: 'all', labelKey: 'automations.filter.all' },
  { value: 'active', labelKey: 'automations.filter.active' },
  { value: 'paused', labelKey: 'automations.filter.paused' }
];

export function AutomationsList({ automations, filter, onFilterChange, onRefresh, isRefreshing }) {
  const t = useT();
  const filtered = filterAutomations(automations, filter);
  const hasAutomations = automations.length > 0;

  return html`
    <div className="space-y-5">
      <${Panel} className="p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div
              className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--v2-text-muted)]"
            >
              ${t('automations.eyebrow')}
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--v2-text-strong)]">
              ${t('automations.title')}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--v2-text-muted)]">
              ${t('automations.description')}
            </p>
            <${Button} as=${Link} to="/chat" variant="secondary" className="mt-3">
              ${t('nav.chat')}
            <//>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div
              className="inline-flex overflow-hidden rounded-[10px] border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)]"
              role="group"
              aria-label=${t('automations.filterLabel')}
            >
              ${AUTOMATION_FILTERS.map(
                (item) => html`
                  <button
                    key=${item.value}
                    type="button"
                    aria-pressed=${filter === item.value}
                    onClick=${() => onFilterChange(item.value)}
                    className=${cn(
                      'h-11 px-3.5 text-xs font-semibold',
                      filter === item.value
                        ? 'bg-[var(--v2-accent-soft)] text-[var(--v2-accent-text)]'
                        : 'text-[var(--v2-text-muted)] hover:bg-[var(--v2-surface-muted)] hover:text-[var(--v2-text-strong)]'
                    )}
                  >
                    ${t(item.labelKey)}
                  </button>
                `
              )}
            </div>
            <button
              type="button"
              aria-label=${t('automations.refresh')}
              disabled=${isRefreshing}
              onClick=${onRefresh}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-[8px] border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] text-[var(--v2-text-strong)] hover:bg-[var(--v2-surface-muted)] hover:border-[color-mix(in_srgb,var(--v2-accent)_30%,var(--v2-panel-border))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-accent)]/50 focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--v2-canvas)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <${Icon} name="retry" className="h-4 w-4" />
            </button>
          </div>
        </div>
      <//>

      ${!filtered.length
        ? html`
            <${EmptyPanel}
              title=${hasAutomations
                ? t('automations.empty.matchingTitle')
                : t('automations.empty.noneTitle')}
              description=${hasAutomations
                ? t('automations.empty.matchingDescription')
                : t('automations.empty.noneDescription')}
            />
          `
        : html`
            <${Panel} className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--v2-panel-border)] text-left">
                      <th
                        className="px-5 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--v2-text-muted)]"
                      >
                        ${t('automations.table.name')}
                      </th>
                      <th
                        className="px-5 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--v2-text-muted)]"
                      >
                        ${t('automations.table.schedule')}
                      </th>
                      <th
                        className="px-5 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--v2-text-muted)]"
                      >
                        ${t('automations.table.nextRun')}
                      </th>
                      <th
                        className="px-5 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--v2-text-muted)]"
                      >
                        ${t('automations.table.lastRun')}
                      </th>
                      <th
                        className="px-5 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--v2-text-muted)]"
                      >
                        ${t('automations.table.status')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    ${filtered.map(
                      (automation) => html`
                        <tr
                          key=${automation.automation_id}
                          className="border-b border-[var(--v2-panel-border)] last:border-0"
                        >
                          <td className="max-w-[280px] px-5 py-4 align-top">
                            <div
                              className="truncate text-sm font-semibold text-[var(--v2-text-strong)]"
                            >
                              ${automation.display_name}
                            </div>
                            <div
                              className="mt-1 truncate font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--v2-text-faint)]"
                            >
                              ${automation.automation_id}
                            </div>
                          </td>
                          <td className="px-5 py-4 align-top text-sm text-[var(--v2-text-muted)]">
                            ${automation.schedule_label}
                          </td>
                          <td className="px-5 py-4 align-top text-sm text-[var(--v2-text-muted)]">
                            ${automation.next_run_label}
                          </td>
                          <td className="px-5 py-4 align-top">
                            <div className="text-sm text-[var(--v2-text-muted)]">
                              ${automation.last_run_label}
                            </div>
                            <div className="mt-2">
                              <${StatusPill}
                                tone=${automation.last_status_tone}
                                label=${automation.last_status_label}
                              />
                            </div>
                          </td>
                          <td className="px-5 py-4 align-top">
                            <${StatusPill}
                              tone=${automation.state_tone}
                              label=${automation.state_label}
                            />
                          </td>
                        </tr>
                      `
                    )}
                  </tbody>
                </table>
              </div>
            <//>
          `}
    </div>
  `;
}
