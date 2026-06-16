<script lang="ts">
  // Debounced text input for memory search. Bubbles up the value via
  // onChange — the parent owns query state so it can clear it from the
  // results panel too.
  //
  // When the input is focused AND empty, a history dropdown surfaces
  // below it, listing the last N distinct queries (MRU first). Click → the
  // parent's `onSubmit` fires immediately so the search runs without a
  // debounce hop. Parent owns the history list and persistence so the
  // dropdown stays in sync with whatever the page records on commit.

  interface Props {
    value: string;
    onChange: (next: string) => void;
    /** Called when the user presses Enter — fires immediately, bypassing debounce. */
    onSubmit: (value: string) => void;
    /** When true, show the spinner glyph in the right edge. */
    pending?: boolean;
    /** Disable the input (e.g. when offline). */
    disabled?: boolean;
    /** Recent search queries, MRU first. Empty array = no dropdown. */
    history?: string[];
    /** Called when the user clicks "Clear" in the dropdown footer. */
    onClearHistory?: () => void;
  }

  let {
    value,
    onChange,
    onSubmit,
    pending = false,
    disabled = false,
    history = [],
    onClearHistory
  }: Props = $props();

  const DEBOUNCE_MS = 250;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Drives the history dropdown visibility. True while the input has focus.
  // The render condition also checks for empty input + non-empty history.
  let focused = $state(false);
  let inputEl = $state<HTMLInputElement | null>(null);
  let dropdownEl = $state<HTMLDivElement | null>(null);

  const dropdownOpen = $derived(focused && value.length === 0 && history.length > 0);

  function onInput(ev: Event) {
    const next = (ev.target as HTMLInputElement).value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      onChange(next);
      timer = null;
    }, DEBOUNCE_MS);
  }

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Enter') {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const v = (ev.currentTarget as HTMLInputElement).value;
      onSubmit(v);
    }
  }

  function onFocus() {
    focused = true;
  }

  // Click-outside handler scoped to the input + its dropdown. Lives on the
  // window so blur'ing through Tab still closes the menu without a focusout
  // race against the click target.
  function onDocPointerDown(ev: PointerEvent) {
    if (!focused) return;
    const target = ev.target as Node | null;
    if (!target) return;
    if (inputEl && inputEl.contains(target)) return;
    if (dropdownEl && dropdownEl.contains(target)) return;
    focused = false;
  }

  function applyHistoryQuery(q: string) {
    focused = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    onSubmit(q);
  }

  function clearAndClose() {
    if (onClearHistory) onClearHistory();
    focused = false;
  }

  $effect(() => {
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown);
    };
  });
</script>

<div class="relative">
  <span class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none">
    <svg
      viewBox="0 0 24 24"
      class="w-4 h-4"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  </span>
  <input
    bind:this={inputEl}
    type="text"
    {value}
    {disabled}
    oninput={onInput}
    onkeydown={onKeydown}
    onfocus={onFocus}
    placeholder="Search the knowledge base…"
    aria-label="Search the knowledge base"
    class="w-full bg-bg-deep border border-border-subtle rounded-md pl-10 pr-10 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-cyan transition-colors min-h-[44px] disabled:opacity-50 disabled:cursor-not-allowed"
  />
  {#if pending}
    <span class="absolute right-3 top-1/2 -translate-y-1/2 text-accent-cyan">
      <svg
        viewBox="0 0 24 24"
        class="w-4 h-4 animate-spin"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="12" cy="12" r="9" stroke-opacity="0.25" />
        <path d="M21 12a9 9 0 0 0-9-9" />
      </svg>
    </span>
  {/if}

  {#if dropdownOpen}
    <div
      bind:this={dropdownEl}
      class="absolute left-0 right-0 top-full mt-1 z-20 bg-bg-deep border border-border-subtle rounded-md shadow-lg overflow-hidden"
    >
      <div
        class="px-3 py-1.5 text-[10px] uppercase tracking-wide text-text-muted border-b border-border-subtle/60"
      >
        Recent searches
      </div>
      <ul class="max-h-56 overflow-auto">
        {#each history as q, i (q + i)}
          <li>
            <button
              type="button"
              onclick={() => applyHistoryQuery(q)}
              class="w-full text-left px-3 py-1.5 text-xs text-text-primary hover:bg-bg-surface hover:text-accent-cyan transition-colors truncate"
            >
              {q}
            </button>
          </li>
        {/each}
      </ul>
      {#if onClearHistory}
        <button
          type="button"
          onclick={clearAndClose}
          class="w-full text-left px-3 py-1.5 text-[10px] uppercase tracking-wide text-text-muted hover:text-red-400 border-t border-border-subtle/60 transition-colors"
        >
          Clear history
        </button>
      {/if}
    </div>
  {/if}
</div>
