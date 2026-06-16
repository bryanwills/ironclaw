import { appScopedPath } from '../../../lib/app-path.js';

export function primaryExtensionAction(ext) {
  const state =
    ext?.onboarding_state || ext?.activation_status || (ext?.active ? 'active' : 'installed');

  if (!ext?.package_ref || state === 'active' || state === 'ready') {
    return null;
  }

  if (state === 'auth_required' || state === 'setup_required' || state === 'failed') {
    return 'configure';
  }

  if (ext.kind === 'wasm_channel') {
    return null;
  }

  return 'activate';
}

export const GOOGLE_OAUTH_SETTINGS_PATH = '/settings/inference#google-oauth';

export function googleOauthSettingsHref() {
  return appScopedPath(GOOGLE_OAUTH_SETTINGS_PATH);
}

const GOOGLE_CONNECTORS = new Set([
  'google',
  'gmail',
  'google-calendar',
  'google-drive',
  'google-sheets',
  'google-docs'
]);

export function connectorKey(source) {
  const ref = source?.package_ref || source?.packageRef || source;
  const raw =
    (typeof ref === 'string' ? ref : ref?.id) ||
    source?.id ||
    source?.display_name ||
    source?.name ||
    '';
  const catalogName = String(raw).includes('/')
    ? String(raw).split('/').filter(Boolean).pop()
    : String(raw);
  const normalized = catalogName.trim().toLowerCase().replaceAll('_', '-');
  if (normalized === 'slack-tool') return 'slack';
  return normalized;
}

export function connectorFamily(source) {
  const key = connectorKey(source);
  if (GOOGLE_CONNECTORS.has(key)) return 'google';
  if (key.includes('notion')) return 'notion';
  if (key.includes('slack')) return 'slack';
  if (key.includes('workspace') || key.includes('filesystem') || key.includes('file-system')) {
    return 'workspace';
  }
  return key;
}

export function isGoogleConnector(source) {
  return connectorFamily(source) === 'google';
}

export function connectorSetupGuidance(source, { state, connectPhase } = {}) {
  const family = connectorFamily(source);
  const phase = connectPhase?.phase || '';

  if (family === 'google' && (phase === 'blocked-google-client-id' || phase === 'needs-token')) {
    return {
      title: 'Needs Google sign-in setup',
      body: 'Hosted Google OAuth is not available from this gateway yet. Add a Desktop app client ID in Settings, restart the engine, then connect Gmail or Calendar.',
      href: googleOauthSettingsHref(),
      actionLabel: 'Open Google setup'
    };
  }

  if (family === 'google' && (state === 'setup_required' || state === 'auth_required')) {
    return {
      title: 'Needs Google sign-in setup',
      body: 'Gmail and Calendar need a Google Desktop app client ID before browser sign-in can start.',
      href: googleOauthSettingsHref(),
      actionLabel: 'Open Google setup'
    };
  }

  if (phase === 'waiting') {
    return {
      title: 'Finish in your browser',
      body: 'Complete the consent screen, then IronClaw will turn the connector on automatically.'
    };
  }

  if (phase === 'connected' || state === 'active' || state === 'ready') {
    return {
      title: 'Connected',
      body: 'The connector is ready for chat and agent runs.'
    };
  }

  if (family === 'notion') {
    return {
      title: 'Connect with Notion',
      body:
        phase === 'needs-token'
          ? 'Notion needs authorization before its tools can run. Open setup to connect the workspace this gateway exposes.'
          : 'Connect opens Notion in your browser. No token paste should be required when the gateway supports DCR.'
    };
  }

  if (family === 'slack') {
    return {
      title: 'Connect Slack',
      body: 'Slack uses workspace install or pairing. If a code is required, enter it here after messaging the Slack app.'
    };
  }

  if (family === 'workspace') {
    return {
      title: 'Workspace setup',
      body: 'Workspace access should ask for a local folder or account only when the gateway exposes that setup path.'
    };
  }

  if (phase === 'needs-token') {
    return {
      title: 'Needs setup',
      body: 'This connector needs credentials before its tools can be turned on.',
      actionLabel: 'Open setup'
    };
  }

  if (state === 'setup_required' || state === 'auth_required') {
    return {
      title: 'Needs setup',
      body: 'Complete setup before this connector is available to the assistant.'
    };
  }

  return null;
}

export function registryStatusBadge(entry, connectPhase) {
  const phase = connectPhase?.phase || '';

  if (phase === 'blocked-google-client-id') {
    return { tone: 'danger', label: 'BLOCKED' };
  }

  if (phase === 'needs-token' || connectorSetupGuidance(entry, { connectPhase })?.title) {
    return { tone: 'warning', label: 'NEEDS SETUP' };
  }

  return { tone: 'muted', label: 'AVAILABLE' };
}

export function setupReadyForActivation({ secrets = [], fields = [] } = {}) {
  if (fields.length > 0 || secrets.length === 0) {
    return false;
  }
  return secrets.every((secret) => secret.provided);
}

export function registryConnectButtonState(connectPhase = {}, entry = null) {
  if (
    isGoogleConnector(entry) &&
    (connectPhase?.phase === 'blocked-google-client-id' || connectPhase?.phase === 'needs-token')
  ) {
    return {
      label: 'Open Google setup',
      disabled: false,
      action: 'google_settings',
      variant: 'secondary',
      href: googleOauthSettingsHref()
    };
  }

  switch (connectPhase?.phase) {
    case 'installing':
    case 'authorizing':
      return { label: 'Connecting...', disabled: true, action: 'wait', variant: 'primary' };
    case 'waiting':
      return {
        label: 'Finish in your browser...',
        disabled: true,
        action: 'wait',
        variant: 'primary'
      };
    case 'activating':
      return { label: 'Turning on...', disabled: true, action: 'wait', variant: 'primary' };
    case 'connected':
      return { label: 'Connected', disabled: true, action: 'none', variant: 'secondary' };
    case 'blocked-google-client-id':
      return {
        label: 'Open Google setup',
        disabled: false,
        action: 'google_settings',
        variant: 'secondary',
        href: googleOauthSettingsHref()
      };
    case 'needs-token':
      return { label: 'Open setup', disabled: false, action: 'manual_setup', variant: 'secondary' };
    case 'error':
      return { label: 'Retry connect', disabled: false, action: 'connect', variant: 'primary' };
    default:
      return { label: 'Connect', disabled: false, action: 'connect', variant: 'primary' };
  }
}
