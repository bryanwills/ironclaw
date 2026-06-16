import { Link, Outlet, useLocation } from 'react-router';
import { useInterfaceTheme } from '../design-system/theme.js';
import { Button } from '../design-system/button.js';
import { useGatewayStatus } from '../hooks/useGatewayStatus.js';
import { useLlmProviders } from '../pages/settings/hooks/useLlmProviders.js';
import { useSidebar } from '../hooks/useSidebar.js';
import { html } from '../lib/html.js';
import { useT } from '../lib/i18n.js';
import { useThreads } from '../pages/chat/hooks/useThreads.js';
import { Sidebar } from '../components/sidebar.js';
import { PageHeader } from '../components/page-header.js';
import { CommandPalette } from '../components/command-palette.js';
import { ToastViewport } from '../components/toast-viewport.js';
import { React } from '../lib/html.js';
import { cn } from '../utils/cn.js';

function readinessDetailForPath(pathname, { gatewayError }) {
  if (!gatewayError) {
    return 'NEAR AI Cloud setup could not be confirmed yet. You can keep browsing, then retry or open setup.';
  }
  if (pathname.startsWith('/settings')) {
    return 'Gateway-backed setup is unavailable until the local gateway responds. You can review settings, then retry.';
  }
  if (pathname.startsWith('/extensions')) {
    return 'Connection setup is unavailable until the local gateway responds. Existing catalog guidance remains visible.';
  }
  if (pathname.startsWith('/chat')) {
    return 'The local gateway is still starting or is unreachable. Chat is paused until IronClaw can reach it.';
  }
  return 'The local gateway is still starting or is unreachable. Some live actions are paused until IronClaw can reach it.';
}

function GatewayReadinessNotice({ gatewayError, providerError, pathname, onRetry }) {
  if (!gatewayError && !providerError) return null;
  const detail = readinessDetailForPath(pathname || '', { gatewayError });

  return html`
    <div
      className=${cn(
        'm-4 rounded-[12px] border px-4 py-3 text-sm',
        'border-[color-mix(in_srgb,var(--v2-warning-text)_34%,var(--v2-panel-border))]',
        'bg-[var(--v2-warning-soft)] text-[var(--v2-text)]'
      )}
      role="status"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="font-semibold text-[var(--v2-text-strong)]">IronClaw is connecting</div>
          <div className="mt-1 leading-5 text-[var(--v2-text-muted)]">${detail}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <${Button} type="button" variant="secondary" onClick=${onRetry}> Retry <//>
          <${Button} as=${Link} to="/settings/inference" variant="primary"> Open setup <//>
        </div>
      </div>
    </div>
  `;
}

export function GatewayLayout({ token, profile, isAdmin, onSignOut }) {
  const t = useT();
  const location = useLocation();
  const { theme, toggleTheme } = useInterfaceTheme();
  const statusQuery = useGatewayStatus(token);
  const threadsState = useThreads();
  const sidebar = useSidebar({
    onNewChat: () => threadsState.setActiveThreadId(null)
  });
  const status = statusQuery.data;

  // Chat is the front door. Model setup remains truthful in the composer and
  // Settings; the layout no longer redirects first-run users into provider
  // management before they can see the product surface.
  const llmProviders = useLlmProviders({ settings: {}, gatewayStatus: status });

  const [paletteOpen, setPaletteOpen] = React.useState(false);
  React.useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  // The current thread contract has no delete endpoint, so the sidebar renders no
  // delete affordance (SidebarThreads conditionally renders the
  // trash button on `onDelete`).

  return html`
    <div className="flex h-[100dvh] overflow-hidden bg-[var(--v2-canvas)]">
      ${sidebar.open &&
      html`<button
        type="button"
        aria-label=${t('nav.close')}
        onClick=${sidebar.close}
        className="fixed inset-0 z-40 bg-black/40 md:hidden"
      />`}

      <div
        className=${cn(
          'fixed inset-y-0 left-0 z-50 md:relative md:z-auto',
          sidebar.open ? 'flex' : 'hidden md:flex'
        )}
      >
        <${Sidebar}
          threadsState=${threadsState}
          theme=${theme}
          toggleTheme=${toggleTheme}
          profile=${profile}
          isAdmin=${isAdmin}
          onSignOut=${onSignOut}
          onClose=${sidebar.close}
          onNewChat=${sidebar.newChat}
          onSelectThread=${sidebar.selectThread}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <${PageHeader} threadsState=${threadsState} onToggleSidebar=${sidebar.toggle} />
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <${GatewayReadinessNotice}
            gatewayError=${statusQuery.error}
            providerError=${llmProviders.error}
            pathname=${location.pathname}
            onRetry=${() => {
              statusQuery.refetch?.();
              llmProviders.refresh?.();
            }}
          />
          <${Outlet}
            context=${{
              gatewayStatus: status,
              gatewayStatusQuery: statusQuery,
              currentUser: profile,
              isAdmin,
              threadsState
            }}
          />
        </main>
      </div>
      <${CommandPalette}
        open=${paletteOpen}
        onClose=${() => setPaletteOpen(false)}
        threadsState=${threadsState}
        onNewChat=${sidebar.newChat}
        onToggleTheme=${toggleTheme}
        isAdmin=${isAdmin}
      />
      <${ToastViewport} />
    </div>
  `;
}
