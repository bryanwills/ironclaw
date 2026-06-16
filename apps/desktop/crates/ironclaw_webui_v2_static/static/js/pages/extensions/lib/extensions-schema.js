export const EXTENSIONS_TABS = [
  { id: 'installed', label: 'My apps', icon: 'bolt' },
  { id: 'channels', label: 'Messaging', icon: 'send' },
  { id: 'mcp', label: 'Knowledge', icon: 'pulse' },
  { id: 'registry', label: 'Browse', icon: 'plus' }
];

export const KIND_LABELS = {
  wasm_tool: 'Tool',
  wasm_channel: 'Messaging app',
  mcp_server: 'Knowledge app',
  first_party: 'Built-in',
  system: 'System',
  channel_relay: 'Relay'
};

export const STATE_TONES = {
  active: 'success',
  ready: 'success',
  pairing_required: 'warning',
  pairing: 'warning',
  auth_required: 'warning',
  setup_required: 'muted',
  failed: 'danger',
  installed: 'muted'
};

export const STATE_LABELS = {
  active: 'active',
  ready: 'ready',
  pairing_required: 'pairing',
  pairing: 'pairing',
  auth_required: 'auth needed',
  setup_required: 'setup needed',
  failed: 'failed',
  installed: 'installed'
};
