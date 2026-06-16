// Cron expression → human-readable description.
//
// Pure TS, zero dependencies. We deliberately scope coverage to the
// patterns IronClaw routines actually use (full RFC 6164 coverage would
// triple the surface area for no win); anything outside our grammar
// returns `{valid: false}` with a generic "Invalid cron expression"
// message so the UI can render the same error regardless of which
// field tripped the parser.
//
// Supported forms:
//   - 5-field cron:    `m h dom mon dow`
//     Each field accepts:
//       *           → wildcard
//       N           → literal integer
//       N-M         → inclusive range
//       N,M,…       → comma-separated list of literals/ranges
//       * / N       → step (also `N-M/S` for stepped range)
//   - shortcut aliases: `@hourly`, `@daily`, `@weekly`, `@monthly`,
//     `@yearly`, `@annually`, `@midnight`
//   - IronClaw's friendly `every Ns|m|h|d` shorthand
//
// We don't return the next-firing timestamp because computing it
// requires a real scheduling library. The interface keeps `next?:
// string` so we can fill it in later without an API change; today it's
// always undefined.

export interface CronDescription {
  /** Human-readable summary of the expression. */
  text: string;
  /** Whether the expression parsed as a recognized pattern. */
  valid: boolean;
  /**
   * ISO timestamp of the next firing. Always undefined in v1 — see
   * module header. The field stays in the contract so future swaps to
   * a real next-firing computation don't break callers.
   */
  next?: string;
}

const INVALID: CronDescription = { text: 'Invalid cron expression', valid: false };

// ─── Friendly shorthand: `every 5m`, `every 30s`, etc. ──────────────────
// Matches IronClaw routine YAML, which lets operators write `every 1h`
// instead of `0 * * * *`. The match is case-insensitive and tolerates
// the singular and plural unit names.
const EVERY_REGEX =
  /^every\s+(\d+)\s*(s(?:ec(?:onds?)?)?|m(?:in(?:utes?)?)?|h(?:ours?)?|d(?:ays?)?|w(?:eeks?)?)$/i;

// ─── Shortcut aliases ────────────────────────────────────────────────────
// Map the standard `@hourly` / `@daily` / etc. directives to their
// natural-language form.
const SHORTCUTS: Record<string, string> = {
  '@hourly': 'Every hour',
  '@daily': 'Every day at midnight',
  '@midnight': 'Every day at midnight',
  '@weekly': 'Every Sunday at midnight',
  '@monthly': 'On the 1st of every month at midnight',
  '@yearly': 'On Jan 1 every year at midnight',
  '@annually': 'On Jan 1 every year at midnight'
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
];

// Range guards per field. Stored as [min, max] inclusive. dom is 1-31,
// mon is 1-12, dow is 0-6 (Sunday = 0; 7 also accepted and remapped to
// 0 to match Vixie cron and Linux cron behaviour).
const FIELD_RANGES: Array<{
  name: 'minute' | 'hour' | 'dom' | 'month' | 'dow';
  min: number;
  max: number;
}> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 6 }
];

interface ParsedField {
  // True when the field was a bare `*` (no list/range/step).
  wildcard: boolean;
  // Step value if the expression used a `* / N` form, otherwise null.
  step: number | null;
  // Sorted, deduped list of literal values the field matches. Empty
  // when the field was a wildcard with no step (i.e. matches all).
  values: number[];
}

