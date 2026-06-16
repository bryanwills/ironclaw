// One-click Google sign-in setup (desktop only).
//
// The bundled engine serves the full Google OAuth flow but needs a client id
// at spawn. A GUI app never sees shell env, so the id lives in the desktop
// settings file (client ids are public identifiers — not secrets) and the
// sidecar reads it on start. Saving offers an immediate engine restart so the
// next Gmail/Calendar connect opens the browser instead of asking for a
// pasted token.
import { React, html } from '../../../lib/html.js';
import { Card } from '../../../design-system/card.js';
import { Button } from '../../../design-system/button.js';
import { useT } from '../../../lib/i18n.js';
import { isDesktopRuntime, openExternalUrl, tauriInvoke } from '../../../lib/api.js';

const CONSOLE_URL = 'https://console.cloud.google.com/apis/credentials';

export function GoogleOauthCard() {
  const t = useT();
  const [clientId, setClientId] = React.useState('');
  const [savedId, setSavedId] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [statusLine, setStatusLine] = React.useState('');
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!isDesktopRuntime()) return;
    (async () => {
      try {
        const settings = (await tauriInvoke('get_settings')) || {};
        const existing = String(settings.googleOauthClientId || '');
        setClientId(existing);
        setSavedId(existing);
      } catch (_) {
        // First run / no settings yet — leave the field empty.
      }
    })();
  }, []);

  if (!isDesktopRuntime()) return null;

  const applyAndRestart = async () => {
    setBusy(true);
    setError('');
    setStatusLine(t('googleOauth.saving'));
    try {
      const settings = (await tauriInvoke('get_settings')) || {};
      settings.googleOauthClientId = clientId.trim();
      await tauriInvoke('save_settings', { settings });
      setSavedId(clientId.trim());

      setStatusLine(t('googleOauth.restarting'));
      const profileId = String(settings.activeProfileId || 'default');
      try {
        await tauriInvoke('stop_sidecar');
      } catch (_) {
        // Not running — fine, start fresh.
      }
      await tauriInvoke('start_sidecar', { profileId });
      setStatusLine(t('googleOauth.applied'));
    } catch (err) {
      setError(String(err?.message || err));
      setStatusLine('');
    } finally {
      setBusy(false);
    }
  };

  const dirty = clientId.trim() !== savedId;

  return html`
    <${Card} id=${'google-oauth'} padding="none" className="scroll-mt-6 p-4 sm:p-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3
          className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--v2-accent-text)]"
        >
          ${t('googleOauth.title')}
        </h3>
        <span
          className=${[
            'rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]',
            savedId
              ? 'border-[color-mix(in_srgb,var(--v2-positive-text)_34%,var(--v2-panel-border))] text-[var(--v2-positive-text)]'
              : 'border-[color-mix(in_srgb,var(--v2-warning-text)_34%,var(--v2-panel-border))] text-[var(--v2-warning-text)]'
          ].join(' ')}
        >
          ${savedId ? 'ready' : 'needs client ID'}
        </span>
      </div>
      <p className="mb-3 text-sm leading-relaxed text-[var(--v2-text-muted)]">
        ${t('googleOauth.desc')}
      </p>
      <div
        className=${[
          'mb-3 rounded-[10px] border px-3 py-2 text-xs leading-5',
          savedId
            ? 'border-[color-mix(in_srgb,var(--v2-positive-text)_24%,var(--v2-panel-border))] bg-[var(--v2-positive-soft)] text-[var(--v2-positive-text)]'
            : 'border-[color-mix(in_srgb,var(--v2-warning-text)_28%,var(--v2-panel-border))] bg-[var(--v2-warning-soft)] text-[var(--v2-warning-text)]'
        ].join(' ')}
      >
        ${savedId
          ? 'Gmail and Calendar can now open browser sign-in from the Extensions registry.'
          : 'Google connectors are blocked until a Desktop app client ID is saved here. Hosted Google OAuth is not available from this gateway yet.'}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="text"
          value=${clientId}
          onInput=${(e) => setClientId(e.target.value)}
          placeholder=${t('googleOauth.placeholder')}
          spellcheck="false"
          autocomplete="off"
          className="min-w-0 flex-1 rounded-[10px] border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] px-3 py-2 text-sm text-[var(--v2-text)] placeholder:text-[var(--v2-text-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--v2-accent)]/50"
        />
        <${Button}
          variant="primary"
          size="sm"
          disabled=${busy || !dirty}
          onClick=${applyAndRestart}
        >
          ${t('googleOauth.apply')}
        <//>
      </div>
      <div className="mt-2 flex items-center gap-3 text-xs text-[var(--v2-text-muted)]">
        <button
          type="button"
          onClick=${() => openExternalUrl(CONSOLE_URL)}
          className="text-[var(--v2-accent-text)] hover:underline"
        >
          ${t('googleOauth.getClientId')}
        </button>
        <span>${t('googleOauth.hint')}</span>
      </div>
      ${statusLine &&
      html`<p className="mt-2 text-xs text-[var(--v2-positive-text)]">${statusLine}</p>`}
      ${error && html`<p className="mt-2 text-xs text-[var(--v2-danger-text)]">${error}</p>`}
    <//>
  `;
}
