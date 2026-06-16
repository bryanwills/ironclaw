// Pure, DOM-free search over a saved Work item: match the query against the
// title and every artifact's text body, returning a one-line snippet around the
// first body hit so a phrase that lives only inside a document is findable. Kept
// import-free (no React) so it is unit testable.
const SNIPPET_RADIUS = 48;

function snippetAround(text, index, queryLength) {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + queryLength + SNIPPET_RADIUS);
  const core = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${core}${end < text.length ? '…' : ''}`;
}

/**
 * @param {any} item
 * @param {string} query
 * @returns {{ match: boolean, snippet: string }}
 */
export function workItemSearchMatch(item, query) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return { match: true, snippet: '' };
  // Title hits need no snippet (the row already shows the title).
  if (
    String(item?.title || '')
      .toLowerCase()
      .includes(q)
  )
    return { match: true, snippet: '' };
  const artifacts = Array.isArray(item?.artifacts) ? item.artifacts : [];
  for (const artifact of artifacts) {
    const text = String(artifact?.content || '');
    if (!text) continue;
    const index = text.toLowerCase().indexOf(q);
    if (index >= 0) return { match: true, snippet: snippetAround(text, index, q.length) };
  }
  return { match: false, snippet: '' };
}
