import { THREAD_STATE } from '../../../lib/thread-state.js';

const NEEDS_PRESENTATION = {
  [THREAD_STATE.NEEDS_ATTENTION]: {
    badge: 'Needs approval',
    detail: 'An approval or auth gate is waiting in this thread.'
  },
  [THREAD_STATE.FAILED]: {
    badge: 'Needs recovery',
    detail: 'A run failed and needs a next step.'
  }
};

export function buildFrontDoorData({
  threads = [],
  threadStates = new Map(),
  automations = [],
  now = Date.now(),
  lastSeenAt = 0,
  limit = 3
} = {}) {
  const normalizedThreads = normalizeThreads(threads);
  // "What moved while you were away": scheduled automations are the only
  // background actor in this binary (threads have no out-of-band producer), so a
  // settled automation run newer than the device's last-seen watermark is the
  // honest signal. lastSeenAt = 0 (first visit / no watermark) shows nothing.
  const sinceAwayAll = lastSeenAt ? sinceAwayAutomations(automations, lastSeenAt, now) : [];
  const sinceAway = sinceAwayAll.slice(0, limit);
  const sinceAwayTotal = sinceAwayAll.length;
  const needsYouAll = normalizedThreads
    .map((thread) => {
      const state = stateForThread(thread, threadStates);
      const presentation = NEEDS_PRESENTATION[state];
      if (!presentation) return null;
      return {
        id: `need-${thread.id}`,
        kind: 'thread',
        icon: state === THREAD_STATE.FAILED ? 'flag' : 'shield',
        title: thread.title,
        badge: presentation.badge,
        detail: presentation.detail,
        href: `/chat/${thread.id}`,
        timestamp: thread.timestamp,
        age: relativeAge(thread.timestamp, now)
      };
    })
    .filter(Boolean)
    .sort(compareByTimestampDesc);
  // Show the top N rows but report the TRUE pending count — under-reporting how
  // many decisions are waiting on a "Needs you" surface would understate the
  // user's real queue. needsYouTotal lets the renderer show "+N more".
  const needsYou = needsYouAll.slice(0, limit);
  const needsYouTotal = needsYouAll.length;

  // Don't double-list an automation run: if it's already under "Since your last
  // visit", keep it out of "Handled" so each settled run shows exactly once.
  const sinceAwayKeys = new Set(sinceAwayAll.map((item) => item.id.replace(/^away-/, '')));
  const handled = [
    ...completedAutomationReceipts(automations, now, sinceAwayKeys),
    ...recentThreadReceipts(normalizedThreads, threadStates, now)
  ]
    .sort(compareByTimestampDesc)
    .slice(0, limit);

  return { sinceAway, sinceAwayTotal, needsYou, needsYouTotal, handled };
}

// A settled automation run (completed or failed) whose last run landed after the
// last-seen watermark — the "moved while you were away" signal. Running/unknown
// states are not settled events, so they are excluded.
function sinceAwayAutomations(automations, lastSeenAt, now) {
  return (Array.isArray(automations) ? automations : [])
    .map((automation) => {
      const timestamp = automation?.last_run_at || automation?.lastRunAt || null;
      const ranAt = Date.parse(timestamp || '');
      if (!Number.isFinite(ranAt) || ranAt <= lastSeenAt) return null;
      const outcome = automationRunOutcome(
        automation?.last_status || automation?.lastStatus || automation?.last_status_label
      );
      if (!outcome) return null;
      return {
        id: `away-${automation.id || automation.display_name || automation.name}`,
        kind: 'automation',
        icon: outcome.icon,
        title: automation.display_name || automation.name || 'Scheduled automation',
        badge: outcome.badge,
        detail: automation.last_run_label
          ? `Ran ${automation.last_run_label}.`
          : 'Ran while you were away.',
        href: '/automations',
        timestamp,
        age: relativeAge(timestamp, now)
      };
    })
    .filter(Boolean)
    .sort(compareByTimestampDesc);
}

