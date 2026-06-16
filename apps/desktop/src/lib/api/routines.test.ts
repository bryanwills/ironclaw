import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRoutine } from './routines';

function fetchJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function opts() {
  return { baseUrl: 'http://example.test/', token: 'tok' };
}

describe('createRoutine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts the typed create body with auth and maps gateway routine fields', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      fetchJson({
        id: 'r1',
        name: 'Morning',
        enabled: true,
        trigger_summary: '0 9 * * *',
        last_run_at: '2026-05-30T12:00:00Z',
        next_fire_at: '2026-05-31T12:00:00Z'
      })
    );

    const result = await createRoutine(opts(), {
      name: '  Morning  ',
      schedule: '  0 9 * * *  ',
      prompt: '  Summarize my day  ',
      enabled: true
    });

    expect(result).toEqual({
      ok: true,
      routine: {
        id: 'r1',
        name: 'Morning',
        schedule: '0 9 * * *',
        enabled: true,
        last_run: '2026-05-30T12:00:00Z',
        next_run: '2026-05-31T12:00:00Z'
      }
    });
    expect(fetchSpy).toHaveBeenCalledWith('http://example.test/api/routines', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer tok',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'Morning',
        schedule: '0 9 * * *',
        prompt: 'Summarize my day',
        enabled: true
      })
    });
  });

  it('returns unavailable instead of throwing for not-implemented gateways', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fetchJson({ error: 'not found' }, 404));

    await expect(
      createRoutine(opts(), {
        name: 'Morning',
        schedule: '0 9 * * *',
        prompt: 'Summarize my day',
        enabled: true
      })
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });
});
