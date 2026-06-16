<script lang="ts" module>
  /**
   * Allowed MIME types for drag-drop import. We keep this exported so the
   * route-level overlay can validate the drag *before* opening the modal —
   * matches the modal's own strictness so we don't surprise the user with
   * a modal that immediately rejects everything.
   *
   * Note that real-world drag-drops sometimes hand us an empty MIME for
   * `.md` files (the OS doesn't always know markdown). The route's filter
   * also accepts an empty MIME when the extension is `.md`, but inside the
   * modal we trust whatever the route handed us — the route already
   * normalized.
   */
  export const ALLOWED_MIME_TYPES = new Set(['text/markdown', 'text/plain', 'application/json']);

  /** Cap individual files. Matches the prompt's 1 MB ceiling. */
  export const MAX_FILE_SIZE = 1024 * 1024;
  /** Cap batch size. Matches the prompt's 20-file ceiling. */
  export const MAX_FILES_PER_BATCH = 20;

  /**
   * A staged file ready to be reviewed in the import modal. The route does
   * the FileReader work up front so the modal can render previews
   * synchronously and so JSON parse failures surface *before* the user
   * opens a multi-file review.
   */
  export interface StagedFile {
    /** Original filename, used to default the destination path. */
    name: string;
    /** Size in bytes. Shown in the preview row. */
    size: number;
    /** Final text content to write (JSON is pre-pretty-printed). */
    content: string;
  }
</script>

