// Tests for the sign-in state machine (R5d/R44 — NEAR.AI sign-in detection).
// refresh() maps GET /api/profile outcomes onto a coarse status with
// transition-gated toasts. We override the real connection.client getter
// (never vi.mock a sibling .svelte.ts) and spy toasts.show. The store's
// constructor wires an $effect.root watching connection.status; we don't
// exercise that reactive path here — we drive refresh()/reset() directly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { signIn } from './sign-in.svelte';
import { connection } from './connection.svelte';
import { toasts } from './toasts.svelte';

function setClient(c: unknown): void {
  Object.defineProperty(connection, 'client', { configurable: true, get: () => c });
}

function fakeClient(getProfile: ReturnType<typeof vi.fn>) {
  return { getProfile };
}

// Minimal UserProfile-ish shape; refresh only reads these fields.
function profile(over: Record<string, unknown> = {}) {
  return { user_id: 'u1', ...over };
}

beforeEach(() => {
  signIn.reset();
  signIn.inflight = false;
  signIn.profile = null;
  signIn.status = 'unknown';
  signIn.lastError = null;
  setClient(null);
});

afterEach(() => {
  signIn.reset();
  vi.restoreAllMocks();
});

describe('signIn.refresh', () => {
  it('stays "unknown" with no connected client', async () => {
    setClient(null);
    await signIn.refresh();
    expect(signIn.status).toBe('unknown');
    expect(signIn.lastError).toBeNull();
  });

  it('maps a null profile to signed-out (no toast from unknown)', async () => {
    const show = vi.spyOn(toasts, 'show');
    setClient(fakeClient(vi.fn().mockResolvedValue(null)));
    await signIn.refresh();
    expect(signIn.status).toBe('signed-out');
    expect(signIn.profile).toBeNull();
    expect(show).not.toHaveBeenCalled();
  });

  it('toasts "Signed out" only on a signed-in → signed-out transition', async () => {
    const show = vi.spyOn(toasts, 'show');
    signIn.status = 'signed-in';
    setClient(fakeClient(vi.fn().mockResolvedValue(null)));
    await signIn.refresh();
    expect(signIn.status).toBe('signed-out');
    expect(show).toHaveBeenCalledWith('Signed out from NEAR.AI', 'info');
  });

  it('maps a profile to signed-in and toasts the account label', async () => {
    const show = vi.spyOn(toasts, 'show');
    setClient(fakeClient(vi.fn().mockResolvedValue(profile({ near_account: 'alice.near' }))));
    await signIn.refresh();
    expect(signIn.status).toBe('signed-in');
    expect(signIn.profile).toMatchObject({ near_account: 'alice.near' });
    expect(show).toHaveBeenCalledWith('Signed in as alice.near', 'success');
  });

  it('falls back through display_name → user_id → "NEAR.AI" for the label', async () => {
    const show = vi.spyOn(toasts, 'show');

    setClient(fakeClient(vi.fn().mockResolvedValue(profile({ display_name: 'Alice' }))));
    await signIn.refresh();
    expect(show).toHaveBeenLastCalledWith('Signed in as Alice', 'success');

    signIn.status = 'unknown';
    setClient(fakeClient(vi.fn().mockResolvedValue({ user_id: 'uid-9' })));
    await signIn.refresh();
    expect(show).toHaveBeenLastCalledWith('Signed in as uid-9', 'success');

    signIn.status = 'unknown';
    setClient(fakeClient(vi.fn().mockResolvedValue({})));
    await signIn.refresh();
    expect(show).toHaveBeenLastCalledWith('Signed in as NEAR.AI', 'success');
  });

  it('does not re-toast when already signed-in', async () => {
    const show = vi.spyOn(toasts, 'show');
    signIn.status = 'signed-in';
    setClient(fakeClient(vi.fn().mockResolvedValue(profile({ near_account: 'a.near' }))));
    await signIn.refresh();
    expect(signIn.status).toBe('signed-in');
    expect(show).not.toHaveBeenCalled();
  });

  it('maps a thrown error to status "error" with lastError', async () => {
    setClient(fakeClient(vi.fn().mockRejectedValue(new Error('gateway 500'))));
    await signIn.refresh();
    expect(signIn.status).toBe('error');
    expect(signIn.lastError).toBe('gateway 500');
  });

  it('collapses concurrent refreshes via the inflight guard', async () => {
    const getProfile = vi.fn().mockResolvedValue(null);
    setClient(fakeClient(getProfile));
    signIn.inflight = true;
    await signIn.refresh();
    expect(getProfile).not.toHaveBeenCalled();
  });
});

describe('signIn.reset', () => {
  it('clears profile/status/error back to a clean slate', () => {
    signIn.profile = profile() as never;
    signIn.status = 'signed-in';
    signIn.lastError = 'x';
    signIn.reset();
    expect(signIn.profile).toBeNull();
    expect(signIn.status).toBe('unknown');
    expect(signIn.lastError).toBeNull();
  });
});
