// Standalone routines API helpers.
//
// Kept separate from `ironclaw.ts` for the create-routine stream so the route
// can call POST /api/routines without expanding the central client surface.
// This mirrors the central client's base URL, bearer auth, JSON request shape,
// and Tauri-http fallback locally.

export interface CreateRoutineRequest {
  name: string;
  schedule: string;
  prompt: string;
  enabled?: boolean;
}

export interface Routine {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  last_run?: string;
  next_run?: string;
}

export type CreateRoutineResult =
  | { ok: true; routine: Routine }
  | { ok: false; reason: 'unavailable' };

export interface RoutineClientOptions {
  baseUrl: string;
  token: string | null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

let tauriFetchPromise: Promise<typeof fetch | null> | null = null;

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function loadTauriFetch(): Promise<typeof fetch | null> {
  if (!inTauri()) return Promise.resolve(null);
  if (tauriFetchPromise) return tauriFetchPromise;
  tauriFetchPromise = import('@tauri-apps/plugin-http')
    .then((m) => (m && typeof m.fetch === 'function' ? (m.fetch as typeof fetch) : null))
    .catch((err) => {
      console.warn(
        '[routines] Tauri http plugin failed to load; falling back to native fetch',
        err
      );
      return null;
    });
  return tauriFetchPromise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function unwrapRoutinePayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) throw new Error('Invalid routine response.');
  const nested = payload.routine;
  if (isRecord(nested)) return nested;
  return payload;
}

function mapRoutine(payload: unknown, fallback: CreateRoutineRequest): Routine {
  const record = unwrapRoutinePayload(payload);
  const id = stringField(record, 'id');
  if (!id) throw new Error('Routine response did not include an id.');
  return {
    id,
    name: stringField(record, 'name') ?? fallback.name,
    schedule:
      stringField(record, 'schedule') ??
      stringField(record, 'trigger_summary') ??
      stringField(record, 'trigger_raw') ??
      fallback.schedule,
    enabled: booleanField(record, 'enabled') ?? fallback.enabled ?? true,
    last_run: stringField(record, 'last_run') ?? stringField(record, 'last_run_at'),
    next_run: stringField(record, 'next_run') ?? stringField(record, 'next_fire_at')
  };
}

function isUnavailableError(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  if (err.status === 404 || err.status === 405 || err.status === 501) return true;
  const lower = err.message.toLowerCase();
  return lower.includes('not implemented') || lower.includes('not found');
}

async function requestJson<T>(
  opts: RoutineClientOptions,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    Accept: 'application/json'
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const maybeTauri = await loadTauriFetch();
  const fetchImpl = maybeTauri ?? fetch;
  const res = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await res.text();
  if (!res.ok) {
    const detail = text || res.statusText;
    throw new HttpError(res.status, url, `${res.status} ${detail}`.trim());
  }
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export async function createRoutine(
  opts: RoutineClientOptions,
  input: CreateRoutineRequest
): Promise<CreateRoutineResult> {
  const body: CreateRoutineRequest = {
    name: input.name.trim(),
    schedule: input.schedule.trim(),
    prompt: input.prompt.trim(),
    enabled: input.enabled
  };

  try {
    const payload = await requestJson<unknown>(opts, 'POST', '/api/routines', body);
    return { ok: true, routine: mapRoutine(payload, body) };
  } catch (err) {
    if (isUnavailableError(err)) return { ok: false, reason: 'unavailable' };
    throw err;
  }
}
