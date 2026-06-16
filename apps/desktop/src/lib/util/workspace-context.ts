import type { Extension } from '$lib/api/types';
import {
  CONNECTOR_PACKS,
  connectorPackStatus,
  type ConnectorPack,
  type ConnectorPackId,
  type ConnectorPackStatus
} from '$lib/data/connector-packs';
import type { ContextItem } from '$lib/util/mission-generator';

export interface WorkspaceContextSource {
  id: ConnectorPackId;
  label: string;
  status: ConnectorPackStatus;
  summary: string;
  prompt: string;
}

const SOURCE_PROMPTS: Record<ConnectorPackId, { summary: string; prompt: string }> = {
  google: {
    summary: 'Gmail and Calendar read-only sweep',
    prompt:
      'Google Workspace is connected. Use available Gmail and Google Calendar read tools to inspect recent high-signal email, unread asks, commitments, and upcoming meetings. Do not send, archive, label, schedule, or write anything. If a Google tool is unavailable or returns no useful data, say that explicitly in the context you return.'
  },
  notion: {
    summary: 'Notion plans and project memory sweep',
    prompt:
      'Notion is connected. Use available Notion read tools to inspect active project pages, CRM/status databases, decisions, blockers, and stale follow-ups. Do not create pages, edit properties, or write notes. If Notion tools are unavailable or no relevant pages are found, say that explicitly in the context you return.'
  },
  slack: {
    summary: 'Slack mentions and thread sweep',
    prompt:
      'Slack is connected. Use available Slack read tools to inspect recent mentions, direct messages, and high-signal channel threads for decisions, asks, and replies owed. Do not send, react, assign, archive, or update Slack. If Slack tools are unavailable or no relevant threads are found, say that explicitly in the context you return.'
  }
};

function installedMap(extensions: Extension[]): Map<string, Extension> {
  return new Map(extensions.map((ext) => [ext.name, ext]));
}

function sourceFromPack(pack: ConnectorPack, extensions: Extension[]): WorkspaceContextSource {
  const status = connectorPackStatus(pack, installedMap(extensions));
  const copy = SOURCE_PROMPTS[pack.id];
  return {
    id: pack.id,
    label: pack.display_name,
    status,
    summary: copy.summary,
    prompt: copy.prompt
  };
}

export function workspaceContextSources(extensions: Extension[]): WorkspaceContextSource[] {
  return CONNECTOR_PACKS.map((pack) => sourceFromPack(pack, extensions));
}

export function connectedWorkspaceSources(
  extensions: Extension[],
  selectedIds?: ReadonlySet<ConnectorPackId> | ConnectorPackId[]
): WorkspaceContextSource[] {
  const selected =
    selectedIds instanceof Set
      ? selectedIds
      : Array.isArray(selectedIds)
        ? new Set(selectedIds)
        : null;
  return workspaceContextSources(extensions).filter(
    (source) => source.status === 'connected' && (!selected || selected.has(source.id))
  );
}

export function workspaceContextItems(sources: WorkspaceContextSource[]): ContextItem[] {
  return sources.map((source) => ({
    kind: 'activity',
    label: `Connected source: ${source.label}`,
    body: `Read-only collection request. ${source.prompt}`
  }));
}
