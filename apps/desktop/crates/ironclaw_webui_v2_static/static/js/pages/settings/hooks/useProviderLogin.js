import { useQueryClient } from '@tanstack/react-query';
import { appScopedPath } from '../../../lib/app-path.js';
import { gatewayOrigin, isDesktopRuntime, openExternalUrl, tauriInvoke } from '../../../lib/api.js';
import { React } from '../../../lib/html.js';
import { useT } from '../../../lib/i18n.js';
import {
  completeNearaiWalletLogin,
  fetchLlmProviders,
  restartDesktopSidecar,
  setActiveLlm,
  startNearaiLogin,
  testLlmProviderConnection
} from '../lib/settings-api.js';

const WALLET_LOGIN_TIMEOUT_MS = 300_000;

function walletLoginChannelName() {
  const suffix =
    typeof window.crypto?.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `nearai-wallet-login:${suffix}`;
}

export function providerLoginOrigin() {
  if (isDesktopRuntime()) {
    const origin = gatewayOrigin();
    if (origin) return origin;
  }

  return window.location.origin;
}

export function walletLoginUrl(channelName) {
  return appScopedPath(`/wallet/connect?channel=${encodeURIComponent(channelName)}`);
}

// Isolated popup that connects a NEAR wallet and signs the NEAR AI login
// message. Resolves with the BroadcastChannel payload, or null if the user
// cancels, closes the window, or the deadline passes.
function awaitWalletSignature(popup, channelName) {
  return new Promise((resolve) => {
    if (typeof window.BroadcastChannel !== 'function') {
      resolve(null);
      return;
    }
    const channel = new window.BroadcastChannel(channelName);
    const onMessage = (event) => {
      const data = event.data;
      if (!data || data.type !== 'nearai-wallet-login') return;
      cleanup();
      resolve(data.ok ? data : null);
    };
    const closedTimer = setInterval(() => {
      if (popup && popup.closed) {
        cleanup();
        resolve(null);
      }
    }, 500);
    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, WALLET_LOGIN_TIMEOUT_MS);
    function cleanup() {
      clearInterval(closedTimer);
      clearTimeout(timeout);
      channel.removeEventListener('message', onMessage);
      channel.close();
    }
    channel.addEventListener('message', onMessage);
  });
}

// How long to keep polling the snapshot for a login to land before giving up.
const NEARAI_POLL_DEADLINE_MS = 300_000;
const POLL_INTERVAL_MS = 2000;

// Poll the LLM snapshot until `providerId` becomes the active provider, or the
// deadline passes. Returns true on success.
//
// Self-healing: the backend is expected to activate the provider after the
// browser callback lands, but if it only stored the session, we verify the
// credential actually works (test-connection) and flip the selection
// ourselves. Verification runs every few ticks — it is a real network call
// against the provider.
const ACTIVATE_PROBE_EVERY_TICKS = 3;

async function pollUntilActive(providerId, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let tick = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    tick += 1;
    const snapshot = await fetchLlmProviders().catch(() => null);
    if (snapshot?.active?.provider_id === providerId) {
      return true;
    }
    if (tick % ACTIVATE_PROBE_EVERY_TICKS !== 0) continue;
    const provider = snapshot?.providers?.find((entry) => entry?.id === providerId);
    if (!provider) continue;
    const probe = await testLlmProviderConnection({
      provider_id: providerId,
      adapter: provider.adapter || providerId,
      model: provider.active_model || provider.default_model || 'auto'
    }).catch(() => null);
    if (!probe?.ok) continue;
    await setActiveLlm({
      provider_id: providerId,
      model: provider.active_model || provider.default_model || 'auto'
    }).catch(() => {});
    const confirmed = await fetchLlmProviders().catch(() => null);
    if (confirmed?.active?.provider_id === providerId) {
      return true;
    }
  }
  return false;
}

