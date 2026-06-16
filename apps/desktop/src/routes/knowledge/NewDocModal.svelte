<script lang="ts" module>
  /**
   * Validate a memory doc path on the client before we even attempt a write.
   * Exported so the route can reuse the exact same rules elsewhere (e.g. for
   * preflighting the inline editor before saving). Returns null on success or
   * a short, user-facing message on failure.
   *
   * Rules:
   *   - non-empty after trim
   *   - no leading slash (paths are relative to the memory root)
   *   - no `..` segments (reject before the wire — gateway also rejects)
   *   - no empty segments (e.g. `foo//bar.md`)
   *   - length cap matches the prompt's 256-char budget
   */
  export function validateMemoryPath(rawPath: string): string | null {
    const path = rawPath.trim();
    if (!path) return 'Path is required.';
    if (path.length >= 256) return 'Path must be under 256 characters.';
    if (path.startsWith('/')) return 'Path must not start with "/".';
    const segments = path.split('/');
    for (const seg of segments) {
      if (seg === '') return 'Path must not contain empty segments (no "//").';
      if (seg === '..') return 'Path must not contain ".." segments.';
    }
    return null;
  }
</script>

<script lang="ts">
  // Compact create-doc modal for the knowledge surface.
  //
  // Owns its own input state (path/content), runs path validation on every
  // keystroke for inline feedback, and delegates the actual write to the
  // parent via `oncreate`. The parent decides what "success" means (toast,
  // tree refresh, selection), keeping the modal free of side effects.

  import { onMount } from 'svelte';
  import { confirmDialog } from '$lib/stores/confirm.svelte';

  interface Props {
    onclose: () => void;
    oncreate: (path: string, content: string) => Promise<void>;
  }

  let { onclose, oncreate }: Props = $props();

  let path = $state('');
  let content = $state('');
  let submitting = $state(false);
  /** True once user has interacted with the path field — suppresses error
   * flash on first render so the modal opens clean. */
  let pathTouched = $state(false);

  const pathError = $derived(pathTouched ? validateMemoryPath(path) : null);
  const canSubmit = $derived(
    !submitting && path.trim().length > 0 && validateMemoryPath(path) === null
  );

  let pathInputEl: HTMLInputElement | undefined = $state();

  onMount(() => {
    // Autofocus the path field so the user can start typing immediately.
    pathInputEl?.focus();
  });

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    submitting = true;
    try {
      // Parent handles toast + tree refresh + close; we just await so the
      // spinner stays visible until that work finishes.
      await oncreate(path.trim(), content);
    } finally {
      submitting = false;
    }
  }

  async function tryClose() {
    // If the textarea has been touched, confirm before discarding. We treat
    // path-only edits as cheap to lose; only the body warrants a confirm.
    if (content.length > 0) {
      const ok = await confirmDialog.ask({
        title: `Discard new document${path.trim() ? ` "${path.trim()}"` : ''}?`,
        body: 'Discards the text you typed here.',
        confirmLabel: 'Discard document',
        cancelLabel: 'Keep editing',
        tone: 'danger'
      });
      if (!ok) return;
    }
    onclose();
  }

  function handleKey(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      void tryClose();
    }
  }
</script>

<svelte:window onkeydown={handleKey} />

<!-- Backdrop: click closes (with same unsaved-confirm path as Esc). -->
<button
  type="button"
  aria-label="Close new-doc modal"
  onclick={() => void tryClose()}
  class="fixed inset-0 z-40 bg-black/50 cursor-default"
></button>

<!-- Modal shell -->
<div
  class="v2-modal-shell fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[min(92vw,460px)] flex flex-col overflow-hidden"
  role="dialog"
  aria-modal="true"
  aria-labelledby="new-doc-title"
>
  <header class="flex items-center justify-between gap-4 px-5 py-4 border-b border-border-subtle">
    <h2 id="new-doc-title" class="text-sm font-semibold text-text-primary">New document</h2>
    <button
      type="button"
      onclick={() => void tryClose()}
      aria-label="Close"
      class="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-surface transition"
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

  <form onsubmit={handleSubmit} class="flex flex-col gap-4 px-5 py-4">
    <div class="space-y-1.5">
      <label
        for="new-doc-path"
        class="block text-[11px] font-semibold uppercase tracking-wider text-text-muted"
      >
        Path
      </label>
      <input
        id="new-doc-path"
        type="text"
        bind:this={pathInputEl}
        value={path}
        oninput={(e) => {
          path = (e.currentTarget as HTMLInputElement).value;
          pathTouched = true;
        }}
        placeholder="my-folder/new-doc.md"
        autocomplete="off"
        spellcheck="false"
        class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors font-mono"
        class:border-red-500={pathError}
      />
      {#if pathError}
        <p class="text-[11px] text-red-400">{pathError}</p>
      {/if}
    </div>

    <div class="space-y-1.5">
      <label
        for="new-doc-body"
        class="block text-[11px] font-semibold uppercase tracking-wider text-text-muted"
      >
        Content
      </label>
      <textarea
        id="new-doc-body"
        rows="10"
        value={content}
        oninput={(e) => (content = (e.currentTarget as HTMLTextAreaElement).value)}
        placeholder="Write your content…"
        class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors font-mono resize-none"
      ></textarea>
    </div>

    <div
      class="pt-1 flex items-center justify-end gap-2 border-t border-border-subtle -mx-5 px-5 pt-3"
    >
      <button
        type="button"
        onclick={() => void tryClose()}
        class="px-3 py-1.5 rounded-md border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent-cyan transition text-xs"
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
          Creating…
        {:else}
          Create
        {/if}
      </button>
    </div>
  </form>
</div>
