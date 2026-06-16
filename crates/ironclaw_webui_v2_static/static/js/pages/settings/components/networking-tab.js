import { html } from "../../../lib/html.js";
import { Card } from "../../../design-system/card.js";
import { NETWORKING_FIELDS } from "../lib/settings-schema.js";
import { filterSettingsSections } from "../lib/settings-search.js";
import { SettingsGroup } from "./settings-field.js";
import { SettingsNotWritable } from './settings-not-writable.js';
import { SettingsSearchEmpty } from "./settings-search-empty.js";
import { useT } from "../../../lib/i18n.js";

export function NetworkingTab({
  settings,
  settingsStatus = 'ready',
  onSave,
  savedKeys,
  isLoading,
  searchQuery = "",
}) {
  const t = useT();
  if (isLoading) {
    return html`
      <div className="space-y-5">
        ${[1, 2].map(
          (i) =>
            html`
              <${Card} key=${i} padding="md">
                <div className="v2-skeleton mb-4 h-3 w-20 rounded" />
                ${[1, 2].map(
                  (j) =>
                    html`
                      <div key=${j} className="flex items-center justify-between border-t border-[var(--v2-panel-border)] py-4 first:border-0">
                        <div className="v2-skeleton h-4 w-32 rounded" />
                        <div className="v2-skeleton h-9 w-36 rounded" />
                      </div>
                    `
                )}
              <//>
            `
        )}
      </div>
    `;
  }

  // These fields write through `useSettings.save`, which has no v2 persistence
  // endpoint yet (status:'todo'). Editable inputs that silently fail to save are
  // fake readiness — gate them on a proven settings backend and show an honest
  // explanation instead ("No fake readiness").
  if (settingsStatus === 'todo') {
    return html`<${SettingsNotWritable} />`;
  }

  const sections = filterSettingsSections(NETWORKING_FIELDS, settings, searchQuery, t);
  if (sections.length === 0) {
    return html`<${SettingsSearchEmpty} query=${searchQuery} />`;
  }

  return html`
    <div className="space-y-5">
      ${sections.map(
        (section) =>
          html`
            <${SettingsGroup}
              key=${section.groupKey}
              groupKey=${section.groupKey}
              fields=${section.fields}
              settings=${settings}
              onSave=${onSave}
              savedKeys=${savedKeys}
            />
          `
      )}
    </div>
  `;
}
