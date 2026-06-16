// Shared normalization for tabular widget payloads (TableWidget,
// ComparisonWidget). Both widgets had identical `cellText` + payload-shaping
// logic copy-pasted; this is the single source of truth. (Audit R200 P1.)
//
// Widget payloads are untrusted `unknown` (they come off the wire / generative
// widget framework), so every step is defensive: non-array headers/rows
// collapse to empty, and non-array rows collapse to `[]` rather than throwing.

interface RawTablePayload {
  headers?: unknown[];
  rows?: unknown[][];
}

/** Coerce an arbitrary table cell value to display text. Strings pass through;
 *  null/undefined → ''; everything else is JSON-stringified. */
export function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * Normalize an arbitrary widget payload into string `headers` + `rows`.
 * Defensive against any shape: missing/!array headers → `[]`; missing/!array
 * rows → `[]`; a non-array row → `[]`. Never throws.
 */
export function normalizeTablePayload(payload: unknown): {
  headers: string[];
  rows: string[][];
} {
  const p = (payload ?? {}) as RawTablePayload;
  const headers = Array.isArray(p.headers) ? p.headers.map(cellText) : [];
  const rows = Array.isArray(p.rows)
    ? p.rows.map((row) => (Array.isArray(row) ? row.map(cellText) : []))
    : [];
  return { headers, rows };
}
