// Pure, DOM-free builder for the Work "Activity" ledger: flatten every saved
// item into a cross-matter, reverse-chronological stream of events — one "saved"
// event per item plus one "action" event per receipt (what the agent actually
// did, captured in dossierFromMessages). Device-local + saved-work-scoped by
// construction; the UI states that honestly (no claim of a full server audit).
function timestampValue(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @param {any[]} items
 * @returns {Array<{ id: string, kind: 'saved'|'action', label: string, detail: string, status: string, matter: string, matterId: string, artifactId: string, timestamp: string|null }>}
 */
export function buildWorkLedger(items) {
  const entries = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !item.id) continue;
    const timestamp = item.updated_at || item.created_at || null;
    const artifacts = Array.isArray(item.artifacts) ? item.artifacts : [];
    const artifactId = (artifacts.find((artifact) => artifact && artifact.id) || {}).id || '';
    const matter = String(item.title || 'Saved work');
    const base = { matter, matterId: item.id, artifactId, timestamp };
    entries.push({
      ...base,
      id: `${item.id}-saved`,
      kind: 'saved',
      label: matter,
      detail: '',
      status: ''
    });
    const receipts = Array.isArray(item.receipts) ? item.receipts : [];
    receipts.forEach((receipt, index) => {
      entries.push({
        ...base,
        id: `${item.id}-action-${index}`,
        kind: 'action',
        label: String((receipt && receipt.label) || 'action'),
        detail: String((receipt && receipt.detail) || ''),
        status: String((receipt && receipt.status) || '')
      });
    });
  }
  return entries.sort((a, b) => timestampValue(b.timestamp) - timestampValue(a.timestamp));
}
