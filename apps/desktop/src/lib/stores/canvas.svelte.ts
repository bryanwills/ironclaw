// Spatial-canvas state (R84 / lane W7).
//
// Backs the `/canvas` research surface: an infinite, pannable, zoomable
// workspace where notes / threads / widgets live as freely-positioned
// node cards connected by arrows. This store is the single source of
// truth for that surface — node geometry, edges, and the viewport
// transform (pan + zoom). The components are thin views over it.
//
// Coordinate model: node x/y/width/height are in CANVAS space (the
// pre-transform coordinate system of the inner world `<div>`). The
// viewport applies `translate(panX, panY) scale(zoom)` to that world,
// so screen pixels = canvasCoord * zoom + pan. Pointer-drag handlers in
// CanvasNode/CanvasViewport convert screen deltas back to canvas space
// by dividing by `zoom`; keeping the stored coords transform-free is
// what makes drag math survive arbitrary zoom levels (see the failure
// note in the task brief).
//
// Persistence: one localStorage blob under `ironclaw-canvas`, rewritten
// on every mutation. Hydration is defensive — an arbitrary JSON shape is
// coerced back into the typed model (unknown kinds, non-finite numbers,
// dangling edges, and prototype-pollution keys like `__proto__` are all
// dropped) so a stale or hand-edited file can never put the in-memory
// state into an invalid shape. Zoom is clamped to [MIN_ZOOM, MAX_ZOOM]
// on both `setZoom` and load.

const STORAGE_KEY = 'ironclaw-canvas';

/** Zoom bounds. A node stays legible at 0.25× and doesn't blow past the
 *  viewport at 3×; the same clamp is applied on load and on `setZoom`. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 3;

/** Default geometry for a freshly-added note. Width/height are in canvas
 *  space; the route nudges x/y so successive notes don't stack exactly. */
export const DEFAULT_NODE_WIDTH = 220;
export const DEFAULT_NODE_HEIGHT = 140;

export type CanvasNodeKind = 'note' | 'thread' | 'widget';

const NODE_KINDS: readonly CanvasNodeKind[] = ['note', 'thread', 'widget'] as const;

export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  title: string;
  body: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
}

interface PersistShape {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  panX: number;
  panY: number;
  zoom: number;
}

/** Monotonic id helper. `crypto.randomUUID` where available, else a
 *  timestamp+counter fallback (jsdom / older runtimes). Prefixed so node
 *  and edge ids never collide. */
