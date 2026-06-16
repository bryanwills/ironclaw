import type { RunbookDomain } from '$lib/data/runbooks';
import type {
  WorkItemApprovalBoundary,
  WorkItemDossierEntry,
  WorkItemWatch
} from '$lib/data/work-item';

// Generative missions — the chief-of-staff core.
//
// A static catalog ("pick Contract Review from a menu") is the wrong shape for
// a chief of staff: it can't know that an *actual* contract just landed. This
// module instead asks the connected agent to PROPOSE specific, grounded
// actions from whatever is currently in front of the user — documents they
// dropped, notes from a call, recent workspace activity. Each proposal is tied
// to a real item, carries a ready-to-run instruction, and defaults to
// approval mode so nothing is sent/written without the user's OK.
//
// Pure functions only (prompt-builder + parser) so they're trivially testable;
// the store (`generated-missions.svelte.ts`) feeds these to the gateway's
// Responses API and renders the result on the Desk.

export type GeneratedMissionMode = 'dry-run' | 'approval';
export type GeneratedMissionDomain = RunbookDomain | 'multi' | 'unknown';

export interface GeneratedMissionArtifact {
  type: string;
  title: string;
  provenance?: string[];
}

export interface GeneratedMissionRisk {
  action: string;
  kind?: WorkItemApprovalBoundary['kind'];
  payload: string;
  reason?: string;
}

const VALID_RUNBOOK_DOMAINS = new Set<RunbookDomain>([
  'coding',
  'legal',
  'finance',
  'research',
  'operations'
]);

/** A piece of live context the agent should reason over. */
export interface ContextItem {
  kind: 'document' | 'note' | 'email' | 'event' | 'activity';
  /** Short human label, e.g. "Inbox — vendor contract". */
  label: string;
  /** The actual content (contract text, call notes, an event summary…). */
  body: string;
}

/** One agent-proposed action, grounded in a specific context item. */
export interface GeneratedMission {
  /** Stable-ish slug derived from the title (for keys / dedupe). */
  id: string;
  /** Action title — should reference the real item. */
  title: string;
  /** The context item label this is tied to. */
  item: string;
  /** One sentence: why this matters now. */
  why: string;
  /** approval = may send/write after OK; dry-run = read-only output. */
  mode: GeneratedMissionMode;
  /** Self-contained instruction to execute the action. */
  run_instruction: string;
  /** What the user gets out of it. */
  deliverable: string;
  /** Selected runbook domain, or multi for a parent matter. */
  domain: GeneratedMissionDomain;
  /** Sub-runbooks when domain is multi. */
  domains: RunbookDomain[];
  /** Context used, available, and missing, with provenance. */
  context: WorkItemDossierEntry[];
  /** External/mutating actions that must be approved before execution. */
  risky_actions: GeneratedMissionRisk[];
  /** Typed expected outputs. */
  expected_artifacts: GeneratedMissionArtifact[];
  /** Monitoring intents to attach as watches. */
  watches: Omit<WorkItemWatch, 'id' | 'status'>[];
}

