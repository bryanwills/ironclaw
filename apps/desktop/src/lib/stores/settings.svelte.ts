// App settings store backed by Tauri.
//
// Settings live in a JSON file at $APPDATA/settings.json (handled by the
// Rust side). The bearer token never enters this object — it's stored in
// the macOS Keychain via a separate `get_token` / `set_token` IPC pair.
//
// Profile-aware shape (introduced by the Profiles system):
//   { activeProfileId, profiles: [...], onboardingComplete }
//
// Each `ProfileConfig` carries its own mode / URLs / llmBackend so the
// user can flip between (e.g.) "abby-remote" and "local-sidecar" without
// re-typing credentials.
//
// Schema migration: a pre-Profiles install has the flat shape
// `{ mode, remoteBaseUrl, localBaseUrl, llmBackend, onboardingComplete }`
// at the top level. `loadSettings()` detects the absence of a `profiles`
// array and wraps those values into a single default profile with id
// `DEFAULT_PROFILE_ID` ("default") — matching what the Rust keychain
// migration looks for when promoting the legacy bearer slots.

import { invoke } from '@tauri-apps/api/core';

import { DEFAULT_NEARAI_MODEL } from '$lib/data/llm-defaults';
import { inTauri } from '$lib/utils/runtime';
import { broadcast } from './broadcast.svelte';

export type ConnectionMode = 'remote' | 'local';

/**
 * Gateway API contract a profile speaks. `v1` is the historical IronClaw
 * gateway (`/api/chat/*`, `/api/engine/*`, …); `v2` is the projection-driven
 * IronClaw Reborn WebChat surface (`/api/webchat/v2/*`). Orthogonal to `mode`
 * — a remote OR local server can be either version. Defaults to `v2` (the
 * migration target); a profile must opt back to `v1` explicitly to use the
 * legacy `/api/chat/*` gateway.
 */
export type ApiVersion = 'v1' | 'v2';

/**
 * Local-mode LLM backend. `nearai` is the default — IronClaw's built-in
 * NEAR.AI Cloud inference; OAuth handled by IronClaw itself on first
 * connect, no key required upfront. `openrouter` is the advanced path:
 * bring your own OpenRouter key.
 *
 * Retained for backward compatibility — `llmProviderId` (a free-form
 * provider id from the gateway's `/api/llm/providers` registry) is the
 * forward-going field. New installs default to `llmProviderId: 'nearai'`
 * and `llmBackend: 'nearai'`; older settings without `llmProviderId` fall
 * back to deriving it from `llmBackend`.
 */
export type LlmBackend = 'nearai' | 'openrouter';

/**
 * Per-profile accent-color override. Used as a visual distinguisher when
 * multiple profile windows are open side-by-side — the tint paints into
 * `--v2-accent` (and derived strong/soft/text shades) on the document
 * root, so any element bound to those CSS variables picks it up.
 *
 * `signal` is the design-system default and is treated as "no override"
 * at the consume site (matches the historical accent and keeps the field
 * optional on disk). Pre-existing profiles with `tint: undefined` round
 * trip as `signal` at render time.
 */
export type ProfileTint = 'signal' | 'cyan' | 'violet' | 'orange' | 'teal' | 'rose';

/**
 * Per-profile gateway connection. The id is opaque (uuid-ish) and never
 * shown — `name` is the user-facing label.
 */
export interface ProfileConfig {
  /** Stable opaque id. Generated via crypto.randomUUID() on creation; the
   *  migrated legacy profile uses the literal `DEFAULT_PROFILE_ID`. */
  id: string;
  /** User-facing label (e.g. "baremetal3", "abby-remote"). */
  name: string;
  /** `remote` talks to a Caddy-fronted gateway; `local` uses the sidecar. */
  mode: ConnectionMode;
  /** Base URL for the remote IronClaw gateway. */
  remoteBaseUrl: string;
  /** Base URL for the local sidecar gateway (auto-discovered port wins). */
  localBaseUrl: string;
  /** Local-mode LLM backend (defaults to NEAR.AI Cloud).
   *  Legacy field — kept for backward compatibility with the binary
   *  NEAR.AI / OpenRouter sidecar selector. New code should consult
   *  `llmProviderId`; `llmBackend` is derived from it on save. */
  llmBackend: LlmBackend;
  /** Local-mode LLM provider id (from the gateway's `/api/llm/providers`
   *  registry). New field — supersedes `llmBackend` for the richer
   *  provider switcher. Defaults to `'nearai'` for new installs. */
  llmProviderId?: string;
  /** Optional default model id for the selected provider. When unset, the
   *  provider/gateway default is used. In local mode this is passed to the
   *  bundled runner on start; hosted gateways may still enforce their own
   *  server-side default until they expose per-user model overrides. */
  llmModelId?: string;
  /** Optional accent-color override for the active profile window.
   *  Defaults to `signal` at consume time when undefined, which preserves
   *  every existing surface that uses the design-system accent. The
   *  consumer (connection store $effect) writes the resolved color into
   *  `--v2-accent` on document.documentElement. */
  tint?: ProfileTint;
  /** Gateway API contract this profile speaks. Optional on disk; absent or
   *  unknown values consume as `'v2'` (the migration default), which routes
   *  the chat surface through the IronClaw Reborn WebChat v2 client
   *  (`src/lib/api/reborn.ts` + the `*V2` transport methods). Set `'v1'`
   *  explicitly to keep the legacy `/api/chat/*` path. */
  apiVersion?: ApiVersion;
}