let idCounter = 0;
function freshId(prefix: string): string {
  idCounter += 1;
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${idCounter.toString(36)}`;
  return `${prefix}_${rand}`;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/** Compose a sub-agent prompt from a node's title/body plus the user's
 *  question, so the "Ask this node" composer (R88) hands the background
 *  agent the node as context. With no title and no body it's just the
 *  question; otherwise the node text is quoted as context above it. */
export function buildNodePrompt(title: string, body: string, question: string): string {
  const t = title.trim();
  const b = body.trim();
  const q = question.trim();
  if (!t && !b) return q;
  const parts: string[] = [t ? `Context from canvas note "${t}":` : 'Context from canvas note:'];
  if (b) parts.push(b);
  parts.push('', `Question: ${q}`);
  return parts.join('\n');
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

/** Coerce one arbitrary object into a CanvasNode, or null if it can't be
 *  salvaged. Rejects prototype-pollution keys and non-finite geometry. */
function coerceNode(raw: unknown): CanvasNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = o.id;
  if (typeof id !== 'string' || !id) return null;
  if (id === '__proto__' || id === 'constructor' || id === 'prototype') return null;
  const kind = NODE_KINDS.includes(o.kind as CanvasNodeKind) ? (o.kind as CanvasNodeKind) : 'note';
  return {
    id,
    kind,
    title: typeof o.title === 'string' ? o.title : '',
    body: typeof o.body === 'string' ? o.body : '',
    x: isFiniteNumber(o.x) ? o.x : 0,
    y: isFiniteNumber(o.y) ? o.y : 0,
    width: isFiniteNumber(o.width) && o.width > 0 ? o.width : DEFAULT_NODE_WIDTH,
    height: isFiniteNumber(o.height) && o.height > 0 ? o.height : DEFAULT_NODE_HEIGHT
  };
}

/** Defensively shape an arbitrary blob into the persisted model. Drops
 *  malformed nodes, dangling/self/duplicate edges, and clamps zoom. */
function coerceLoaded(raw: unknown): PersistShape {
  const out: PersistShape = { nodes: [], edges: [], panX: 0, panY: 0, zoom: 1 };
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;

  const nodeArr = Array.isArray(obj.nodes) ? obj.nodes : [];
  const seenNodeIds = new Set<string>();
  for (const candidate of nodeArr) {
    const node = coerceNode(candidate);
    if (!node) continue;
    if (seenNodeIds.has(node.id)) continue;
    seenNodeIds.add(node.id);
    out.nodes.push(node);
  }

  const edgeArr = Array.isArray(obj.edges) ? obj.edges : [];
  const seenEdgeIds = new Set<string>();
  const seenPairs = new Set<string>();
  for (const candidate of edgeArr) {
    if (!candidate || typeof candidate !== 'object') continue;
    const e = candidate as Record<string, unknown>;
    const { id, from, to } = e;
    if (typeof id !== 'string' || !id) continue;
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    if (from === to) continue; // no self-loops
    if (!seenNodeIds.has(from) || !seenNodeIds.has(to)) continue; // dangling
    if (seenEdgeIds.has(id)) continue;
    const pair = `${from}->${to}`;
    if (seenPairs.has(pair)) continue; // dedup
    seenEdgeIds.add(id);
    seenPairs.add(pair);
    out.edges.push({ id, from, to });
  }

  if (isFiniteNumber(obj.panX)) out.panX = obj.panX;
  if (isFiniteNumber(obj.panY)) out.panY = obj.panY;
  out.zoom = clampZoom(isFiniteNumber(obj.zoom) ? obj.zoom : 1);
  return out;
}

class CanvasStore {
  /** Node cards, in render order. Mutations replace the array reference
   *  so Svelte 5 reactivity (and the arrow overlay) re-runs. */
  nodes = $state<CanvasNode[]>([]);
  /** Arrows between nodes. */
  edges = $state<CanvasEdge[]>([]);

  // Viewport transform — world is translated by (panX, panY) then scaled
  // by `zoom`. See coordinate-model note in the file header.
  panX = $state(0);
  panY = $state(0);
  zoom = $state(1);

  constructor() {
    if (isBrowser()) this.hydrate();
  }

  /** Push a fresh empty note at the given canvas coords. Returns the new
   *  node so the caller can immediately focus / select it. */
  addNote(x = 100, y = 100): CanvasNode {
    const node: CanvasNode = {
      id: freshId('node'),
      kind: 'note',
      title: 'Untitled note',
      body: '',
      x: isFiniteNumber(x) ? x : 100,
      y: isFiniteNumber(y) ? y : 100,
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT
    };
    this.nodes = [...this.nodes, node];
    this.persist();
    return node;
  }

  /** Patch a node by id. No-op if the id is unknown. Always replaces the
   *  array reference and the patched node object so reactivity fires. */
  updateNode(id: string, patch: Partial<CanvasNode>): void {
    let changed = false;
    const next = this.nodes.map((n) => {
      if (n.id !== id) return n;
      changed = true;
      // `id` is identity — never let a patch reassign it.
      const { id: _ignored, ...rest } = patch;
      return { ...n, ...rest };
    });
    if (!changed) return;
    this.nodes = next;
    this.persist();
  }

  /** Remove a node and every edge that touches it. */
  removeNode(id: string): void {
    const nextNodes = this.nodes.filter((n) => n.id !== id);
    if (nextNodes.length === this.nodes.length) return; // unknown id
    this.nodes = nextNodes;
    this.edges = this.edges.filter((e) => e.from !== id && e.to !== id);
    this.persist();
  }

  /** Connect two nodes with an arrow. Skips self-loops, unknown
   *  endpoints, and duplicate (same from→to) edges. */
  connect(from: string, to: string): void {
    if (!from || !to || from === to) return;
    const hasFrom = this.nodes.some((n) => n.id === from);
    const hasTo = this.nodes.some((n) => n.id === to);
    if (!hasFrom || !hasTo) return;
    const dup = this.edges.some((e) => e.from === from && e.to === to);
    if (dup) return;
    this.edges = [...this.edges, { id: freshId('edge'), from, to }];
    this.persist();
  }

  /** Drop an edge by id. */
  disconnect(edgeId: string): void {
    const next = this.edges.filter((e) => e.id !== edgeId);
    if (next.length === this.edges.length) return;
    this.edges = next;
    this.persist();
  }

  /** Set the viewport pan offset (screen pixels). */
  setPan(x: number, y: number): void {
    this.panX = isFiniteNumber(x) ? x : 0;
    this.panY = isFiniteNumber(y) ? y : 0;
    this.persist();
  }

  /** Set the zoom factor, clamped to [MIN_ZOOM, MAX_ZOOM]. */
  setZoom(z: number): void {
    this.zoom = clampZoom(z);
    this.persist();
  }

  /** Wipe all nodes + edges (viewport untouched). */
  clear(): void {
    this.nodes = [];
    this.edges = [];
    this.persist();
  }

  /** Hydrate from localStorage. Defensive parse — corrupt JSON or an
   *  invalid shape falls back to the empty default. */
  private hydrate(): void {
    if (!isBrowser()) return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = coerceLoaded(JSON.parse(raw) as unknown);
      this.nodes = parsed.nodes;
      this.edges = parsed.edges;
      this.panX = parsed.panX;
      this.panY = parsed.panY;
      this.zoom = parsed.zoom;
    } catch {
      // Corrupt JSON or unavailable storage — keep the empty defaults.
    }
  }

  /** Best-effort persist of the full surface. Quota / private-mode
   *  failures are non-fatal (state survives in memory). */
  private persist(): void {
    if (!isBrowser()) return;
    try {
      const payload: PersistShape = {
        nodes: this.nodes,
        edges: this.edges,
        panX: this.panX,
        panY: this.panY,
        zoom: this.zoom
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Storage full or disabled — non-fatal.
    }
  }
}

/** Global singleton — import this anywhere. */
export const canvas = new CanvasStore();
