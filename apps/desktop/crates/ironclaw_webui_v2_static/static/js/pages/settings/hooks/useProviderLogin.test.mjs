import assert from 'node:assert/strict';
import test from 'node:test';

import { providerLoginOrigin, walletLoginUrl } from './useProviderLogin.js';

const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;

function installWindow({ origin = 'tauri://localhost', pathname = '/', tauri = false } = {}) {
  const store = new Map();
  const localStorage = {
    getItem: (key) => store.get(key) || null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
  };

  globalThis.window = {
    location: { origin, pathname },
    localStorage,
    __TAURI_INTERNALS__: tauri ? { invoke: () => {} } : undefined
  };
  globalThis.localStorage = localStorage;
  return { localStorage };
}

test.afterEach(() => {
  if (originalWindow === undefined) {
    delete globalThis.window;
  } else {
    globalThis.window = originalWindow;
  }

  if (originalLocalStorage === undefined) {
    delete globalThis.localStorage;
  } else {
    globalThis.localStorage = originalLocalStorage;
  }
});

test('walletLoginUrl targets the root route inside the packaged desktop app', () => {
  installWindow({ pathname: '/' });

  assert.equal(
    walletLoginUrl('nearai-wallet-login:abc 123'),
    '/wallet/connect?channel=nearai-wallet-login%3Aabc%20123'
  );
});

test('walletLoginUrl keeps /v2 only when the hosted static UI is mounted under /v2', () => {
  installWindow({ pathname: '/v2/settings/inference' });

  assert.equal(
    walletLoginUrl('nearai-wallet-login:abc 123'),
    '/v2/wallet/connect?channel=nearai-wallet-login%3Aabc%20123'
  );
});

test('providerLoginOrigin uses the local gateway origin inside Tauri', () => {
  const { localStorage } = installWindow({ tauri: true });
  localStorage.setItem('ironclaw:desktop-gateway-origin', 'http://127.0.0.1:3100/');

  assert.equal(providerLoginOrigin(), 'http://127.0.0.1:3100');
});

test('providerLoginOrigin uses the browser origin outside Tauri', () => {
  installWindow({ origin: 'https://ironclaw.example/v2' });

  assert.equal(providerLoginOrigin(), 'https://ironclaw.example/v2');
});
