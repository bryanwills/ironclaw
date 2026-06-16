export type ExtensionKindHint =
  | 'mcp_server'
  | 'wasm_tool'
  | 'wasm_channel'
  | 'channel_relay'
  | 'acp_agent'
  | string;

export interface ExtensionTarget {
  /** Reborn ExtensionName: no registry path prefix, slash, or traversal chars. */
  name: string;
  /** Optional Reborn kind hint used to disambiguate bare registry names. */
  kind?: ExtensionKindHint;
}

const PREFIX_KIND: Record<string, ExtensionKindHint> = {
  tools: 'wasm_tool',
  tool: 'wasm_tool',
  channels: 'wasm_channel',
  channel: 'wasm_channel',
  'mcp-servers': 'mcp_server',
  mcp_servers: 'mcp_server',
  mcp: 'mcp_server',
  'channel-relays': 'channel_relay',
  channel_relays: 'channel_relay',
  acp: 'acp_agent',
  agents: 'acp_agent'
};

const KIND_PREFIX: Record<string, string> = {
  wasm_tool: 'tools',
  tool: 'tools',
  wasm_channel: 'channels',
  channel: 'channels',
  mcp_server: 'mcp-servers',
  mcp: 'mcp-servers',
  channel_relay: 'channel-relays',
  acp_agent: 'acp'
};

function canonicalName(raw: string): string {
  return raw.trim().replace(/-/g, '_');
}

function assertSafeName(name: string, original: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`Invalid extension name: ${original}`);
  }
  return name;
}

function canonicalKind(kind: ExtensionKindHint | undefined): ExtensionKindHint | undefined {
  if (!kind) return undefined;
  const k = String(kind).toLowerCase();
  if (k.includes('mcp')) return 'mcp_server';
  if (k === 'tool' || k === 'wasm_tool' || k.includes('wasm_tool')) return 'wasm_tool';
  if (k === 'channel' || k === 'wasm_channel' || k.includes('wasm_channel')) return 'wasm_channel';
  if (k.includes('relay')) return 'channel_relay';
  if (k.includes('acp')) return 'acp_agent';
  return undefined;
}

export function extensionTarget(ref: string, kindHint?: ExtensionKindHint): ExtensionTarget {
  const trimmed = String(ref ?? '').trim();
  if (!trimmed) return { name: '', kind: canonicalKind(kindHint) };
  if (trimmed.includes('\\')) throw new Error(`Invalid extension name: ${trimmed}`);

  let prefix: string | undefined;
  let rawName = trimmed;
  if (trimmed.includes('/')) {
    const parts = trimmed.split('/');
    if (
      parts.length !== 2 ||
      parts.some((part) => part.length === 0 || part === '.' || part === '..')
    ) {
      throw new Error(`Invalid extension catalog ref: ${trimmed}`);
    }
    prefix = parts[0]?.toLowerCase();
    if (!PREFIX_KIND[prefix]) throw new Error(`Invalid extension catalog ref: ${trimmed}`);
    rawName = parts[1] ?? '';
  }
  const name = assertSafeName(canonicalName(rawName), trimmed);
  return {
    name,
    kind: canonicalKind(kindHint ?? (prefix ? PREFIX_KIND[prefix] : undefined))
  };
}

export function extensionName(ref: string): string {
  return extensionTarget(ref).name;
}

export function extensionRefCandidates(ref: string, kindHint?: ExtensionKindHint): string[] {
  const target = extensionTarget(ref, kindHint);
  const raw = String(ref ?? '').trim();
  const out = new Set<string>();
  if (raw) out.add(raw);
  if (target.name) out.add(target.name);

  const kind = String(target.kind ?? '').toLowerCase();
  const preferredPrefix = KIND_PREFIX[kind];
  if (preferredPrefix && target.name) out.add(`${preferredPrefix}/${target.name}`);

  return [...out].filter(Boolean);
}

export function extensionMatches(
  ref: string,
  candidate: string,
  kindHint?: ExtensionKindHint
): boolean {
  return extensionRefCandidates(ref, kindHint).includes(candidate);
}
