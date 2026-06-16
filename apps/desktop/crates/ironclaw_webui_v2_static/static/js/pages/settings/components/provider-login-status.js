import { html } from '../../../lib/html.js';
import { useT } from '../../../lib/i18n.js';

// Shared status surface for the NEAR AI login flow driven by
// `useProviderLogin`. Both the onboarding screen and the Settings → Inference tab
// drop this in so the two surfaces stay identical.
export function ProviderLoginStatus({ login }) {
  const t = useT();
  const { nearaiBusy, nearaiError } = login;

  return html`
    ${nearaiBusy &&
    html`<div className="text-center text-xs text-[var(--v2-text-muted)]">
      ${t('onboarding.nearaiWaiting')}
    </div>`}
    ${nearaiError &&
    html`<div className="text-center text-xs text-[var(--v2-danger-text)]">${nearaiError}</div>`}
  `;
}
