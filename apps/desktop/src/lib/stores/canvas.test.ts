// Tests for the spatial-canvas store (R84 / lane W7).
//
// The store is a runtime singleton with `$state` runes. Each test resets
// the in-memory shape via `canvas.clear()` + a fresh viewport, and clears
// the STORAGE_KEY blob so cases don't leak into one another.
//
// We exercise the public API only: addNote / updateNode / removeNode /
// connect / disconnect / setZoom / setPan / clear + the localStorage
// round-trip. The load-bearing cases are: removeNode dropping touching
// edges, connect's self-loop + dedup guards, and setZoom's clamp — those
// are the invariants the arrow overlay and viewport rely on.
//
// Vitest 4 ships an experimental localStorage missing the standard
// Storage methods in this jsdom path; we install a tiny Map-backed shim
// per file (test files only — vitest.setup.ts is off-limits). Shim copied
// from pins.test.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildNodePrompt, canvas, MAX_ZOOM, MIN_ZOOM } from './canvas.svelte';

const STORAGE_KEY = 'ironclaw-canvas';

function installLocalStorageShim() {
  const store = new Map<string, string>();
  const shim = {
    get length() {
      return store.size;
    },
    key(i: number) {
      return Array.from(store.keys())[i] ?? null;
    },
    getItem(k: string) {
      return store.has(k) ? (store.get(k) as string) : null;
    },
    setItem(k: string, v: string) {
      store.set(String(k), String(v));
    },
    removeItem(k: string) {
      store.delete(k);
    },
    clear() {
      store.clear();
    }
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: shim });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: shim });
  }
}

function resetCanvas() {
  canvas.clear();
  canvas.setPan(0, 0);
  canvas.setZoom(1);
}

