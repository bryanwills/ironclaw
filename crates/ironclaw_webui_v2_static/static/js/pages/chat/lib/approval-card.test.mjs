import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function approvalCardSourceForTest() {
  const source = readFileSync(new URL('../components/approval-card.js', import.meta.url), 'utf8');
  const lines = [];
  let skippingImport = false;
  for (const line of source.split('\n')) {
    if (!skippingImport && line.startsWith('import ')) {
      skippingImport = !line.trimEnd().endsWith(';');
      continue;
    }
    if (skippingImport) {
      skippingImport = !line.trimEnd().endsWith(';');
      continue;
    }
    lines.push(line.replace('export function ApprovalCard', 'function ApprovalCard'));
  }
  return `${lines.join('\n')}\nglobalThis.__testExports = { ApprovalCard };`;
}

function textContent(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join(' ');
  if (typeof node !== 'object' || !Array.isArray(node.values)) return '';
  return node.values.map(textContent).join(' ');
}

// Full markup walk (static template strings + interpolated values), so
// structural/class assertions can prove how a field is rendered, not just its
// visible text.
function markup(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(markup).join(' ');
  if (typeof node !== 'object') return '';
  const strings = Array.isArray(node.strings) ? node.strings.join(' ') : '';
  const values = Array.isArray(node.values) ? node.values.map(markup).join(' ') : '';
  return `${strings} ${values}`;
}

function renderApprovalCard({
  alwaysState = false,
  risk = { tone: 'danger', key: 'tool.riskSend', allowAlways: false },
  gateOverride = null,
  onApprove,
  onDeny,
  onAlways
} = {}) {
  const listeners = new Map();
  const cleanups = [];
  const components = {
    Badge() {},
    Button() {},
    Icon() {}
  };
  const translations = {
    'approval.title': 'Approval required',
    'approval.approve': 'Approve',
    'approval.deny': 'Deny',
    'approval.approveAndAlways': 'Approve & always allow',
    'approval.alwaysAllowToolLabel': 'Always allow {tool} without asking',
    'approval.alwaysUnavailable':
      'Always allow is unavailable for this kind of action. IronClaw must ask each time.',
    'approval.thisTool': 'this tool',
    'approval.nothingSentYet': 'Nothing has been sent yet.',
    'approval.actionLabel': 'Action',
    'approval.targetLabel': 'Target / resource',
    'approval.destinationLabel': 'Destination',
    'approval.outboundDataLabel': 'Outbound data',
    'approval.touchesLabel': 'Touches',
    'approval.whatLeavesMachineLabel': 'What leaves the machine',
    'approval.notSpecified': 'Not specified by the tool.',
    'approval.parametersLabel': 'Parameters',
    'approval.shortcutHint': 'Cmd/Ctrl+Enter approve / Esc deny',
    'projects.card.risk': 'Risk',
    'tool.riskRead': 'reads',
    'tool.riskSend': 'sends externally'
  };
  const context = {
    ...components,
    React: {
      useCallback: (fn) => fn,
      useEffect: (fn) => {
        const cleanup = fn();
        if (cleanup) cleanups.push(cleanup);
      },
      useMemo: (fn) => fn(),
      useState: () => [alwaysState, () => {}]
    },
    classifyRisk: () => risk,
    globalThis: {},
    html: (strings, ...values) => ({ strings: Array.from(strings), values }),
    useT:
      () =>
      (key, params = {}) =>
        (translations[key] || key).replace(/\{(\w+)\}/g, (_match, name) => params[name] || '')
  };
  context.window = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    }
  };

  vm.runInNewContext(approvalCardSourceForTest(), context);
  const tree = context.globalThis.__testExports.ApprovalCard({
    gate: gateOverride || {
      toolName: 'send_email',
      description: 'Send the generated services agreement to legal review.',
      parameters: JSON.stringify(
        {
          recipient: 'legal-review@example.com',
          subject: 'Draft services agreement',
          body: 'Please find the agreement attached for review.',
          cc: ['counsel@example.com'],
          bcc: 'records@example.com',
          attachment_name: 'services-agreement.docx'
        },
        null,
        2
      ),
      allowAlways: true
    },
    onApprove,
    onDeny,
    onAlways
  });
  return { tree, components, listeners, cleanups };
}

