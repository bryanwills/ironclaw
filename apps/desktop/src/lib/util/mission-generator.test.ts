import { describe, it, expect } from 'vitest';
import {
  buildProposalPrompt,
  buildWorkProductPrompt,
  parseProposedMissions,
  type ContextItem
} from './mission-generator';

const ITEMS: ContextItem[] = [
  { kind: 'email', label: 'Inbox — Northwind MSA', body: 'Please countersign the MSA…' },
  { kind: 'note', label: 'Call — Beacon Robotics', body: 'Pilot, $25k floated…' }
];

describe('buildProposalPrompt', () => {
  it('embeds every item label + body and asks for strict JSON', () => {
    const p = buildProposalPrompt(ITEMS);
    expect(p).toContain('Inbox — Northwind MSA');
    expect(p).toContain('Call — Beacon Robotics');
    expect(p).toContain('Please countersign the MSA');
    expect(p).toContain('STRICT JSON');
    expect(p).toMatch(/not.*advice/i);
  });

  it('throws when there is no context', () => {
    expect(() => buildProposalPrompt([])).toThrow();
  });
});

describe('buildWorkProductPrompt', () => {
  it('asks for a user-visible markdown deliverable, not strict JSON', () => {
    const mission = parseProposedMissions(
      JSON.stringify([
        {
          title: 'Review Northwind MSA',
          item: 'Inbox — Northwind MSA',
          why: 'It has liability asymmetry.',
          mode: 'approval',
          run_instruction: 'Prepare a red-flag memo.',
          deliverable: 'Risk memo',
          expected_artifacts: [{ type: 'risk-memo', title: 'Risk memo' }]
        }
      ])
    )[0];

    const prompt = buildWorkProductPrompt(mission, ITEMS);

    expect(prompt).toContain('Create the deliverable');
    expect(prompt).toContain('Do not return JSON');
    expect(prompt).toContain('# Risk memo');
    expect(prompt).toContain('Inbox — Northwind MSA');
    expect(prompt).not.toContain('Return STRICT JSON only');
  });
});