// Parse a single cron field. Returns null if the field is malformed
// (out of range, unparseable integer, empty token, etc.).
//
// The grammar accepted here is the intersection of Vixie cron and
// common modern variants — wildcard, integers, `N-M` ranges, `N,M,…`
// lists, and step expressions (`* / N` or `N-M / S`). Day-of-week `7`
// is remapped to `0` upstream for Vixie/Linux compatibility.
function parseField(raw: string, range: { min: number; max: number }): ParsedField | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Pure wildcard — no step, matches everything.
  if (trimmed === '*') {
    return { wildcard: true, step: null, values: [] };
  }

  // Step form. Accepts `*/N` and `MIN-MAX/N`. Anything else with a
  // slash is rejected.
  if (trimmed.includes('/')) {
    const [base, stepStr] = trimmed.split('/');
    const step = Number(stepStr);
    if (!Number.isInteger(step) || step <= 0) return null;
    let lo: number;
    let hi: number;
    if (base === '*') {
      lo = range.min;
      hi = range.max;
    } else if (base.includes('-')) {
      const [aStr, bStr] = base.split('-');
      const a = Number(aStr);
      const b = Number(bStr);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      if (a < range.min || b > range.max || a > b) return null;
      lo = a;
      hi = b;
    } else {
      // Bare `N/S` — common extension meaning "starting at N, every S
      // within the field range". Mirrors Vixie / Linux cron.
      const a = Number(base);
      if (!Number.isInteger(a)) return null;
      if (a < range.min || a > range.max) return null;
      lo = a;
      hi = range.max;
    }
    const values: number[] = [];
    for (let v = lo; v <= hi; v += step) values.push(v);
    // Step expressions are never treated as wildcards even when they
    // span the full field range — otherwise `*/15` would be
    // indistinguishable from `*` at the dispatch layer below and the
    // "Every 15 minutes" template would never fire.
    return {
      wildcard: false,
      step,
      values
    };
  }

  // Comma list (possibly mixing literals and ranges).
  if (trimmed.includes(',')) {
    const parts = trimmed.split(',');
    const seen = new Set<number>();
    for (const part of parts) {
      const sub = parseField(part, range);
      if (!sub || sub.values.length === 0) return null;
      for (const v of sub.values) seen.add(v);
    }
    return {
      wildcard: false,
      step: null,
      values: Array.from(seen).sort((a, b) => a - b)
    };
  }

  // Range form.
  if (trimmed.includes('-')) {
    const [aStr, bStr] = trimmed.split('-');
    const a = Number(aStr);
    const b = Number(bStr);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
    if (a < range.min || b > range.max || a > b) return null;
    const values: number[] = [];
    for (let v = a; v <= b; v += 1) values.push(v);
    return { wildcard: false, step: null, values };
  }

  // Bare integer.
  const n = Number(trimmed);
  if (!Number.isInteger(n)) return null;
  if (n < range.min || n > range.max) return null;
  return { wildcard: false, step: null, values: [n] };
}

/**
 * Format an hour + minute pair as a 12-hour clock time.
 * Examples: `(9, 0)` → `9:00 AM`, `(0, 0)` → `12:00 AM`, `(13, 30)` →
 * `1:30 PM`. Pulled out so the same logic runs for minute lists and
 * fixed times.
 */
function formatTime(hour: number, minute: number): string {
  const period = hour < 12 ? 'AM' : 'PM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const mm = String(minute).padStart(2, '0');
  return `${h12}:${mm} ${period}`;
}

/**
 * Compact human description of a day-of-week field. Recognises a few
 * common shapes:
 *   - all 7 → "every day"
 *   - Mon-Fri (1-5) → "every weekday"
 *   - Sat-Sun (0, 6) → "every weekend"
 *   - single day → "every Monday"
 *   - small list → "every Mon, Wed and Fri"
 * Anything else falls back to the raw value list.
 */
