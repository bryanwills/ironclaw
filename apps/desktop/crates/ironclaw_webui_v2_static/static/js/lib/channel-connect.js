import { apiFetch } from './api.js';
import { appScopedPath } from './app-path.js';

const EXTENSION_CONNECT_TARGETS = [
  {
    id: 'gmail',
    display_name: 'Gmail',
    package_ref: { kind: 'extension', id: 'tools/gmail' },
    aliases: ['gmail', 'email', 'inbox', 'google mail']
  },
  {
    id: 'google-calendar',
    display_name: 'Google Calendar',
    package_ref: { kind: 'extension', id: 'tools/google_calendar' },
    aliases: ['google calendar', 'gcal', 'calendar', 'schedule']
  },
  {
    id: 'notion',
    display_name: 'Notion',
    package_ref: { kind: 'extension', id: 'mcp-servers/notion' },
    aliases: ['notion', 'wiki', 'knowledge base', 'team knowledge']
  },
  {
    id: 'slack',
    display_name: 'Slack',
    package_ref: { kind: 'extension', id: 'channels/slack' },
    aliases: ['slack', 'slack account', 'slack workspace']
  },
  {
    id: 'workspace',
    display_name: 'Workspace files',
    package_ref: null,
    aliases: ['workspace', 'local files', 'files', 'documents', 'file system', 'gspace']
  }
];

export function listConnectableChannels() {
  return apiFetch('/api/webchat/v2/channels/connectable');
}

export function resolveChannelConnectCommand(input, channels) {
  if (!looksLikeChannelConnectCommand(input)) return null;
  const text = normalizedWords(input);
  return (
    (channels || []).find((channel) =>
      channelAliases(channel).some((alias) => includesWordPhrase(text, normalizedWords(alias)))
    ) || null
  );
}

export function resolveExtensionConnectCommand(input) {
  if (!looksLikeChannelConnectCommand(input)) return null;
  const text = normalizedWords(input);
  const target = findExtensionConnectTarget(text);
  if (!target) return null;
  return extensionSetupAction(target);
}

export function resolveExtensionRecoveryAction(input) {
  const target = findExtensionConnectTarget(normalizedWords(input));
  if (!target) return null;
  return extensionSetupAction(target);
}

function extensionSetupAction(target) {
  const setupPath =
    target.id === 'workspace'
      ? `/extensions/registry?focus=${encodeURIComponent(target.id)}`
      : `/extensions/registry?setup=1&focus=${encodeURIComponent(target.id)}`;
  return {
    channel: target.id,
    display_name: target.display_name,
    strategy: 'extension_setup_link',
    package_ref: target.package_ref,
    action: {
      title: `Connect ${target.display_name}`,
      label: target.id === 'workspace' ? 'Open file options' : 'Open setup',
      href: appScopedPath(setupPath),
      instructions: connectorInstructions(target.id)
    }
  };
}

export function looksLikeChannelConnectCommand(input) {
  const text = normalizedWords(input);
  if (!text) return false;
  const intent = /(^|\s)(connect|link|pair|setup|set up)(\s|$)/.test(text);
  const target =
    /(^|\s)(account|channel|app|integration|slack|telegram|whatsapp|notion|gmail|email|calendar|gcal|workspace|files|documents|gspace)(\s|$)/.test(
      text
    );
  return intent && target;
}

function channelAliases(channel) {
  return [
    channel?.channel,
    channel?.display_name,
    ...(Array.isArray(channel?.command_aliases) ? channel.command_aliases : [])
  ].filter(Boolean);
}

function normalizedWords(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function includesWordPhrase(text, phrase) {
  if (!phrase) return false;
  return ` ${text} `.includes(` ${phrase} `);
}

function findExtensionConnectTarget(text) {
  return EXTENSION_CONNECT_TARGETS.find((entry) =>
    entry.aliases.some((alias) => includesWordPhrase(text, normalizedWords(alias)))
  );
}

function connectorInstructions(id) {
  switch (id) {
    case 'gmail':
      return 'Open Gmail setup in Connections. Google may require a Desktop app client ID before browser sign-in is available.';
    case 'google-calendar':
      return 'Open Calendar setup in Connections. Google may require a Desktop app client ID before browser sign-in is available.';
    case 'notion':
      return 'Open Notion setup in Connections. When the gateway supports Notion OAuth, this should connect through the browser without token paste.';
    case 'slack':
      return 'Open Slack setup in Connections. If the gateway exposes pairing, enter the workspace code there.';
    case 'workspace':
      return 'Open the Connections file surface. Local files already work through chat attachments; broader workspace browsing stays hidden until the gateway exposes it.';
    default:
      return 'Open Connections to finish setup for this app.';
  }
}
