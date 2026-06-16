import { React, html } from '../../../lib/html.js';
import { Badge } from '../../../design-system/badge.js';
import { Button } from '../../../design-system/button.js';
import { Icon } from '../../../design-system/icons.js';
import { KIND_LABELS, STATE_TONES, STATE_LABELS } from '../lib/extensions-schema.js';
import {
  connectorFamily,
  connectorKey,
  connectorSetupGuidance,
  primaryExtensionAction,
  registryConnectButtonState,
  registryStatusBadge
} from '../lib/extension-actions.js';

/* Card layout (Option B): self-contained bordered card. Capabilities collapse
   behind a count disclosure; secondary actions (Configure / Setup / Remove)
   live in an overflow menu so the resting card stays calm. */

const CARD =
  'flex h-full flex-col rounded-[14px] border border-[var(--v2-panel-border)] ' +
  'bg-[var(--v2-card-bg)] p-4 shadow-[var(--v2-shadow-sm)] ' +
  'transition-colors hover:border-[color-mix(in_srgb,var(--v2-accent)_22%,var(--v2-panel-border))]';
const META =
  'mt-1.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] text-[var(--v2-text-faint)]';
const DESC = 'mt-2 line-clamp-2 text-xs leading-5 text-[var(--v2-text-muted)]';
const FOOTER = 'mt-auto flex items-center gap-2 border-t border-[var(--v2-panel-border)] pt-3';
const DISCLOSURE =
  'v2-button -my-2 inline-flex min-h-[44px] items-center gap-1.5 border-0 bg-transparent py-2 pr-2 ' +
  'font-mono text-[11px] text-[var(--v2-text-faint)] hover:text-[var(--v2-accent-text)]';
const CHIP =
  'rounded border border-[var(--v2-panel-border)] bg-[var(--v2-surface)] ' +
  'px-1.5 py-0.5 font-mono text-[10px] text-[var(--v2-text-muted)]';
const APP_ICON =
  'grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-[10px] border ' +
  'border-[var(--v2-panel-border)] bg-[var(--v2-surface)] shadow-[var(--v2-shadow-sm)]';

function packageId(item) {
  return item.package_ref?.id || '';
}

export function connectorIconKind(source) {
  const key = connectorKey(source);
  const family = connectorFamily(source);

  if (key === 'gmail') return 'gmail';
  if (key === 'google-calendar' || key === 'google_calendar') return 'google-calendar';
  if (key === 'google-drive' || key === 'gdrive' || key === 'drive') return 'google-drive';
  if (key === 'google-sheets' || key === 'gsheets' || key === 'sheets') return 'google-sheets';
  if (key.includes('github')) return 'github';
  if (key.includes('telegram')) return 'telegram';
  if (key.includes('web') || key.includes('http') || key.includes('hacker-news')) return 'web';
  if (key.includes('routine') || key.includes('trigger')) return 'routine';
  if (family === 'notion') return 'notion';
  if (family === 'slack') return 'slack';
  if (family === 'workspace') return 'workspace';
  if (family === 'google') return 'google';
  if (source?.kind === 'wasm_channel') return 'channel';
  if (source?.kind === 'mcp_server') return 'knowledge';
  return 'tool';
}

function GoogleBarsIcon({ letter }) {
  return html`
    <svg viewBox="0 0 36 36" className="h-full w-full" aria-hidden="true">
      <rect width="36" height="36" rx="9" fill="#fff" />
      <path d="M6 9h24v5H6z" fill="#4285f4" />
      <path d="M6 14h24v5H6z" fill="#34a853" />
      <path d="M6 19h24v5H6z" fill="#fbbc04" />
      <path d="M6 24h24v3H6z" fill="#ea4335" />
      <text
        x="18"
        y="22"
        textAnchor="middle"
        fontSize="13"
        fontWeight="700"
        fontFamily="Inter, ui-sans-serif, system-ui"
        fill="#1f2937"
      >
        ${letter}
      </text>
    </svg>
  `;
}

