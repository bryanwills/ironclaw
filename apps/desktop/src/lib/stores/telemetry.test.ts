// Unit tests for the opt-in telemetry store. We seed `enabled`/`endpoint`
// $state directly (rather than via setEnabled/setEndpoint) so we don't arm the
// real 5-minute setInterval, and stopTimer() in beforeEach/afterEach guarantees
// no dangling handle leaks between tests. fetch is stubbed for the flush paths.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { telemetry } from '$lib/stores/telemetry.svelte';

const URL = 'https://telemetry.example/collect';

beforeEach(() => {
  telemetry.stopTimer();
  telemetry.enabled = false;
  telemetry.endpoint = '';
  telemetry.queue = [];
  telemetry.lastFlushAt = null;
});

afterEach(() => {
  telemetry.stopTimer();
  vi.unstubAllGlobals();
});

describe('telemetry recordEvent gating', () => {
  it('is a no-op unless both enabled and endpoint are set', () => {
    telemetry.recordEvent('palette:opened');
    expect(telemetry.queue).toHaveLength(0); // off + no endpoint

    telemetry.enabled = true;
    telemetry.recordEvent('x'); // endpoint still empty
    expect(telemetry.queue).toHaveLength(0);

    telemetry.endpoint = URL;
    telemetry.recordEvent('y'); // both set → buffered
    expect(telemetry.queue).toHaveLength(1);
    expect(telemetry.queue[0].name).toBe('y');
  });

  it('caps the queue at MAX_QUEUE, dropping the oldest events', () => {
    telemetry.enabled = true;
    telemetry.endpoint = URL;
    for (let i = 0; i < 505; i++) telemetry.recordEvent(`e${i}`);
    expect(telemetry.queue).toHaveLength(500);
    expect(telemetry.queue[0].name).toBe('e5'); // first five dropped
    expect(telemetry.queue[499].name).toBe('e504');
  });
});

describe('telemetry setEnabled', () => {
  it('purges the pending queue the moment the user opts out', () => {
    telemetry.enabled = true;
    telemetry.endpoint = URL;
    telemetry.recordEvent('x');
    expect(telemetry.queue).toHaveLength(1);

    telemetry.setEnabled(false);
    expect(telemetry.enabled).toBe(false);
    expect(telemetry.queue).toHaveLength(0);
  });
});

describe('telemetry flush', () => {
  it('posts the queue, clears it, and stamps lastFlushAt on success', async () => {
    telemetry.enabled = true;
    telemetry.endpoint = URL;
    telemetry.recordEvent('x');
    const fetchMock = vi.fn(async () => ({ ok: true }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    await telemetry.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(telemetry.queue).toHaveLength(0);
    expect(typeof telemetry.lastFlushAt).toBe('number');
  });

  it('restores the queue and leaves lastFlushAt null when the POST is not ok', async () => {
    telemetry.enabled = true;
    telemetry.endpoint = URL;
    telemetry.recordEvent('x');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }) as unknown as Response)
    );

    await telemetry.flush();

    expect(telemetry.queue).toHaveLength(1); // restored for retry
    expect(telemetry.lastFlushAt).toBeNull();
  });

  it('is a no-op (no fetch) when the queue is empty', async () => {
    telemetry.enabled = true;
    telemetry.endpoint = URL;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await telemetry.flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
