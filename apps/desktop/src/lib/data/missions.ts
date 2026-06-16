import type { ConnectorPackId, ConnectorPackStatus } from './connector-packs';

export type MissionMode = 'dry-run' | 'approval';

export interface Mission {
  id: string;
  title: string;
  description: string;
  icon?: string;
  prompt: string;
  required_connectors?: ConnectorPackId[];
  mode: MissionMode;
}

export const FIRST_RUN_MISSIONS: Mission[] = [
  {
    id: 'morning-brief',
    title: 'Morning Brief',
    description: 'Active work, open loops, and your top three priorities.',
    icon: 'sunrise',
    required_connectors: ['google'],
    mode: 'approval',
    prompt: `You are my Chief of Staff preparing my morning brief.

Use the context you can read from this workspace and any connected sources. Summarize what is active, restate open loops and commitments, and propose the top 3 priorities for today with a one-line rationale for each.

Use executive brevity. Separate "Decision needed", "FYI", and "Can handle" where useful. Do not send messages, change calendars, update records, or write anywhere. If you identify work you can take forward, propose the action first and wait for my approval before doing anything outside this chat.`
  },
  {
    id: 'inbox-triage',
    title: 'Inbox Triage',
    description: 'Sort recent email into decisions, FYIs, and work you can handle.',
    icon: 'inbox',
    required_connectors: ['google'],
    mode: 'approval',
    prompt: `You are my Chief of Staff triaging my recent email inbox.

Review recent unread or high-signal email threads. Classify each item into exactly one bucket: "Decision needed", "FYI", or "Can handle". For each, give a one-line reason and a concrete suggested next action. Put the most urgent items first and reference the source clearly.

Use executive brevity. Do not archive, mark read, reply, label, snooze, or change anything. For any "Can handle" item, propose the exact next step and wait for my approval before sending or writing.`
  },
  {
    id: 'meeting-prep',
    title: 'Meeting Prep',
    description: 'Brief for your next important calendar event.',
    icon: 'calendar',
    required_connectors: ['google'],
    mode: 'approval',
    prompt: `You are my Chief of Staff preparing me for my next important meeting.

Look at today's calendar and pick the next meeting where preparation would matter. Build a brief with the meeting objective, attendees, relevant recent context, likely decisions, risks or blockers, and 3 sharp questions I should ask.

Use executive brevity. Do not move meetings, email attendees, create docs, or update calendar fields. If preparation requires an outbound note, agenda, or document, show me the draft first and wait for my approval before any send or write.`
  },
  {
    id: 'follow-up-catcher',
    title: 'Follow-up Catcher',
    description: 'Find commitments and stalled threads that need a nudge.',
    icon: 'repeat',
    required_connectors: ['google'],
    mode: 'approval',
    prompt: `You are my Chief of Staff catching follow-ups I might be carrying.

Review recent email, calendar context, and available open loops. Identify commitments, unanswered asks, waiting-on-someone items, and deadlines that need attention. Group them by urgency and recommend the next action for each.

Use executive brevity. Do not send reminders, create tasks, update records, or change status anywhere. If a follow-up message is useful, draft it in my voice and show it for approval before any send or write.`
  },
  {
    id: 'draft-replies',
    title: 'Draft Replies',
    description: 'Draft ready-to-send replies for the highest-leverage threads.',
    icon: 'mail',
    required_connectors: ['google'],
    mode: 'approval',
    prompt: `You are my Chief of Staff drafting replies for me.

Find up to 3 recent email threads where a concise reply would move work forward. For each thread, explain why it matters in one line, then write a single finished draft in my voice: direct, concrete, and ready to send. If key facts are missing, state assumptions after the draft.

Do not send, schedule, archive, label, or modify any email. Return only proposed drafts and the minimum context needed to approve them. Wait for my explicit approval before any send or write.`
  },
  {
    id: 'slack-catchup',
    title: 'Slack Catch-up',
    description: 'Summarize missed mentions and draft replies for priority threads.',
    icon: 'message-square',
    required_connectors: ['slack'],
    mode: 'approval',
    prompt: `You are my Chief of Staff catching me up on Slack.

Review recent mentions, direct messages, and high-signal channel threads. Summarize what needs my attention, identify decisions or asks, and draft concise replies for the top priority threads.

Use executive brevity. Do not send, react, assign, archive, or update anything in Slack. Return proposed replies only and wait for my explicit approval before any send or write.`
  },
  {
    id: 'update-notion-crm',
    title: 'Update Notion CRM',
    description: 'Turn relationship context into proposed Notion CRM updates.',
    icon: 'database',
    required_connectors: ['notion'],
    mode: 'approval',
    prompt: `You are my Chief of Staff keeping my Notion CRM current.

Review available relationship context and identify contacts, accounts, next steps, status changes, or notes that should be reflected in Notion. Produce a proposed update list with the target page or database, the exact fields or notes to change, and the reason for each update.

Use executive brevity. Do not create pages, edit properties, add notes, or write to Notion. Show the proposed Notion changes first and wait for my explicit approval before any write.`
  },
  {
    id: 'contract-review',
    title: 'Review a Contract',
    description: 'Flag risks, missing protections, and one-sided terms with redlines.',
    icon: 'file-text',
    mode: 'approval',
    prompt: `You are my Chief of Staff giving a contract a first-pass review. Paste the contract text or the key clauses, and tell me which side we are on.

Lead with the highest-risk issues. Name the protections that are missing (carve-outs, term limits, mutual remedies, return-or-destroy, liability caps) and call out anything one-sided. Flag structural mismatches explicitly — for example, an agreement titled "mutual" that places obligations on only one party. For each material issue, propose specific redline language with a one-line rationale, then give a short go / negotiate / no-go read for our side.

Write in a hedged, professional voice: avoid categorical claims ("this is X"); prefer "this appears to / is intended to / we recommend". This is preparation for counsel, not legal advice — say so, and flag anything that genuinely needs a licensed attorney. Do not send, save, or share anything; return the review here for my approval.`
  },
  {
    id: 'draft-from-notes',
    title: 'Draft from Notes',
    description: 'Turn call or meeting notes into a follow-up and a clean first draft.',
    icon: 'pen-tool',
    mode: 'approval',
    prompt: `You are my Chief of Staff drafting from my notes. Paste the call or meeting notes, and tell me what you need — for example a follow-up email, a term sheet, an MoU, or an engagement letter.

Use only what the notes support. Mark every assumption explicitly, and list open items separately rather than guessing. Never invent commercial terms, numbers, dates, or names that are not in the notes. Produce a clean, ready-to-edit draft in my voice, plus a short cover note where one helps.

Write precisely and skimmably. This is a first draft to prepare for counsel or a counterparty, not legal advice. Do not send, save, or share anything; return the drafts here for my approval before any send or write.`
  }
];

function timeOfDayScore(mission: Mission, hourOfDay: number): number {
  if (mission.id === 'morning-brief' && hourOfDay >= 5 && hourOfDay <= 11) return 2;
  if (
    (mission.id === 'inbox-triage' || mission.id === 'follow-up-catcher') &&
    hourOfDay >= 11 &&
    hourOfDay <= 16
  ) {
    return 2;
  }
  return 0;
}

export function recommendMissions(
  missions: Mission[],
  packStatuses: Record<ConnectorPackId, ConnectorPackStatus>,
  hourOfDay: number
): Mission[] {
  return missions
    .map((mission, index) => ({ mission, index }))
    .filter(({ mission }) =>
      (mission.required_connectors ?? []).every(
        (connector) => packStatuses[connector] === 'connected'
      )
    )
    .sort((a, b) => {
      const scoreDelta =
        timeOfDayScore(b.mission, hourOfDay) - timeOfDayScore(a.mission, hourOfDay);
      return scoreDelta || a.index - b.index;
    })
    .map(({ mission }) => mission);
}

export function missionById(id: string): Mission | undefined {
  return FIRST_RUN_MISSIONS.find((mission) => mission.id === id);
}