describe('parseProposedMissions', () => {
  const good = JSON.stringify([
    {
      title: 'Review the Northwind MSA before signing',
      item: 'Inbox — Northwind MSA',
      why: 'It auto-renews and caps their liability, not yours.',
      mode: 'approval',
      run_instruction: 'Review the MSA and flag risky clauses with redlines.',
      deliverable: 'A clause-by-clause review memo.'
    },
    {
      title: 'Draft the Beacon pilot follow-up',
      item: 'Call — Beacon Robotics',
      why: 'You promised a number + term sheet by end of week.',
      mode: 'dry-run',
      run_instruction: 'Draft a follow-up email and a 1-page term sheet.',
      deliverable: 'A ready-to-send draft.'
    }
  ]);

  it('parses a clean JSON array', () => {
    const m = parseProposedMissions(good);
    expect(m).toHaveLength(2);
    expect(m[0].title).toContain('Northwind');
    expect(m[0].mode).toBe('approval');
    expect(m[1].mode).toBe('dry-run');
    expect(m[0].id).toBeTruthy();
  });

  it('tolerates ```json fences and leading prose', () => {
    const wrapped = 'Sure, here are the actions:\n```json\n' + good + '\n```';
    expect(parseProposedMissions(wrapped)).toHaveLength(2);
  });

  it('drops elements missing a title or run_instruction', () => {
    const partial = JSON.stringify([
      { title: 'No instruction' },
      { run_instruction: 'No title' },
      { title: 'Valid', run_instruction: 'Do it' }
    ]);
    const m = parseProposedMissions(partial);
    expect(m).toHaveLength(1);
    expect(m[0].title).toBe('Valid');
  });

  it('defaults unknown/missing mode to approval (safe)', () => {
    const m = parseProposedMissions(
      JSON.stringify([{ title: 'X', run_instruction: 'Y', mode: 'whatever' }])
    );
    expect(m[0].mode).toBe('approval');
  });

  it('accepts known domains, preserves valid multi-domain runbooks, and defaults invalid domains to unknown', () => {
    const m = parseProposedMissions(
      JSON.stringify([
        { title: 'Coding', run_instruction: 'Do coding work', domain: 'coding' },
        { title: 'Legal', run_instruction: 'Do legal work', domain: 'legal' },
        { title: 'Finance', run_instruction: 'Do finance work', domain: 'finance' },
        { title: 'Research', run_instruction: 'Do research work', domain: 'research' },
        { title: 'Operations', run_instruction: 'Do ops work', domain: 'operations' },
        {
          title: 'Multi',
          run_instruction: 'Coordinate workstreams',
          domain: 'multi',
          domains: ['coding', 'legal', 'bogus', '', 'finance', 12]
        },
        { title: 'Invalid', run_instruction: 'Do unknown work', domain: 'sales' }
      ])
    );

    expect(m.map((mission) => mission.domain)).toEqual([
      'coding',
      'legal',
      'finance',
      'research',
      'operations',
      'multi',
      'unknown'
    ]);
    expect(m[5].domains).toEqual(['coding', 'legal', 'finance']);
    expect(m[6].domains).toEqual([]);
  });

  it('validates risky action payloads and falls back unknown risk kinds to other', () => {
    const m = parseProposedMissions(
      JSON.stringify([
        {
          title: 'Prepare outbound update',
          run_instruction: 'Draft the client update and wait for approval.',
          risky_actions: [
            {
              action: 'Send client update',
              kind: 'send',
              payload: 'Email draft to acme@example.com',
              reason: 'External communication'
            },
            {
              action: 'Archive workspace',
              kind: 'nuke',
              payload: 'Archive the stale workspace'
            },
            { action: 'Missing payload', kind: 'delete' },
            { payload: 'Missing action', kind: 'write' },
            null,
            'send something'
          ]
        }
      ])
    );

    expect(m[0].risky_actions).toEqual([
      {
        action: 'Send client update',
        kind: 'send',
        payload: 'Email draft to acme@example.com',
        reason: 'External communication'
      },
      {
        action: 'Archive workspace',
        kind: 'other',
        payload: 'Archive the stale workspace'
      }
    ]);
  });

  it('normalizes expected artifact provenance and drops malformed artifacts', () => {
    const m = parseProposedMissions(
      JSON.stringify([
        {
          title: 'Create diligence packet',
          run_instruction: 'Compile the diligence packet.',
          expected_artifacts: [
            {
              type: ' memo ',
              title: ' Risk memo ',
              provenance: [' Inbox — MSA ', 42, '', 'Call notes']
            },
            { type: 'spreadsheet', provenance: ['Finance export'] },
            { title: 'Missing type', provenance: ['Workspace'] },
            'artifact'
          ]
        }
      ])
    );

    expect(m[0].expected_artifacts).toEqual([
      {
        type: 'memo',
        title: 'Risk memo',
        provenance: ['Inbox — MSA', 'Call notes']
      }
    ]);
  });

  it('validates watch fields and coerces blank next_check to null', () => {
    const m = parseProposedMissions(
      JSON.stringify([
        {
          title: 'Monitor renewal',
          run_instruction: 'Watch renewal signals.',
          watches: [
            {
              trigger: 'Contract renewal changes',
              cadence: 'daily',
              source: 'Notion',
              next_check: '2026-06-02T09:00:00Z',
              escalation: 'Tell the user before auto-renewal risk.'
            },
            {
              trigger: 'CFO reply',
              cadence: 'hourly',
              source: 'Gmail',
              next_check: '',
              escalation: 'Surface the reply with suggested response.'
            },
            {
              trigger: 'Missing escalation',
              cadence: 'daily',
              source: 'Slack'
            },
            { cadence: 'daily', source: 'Calendar', escalation: 'Missing trigger' },
            null
          ]
        }
      ])
    );

    expect(m[0].watches).toEqual([
      {
        trigger: 'Contract renewal changes',
        cadence: 'daily',
        source: 'Notion',
        next_check: '2026-06-02T09:00:00Z',
        escalation: 'Tell the user before auto-renewal risk.'
      },
      {
        trigger: 'CFO reply',
        cadence: 'hourly',
        source: 'Gmail',
        next_check: null,
        escalation: 'Surface the reply with suggested response.'
      }
    ]);
  });

  it('drops malformed context entries and preserves valid dossier provenance', () => {
    const m = parseProposedMissions(
      JSON.stringify([
        {
          title: 'Brief the meeting',
          run_instruction: 'Prepare the meeting brief.',
          context: [
            {
              label: 'Board deck',
              state: 'used',
              provenance: 'Uploaded PDF',
              detail: 'Q3 metrics'
            },
            {
              label: 'CRM export',
              state: 'available',
              provenance: 'Workspace connector'
            },
            {
              label: 'Missing contract',
              state: 'missing',
              provenance: 'Notion'
            },
            { label: 'No provenance', state: 'used' },
            { label: 'Bad state', state: 'invented', provenance: 'Model guess' },
            { state: 'used', provenance: 'No label' },
            'context'
          ]
        },
        {
          title: 'Non-array context',
          run_instruction: 'Do not crash.',
          context: { label: 'Wrong shape', state: 'used', provenance: 'Object' }
        }
      ])
    );

    expect(m[0].context).toEqual([
      {
        label: 'Board deck',
        state: 'used',
        provenance: 'Uploaded PDF',
        detail: 'Q3 metrics'
      },
      {
        label: 'CRM export',
        state: 'available',
        provenance: 'Workspace connector'
      },
      {
        label: 'Missing contract',
        state: 'missing',
        provenance: 'Notion'
      }
    ]);
    expect(m[1].context).toEqual([]);
  });

  it('gives each mission a unique id', () => {
    const dup = JSON.stringify([
      { title: 'Same', run_instruction: 'a' },
      { title: 'Same', run_instruction: 'b' }
    ]);
    const m = parseProposedMissions(dup);
    expect(m).toHaveLength(2);
    expect(m[0].id).not.toBe(m[1].id);
  });

  it('returns [] on garbage, non-array, or empty input', () => {
    expect(parseProposedMissions('')).toEqual([]);
    expect(parseProposedMissions('not json at all')).toEqual([]);
    expect(parseProposedMissions('{"title":"obj not array"}')).toEqual([]);
    expect(parseProposedMissions('[oops')).toEqual([]);
  });
});