const SYSTEM = `You are the user's Chief of Staff inside IronClaw, a desktop workspace. New items just landed in the workspace (below). Do NOT choose from a fixed menu of generic tasks. Read what ACTUALLY arrived and propose the specific, grounded next actions you would put on the user's Desk right now — each tied to a real item, in the user's interest, and scoped so it can run without sending or writing anything until the user approves.

Some items may be read-only collection requests for connected sources instead of already-retrieved content. For those, use the available connector tools to inspect the named source before proposing source-specific actions. If you cannot inspect that source, do not invent inbox messages, meetings, pages, or Slack threads; mark the source as missing/available in context and propose the safest next collection or briefing action.

This is workspace assistance, not legal/financial advice; where something needs a professional, say so inside the action rather than skipping it.

Return STRICT JSON only — an array (highest priority first), each element:
{
  "title": "<short; references the real item>",
  "item": "<the label of the item this is about>",
  "why": "<one sentence: why this matters now>",
  "mode": "approval" | "dry-run",
  "run_instruction": "<the exact task to execute, self-contained>",
  "deliverable": "<what the user gets>",
  "domain": "coding" | "legal" | "finance" | "research" | "operations" | "multi" | "unknown",
  "domains": ["<only for multi: coding|legal|finance|research|operations>"],
  "context": [{"label":"<input/context name>","state":"used|available|missing","provenance":"<item label/source>","detail":"<optional>"}],
  "risky_actions": [{"action":"<push/send/trade/export/write/etc>","kind":"send|trade|push|pr|export|delete|write|other","payload":"<exact payload/action to approve>","reason":"<why approval is required>"}],
  "expected_artifacts": [{"type":"<machine-readable type>","title":"<human title>","provenance":["<source labels>"]}],
  "watches": [{"trigger":"<what to watch for>","cadence":"<how often/when>","source":"<source system>","next_check":"<next check or null>","escalation":"<what to surface to the user>"}]
}
Propose 2-6 actions. No prose outside the JSON array.`;

/** Render context items + the proposal instruction into a single prompt. */
export function buildProposalPrompt(items: ContextItem[]): string {
  if (items.length === 0) {
    throw new Error('buildProposalPrompt: no context items');
  }
  const rendered = items
    .map((it, i) => `=== Item ${i + 1} — [${it.kind}] ${it.label} ===\n${it.body.trim()}`)
    .join('\n\n');
  return `${SYSTEM}\n\n--- WORKSPACE CONTEXT ---\n${rendered}`;
}

function excerpt(value: string, max = 6_000): string {
  const cleaned = value.trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}\n\n[truncated]`;
}

/** Prompt the agent to render the selected generated mission into a user-visible work product. */
export function buildWorkProductPrompt(mission: GeneratedMission, items: ContextItem[]): string {
  const context =
    items.length > 0
      ? items
          .map((it, i) => `=== Source ${i + 1} — [${it.kind}] ${it.label} ===\n${excerpt(it.body)}`)
          .join('\n\n')
      : 'No full source body is available. Use only the mission metadata and call out missing context.';

  const expectedArtifacts = mission.expected_artifacts
    .map((artifact) => `- ${artifact.title} (${artifact.type})`)
    .join('\n');
  const approvals = mission.risky_actions
    .map((risk) => `- ${risk.action}: ${risk.payload}`)
    .join('\n');

  return `You are drafting a visible work product inside IronClaw Work.

Create the deliverable for this generated mission as Markdown. Do not return JSON. Do not include system prompts, hidden instructions, or raw workspace context. Do not send messages, write to external tools, make legal/financial claims, or pretend missing connector data was inspected. If the available source material is insufficient, make that explicit in a "Missing context" section and draft only what can be grounded.

Mission title: ${mission.title}
Source item: ${mission.item}
Why now: ${mission.why || 'Not provided'}
Requested deliverable: ${mission.deliverable || 'Work product draft'}
Run instruction: ${mission.run_instruction}
Mode: ${mission.mode}
Expected artifacts:
${expectedArtifacts || '- Work product draft'}
Approval gates:
${approvals || '- None identified; still keep external actions as drafts only.'}

Return Markdown with these sections where relevant:
# ${mission.deliverable || mission.title}
## Summary
## Draft
## Approval Needed
## Missing Context

