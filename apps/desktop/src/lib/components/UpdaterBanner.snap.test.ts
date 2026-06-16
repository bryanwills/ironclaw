// Snapshot tests for UpdaterBanner — one per displayed status. The
// `idle` case is also covered to lock down that the banner renders
// literally nothing when the updater isn't in an interesting state
// (the layout otherwise reserves vertical space and noise here would
// be a regression).
//
// We mock the entire `$lib/stores/updater.svelte` module so the test
// controls `status` / `update` / `progress` / `error` per case without
// having to drive the real `UpdaterStore` rune class — which would in
// turn try to import `@tauri-apps/plugin-updater` and persist to
// localStorage.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';

// Mutable stub. The component reads `updater.status` etc. as plain
// property accesses; runes evaluate to the current value at render
// time so a plain JS object backs them equivalently for snapshot
// purposes (no reactivity assertions here).
//
// Hoisted via `vi.hoisted` so the `vi.mock` factory below (which
// vitest lifts to the top of the file) can capture it without a TDZ
// reference error.
const { updaterStub } = vi.hoisted(() => ({
  updaterStub: {
    status: 'idle' as string,
    update: null as { version: string; notes?: string } | null,
    progress: null as number | null,
    error: null as string | null,
    install: async () => undefined,
    dismiss: () => undefined,
    skipCurrent: () => undefined,
    check: async () => undefined
  }
}));

vi.mock('$lib/stores/updater.svelte', () => ({
  updater: updaterStub
}));

// MarkdownView is imported by the component but only renders when the
// "View release notes" link is clicked (showNotes flips true). None of
// these snapshots exercise that path, so the real import is fine — it
// just sits in the module graph without producing any DOM.

// Import AFTER the mocks so the component sees the stubbed store.
import UpdaterBanner from './UpdaterBanner.svelte';

afterEach(() => {
  updaterStub.status = 'idle';
  updaterStub.update = null;
  updaterStub.progress = null;
  updaterStub.error = null;
});

describe('UpdaterBanner snapshots', () => {
  it('matches the idle (hidden) snapshot', () => {
    updaterStub.status = 'idle';
    const { container } = render(UpdaterBanner);
    // Visible derives `false` on idle — the entire `{#if visible}` block
    // collapses, so the snapshot is just an empty comment marker.
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('matches the available snapshot', () => {
    updaterStub.status = 'available';
    updaterStub.update = { version: '0.1.14' };
    const { container } = render(UpdaterBanner);
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('matches the downloading snapshot', () => {
    updaterStub.status = 'downloading';
    updaterStub.update = { version: '0.1.14' };
    updaterStub.progress = 42;
    const { container } = render(UpdaterBanner);
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('matches the error snapshot', () => {
    updaterStub.status = 'error';
    updaterStub.error = 'Signature verification failed';
    const { container } = render(UpdaterBanner);
    expect(container.innerHTML).toMatchSnapshot();
  });
});