/**
 * Hex/rgba values for each `ProfileTint`. Held in one place so the
 * settings picker, sidebar/popover dots, and the CSS-variable override
 * effect all draw from the same palette. The shape mirrors the existing
 * `--v2-accent*` variable set so a tint can populate all four slots
 * without per-variant math.
 *
 * `soft` is the accent at ~14% alpha to match the existing `--v2-accent-soft`
 * pattern; `strong` is a darker shade for hover states; `text` is a lighter
 * shade for text-on-canvas readability (matches the design system's
 * `accent-text` token).
 */
export const PROFILE_TINTS: Record<
  ProfileTint,
  { accent: string; strong: string; soft: string; text: string; label: string }
> = {
  signal: {
    accent: '#4ca7e6',
    strong: '#2882c8',
    soft: 'rgba(76, 167, 230, 0.14)',
    text: '#8fc8f2',
    label: 'Signal'
  },
  cyan: {
    accent: '#00d4ff',
    strong: '#00a8cc',
    soft: 'rgba(0, 212, 255, 0.14)',
    text: '#7ee6ff',
    label: 'Cyan'
  },
  violet: {
    accent: '#a78bfa',
    strong: '#7c5cf0',
    soft: 'rgba(167, 139, 250, 0.14)',
    text: '#c8b8fc',
    label: 'Violet'
  },
  orange: {
    accent: '#fb923c',
    strong: '#ea6a18',
    soft: 'rgba(251, 146, 60, 0.14)',
    text: '#fdb985',
    label: 'Orange'
  },
  teal: {
    accent: '#2dd4bf',
    strong: '#14a89a',
    soft: 'rgba(45, 212, 191, 0.14)',
    text: '#7ce6d5',
    label: 'Teal'
  },
  rose: {
    accent: '#fb7185',
    strong: '#e54860',
    soft: 'rgba(251, 113, 133, 0.14)',
    text: '#fda4af',
    label: 'Rose'
  }
};

/** Stable iteration order for the picker UI. Kept separate from the
 *  Record so `Object.keys` ordering quirks never reorder swatches across
 *  JS engines. */
export const PROFILE_TINT_ORDER: ProfileTint[] = [
  'signal',
  'cyan',
  'violet',
  'orange',
  'teal',
  'rose'
];

/**
 * Resolve a profile's tint to its palette entry. Defaults to `signal` when
 * the field is undefined (legacy profiles) or set to an unrecognised value
 * (defensive — settings.json could be hand-edited). Pure; safe to call from
 * any render path.
 */
export function resolveTint(t: ProfileTint | undefined): {
  accent: string;
  strong: string;
  soft: string;
  text: string;
  label: string;
} {
  if (t && t in PROFILE_TINTS) return PROFILE_TINTS[t];
  return PROFILE_TINTS.signal;
}

export interface AppSettings {
  /** Id of the currently-selected profile. Must always reference a real
   *  entry in `profiles` (the loader + helpers enforce this invariant). */
  activeProfileId: string;
  /** All configured profiles. Always at least one entry. */
  profiles: ProfileConfig[];
  /**
   * First-run wizard sentinel. False on a fresh install (or when the field
   * is missing from an older settings.json), which redirects the user to
   * `/onboarding` on layout mount. Flipped to true once the user completes
   * (or explicitly skips) the wizard, so they never see it again unless
   * they hit "Re-run onboarding" from /settings.
   */
  onboardingComplete: boolean;
  /**
   * App-level "show admin surfaces" toggle. App-level, NOT per-profile —
   * if the user wants the Admin sidebar item and `/admin` route mounted
   * they almost certainly want it across every profile they switch into.
   *
   * Defaults to `false` (the loader's `migrateLoaded` always materializes
   * the field, so consumers can treat it as effectively required). Marked
   * optional on the type so older callers that construct an `AppSettings`
   * draft inline (e.g. the onboarding initializer) don't have to be
   * updated everywhere — anything reading the field still gets a boolean
   * when the value comes off disk. Toggling on in /settings unhides the
   * sidebar entry + Cmd+7 shortcut + the route guard; toggling off
   * redirects out of `/admin` to `/settings` if currently there.
   */
  adminMode?: boolean;
  /**
   * App-level "Show in menu bar" toggle. App-level, NOT per-profile —
   * the tray icon is global chrome, not per-gateway state.
   *
   * Defaults to `true` (the loader materializes the field, so consumers
   * can treat it as effectively required). Marked optional on the type
   * for the same reason `adminMode` is — older code constructing draft
   * settings inline shouldn't have to be updated everywhere.
   *
   * Rust honours this on app start (via `tauri::Builder::setup` reading
   * `settings.json`); the JS connection store pushes the value to the
   * `set_tray_visible` IPC whenever the user toggles it from /settings.
   */
  trayEnabled?: boolean;
  /**
   * App-level "Use Responses API streaming" toggle. Defaults to `true` so a
   * fresh install gets the better delta-streaming path on any gateway that
   * supports it (IronClaw v0.29.x+ exposes `/api/v1/responses` with real
   * incremental `response.output_text.delta` events). Older gateways still
   * work via the auto-detected fallback to the legacy `/api/chat/events`
   * pipeline.
   *
   * Toggling off pins the chat surface to the legacy path regardless of
   * server capability — useful for debugging issues that only reproduce
   * on one transport. App-level (not per-profile) because it's a transport
   * preference, not per-gateway. Only an explicit `false` on disk disables it.
   */
  useResponsesApi?: boolean;
  /**
   * App-level "Show Engine v2 surface" toggle. Defaults to `false` so the
   * Engine v2 sidebar entry, the Cmd+9 shortcut, and the `/missions` route
   * stay hidden until the user opts in from /settings → Advanced. App-level
   * (not per-profile) because Engine v2 is a chrome preference like
   * `adminMode` — once the user opts in they almost certainly want it
   * across every profile they switch into.
   *
   * Toggling on unhides the sidebar entry + the Cmd+9 keyboard chord and
   * mounts the /missions route content. Toggling off retracts all three and
   * (via the layout's $effect) bounces the user out of /missions if they
   * happen to be there.
   */
  engineV2Enabled?: boolean;
}

