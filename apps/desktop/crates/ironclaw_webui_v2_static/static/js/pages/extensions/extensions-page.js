import { Navigate, useLocation, useParams } from 'react-router';
import { React, html } from '../../lib/html.js';
import { ActionToast } from './components/action-toast.js';
import { ChannelsTab } from './components/channels-tab.js';
import { ConfigureModal } from './components/configure-modal.js';
import { InstalledTab } from './components/installed-tab.js';
import { McpTab } from './components/mcp-tab.js';
import { RegistryTab } from './components/registry-tab.js';
import { useExtensions } from './hooks/useExtensions.js';

export function ExtensionsPage() {
  const { tab = 'installed' } = useParams();
  const location = useLocation();
  const [configuring, setConfiguring] = React.useState(null);
  const handledSetupLinkRef = React.useRef('');

  const {
    status,
    extensions,
    channels,
    mcpServers,
    tools,
    channelRegistry,
    mcpRegistry,
    toolRegistry,
    loadError,
    connectableChannels,
    isLoading,
    isBusy,
    actionResult,
    clearResult,
    install,
    addCustomMcp,
    activate,
    remove,
    invalidate
  } = useExtensions();

  const handleConfigure = React.useCallback((extension) => setConfiguring(extension), []);
  const handleCloseModal = React.useCallback(() => setConfiguring(null), []);
  const handleSaved = React.useCallback(() => invalidate(), [invalidate]);
  const handleActivateFromModal = React.useCallback(
    (extension) => {
      if (!extension) return;
      activate(extension);
      setConfiguring(null);
    },
    [activate]
  );

  React.useEffect(() => {
    if (isLoading || configuring) return;
    const params = new URLSearchParams(location.search || '');
    if (params.get('setup') !== '1') return;
    const setupLinkKey = `${location.pathname}?${location.search}`;
    if (handledSetupLinkRef.current === setupLinkKey) return;
    const targetId = canonicalExtensionId(params.get('focus'));
    if (!targetId) return;
    const target = extensions.find((extension) =>
      [extension?.package_ref?.id, extension?.id, extension?.display_name].some(
        (value) => canonicalExtensionId(value) === targetId
      )
    );
    if (!target?.package_ref) return;
    handledSetupLinkRef.current = setupLinkKey;
    setConfiguring({
      packageRef: target.package_ref,
      displayName: target.display_name || targetId
    });
  }, [configuring, extensions, isLoading, location.pathname, location.search]);

  if (isLoading) {
    return html`
      <div className="flex h-full flex-col overflow-y-auto">
        <div className="v2-page-entrance flex-1 p-4 sm:p-6">
          <div className="space-y-5">
            ${[1, 2, 3].map(
              (i) => html`
                <div
                  key=${i}
                  className="flex items-center justify-between border-t border-[var(--v2-panel-border)] py-4 first:border-0"
                >
                  <div>
                    <div className="v2-skeleton h-4 w-40 rounded" />
                    <div className="v2-skeleton mt-2 h-3 w-56 rounded" />
                  </div>
                  <div className="v2-skeleton h-7 w-16 rounded-full" />
                </div>
              `
            )}
          </div>
        </div>
      </div>
    `;
  }

  const tabContent = {
    installed: html`<${InstalledTab}
      extensions=${extensions}
      onActivate=${activate}
      onConfigure=${handleConfigure}
      onRemove=${remove}
      isBusy=${isBusy}
    />`,
    channels: html`<${ChannelsTab}
      status=${status}
      channels=${channels}
      connectableChannels=${connectableChannels}
      channelRegistry=${channelRegistry}
      loadError=${loadError}
      onActivate=${activate}
      onConfigure=${handleConfigure}
      onRemove=${remove}
      onInstall=${install}
      isBusy=${isBusy}
    />`,
    mcp: html`<${McpTab}
      mcpServers=${mcpServers}
      mcpRegistry=${mcpRegistry}
      loadError=${loadError}
      onActivate=${activate}
      onConfigure=${handleConfigure}
      onRemove=${remove}
      onInstall=${install}
      onAddCustom=${addCustomMcp}
      isBusy=${isBusy}
    />`,
    registry: html`<${RegistryTab}
      toolRegistry=${toolRegistry}
      channelRegistry=${channelRegistry}
      mcpRegistry=${mcpRegistry}
      loadError=${loadError}
      onInstall=${install}
      onConfigure=${handleConfigure}
      isBusy=${isBusy}
    />`
  };

  if (!tabContent[tab]) {
    return html`<${Navigate} to="/extensions/installed" replace />`;
  }

  return html`
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="v2-page-entrance flex-1 p-4 sm:p-6">
        <div className="space-y-5">
          <${ActionToast} result=${actionResult} onDismiss=${clearResult} />
          ${tabContent[tab]}
        </div>
      </div>

      ${configuring &&
      html`
        <${ConfigureModal}
          extension=${configuring}
          onActivate=${handleActivateFromModal}
          onClose=${handleCloseModal}
          onSaved=${handleSaved}
        />
      `}
    </div>
  `;
}

function canonicalExtensionId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withoutCatalogPrefix = raw.includes('/') ? raw.split('/').pop() : raw;
  const normalized = withoutCatalogPrefix.toLowerCase().replaceAll('_', '-');
  if (normalized === 'google-calendar') return 'google-calendar';
  if (normalized === 'slack-tool') return 'slack';
  return normalized;
}
