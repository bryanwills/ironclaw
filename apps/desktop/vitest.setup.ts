// Vitest setup — runs once per worker before any test file.
//
// Wires `expect(...).toBeInTheDocument()` and friends, and stubs the
// Tauri IPC surface to no-op by default so components don't blow up
// trying to talk to the Rust side. Individual tests can override
// these mocks via `vi.mocked(...).mockResolvedValueOnce(...)`.

import '@testing-library/jest-dom/vitest';
import { vi, beforeEach } from 'vitest';

// ---- Tauri API stubs ------------------------------------------------------
//
// `@tauri-apps/api/core` `invoke` is the single funnel for every
// JS → Rust call. Real handlers don't exist in jsdom, so default to
// undefined — callers that care about a specific command can override
// per-test.

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
  sendNotification: vi.fn().mockResolvedValue(undefined),
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue('granted')
}));

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn().mockResolvedValue(null)
}));

// ---- localStorage ----------------------------------------------------------
//
// jsdom ships a localStorage, but the tests reset between cases to
// keep them order-independent. Some node/vitest combinations expose
// a global without `clear` — guard the call so an exotic runtime
// doesn't take down every test.

beforeEach(() => {
  if (typeof localStorage !== 'undefined' && typeof localStorage.clear === 'function') {
    localStorage.clear();
  }
});
