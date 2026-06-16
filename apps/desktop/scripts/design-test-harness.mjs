#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const checks = [
  {
    id: 'DT-1',
    label: 'cold-open prepared desk',
    proof:
      'front door data ranks backed needs-you work and the empty state renders the prepared desk',
    commands: [
      {
        label: 'front-door data contract',
        args: [
          '--test',
          'crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/frontdoor-data.test.mjs'
        ]
      }
    ],
    assertions: [
      {
        label: 'Inter Variable is the app type foundation',
        file: 'crates/ironclaw_webui_v2_static/static/styles/app.css',
        includes: ['font-family: "Inter Variable"', 'inter-variable.woff2']
      },
      {
        label: 'chat cold open includes the prepared desk panel',
        file: 'crates/ironclaw_webui_v2_static/static/js/pages/chat/components/empty-state.js',
        includes: [
          'data-testid="frontdoor-panel"',
          'title="Needs you"',
          'title="Handled"',
          'variant="hero"',
          'Connect NEAR AI Cloud once'
        ]
      }
    ]
  },
  {
    id: 'DT-2',
    label: 'primary-action dominance',
    proof:
      'primary controls remain flat signal-blue tokens and Connections avoids legacy loud classes',
    commands: [
      {
        label: 'Connections design-token contract',
        args: [
          '--test',
          'crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/extensions-design-contract.test.mjs'
        ]
      }
    ],
    assertions: [
      {
        label: 'Button primary is flat token blue',
        file: 'crates/ironclaw_webui_v2_static/static/js/design-system/button.js',
        includes: ['bg-[var(--v2-accent-btn)] text-white'],
        rejects: [/bg-gradient/, /linear-gradient/, /shadow-\[/]
      },
      {
        label: 'legacy v2 primary button shim is flat token blue',
        file: 'crates/ironclaw_webui_v2_static/static/styles/app.css',
        includes: ['.v2-button-primary', 'background: var(--v2-accent-btn);'],
        rejectsInBlock: {
          start: '.v2-button-primary {',
          end: '}',
          patterns: [/linear-gradient/, /box-shadow/, /filter:/]
        }
      }
    ]
  },
  {
    id: 'DT-3',
    label: 'bicolor attribution and semantic status',
    proof:
      'gold stays reserved for agent artifacts/receipts while status states use semantic tokens',
    commands: [
      {
        label: 'static status-token lint',
        args: ['scripts/lint-static-status-tokens.mjs']
      },
      {
        label: 'chat semantic-token contract',
        args: [
          '--test',
          'crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/chat-design-contract.test.mjs'
        ]
      },
      {
        label: 'settings semantic-token contract',
        args: [
          '--test',
          'crates/ironclaw_webui_v2_static/static/js/pages/settings/lib/settings-design-contract.test.mjs'
        ]
      },
      {
        label: 'logs semantic-token contract',
        args: [
          '--test',
          'crates/ironclaw_webui_v2_static/static/js/pages/logs/logs-design-contract.test.mjs'
        ]
      },
      {
        label: 'routed/admin semantic-token contract',
        args: [
          '--test',
          'crates/ironclaw_webui_v2_static/static/js/pages/deep-link-design-contract.test.mjs'
        ]
      },
      {
        label: 'message/artifact grammar contract',
        args: [
          '--test',
          'crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/message-bubble.test.mjs'
        ]
      }
    ],
    assertions: [
      {
        label: 'generated work uses explicit gold artifact language',
        file: 'crates/ironclaw_webui_v2_static/static/js/pages/chat/components/message-bubble.js',
        includes: ['Generated document', 'Generated file', 'v2-gold']
      }
    ]
  },
  {
    id: 'DT-4',
    label: 'calm density and reduced motion',
    proof: 'no pulse/bounce/shimmer loops, static skeletons, and reduced-motion opt-in policy',
    commands: [
      {
        label: 'calm-motion contract',
        args: [
          '--test',
          'crates/ironclaw_webui_v2_static/static/js/design-system/calm-motion.test.mjs'
        ]
      }
    ],
    assertions: []
  },
  {
    id: 'DT-5',
    label: 'empty/loading dignity',
    proof: 'empty states explain what happens next and loading uses static skeleton structure',
    commands: [],
    assertions: [
      {
        label: 'front door empty states name next evidence-backed action',
        file: 'crates/ironclaw_webui_v2_static/static/js/pages/chat/components/empty-state.js',
        includes: [
          'Nothing waiting on you.',
          'Approvals and auth gates appear here when they are backed by a thread.',
          'No completed receipts yet.',
          'Completed actions, automations, and recent work appear here once IronClaw has evidence.'
        ]
      },
      {
        label: 'installed Connections empty state has a next action',
        file: 'crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/installed-tab.js',
        includes: ['No apps connected yet', 'Browse apps']
      },
      {
        label: 'knowledge-app empty state has a next action',
        file: 'crates/ironclaw_webui_v2_static/static/js/pages/extensions/components/mcp-tab.js',
        includes: ['No knowledge apps connected', 'Browse knowledge apps']
      },
      {
        label: 'skeleton primitive is non-animated',
        file: 'crates/ironclaw_webui_v2_static/static/styles/app.css',
        includes: ['.v2-skeleton', 'animation: none;']
      }
    ]
  },
  {
    id: 'DT-6',
    label: 'gate craft',
    proof:
      'approval cards name action, touched resources, outbound data, sent-yet boundary, and keyboard controls',
    commands: [
      {
        label: 'approval-card craft contract',
        args: [
          '--test',
          'crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/approval-card.test.mjs'
        ]
      }
    ],
    assertions: [
      {
        label: 'approval card source keeps user-visible risk labels',
        file: 'crates/ironclaw_webui_v2_static/static/js/pages/chat/components/approval-card.js',
        includes: [
          'approval.nothingSentYet',
          'approval.touchesLabel',
          'approval.whatLeavesMachineLabel',
          'approval.shortcutHint'
        ]
      }
    ]
  },
  {
    id: 'COPY',
    label: 'desktop copy discipline',
    proof: 'normal product copy does not leak third-party/provider/admin jargon',
    commands: [
      {
        label: 'static copy lint',
        args: ['scripts/lint-static-copy.mjs']
      }
    ],
    assertions: []
  }
];