function describeDow(field: ParsedField): string {
  if (field.wildcard) return 'every day';
  const values = field.values;
  if (values.length === 7) return 'every day';
  // 1-5 weekday block.
  if (values.length === 5 && values.every((v, i) => v === i + 1)) {
    return 'every weekday';
  }
  // 0 and 6 weekend block.
  if (values.length === 2 && values[0] === 0 && values[1] === 6) {
    return 'every weekend';
  }
  if (values.length === 1) {
    return `every ${DAY_NAMES[values[0]]}`;
  }
  const names = values.map((v) => DAY_NAMES[v].slice(0, 3));
  if (names.length === 2) return `every ${names[0]} and ${names[1]}`;
  return `every ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Describe a day-of-month field. Picks an ordinal suffix and supports
 * a small comma list. Wildcards are caller-handled (returning "every"
 * would clash with the prefix in the parent description).
 */
function describeDom(field: ParsedField): string {
  if (field.wildcard) return 'every day';
  const values = field.values;
  if (values.length === 1) return `the ${ordinal(values[0])}`;
  const ords = values.map(ordinal);
  if (ords.length === 2) return `the ${ords[0]} and ${ords[1]}`;
  return `the ${ords.slice(0, -1).join(', ')} and ${ords[ords.length - 1]}`;
}

/** "1" → "1st", "2" → "2nd", "11" → "11th", etc. */
function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const mod10 = n % 10;
  if (mod10 === 1) return `${n}st`;
  if (mod10 === 2) return `${n}nd`;
  if (mod10 === 3) return `${n}rd`;
  return `${n}th`;
}

/** Describe a month field — wildcard → "every month", single → month name. */
function describeMonth(field: ParsedField): string {
  if (field.wildcard) return 'every month';
  if (field.values.length === 1) return MONTH_NAMES[field.values[0] - 1];
  return field.values.map((v) => MONTH_NAMES[v - 1]).join(', ');
}

/**
 * Top-level entry point. Returns a human-readable description for the
 * supported cron patterns, or `{valid: false}` for anything we don't
 * recognise. Whitespace is normalised before parsing so multi-space
 * inputs (`0  9  *  *  1`) still match.
 */
export function describeCron(expr: string): CronDescription {
  if (typeof expr !== 'string') return INVALID;
  const trimmed = expr.trim();
  if (trimmed.length === 0) return INVALID;

  // Shortcut aliases (e.g. `@daily`). Case-insensitive — operators
  // sometimes capitalise them.
  const lower = trimmed.toLowerCase();
  const aliasText = SHORTCUTS[lower];
  if (aliasText) return { text: aliasText, valid: true };

  // Friendly `every Ns|m|h|d|w` shorthand. Translates to "Every N
  // <unit>" with proper pluralisation. Singular `1` → "Every <unit>".
  const everyMatch = trimmed.match(EVERY_REGEX);
  if (everyMatch) {
    const n = Number(everyMatch[1]);
    if (!Number.isInteger(n) || n <= 0) return INVALID;
    const unitChar = everyMatch[2][0].toLowerCase();
    const unitWord =
      unitChar === 's'
        ? 'second'
        : unitChar === 'm'
          ? 'minute'
          : unitChar === 'h'
            ? 'hour'
            : unitChar === 'd'
              ? 'day'
              : 'week';
    if (n === 1) return { text: `Every ${unitWord}`, valid: true };
    return { text: `Every ${n} ${unitWord}s`, valid: true };
  }

  // 5-field cron. Split on any run of whitespace so `0\t9 *\t* 1`
  // works the same as `0 9 * * 1`.
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return INVALID;

  // Parse each field with its range. Bail on the first failure so we
  // never produce a partial description.
  const fields: ParsedField[] = [];
  for (let i = 0; i < 5; i += 1) {
    const range = FIELD_RANGES[i];
    let raw = parts[i];
    // dow accepts `7` as an alias for `0` (Sunday). Vixie / Linux
    // cron behavior — `0 9 * * 7` should describe Sunday, not error.
    if (range.name === 'dow') {
      raw = raw.replace(/\b7\b/g, '0');
    }
    const parsed = parseField(raw, range);
    if (!parsed) return INVALID;
    fields.push(parsed);
  }

  const [minute, hour, dom, month, dow] = fields;

  // ─── Pattern dispatch ────────────────────────────────────────────────
  //
  // Order matters. We pick the most specific shape that matches the
  // expression — for example, "every weekday at 9am" before falling
  // back to the generic "every day at 9:00 AM" template.

  // Every minute (`* * * * *`).
  if (minute.wildcard && hour.wildcard && dom.wildcard && month.wildcard && dow.wildcard) {
    return { text: 'Every minute', valid: true };
  }

  // Stepped minute wildcard: `*/N * * * *` (or `*/N` in any all-wild
  // outer position).
  if (
    minute.step !== null &&
    minute.wildcard === false &&
    hour.wildcard &&
    dom.wildcard &&
    month.wildcard &&
    dow.wildcard
  ) {
    return {
      text: minute.step === 1 ? 'Every minute' : `Every ${minute.step} minutes`,
      valid: true
    };
  }

  // Stepped hour wildcard: `0 */N * * *`.
  if (
    minute.values.length === 1 &&
    minute.values[0] === 0 &&
    hour.step !== null &&
    hour.wildcard === false &&
    dom.wildcard &&
    month.wildcard &&
    dow.wildcard
  ) {
    return {
      text: hour.step === 1 ? 'Every hour' : `Every ${hour.step} hours`,
      valid: true
    };
  }

  // `0 * * * *` → "Every hour at minute 0".
  if (
    minute.values.length === 1 &&
    hour.wildcard &&
    dom.wildcard &&
    month.wildcard &&
    dow.wildcard
  ) {
    return {
      text: `Every hour at minute ${minute.values[0]}`,
      valid: true
    };
  }

  // Fixed time of day. Requires a single minute AND a single hour so
  // we can format `N:MM AM/PM`. Falls through to the generic case
  // otherwise.
  const hasFixedTime = minute.values.length === 1 && hour.values.length === 1;
  if (hasFixedTime) {
    const time = formatTime(hour.values[0], minute.values[0]);

    // Yearly fixed time on a specific calendar date.
    // `0 9 1 1 *` → "On Jan 1 every year at 9:00 AM".
    if (dom.values.length === 1 && month.values.length === 1 && dow.wildcard) {
      return {
        text: `On ${MONTH_NAMES[month.values[0] - 1]} ${dom.values[0]} every year at ${time}`,
        valid: true
      };
    }

    // Monthly fixed time on a specific dom (any month).
    // `0 9 1 * *` → "On the 1st of every month at 9:00 AM".
    if (dom.values.length >= 1 && !dom.wildcard && month.wildcard && dow.wildcard) {
      return {
        text: `On ${describeDom(dom)} of every month at ${time}`,
        valid: true
      };
    }

    // Weekly fixed time, day-of-week pinned.
    // `0 9 * * 1-5` → "Every weekday at 9:00 AM".
    if (dom.wildcard && month.wildcard && !dow.wildcard) {
      return {
        text: `${capitalize(describeDow(dow))} at ${time}`,
        valid: true
      };
    }

    // Daily fixed time, everything else wild. `0 9 * * *`.
    if (dom.wildcard && month.wildcard && dow.wildcard) {
      return { text: `Every day at ${time}`, valid: true };
    }
  }

  // Fallback: produce the best description we can with the pieces we
  // have. This is the catch-all for anything the specific dispatch
  // didn't claim — e.g. multiple hours, multi-minute lists, etc.
  // The shape is "<minute clause> <day clause> <month clause>".
  return { text: genericDescribe(minute, hour, dom, month, dow), valid: true };
}

/** Capitalise the first letter, leave the rest alone. */
function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Fallback describer for cron shapes that don't match a known
 * specific template. Builds the description as a comma-glued series
 * of clauses; the result is wordier than the specific templates but
 * still correct.
 */
function genericDescribe(
  minute: ParsedField,
  hour: ParsedField,
  dom: ParsedField,
  month: ParsedField,
  dow: ParsedField
): string {
  const parts: string[] = [];

  // Time clause.
  if (minute.wildcard && hour.wildcard) {
    parts.push('Every minute');
  } else if (minute.wildcard) {
    parts.push(
      `Every minute past ${listValues(hour.values)} ${hour.values.length === 1 ? 'hour' : 'hours'}`
    );
  } else if (hour.wildcard) {
    parts.push(`At minute ${listValues(minute.values)} of every hour`);
  } else {
    parts.push(`At ${listValues(hour.values)}:${listValues(minute.values, true)}`);
  }

  // Day-of-month / month / day-of-week clauses, only if non-trivial.
  if (!dom.wildcard) parts.push(`on ${describeDom(dom)}`);
  if (!month.wildcard) parts.push(`in ${describeMonth(month)}`);
  if (!dow.wildcard) parts.push(`on ${describeDow(dow)}`);

  return parts.join(', ');
}

/**
 * Render a small list of numbers as a comma-separated string. The
 * `zeroPad` mode pads to two digits for minute slots so the parent
 * clause reads as `HH:MM`.
 */
function listValues(values: number[], zeroPad = false): string {
  if (values.length === 0) return '';
  const fmt = (v: number) => (zeroPad ? String(v).padStart(2, '0') : String(v));
  if (values.length === 1) return fmt(values[0]);
  if (values.length === 2) return `${fmt(values[0])} and ${fmt(values[1])}`;
  return `${values.slice(0, -1).map(fmt).join(', ')} and ${fmt(values[values.length - 1])}`;
}
