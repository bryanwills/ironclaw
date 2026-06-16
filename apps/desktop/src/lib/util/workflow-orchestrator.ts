import type { ConnectorPackId } from '$lib/data/connector-packs';
import type { Mission } from '$lib/data/missions';
import type { RunbookDomain } from '$lib/data/runbooks';
import type { WorkItemApprovalBoundary } from '$lib/data/work-item';
import { planWorkAsk, type WorkRouteClassification, type WorkRouteResult } from './work-router';

type WorkflowSurface =
  | 'chat'
  | 'first-run-mission'
  | 'generated-mission'
  | 'command'
  | 'automation';

export type WorkflowDecision = {
  surface: WorkflowSurface;
  requiresWorkItem: boolean;
  mustNotExecute: boolean;
  reason: string;
  evidence: string[];
};

export type WorkflowOrchestrationResult =
  | {
      status: 'chat_allowed';
      decision: WorkflowDecision;
    }
  | {
      status: 'routed';
      route: Extract<WorkRouteResult, { status: 'routed' }>;
      decision: WorkflowDecision;
    }
  | {
      status: 'needs_clarification';
      route: Extract<WorkRouteResult, { status: 'needs_clarification' }>;
      decision: WorkflowDecision;
    };

type AskInput = {
  ask: string;
  title?: string;
  surface?: WorkflowSurface;
  classification?: WorkRouteClassification | null;
  source?: string;
  connectorPacks?: ConnectorPackId[];
  hasAttachments?: boolean;
};

type LocalSignal = {
  domain: RunbookDomain | 'multi' | 'unknown';
  domains?: RunbookDomain[];
  confidence: number;
  evidence: string[];
};

const DOMAIN_SIGNALS: Record<RunbookDomain, string[]> = {
  coding: [
    'branch',
    'build',
    'ci',
    'code',
    'commit',
    'dependency',
    'deploy',
    'diff',
    'failing test',
    'fix',
    'github',
    'pull request',
    'pr',
    'repo',
    'repository',
    'test suite'
  ],
  legal: [
    'agreement',
    'clause',
    'contract',
    'counterparty',
    'dpa',
    'liability',
    'msa',
    'redline',
    'sow',
    'terms'
  ],
  finance: [
    'allocation',
    'cash',
    'exposure',
    'fund',
    'holdings',
    'liquidity',
    'order',
    'portfolio',
    'position',
    'rebalance',
    'risk limits',
    'trade'
  ],
  research: [
    'brief',
    'cite',
    'compare',
    'competitor',
    'diligence',
    'market map',
    'research',
    'source',
    'sources',
    'verify'
  ],
  operations: [
    'calendar',
    'crm',
    'email',
    'follow-up',
    'gmail',
    'inbox',
    'meeting',
    'notion',
    'queue',
    'reply',
    'schedule',
    'slack',
    'triage'
  ]
};

const RISK_PATTERNS: Array<{
  test: RegExp;
  action: string;
  kind: WorkItemApprovalBoundary['kind'];
  payload: string;
}> = [
  {
    test: /\b(send|reply|email|message|post)\b/i,
    action: 'Send message or reply',
    kind: 'send',
    payload: 'Any outbound message requested by this ask.'
  },
  {
    test: /\b(push|open (a )?pr|open (a )?pull request|publish branch)\b/i,
    action: 'Publish code or open PR',
    kind: 'push',
    payload: 'Any branch push or pull request opened from this work.'
  },
  {
    test: /\b(trade|buy|sell|execute order|place order|move funds|wire)\b/i,
    action: 'Execute financial action',
    kind: 'trade',
    payload: 'Any order, fund movement, or trade requested by this work.'
  },
  {
    test: /\b(?:update|write|create|edit)\s+(?:(?:in|to|on)\s+)?(?:notion|gmail|google\s+calendar|gcal|calendar|slack|crm|hubspot|salesforce|linear|jira|github|drive|sheets?|docs?|database|ticket|issue|task|page|workspace|external\s+system|file|disk)\b|\b(?:label|archive)\s+(?:email|message|thread|gmail|inbox)\b|\b(?:schedule|reschedule)\s+(?:meeting|call|event|calendar)\b/i,
    action: 'Write to an external system',
    kind: 'write',
    payload: 'Any external write or state change requested by this work.'
  },
  {
    test: /\b(delete|remove|destroy)\b/i,
    action: 'Delete external state',
    kind: 'delete',
    payload: 'Any destructive action requested by this work.'
  },
  {
    test: /\b(export|share|download)\b/i,
    action: 'Export or share artifact',
    kind: 'export',
    payload: 'Any exported or shared artifact requested by this work.'
  }
];

