import { Navigate, useOutletContext, useParams } from 'react-router';
import { React, html } from '../../lib/html.js';
import { useT } from '../../lib/i18n.js';
import { AgentTab } from './components/agent-tab.js';
import { ChannelsTab } from './components/channels-tab.js';
import { InferenceTab } from './components/inference-tab.js';
import { LanguageTab } from './components/language-tab.js';
import { NetworkingTab } from './components/networking-tab.js';
import { RestartBanner } from './components/restart-banner.js';
import { SkillsTab } from './components/skills-tab.js';
import { ToolsTab } from './components/tools-tab.js';
import { UsersTab } from './components/users-tab.js';
import { useSettings } from './hooks/useSettings.js';

export function SettingsPage() {
  const t = useT();
  const { tab = 'inference' } = useParams();
  const { gatewayStatus, gatewayStatusQuery, isAdmin = true } = useOutletContext();
  const { settings, query, status, save, savedKeys, needsRestart, saveError } = useSettings();

  const isLoading = query.isLoading;

  const tabContent = {
    inference: html`<${InferenceTab}
      settings=${settings}
      gatewayStatus=${gatewayStatus}
      settingsStatus=${status}
      onSave=${save}
      savedKeys=${savedKeys}
      isLoading=${isLoading}
    />`,
    agent: html`<${AgentTab}
      settings=${settings}
      settingsStatus=${status}
      onSave=${save}
      savedKeys=${savedKeys}
      isLoading=${isLoading}
    />`,
    channels: html`<${ChannelsTab} />`,
    networking: html`<${NetworkingTab}
      settings=${settings}
      settingsStatus=${status}
      onSave=${save}
      savedKeys=${savedKeys}
      isLoading=${isLoading}
    />`,
    tools: html`<${ToolsTab} />`,
    skills: html`<${SkillsTab} />`,
    users: html`<${UsersTab} />`,
    language: html`<${LanguageTab} />`
  };

  if (!tabContent[tab] || (!isAdmin && tab === 'users')) {
    return html`<${Navigate} to="/settings/inference" replace />`;
  }

  return html`
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="v2-page-entrance flex-1 p-4 sm:p-6">
          <div className="space-y-5">
            ${needsRestart &&
            html`<div
              className="sticky top-0 z-20 -mx-4 -mt-4 mb-1 bg-[color-mix(in_srgb,var(--v2-canvas)_92%,transparent)] px-4 pt-4 backdrop-blur sm:-mx-6 sm:px-6"
            >
              <${RestartBanner}
                visible=${true}
                gatewayStatus=${gatewayStatus}
                gatewayStatusQuery=${gatewayStatusQuery}
              />
            </div>`}
            ${saveError &&
            html`
              <div
                className="rounded-xl border border-[color-mix(in_srgb,var(--v2-danger-text)_36%,var(--v2-panel-border))] bg-[var(--v2-danger-soft)] px-4 py-3 text-sm text-[var(--v2-danger-text)]"
              >
                ${t('error.saveFailed', { message: saveError.message })}
              </div>
            `}
            ${tabContent[tab]}
          </div>
        </div>
      </div>
    </div>
  `;
}
