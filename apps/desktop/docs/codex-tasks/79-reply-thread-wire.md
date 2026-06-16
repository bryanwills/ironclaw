# R79 — Reply-thread wire (intra-message Slack-style threads)

**Lane**: W2 (codex)
**Branch**: `codex/r79-reply-thread-wire`
**Depends on**: nothing

## Context

The current chat is flat — every assistant turn lives in the parent
thread. The Workspace OS shift (see `docs/WORKSPACE-OS.md`) introduces
**reply-threads**: hover any message, click "Reply in thread", open a
sub-conversation that doesn't displace the main thread. Slack-style.

This task ships the WIRE only:
- API client methods to post + stream replies that carry a
  `reply_to_message_id`.
- A store that keeps reply-threads keyed by parent message id.

UI (R80, claude) consumes this store.

## Owned files

- `src/lib/api/ironclaw.ts` — APPEND only: `postReplyThread`,
  `streamReplyThread`, `listReplyThread`.
- `src/lib/api/types.ts` — APPEND only.
- `src/lib/stores/reply-threads.svelte.ts` — NEW.
- `src/lib/stores/reply-threads.test.ts` — NEW.

## Forbidden

- All routes, components.
- All other stores.
- All Rust.

## Probe

Verify against baremetal3 (token in env, tunnel on 18789):

```bash
TOKEN="62c807bdfa3d40fa7b3b0d141c38e5a6edc0d8839669678c293c9497e821bc3f"
URL="http://127.0.0.1:18789"
THR="$(curl -s -H "Authorization: Bearer $TOKEN" "$URL/api/chat/threads" | jq -r '.threads[0].id')"
MSG="$(curl -s -H "Authorization: Bearer $TOKEN" "$URL/api/chat/threads/$THR/history" | jq -r '.messages[0].id')"

# 1. Does reply-to-message wire exist on /api/chat/send?
curl -sS -w "\n%{http_code}\n" -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(printf '{"content":"reply test","thread_id":"%s","reply_to_message_id":"%s"}' "$THR" "$MSG")" \
  "$URL/api/chat/send"

# 2. Per-message reply listing?
curl -sS -w "\n%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  "$URL/api/chat/messages/$MSG/replies"
```

If `reply_to_message_id` is silently dropped (no `<thread_reply>`
block in the returned content), the server side hasn't been wired
yet. Three options in priority order:

1. **Preferred**: open an upstream issue with the wire below and
   block. Don't ship a fake.
2. **Fallback A**: degrade gracefully — replies post as normal
   thread messages with a `> Replying to: "<truncated parent>"`
   prefix in the content. UI (R80) renders them as if threaded; on
   the server it's flat. Document the limitation.
3. **Fallback B**: client-side-only reply threads stored in
   `localStorage`. No server round trip. Survives session.

Pick option 1 if upstream is responsive, option 2 otherwise. Avoid
option 3 (data loss risk).

## Expected wire contract

```
POST /api/chat/send
  body: { content, thread_id, reply_to_message_id?, attachments? }
  resp: { message_id, status: "accepted" }

GET /api/chat/messages/<msg_id>/replies
  resp: { replies: Message[], next_cursor?: string }

SSE /api/chat/threads/<thr>/events
  events: existing assistant.* + new reply.posted / reply.streamed
```

## Type additions

```ts
export interface ReplyThread {
  parent_message_id: string;
  parent_thread_id: string;
  replies: Message[];
  unread_count: number;
  last_updated_at: string;
}

export interface ReplyThreadStreamEvent {
  type: 'reply.started' | 'reply.delta' | 'reply.completed' | 'reply.failed';
  reply_id: string;
  parent_message_id: string;
  delta?: string;
  message?: Message;
  error?: string;
}
```

## Client additions

```ts
async postReplyThread(
  parentMessageId: string,
  parentThreadId: string,
  content: string,
  attachments?: AttachmentInput[]
): Promise<{ message_id: string }> {
  const url = `${this.baseUrl}/api/chat/send`;
  const maybeTauri = await loadTauriFetch();
  const fetchImpl = maybeTauri ?? fetch;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
    },
    body: JSON.stringify({
      content,
      thread_id: parentThreadId,
      reply_to_message_id: parentMessageId,
      ...(attachments && attachments.length > 0 ? { attachments } : {})
    })
  });
  if (!res.ok) throw new Error(`postReplyThread ${res.status}`);
  return await res.json();
}

async listReplyThread(parentMessageId: string): Promise<Message[]> {
  const url = `${this.baseUrl}/api/chat/messages/${parentMessageId}/replies`;
  const maybeTauri = await loadTauriFetch();
  const fetchImpl = maybeTauri ?? fetch;
  const res = await fetchImpl(url, {
    headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}
  });
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error(`listReplyThread ${res.status}`);
  }
  const body = await res.json();
  return body.replies ?? [];
}
```