const failures = [];

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function blockBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) return null;
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) return null;
  return source.slice(startIndex, endIndex + end.length);
}

function runNodeCommand(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim()
  };
}

function assertFile({ id, assertion }) {
  const source = read(assertion.file);
  for (const fragment of assertion.includes || []) {
    if (!source.includes(fragment)) {
      failures.push(`${id} ${assertion.label}: missing ${JSON.stringify(fragment)}`);
    }
  }
  for (const pattern of assertion.rejects || []) {
    if (pattern.test(source)) {
      failures.push(`${id} ${assertion.label}: rejected pattern ${pattern}`);
    }
  }
  if (assertion.rejectsInBlock) {
    const { start, end, patterns } = assertion.rejectsInBlock;
    const block = blockBetween(source, start, end);
    if (!block) {
      failures.push(`${id} ${assertion.label}: missing block starting ${JSON.stringify(start)}`);
    } else {
      for (const pattern of patterns) {
        if (pattern.test(block)) {
          failures.push(`${id} ${assertion.label}: rejected pattern ${pattern} in block`);
        }
      }
    }
  }
}

console.log('IronClaw static design-test harness');
console.log('DT-1..DT-6 map to the shipped static UI, not the legacy Svelte surface.');

for (const check of checks) {
  console.log(`\n${check.id} ${check.label}`);
  console.log(`  proof: ${check.proof}`);

  for (const assertion of check.assertions) {
    assertFile({ id: check.id, assertion });
  }

  for (const command of check.commands) {
    const result = runNodeCommand(command.args);
    if (result.status !== 0) {
      failures.push(`${check.id} ${command.label} failed\n${result.output}`);
      console.error(`  fail: ${command.label}`);
    } else {
      console.log(`  ok: ${command.label}`);
    }
  }
}

if (failures.length > 0) {
  console.error('\nDesign-test harness failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('\nDesign-test harness OK: DT-1..DT-6 static checks passed.');