/** Id used for the migrated default profile. Must stay in sync with the
 *  Rust constant `DEFAULT_PROFILE_ID` in `keychain.rs`. */
export const DEFAULT_PROFILE_ID = 'default';

/** Canonical hosted IronClaw gateway. The collapsed onboarding "Hosted"
 *  card prefills this so a brand-new user only has to paste their access
 *  token (no URL typing) to connect to a running NEAR.AI-backed gateway. */
export const HOSTED_DEFAULT_URL = 'https://baremetal3.agents.near.ai';
const LOCAL_SIDECAR_DEFAULT_URL = 'http://127.0.0.1:3100';
const STALE_LOCAL_SIDECAR_URLS = new Set(['http://127.0.0.1:3000', 'http://localhost:3000']);

function normalizedLocalUrl(value: string | undefined): string {
  const raw = value || LOCAL_SIDECAR_DEFAULT_URL;
  return STALE_LOCAL_SIDECAR_URLS.has(raw.replace(/\/+$/, '')) ? LOCAL_SIDECAR_DEFAULT_URL : raw;
}

function shouldRecoverStaleLocalProfile(profile: Partial<ProfileConfig>): boolean {
  if (profile.mode === 'local') return false;
  const remoteBaseUrl = (profile.remoteBaseUrl || '').replace(/\/+$/, '');
  if (!STALE_LOCAL_SIDECAR_URLS.has(remoteBaseUrl)) return false;
  const label = (profile.name || '').toLowerCase();
  return label.includes('local ironclaw') || label.includes('ironclaw');
}

