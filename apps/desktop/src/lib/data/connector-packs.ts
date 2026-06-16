// Workspace Packs are pure data definitions for one-click extension setup.
// The desktop installs these Reborn ExtensionName values through the existing
// `/api/extensions` install + setup + readiness flow. Slash-prefixed catalog
// refs (`tools/gmail`, `channels/slack`) are accepted only as compatibility
// aliases in readiness/deep-link matching; lifecycle APIs must receive bare
// names such as `gmail`, `google_calendar`, `notion`, and `slack`.

import { extensionRefCandidates, type ExtensionKindHint } from '$lib/util/extension-identity';

export type ConnectorAuthKind = 'oauth' | 'dcr' | 'token' | 'none';
export type ConnectorPackId = 'google' | 'notion' | 'slack';
export type ConnectorPackStatus =
  | 'checking'
  | 'unknown'
  | 'locked'
  | 'connected'
  | 'partial'
  | 'needs-auth'
  | 'not-installed';

export interface ConnectorPack {
  id: ConnectorPackId;
  display_name: string;
  description: string;
  extensions: string[];
  core_extensions?: string[];
  extension_kind_hints?: Record<string, ExtensionKindHint>;
  primary_extension_id: string;
  shared_auth: string | null;
  auth_kind: ConnectorAuthKind;
  example_tasks: string[];
}

export const CONNECTOR_PACKS: ConnectorPack[] = [
  {
    id: 'google',
    display_name: 'Google Workspace',
    description:
      'Start with Gmail and Calendar. Add Drive, Docs, Sheets, and Slides for more context.',
    extensions: [
      'gmail',
      'google_calendar',
      'google_docs',
      'google_drive',
      'google_sheets',
      'google_slides'
    ],
    core_extensions: ['gmail', 'google_calendar'],
    extension_kind_hints: {
      gmail: 'wasm_tool',
      google_calendar: 'wasm_tool',
      google_docs: 'wasm_tool',
      google_drive: 'wasm_tool',
      google_sheets: 'wasm_tool',
      google_slides: 'wasm_tool'
    },
    primary_extension_id: 'gmail',
    shared_auth: 'google_oauth_token',
    auth_kind: 'oauth',
    example_tasks: [
      'Summarize unread Gmail and draft the replies I owe.',
      "Find next week's calendar conflicts and gather the relevant Drive context.",
      'Turn this Sheets forecast into a Slides briefing with speaker notes.'
    ]
  },
  {
    id: 'notion',
    display_name: 'Notion',
    description: 'Connect Notion to keep plans, docs, and project memory actionable.',
    extensions: ['notion'],
    core_extensions: ['notion'],
    extension_kind_hints: {
      notion: 'mcp_server'
    },
    primary_extension_id: 'notion',
    shared_auth: null,
    auth_kind: 'dcr',
    example_tasks: [
      'Summarize open project pages and flag overdue decisions.',
      'Create a launch checklist in Notion from this plan.',
      'Update the weekly status page with blockers and next steps.'
    ]
  },
  {
    id: 'slack',
    display_name: 'Slack',
    description: 'Connect Slack to turn conversations into decisions and drafts.',
    extensions: ['slack', 'slack_tool'],
    core_extensions: ['slack', 'slack_tool'],
    extension_kind_hints: {
      slack: 'wasm_channel',
      slack_tool: 'wasm_tool'
    },
    primary_extension_id: 'slack',
    shared_auth: null,
    auth_kind: 'oauth',
    example_tasks: [
      'Summarize missed Slack mentions and list what needs my response.',
      "Draft replies for today's priority Slack threads.",
      'Turn this channel discussion into owners, decisions, and next actions.'
    ]
  }
];

export function connectorPackById(id: string): ConnectorPack | undefined {
  return CONNECTOR_PACKS.find((pack) => pack.id === id);
}

export interface ConnectorReadinessLike {
  name: string;
  ready?: boolean;
  readiness_message?: string;
}

export function isConnectorReady(ext: ConnectorReadinessLike | undefined): boolean {
  return ext?.ready === true || ext?.readiness_message === 'ready';
}

export function connectorNeedsAuth(ext: ConnectorReadinessLike | undefined): boolean {
  return ext?.readiness_message === 'needs_auth';
}

export function connectorPackStatus(
  pack: ConnectorPack,
  source: ReadonlyMap<string, ConnectorReadinessLike>,
  fallback: ConnectorPackStatus = 'not-installed'
): ConnectorPackStatus {
  const entriesByName = new Map(
    pack.extensions.map((name) => {
      let match: ConnectorReadinessLike | undefined;
      for (const candidate of extensionRefCandidates(name, pack.extension_kind_hints?.[name])) {
        const ext = source.get(candidate);
        if (ext) {
          match = ext;
          break;
        }
      }
      return [name, match] as const;
    })
  );
  const entries = Array.from(entriesByName.values());
  const coreEntries = (pack.core_extensions ?? pack.extensions).map((name) => {
    for (const candidate of extensionRefCandidates(name, pack.extension_kind_hints?.[name])) {
      const ext = source.get(candidate);
      if (ext) return ext;
    }
    return undefined;
  });
  const installedCount = entries.filter((ext) => ext !== undefined).length;

  if (installedCount === 0) return fallback;
  if (coreEntries.some((ext) => connectorNeedsAuth(ext))) return 'needs-auth';
  if (coreEntries.every((ext) => isConnectorReady(ext))) return 'connected';
  return 'partial';
}
