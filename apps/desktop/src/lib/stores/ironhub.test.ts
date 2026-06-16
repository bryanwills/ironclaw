// Wire-shape tests for the IronHub wrappers.
//
// All three wrappers gate on `inTauri()` and return `null` outside the
// webview. Inside Tauri they delegate to `invoke()`, surface the typed
// shape on success, and swallow errors to `null` so the calling UI can
// render an empty-state without try/catch boilerplate.
//
// The vitest harness does NOT load `app.html`, so `inTauri()` returns
// false by default — we toggle `window.__TAURI_INTERNALS__` in
// individual tests to flip the path.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

import { fetchIronHubSkill, installIronHubSkillLocal, listIronHubCatalog } from './ironhub.svelte';

function armTauri() {
  // Minimum surface `inTauri()` looks for. Real IPC dispatch is mocked
  // via the vi.mock in vitest.setup.ts, so we don't need the full
  // internals object.
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
}

function disarmTauri() {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
}

describe('listIronHubCatalog', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });
  afterEach(() => {
    disarmTauri();
  });

  it('returns null when not running in Tauri', async () => {
    disarmTauri();
    const out = await listIronHubCatalog();
    expect(out).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('passes the success payload through', async () => {
    armTauri();
    const payload = {
      schema: 'ironhub-catalog.v1' as const,
      fetched_at: 1234,
      tools: [{ name: 't', path: 'tools/t', readme_excerpt: null }],
      skills: [{ name: 's', path: 'skills/s', readme_excerpt: 'hello' }]
    };
    vi.mocked(invoke).mockResolvedValueOnce(payload);
    const out = await listIronHubCatalog();
    expect(out).toEqual(payload);
    expect(invoke).toHaveBeenCalledWith('list_ironhub_catalog', { force: false });
  });

  it('forwards the force flag when requested', async () => {
    armTauri();
    vi.mocked(invoke).mockResolvedValueOnce({
      schema: 'ironhub-catalog.v1',
      fetched_at: 0,
      tools: [],
      skills: []
    });
    await listIronHubCatalog(true);
    expect(invoke).toHaveBeenCalledWith('list_ironhub_catalog', { force: true });
  });

  it('rejects payloads with the wrong schema', async () => {
    armTauri();
    vi.mocked(invoke).mockResolvedValueOnce({
      schema: 'ironhub-catalog.v999',
      fetched_at: 1,
      tools: [],
      skills: []
    });
    const out = await listIronHubCatalog();
    expect(out).toBeNull();
  });

  it('returns null when invoke rejects', async () => {
    armTauri();
    vi.mocked(invoke).mockRejectedValueOnce(new Error('network'));
    const out = await listIronHubCatalog();
    expect(out).toBeNull();
  });
});

describe('fetchIronHubSkill', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });
  afterEach(() => {
    disarmTauri();
  });

  it('returns null when not running in Tauri', async () => {
    disarmTauri();
    const out = await fetchIronHubSkill('foo');
    expect(out).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('passes the SKILL.md blob through on success', async () => {
    armTauri();
    const payload = {
      slug: 'chief-of-staff',
      content: '# Skill body',
      sha: 'abc',
      fetched_at: 100
    };
    vi.mocked(invoke).mockResolvedValueOnce(payload);
    const out = await fetchIronHubSkill('chief-of-staff');
    expect(out).toEqual(payload);
    expect(invoke).toHaveBeenCalledWith('fetch_ironhub_skill', { slug: 'chief-of-staff' });
  });

  it('returns null when invoke rejects (e.g. 404)', async () => {
    armTauri();
    vi.mocked(invoke).mockRejectedValueOnce(new Error('404'));
    const out = await fetchIronHubSkill('missing');
    expect(out).toBeNull();
  });

  it('returns null when content is missing from the response', async () => {
    armTauri();
    vi.mocked(invoke).mockResolvedValueOnce({ slug: 'x' });
    const out = await fetchIronHubSkill('x');
    expect(out).toBeNull();
  });
});

describe('installIronHubSkillLocal', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });
  afterEach(() => {
    disarmTauri();
  });

  it('returns null when not running in Tauri', async () => {
    disarmTauri();
    const out = await installIronHubSkillLocal('foo');
    expect(out).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('passes the install result through on success', async () => {
    armTauri();
    const payload = { path: '/Users/me/.ironclaw/skills/foo/SKILL.md', bytes_written: 1234 };
    vi.mocked(invoke).mockResolvedValueOnce(payload);
    const out = await installIronHubSkillLocal('foo');
    expect(out).toEqual(payload);
    expect(invoke).toHaveBeenCalledWith('install_ironhub_skill_local', { slug: 'foo' });
  });

  it('returns null when invoke rejects (e.g. no local sidecar)', async () => {
    armTauri();
    vi.mocked(invoke).mockRejectedValueOnce(new Error('install requires the bundled sidecar'));
    const out = await installIronHubSkillLocal('foo');
    expect(out).toBeNull();
  });

  it('returns null when the response is missing the path field', async () => {
    armTauri();
    vi.mocked(invoke).mockResolvedValueOnce({ bytes_written: 12 });
    const out = await installIronHubSkillLocal('foo');
    expect(out).toBeNull();
  });
});
