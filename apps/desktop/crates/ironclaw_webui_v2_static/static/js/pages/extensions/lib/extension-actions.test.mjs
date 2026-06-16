import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GOOGLE_OAUTH_SETTINGS_PATH,
  connectorFamily,
  connectorKey,
  connectorSetupGuidance,
  googleOauthSettingsHref,
  isGoogleConnector,
  primaryExtensionAction,
  registryConnectButtonState,
  registryStatusBadge,
  setupReadyForActivation
} from './extension-actions.js';

const notionRef = { kind: 'extension', id: 'notion' };

test('primaryExtensionAction opens configuration before OAuth-required activation', () => {
  assert.equal(
    primaryExtensionAction({
      package_ref: notionRef,
      kind: 'mcp_server',
      onboarding_state: 'auth_required'
    }),
    'configure'
  );
});

test('primaryExtensionAction activates configured inactive MCP extensions', () => {
  assert.equal(
    primaryExtensionAction({
      package_ref: notionRef,
      kind: 'mcp_server',
      activation_status: 'installed'
    }),
    'activate'
  );
});

test('primaryExtensionAction reopens setup for failed extensions', () => {
  assert.equal(
    primaryExtensionAction({
      package_ref: notionRef,
      kind: 'mcp_server',
      activation_status: 'failed'
    }),
    'configure'
  );
});

test('primaryExtensionAction hides activation for active extensions', () => {
  assert.equal(
    primaryExtensionAction({
      package_ref: notionRef,
      kind: 'mcp_server',
      active: true
    }),
    null
  );
});

test('setupReadyForActivation waits until all setup secrets are provided', () => {
  assert.equal(
    setupReadyForActivation({
      secrets: [{ provided: true }, { provided: true }],
      fields: []
    }),
    true
  );
  assert.equal(
    setupReadyForActivation({
      secrets: [{ provided: true }, { provided: false }],
      fields: []
    }),
    false
  );
  assert.equal(
    setupReadyForActivation({
      secrets: [{ provided: true }],
      fields: [{ name: 'workspace' }]
    }),
    false
  );
});

test('registryConnectButtonState makes manual-token setup actionable', () => {
  assert.deepEqual(registryConnectButtonState({ phase: 'needs-token' }), {
    label: 'Open setup',
    disabled: false,
    action: 'manual_setup',
    variant: 'secondary'
  });
});

test('connector helpers identify catalog refs without leaking slash-prefixed lifecycle names', () => {
  assert.equal(connectorKey({ package_ref: { id: 'tools/google_calendar' } }), 'google-calendar');
  assert.equal(connectorKey({ packageRef: { id: 'channels/slack_tool' } }), 'slack');
  assert.equal(connectorFamily({ package_ref: { id: 'mcp-servers/notion' } }), 'notion');
  assert.equal(isGoogleConnector({ package_ref: { id: 'tools/gmail' } }), true);
  assert.equal(isGoogleConnector({ package_ref: { id: 'tools/google_drive' } }), true);
  assert.equal(isGoogleConnector({ package_ref: { id: 'tools/google_sheets' } }), true);
  assert.equal(isGoogleConnector({ package_ref: { id: 'mcp-servers/notion' } }), false);
});

test('Google connector guidance points blocked users to the settings client-id target', () => {
  const guidance = connectorSetupGuidance(
    { package_ref: { id: 'tools/gmail' } },
    { connectPhase: { phase: 'blocked-google-client-id' } }
  );

  assert.equal(guidance.title, 'Needs Google sign-in setup');
  assert.equal(guidance.href, GOOGLE_OAUTH_SETTINGS_PATH);
  assert.match(guidance.body, /Desktop app client ID/);
  assert.deepEqual(
    registryConnectButtonState(
      { phase: 'blocked-google-client-id' },
      { package_ref: { id: 'tools/google_calendar' } }
    ),
    {
      label: 'Open Google setup',
      disabled: false,
      action: 'google_settings',
      variant: 'secondary',
      href: GOOGLE_OAUTH_SETTINGS_PATH
    }
  );
});