describe('canvas store', () => {
  beforeEach(() => {
    installLocalStorageShim();
    resetCanvas();
  });

  afterEach(() => {
    resetCanvas();
  });

  it('addNote() appends a note and returns it', () => {
    const node = canvas.addNote(50, 60);
    expect(canvas.nodes).toHaveLength(1);
    expect(canvas.nodes[0].id).toBe(node.id);
    expect(node.kind).toBe('note');
    expect(node.x).toBe(50);
    expect(node.y).toBe(60);
  });

  it('updateNode() moves a node by patching x/y', () => {
    const node = canvas.addNote(0, 0);
    canvas.updateNode(node.id, { x: 300, y: 200 });
    const moved = canvas.nodes.find((n) => n.id === node.id);
    expect(moved?.x).toBe(300);
    expect(moved?.y).toBe(200);
  });

  it('updateNode() never lets a patch reassign the id', () => {
    const node = canvas.addNote(0, 0);
    // Cast through unknown to smuggle an `id` into the patch and confirm
    // it's stripped (identity is never reassignable via updateNode).
    canvas.updateNode(node.id, { id: 'hijacked', title: 'renamed' } as Partial<typeof node>);
    expect(canvas.nodes[0].id).toBe(node.id);
    expect(canvas.nodes[0].title).toBe('renamed');
  });

  it('removeNode() drops the node and every edge that touches it', () => {
    const a = canvas.addNote(0, 0);
    const b = canvas.addNote(100, 0);
    const c = canvas.addNote(200, 0);
    canvas.connect(a.id, b.id);
    canvas.connect(b.id, c.id);
    expect(canvas.edges).toHaveLength(2);

    canvas.removeNode(b.id);
    expect(canvas.nodes.find((n) => n.id === b.id)).toBeUndefined();
    // Both edges touched b → both gone.
    expect(canvas.edges).toHaveLength(0);
  });

  it('connect() adds an edge, dedups, and rejects self-loops', () => {
    const a = canvas.addNote(0, 0);
    const b = canvas.addNote(100, 0);

    canvas.connect(a.id, b.id);
    expect(canvas.edges).toHaveLength(1);

    // Duplicate (same from→to) is a no-op.
    canvas.connect(a.id, b.id);
    expect(canvas.edges).toHaveLength(1);

    // Self-loop is rejected.
    canvas.connect(a.id, a.id);
    expect(canvas.edges).toHaveLength(1);

    // Unknown endpoint is rejected.
    canvas.connect(a.id, 'does-not-exist');
    expect(canvas.edges).toHaveLength(1);
  });

  it('disconnect() removes an edge by id', () => {
    const a = canvas.addNote(0, 0);
    const b = canvas.addNote(100, 0);
    canvas.connect(a.id, b.id);
    const edgeId = canvas.edges[0].id;

    canvas.disconnect(edgeId);
    expect(canvas.edges).toHaveLength(0);

    // Disconnecting an unknown id is a no-op.
    canvas.disconnect('nope');
    expect(canvas.edges).toHaveLength(0);
  });

  it('setZoom() clamps to [MIN_ZOOM, MAX_ZOOM]', () => {
    canvas.setZoom(10);
    expect(canvas.zoom).toBe(MAX_ZOOM);

    canvas.setZoom(0.01);
    expect(canvas.zoom).toBe(MIN_ZOOM);

    canvas.setZoom(1.5);
    expect(canvas.zoom).toBe(1.5);

    // Non-finite falls back to 1.
    canvas.setZoom(Number.NaN);
    expect(canvas.zoom).toBe(1);
  });

  it('setPan() stores the offset', () => {
    canvas.setPan(120, -40);
    expect(canvas.panX).toBe(120);
    expect(canvas.panY).toBe(-40);
  });

  it('clear() wipes nodes and edges but leaves the viewport', () => {
    const a = canvas.addNote(0, 0);
    const b = canvas.addNote(100, 0);
    canvas.connect(a.id, b.id);
    canvas.setPan(50, 50);
    canvas.setZoom(2);

    canvas.clear();
    expect(canvas.nodes).toHaveLength(0);
    expect(canvas.edges).toHaveLength(0);
    // Viewport untouched.
    expect(canvas.panX).toBe(50);
    expect(canvas.panY).toBe(50);
    expect(canvas.zoom).toBe(2);
  });

  it('persists mutations to localStorage and round-trips the shape', () => {
    const a = canvas.addNote(10, 20);
    const b = canvas.addNote(110, 20);
    canvas.connect(a.id, b.id);
    canvas.setPan(25, 75);
    canvas.setZoom(1.75);

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as {
      nodes: unknown[];
      edges: unknown[];
      panX: number;
      panY: number;
      zoom: number;
    };
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.edges).toHaveLength(1);
    expect(parsed.panX).toBe(25);
    expect(parsed.panY).toBe(75);
    expect(parsed.zoom).toBe(1.75);
  });
});

describe('buildNodePrompt (R88 — Ask this node)', () => {
  it('returns the bare question when the node has no title or body', () => {
    expect(buildNodePrompt('', '', 'what is X?')).toBe('what is X?');
    expect(buildNodePrompt('   ', '  ', '  what is X?  ')).toBe('what is X?');
  });

  it('quotes the title as context above the question', () => {
    const out = buildNodePrompt('Roadmap', '', 'next step?');
    expect(out).toContain('Context from canvas note "Roadmap":');
    expect(out).toContain('Question: next step?');
  });

  it('includes the body when present', () => {
    const out = buildNodePrompt('Ideas', 'ship the canvas', 'how?');
    expect(out).toContain('Context from canvas note "Ideas":');
    expect(out).toContain('ship the canvas');
    expect(out.indexOf('ship the canvas')).toBeLessThan(out.indexOf('Question: how?'));
  });

  it('uses a generic context header when only the body is set', () => {
    const out = buildNodePrompt('', 'just some body text', 'summarize');
    expect(out).toContain('Context from canvas note:');
    expect(out).toContain('just some body text');
    expect(out).toContain('Question: summarize');
  });
});