function newProfileId(): string {
  // crypto.randomUUID() is available in modern webviews (Tauri 2 ships
  // WebKit ≥ 16.4 on macOS) — no extra dep needed.
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultProfile(overrides?: Partial<ProfileConfig>): ProfileConfig {
  return {
    id: overrides?.id ?? newProfileId(),
    name: overrides?.name ?? 'Default',
    mode: overrides?.mode ?? 'remote',
    remoteBaseUrl: normalizedLocalUrl(overrides?.remoteBaseUrl),
    localBaseUrl: normalizedLocalUrl(overrides?.localBaseUrl),
    llmBackend: overrides?.llmBackend ?? 'nearai',
    llmProviderId: overrides?.llmProviderId ?? overrides?.llmBackend ?? 'nearai',
    llmModelId:
      typeof overrides?.llmModelId === 'string' && overrides.llmModelId.trim().length > 0
        ? overrides.llmModelId.trim()
        : (overrides?.llmProviderId ?? overrides?.llmBackend ?? 'nearai') === 'nearai'
          ? DEFAULT_NEARAI_MODEL
          : undefined,
    apiVersion: overrides?.apiVersion ?? 'v2'
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  activeProfileId: DEFAULT_PROFILE_ID,
  profiles: [defaultProfile({ id: DEFAULT_PROFILE_ID, name: 'Default' })],
  onboardingComplete: false,
  adminMode: false,
  trayEnabled: true,
  useResponsesApi: true,
  engineV2Enabled: false
};

/** Shape of the legacy (pre-Profiles) settings file. Kept narrow on
 *  purpose — anything else is just preserved into the migrated profile. */
interface LegacyAppSettings {
  mode?: ConnectionMode;
  remoteBaseUrl?: string;
  localBaseUrl?: string;
  llmBackend?: LlmBackend;
  llmModelId?: string;
  onboardingComplete?: boolean;
  trayEnabled?: boolean;
  useResponsesApi?: boolean;
  engineV2Enabled?: boolean;
}

/**
 * Take whatever's on disk and produce a valid `AppSettings`. Pure — no IPC.
 *
 * Handles three cases:
 *   1. Empty / missing file → fresh defaults (one Default profile).
 *   2. Legacy flat shape (no `profiles` array) → wrap into a single
 *      profile with id `DEFAULT_PROFILE_ID`. The Rust keychain layer
 *      will promote the suffix-less Keychain entries to `:default` on
 *      first read.
 *   3. Profile-aware shape → trust it, but defensively re-anchor
 *      `activeProfileId` to the first profile if it points nowhere.
 */
export function migrateLoaded(raw: Partial<AppSettings> & LegacyAppSettings): AppSettings {
  // Case 3 + 2 share the same input — `profiles` being a non-empty array
  // is the discriminator.
  if (Array.isArray(raw.profiles) && raw.profiles.length > 0) {
    const profiles = raw.profiles.map((p) => {
      const recoveredLocal = shouldRecoverStaleLocalProfile(p);
      const localBaseUrl = normalizedLocalUrl(p.localBaseUrl);
      const llmBackend = (p.llmBackend === 'openrouter' ? 'openrouter' : 'nearai') as LlmBackend;
      const llmProviderId =
        typeof p.llmProviderId === 'string' && p.llmProviderId.length > 0
          ? p.llmProviderId
          : llmBackend;
      // `tint` is opt-in and defensively narrowed — unknown values fall
      // through to `undefined`, which the consume site treats as `signal`.
      const tint =
        typeof p.tint === 'string' && (p.tint as ProfileTint) in PROFILE_TINTS
          ? (p.tint as ProfileTint)
          : undefined;
      return {
        id: p.id || newProfileId(),
        name: recoveredLocal
          ? (p.name || 'Local IronClaw').replace('(:3000)', '(:3100)')
          : p.name || 'Untitled',
        mode: (recoveredLocal || p.mode === 'local' ? 'local' : 'remote') as ConnectionMode,
        remoteBaseUrl: recoveredLocal ? localBaseUrl : normalizedLocalUrl(p.remoteBaseUrl),
        localBaseUrl,
        llmBackend,
        // Derive from the legacy field if the new one wasn't stored yet,
        // so existing installs land on the matching provider without a
        // user round-trip.
        llmProviderId,
        llmModelId:
          typeof p.llmModelId === 'string' && p.llmModelId.trim().length > 0
            ? p.llmModelId.trim()
            : llmProviderId === 'nearai'
              ? DEFAULT_NEARAI_MODEL
              : undefined,
        tint,
        // v2 is the default; only an explicit 'v1' opts back to the legacy
        // gateway. Absent (existing files) and unknown values resolve to 'v2'.
        apiVersion: (p.apiVersion === 'v1' ? 'v1' : 'v2') as ApiVersion
      };
    });
    const activeId =
      raw.activeProfileId && profiles.some((p) => p.id === raw.activeProfileId)
        ? raw.activeProfileId
        : profiles[0].id;
    return {
      activeProfileId: activeId,
      profiles,
      onboardingComplete: raw.onboardingComplete === true,
      // adminMode is opt-in — only true when explicitly stored as boolean
      // true. Older settings files that don't carry the field round-trip
      // as `false`, which matches the "do not surface admin routes by
      // default" intent.
      adminMode: raw.adminMode === true,
      // trayEnabled is opt-OUT — defaults to true so a fresh install
      // gets the tray icon by default. Only an explicit `false` on disk
      // hides it.
      trayEnabled: raw.trayEnabled !== false,
      // useResponsesApi is opt-OUT — defaults to true so users get the
      // better delta-streaming path. The chat surface auto-falls-back to
      // the legacy /api/chat path if the active gateway doesn't expose
      // /api/v1/responses, so flipping this on is safe on every server.
      useResponsesApi: raw.useResponsesApi !== false,
      // engineV2Enabled is opt-IN — same shape as adminMode. Only true
      // when explicitly stored. Older files round-trip as `false`, which
      // matches the "do not surface Engine v2 routes by default" intent.
      engineV2Enabled: raw.engineV2Enabled === true
    };
  }

  // Legacy flat → single profile. Keep the same id so Keychain promotion
  // lines up. If even the legacy fields are empty (fresh install via
  // get_settings's `{}` first-run response), we still produce one default
  // profile so the rest of the app has something to render.
  const legacyBackend = raw.llmBackend ?? 'nearai';
  const legacyRecoveredLocal = shouldRecoverStaleLocalProfile({
    mode: raw.mode,
    name: 'Default IronClaw',
    remoteBaseUrl: raw.remoteBaseUrl,
    localBaseUrl: raw.localBaseUrl
  });
  const profile = defaultProfile({
    id: DEFAULT_PROFILE_ID,
    name: 'Default',
    mode: legacyRecoveredLocal ? 'local' : (raw.mode ?? 'remote'),
    remoteBaseUrl: normalizedLocalUrl(raw.remoteBaseUrl),
    localBaseUrl: normalizedLocalUrl(raw.localBaseUrl),
    llmBackend: legacyBackend,
    llmProviderId: legacyBackend,
    llmModelId: raw.llmModelId
  });
  return {
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: [profile],
    onboardingComplete: raw.onboardingComplete === true,
    adminMode: raw.adminMode === true,
    trayEnabled: raw.trayEnabled !== false,
    useResponsesApi: raw.useResponsesApi !== false,
    engineV2Enabled: raw.engineV2Enabled === true
  };
}

// ---- Live in-memory cache -------------------------------------------------
//
// All the helpers below mutate this and immediately persist via
// `saveSettings`. The `connection` store also keeps its own copy in a
// Svelte 5 `$state` field — it pulls from here in `refresh()`.

let cached: AppSettings | null = null;

export async function loadSettings(): Promise<AppSettings> {
  if (!inTauri()) {
    cached = structuredClone(DEFAULT_SETTINGS);
    return cached;
  }
  try {
    const raw = await invoke<Partial<AppSettings> & LegacyAppSettings>('get_settings');
    cached = migrateLoaded(raw ?? {});
    return cached;
  } catch (err) {
    console.warn('loadSettings failed; returning defaults', err);
    cached = structuredClone(DEFAULT_SETTINGS);
    return cached;
  }
}

export async function saveSettings(s: AppSettings): Promise<void> {
  // CRITICAL: Svelte 5 `$state` proxies are NOT cloneable via the structured
  // clone algorithm — Tauri IPC's underlying postMessage chokes with
  // `DOMException: DataCloneError "The object can not be cloned."`. This
  // bit the onboarding wizard's Skip/Finish handlers hard (R34d). The fix:
  // JSON-roundtrip to a pure plain-object before doing ANYTHING with it.
  // Cheap (settings is ~1KB), safe (settings is JSON-on-disk anyway), and
  // bulletproof against future code paths that hand us a `$state` view.
  const plain = JSON.parse(JSON.stringify(s)) as AppSettings;
  if (!inTauri()) {
    console.warn('saveSettings called outside Tauri; no-op');
    // No on-disk write to fail against here, so adopt the new view and
    // notify siblings (`broadcast.send` no-ops without an open channel).
    cached = structuredClone(plain);
    broadcast.send({ kind: 'settings-changed' });
    return;
  }
  // Persist FIRST; adopt the new settings into the in-memory cache only once
  // the on-disk write actually succeeded. If the IPC rejects (disk error,
  // serialization failure), the cache keeps its last-known-good view and the
  // rejection propagates to the caller — rather than leaving memory believing
  // unsaved config was persisted (Codex audit P0).
  await invoke('save_settings', { settings: plain });
  cached = structuredClone(plain);
  // Fan the change out to every sibling window so their
  // `connection.settings` rune refreshes from disk. Fires AFTER the
  // IPC resolves so peers never read stale on-disk state. Loop-safe:
  // peers call `connection.reloadSettings()` (no save), so no echo.
  broadcast.send({ kind: 'settings-changed' });
}

// ---- Settings backup (import validation) ---------------------------------

/** Result of `validateImportedSettings`. Discriminated union so callers can
 *  surface the specific failure reason in the UI instead of a generic
 *  "import failed" toast. */
export type ImportValidationResult =
  | { ok: true; settings: AppSettings }
  | { ok: false; error: string };

/**
 * Parse + validate the JSON shape of an imported settings backup. Returns
 * a discriminated union so the caller can show the specific failure reason
 * rather than a generic message.
 *
 * Validation rules enforced:
 *   - Input must be valid JSON parsing to a non-null object.
 *   - `profiles` must be a non-empty array of profile objects.
 *   - Each profile must have a string `id`, `name`, `remoteBaseUrl`,
 *     `localBaseUrl`, a `mode` of `'remote' | 'local'`, and an `llmBackend`
 *     of `'nearai' | 'openrouter'`.
 *   - `activeProfileId` must be a string matching one of the profile ids.
 *
 * Optional fields (`onboardingComplete`, `adminMode`, `trayEnabled`) are
 * accepted as-is but coerced to booleans on the persisted shape.
 */
export function validateImportedSettings(raw: string): ImportValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `Not valid JSON: ${(err as Error).message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Expected a JSON object at the top level' };
  }
  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.profiles)) {
    return { ok: false, error: 'Missing or invalid `profiles` array' };
  }
  if (obj.profiles.length === 0) {
    return { ok: false, error: '`profiles` array is empty — need at least one profile' };
  }

  const profiles: ProfileConfig[] = [];
  for (let i = 0; i < obj.profiles.length; i++) {
    const p = obj.profiles[i];
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      return { ok: false, error: `profiles[${i}] is not an object` };
    }
    const pp = p as Record<string, unknown>;
    if (typeof pp.id !== 'string' || pp.id.length === 0) {
      return { ok: false, error: `profiles[${i}].id missing or not a string` };
    }
    if (typeof pp.name !== 'string' || pp.name.length === 0) {
      return { ok: false, error: `profiles[${i}].name missing or not a string` };
    }
    if (pp.mode !== 'remote' && pp.mode !== 'local') {
      return {
        ok: false,
        error: `profiles[${i}].mode must be "remote" or "local" (got ${JSON.stringify(pp.mode)})`
      };
    }
    if (typeof pp.remoteBaseUrl !== 'string') {
      return { ok: false, error: `profiles[${i}].remoteBaseUrl missing or not a string` };
    }
    if (typeof pp.localBaseUrl !== 'string') {
      return { ok: false, error: `profiles[${i}].localBaseUrl missing or not a string` };
    }
    if (pp.llmBackend !== 'nearai' && pp.llmBackend !== 'openrouter') {
      return {
        ok: false,
        error: `profiles[${i}].llmBackend must be "nearai" or "openrouter" (got ${JSON.stringify(pp.llmBackend)})`
      };
    }
    // llmProviderId is optional in the wire — if missing/non-string we
    // derive it from llmBackend so older backups round-trip cleanly.
    const llmProviderId =
      typeof pp.llmProviderId === 'string' && pp.llmProviderId.length > 0
        ? pp.llmProviderId
        : pp.llmBackend;
    const llmModelId =
      typeof pp.llmModelId === 'string' && pp.llmModelId.trim().length > 0
        ? pp.llmModelId.trim()
        : llmProviderId === 'nearai'
          ? DEFAULT_NEARAI_MODEL
          : undefined;
    // `tint` is opt-in; unknown / missing values import as undefined so
    // the consume site (resolveTint) falls back to `signal`. We do not
    // reject an unknown tint — round-tripping a future tint name from a
    // newer build shouldn't kill an import on an older client.
    const tint =
      typeof pp.tint === 'string' && (pp.tint as ProfileTint) in PROFILE_TINTS
        ? (pp.tint as ProfileTint)
        : undefined;
    // v2 is the default; only an explicit 'v1' opts back to the legacy
    // gateway. Missing/unknown values import as 'v2'. We do not reject an
    // unknown value (forward-compat, same as `tint`).
    const apiVersion: ApiVersion = pp.apiVersion === 'v1' ? 'v1' : 'v2';
    profiles.push({
      id: pp.id,
      name: pp.name,
      mode: pp.mode,
      remoteBaseUrl: pp.remoteBaseUrl,
      localBaseUrl: pp.localBaseUrl,
      llmBackend: pp.llmBackend,
      llmProviderId,
      llmModelId,
      tint,
      apiVersion
    });
  }

  if (typeof obj.activeProfileId !== 'string' || obj.activeProfileId.length === 0) {
    return { ok: false, error: 'Missing or invalid `activeProfileId`' };
  }
  if (!profiles.some((p) => p.id === obj.activeProfileId)) {
    return {
      ok: false,
      error: '`activeProfileId` does not match any profile id'
    };
  }

  const settings: AppSettings = {
    activeProfileId: obj.activeProfileId,
    profiles,
    onboardingComplete: obj.onboardingComplete === true,
    adminMode: obj.adminMode === true,
    trayEnabled: obj.trayEnabled !== false,
    engineV2Enabled: obj.engineV2Enabled === true,
    // Opt-OUT, default true (mirrors loadSettings) — preserve an explicit
    // `false` so a backup round-trip doesn't silently re-enable the
    // Responses API.
    useResponsesApi: obj.useResponsesApi !== false
  };
  return { ok: true, settings };
}

/**
 * Validate the supplied JSON string, persist it via `saveSettings`, and
 * return the parsed `AppSettings`. Throws on validation failure with the
 * specific reason.
 *
 * Tokens / OpenRouter keys are NOT imported (they live in the Keychain,
 * not in settings.json). The caller should surface a reminder to re-enter
 * credentials per profile after this resolves.
 */
export async function importSettingsFromString(raw: string): Promise<AppSettings> {
  const result = validateImportedSettings(raw);
  if (!result.ok) {
    throw new Error(result.error);
  }
  await saveSettings(result.settings);
  return result.settings;
}

// ---- Profile helpers ------------------------------------------------------
//
// All helpers operate on the in-memory cache + persist immediately.
// `loadSettings()` MUST have been called once before these are used — the
// app's mount path (connection.init → loadSettings) takes care of that.

function requireCache(): AppSettings {
  if (!cached) {
    throw new Error('settings: cache not initialized — call loadSettings() before mutating');
  }
  return cached;
}

/** The currently active profile. Throws if settings haven't been loaded. */
export function getActiveProfile(): ProfileConfig {
  const s = requireCache();
  const p = s.profiles.find((x) => x.id === s.activeProfileId) ?? s.profiles[0];
  if (!p) throw new Error('settings: no profiles configured');
  return p;
}

/** Read-only snapshot of all profiles, in stored order. */
export function listProfiles(): ProfileConfig[] {
  return [...requireCache().profiles];
}

/** Persist a new active profile. Throws if the id doesn't exist. */
export async function setActiveProfile(id: string): Promise<void> {
  const s = requireCache();
  if (!s.profiles.some((p) => p.id === id)) {
    throw new Error(`setActiveProfile: unknown profile id ${id}`);
  }
  if (s.activeProfileId === id) return;
  const next: AppSettings = { ...s, activeProfileId: id };
  await saveSettings(next);
}

/**
 * Append a fresh profile and persist. Returns the new profile so callers
 * can chain (e.g. `setActiveProfile(addProfile(name).id)`).
 */
export async function addProfile(
  name: string,
  base?: Partial<ProfileConfig>
): Promise<ProfileConfig> {
  const s = requireCache();
  const trimmed = name.trim();
  if (!trimmed) throw new Error('addProfile: name required');
  if (trimmed.length >= 64) throw new Error('addProfile: name too long');
  const profile = defaultProfile({ ...base, id: newProfileId(), name: trimmed });
  const next: AppSettings = { ...s, profiles: [...s.profiles, profile] };
  await saveSettings(next);
  return profile;
}

/**
 * Apply a partial update to a single profile + persist. Silently no-ops if
 * the id doesn't exist (caller is expected to validate first).
 */
export async function updateProfile(id: string, patch: Partial<ProfileConfig>): Promise<void> {
  const s = requireCache();
  const idx = s.profiles.findIndex((p) => p.id === id);
  if (idx === -1) return;
  // Forbid id mutation — that would orphan Keychain entries.
  const { id: _ignored, ...safePatch } = patch;
  const merged: ProfileConfig = { ...s.profiles[idx], ...safePatch };
  const next: AppSettings = {
    ...s,
    profiles: s.profiles.map((p, i) => (i === idx ? merged : p))
  };
  await saveSettings(next);
}

/**
 * Reorder the in-memory profiles array to match `orderedIds` and persist.
 *
 * Validation: `orderedIds` MUST contain exactly the same set of ids as
 * the current `profiles` array (same length, no duplicates, no foreign
 * ids, no missing ids). On mismatch this throws — the caller is expected
 * to validate at the UI boundary, and a silent reorder of a partial set
 * would risk dropping a profile from settings.json on the next save.
 *
 * No-ops (skip the write) when the supplied order is already current, so
 * a drop-on-self drag from the UI does not churn the broadcast bus.
 *
 * Side effects (via `saveSettings`):
 *   - Writes settings.json on disk.
 *   - Fans a `settings-changed` broadcast to sibling windows, which causes
 *     their `connection.reloadSettings()` to pick up the new order.
 *
 * The active profile is preserved (its id stays in `activeProfileId`); we
 * only shuffle list ordering, never the selection.
 */
export async function reorderProfiles(orderedIds: string[]): Promise<void> {
  const s = requireCache();
  if (!Array.isArray(orderedIds)) {
    throw new Error('reorderProfiles: orderedIds must be an array');
  }
  if (orderedIds.length !== s.profiles.length) {
    throw new Error(
      `reorderProfiles: id count mismatch (got ${orderedIds.length}, expected ${s.profiles.length})`
    );
  }
  const current = new Set(s.profiles.map((p) => p.id));
  const incoming = new Set<string>();
  for (const id of orderedIds) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('reorderProfiles: orderedIds must contain non-empty strings');
    }
    if (incoming.has(id)) {
      throw new Error(`reorderProfiles: duplicate id ${id}`);
    }
    incoming.add(id);
    if (!current.has(id)) {
      throw new Error(`reorderProfiles: unknown profile id ${id}`);
    }
  }
  // Both sets have equal length AND `incoming ⊂ current` — so they're
  // equal as sets. (The length check above plus the subset check covers
  // the full equality.) Now check whether the order has actually changed
  // — if not, skip the disk write + broadcast.
  let changed = false;
  for (let i = 0; i < orderedIds.length; i++) {
    if (s.profiles[i].id !== orderedIds[i]) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  // Build the reordered array. Look up by id rather than mutating in place
  // so the source array stays untouched until `saveSettings` resolves.
  const byId = new Map(s.profiles.map((p) => [p.id, p]));
  const profiles = orderedIds.map((id) => byId.get(id)!);
  const next: AppSettings = { ...s, profiles };
  await saveSettings(next);
}

/**
 * Remove a profile. Refuses if it's the last remaining profile (we always
 * keep at least one), and refuses to delete the active profile when it's
 * the only one — callers should switch active first.
 */
export async function deleteProfile(id: string): Promise<void> {
  const s = requireCache();
  if (s.profiles.length <= 1) {
    throw new Error('deleteProfile: cannot remove the last profile');
  }
  const target = s.profiles.find((p) => p.id === id);
  if (!target) return;
  if (id === s.activeProfileId && s.profiles.length === 1) {
    // Defensive — the length check above covers this, but make the
    // intent explicit.
    throw new Error('deleteProfile: cannot remove the active-and-only profile');
  }
  // Drop the entry. If we just removed the active one, pivot to the first
  // remaining profile so the connection store always has a target.
  const profiles = s.profiles.filter((p) => p.id !== id);
  const activeProfileId = s.activeProfileId === id ? profiles[0].id : s.activeProfileId;
  const next: AppSettings = { ...s, profiles, activeProfileId };
  await saveSettings(next);
  // Best-effort credential cleanup — never throws (delete is no-op when
  // the entry doesn't exist).
  try {
    await deleteToken(id);
  } catch (err) {
    console.warn('deleteProfile: deleteToken failed', err);
  }
  try {
    await deleteOpenRouterKey(id);
  } catch (err) {
    console.warn('deleteProfile: deleteOpenRouterKey failed', err);
  }
}

// ---- Gateway-token Keychain (per-profile) --------------------------------

export async function getToken(profileId: string): Promise<string | null> {
  if (!inTauri()) return null;
  try {
    const t = await invoke<string | null>('get_token', { profileId });
    return t ?? null;
  } catch (err) {
    console.warn('getToken failed', err);
    return null;
  }
}

export async function setToken(profileId: string, token: string): Promise<void> {
  if (!inTauri()) {
    console.warn('setToken called outside Tauri; no-op');
    return;
  }
  await invoke('set_token', { profileId, token });
}

export async function deleteToken(profileId: string): Promise<void> {
  if (!inTauri()) {
    console.warn('deleteToken called outside Tauri; no-op');
    return;
  }
  await invoke('delete_token', { profileId });
}

/** Which backing store the gateway-token was loaded from. The Settings
 *  page surfaces this so the user can tell whether the macOS keychain
 *  ACL prompt is wedged on their machine (a frequent source of confusing
 *  "Disconnected" failures on fresh ad-hoc-signed dev builds — see v0.2.8). */
export type TokenSource = 'keychain' | 'file' | 'absent';

export async function getTokenSource(profileId: string): Promise<TokenSource> {
  if (!inTauri()) return 'absent';
  try {
    const raw = await invoke<string>('get_token_source', { profileId });
    if (raw === 'keychain' || raw === 'file' || raw === 'absent') return raw;
    return 'absent';
  } catch (err) {
    console.warn('getTokenSource failed', err);
    return 'absent';
  }
}

/** Self-describing diagnostic blob. Doesn't include secrets — token values
 *  are reported only by their source ("keychain" | "file" | "absent"), never
 *  in plaintext. Useful for support tickets: a user can call this, copy the
 *  output, and paste it into an issue without leaking auth. */
export interface DiagnosticReport {
  schema: 'ironclaw-diagnostic-report.v1';
  generated_at: number;
  app: {
    name: string;
    version: string;
    bundle_id: string;
    app_data_dir: string;
  };
  host: {
    os: string;
    os_version: string;
    arch: string;
    kernel: string;
  };
  profile: {
    id: string;
    token_source: TokenSource | 'error';
  };
}

export async function getDiagnosticReport(profileId: string): Promise<DiagnosticReport | null> {
  if (!inTauri()) return null;
  try {
    return await invoke<DiagnosticReport>('diagnostic_report', { profileId });
  } catch (err) {
    console.warn('getDiagnosticReport failed', err);
    return null;
  }
}

/** How the running binary was built, surfaced from `build_provenance` (R38).
 *  `build_kind` is the user-facing summary:
 *    - "public"  — release, no devtools, intended for end users
 *    - "support" — release with `dev-devtools` feature flag, for debugging
 *      a specific user's install
 *    - "dev"     — debug build (cargo run / npm run tauri dev)
 *  `signing` reflects what `codesign -dvv` reports for the .app bundle —
 *  `"developer-id"` is the only state safe for distribution; everything else
 *  triggers Gatekeeper warnings on a fresh machine. */
export interface BuildProvenance {
  schema: 'ironclaw-build-provenance.v1';
  version: string;
  profile: 'debug' | 'release';
  devtools: boolean;
  signing: 'developer-id' | 'adhoc' | 'unsigned' | 'unknown';
  build_kind: 'public' | 'support' | 'dev';
}

export async function getBuildProvenance(): Promise<BuildProvenance | null> {
  if (!inTauri()) return null;
  try {
    return await invoke<BuildProvenance>('build_provenance');
  } catch (err) {
    console.warn('getBuildProvenance failed', err);
    return null;
  }
}

// ---- OpenRouter key (Keychain, per-profile) ------------------------------

export async function getOpenRouterKey(profileId: string): Promise<string | null> {
  if (!inTauri()) return null;
  try {
    const k = await invoke<string | null>('get_openrouter_key', { profileId });
    return k ?? null;
  } catch (err) {
    console.warn('getOpenRouterKey failed', err);
    return null;
  }
}

export async function setOpenRouterKey(profileId: string, key: string): Promise<void> {
  if (!inTauri()) {
    console.warn('setOpenRouterKey called outside Tauri; no-op');
    return;
  }
  await invoke('set_openrouter_key', { profileId, key });
}

export async function deleteOpenRouterKey(profileId: string): Promise<void> {
  if (!inTauri()) {
    console.warn('deleteOpenRouterKey called outside Tauri; no-op');
    return;
  }
  await invoke('delete_openrouter_key', { profileId });
}

// ---- Local gateway token (auto-generated UUID for sidecar auth) ----------

export async function getOrCreateLocalToken(): Promise<string | null> {
  if (!inTauri()) return null;
  try {
    return await invoke<string>('get_or_create_local_token');
  } catch (err) {
    console.warn('getOrCreateLocalToken failed', err);
    return null;
  }
}

// ---- Data directory (for "reveal in Finder" UX) --------------------------

export async function localDataDir(): Promise<string | null> {
  if (!inTauri()) return null;
  try {
    return await invoke<string>('local_data_dir');
  } catch (err) {
    console.warn('localDataDir failed', err);
    return null;
  }
}

export async function revealInFinder(path: string): Promise<void> {
  if (!inTauri()) {
    console.warn('revealInFinder called outside Tauri; no-op');
    return;
  }
  await invoke('reveal_in_finder', { path });
}

// ---- Sidecar lifecycle ---------------------------------------------------

export interface SidecarStatusPayload {
  running: boolean;
  port: number | null;
}

export async function startSidecar(
  profileId: string,
  backend?: LlmBackend,
  providerId?: string,
  modelId?: string
): Promise<number> {
  if (!inTauri()) throw new Error('startSidecar requires the Tauri runtime');
  // Forward the chosen backend; the Rust side defaults to NEAR.AI if
  // omitted. Passing it explicitly keeps the spawn deterministic across
  // tabs/processes. The profileId scopes the OpenRouter-key lookup.
  //
  // `providerId` is the new, richer field from the LlmProviderPicker.
  // When supplied it wins over `backend` on the Rust side; when absent
  // Rust falls back to the legacy `backend` enum so older callers keep
  // working without churn.
  return invoke<number>('start_sidecar', {
    backend: backend ?? 'nearai',
    providerId,
    modelId: modelId && modelId.trim().length > 0 ? modelId.trim() : undefined,
    profileId
  });
}

// ---- Per-provider credential Keychain (LLM picker) -----------------------
//
// Credentials live in `llm-<provider-id>:<profile-id>` slots so each
// provider keeps its own secret per profile (matching the prompt's spec).
// The OpenRouter slot is handled separately so the legacy NEAR.AI /
// OpenRouter radio + the new picker can co-exist without stepping on
// each other — when the user picks `openrouter` in the new picker its
// input writes into the same `openrouter-key:<profile>` slot via the
// dedicated set/clear OpenRouter helpers.

export async function getLlmProviderCredential(
  profileId: string,
  providerId: string
): Promise<string | null> {
  if (!inTauri()) return null;
  try {
    const v = await invoke<string | null>('get_llm_provider_credential', {
      profileId,
      providerId
    });
    return v ?? null;
  } catch (err) {
    console.warn('getLlmProviderCredential failed', err);
    return null;
  }
}

export async function setLlmProviderCredential(
  profileId: string,
  providerId: string,
  value: string
): Promise<void> {
  if (!inTauri()) {
    console.warn('setLlmProviderCredential called outside Tauri; no-op');
    return;
  }
  await invoke('set_llm_provider_credential', {
    profileId,
    providerId,
    value
  });
}

export async function deleteLlmProviderCredential(
  profileId: string,
  providerId: string
): Promise<void> {
  if (!inTauri()) {
    console.warn('deleteLlmProviderCredential called outside Tauri; no-op');
    return;
  }
  await invoke('delete_llm_provider_credential', {
    profileId,
    providerId
  });
}

export async function stopSidecar(): Promise<void> {
  if (!inTauri()) return;
  await invoke('stop_sidecar');
}

export async function sidecarStatus(): Promise<SidecarStatusPayload> {
  if (!inTauri()) return { running: false, port: null };
  return invoke<SidecarStatusPayload>('sidecar_status');
}