<script lang="ts">
  // Batch-import modal for the knowledge surface.
  //
  // Receives a list of pre-read `StagedFile`s from the route's drop
  // handler, lets the user edit each destination path, then writes them
  // one-by-one via `onimport`. Results bubble back up so the route can
  // refresh the tree and toast a summary.
  //
  // Path validation mirrors NewDocModal exactly — same rules, same
  // user-facing messages, so users see consistent feedback wherever they
  // create memory docs.
  //
  // Imports run sequentially (not in parallel) so the user can read the
  // progress toast and so a slow gateway doesn't get hammered with 20
  // concurrent writes. The prompt explicitly calls for "Importing N of M…"
  // semantics, which only make sense in a serial loop.
  //
  // The parent owns the toast lifecycle: it gets the per-file results
  // (`{ path, ok, error? }[]`) and decides what summary to show.

  import { onMount } from 'svelte';
  import { validateMemoryPath } from './NewDocModal.svelte';

  interface Props {
    files: StagedFile[];
    onclose: () => void;
    /**
     * Sequentially write each staged file. Resolves once every file has
     * been attempted. Per-file errors are reported via `onProgress`; the
     * promise itself only rejects if something catastrophic blows up
     * outside the per-file loop.
     */
    onimport: (
      items: Array<{ path: string; content: string }>,
      onProgress: (index: number, total: number, ok: boolean, error?: string) => void
    ) => Promise<void>;
  }

  let { files, onclose, onimport }: Props = $props();

  /**
   * Per-row editable state. Seeded once from `files` so editing a path
   * doesn't get clobbered if `files` ever updates mid-flight. The
   * route only ever swaps a fresh array (it never mutates), and the
   * modal is unmounted between batches, so one-shot capture is correct.
   */
  // svelte-ignore state_referenced_locally
  let rows = $state(
    files.map((f) => ({
      name: f.name,
      size: f.size,
      content: f.content,
      path: defaultPathFor(f.name),
      touched: false
    }))
  );

  let submitting = $state(false);
  /** Progress label shown on the submit button mid-import. */
  let progressLabel = $state<string | null>(null);

  /**
   * Derived list of validation errors, one slot per row. `null` when the
   * row's path is valid (or untouched — same suppress-on-first-render
   * pattern as NewDocModal so the modal opens clean).
   */
  const pathErrors = $derived(rows.map((r) => (r.touched ? validateMemoryPath(r.path) : null)));

  /**
   * True only when every row has a valid path AND no two rows share the
   * same destination. Duplicate paths would have the second write
   * silently overwrite the first, which is almost certainly not what the
   * user wants on a batch import — flag it loudly.
   */
  const dupePaths = $derived(findDuplicatePaths(rows.map((r) => r.path.trim())));
  const canSubmit = $derived(
    !submitting &&
      rows.length > 0 &&
      rows.every((r) => validateMemoryPath(r.path) === null) &&
      dupePaths.size === 0
  );

  /**
   * Refs for every path input, used so we can autofocus the first row on
   * mount. We can't conditionally `bind:this` to a single variable inside
   * an `{#each}` (Svelte 5 rejects conditional bind targets), so we
   * collect into an array and pluck index 0.
   */
  const pathInputRefs: Array<HTMLInputElement | undefined> = [];

  onMount(() => {
    // Autofocus the first path field so the user can start tabbing through
    // edits immediately.
    pathInputRefs[0]?.focus();
  });

  /**
   * Build the default destination path for a dropped file.
   *
   * Strategy: `imports/{filename}`. We pass the filename through
   * `sanitizeFilename` so spaces and OS-flavored quirks (`:` from older
   * macOS, leading dots, etc.) don't immediately fail the validator. The
   * user can still edit the result.
   */
  function defaultPathFor(rawName: string): string {
    return `imports/${sanitizeFilename(rawName)}`;
  }

  /**
   * Make a filename safe enough to survive `validateMemoryPath`:
   * - drop any directory prefix the browser smuggled in (some browsers
   *   include relative folder paths on directory drops)
   * - collapse whitespace, replace with single dashes
   * - drop characters that would create empty segments or look bogus
   *
   * We deliberately do NOT lowercase — case carries meaning.
   */
  function sanitizeFilename(raw: string): string {
    // Strip any directory prefix smuggled in via webkitRelativePath.
    const last = raw.split('/').pop() ?? raw;
    // Replace runs of whitespace with single dashes.
    let s = last.replace(/\s+/g, '-');
    // Drop characters the validator would otherwise reject; keeping a
    // small allow-list is simpler than blacklisting.
    s = s.replace(/[^A-Za-z0-9._\-]/g, '_');
    // Collapse consecutive dots so users don't accidentally form a `..`
    // segment. The validator would also catch this, but better to fix at
    // the seed stage.
    s = s.replace(/\.{2,}/g, '.');
    // Avoid an empty result if the user dropped a weirdly-named file.
    if (!s || s === '.') s = 'untitled';
    return s;
  }

  /** Return the set of paths that appear more than once in the batch. */
  function findDuplicatePaths(paths: string[]): Set<string> {
    const seen = new Map<string, number>();
    for (const p of paths) {
      if (!p) continue;
      seen.set(p, (seen.get(p) ?? 0) + 1);
    }
    const dupes = new Set<string>();
    for (const [p, n] of seen) {
      if (n > 1) dupes.add(p);
    }
    return dupes;
  }

  /** Render bytes as a compact label (B, KB). 1 KB threshold is plenty
   *  given the 1 MB per-file cap. */
  function formatSize(n: number): string {
    if (n < 1024) return `${n} B`;
    const kb = n / 1024;
    if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    return `${(kb / 1024).toFixed(1)} MB`;
  }

  /** First 100 chars of content, single-line, with trailing ellipsis. */
  function preview(content: string): string {
    const flat = content.replace(/\s+/g, ' ').trim();
    if (flat.length <= 100) return flat;
    return flat.slice(0, 100) + '…';
  }

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    submitting = true;
    progressLabel = `Importing 0 of ${rows.length}…`;
    try {
      const items = rows.map((r) => ({ path: r.path.trim(), content: r.content }));
      await onimport(items, (index, total, _ok, _error) => {
        // index is 1-based for display. The parent already toasts per-file
        // failures via the final summary; we just update the button label.
        progressLabel = `Importing ${index} of ${total}…`;
      });
      // Parent closes the modal on success — leave `submitting` true so
      // the user can't click twice during the close animation.
    } finally {
      submitting = false;
      progressLabel = null;
    }
  }

  function tryClose() {
    if (submitting) return; // mid-import; ignore close attempts
    onclose();
  }

  function handleKey(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      tryClose();
    }
  }
</script>

<svelte:window onkeydown={handleKey} />

<!-- Backdrop. While submitting we ignore clicks so a stray click can't
     blow away an in-flight import. -->
<button
  type="button"
  aria-label="Close import modal"
  onclick={tryClose}
  class="fixed inset-0 z-40 bg-black/50 cursor-default"
