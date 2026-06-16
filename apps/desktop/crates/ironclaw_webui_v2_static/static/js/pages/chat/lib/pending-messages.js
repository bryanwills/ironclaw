const STORAGE_PREFIX = 'ironclaw:pending-messages:v1:';
const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000;

// Ids must stay unique across WebView reloads and parallel windows: records
// now outlive the session in localStorage, so a session-scoped counter would
// collide with restored rows and false-confirm/destroy them.
export function pendingMessageId() {
  const unique =
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `pending-${unique}`;
}

export function addPending(store, key, record) {
  const existing = store.get(key) || loadPending(key);
  replacePending(store, key, [...existing, record]);
}

export function removePending(store, key, pendingId) {
  const existing = store.get(key) || loadPending(key);
  const index = existing.findIndex((r) => r.id === pendingId);
  if (index === -1) return;
  replacePending(store, key, existing.slice(0, index).concat(existing.slice(index + 1)));
}

export function replacePending(store, key, records) {
  const next = sanitizeRecords(records);
  if (next.length > 0) store.set(key, next);
  else store.delete(key);
  persistPending(key, next);
}

export function loadPending(key) {
  const storage = pendingStorage();
  if (!storage || !key) return [];
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(key)) || '[]');
    const records = sanitizeRecords(parsed).filter(isFreshPendingRecord);
    if (records.length !== parsed.length) persistPending(key, records);
    return records;
  } catch (_) {
    persistPending(key, []);
    return [];
  }
}

export function recordAcceptedMessageRef(store, key, pendingId, acceptedMessageRef) {
  const timelineMessageId = timelineMessageIdFromAcceptedRef(acceptedMessageRef);
  if (!timelineMessageId) return null;

  updatePending(store, key, pendingId, { timelineMessageId });
  return timelineMessageId;
}

function updatePending(store, key, pendingId, patch) {
  const existing = store.get(key) || loadPending(key);
  const index = existing.findIndex((record) => record.id === pendingId);
  if (index === -1) return;
  const next = existing.slice();
  next[index] = { ...next[index], ...patch };
  replacePending(store, key, next);
}

function timelineMessageIdFromAcceptedRef(ref) {
  if (typeof ref !== 'string') return null;
  return ref.startsWith('msg:') ? ref.slice('msg:'.length) : null;
}

function persistPending(key, records) {
  const storage = pendingStorage();
  if (!storage || !key) return;
  try {
    if (records.length > 0) {
      storage.setItem(storageKey(key), JSON.stringify(records.slice(-25)));
    } else {
      storage.removeItem(storageKey(key));
    }
  } catch (_) {
    // Persistence is a best-effort UX guard. Storage failures must not break chat.
  }
}

function pendingStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : globalThis.localStorage;
  } catch (_) {
    return null;
  }
}

function storageKey(key) {
  return `${STORAGE_PREFIX}${encodeURIComponent(String(key || ''))}`;
}

function sanitizeRecords(records) {
  if (!Array.isArray(records)) return [];
  return records
    .map((record) => sanitizeRecord(record))
    .filter(Boolean)
    .slice(-25);
}

function sanitizeRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const id = String(record.id || '').slice(0, 160);
  const content = String(record.content || '');
  if (!id || !content.trim()) return null;
  return {
    id,
    role: record.role || 'user',
    content,
    timestamp: record.timestamp || new Date().toISOString(),
    // Base64 image payloads never enter the durable queue; their metadata
    // travels in `attachments` alongside file chips.
    images: [],
    attachments: sanitizeAttachments(record.attachments),
    isOptimistic: record.isOptimistic !== false,
    timelineMessageId: record.timelineMessageId || null
  };
}

function sanitizeAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.slice(0, 10).map((attachment) => ({
    filename: String(attachment?.filename || attachment?.name || 'attachment').slice(0, 240),
    mime_type: String(attachment?.mime_type || 'application/octet-stream').slice(0, 120),
    size_label: String(attachment?.size_label || '').slice(0, 80)
  }));
}

function isFreshPendingRecord(record) {
  const timestamp = Date.parse(record.timestamp || '');
  if (!Number.isFinite(timestamp)) return true;
  return Date.now() - timestamp < MAX_PENDING_AGE_MS;
}