function automationRunOutcome(status) {
  const normalized = String(status || '').toLowerCase();
  if (
    normalized === 'ok' ||
    normalized === 'done' ||
    normalized === 'completed' ||
    normalized === 'success'
  ) {
    return { badge: 'Completed', icon: 'check' };
  }
  if (normalized === 'failed' || normalized === 'error') {
    return { badge: 'Failed', icon: 'flag' };
  }
  return null;
}

function normalizeThreads(threads) {
  return (Array.isArray(threads) ? threads : [])
    .map((thread) => {
      const id = String(thread?.id || thread?.thread_id || '').trim();
      if (!id) return null;
      const title =
        String(thread?.title || '').trim() || `Thread ${id.slice(0, Math.min(id.length, 8))}`;
      const timestamp = thread?.updated_at || thread?.created_at || null;
      return {
        id,
        title,
        timestamp,
        turnCount: Number(thread?.turn_count || thread?.turnCount || 0),
        state: normalizeThreadState(thread?.state)
      };
    })
    .filter(Boolean);
}

function stateForThread(thread, threadStates) {
  const fromStore =
    threadStates && typeof threadStates.get === 'function' ? threadStates.get(thread.id) : null;
  return normalizeThreadState(fromStore || thread.state);
}

function normalizeThreadState(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (normalized === 'needs_attention' || normalized === 'needs-your-attention') {
    return THREAD_STATE.NEEDS_ATTENTION;
  }
  if (normalized === 'failed' || normalized === 'error') return THREAD_STATE.FAILED;
  if (normalized === 'running' || normalized === 'processing') return THREAD_STATE.RUNNING;
  return '';
}

function completedAutomationReceipts(automations, now, excludeKeys = new Set()) {
  return (Array.isArray(automations) ? automations : [])
    .filter((automation) => {
      const key = automation?.id || automation?.display_name || automation?.name;
      if (key && excludeKeys.has(key)) return false;
      const status = String(
        automation?.last_status || automation?.lastStatus || automation?.last_status_label || ''
      ).toLowerCase();
      return status === 'ok' || status === 'done' || status === 'completed' || status === 'success';
    })
    .map((automation) => {
      const timestamp = automation.last_run_at || automation.lastRunAt || null;
      return {
        id: `automation-${automation.id || automation.display_name || automation.name}`,
        kind: 'automation',
        icon: 'check',
        title: automation.display_name || automation.name || 'Completed automation',
        badge: 'Completed',
        detail: automation.last_run_label
          ? `Automation result from ${automation.last_run_label}.`
          : 'Automation finished with a clean result.',
        href: '/automations',
        timestamp,
        age: relativeAge(timestamp, now)
      };
    });
}

function recentThreadReceipts(threads, threadStates, now) {
  return threads
    .filter((thread) => {
      if (thread.turnCount <= 0) return false;
      const state = stateForThread(thread, threadStates);
      return state !== THREAD_STATE.NEEDS_ATTENTION && state !== THREAD_STATE.FAILED;
    })
    .map((thread) => ({
      id: `recent-${thread.id}`,
      kind: 'thread',
      icon: 'chat',
      title: thread.title,
      badge: 'Recent work',
      detail: `${thread.turnCount} ${thread.turnCount === 1 ? 'turn' : 'turns'} in the thread.`,
      href: `/chat/${thread.id}`,
      timestamp: thread.timestamp,
      age: relativeAge(thread.timestamp, now)
    }));
}

function compareByTimestampDesc(a, b) {
  return timestampValue(b.timestamp) - timestampValue(a.timestamp);
}

function timestampValue(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function relativeAge(value, now = Date.now()) {
  const parsed = Date.parse(value || '');
  if (!Number.isFinite(parsed)) return '';
  const minutes = Math.max(1, Math.round((now - parsed) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
