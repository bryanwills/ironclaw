// IronHub catalog wrappers.
//
// Thin typed shells over the three Tauri commands defined in
// `src-tauri/src/ironhub.rs` (`list_ironhub_catalog`, `fetch_ironhub_skill`,
// `install_ironhub_skill_local`). The Rust side owns the file-cache, the
// 1-hour TTL, and the local-sidecar guard for installs; the wrappers
// here just gate on `inTauri()` and translate thrown errors to
// `null` returns so call sites can render an empty-state instead of
// crashing.
//
// IMPORTANT: do NOT mirror the catalog to localStorage. The Rust-side
// `ironhub-catalog.json` cache is the canonical store — caching twice
// just creates a desync between the two. The UI calls
// `listIronHubCatalog()` on mount and lets Rust decide whether to serve
// from cache or re-fetch.

import { invoke } from '@tauri-apps/api/core';

import { inTauri } from '$lib/utils/runtime';

/** Schema constant emitted by the Rust side. Treat as exhaustive — any
 *  drift here will fail a type-narrow in callers. */
export type IronHubCatalogSchema = 'ironhub-catalog.v1';

/** One row in the catalog. `path` is the upstream repo path (e.g.
 *  `skills/chief-of-staff`); `readme_excerpt` is the first ~600 chars
 *  of the directory's README.md when present, `null` otherwise. */
export interface IronHubCatalogEntry {
  name: string;
  path: string;
  readme_excerpt: string | null;
}

export interface IronHubCatalog {
  schema: IronHubCatalogSchema;
  fetched_at: number;
  tools: IronHubCatalogEntry[];
  skills: IronHubCatalogEntry[];
}

export interface IronHubSkillBlob {
  slug: string;
  content: string;
  sha: string;
  fetched_at: number;
}

export interface IronHubInstallResult {
  path: string;
  bytes_written: number;
}

/** Pull the catalog. Pass `force` to bypass the 1h Rust-side cache. */
export async function listIronHubCatalog(force = false): Promise<IronHubCatalog | null> {
  if (!inTauri()) return null;
  try {
    const raw = await invoke<IronHubCatalog>('list_ironhub_catalog', { force });
    if (!raw || raw.schema !== 'ironhub-catalog.v1') return null;
    return raw;
  } catch (err) {
    console.warn('listIronHubCatalog failed', err);
    return null;
  }
}

/** Fetch the raw SKILL.md for a slug. Used by the preview modal and the
 *  copy-to-clipboard affordance. */
export async function fetchIronHubSkill(slug: string): Promise<IronHubSkillBlob | null> {
  if (!inTauri()) return null;
  try {
    const raw = await invoke<IronHubSkillBlob>('fetch_ironhub_skill', { slug });
    if (!raw || typeof raw.content !== 'string') return null;
    return raw;
  } catch (err) {
    console.warn('fetchIronHubSkill failed', err);
    return null;
  }
}

/** Install a skill into the local sidecar's skills dir. Returns `null`
 *  outside Tauri OR when no local sidecar is running — the caller renders
 *  a toast with the error message it surfaced. */
export async function installIronHubSkillLocal(slug: string): Promise<IronHubInstallResult | null> {
  if (!inTauri()) return null;
  try {
    const raw = await invoke<IronHubInstallResult>('install_ironhub_skill_local', { slug });
    if (!raw || typeof raw.path !== 'string') return null;
    return raw;
  } catch (err) {
    console.warn('installIronHubSkillLocal failed', err);
    return null;
  }
}