test('Google connector guidance stays scoped inside the hosted /v2 app', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { pathname: '/v2/extensions/registry' } };

  try {
    assert.equal(googleOauthSettingsHref(), '/v2/settings/inference#google-oauth');
    assert.equal(
      connectorSetupGuidance(
        { package_ref: { id: 'tools/gmail' } },
        { connectPhase: { phase: 'blocked-google-client-id' } }
      ).href,
      '/v2/settings/inference#google-oauth'
    );
    assert.equal(
      registryConnectButtonState(
        { phase: 'blocked-google-client-id' },
        { package_ref: { id: 'tools/google_calendar' } }
      ).href,
      '/v2/settings/inference#google-oauth'
    );
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test('connectorSetupGuidance gives honest connector-specific setup copy', () => {
  assert.match(
    connectorSetupGuidance({ package_ref: { id: 'mcp-servers/notion' } })?.body,
    /opens Notion/
  );
  assert.match(
    connectorSetupGuidance({ package_ref: { id: 'channels/slack' } })?.body,
    /workspace install|pairing/
  );
  assert.match(
    connectorSetupGuidance({ package_ref: { id: 'workspace' } })?.body,
    /local folder|gateway/
  );
});

test('registryStatusBadge flags a blocked Google client id as BLOCKED', () => {
  assert.deepEqual(
    registryStatusBadge(
      { package_ref: { id: 'tools/gmail' } },
      { phase: 'blocked-google-client-id' }
    ),
    { tone: 'danger', label: 'BLOCKED' }
  );
});

test('registryStatusBadge flags a needs-token connector as NEEDS SETUP', () => {
  assert.deepEqual(registryStatusBadge({ package_ref: { id: 'tools/custom' } }, { phase: 'needs-token' }), {
    tone: 'warning',
    label: 'NEEDS SETUP'
  });
});

test('registryStatusBadge flags connectors with resting setup guidance as NEEDS SETUP', () => {
  assert.deepEqual(registryStatusBadge({ package_ref: { id: 'mcp-servers/notion' } }), {
    tone: 'warning',
    label: 'NEEDS SETUP'
  });
  assert.deepEqual(registryStatusBadge({ package_ref: { id: 'channels/slack' } }), {
    tone: 'warning',
    label: 'NEEDS SETUP'
  });
});

test('registryStatusBadge flags blocked Google before its setup guidance', () => {
  // blocked-google-client-id also produces guidance.title; BLOCKED must win.
  assert.deepEqual(
    registryStatusBadge(
      { package_ref: { id: 'tools/google_calendar' } },
      { phase: 'blocked-google-client-id' }
    ),
    { tone: 'danger', label: 'BLOCKED' }
  );
});

test('registryStatusBadge leaves a plain connector AVAILABLE at rest', () => {
  assert.deepEqual(registryStatusBadge({ package_ref: { id: 'tools/web_search' } }), {
    tone: 'muted',
    label: 'AVAILABLE'
  });
  // Google has no resting setup-guidance title, so it reads ready until a phase says otherwise.
  assert.deepEqual(registryStatusBadge({ package_ref: { id: 'tools/gmail' } }), {
    tone: 'muted',
    label: 'AVAILABLE'
  });
  assert.deepEqual(registryStatusBadge({ package_ref: { id: 'tools/web_search' } }, undefined), {
    tone: 'muted',
    label: 'AVAILABLE'
  });
});

test('registryConnectButtonState keeps running and connected phases disabled', () => {
  assert.deepEqual(registryConnectButtonState({ phase: 'waiting' }), {
    label: 'Finish in your browser...',
    disabled: true,
    action: 'wait',
    variant: 'primary'
  });
  assert.deepEqual(registryConnectButtonState({ phase: 'connected' }), {
    label: 'Connected',
    disabled: true,
    action: 'none',
    variant: 'secondary'
  });
  assert.deepEqual(registryConnectButtonState({ phase: 'error' }), {
    label: 'Retry connect',
    disabled: false,
    action: 'connect',
    variant: 'primary'
  });
});