function connectorGlyph(kind) {
  switch (kind) {
    case 'gmail':
      return html`
        <svg viewBox="0 0 36 36" className="h-full w-full" aria-hidden="true">
          <rect width="36" height="36" rx="9" fill="#fff" />
          <path
            d="M7 11.5v14h5.2V16.2L18 20.8l5.8-4.6v9.3H29v-14h-5.2L18 16.1l-5.8-4.6H7Z"
            fill="#ea4335"
          />
          <path d="M7 11.5 18 20.8l11-9.3v3.8L18 24.6 7 15.3v-3.8Z" fill="#fbbc04" />
          <path d="M7 15.3v10.2h5.2v-5.8L7 15.3Z" fill="#4285f4" />
          <path d="M29 15.3v10.2h-5.2v-5.8L29 15.3Z" fill="#34a853" />
        </svg>
      `;
    case 'google-calendar':
      return html`
        <svg viewBox="0 0 36 36" className="h-full w-full" aria-hidden="true">
          <rect width="36" height="36" rx="9" fill="#fff" />
          <path d="M9 8h18a2 2 0 0 1 2 2v4H7v-4a2 2 0 0 1 2-2Z" fill="#4285f4" />
          <path d="M7 14h22v12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V14Z" fill="#fff" />
          <path
            d="M9 8h18a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z"
            fill="none"
            stroke="#dadce0"
          />
          <text
            x="18"
            y="24"
            textAnchor="middle"
            fontSize="12"
            fontWeight="700"
            fontFamily="Inter, ui-sans-serif, system-ui"
            fill="#1a73e8"
          >
            31
          </text>
        </svg>
      `;
    case 'notion':
      return html`
        <svg viewBox="0 0 36 36" className="h-full w-full" aria-hidden="true">
          <rect
            x="5"
            y="5"
            width="26"
            height="26"
            rx="5"
            fill="#fff"
            stroke="#111827"
            strokeWidth="1.5"
          />
          <text
            x="18"
            y="23.5"
            textAnchor="middle"
            fontSize="17"
            fontWeight="800"
            fontFamily="Georgia, serif"
            fill="#111827"
          >
            N
          </text>
        </svg>
      `;
    case 'slack':
      return html`
        <svg viewBox="0 0 36 36" className="h-full w-full" aria-hidden="true">
          <rect width="36" height="36" rx="9" fill="#fff" />
          <rect x="10" y="15" width="6" height="16" rx="3" fill="#36c5f0" />
          <rect x="5" y="20" width="16" height="6" rx="3" fill="#36c5f0" />
          <rect x="20" y="5" width="6" height="16" rx="3" fill="#2eb67d" />
          <rect x="15" y="10" width="16" height="6" rx="3" fill="#2eb67d" />
          <rect x="20" y="15" width="6" height="16" rx="3" fill="#ecb22e" />
          <rect x="15" y="20" width="16" height="6" rx="3" fill="#ecb22e" />
          <rect x="10" y="5" width="6" height="16" rx="3" fill="#e01e5a" />
          <rect x="5" y="10" width="16" height="6" rx="3" fill="#e01e5a" />
        </svg>
      `;
    case 'google-drive':
      return html`
        <svg viewBox="0 0 36 36" className="h-full w-full" aria-hidden="true">
          <rect width="36" height="36" rx="9" fill="#fff" />
          <path d="M14.5 7h7l8.5 14.7h-7L14.5 7Z" fill="#0f9d58" />
          <path d="M6 21.7 14.5 7l3.5 6.1-5 8.6H6Z" fill="#f4b400" />
          <path d="M13 21.7h17L26.5 28h-17L13 21.7Z" fill="#4285f4" />
        </svg>
      `;
    case 'google-sheets':
      return html`<${GoogleBarsIcon} letter="S" />`;
    case 'github':
      return html`
        <svg viewBox="0 0 36 36" className="h-full w-full" aria-hidden="true">
          <rect width="36" height="36" rx="9" fill="#111827" />
          <circle cx="18" cy="18" r="9" fill="#fff" />
          <path
            d="M14.2 26.5c.6-1.4.4-2.4 0-3.1-2.9.2-4.1-1.2-4.6-2.4-.3-.7-.7-1.1-1.3-1.6-.4-.3-.1-.6.5-.5 1.1.2 1.8 1.2 2.2 1.8.9 1.5 2.5 1.3 3.3 1 .1-.7.5-1.3 1-1.6-2.6-.3-5.2-1.3-5.2-5.4 0-1.2.4-2.2 1.1-3-.1-.3-.5-1.5.1-3 0 0 .9-.3 3 1.1.9-.2 1.8-.4 2.7-.4s1.9.1 2.7.4c2.1-1.4 3-1.1 3-1.1.6 1.5.2 2.7.1 3 .7.8 1.1 1.8 1.1 3 0 4.1-2.6 5.1-5.2 5.4.7.6 1.2 1.6 1.2 3.2v3.1"
            fill="#111827"
          />
        </svg>
      `;
    case 'telegram':
      return html`
        <svg viewBox="0 0 36 36" className="h-full w-full" aria-hidden="true">
          <rect width="36" height="36" rx="9" fill="#27a7e7" />
          <path
            d="M27.8 9.4 23 27.1c-.3 1.2-1.2 1.5-2.3.9l-6.4-4.7-3.1 3c-.3.3-.6.6-1.2.6l.4-6.6L22.5 11c.5-.5-.1-.7-.8-.3L7.1 19.9c-1.1.3-1.9-.1-2.1-.8-.2-.6.5-1.1 1.4-1.4l19.5-7.5c.9-.3 1.7.2 1.9 1.2Z"
            fill="#fff"
          />
        </svg>
      `;
    case 'workspace':
      return html`<${Icon} name="folder" className="h-5 w-5 text-[var(--v2-text-muted)]" />`;
    case 'web':
      return html`<${Icon} name="search" className="h-5 w-5 text-[var(--v2-info-text)]" />`;
    case 'routine':
      return html`<${Icon} name="clock" className="h-5 w-5 text-[var(--v2-warning-text)]" />`;
    case 'channel':
      return html`<${Icon} name="send" className="h-5 w-5 text-[var(--v2-text-muted)]" />`;
    case 'knowledge':
      return html`<${Icon} name="layers" className="h-5 w-5 text-[var(--v2-text-muted)]" />`;
    default:
      return html`<${Icon} name="plug" className="h-5 w-5 text-[var(--v2-text-muted)]" />`;
  }
}