(Streaming reuses the existing `/api/chat/threads/<id>/events` SSE
with the new `reply.*` event types; no new endpoint needed.)

## Store spec

```ts
// Reply-threads keyed by parent message id. Each entry is a thin
// list of messages plus an unread counter that decrements as the
// UI opens the panel.
//
// Storage is in-memory. The IDB cache (R62) can persist later by
// keying on `parent_message_id` once that store is wired.

import { connection } from './connection.svelte';
import type { Message, ReplyThread, ReplyThreadStreamEvent } from '$lib/api/types';

class ReplyThreadsStore {
  private byParent = $state<Record<string, ReplyThread>>({});

  async load(parentMessageId: string, parentThreadId: string): Promise<void> {
    const client = connection.client;
    if (!client) return;
    const replies = await client.listReplyThread(parentMessageId);
    this.byParent[parentMessageId] = {
      parent_message_id: parentMessageId,
      parent_thread_id: parentThreadId,
      replies,
      unread_count: 0,
      last_updated_at: new Date().toISOString()
    };
  }

  async post(parentMessageId: string, parentThreadId: string, content: string): Promise<void> {
    const client = connection.client;
    if (!client) throw new Error('Not connected');
    const optimistic: Message = {
      id: `local-${Date.now()}`,
      role: 'user',
      content,
      created_at: new Date().toISOString()
    };
    this.appendReply(parentMessageId, optimistic);
    const { message_id } = await client.postReplyThread(parentMessageId, parentThreadId, content);
    // Patch the optimistic message with the server id.
    const slot = this.byParent[parentMessageId];
    if (slot) {
      slot.replies = slot.replies.map((r) =>
        r.id === optimistic.id ? { ...r, id: message_id } : r
      );
    }
  }

  /** Called by the thread-events SSE consumer when a reply event fires. */
  handleEvent(ev: ReplyThreadStreamEvent): void {
    const slot = this.byParent[ev.parent_message_id];
    if (!slot) return;
    if (ev.type === 'reply.completed' && ev.message) {
      this.appendReply(ev.parent_message_id, ev.message);
      slot.unread_count += 1;
    } else if (ev.type === 'reply.delta' && ev.delta) {
      // Append to the in-progress reply OR create a stub.
      let last = slot.replies[slot.replies.length - 1];
      if (!last || last.id !== ev.reply_id) {
        last = {
          id: ev.reply_id,
          role: 'assistant',
          content: '',
          created_at: new Date().toISOString()
        };
        slot.replies = [...slot.replies, last];
      }
      last.content += ev.delta;
      slot.replies = [...slot.replies.slice(0, -1), last];
    }
  }

  markRead(parentMessageId: string): void {
    const slot = this.byParent[parentMessageId];
    if (slot) slot.unread_count = 0;
  }

  forParent(parentMessageId: string): ReplyThread | null {
    return this.byParent[parentMessageId] ?? null;
  }

  unreadCount(parentMessageId: string): number {
    return this.byParent[parentMessageId]?.unread_count ?? 0;
  }

  private appendReply(parentMessageId: string, msg: Message): void {
    const slot = this.byParent[parentMessageId];
    if (slot) {
      slot.replies = [...slot.replies, msg];
      slot.last_updated_at = new Date().toISOString();
    }
  }
}

export const replyThreads = new ReplyThreadsStore();
```

## Acceptance

1. `npm run check` → 0 errors.
2. `npm run test` → green. Cases:
   - `post()` records the optimistic reply, then patches its id when
     the server responds.
   - `handleEvent('reply.delta')` appends to the in-progress reply.
   - `handleEvent('reply.completed')` increments unread.
   - `markRead` zeros the counter.
3. Manual: against baremetal3, call
   ```js
   await window._stores.replyThreads.post('<msg-id>', '<thr-id>', 'test reply');
   ```
   and verify the gateway accepts (200).

## Out of scope

- Any UI (R80).
- Streaming subscription wiring — the thread-events SSE consumer
  already exists; just confirm it forwards `reply.*` events to
  `replyThreads.handleEvent()`. If it doesn't, open a small
  registration PR that wires the dispatch and ship that BEFORE this
  brief.

## Notes

- Reply-threads are session-scoped; reloading the app clears them.
  R62 (IDB cache) will add persistence later.
- The server-side reply rendering is a `<thread_reply parent_id="...">`
  block — the assistant should respect the context. The desktop side
  doesn't have to parse that; we render replies as flat messages
  inside the panel.
