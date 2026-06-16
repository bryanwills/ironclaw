// Agent-UI state reader — the "see" half of agent-controlled UI.
//
// Produces a REDACTED, semantic snapshot of the current UI for the agent to
// read before it acts. Never raw DOM, never secrets. Pure: the app passes a
// `UiStateSource` (the live bits, gathered at the call site from $page/stores),
// and this builds + redacts the snapshot — so it's unit-testable without a DOM
// and the redaction is enforced in one place. The surface vocabulary is shared
// with the action registry (NAV_SURFACES) so "see" and "drive" speak the same
// names.

import { NAV_SURFACES, type NavSurface } from './actions';

/**
 * The live UI bits the app supplies. Deliberately a curated, secret-free shape
 * — there is no token/credential field by construction, so the snapshot can
 * never carry one. Free-text fields are still run through `redactSecrets` as
 * defence-in-depth (e.g. a user who pasted a token into the composer).
 */
export interface UiStateSource {
  /** Current route path, e.g. "/knowledge". */
  path: string;
  /** Active chat thread id, if any. */
  activeThreadId?: string | null;
  /** Name of an open modal/overlay, if any (e.g. "command-palette"). */
  openModal?: string | null;
  /** The composer draft text, if the chat surface is active. */
  composerDraft?: string | null;
  /** Connection status label, e.g. "connected" | "disconnected". */
  connectionStatus?: string | null;
  /** Active profile display name. */
  profileName?: string | null;
}

/** The redacted snapshot handed to the agent. */
export interface UiState {
  /** Friendly surface name derived from the path (matches NAV_SURFACES keys). */
  surface: string;
  path: string;
  activeThreadId: string | null;
  openModal: string | null;
  composerDraft: string | null;
  connectionStatus: string | null;
  profileName: string | null;
}

/** Path → surface name, inverted from the shared NAV_SURFACES map. */
const PATH_TO_SURFACE = Object.fromEntries(
  Object.entries(NAV_SURFACES).map(([name, path]) => [path, name as NavSurface])
) as Record<string, NavSurface>;

/**
 * Resolve a route path to a friendly surface name. Strips a query string and
 * trailing slashes before matching; unknown paths resolve to "unknown" so the
 * agent never receives a fabricated surface.
 */
export function surfaceForPath(path: string): string {
  const clean = (path.split('?')[0] ?? '').replace(/\/+$/, '') || '/';
  if (clean === '/') return 'dashboard';
  return PATH_TO_SURFACE[clean] ?? PATH_TO_SURFACE[path] ?? 'unknown';
}

const TOKEN_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._-]+/gi, // Authorization headers
  /\b(?:sk|pk)-[A-Za-z0-9._-]{8,}/g, // OpenAI-style keys
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g, // GitHub tokens
  /\b[A-Fa-f0-9]{32,}\b/g // long hex blobs (api keys / hashes)
];

/**
 * Mask token/secret-looking substrings so nothing sensitive rides in the
 * snapshot the agent — and, downstream, the model/wire — sees. Conservative by
 * design: only well-known token shapes are masked, so ordinary prose is left
 * intact.
 */
export function redactSecrets(value: string): string {
  let out = value;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

/** Build the redacted UI-state snapshot from the supplied live bits. */
export function readUiState(source: UiStateSource): UiState {
  const draft = source.composerDraft ?? null;
  return {
    surface: surfaceForPath(source.path),
    path: source.path,
    activeThreadId: source.activeThreadId ?? null,
    openModal: source.openModal ?? null,
    composerDraft: draft === null ? null : redactSecrets(draft),
    connectionStatus: source.connectionStatus ?? null,
    profileName: source.profileName ?? null
  };
}