export function ConnectorAppIcon({ source, className = '' }) {
  const kind = connectorIconKind(source);
  return html`
    <span
      aria-hidden="true"
      data-testid="connector-app-icon"
      data-connector-icon=${kind}
      className=${[APP_ICON, className].filter(Boolean).join(' ')}
    >
      ${connectorGlyph(kind)}
    </span>
  `;
}

/* Lightweight overflow menu. Real <button>s; closes on outside click. */
function OverflowMenu({ actions, isBusy }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);

  React.useEffect(() => {
    if (!open) return undefined;
    const onDoc = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return html`
    <div ref=${ref} className="relative shrink-0">
      <button
        type="button"
        aria-label="More actions"
        aria-haspopup="true"
        aria-expanded=${open ? 'true' : 'false'}
        disabled=${isBusy}
        onClick=${() => setOpen((v) => !v)}
        className="grid h-11 w-11 -mr-1.5 -mt-1.5 place-items-center rounded-md border border-transparent text-[var(--v2-text-faint)] hover:bg-[var(--v2-surface-muted)] hover:text-[var(--v2-text-strong)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <${Icon} name="more" className="h-4 w-4" strokeWidth=${2.4} />
      </button>
      ${open &&
      html`
        <div
          role="menu"
          className="absolute right-0 top-8 z-10 min-w-[156px] rounded-[10px] border border-[var(--v2-panel-border)] bg-[var(--v2-surface)] p-1 shadow-[0_20px_40px_-20px_rgba(0,0,0,0.7)]"
        >
          ${actions.map(
            (action) => html`
              <button
                key=${action.id}
                type="button"
                role="menuitem"
                disabled=${isBusy}
                onClick=${() => {
                  setOpen(false);
                  action.run();
                }}
                className=${[
                  'flex min-h-[44px] w-full items-center gap-2.5 rounded-[7px] px-2.5 py-1.5 text-left text-[13px] disabled:cursor-not-allowed disabled:opacity-50',
                  action.danger
                    ? 'text-[var(--v2-danger-text)] hover:bg-[var(--v2-danger-soft)]'
                    : 'text-[var(--v2-text)] hover:bg-[var(--v2-surface-soft)]'
                ].join(' ')}
              >
                <${Icon} name=${action.icon || 'settings'} className="h-3.5 w-3.5" />
                ${action.label}
              </button>
            `
          )}
        </div>
      `}
    </div>
  `;
}

function ChipGrid({ items }) {
  if (!items || items.length === 0) return null;
  return html`
    <div className="mt-3 flex flex-wrap gap-1">
      ${items.map((item) => html`<span key=${item} className=${CHIP}>${item}</span>`)}
    </div>
  `;
}

function ConnectorGuidance({ guidance, fallback }) {
  const body = fallback || guidance?.body;
  if (!body && !guidance?.title) return null;

  return html`
    <div
      className="mt-3 rounded-[12px] border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] px-3 py-2 text-xs leading-5 text-[var(--v2-text-muted)]"
    >
      ${guidance?.title &&
      html`
        <div className="mb-0.5 font-semibold text-[var(--v2-text-strong)]">${guidance.title}</div>
      `}
      ${body && html`<div>${body}</div>`}
      ${guidance?.href &&
      html`
        <${Button}
          as="a"
          href=${guidance.href}
          variant="secondary"
          size="sm"
          className="mt-2 min-h-[44px] px-2.5 text-xs"
        >
          ${guidance.actionLabel || 'Open setup'}
        <//>
      `}
    </div>
  `;
}

export function ExtensionCard({ ext, onActivate, onConfigure, onRemove, isBusy }) {
  const state =
    ext.onboarding_state || ext.activation_status || (ext.active ? 'active' : 'installed');
  const tone = STATE_TONES[state] || 'muted';
  const label = STATE_LABELS[state] || state;
  const kindLabel = KIND_LABELS[ext.kind] || ext.kind;
  const displayName = ext.display_name || packageId(ext);
  const canManage = Boolean(ext.package_ref);
  const tools = ext.tools || [];
  const [capsOpen, setCapsOpen] = React.useState(false);

  const setupState = state === 'setup_required' || state === 'auth_required';
  const onboardingHint =
    (setupState
      ? ext.onboarding?.credential_instructions || ext.onboarding?.credential_next_step
      : ext.onboarding?.credential_next_step || ext.onboarding?.credential_instructions) || null;
  const guidance = connectorSetupGuidance(ext, { state });

  const configurePayload = { packageRef: ext.package_ref, displayName };

  const primaryActions = [];
  const overflowActions = [];
  const primaryAction = primaryExtensionAction(ext);

  if (primaryAction === 'configure') {
    primaryActions.push({
      id: 'configure',
      label: ext.authenticated ? 'Reconfigure' : 'Configure',
      run: () => onConfigure(configurePayload)
    });
  } else if (primaryAction === 'activate') {
    primaryActions.push({
      id: 'activate',
      label: 'Activate',
      run: () => onActivate(configurePayload)
    });
  }
  if (canManage && (ext.needs_setup || ext.has_auth) && primaryAction !== 'configure') {
    overflowActions.push({
      id: 'configure',
      label: ext.authenticated ? 'Reconfigure' : 'Configure',
      icon: 'settings',
      run: () => onConfigure(configurePayload)
    });
  }
  if (
    canManage &&
    ext.kind === 'wasm_channel' &&
    (state === 'setup_required' || state === 'failed')
  ) {
    overflowActions.push({
      id: 'setup',
      label: 'Setup',
      icon: 'settings',
      run: () => onConfigure(configurePayload)
    });
  }
  if (
    canManage &&
    ext.kind === 'wasm_channel' &&
    (state === 'active' || state === 'ready' || state === 'pairing_required' || state === 'pairing')
  ) {
    overflowActions.push({
      id: 'reconfigure',
      label: 'Reconfigure',
      icon: 'settings',
      run: () => onConfigure(configurePayload)
    });
  }
  if (canManage) {
    overflowActions.push({
      id: 'remove',
      label: 'Remove',
      icon: 'trash',
      danger: true,
      run: () => onRemove(configurePayload)
    });
  }

  const primary = primaryActions[0];
  const showFooter = tools.length > 0 || Boolean(primary);

  return html`
    <div className=${CARD}>
      <div className="flex items-start gap-3">
        <${ConnectorAppIcon} source=${ext} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-sm font-semibold text-[var(--v2-text-strong)]">
              ${displayName}
            </span>
            <${Badge} tone=${tone} label=${label} size="sm" />
          </div>
          <div className=${META}>
            <span>${kindLabel}</span>
            ${ext.version && html`<span>· v${ext.version}</span>`}
          </div>
        </div>
        ${overflowActions.length > 0 &&
        html`<${OverflowMenu} actions=${overflowActions} isBusy=${isBusy} />`}
      </div>

      ${ext.description && html`<p className=${DESC}>${ext.description}</p>`}
      ${ext.activation_error &&
      html`
        <div
          className="mt-2 rounded-[10px] border border-[color-mix(in_srgb,var(--v2-danger-text)_36%,var(--v2-panel-border))] bg-[var(--v2-danger-soft)] px-3 py-1.5 text-xs text-[var(--v2-danger-text)]"
        >
          ${ext.activation_error}
        </div>
      `}
      <${ConnectorGuidance} guidance=${guidance} fallback=${onboardingHint} />

      ${showFooter &&
      html`
        <div className=${FOOTER}>
          ${tools.length > 0 &&
          html`
            <button
              type="button"
              aria-expanded=${capsOpen ? 'true' : 'false'}
              onClick=${() => setCapsOpen((v) => !v)}
              className=${DISCLOSURE}
            >
              <${Icon} name="layers" className="h-3.5 w-3.5" />
              <span>${tools.length} ${tools.length === 1 ? 'capability' : 'capabilities'}</span>
              <${Icon}
                name="chevron"
                className=${['h-3 w-3', capsOpen ? 'rotate-180' : ''].join(' ')}
              />
            </button>
          `}
          <span className="flex-1"></span>
          ${primary &&
          html`
            <${Button}
              variant="secondary"
              size="sm"
              className="min-h-[44px] px-3.5"
              onClick=${primary.run}
              disabled=${isBusy}
            >
              ${primary.label}
            <//>
          `}
        </div>
      `}
      ${capsOpen && html`<${ChipGrid} items=${tools} />`}
    </div>
  `;
}

export function RegistryCard({ entry, onInstall, isBusy, onConnect, onManualSetup, connectPhase }) {
  const kindLabel = KIND_LABELS[entry.kind] || entry.kind;
  const displayName = entry.display_name || packageId(entry);
  const canInstall = Boolean(entry.package_ref);
  const keywords = entry.keywords || [];
  const [kwOpen, setKwOpen] = React.useState(false);
  const connectButton = registryConnectButtonState(connectPhase, entry);
  const guidance = connectorSetupGuidance(entry, { connectPhase });
  const statusBadge = registryStatusBadge(entry, connectPhase);
  const runConnectAction = () => {
    if (connectButton.action === 'manual_setup' && onManualSetup) {
      onManualSetup(entry);
      return;
    }
    if (onConnect) {
      onConnect(entry);
      return;
    }
    onInstall({ packageRef: entry.package_ref, displayName });
  };
  const showFooter = keywords.length > 0 || canInstall;

  return html`
    <div
      className=${CARD}
      data-testid=${`registry-card-${entry.id || packageId(entry)}`}
      data-package-ref=${entry.package_ref?.id || ''}
    >
      <div className="flex items-start gap-3">
        <${ConnectorAppIcon} source=${entry} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-sm font-semibold text-[var(--v2-text-strong)]">
              ${displayName}
            </span>
            <${Badge} tone=${statusBadge.tone} label=${statusBadge.label} size="sm" />
          </div>
          <div className=${META}>
            <span>${kindLabel}</span>
            ${entry.version && html`<span>· v${entry.version}</span>`}
          </div>
        </div>
      </div>

      ${entry.description && html`<p className=${DESC}>${entry.description}</p>`}
      ${connectPhase?.phase === 'error' &&
      connectPhase?.message &&
      html`
        <div
          className="mt-2 rounded-[10px] border border-[color-mix(in_srgb,var(--v2-danger-text)_36%,var(--v2-panel-border))] bg-[var(--v2-danger-soft)] px-3 py-1.5 text-xs text-[var(--v2-danger-text)]"
        >
          ${connectPhase.message}
        </div>
      `}
      <${ConnectorGuidance}
        guidance=${guidance}
        fallback=${connectPhase?.phase === 'blocked-google-client-id'
          ? connectPhase?.message
          : null}
      />

      ${showFooter &&
      html`
        <div className=${FOOTER}>
          ${keywords.length > 0 &&
          html`
            <button
              type="button"
              aria-expanded=${kwOpen ? 'true' : 'false'}
              onClick=${() => setKwOpen((v) => !v)}
              className=${DISCLOSURE}
            >
              <${Icon} name="list" className="h-3.5 w-3.5" />
              <span>${keywords.length} ${keywords.length === 1 ? 'keyword' : 'keywords'}</span>
              <${Icon}
                name="chevron"
                className=${['h-3 w-3', kwOpen ? 'rotate-180' : ''].join(' ')}
              />
            </button>
          `}
          <span className="flex-1"></span>
          ${canInstall &&
          connectButton.href &&
          html`
            <${Button}
              as="a"
              href=${connectButton.href}
              variant=${connectButton.variant}
              size="sm"
              className="min-h-[44px] px-3.5"
              aria-disabled=${isBusy || connectButton.disabled ? 'true' : 'false'}
            >
              ${connectButton.label}
            <//>
          `}
          ${canInstall &&
          !connectButton.href &&
          html`
            <${Button}
              variant=${connectButton.variant}
              size="sm"
              className="min-h-[44px] px-3.5"
              onClick=${runConnectAction}
              disabled=${isBusy || connectButton.disabled}
            >
              ${connectButton.action === 'connect' &&
              html`<${Icon} name="plus" className="mr-1.5 h-3.5 w-3.5" />`}
              ${connectButton.label}
            <//>
          `}
        </div>
      `}
      ${kwOpen && html`<${ChipGrid} items=${keywords} />`}
    </div>
  `;
}