function compactText(...parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n')
    .toLowerCase();
}

function riskPatternMatches(pattern: RegExp, text: string): boolean {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  for (const match of text.matchAll(matcher)) {
    if (!isNegatedRiskMatch(text, match.index ?? 0)) return true;
  }
  return false;
}

function isNegatedRiskMatch(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 64), index);
  return /\b(?:do\s+not|don't|dont|never|not|no|without)\s+(?:[a-z0-9_-]+\s+){0,5}$/i.test(before);
}

function hasPhrase(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

function localSignalForAsk(input: AskInput): LocalSignal | null {
  const text = compactText(input.title, input.ask, input.source, input.connectorPacks?.join(' '));
  if (!text) return null;

  const scored = Object.entries(DOMAIN_SIGNALS)
    .map(([domain, signals]) => ({
      domain: domain as RunbookDomain,
      hits: signals.filter((signal) => hasPhrase(text, signal))
    }))
    .filter((entry) => entry.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length);

  const risky = RISK_PATTERNS.some((risk) => riskPatternMatches(risk.test, text));
  const durableOutput =
    /\b(artifact|brief|build|compose|create|draft|generate|make|monitor|plan|prepare|produce|redline|review|summary|triage|watch|write)\b/i.test(
      text
    );

  if (scored.length === 0) {
    if (!risky && !durableOutput) return null;
    return {
      domain: 'unknown',
      confidence: 0.3,
      evidence: [
        risky ? 'The ask implies an external or mutating action.' : 'The ask requests durable work.'
      ]
    };
  }

  const top = scored[0];
  const selected = scored.filter((entry) => entry.hits.length >= Math.max(1, top.hits.length - 1));
  const domains = selected.map((entry) => entry.domain);
  const confidence =
    input.surface === 'first-run-mission'
      ? 0.84
      : top.hits.length >= 2 || risky || durableOutput
        ? 0.72
        : 0.5;

  return {
    domain: domains.length > 1 ? 'multi' : domains[0],
    ...(domains.length > 1 ? { domains } : {}),
    confidence,
    evidence: selected.flatMap((entry) =>
      entry.hits.slice(0, 3).map((hit) => `${entry.domain}:${hit}`)
    )
  };
}

function risksForAsk(input: AskInput): WorkRouteClassification['riskyActions'] {
  const text = compactText(input.title, input.ask, input.source);
  return RISK_PATTERNS.filter((risk) => riskPatternMatches(risk.test, text)).map((risk) => ({
    action: risk.action,
    kind: risk.kind,
    payload: risk.payload,
    reason: 'Detected from an explicit requested action.'
  }));
}

function artifactsForAsk(input: AskInput): WorkRouteClassification['expectedArtifacts'] {
  const text = compactText(input.title, input.ask, input.source);
  const out: NonNullable<WorkRouteClassification['expectedArtifacts']> = [];
  if (/\b(pr summary|pull request summary)\b/i.test(text)) {
    out.push({ type: 'PR summary', title: 'PR summary', provenance: ['ask'] });
  }
  if (/\b(redline|contract|agreement|msa|dpa|sow)\b/i.test(text)) {
    out.push({ type: 'proposed redline', title: 'Proposed redline', provenance: ['ask'] });
  }
  if (/\b(brief|research|diligence|market map)\b/i.test(text)) {
    out.push({ type: 'brief', title: 'Cited brief', provenance: ['ask'] });
  }
  if (/\b(draft|reply|email|message)\b/i.test(text)) {
    out.push({ type: 'draft', title: 'Draft response', provenance: ['ask'] });
  }
  if (/\b(triage|queue|inbox)\b/i.test(text)) {
    out.push({ type: 'triaged action list', title: 'Triaged action list', provenance: ['ask'] });
  }
  return out;
}

function cadenceForAsk(text: string): string {
  if (/\b(weekly|week)\b/i.test(text)) return 'weekly';
  if (/\b(daily|day|tomorrow)\b/i.test(text)) return 'daily';
  if (/\b(every\s+\d+\s+minutes?|minute)\b/i.test(text)) {
    const match = /\bevery\s+(\d+)\s+minutes?\b/i.exec(text);
    return match ? `every ${match[1]} minutes` : 'every 15 minutes';
  }
  return 'hourly';
}

function initialNextCheck(cadence: string): string {
  const now = Date.now();
  const minutes = /^every\s+(\d+)\s+minutes?$/i.exec(cadence);
  if (minutes) {
    return new Date(now + Number(minutes[1]) * 60_000).toISOString();
  }
  if (cadence === 'daily') return new Date(now + 24 * 60 * 60_000).toISOString();
  if (cadence === 'weekly') return new Date(now + 7 * 24 * 60 * 60_000).toISOString();
  return new Date(now + 60 * 60_000).toISOString();
}

function watchesForAsk(input: AskInput): WorkRouteClassification['watches'] {
  const text = compactText(input.title, input.ask, input.source);
  if (!/\b(watch|monitor|keep an eye|notify|alert)\b/i.test(text)) return [];
  const cadence = cadenceForAsk(text);
  return [
    {
      trigger: 'Requested condition changes',
      cadence,
      source: input.connectorPacks?.join(', ') || 'available sources',
      next_check: initialNextCheck(cadence),
      escalation: 'Surface the change before taking any external action.'
    }
  ];
}

function contextForAsk(input: AskInput, signal: LocalSignal): WorkRouteClassification['context'] {
  const context: NonNullable<WorkRouteClassification['context']> = [];
  const domains = signal.domain === 'multi' ? (signal.domains ?? []) : [signal.domain];
  if (domains.includes('coding')) {
    context.push({
      label: 'Task or issue to address',
      state: 'available',
      provenance: 'user:ask',
      detail: 'The user supplied the task in the ask.'
    });
  }
  if (domains.includes('research')) {
    context.push({
      label: 'Topic or question',
      state: 'available',
      provenance: 'user:ask',
      detail: 'The user supplied the research question in the ask.'
    });
  }
  if (domains.includes('operations') && input.connectorPacks?.length) {
    context.push({
      label: 'Inbox, queue, or backlog to triage',
      state: 'available',
      provenance: `connector:${input.connectorPacks.join(',')}`,
      detail: 'The mission is gated on a connected workspace pack.'
    });
  }
  if (domains.includes('legal') && input.hasAttachments) {
    context.push({
      label: 'Document(s) to review',
      state: 'available',
      provenance: 'attachment',
      detail: 'The user attached source material.'
    });
  }
  return context;
}

function classificationFromLocalSignal(
  input: AskInput,
  signal: LocalSignal
): WorkRouteClassification {
  return {
    domain: signal.domain,
    confidence: signal.confidence,
    title: input.title,
    domains: signal.domains,
    rationale: signal.evidence.join(', '),
    context: contextForAsk(input, signal),
    riskyActions: risksForAsk(input),
    expectedArtifacts: artifactsForAsk(input),
    watches: watchesForAsk(input)
  };
}

function mergeUniqueBy<T>(base: T[] | undefined, additions: T[], keyOf: (item: T) => string): T[] {
  const out = [...(base ?? [])];
  const seen = new Set(out.map(keyOf));
  for (const item of additions) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function hardenClassificationWithLocalSignals(
  input: AskInput,
  classification: WorkRouteClassification,
  signal: LocalSignal | null
): WorkRouteClassification {
  const riskyActions = mergeUniqueBy(
    classification.riskyActions,
    risksForAsk(input) ?? [],
    (risk) => `${risk.kind ?? 'other'}:${risk.action.toLowerCase()}`
  );
  const expectedArtifacts = mergeUniqueBy(
    classification.expectedArtifacts,
    artifactsForAsk(input) ?? [],
    (artifact) => `${artifact.type.toLowerCase()}:${artifact.title.toLowerCase()}`
  );
  const watches = mergeUniqueBy(
    classification.watches,
    watchesForAsk(input) ?? [],
    (watch) => `${watch.trigger.toLowerCase()}:${watch.source.toLowerCase()}`
  );
  return {
    ...classification,
    riskyActions,
    expectedArtifacts,
    watches,
    rationale: [classification.rationale, signal?.evidence.join(', ')].filter(Boolean).join(' | ')
  };
}

function decisionForRoute(
  surface: WorkflowSurface,
  route: WorkRouteResult,
  evidence: string[]
): WorkflowDecision {
  const mustNotExecute =
    route.status === 'needs_clarification' ||
    route.workItem.approvalBoundaries.some((gate) => gate.status === 'pending');
  return {
    surface,
    requiresWorkItem: true,
    mustNotExecute,
    reason:
      route.status === 'routed'
        ? 'Serious work is routed through a durable Work Item.'
        : 'The ask looks like serious work, but the router needs more context before acting.',
    evidence
  };
}

function isAttachmentGenerationAsk(
  input: AskInput,
  classification: WorkRouteClassification
): boolean {
  if ((input.surface ?? 'chat') !== 'chat') return false;
  if (!input.hasAttachments) return false;
  if ((classification.riskyActions ?? []).length > 0) return false;
  if ((classification.watches ?? []).length > 0) return false;

  return /\b(analy[sz]e|brief|compare|compose|convert|create|draft|extract|generate|make|prepare|review|summari[sz]e|write)\b/i.test(
    input.ask
  );
}

export function orchestrateChiefOfStaffAsk(input: AskInput): WorkflowOrchestrationResult {
  const surface = input.surface ?? 'chat';
  const signal = localSignalForAsk(input);
  const classification = input.classification
    ? hardenClassificationWithLocalSignals(input, input.classification, signal)
    : signal
      ? classificationFromLocalSignal(input, signal)
      : null;

  if (!classification) {
    return {
      status: 'chat_allowed',
      decision: {
        surface,
        requiresWorkItem: false,
        mustNotExecute: false,
        reason: 'No explicit durable-work or external-action signal was detected.',
        evidence: []
      }
    };
  }

  const route = planWorkAsk({ ask: input.ask, classification });
  if (route.status === 'needs_clarification' && isAttachmentGenerationAsk(input, classification)) {
    return {
      status: 'chat_allowed',
      decision: {
        surface,
        requiresWorkItem: false,
        mustNotExecute: false,
        reason: 'Attached-source generation can be answered directly in chat.',
        evidence: signal?.evidence ?? [classification.rationale ?? 'attachment generation']
      }
    };
  }
  const decision = decisionForRoute(
    surface,
    route,
    signal?.evidence ?? [classification.rationale ?? 'classification']
  );
  if (route.status === 'routed') {
    return { status: 'routed', route, decision };
  }
  return { status: 'needs_clarification', route, decision };
}

const MISSION_CLASSIFICATIONS: Record<
  string,
  Pick<WorkRouteClassification, 'domain' | 'domains' | 'expectedArtifacts' | 'riskyActions'>
> = {
  'morning-brief': {
    domain: 'operations',
    expectedArtifacts: [
      { type: 'brief', title: 'Morning brief', provenance: ['mission:morning-brief'] }
    ]
  },
  'inbox-triage': {
    domain: 'operations',
    expectedArtifacts: [
      {
        type: 'triaged action list',
        title: 'Inbox triage action list',
        provenance: ['mission:inbox-triage']
      }
    ]
  },
  'meeting-prep': {
    domain: 'operations',
    expectedArtifacts: [
      { type: 'brief', title: 'Meeting prep brief', provenance: ['mission:meeting-prep'] }
    ]
  },
  'follow-up-catcher': {
    domain: 'operations',
    expectedArtifacts: [
      {
        type: 'triaged action list',
        title: 'Follow-up action list',
        provenance: ['mission:follow-up-catcher']
      }
    ],
    riskyActions: [
      {
        action: 'Send follow-up',
        kind: 'send',
        payload: 'Any reminder or follow-up message drafted from the mission.',
        reason: 'Follow-up messages leave the app.'
      }
    ]
  },
  'draft-replies': {
    domain: 'operations',
    expectedArtifacts: [
      { type: 'draft replies', title: 'Draft replies', provenance: ['mission:draft-replies'] }
    ],
    riskyActions: [
      {
        action: 'Send draft reply',
        kind: 'send',
        payload: 'Any email reply drafted by the mission.',
        reason: 'Replies require explicit approval before sending.'
      }
    ]
  },
  'slack-catchup': {
    domain: 'operations',
    expectedArtifacts: [
      { type: 'draft replies', title: 'Slack reply drafts', provenance: ['mission:slack-catchup'] }
    ],
    riskyActions: [
      {
        action: 'Send Slack reply',
        kind: 'send',
        payload: 'Any Slack reply, reaction, or channel update.',
        reason: 'Slack writes require explicit approval.'
      }
    ]
  },
  'update-notion-crm': {
    domain: 'operations',
    expectedArtifacts: [
      {
        type: 'change list',
        title: 'Proposed Notion CRM updates',
        provenance: ['mission:update-notion-crm']
      }
    ],
    riskyActions: [
      {
        action: 'Write to Notion',
        kind: 'write',
        payload: 'Any Notion page, database property, or note update.',
        reason: 'Workspace writes require explicit approval.'
      }
    ]
  },
  'contract-review': {
    domain: 'legal',
    expectedArtifacts: [
      {
        type: 'clause-level red-flag review',
        title: 'Contract risk review',
        provenance: ['mission:contract-review']
      },
      {
        type: 'proposed redline',
        title: 'Proposed redline',
        provenance: ['mission:contract-review']
      }
    ]
  },
  'draft-from-notes': {
    domain: 'multi',
    domains: ['operations', 'legal'],
    expectedArtifacts: [
      { type: 'draft', title: 'Draft from notes', provenance: ['mission:draft-from-notes'] }
    ],
    riskyActions: [
      {
        action: 'Send or write draft',
        kind: 'send',
        payload: 'Any outbound message or saved document created from the notes.',
        reason: 'Drafts must be reviewed before sending or writing.'
      }
    ]
  }
};

export function planFirstRunMissionWorkflow(mission: Mission): WorkflowOrchestrationResult {
  const mapped = MISSION_CLASSIFICATIONS[mission.id];
  if (!mapped) {
    return orchestrateChiefOfStaffAsk({
      ask: mission.prompt,
      title: mission.title,
      surface: 'first-run-mission',
      source: `mission:${mission.id}`,
      connectorPacks: mission.required_connectors ?? []
    });
  }

  const signal: WorkRouteClassification = {
    domain: mapped.domain,
    confidence: 0.86,
    title: mission.title,
    rationale: `mission:${mission.id}`,
    domains: mapped.domains,
    context: contextForAsk(
      {
        ask: mission.prompt,
        title: mission.title,
        surface: 'first-run-mission',
        source: `mission:${mission.id}`,
        connectorPacks: mission.required_connectors ?? []
      },
      {
        domain: mapped.domain,
        domains: mapped.domains,
        confidence: 0.86,
        evidence: [`mission:${mission.id}`]
      }
    ),
    riskyActions: mapped.riskyActions,
    expectedArtifacts: mapped.expectedArtifacts
  };

  return orchestrateChiefOfStaffAsk({
    ask: mission.prompt,
    title: mission.title,
    surface: 'first-run-mission',
    source: `mission:${mission.id}`,
    connectorPacks: mission.required_connectors ?? [],
    classification: signal
  });
}
