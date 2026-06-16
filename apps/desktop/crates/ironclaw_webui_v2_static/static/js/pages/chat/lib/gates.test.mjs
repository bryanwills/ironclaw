import assert from 'node:assert/strict';
import test from 'node:test';

import { formatGateParameters, gateFromEvent, gateFromProjection } from './gates.js';

test('gateFromEvent preserves approval tool metadata and allow-always support', () => {
  const gate = gateFromEvent('gate', {
    request_id: 'approval-request-1',
    turn_run_id: 'run-1',
    gate_ref: 'gate-1',
    headline: 'Approve sending an email',
    body: 'IronClaw wants to send a customer email.',
    tool_name: 'send_email',
    description: 'Send email to customer@example.com',
    parameters: {
      to: 'customer@example.com',
      subject: 'Services agreement'
    },
    allow_always: true
  });

  assert.deepEqual(gate, {
    kind: 'gate',
    requestId: 'approval-request-1',
    runId: 'run-1',
    gateRef: 'gate-1',
    headline: 'Approve sending an email',
    body: 'IronClaw wants to send a customer email.',
    toolName: 'send_email',
    description: 'Send email to customer@example.com',
    parameters: '{\n  "to": "customer@example.com",\n  "subject": "Services agreement"\n}',
    allowAlways: true
  });
});

test('gateFromEvent maps Reborn approval_context into approval card details', () => {
  const gate = gateFromEvent('gate', {
    turn_run_id: 'run-context-1',
    gate_ref: 'gate-context-1',
    headline: 'Approve external request',
    body: 'This action needs approval before anything leaves the machine.',
    allow_always: true,
    approval_context: {
      tool_name: 'http_post',
      action: { label: 'POST request', method: 'POST' },
      scope: { label: 'This endpoint', reusable: false },
      reason: 'Send the prepared payload to the webhook.',
      destination: {
        label: 'Webhook endpoint',
        domain: 'hooks.example.com',
        url: 'https://hooks.example.com/inbound'
      },
      details: [
        { label: 'Estimated transfer', value: '4096 bytes' },
        { label: 'Payload', value: 'services agreement summary' }
      ]
    }
  });

  assert.deepEqual(gate, {
    kind: 'gate',
    requestId: 'gate-context-1',
    runId: 'run-context-1',
    gateRef: 'gate-context-1',
    headline: 'Approve external request',
    body: 'This action needs approval before anything leaves the machine.',
    toolName: 'http_post',
    description: 'Send the prepared payload to the webhook.',
    parameters:
      '{\n' +
      '  "action": "POST request",\n' +
      '  "method": "POST",\n' +
      '  "scope": "This endpoint",\n' +
      '  "reusable_scope": false,\n' +
      '  "reason": "Send the prepared payload to the webhook.",\n' +
      '  "destination": "Webhook endpoint",\n' +
      '  "destination_domain": "hooks.example.com",\n' +
      '  "destination_url": "https://hooks.example.com/inbound",\n' +
      '  "details": {\n' +
      '    "Estimated transfer": "4096 bytes",\n' +
      '    "Payload": "services agreement summary"\n' +
      '  }\n' +
      '}',
    allowAlways: true
  });
});

test('gateFromEvent keeps explicit flat parameters ahead of approval_context fallback', () => {
  const gate = gateFromEvent('gate', {
    turn_run_id: 'run-flat-1',
    gate_ref: 'gate-flat-1',
    headline: 'Approve send',
    tool_name: 'send_email',
    description: 'Send email',
    parameters: { to: 'legal@example.com' },
    approval_context: {
      tool_name: 'http_post',
      action: { label: 'POST request', method: 'POST' },
      scope: { label: 'This endpoint', reusable: false },
      destination: { label: 'Webhook endpoint' }
    }
  });

  assert.equal(gate.toolName, 'send_email');
  assert.equal(gate.description, 'Send email');
  assert.equal(gate.parameters, '{\n  "to": "legal@example.com"\n}');
});

test('gateFromProjection keeps projected gate honest without fabricating tool metadata', () => {
  const gate = gateFromProjection('run-2', {
    gate_ref: 'gate-2',
    headline: 'Approval required',
    allow_always: true
  });

  assert.deepEqual(gate, {
    kind: 'gate',
    requestId: 'gate-2',
    runId: 'run-2',
    gateRef: 'gate-2',
    headline: 'Approval required',
    body: '',
    toolName: '',
    description: '',
    parameters: '',
    allowAlways: true
  });
});

test('formatGateParameters returns strings as-is and hides absent values', () => {
  assert.equal(formatGateParameters('{"already":"redacted"}'), '{"already":"redacted"}');
  assert.equal(formatGateParameters(null), '');
  assert.equal(formatGateParameters(undefined), '');
  assert.equal(formatGateParameters(''), '');
});
