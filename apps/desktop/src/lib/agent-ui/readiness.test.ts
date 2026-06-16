import { describe, it, expect } from 'vitest';
import { agentUiReadiness } from './readiness.svelte';

describe('agentUiReadiness', () => {
  it('reports supported when the gateway can delegate client tools', () => {
    const r = agentUiReadiness({ clientToolDelegation: true });
    expect(r.supported).toBe(true);
    expect(r.label).toBe('Supported');
    expect(r.detail).toMatch(/drive the app/i);
  });

  it('reports unsupported when the gateway cannot delegate', () => {
    const r = agentUiReadiness({ clientToolDelegation: false });
    expect(r.supported).toBe(false);
    expect(r.label).toBe('Not supported by this gateway');
    expect(r.detail).toMatch(/can't drive the app/i);
  });

  it('treats an absent capability as unsupported (honest default)', () => {
    const r = agentUiReadiness({});
    expect(r.supported).toBe(false);
    expect(r.label).toBe('Not supported by this gateway');
  });

  it('never claims desktop control in the unsupported detail copy', () => {
    const detail = agentUiReadiness({}).detail.toLowerCase();
    // Must not imply the agent can drive the desktop today.
    expect(detail).not.toMatch(/can (drive|control|operate) the (desktop|app|ui)/);
  });
});
