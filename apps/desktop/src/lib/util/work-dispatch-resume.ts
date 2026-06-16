import type { AttachmentInput } from '$lib/api/types';

const STORAGE_KEY = 'ironclaw-work-dispatch-resumes';
const MAX_RESUME_RECORDS = 25;

export const WORK_DISPATCH_RESUME_PARAM = 'resumeWorkDispatch';

export interface WorkDispatchResume {
  id: string;
  source: 'reborn-chat';
  workItemId: string;
  boundaryId: string;
  content: string;
  attachments: AttachmentInput[];
  threadId?: string;
  created_at: string;
  updated_at: string;
}

type WorkDispatchResumeInput = Pick<
  WorkDispatchResume,
  'source' | 'workItemId' | 'boundaryId' | 'content' | 'attachments' | 'threadId'
>;

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `resume-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function coerceAttachment(raw: unknown): AttachmentInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const name = typeof value.name === 'string' ? value.name : '';
  const mime_type = typeof value.mime_type === 'string' ? value.mime_type : '';
  const data_base64 = typeof value.data_base64 === 'string' ? value.data_base64 : '';
  if (!name || !mime_type || !data_base64) return null;
  return { name, mime_type, data_base64 };
}

function coerceResume(raw: unknown): WorkDispatchResume | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const source = value.source === 'reborn-chat' ? value.source : null;
  const workItemId = typeof value.workItemId === 'string' ? value.workItemId.trim() : '';
  const boundaryId = typeof value.boundaryId === 'string' ? value.boundaryId.trim() : '';
  const content = typeof value.content === 'string' ? value.content : '';
  const created_at = typeof value.created_at === 'string' ? value.created_at : '';
  const updated_at = typeof value.updated_at === 'string' ? value.updated_at : '';
  if (!id || !source || !workItemId || !boundaryId || !content || !created_at || !updated_at) {
    return null;
  }
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.map(coerceAttachment).filter((a): a is AttachmentInput => a !== null)
    : [];
  const threadId =
    typeof value.threadId === 'string' && value.threadId.trim() ? value.threadId : undefined;
  return {
    id,
    source,
    workItemId,
    boundaryId,
    content,
    attachments,
    threadId,
    created_at,
    updated_at
  };
}

function readAll(): WorkDispatchResume[] {
  if (!canUseStorage()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(coerceResume).filter((r): r is WorkDispatchResume => r !== null);
  } catch {
    return [];
  }
}

function writeAll(records: WorkDispatchResume[]): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, MAX_RESUME_RECORDS)));
  } catch {
    // Storage failures should not make the approval UI unusable.
  }
}

export function createWorkDispatchResume(
  input: WorkDispatchResumeInput
): WorkDispatchResume | null {
  if (!canUseStorage()) return null;
  const now = new Date().toISOString();
  const record: WorkDispatchResume = {
    id: newId(),
    source: input.source,
    workItemId: input.workItemId,
    boundaryId: input.boundaryId,
    content: input.content,
    attachments: input.attachments,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    created_at: now,
    updated_at: now
  };
  upsertWorkDispatchResume(record);
  return record;
}

export function getWorkDispatchResume(id: string | null | undefined): WorkDispatchResume | null {
  if (!id) return null;
  return readAll().find((record) => record.id === id) ?? null;
}

export function upsertWorkDispatchResume(record: WorkDispatchResume): void {
  const now = new Date().toISOString();
  const next = [
    { ...record, updated_at: now },
    ...readAll().filter((existing) => existing.id !== record.id)
  ];
  writeAll(next);
}

export function updateWorkDispatchResumeBoundary(
  id: string | null | undefined,
  boundaryId: string
): void {
  const record = getWorkDispatchResume(id);
  if (!record) return;
  upsertWorkDispatchResume({ ...record, boundaryId });
}

export function removeWorkDispatchResume(id: string | null | undefined): void {
  if (!id) return;
  writeAll(readAll().filter((record) => record.id !== id));
}

export function workDispatchReviewHref(
  record: WorkDispatchResume | null,
  workItemId: string
): string {
  if (!record) return `/work?item=${encodeURIComponent(workItemId)}`;
  return `/work?item=${encodeURIComponent(workItemId)}&${WORK_DISPATCH_RESUME_PARAM}=${encodeURIComponent(record.id)}`;
}

export function workDispatchChatHref(record: WorkDispatchResume): string {
  const params = new URLSearchParams({ [WORK_DISPATCH_RESUME_PARAM]: record.id });
  if (record.threadId) params.set('thread', record.threadId);
  return `/chat?${params.toString()}`;
}
