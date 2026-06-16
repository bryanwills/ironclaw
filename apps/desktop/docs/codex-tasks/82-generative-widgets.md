# R82 — Generative widget framework

**Lane**: W5 (codex)
**Branch**: `codex/r82-generative-widgets`
**Depends on**: A3 (Mermaid/Plotly/KaTeX renderers, R53) — MUST be
merged before this lane starts.

## Context

Structured outputs (tables, charts, comparisons, Mermaid diagrams,
LaTeX, JSON specs) should be first-class artifacts, not throwaway
chat content. A user looking at a "TEE hardware comparison" table
should be able to:

- Pin it to their dashboard (it auto-refreshes when the underlying
  query is re-run).
- Drag it onto the spatial canvas (R84).
- Share it (export as PNG/SVG).
- Refresh it (re-run the query that produced it).

This task ships the **widget framework**: a base `Widget` component
with the chrome (title + refresh + pin + share + ⋯), N subclasses for
each renderer type, and a store that tracks which widgets are pinned
where.

R83 (Council v2, claude) and R77 (Dashboard, claude) consume this
framework. The MarkdownView gains a "Promote to widget" hook on
detected structured blocks.

## Owned files

- `src/lib/components/widgets/` — NEW directory.
  - `Widget.svelte` — base component with chrome.
  - `ChartWidget.svelte` — Plotly subclass.
  - `TableWidget.svelte` — markdown table subclass.
  - `TextWidget.svelte` — markdown text subclass (for briefings,
    summaries).
  - `MermaidWidget.svelte` — Mermaid subclass.
  - `ComparisonWidget.svelte` — side-by-side comparison subclass.
- `src/lib/stores/widgets.svelte.ts` — NEW.
- `src/lib/stores/widgets.test.ts` — NEW.
- `src/lib/components/MarkdownView.svelte` — append a single hook
  (`onPromote?: (block: PromotableBlock) => void` prop). Render a
  small "Promote to widget" affordance over each detected promotable
  block. **Do not modify the existing render paths.**

## Forbidden

- Other routes.
- Other components.
- Other stores.
- Rust.

## Coordination with A3

A3 owns `MarkdownView.svelte` for the renderer additions. W5 only
APPENDS the promote-hook prop + the small affordance overlay. If A3
hasn't merged when this PR opens, BLOCK and wait. (No merge race on
this file is allowed.)

## Widget shape

```ts
export type WidgetKind = 'chart' | 'table' | 'text' | 'mermaid' | 'comparison';

export interface Widget {
  id: string;                 // uuid-ish, generated at pin time
  kind: WidgetKind;
  title: string;
  source: {
    thread_id?: string;
    message_id?: string;
    query?: string;           // for refresh
  };
  payload: unknown;           // kind-specific
  pinned_to: ('dashboard' | 'canvas' | string)[];
  created_at: string;
  updated_at: string;
}

export interface PromotableBlock {
  kind: WidgetKind;
  title?: string;             // inferred from heading above the block
  payload: unknown;
  // The source location so the widget can re-run the query later.
  source: { thread_id?: string; message_id?: string; query?: string };
}
```

## Detection

In `MarkdownView`, while walking the AST, detect:

- Fenced code block, info string `mermaid` → `{kind: 'mermaid'}`.
- Fenced code block, info string `plotly` → `{kind: 'chart'}`.
- Heading immediately followed by a markdown table (≥2 rows) →
  `{kind: 'table'}` if the table has ≥3 columns, `{kind: 'comparison'}`
  if exactly 2 data columns (likely a side-by-side comparison).
- KaTeX block (`$$...$$`) → no widget (math stays inline).
- Heading immediately followed by ≥3 paragraphs → `{kind: 'text'}` if
  the heading text matches `/brief|summary|news/i`.

Skipped: code blocks (any language other than mermaid/plotly), images
(those are already first-class with the lightbox).

Heuristic precedence: explicit code-block fences win over inferred
heading-driven detection.

## Promote affordance

Floating ⋮ button at the top-right corner of each promotable block,
appears on hover only. Click → emits the `PromotableBlock` to the
`onPromote` callback. The caller (chat surface) wires this to
`widgets.promote(block, threadId, messageId)`.

CSS: position absolute, top 4 right 4, opacity 0 by default, group
hover reveals (matches existing kebab patterns elsewhere). Background
`bg-bg-deep/80 backdrop-blur-sm`.

## Store spec

