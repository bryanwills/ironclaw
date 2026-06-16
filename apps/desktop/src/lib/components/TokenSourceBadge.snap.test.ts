// Snapshot tests for TokenSourceBadge — one per source. With
// `forcedSource` set, the badge renders synchronously off the prop
// (no IPC, no polling), so the snapshot is deterministic and small.
//
// These complement the wrapper-level vitest specs in
// `src/lib/stores/token-source.test.ts` (which exercise the IPC path).

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';

import TokenSourceBadge from './TokenSourceBadge.svelte';

describe('TokenSourceBadge snapshots', () => {
  it('matches the keychain (normal) snapshot', () => {
    const { container } = render(TokenSourceBadge, {
      props: { forcedSource: 'keychain' }
    });
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('matches the file fallback (degraded) snapshot', () => {
    const { container } = render(TokenSourceBadge, {
      props: { forcedSource: 'file' }
    });
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('matches the absent snapshot', () => {
    const { container } = render(TokenSourceBadge, {
      props: { forcedSource: 'absent' }
    });
    expect(container.innerHTML).toMatchSnapshot();
  });
});