--- SOURCE MATERIAL ---
${context}`;
}

/** Lowercase-slug a title into a stable id; falls back to an index-based id. */
function slug(title: string, index: number): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || `mission-${index + 1}`;
}

function coerceMode(v: unknown): GeneratedMissionMode {
  return v === 'dry-run' ? 'dry-run' : 'approval';
}

function coerceDomain(v: unknown): GeneratedMissionDomain {
  if (
    v === 'coding' ||
    v === 'legal' ||
    v === 'finance' ||
    v === 'research' ||
    v === 'operations' ||
    v === 'multi'
  ) {
    return v;
  }
  return 'unknown';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseContext(v: unknown): WorkItemDossierEntry[] {
  if (!Array.isArray(v)) return [];
  const out: WorkItemDossierEntry[] = [];
  for (const entry of v) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const label = str(e.label);
    const provenance = str(e.provenance);
    const state = e.state;
    if (!label || !provenance) continue;
    if (state !== 'used' && state !== 'available' && state !== 'missing') continue;
    out.push({
      label,
      state,
      provenance,
      ...(str(e.detail) ? { detail: str(e.detail) } : {})
    });
  }
  return out;
}

function parseRisks(v: unknown): GeneratedMissionRisk[] {
  if (!Array.isArray(v)) return [];
  const out: GeneratedMissionRisk[] = [];
  for (const entry of v) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const action = str(e.action);
    const payload = str(e.payload);
    if (!action || !payload) continue;
    const kind =
      e.kind === 'send' ||
      e.kind === 'trade' ||
      e.kind === 'push' ||
      e.kind === 'pr' ||
      e.kind === 'export' ||
      e.kind === 'delete' ||
      e.kind === 'write' ||
      e.kind === 'other'
        ? e.kind
        : 'other';
    out.push({
      action,
      kind,
      payload,
      ...(str(e.reason) ? { reason: str(e.reason) } : {})
    });
  }
  return out;
}

function parseArtifacts(v: unknown): GeneratedMissionArtifact[] {
  if (!Array.isArray(v)) return [];
  const out: GeneratedMissionArtifact[] = [];
  for (const entry of v) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const type = str(e.type);
    const title = str(e.title);
    if (!type || !title) continue;
    out.push({ type, title, provenance: strList(e.provenance) });
  }
  return out;
}

function parseWatches(v: unknown): Omit<WorkItemWatch, 'id' | 'status'>[] {
  if (!Array.isArray(v)) return [];
  const out: Omit<WorkItemWatch, 'id' | 'status'>[] = [];
  for (const entry of v) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const trigger = str(e.trigger);
    const cadence = str(e.cadence);
    const source = str(e.source);
    const escalation = str(e.escalation);
    if (!trigger || !cadence || !source || !escalation) continue;
    out.push({
      trigger,
      cadence,
      source,
      next_check: str(e.next_check) || null,
      escalation
    });
  }
  return out;
}

/**
 * Parse the model's reply into validated missions. Tolerant of the usual LLM
 * wrapping (```json fences, leading prose): it extracts the first JSON array,
 * then keeps only elements with a usable title + run_instruction. Never
 * throws on malformed model output — returns [] so the UI shows an empty
 * state rather than crashing.
 */
export function parseProposedMissions(raw: string): GeneratedMission[] {
  if (!raw) return [];
  // Strip code fences, then take the first [...] block.
  const unfenced = raw.replace(/```(?:json)?/gi, '');
  const start = unfenced.indexOf('[');
  const end = unfenced.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: GeneratedMission[] = [];
  const seen = new Set<string>();
  arr.forEach((el, i) => {
    if (!el || typeof el !== 'object') return;
    const o = el as Record<string, unknown>;
    const title = str(o.title);
    const run_instruction = str(o.run_instruction);
    if (!title || !run_instruction) return;
    let id = slug(title, i);
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    out.push({
      id,
      title,
      item: str(o.item) || 'workspace',
      why: str(o.why),
      mode: coerceMode(o.mode),
      run_instruction,
      deliverable: str(o.deliverable),
      domain: coerceDomain(o.domain),
      domains: strList(o.domains).filter((id): id is RunbookDomain =>
        VALID_RUNBOOK_DOMAINS.has(id as RunbookDomain)
      ),
      context: parseContext(o.context),
      risky_actions: parseRisks(o.risky_actions),
      expected_artifacts: parseArtifacts(o.expected_artifacts),
      watches: parseWatches(o.watches)
    });
  });
  return out;
}