></button>

<!-- Modal shell. Wider than NewDocModal because the row list needs the
     horizontal real estate for path + preview side-by-side. Caps at
     720px so it doesn't dominate huge monitors. -->
<div
  class="v2-modal-shell fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[min(94vw,720px)] max-h-[min(90vh,720px)] flex flex-col overflow-hidden"
  role="dialog"
  aria-modal="true"
  aria-labelledby="import-doc-title"
>
  <header class="flex items-center justify-between gap-4 px-5 py-4 border-b border-border-subtle">
    <div>
      <h2 id="import-doc-title" class="text-sm font-semibold text-text-primary">
        Import {rows.length}
        {rows.length === 1 ? 'file' : 'files'}
      </h2>
      <p class="text-[11px] text-text-muted mt-0.5">
        Review destination paths, then import. Defaults to <code class="font-mono"
          >imports/&lcub;name&rcub;</code
        >.
      </p>
    </div>
    <button
      type="button"
      onclick={tryClose}
      aria-label="Close"
      disabled={submitting}
      class="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-surface transition disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <svg
        viewBox="0 0 24 24"
        class="w-3.5 h-3.5"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  </header>

  <form onsubmit={handleSubmit} class="flex flex-col min-h-0 flex-1">
    <!-- Scrollable list of staged files. -->
    <div class="flex-1 min-h-0 overflow-auto px-5 py-3 space-y-3">
      {#each rows as row, i (row.name + '#' + i)}
        {@const dupe = dupePaths.has(row.path.trim())}
        <div
          class="rounded-md border bg-bg-deep px-3 py-2.5"
          class:border-border-subtle={!pathErrors[i] && !dupe}
          class:border-red-500={pathErrors[i] || dupe}
        >
          <!-- Row header: original filename + size + content-type hint. -->
          <div class="flex items-baseline justify-between gap-3 mb-1.5">
            <div class="text-xs text-text-primary font-mono truncate" title={row.name}>
              {row.name}
            </div>
            <div class="text-[10px] text-text-muted tabular-nums shrink-0">
              {formatSize(row.size)}
            </div>
          </div>

          <!-- Editable destination path. -->
          <label class="block">
            <span class="sr-only">Destination path for {row.name}</span>
            <input
              type="text"
              value={row.path}
              bind:this={pathInputRefs[i]}
              oninput={(e) => {
                row.path = (e.currentTarget as HTMLInputElement).value;
                row.touched = true;
              }}
              autocomplete="off"
              spellcheck="false"
              disabled={submitting}
              class="w-full bg-bg-surface border border-border-subtle rounded-md px-2 py-1.5 text-xs text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors font-mono disabled:opacity-50"
              class:border-red-500={pathErrors[i] || dupe}
            />
          </label>
          {#if pathErrors[i]}
            <p class="mt-1 text-[11px] text-red-400">{pathErrors[i]}</p>
          {:else if dupe}
            <p class="mt-1 text-[11px] text-red-400">Duplicate path — another row uses it</p>
          {/if}

          <!-- First-100-char preview. Always shown so users can sanity-check
               that the right file landed in the right slot. -->
          <p class="mt-2 text-[11px] text-text-muted leading-snug break-words">
            {preview(row.content) || '(empty file)'}
          </p>
        </div>
      {/each}
    </div>

    <div class="px-5 py-3 flex items-center justify-end gap-2 border-t border-border-subtle">
      <button
        type="button"
        onclick={tryClose}
        disabled={submitting}
        class="px-3 py-1.5 rounded-md border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent-cyan transition text-xs disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={!canSubmit}
        class="inline-flex items-center gap-2 px-4 py-1.5 rounded-md bg-accent-cyan text-bg-deep text-xs font-semibold hover:brightness-95 transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {#if submitting}
          <svg
            viewBox="0 0 24 24"
            class="w-3 h-3 animate-spin"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <circle cx="12" cy="12" r="10" opacity="0.25" />
            <path d="M22 12a10 10 0 0 0-10-10" />
          </svg>
          {progressLabel ?? 'Importing…'}
        {:else}
          Import all
        {/if}
      </button>
    </div>
  </form>
</div>
