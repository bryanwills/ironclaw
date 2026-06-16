// Small relative-time + duration formatters. Pulled into a helper because
// the table, detail panel, and runs list all need them and we don't want
// to bring in `date-fns` for ~30 lines of logic.

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Returns a compact relative-time string ("2h ago", "in 3h", "just now").
 * Returns "—" for missing / unparseable timestamps so the UI stays tidy.
 */
export function relativeTime(iso?: string, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const deltaSec = Math.round((t - now) / 1000);
  const abs = Math.abs(deltaSec);
  if (abs < 5) return 'just now';
  const future = deltaSec > 0;
  let value: number;
  let unit: string;
  if (abs < MINUTE) {
    value = abs;
    unit = 's';
  } else if (abs < HOUR) {
    value = Math.round(abs / MINUTE);
    unit = 'm';
  } else if (abs < DAY) {
    value = Math.round(abs / HOUR);
    unit = 'h';
  } else if (abs < WEEK) {
    value = Math.round(abs / DAY);
    unit = 'd';
  } else {
    value = Math.round(abs / WEEK);
    unit = 'w';
  }
  return future ? `in ${value}${unit}` : `${value}${unit} ago`;
}

/**
 * Format a duration between two ISO timestamps. Falls back to "—" if
 * either is missing or unparseable. Used for the routine runs table.
 */
export function durationBetween(startIso?: string, endIso?: string): string {
  if (!startIso || !endIso) return '—';
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  if (Number.isNaN(s) || Number.isNaN(e)) return '—';
  const ms = e - s;
  if (ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = sec / 60;
  if (min < 60) return `${min.toFixed(1)}m`;
  const hr = min / 60;
  return `${hr.toFixed(1)}h`;
}

/** Format an ISO timestamp as a short local timestamp like "May 27, 14:32:09". */
export function shortTimestamp(iso?: string): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}