test('ApprovalCard names literal action fields, unknown outbound data, and shortcuts', () => {
  const { tree, cleanups } = renderApprovalCard();

  const visible = textContent(tree);
  assert.match(visible, /Nothing has been sent yet\./);
  assert.match(visible, /Send the generated services agreement to legal review\./);
  assert.match(visible, /Action/);
  assert.match(visible, /send_email/);
  assert.match(visible, /Touches/);
  assert.match(visible, /Destination/);
  assert.match(visible, /legal-review@example\.com/);
  assert.match(visible, /What leaves the machine/);
  // Every field that genuinely leaves the machine is disclosed in the outbound
  // section — subject and body are sent content; cc/bcc are additional parties
  // the data reaches. None may silently vanish behind a first-match.
  assert.match(visible, /subject: Draft services agreement/);
  assert.match(visible, /body: Please find the agreement attached for review\./);
  assert.match(visible, /cc: counsel@example\.com/);
  assert.match(visible, /bcc: records@example\.com/);
  // Regression: the attachment that was already disclosed before this change is
  // still listed, so expanding the outbound set never dropped a prior field.
  assert.match(visible, /attachment: services-agreement\.docx/);
  assert.match(visible, /Always allow is unavailable/);
  assert.match(visible, /Parameters/);
  assert.match(visible, /legal-review@example\.com/);
  assert.match(visible, /Cmd\/Ctrl\+Enter approve \/ Esc deny/);
  assert.match(visible, /Approve/);
  assert.match(visible, /Deny/);
  // The risk classification is explicitly named (not just an unlabeled pill).
  assert.match(visible, /Risk/);
  assert.match(visible, /sends externally/);

  // Craft contract: the sent-yet boundary reads as a distinct strong-weight
  // statement, and the two data-movement fields (destination + outbound) are
  // visually emphasized so the safety crux scans above honest-empty fields.
  const all = markup(tree);
  assert.match(all, /shield/, 'sent-yet boundary keeps the shield affordance');
  // The boundary statement is rendered as its own bordered, strong-weight bar.
  assert.match(
    all,
    /text-\[var\(--v2-text-strong\)\][^]*?Nothing has been sent yet/,
    'sent-yet boundary uses strong text weight'
  );
  // Emphasis (strong-weight value + bordered cell) is present for the
  // data-movement fields that actually carry data. For a high-risk (danger)
  // gate — the default fixture is a send_email — those egress fields escalate
  // to danger tone so destination/outbound read as the safety crux, not the
  // decorative gold used for benign structured fields.
  assert.match(all, /font-semibold text-\[var\(--v2-danger-text\)\]/);
  assert.match(all, /bg-\[var\(--v2-danger-soft\)\]/);
  // The outbound disclosures are anchored under the "What leaves the machine"
  // label, not stranded elsewhere on the card — the gate's data-egress claim
  // must be the thing that actually enumerates what egresses.
  assert.match(
    all,
    /What leaves the machine[^]*?subject: Draft services agreement[^]*?bcc: records@example\.com/,
    'outbound fields render under the outbound label'
  );
  cleanups.forEach((cleanup) => cleanup());
});

test('ApprovalCard keeps benign (non-danger) egress fields on structured gold, not danger tone', () => {
  const { tree, cleanups } = renderApprovalCard({
    risk: { tone: 'muted', key: 'tool.riskRead', allowAlways: true },
  });
  const all = markup(tree);
  // A low-risk gate's emphasized data-movement fields stay on the structured
  // strong/gold treatment — danger tone is reserved for high-risk egress.
  assert.match(all, /font-medium text-\[var\(--v2-text-strong\)\]/);
  assert.doesNotMatch(all, /bg-\[var\(--v2-danger-soft\)\]/);
  assert.doesNotMatch(all, /font-semibold text-\[var\(--v2-danger-text\)\]/);
  cleanups.forEach((cleanup) => cleanup());
});

test('ApprovalCard outbound section enumerates fields nested one level deep and dedupes a key reachable twice', () => {
  const { tree, cleanups } = renderApprovalCard({
    gateOverride: {
      toolName: 'send_email',
      description: 'Send the prepared note.',
      // `subject` lives both at top level and in the nested params object. The
      // outbound search visits both depths, so without dedupe it would list the
      // identical subject twice. A distinct nested `body`/`bcc` must still show.
      parameters: JSON.stringify(
        {
          to: 'ops@example.com',
          subject: 'Status update',
          args: {
            subject: 'Status update',
            body: 'All systems nominal.',
            bcc: 'audit@example.com'
          }
        },
        null,
        2
      ),
      allowAlways: true
    }
  });

  const visible = textContent(tree);
  // Primary recipient is the Destination, not an outbound content field.
  assert.match(visible, /ops@example\.com/);
  // Nested outbound fields are disclosed.
  assert.match(visible, /subject: Status update/);
  assert.match(visible, /body: All systems nominal\./);
  assert.match(visible, /bcc: audit@example\.com/);
  // The identical subject reachable at both depths collapses to one entry.
  const all = markup(tree);
  const outboundSection = all.slice(all.indexOf('What leaves the machine'));
  const subjectMentions = (outboundSection.match(/subject: Status update/g) || []).length;
  assert.equal(subjectMentions, 1, 'a key reachable at two depths is listed once');
  cleanups.forEach((cleanup) => cleanup());
});

test('ApprovalCard keyboard shortcuts approve and deny while ignoring editable text fields', () => {
  const calls = [];
  const { listeners, cleanups } = renderApprovalCard({
    onApprove: () => calls.push('approve'),
    onDeny: () => calls.push('deny')
  });
  const onKeyDown = listeners.get('keydown');
  assert.equal(typeof onKeyDown, 'function');

  onKeyDown({
    key: 'Enter',
    metaKey: true,
    target: { tagName: 'TEXTAREA' },
    preventDefault: () => calls.push('prevented-textarea')
  });
  onKeyDown({
    key: 'Enter',
    metaKey: true,
    target: { tagName: 'DIV' },
    preventDefault: () => calls.push('prevented-approve')
  });
  onKeyDown({
    key: 'Escape',
    target: { tagName: 'DIV' },
    preventDefault: () => calls.push('prevented-deny')
  });

  assert.deepEqual(calls, ['prevented-approve', 'approve', 'prevented-deny', 'deny']);
  cleanups.forEach((cleanup) => cleanup());
});

test('ApprovalCard Cmd/Ctrl+Enter uses always-allow when checked', () => {
  const calls = [];
  const { listeners, cleanups } = renderApprovalCard({
    alwaysState: true,
    risk: { tone: 'muted', key: 'tool.riskRead', allowAlways: true },
    onApprove: () => calls.push('approve'),
    onAlways: () => calls.push('always')
  });

  listeners.get('keydown')({
    key: 'Enter',
    ctrlKey: true,
    target: { tagName: 'DIV' },
    preventDefault: () => calls.push('prevented')
  });

  assert.deepEqual(calls, ['prevented', 'always']);
  cleanups.forEach((cleanup) => cleanup());
});
