const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

function parseTimestamp(input: string | number): number | null {
  const timestamp = typeof input === 'number' ? input : Date.parse(input);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Compact relative time: "just now" (< 45s), "5m ago", "3h ago",
 *  "2d ago", "3w ago", "5mo ago", "2y ago". Past only; a future or
 *  unparseable input returns "just now". `now` is injectable for tests
 *  (defaults to Date.now()). Accepts an ISO string or epoch ms. */
export function relativeTime(input: string | number, now = Date.now()): string {
  const timestamp = parseTimestamp(input);
  if (timestamp === null || timestamp > now) {
    return 'just now';
  }

  const elapsed = now - timestamp;
  if (elapsed < 45 * SECOND_MS) {
    return 'just now';
  }

  if (elapsed < HOUR_MS) {
    return `${Math.max(1, Math.floor(elapsed / MINUTE_MS))}m ago`;
  }

  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  }

  if (elapsed < WEEK_MS) {
    return `${Math.floor(elapsed / DAY_MS)}d ago`;
  }

  if (elapsed < MONTH_MS) {
    return `${Math.floor(elapsed / WEEK_MS)}w ago`;
  }

  if (elapsed < YEAR_MS) {
    return `${Math.floor(elapsed / MONTH_MS)}mo ago`;
  }

  return `${Math.floor(elapsed / YEAR_MS)}y ago`;
}

/** Humanize a duration in ms: "0s", "45s", "5m", "1h 5m", "2d 3h".
 *  Shows at most the two largest non-zero units. Negative -> "0s". */
export function formatDuration(ms: number): string {
  if (ms <= 0 || !Number.isFinite(ms)) {
    return '0s';
  }

  const totalSeconds = Math.floor(ms / SECOND_MS);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const units = [
    { label: 'd', value: days },
    { label: 'h', value: hours },
    { label: 'm', value: minutes },
    { label: 's', value: seconds }
  ];

  const parts = units
    .filter((unit) => unit.value > 0)
    .slice(0, 2)
    .map((unit) => `${unit.value}${unit.label}`);

  return parts.length > 0 ? parts.join(' ') : '0s';
}

/** Absolute local timestamp for tooltips, e.g. "2026-05-28 17:42".
 *  Unparseable input returns the empty string. */
export function absoluteTime(input: string | number): string {
  const timestamp = parseTimestamp(input);
  if (timestamp === null) {
    return '';
  }

  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours()
  )}:${pad2(date.getMinutes())}`;
}
