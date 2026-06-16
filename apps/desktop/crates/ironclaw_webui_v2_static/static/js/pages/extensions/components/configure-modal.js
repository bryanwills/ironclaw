import { Button } from '../../../design-system/button.js';
import { Icon } from '../../../design-system/icons.js';
import { Input } from '../../../design-system/input.js';
import { isDesktopRuntime } from '../../../lib/api.js';
import { React, html } from '../../../lib/html.js';
import { useExtensionSetup, useOauthSetup, useSetupSubmit } from '../hooks/useExtensions.js';
import { setupReadyForActivation } from '../lib/extension-actions.js';

export function ConfigureModal({ extension, onActivate, onClose, onSaved }) {
  const extensionName = extension?.displayName || extension?.packageRef?.id || 'Extension';
  const {
    secrets = [],
    fields = [],
    onboarding,
    isLoading,
    error
  } = useExtensionSetup(extension?.packageRef);
  const [values, setValues] = React.useState({});
  const [fieldValues, setFieldValues] = React.useState({});
  const oauthMutation = useOauthSetup(extension?.packageRef);

  // setup_url comes from third-party registry metadata. Bind it to an href
  // only when it parses as an https: URL — target=_blank rel=noopener does
  // NOT neutralize a javascript:/data: scheme, so a non-https value is
  // rendered as inert text instead (mirrors auth-oauth-card.js).
  const httpsSetupUrl = React.useMemo(() => {
    const raw = onboarding?.setup_url;
    if (!raw) return null;
    try {
      return new URL(raw).protocol === 'https:' ? raw : null;
    } catch {
      return null;
    }
  }, [onboarding?.setup_url]);

  const submitMutation = useSetupSubmit(extension?.packageRef, (res) => {
    if (res.success !== false) {
      if (onSaved) onSaved(res);
      onClose();
    }
  });

  const handleSubmit = React.useCallback(() => {
    const secretPayload = {};
    for (const [key, val] of Object.entries(values)) {
      const trimmed = (val || '').trim();
      if (trimmed) secretPayload[key] = trimmed;
    }
    submitMutation.mutate({ secrets: secretPayload, fields: fieldValues });
  }, [values, fieldValues, submitMutation]);
  const handleOauth = React.useCallback(
    (secret) => {
      // Desktop: the mutation routes the auth URL to the SYSTEM browser
      // (openExternalUrl) — a child webview would have no cookies/passkeys
      // and just flash dead. Hosted keeps the classic pre-opened popup so
      // the navigation stays inside the user gesture.
      const popup = isDesktopRuntime()
        ? null
        : window.open('about:blank', '_blank', 'width=600,height=600');
      if (popup) popup.opener = null;
      oauthMutation.mutate({ secret, popup });
    },
    [oauthMutation]
  );
  const manualSecrets = secrets.filter(
    (secret) => (secret.setup?.kind || 'manual_token') === 'manual_token'
  );
  const canSave = manualSecrets.length > 0 || fields.length > 0;
  const canActivate = setupReadyForActivation({ secrets, fields });

  if (isLoading) {
    return html`
      <${ModalShell} onClose=${onClose} title=${'Configure ' + extensionName}>
        <div className="space-y-3">
          ${[1, 2].map(
            (i) => html`<div key=${i} className="v2-skeleton h-10 w-full rounded-md" />`
          )}
        </div>
      <//>
    `;
  }

  if (error) {
    return html`
      <${ModalShell} onClose=${onClose} title=${'Configure ' + extensionName}>
        <p className="text-sm text-[var(--v2-danger-text)]">
          Failed to load setup: ${error.message}
        </p>
      <//>
    `;
  }

  if (secrets.length === 0 && fields.length === 0) {
    return html`
      <${ModalShell} onClose=${onClose} title=${'Configure ' + extensionName}>
        <p className="text-sm text-[var(--v2-text-muted)]">
          No configuration required for this extension.
        </p>
      <//>
    `;
  }

  return html`
    <${ModalShell} onClose=${onClose} title=${'Configure ' + extensionName}>
      ${onboarding?.credential_instructions &&
      html`
        <p className="mb-4 text-sm leading-6 text-[var(--v2-text-muted)]">
          ${onboarding.credential_instructions}
        </p>
      `}
      ${httpsSetupUrl &&
      html`
        <a
          href=${httpsSetupUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--v2-accent-text)] hover:underline"
        >
          Get credentials
          <${Icon} name="bolt" className="h-3.5 w-3.5" />
        </a>
      `}
      ${onboarding?.setup_url &&
      !httpsSetupUrl &&
      html`
        <span
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-[var(--v2-text-faint)]"
          title=${onboarding.setup_url}
        >
          Get credentials
          <${Icon} name="bolt" className="h-3.5 w-3.5" />
        </span>
      `}

      <div className="space-y-4">
        ${secrets.map(
          (secret) => html`
            <div key=${secret.name}>
              <label
                className="mb-1.5 flex items-center gap-2 text-sm font-medium text-[var(--v2-text-strong)]"
              >
                ${secret.prompt || secret.name}
                ${secret.optional &&
                html`
                  <span className="font-mono text-[10px] text-[var(--v2-text-faint)]">
                    optional
                  </span>
                `}
                ${secret.provided &&
                html`
                  <span className="font-mono text-[10px] text-[var(--v2-positive-text)]">
                    configured
                  </span>
                `}
              </label>
              ${(secret.setup?.kind || 'manual_token') === 'oauth'
                ? html`
                    <div
                      className="flex items-center justify-between gap-3 rounded-[12px] border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] px-3 py-2"
                    >
                      <span className="text-xs text-[var(--v2-text-muted)]">
                        ${secret.provided
                          ? 'Authorization is configured.'
                          : 'Authorize this provider in a browser popup.'}
                      </span>
                      <${Button}
                        variant=${secret.provided ? 'secondary' : 'primary'}
                        className="min-h-[44px] shrink-0"
                        onClick=${() => handleOauth(secret)}
                        disabled=${oauthMutation.isPending}
                      >
                        ${oauthMutation.isPending
                          ? 'Opening...'
                          : secret.provided
                            ? 'Reconnect'
                            : 'Authorize'}
                      <//>
                    </div>
                  `
                : html`
                    <${Input}
                      type="password"
                      placeholder=${secret.provided ? '••••••• (leave blank to keep)' : ''}
                      value=${values[secret.name] || ''}
                      onChange=${(e) =>
                        setValues((prev) => ({
                          ...prev,
                          [secret.name]: e.target.value
                        }))}
                      onKeyDown=${(e) => e.key === 'Enter' && handleSubmit()}
                      size="sm"
                      className="min-h-[44px]"
                    />
                    ${secret.auto_generate &&
                    !secret.provided &&
                    html`
                      <p className="mt-1 text-xs text-[var(--v2-text-faint)]">
                        Auto-generated if left blank
                      </p>
                    `}
                  `}
            </div>
          `
        )}
        ${fields.map(
          (field) => html`
            <div key=${field.name}>
              <label
                className="mb-1.5 flex items-center gap-2 text-sm font-medium text-[var(--v2-text-strong)]"
              >
                ${field.prompt || field.name}
                ${field.optional &&
                html`
                  <span className="font-mono text-[10px] text-[var(--v2-text-faint)]">
                    optional
                  </span>
                `}
              </label>
              <${Input}
                type="text"
                placeholder=${field.placeholder || ''}
                value=${fieldValues[field.name] || ''}
                onChange=${(e) =>
                  setFieldValues((prev) => ({
                    ...prev,
                    [field.name]: e.target.value
                  }))}
                onKeyDown=${(e) => e.key === 'Enter' && handleSubmit()}
                size="sm"
                className="min-h-[44px]"
              />
            </div>
          `
        )}
      </div>

      ${onboarding?.credential_next_step &&
      html`
        <p className="mt-4 text-xs leading-5 text-[var(--v2-text-muted)]">
          ${onboarding.credential_next_step}
        </p>
      `}
      ${submitMutation.error &&
      html`
        <div
          className="mt-4 rounded-[12px] border border-[color-mix(in_srgb,var(--v2-danger-text)_36%,var(--v2-panel-border))] bg-[var(--v2-danger-soft)] px-3 py-2 text-xs text-[var(--v2-danger-text)]"
        >
          ${submitMutation.error.message}
        </div>
      `}
      ${oauthMutation.error &&
      html`
        <div
          className="mt-4 rounded-[12px] border border-[color-mix(in_srgb,var(--v2-danger-text)_36%,var(--v2-panel-border))] bg-[var(--v2-danger-soft)] px-3 py-2 text-xs text-[var(--v2-danger-text)]"
        >
          ${oauthMutation.error.message}
        </div>
      `}

      <div className="mt-6 flex items-center justify-end gap-3">
        <${Button} variant="ghost" className="min-h-[44px]" onClick=${onClose}>Cancel<//>
        ${canActivate &&
        html`
          <${Button}
            variant="primary"
            className="min-h-[44px]"
            onClick=${() => onActivate?.(extension)}
          >
            Activate
          <//>
        `}
        ${canSave &&
        html`
          <${Button}
            variant=${canActivate ? 'secondary' : 'primary'}
            className="min-h-[44px]"
            onClick=${handleSubmit}
            disabled=${submitMutation.isPending}
          >
            ${submitMutation.isPending ? 'Saving…' : 'Save'}
          <//>
        `}
      </div>
    <//>
  `;
}