```ts
// Pinned widgets. Backed by IDB (via R62) when available, falls
// through to localStorage for older builds.
//
// Promoting a block from MarkdownView creates a widget; pinning
// attaches it to a surface ("dashboard", "canvas", or a free-form
// workspace id). Refreshing re-runs the source query and replaces
// the payload.

import type { IronClawClient } from '$lib/api/ironclaw';
import type { PromotableBlock, Widget } from '$lib/api/types';
import { connection } from './connection.svelte';

const STORAGE_KEY = 'ironclaw-widgets';

class WidgetsStore {
  byId = $state<Record<string, Widget>>({});
  pinnedToDashboard = $derived<Widget[]>(
    Object.values(this.byId).filter((w) => w.pinned_to.includes('dashboard'))
  );

  constructor() {
    if (typeof window !== 'undefined') {
      this.hydrate();
    }
  }

  promote(block: PromotableBlock, threadId?: string, messageId?: string): Widget {
    const id = `wgt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this.byId[id] = widget;
    this.persist();
    return widget;
  }

  pin(widgetId: string, target: string): void {
    const w = this.byId[widgetId];
    if (!w) return;
    if (!w.pinned_to.includes(target)) w.pinned_to = [...w.pinned_to, target];
    this.persist();
  }

  unpin(widgetId: string, target: string): void {
    const w = this.byId[widgetId];
    if (!w) return;
    w.pinned_to = w.pinned_to.filter((p) => p !== target);
    this.persist();
  }

  remove(widgetId: string): void {
    delete this.byId[widgetId];
    this.persist();
  }

  async refresh(widgetId: string): Promise<void> {
    const w = this.byId[widgetId];
    if (!w) return;
    const client = connection.client;
    if (!client) return;
    const query = w.source.query;
    if (!query) return; // can't refresh without a source query
    // Fire the query as a one-shot send and replace the payload from
    // the response. Implementation depends on widget kind — start
    // with text + table (re-run as chat message, parse response).
    // Charts + Mermaid require re-extracting from the response —
    // ship that in a follow-up.
    // For v1, only `text` and `table` widgets are refreshable.
    if (w.kind !== 'text' && w.kind !== 'table') return;
    // ... (codex: implement the one-shot send + reparse, or open a
    // follow-up issue for full refresh support).
  }

  private deriveTitle(block: PromotableBlock): string {
    return block.title?.slice(0, 60) ?? `${block.kind} widget`;
  }

  private persist(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.byId));
    } catch {
      // quota exhausted; skip.
    }
  }

  private hydrate(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        // Defensive filter against prototype pollution.
        for (const [k, v] of Object.entries(parsed)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          if (v && typeof v === 'object' && 'id' in v) {
            this.byId[k] = v as Widget;
          }
        }
      }
    } catch {
      // corrupt storage; ignore.
    }
  }
}

export const widgets = new WidgetsStore();
```

## Widget chrome — `Widget.svelte`

```svelte
<script lang="ts">
  import type { Widget } from '$lib/api/types';
  import Icon from '$lib/components/Icon.svelte';
  import { widgets } from '$lib/stores/widgets.svelte';

  interface Props {
    widget: Widget;
    surface: 'dashboard' | 'canvas' | 'chat';
  }
  let { widget, surface }: Props = $props();
</script>

<div class="rounded-lg border surface bg-bg-deep p-3 flex flex-col gap-2">
  <div class="flex items-center justify-between text-xs">
    <span class="font-semibold text-text-primary truncate">{widget.title}</span>
    <div class="flex items-center gap-1 text-text-muted">
      <button
        type="button"
        class="px-1 hover:text-accent-cyan transition-colors"
        title="Refresh"
        aria-label="Refresh widget"
        onclick={() => widgets.refresh(widget.id)}
      >
        <Icon name="refresh" class="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        class="px-1 hover:text-accent-cyan transition-colors"
        title={widget.pinned_to.includes(surface) ? 'Unpin' : 'Pin to dashboard'}
        aria-label="Pin widget"
        onclick={() =>
          widget.pinned_to.includes('dashboard')
            ? widgets.unpin(widget.id, 'dashboard')
            : widgets.pin(widget.id, 'dashboard')
        }
      >
        <Icon name="pin" class="w-3.5 h-3.5" />
      </button>
    </div>
  </div>
  <slot />
</div>
```

The N subclasses (`ChartWidget`, `TableWidget`, `TextWidget`,
`MermaidWidget`, `ComparisonWidget`) wrap `Widget` and slot in their
own renderer for the payload. Each one is ~30 lines.

## Acceptance

1. `npm run check` + `npm run test` → green. Cases:
   - `promote(block)` creates a widget with a uuid id.
   - `pin/unpin` toggles `pinned_to`.
   - Storage round-trips: write, restart, read.
   - Prototype-pollution filter rejects `__proto__` key.
2. `npm run build` → bundle: the new widgets directory is ≤25 KB
   gzipped (excluding renderer libs which are A3's lane).
3. Manual smoke:
   - Send a markdown table in chat. Hover. The ⋮ promote button
     appears.
   - Click → widget appears in `widgets.byId`.
   - Pin → it shows up on the dashboard route (R77, claude — coordinate
     timing).
   - Refresh on a text widget → re-runs the source query.

## Out of scope

- Widget editing (changing the title, modifying the payload).
- Sharing / export (PNG/SVG generation) — separate lane.
- Cross-window sync of widget state (defer to broadcast-channel layer).
- Widget refresh for chart/mermaid (only text/table supported in v1).
- Drag-to-rearrange on the dashboard (W8 owns that).

## Notes

- The promote affordance must NOT show in a printed/exported version
  of the conversation. Hide under `@media print`.
- Widget ids prefix with `wgt-` so debugging logs are clear.
- Keep the subclasses tiny — they're just renderer + chrome
  composition.