// Shared NEAR AI login flow, surface-agnostic. The onboarding
// screen and the Settings → Inference tab both drive the same backend login
// endpoints; this hook owns the open-tab + poll-until-active choreography so the
// two surfaces stay in sync. `onSuccess` runs after the provider goes active
// (the onboarding screen navigates to chat; settings just lets the refreshed
// snapshot re-render the now-active card).
export function useProviderLogin({ onSuccess } = {}) {
  const t = useT();
  const queryClient = useQueryClient();

  const [nearaiBusy, setNearaiBusy] = React.useState(false);
  const [nearaiError, setNearaiError] = React.useState('');

  const finishActive = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['llm-providers'] });
    if (onSuccess) {
      onSuccess();
    }
  }, [queryClient, onSuccess]);

  const startNearai = React.useCallback(
    async (provider) => {
      setNearaiError('');
      setNearaiBusy(true);
      try {
        if (isDesktopRuntime()) {
          // Connect in the user's own browser session (where they're already
          // signed in): the Rust command opens cloud-api.near.ai/v1/auth/<provider>
          // with a loopback callback, captures the token, mints a long-lived sk-
          // API key, and vaults it in the keychain. Then restart the sidecar so it
          // respawns with the key in its env — never an upsert (a user nearai
          // provider def breaks gateway list-models).
          await tauriInvoke('nearai_connect_loopback', { provider });
          await restartDesktopSidecar();
          if (await pollUntilActive('nearai', NEARAI_POLL_DEADLINE_MS)) {
            await finishActive();
            return;
          }
          setNearaiError(t('onboarding.nearaiTimeout'));
          return;
        }
        const { auth_url: authUrl } = await startNearaiLogin({
          provider,
          origin: providerLoginOrigin()
        });
        const opened = await openExternalUrl(authUrl);
        if (!opened) {
          setNearaiError(t('onboarding.nearaiFailed'));
          return;
        }
        if (await pollUntilActive('nearai', NEARAI_POLL_DEADLINE_MS)) {
          await finishActive();
          return;
        }
        setNearaiError(t('onboarding.nearaiTimeout'));
      } catch (err) {
        const message = String(err?.message || err || '');
        setNearaiError(message || t('onboarding.nearaiFailed'));
      } finally {
        setNearaiBusy(false);
      }
    },
    [finishActive, t]
  );

  // NEAR wallet login can't reuse the GitHub/Google redirect: NEP-413 signing
  // happens in the browser. Open the isolated wallet popup, wait for the signed
  // message, then relay it to the backend (which exchanges it for a NEAR AI
  // session token, makes NEAR AI active, and hot-swaps the provider).
  const startNearaiWallet = React.useCallback(async () => {
    setNearaiError('');
    setNearaiBusy(true);
    try {
      const channelName = walletLoginChannelName();
      // No 'noopener'/'noreferrer': both null out window.open's return value, so
      // awaitWalletSignature could never see `popup.closed` and a cancelled
      // sign-in would dead-wait the full 5-minute timeout. The popup is a
      // same-origin app page (walletLoginUrl → appScopedPath) that talks back
      // over BroadcastChannel and holds no app state, so a real handle is safe.
      const popup = window.open(walletLoginUrl(channelName), '_blank', 'width=460,height=640');
      const signed = await awaitWalletSignature(popup, channelName);
      if (!signed) {
        setNearaiError(t('onboarding.nearaiFailed'));
        return;
      }
      await completeNearaiWalletLogin({
        account_id: signed.accountId,
        public_key: signed.publicKey,
        signature: signed.signature,
        message: signed.message,
        recipient: signed.recipient,
        nonce: signed.nonce
      });
      await finishActive();
    } catch (_err) {
      setNearaiError(t('onboarding.nearaiFailed'));
    } finally {
      setNearaiBusy(false);
    }
  }, [finishActive, t]);

  return {
    nearaiBusy,
    nearaiError,
    startNearai,
    startNearaiWallet
  };
}
