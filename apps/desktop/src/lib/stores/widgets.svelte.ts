// Generative widget registry.
//
// Widgets are promoted from structured Markdown blocks, then pinned to
// surfaces such as the dashboard or spatial canvas. The in-memory state is a
// Svelte 5 rune store; persistence writes to IndexedDB when available and to a
// localStorage mirror for older builds / synchronous boot hydration.

import type { ChatEvent, PromotableBlock, Widget } from '$lib/api/types';
import { connection } from './connection.svelte';

const STORAGE_KEY = 'ironclaw-widgets';
const DB_NAME = 'ironclaw-widgets';
const DB_VERSION = 1;
const STORE_NAME = 'widgets';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function storageAvailable(): boolean {
  return typeof localStorage !== 'undefined';
}

function isForbiddenKey(k: string): boolean {
  return k === '__proto__' || k === 'constructor' || k === 'prototype';
}

function isWidget(v: unknown): v is Widget {
  if (!v || typeof v !== 'object') return false;
  const w = v as Record<string, unknown>;
  return (
    typeof w.id === 'string' &&
    typeof w.kind === 'string' &&
    typeof w.title === 'string' &&
    w.source !== null &&
    typeof w.source === 'object' &&
    Array.isArray(w.pinned_to) &&
    typeof w.created_at === 'string' &&
    typeof w.updated_at === 'string'
  );
}

function coerceWidgets(raw: unknown): Record<string, Widget> {
  const out: Record<string, Widget> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isForbiddenKey(k)) continue;
    if (!isWidget(v)) continue;
    out[k] = {
      ...v,
      pinned_to: v.pinned_to.filter((p): p is string => typeof p === 'string')
    };
  }
  return out;
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }

  dbPromise = new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }

    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
  return dbPromise;
}

async function putWidgetsIdb(widgets: Record<string, Widget>): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      for (const widget of Object.values(widgets)) {
        store.put(widget);
      }
    } catch {
      resolve();
    }
  });
}

async function getWidgetsIdb(): Promise<Record<string, Widget> | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const out: Record<string, Widget> = {};
        for (const value of req.result as unknown[]) {
          if (!isWidget(value) || isForbiddenKey(value.id)) continue;
          out[value.id] = value;
        }
        resolve(out);
      };
    } catch {
      resolve(null);
    }
  });
}

function parseFirstMarkdownTable(
  markdown: string
): { headers: string[]; rows: string[][]; markdown: string } | null {
  const lines = markdown.split(/\r?\n/u);
  for (let i = 0; i < lines.length - 2; i += 1) {
    const header = lines[i];
    const divider = lines[i + 1];
    if (
      !header.includes('|') ||
      !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(divider)
    ) {
      continue;
    }
    const rows: string[] = [header, divider];
    let cursor = i + 2;
    while (cursor < lines.length && lines[cursor].includes('|') && lines[cursor].trim() !== '') {
      rows.push(lines[cursor]);
      cursor += 1;
    }
    if (rows.length < 4) continue;
    const headers = splitMarkdownRow(header);
    const body = rows.slice(2).map(splitMarkdownRow);
    return { headers, rows: body, markdown: rows.join('\n') };
  }
  return null;
}

function splitMarkdownRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/u, '')
    .replace(/\|$/u, '')
    .split('|')
    .map((cell) => cell.trim());
}

function eventText(ev: ChatEvent, current: string): string {
  if (ev.type !== 'content_delta') return current;
  // Responses API chunks are true deltas; the legacy gateway historically
  // sent full content. Handle both so widget refresh does not duplicate text.
  if (ev.delta.startsWith(current)) return ev.delta;
  return current + ev.delta;
}

export class WidgetsStore {
  byId = $state<Record<string, Widget>>({});
  pinnedToDashboard = $derived<Widget[]>(
    Object.values(this.byId).filter((w) => w.pinned_to.includes('dashboard'))
  );

  constructor() {
    if (typeof window !== 'undefined') {
      this.hydrate();
      void this.hydrateIdb();
    }
  }

  promote(block: PromotableBlock, threadId?: string, messageId?: string): Widget {
    const id = `wgt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const widget: Widget = {
      id,
      kind: block.kind,
      title: block.title ?? this.deriveTitle(block),
      source: {
        thread_id: threadId ?? block.source.thread_id,
        message_id: messageId ?? block.source.message_id,
        query: block.source.query
      },
      payload: block.payload,
      pinned_to: [],
      created_at: now,
      updated_at: now
    };
    this.byId[id] = widget;
    this.persist();
    return widget;
  }

  pin(widgetId: string, target: string): void {
    const w = this.byId[widgetId];
    if (!w) return;
    if (!w.pinned_to.includes(target)) {
      w.pinned_to = [...w.pinned_to, target];
      w.updated_at = new Date().toISOString();
    }
    this.persist();
  }

  unpin(widgetId: string, target: string): void {
    const w = this.byId[widgetId];
    if (!w) return;
    w.pinned_to = w.pinned_to.filter((p) => p !== target);
    w.updated_at = new Date().toISOString();
    this.persist();
  }

  remove(widgetId: string): void {
    delete this.byId[widgetId];
    this.persist();
  }

  async refresh(widgetId: string): Promise<void> {
    const w = this.byId[widgetId];
    if (!w) return;
    if (w.kind !== 'text' && w.kind !== 'table') return;

    const client = connection.client;
    const query = w.source.query;
    if (!client || !query) return;

    const controller = new AbortController();
    let response = '';
    try {
      for await (const ev of client.streamResponse(
        query,
        w.source.thread_id ?? null,
        controller.signal
      )) {
        if (ev.type === 'error') throw new Error(ev.message);
        response = eventText(ev, response);
      }
    } finally {
      controller.abort();
    }

    const trimmed = response.trim();
    if (!trimmed) return;
    w.payload = w.kind === 'table' ? (parseFirstMarkdownTable(trimmed) ?? trimmed) : trimmed;
    w.updated_at = new Date().toISOString();
    this.persist();
  }

  private deriveTitle(block: PromotableBlock): string {
    return block.title?.slice(0, 60) ?? `${block.kind} widget`;
  }

  private persist(): void {
    if (storageAvailable()) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.byId));
      } catch {
        // quota exhausted; skip.
      }
    }
    void putWidgetsIdb(this.byId);
  }

  private hydrate(): void {
    if (!storageAvailable()) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      this.byId = coerceWidgets(JSON.parse(raw) as unknown);
    } catch {
      // corrupt storage; ignore.
    }
  }

  private async hydrateIdb(): Promise<void> {
    const loaded = await getWidgetsIdb();
    if (!loaded || Object.keys(loaded).length === 0) return;
    this.byId = { ...this.byId, ...loaded };
  }
}

export const widgets = new WidgetsStore();
