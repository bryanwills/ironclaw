/**
 * Domain runbooks — structured operating modes a later UI/work-item selects to
 * turn a vague prompt ("do some legal work") into a concrete plan: required
 * inputs, ordered steps with approval gates, expected artifacts, and the
 * verification a run must pass. Pure data; no Svelte, no stores, no API calls.
 */

export type RunbookDomain = 'coding' | 'legal' | 'finance' | 'research' | 'operations';

export type ApprovalGate = 'read-only' | 'dry-run' | 'approval-required';

export interface RunbookStep {
  title: string;
  detail: string;
  gate: ApprovalGate;
}

export interface Runbook {
  id: RunbookDomain;
  display_name: string;
  summary: string;
  required_inputs: string[];
  optional_context: string[];
  suggested_tools: string[];
  steps: RunbookStep[];
  expected_artifacts: string[];
  verification: string[];
  constraints: string[];
}

export const RUNBOOKS: Runbook[] = [
  {
    id: 'coding',
    display_name: 'Coding',
    summary: 'Investigate, plan, edit, test, and open a PR for a code change.',
    required_inputs: ['Repository or working directory', 'Task or issue to address'],
    optional_context: ['Target branch', 'Linked issue or design doc', 'Acceptance criteria'],
    suggested_tools: ['filesystem', 'shell', 'github', 'web-search'],
    steps: [
      {
        title: 'Investigate',
        detail: 'Read the files, tests, and history to scope the change and its blast radius.',
        gate: 'read-only'
      },
      {
        title: 'Plan',
        detail: 'Write the intended diff as a short plan: files to touch, approach, and risks.',
        gate: 'read-only'
      },
      {
        title: 'Edit',
        detail: 'Apply the change to the working tree; keep it scoped to the plan.',
        gate: 'dry-run'
      },
      {
        title: 'Test',
        detail: 'Run the unit and type checks; iterate until the suite passes locally.',
        gate: 'dry-run'
      },
      {
        title: 'Open PR',
        detail: 'Push the branch and open a pull request with a summary of the change.',
        gate: 'approval-required'
      }
    ],
    expected_artifacts: ['patch', 'PR summary'],
    verification: ['Test suite and type checks pass', 'Diff reviewed against the plan'],
    constraints: [
      'Stay inside the files the task names; flag scope creep instead of expanding it.',
      'Requires approval before any push or PR; nothing leaves the working tree without it.'
    ]
  },
  {
    id: 'legal',
    display_name: 'Legal',
    summary: 'Review or mark up a document: surface red flags, obligations, and a redline.',
    required_inputs: ['Document(s) to review'],
    optional_context: ['Counterparty', 'Governing law', 'Prior version or template', 'Deal brief'],
    suggested_tools: ['filesystem', 'knowledge-base', 'web-search'],
    steps: [
      {
        title: 'Intake',
        detail: 'Read the document(s) and identify parties, term, and document type.',
        gate: 'read-only'
      },
      {
        title: 'Clause review',
        detail: 'Scan clause by clause for red flags, missing protections, and ambiguous terms.',
        gate: 'read-only'
      },
      {
        title: 'Draft markup',
        detail: 'Produce an obligations table and a proposed redline as drafts for review.',
        gate: 'dry-run'
      },
      {
        title: 'Send or file',
        detail: 'Send the markup to the counterparty or write the executed file once approved.',
        gate: 'approval-required'
      }
    ],
    expected_artifacts: ['clause-level red-flag review', 'obligations table', 'proposed redline'],
    verification: [
      'Every red flag cites the clause it came from',
      'Obligations traced to source text'
    ],
    constraints: [
      'Not legal advice; output is a working draft for a qualified reviewer.',
      'Requires approval before any send, file write, trade, or money movement.'
    ]
  },
  {
    id: 'finance',
    display_name: 'Finance',
    summary: 'Read positions, compute exposure, and propose an approval-gated rebalance.',
    required_inputs: ['Holdings or positions'],
    optional_context: ['Target allocation', 'Risk limits', 'Cash available', 'Time horizon'],
    suggested_tools: ['portfolio', 'market-data', 'news'],
    steps: [
      {
        title: 'Pull positions',
        detail: 'Read current holdings and the latest quotes for each instrument.',
        gate: 'read-only'
      },
      {
        title: 'Compute exposure',
        detail: 'Roll up exposure by asset, sector, and currency against the stated limits.',
        gate: 'read-only'
      },
      {
        title: 'Draft rebalance',
        detail: 'Propose the trades to reach the target allocation as a draft recommendation.',
        gate: 'dry-run'
      },
      {
        title: 'Execute',
        detail: 'Place trades or move funds only after the recommendation is approved.',
        gate: 'approval-required'
      }
    ],
    expected_artifacts: ['exposure summary', 'rebalance recommendation (approval-gated)'],
    verification: [
      'Exposure totals reconcile to the input positions',
      'Each proposed trade names its rationale'
    ],
    constraints: [
      'Not financial advice; output is analysis for a human decision-maker.',
      'Requires approval before any send, file write, trade, or money movement.'
    ]
  },
  {
    id: 'research',
    display_name: 'Research',
    summary: 'Scope a question, search across sources, verify claims, and write a cited brief.',
    required_inputs: ['Topic or question'],
    optional_context: ['Scope or boundaries', 'Preferred sources', 'Deadline', 'Audience'],
    suggested_tools: ['web-search', 'web-fetch', 'knowledge-base'],
    steps: [
      {
        title: 'Scope',
        detail: 'Restate the question and define what is in and out of scope.',
        gate: 'read-only'
      },
      {
        title: 'Search',
        detail: 'Fan out across sources and collect candidate evidence with links.',
        gate: 'read-only'
      },
      {
        title: 'Verify',
        detail: 'Cross-check claims against primary sources and discard the unsupported ones.',
        gate: 'read-only'
      },
      {
        title: 'Synthesize',
        detail: 'Write a cited brief with findings, confidence, and open questions.',
        gate: 'read-only'
      }
    ],
    expected_artifacts: ['cited brief'],
    verification: ['Every claim links to a source', 'Open questions and confidence stated'],
    constraints: ['Cite sources for every claim; mark inference as inference, not fact.']
  },
  {
    id: 'operations',
    display_name: 'Operations',
    summary: 'Triage an inbox or queue, cluster by intent, and draft replies for review.',
    required_inputs: ['Inbox, queue, or backlog to triage'],
    optional_context: ['Priority rules', 'Tone or templates', 'Escalation contacts'],
    suggested_tools: ['gmail', 'slack', 'tasks', 'calendar'],
    steps: [
      {
        title: 'Ingest',
        detail: 'Read the items in the queue and capture sender, intent, and urgency.',
        gate: 'read-only'
      },
      {
        title: 'Triage',
        detail: 'Cluster by intent, flag anything urgent, and order by priority.',
        gate: 'read-only'
      },
      {
        title: 'Draft replies',
        detail: 'Write draft responses for the items that need one, held for review.',
        gate: 'dry-run'
      },
      {
        title: 'Send',
        detail: 'Send the approved replies and update task or calendar state.',
        gate: 'approval-required'
      }
    ],
    expected_artifacts: ['triaged action list', 'draft replies'],
    verification: ['Urgent items surfaced at the top', 'Each draft maps to a queue item'],
    constraints: ['Requires approval before any reply is sent or state is changed.']
  }
];

export function runbookByDomain(id: string): Runbook | undefined {
  return RUNBOOKS.find((r) => r.id === id);
}
