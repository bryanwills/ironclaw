<script lang="ts" module>
  // PromptDiff.svelte — full-route diff overlay used by SystemPromptEditor.
  //
  // Renders a line-by-line diff between two prompt snapshots (the "old"
  // and "new" texts that the caller hands in). Two view modes:
  //
  //   - Side-by-side: two columns, old on the left, new on the right. Each
  //     unchanged line aligns horizontally with its counterpart; removed
  //     lines show on the left only with a blank cell on the right (and
  //     vice versa) so the eye can scan across the gutter and immediately
  //     see what changed without re-reading both sides.
  //   - Unified: a single GitHub-style column with `-` / `+` / ` ` sigils.
  //
  // The diff is computed via a longest-common-subsequence DP — the same
  // approach the parent editor uses for its inline diff, kept local here
  // so this component is self-contained and doesn't import editor
  // internals.
  //
  // The "Restore" footer button doesn't talk to the server; it hands the
  // old text back through `onrestore`, the editor pulls it into its draft
  // state, marks dirty, and closes the diff. The user still has to click
  // Save in the editor to persist — that's deliberate so an accidental
  // restore is undoable via Discard.

  export type DiffMode = 'side' | 'unified';

  export type DiffChunk = {
    kind: 'same' | 'add' | 'del';
    oldLine?: number;
    newLine?: number;
    text: string;
  };

  // Standard LCS line diff. Worst case is m*n cells of Uint16 storage —
  // for a 64 KB SYSTEM.md (a few thousand lines tops) that's well under
  // a megabyte, so we don't bother with the Myers refinement.
  export function computeDiff(oldText: string, newText: string): DiffChunk[] {
    const a = oldText.split('\n');
    const b = newText.split('\n');
    const m = a.length;
    const n = b.length;

    const dp: Uint16Array[] = new Array(m + 1);
    for (let i = 0; i <= m; i++) dp[i] = new Uint16Array(n + 1);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (a[i] === b[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    const out: DiffChunk[] = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) {
        out.push({ kind: 'same', oldLine: i + 1, newLine: j + 1, text: a[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ kind: 'del', oldLine: i + 1, text: a[i] });
        i++;
      } else {
        out.push({ kind: 'add', newLine: j + 1, text: b[j] });
        j++;
      }
    }
    while (i < m) out.push({ kind: 'del', oldLine: i + 1, text: a[i++] });
    while (j < n) out.push({ kind: 'add', newLine: j + 1, text: b[j++] });
    return out;
  }

  // Pair adjacent del/add runs into aligned rows for side-by-side view.
  // The visual contract: every row has either an old cell, a new cell, or
  // both. A pure delete shows blank on the right; a pure add shows blank
  // on the left; an unchanged line shows the same text on both sides.
  // Pairing within a contiguous del/add block keeps the columns from
  // drifting out of sync — a 3-del-then-2-add run becomes 2 paired rows
  // (each with a del and an add) plus 1 lone del row.
  export type SideRow = {
    left?: { text: string; line: number };
    right?: { text: string; line: number };
    kind: 'same' | 'changed' | 'del' | 'add';
  };

  export function pairForSideBySide(chunks: DiffChunk[]): SideRow[] {
    const rows: SideRow[] = [];
    let i = 0;
    while (i < chunks.length) {
      const c = chunks[i];
      if (c.kind === 'same') {
        rows.push({
          kind: 'same',
          left: { text: c.text, line: c.oldLine ?? 0 },
          right: { text: c.text, line: c.newLine ?? 0 }
        });
        i++;
        continue;
      }
      // Collect the contiguous non-same run, then zip dels with adds.
      const dels: DiffChunk[] = [];
      const adds: DiffChunk[] = [];
      while (i < chunks.length && chunks[i].kind !== 'same') {
        if (chunks[i].kind === 'del') dels.push(chunks[i]);
        else adds.push(chunks[i]);
        i++;
      }
      const paired = Math.min(dels.length, adds.length);
      for (let k = 0; k < paired; k++) {
        rows.push({
          kind: 'changed',
          left: { text: dels[k].text, line: dels[k].oldLine ?? 0 },
          right: { text: adds[k].text, line: adds[k].newLine ?? 0 }
        });
      }
      for (let k = paired; k < dels.length; k++) {
        rows.push({
          kind: 'del',
          left: { text: dels[k].text, line: dels[k].oldLine ?? 0 }
        });
      }
      for (let k = paired; k < adds.length; k++) {
        rows.push({
          kind: 'add',
          right: { text: adds[k].text, line: adds[k].newLine ?? 0 }
        });
      }
    }
    return rows;
  }
</script>

<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';

  type Props = {
    oldText: string;
    newText: string;
    oldLabel: string;
    newLabel: string;
    onclose: () => void;
    onrestore?: (oldText: string) => void;
  };

  const { oldText, newText, oldLabel, newLabel, onclose, onrestore }: Props = $props();

  let mode = $state<DiffMode>('side');

  const chunks = $derived(computeDiff(oldText, newText));
  const sideRows = $derived(pairForSideBySide(chunks));

  // Summary counts shown in the header so the operator can tell at a
  // glance whether the diff is large or trivial without scrolling.
  const stats = $derived.by(() => {
    let added = 0;
    let removed = 0;
    for (const c of chunks) {
      if (c.kind === 'add') added++;
      else if (c.kind === 'del') removed++;
    }
    return { added, removed };
  });

  const noChange = $derived(stats.added === 0 && stats.removed === 0);

  // Keyboard: Esc closes. Trapped on the outer container so the parent
  // route's shortcuts (if any) don't fire while the modal is open.
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
    }
  }

  function handleRestore() {
    if (!onrestore) return;
    onrestore(oldText);
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Backdrop. Click-out dismiss is intentionally NOT wired so the operator
     can't lose a long diff scroll by mis-clicking the dim area. -->
<div
  class="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 backdrop-blur-sm p-4 sm:p-6"
  role="dialog"
  aria-modal="true"
  aria-label="Prompt diff viewer"
>
  <div
    class="flex flex-col w-full max-w-7xl bg-bg-surface border border-border-subtle rounded-lg shadow-2xl overflow-hidden"
  >
    <!-- Header: from → to labels, mode toggle, close. -->
    <div class="flex items-center gap-3 px-5 py-3 border-b border-border-subtle bg-bg-deep">
      <div class="flex items-center gap-2 min-w-0 flex-1">
        <span
          class="text-xs font-mono px-2 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/30 truncate"
          title={oldLabel}
        >
          {oldLabel}
        </span>
        <span class="text-text-muted text-xs shrink-0">→</span>
        <span
          class="text-xs font-mono px-2 py-0.5 rounded bg-green-500/15 text-green-300 border border-green-500/30 truncate"
          title={newLabel}
        >
          {newLabel}
        </span>
        <span class="text-[11px] text-text-muted ml-2 font-mono shrink-0">
          <span class="text-green-400">+{stats.added}</span>
          <span class="opacity-50 mx-1">/</span>
          <span class="text-red-400">−{stats.removed}</span>
        </span>
      </div>

      <!-- Side / Unified toggle. Segmented control so both options stay
           visible and the active one reads as pressed. -->
      <div class="inline-flex rounded-md border border-border-subtle overflow-hidden shrink-0">
        <button
          type="button"
          onclick={() => (mode = 'side')}
          class="px-3 py-1 text-xs transition"
          class:bg-accent-cyan={mode === 'side'}
          class:text-bg-deep={mode === 'side'}
          class:text-text-muted={mode !== 'side'}
          class:hover:text-text-primary={mode !== 'side'}
          aria-pressed={mode === 'side'}
        >
          Side-by-side
        </button>
        <button
          type="button"
          onclick={() => (mode = 'unified')}
          class="px-3 py-1 text-xs transition border-l border-border-subtle"
          class:bg-accent-cyan={mode === 'unified'}
          class:text-bg-deep={mode === 'unified'}
          class:text-text-muted={mode !== 'unified'}
          class:hover:text-text-primary={mode !== 'unified'}
          aria-pressed={mode === 'unified'}
        >
          Unified
        </button>
      </div>

      <button
        type="button"
        onclick={onclose}
        class="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-surface transition shrink-0"
        aria-label="Close diff"
        title="Close (Esc)"
      >
        <Icon name="close" class="w-4 h-4" />
      </button>
    </div>

    <!-- Body: the diff itself. Scrolls inside the modal so the header
         and footer stay pinned. -->
    <div class="flex-1 min-h-0 overflow-auto bg-bg-deep font-mono text-xs">
      {#if noChange}
        <div class="p-8 text-center text-text-muted italic">The two versions are identical</div>
      {:else if mode === 'side'}
        <!-- Side-by-side: CSS grid with two equal columns. Each row is a
             paired left/right pair from `sideRows`. Background tint is
             applied per cell (not per row) so a "changed" pair shows red
             on the left and green on the right at the same height. -->
        <div class="min-w-fit">
          {#each sideRows as row, i (i)}
            {@const leftCls =
              row.kind === 'del' || row.kind === 'changed'
                ? 'bg-red-500/10 text-red-200'
                : row.kind === 'add'
                  ? 'bg-bg-base/40 text-text-muted/40'
                  : 'text-text-primary'}
            {@const rightCls =
              row.kind === 'add' || row.kind === 'changed'
                ? 'bg-green-500/10 text-green-200'
                : row.kind === 'del'
                  ? 'bg-bg-base/40 text-text-muted/40'
                  : 'text-text-primary'}
            <div class="grid grid-cols-[3rem_1fr_3rem_1fr] hover:bg-bg-surface/40">
              <!-- Old gutter / content -->
              <div
                class="px-2 py-0.5 text-text-muted/60 text-right select-none border-r border-border-subtle/30 {leftCls
                  .replace('text-red-200', '')
                  .replace('text-text-primary', '')
                  .replace('text-text-muted/40', '')}"
              >
                {row.left?.line ?? ''}
              </div>
              <div
                class="px-3 py-0.5 whitespace-pre-wrap break-words border-r border-border-subtle/30 {leftCls}"
              >
                {row.left ? row.left.text || ' ' : ''}
              </div>
              <!-- New gutter / content -->
              <div
                class="px-2 py-0.5 text-text-muted/60 text-right select-none border-r border-border-subtle/30 {rightCls
                  .replace('text-green-200', '')
                  .replace('text-text-primary', '')
                  .replace('text-text-muted/40', '')}"
              >
                {row.right?.line ?? ''}
              </div>
              <div class="px-3 py-0.5 whitespace-pre-wrap break-words {rightCls}">
                {row.right ? row.right.text || ' ' : ''}
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <!-- Unified: single column, GitHub-style. Sigil + content. -->
        <div class="min-w-fit">
          {#each chunks as c, i (i)}
            {@const sigil = c.kind === 'add' ? '+' : c.kind === 'del' ? '-' : ' '}
            {@const cls =
              c.kind === 'add'
                ? 'bg-green-500/10 text-green-200 border-l-2 border-green-500/60'
                : c.kind === 'del'
                  ? 'bg-red-500/10 text-red-200 border-l-2 border-red-500/60'
                  : 'text-text-primary border-l-2 border-transparent'}
            <div class="grid grid-cols-[3rem_3rem_1.5rem_1fr] hover:bg-bg-surface/40 {cls}">
              <div class="px-2 py-0.5 text-text-muted/60 text-right select-none">
                {c.oldLine ?? ''}
              </div>
              <div
                class="px-2 py-0.5 text-text-muted/60 text-right select-none border-r border-border-subtle/30"
              >
                {c.newLine ?? ''}
              </div>
              <div class="px-1 py-0.5 text-center select-none opacity-70">
                {sigil}
              </div>
              <div class="px-2 py-0.5 whitespace-pre-wrap break-words">
                {c.text || ' '}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Footer: restore + close. Restore is primary cyan because it's the
         load-bearing action of the modal; Close is the neutral secondary. -->
    <div class="flex items-center gap-3 px-5 py-3 border-t border-border-subtle bg-bg-deep">
      <span class="text-[11px] text-text-muted">
        Esc to close. Restore loads the
        <span class="text-red-300">{oldLabel}</span>
        snapshot into the editor — it won't save until you click Save.
      </span>
      <button
        type="button"
        onclick={onclose}
        class="ml-auto px-4 py-2 rounded-md border border-border-subtle text-sm text-text-primary hover:border-text-muted transition min-h-[36px]"
      >
        Close
      </button>
      {#if onrestore}
        <button
          type="button"
          onclick={handleRestore}
          class="px-4 py-2 rounded-md bg-accent-cyan text-bg-deep text-sm font-semibold hover:brightness-110 transition min-h-[36px]"
          title="Load this snapshot into the draft"
        >
          Restore this version
        </button>
      {/if}
    </div>
  </div>
</div>