function ModalShell({ onClose, title, children }) {
  const panelRef = React.useRef(null);
  const restoreFocusRef = React.useRef(null);

  // Move focus into the setup dialog on open and hand it back to the opener on
  // close so keyboard users are never stranded behind the modal.
  React.useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const target = panel.querySelector(
        'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])'
      );
      (target instanceof HTMLElement ? target : panel).focus();
    });
    return () => {
      window.cancelAnimationFrame(id);
      restoreFocusRef.current?.focus?.();
      restoreFocusRef.current = null;
    };
  }, []);

  // Esc closes from anywhere inside; Tab/Shift-Tab stay trapped in the panel.
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(
      panel.querySelectorAll(
        'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
    if (items.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const activeEl = document.activeElement;
    if (event.shiftKey && (activeEl === first || activeEl === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && activeEl === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return html`
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      onKeyDown=${onKeyDown}
      onClick=${(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref=${panelRef}
        tabindex=${-1}
        data-testid="connector-setup-modal"
        className="w-full max-w-lg overflow-hidden rounded-[22px] border border-[var(--v2-panel-border)] bg-[var(--v2-card-bg)] shadow-[0_24px_60px_rgba(0,0,0,0.35)] outline-none"
        onClick=${(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between gap-4 border-b border-[var(--v2-panel-border)] px-5 py-4"
        >
          <h3 className="text-lg font-semibold text-[var(--v2-text-strong)]">${title}</h3>
          <button
            type="button"
            onClick=${onClose}
            aria-label="Close setup"
            className="grid h-11 w-11 -mr-1.5 place-items-center rounded-[10px] border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] text-[var(--v2-text-muted)] hover:bg-[var(--v2-surface-muted)] hover:text-[var(--v2-text-strong)]"
          >
            <${Icon} name="close" className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[min(70dvh,38rem)] overflow-y-auto px-5 py-4">${children}</div>
      </div>
    </div>
  `;
}
