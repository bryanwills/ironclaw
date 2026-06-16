<script lang="ts">
  // System-prompt editor.
  //
  // Loads the admin-scoped SYSTEM.md, lets the user edit it in a large
  // monospace textarea, and saves via setSystemPrompt(). Includes:
  //   - Dirty tracking (Save disabled until the draft differs from server).
  //   - Live character + word count, soft warning at 95% of the 64 KB cap,
  //     hard-disable + red helper when over the cap.
  //   - "Restore default" link (PUTs an empty string → server falls back).
  //   - Side-preview pane that flips between 50/50 columns at wide widths
  //     and stacked rows on narrow viewports. Scrolling is synced in the
  //     side-by-side layout (editor scroll position drives preview and
  //     vice versa) using a proportional fraction so the unequal content
  //     heights line up at the same percentage of read.
  //   - Save history (last 5 saves in localStorage `ironclaw-admin-prompt-history`)
  //     accessible from a History panel with restore + line-diff buttons.
  //
  // Wire detail: the gateway expects `{content}`, not `{prompt}` — the
  // client maps for us; this surface just talks the convenience name.

  import { onMount, tick } from 'svelte';
  import { connection } from '$lib/stores/connection.svelte';
  import { confirmDialog } from '$lib/stores/confirm.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import MarkdownView from '$lib/components/MarkdownView.svelte';
  import { redactSecrets } from '$lib/utils/redact';

  // Server hard-caps at 64 KB. We surface a soft warning at 95% so the
  // user notices well before the gateway returns a 413. The exact limit is
  // duplicated here (rather than imported) because the constraint lives
  // on the wire — there's no client config for it.
  const MAX_BYTES = 64 * 1024;
  const SOFT_WARN_BYTES = Math.floor(MAX_BYTES * 0.95);

  // Persistence for the save-history panel. Capped at 5 to keep the panel
  // scan-able and the localStorage payload tiny.
  const HISTORY_KEY = 'ironclaw-admin-prompt-history';
  const HISTORY_LIMIT = 5;

  type HistoryEntry = {
    timestamp: number;
    prompt: string;
    length: number;
  };

  type LoadState = 'idle' | 'loading' | 'loaded' | 'error';
  type SaveState = 'idle' | 'saving' | 'saved' | 'error';

  let loadState = $state<LoadState>('idle');
  let loadError = $state<string | null>(null);

  let saveState = $state<SaveState>('idle');
  let saveError = $state<string | null>(null);

  let serverPrompt = $state('');
  let draft = $state('');
  let showPreview = $state(false);
  let forbidden = $state(false);

  let history = $state<HistoryEntry[]>([]);
  let showHistory = $state(false);

  // When the user clicks "Diff" against a history entry the diff renders
  // inside the history panel. Null = panel shows the list. The entry value
  // is captured at click-time so a subsequent history list re-sort doesn't
  // confuse the comparison.
  let diffTarget = $state<HistoryEntry | null>(null);

  // DOM refs used for synced scrolling between editor and preview panes.
  // `syncScrollGuard` short-circuits the reciprocal handler so we don't
  // bounce events back and forth in an infinite loop.
  let editorEl = $state<HTMLTextAreaElement | null>(null);
  let previewEl = $state<HTMLDivElement | null>(null);
  let syncScrollGuard = false;

  const isDisconnected = $derived(
    connection.status === 'disconnected' || connection.status === 'idle' || !connection.client
  );

  // Use TextEncoder for an honest byte count — naïve `length` counts UTF-16
  // code units, which under-reports for any multi-byte char (emoji, CJK)
  // and would let the user blow past 64 KB on the wire.
  const byteCount = $derived.by(() => new TextEncoder().encode(draft).length);
  const charCount = $derived(draft.length);
  // Whitespace-split word count. Trim first so a trailing newline doesn't
  // count as a phantom word, and short-circuit empty drafts so the count
  // reads 0 instead of 1 (which an unguarded split returns for '').
  const wordCount = $derived.by(() => {
    const trimmed = draft.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
  });
  const overLimit = $derived(byteCount > MAX_BYTES);
  const approaching = $derived(byteCount > SOFT_WARN_BYTES && byteCount <= MAX_BYTES);
  const pctUsed = $derived(Math.min(100, Math.round((byteCount / MAX_BYTES) * 100)));
  const dirty = $derived(draft !== serverPrompt);

  // Read-only preview redaction. Edit mode (the textarea) always shows
  // the raw draft so the operator can edit the real bytes; the rendered
  // Markdown preview is treated as a read-only view and runs through
  // `redactSecrets`. The detector below is a string-equality probe — if
  // `redactSecrets` changed anything we know at least one pattern hit,
  // which lets us flip on the banner without re-walking the patterns.
  const redactedDraft = $derived(redactSecrets(draft));
  const hasSecretInDraft = $derived(redactedDraft !== draft);

  onMount(() => {
    hydrateHistory();
    void load();
  });

  function hydrateHistory() {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(HISTORY_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      history = parsed
        .filter(
          (e): e is HistoryEntry =>
            !!e &&
            typeof e === 'object' &&
            typeof (e as HistoryEntry).timestamp === 'number' &&
            typeof (e as HistoryEntry).prompt === 'string' &&
            typeof (e as HistoryEntry).length === 'number'
        )
        .slice(0, HISTORY_LIMIT);
    } catch {
      // Corrupt history is non-fatal — discard it.
      history = [];
    }
  }

  function persistHistory() {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      // Storage full / disabled; history persistence is best-effort.
    }
  }

  function recordHistory(prompt: string) {
    const entry: HistoryEntry = {
      timestamp: Date.now(),
      prompt,
      length: new TextEncoder().encode(prompt).length
    };
    // Don't dedupe — even an identical-prompt save records the timestamp
    // so the operator can see they Ctrl+S'd without changes.
    history = [entry, ...history].slice(0, HISTORY_LIMIT);
    persistHistory();
  }

  async function load() {
    const client = connection.client;
    if (!client) {
      loadState = 'idle';
      return;
    }
    loadState = 'loading';
    loadError = null;
    forbidden = false;
    try {
      // Use the RAW variant — the editor round-trips this value back to
      // the server on Save. The redacted `getSystemPrompt()` would persist
      // bullet-masked secrets in place of the real prompt bytes on the
      // next save, silently destroying any embedded tokens. The
      // SystemPromptEditor's own `redactedDraft` derivation still masks
      // the read-only preview pane in the side-by-side layout, so the
      // operator never sees the raw token rendered on screen.
      const res = await client.getSystemPromptRaw();
      serverPrompt = res.prompt;
      draft = res.prompt;
      loadState = 'loaded';
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403) {
        forbidden = true;
        loadError =
          "This profile's token doesn't have admin role. Switch profile or use a token with admin permission.";
      } else if (status === 404) {
        loadError =
          'System prompt management is only available in multi-tenant mode on this gateway.';
      } else {
        loadError = (err as Error).message;
      }
      loadState = 'error';
    }
  }

  function discard() {
    draft = serverPrompt;
    saveState = 'idle';
    saveError = null;
  }

  async function save() {
    if (overLimit) {
      toasts.show(`Prompt exceeds the 64 KB limit (${byteCount} bytes)`, 'error');
      return;
    }
    const client = connection.client;
    if (!client) return;
    saveState = 'saving';
    saveError = null;
    try {
      await client.setSystemPrompt(draft);
      serverPrompt = draft;
      saveState = 'saved';
      recordHistory(draft);
      toasts.show('System prompt saved', 'success');
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403) {
        saveError =
          "This profile's token doesn't have admin role. Switch profile or use a token with admin permission.";
        forbidden = true;
      } else if (status === 413) {
        saveError = 'Server rejected the prompt as too large (64 KB cap).';
      } else {
        saveError = (err as Error).message;
      }
      saveState = 'error';
      toasts.show(`Save failed: ${saveError}`, 'error');
    }
  }

  async function restoreDefault() {
    // PUTing an empty string falls back to the gateway's built-in default —
    // the server reads the empty doc as "no admin instructions" and stops
    // injecting the System Instructions section.
    const ok = await confirmDialog.ask({
      title: 'Restore gateway default system prompt?',
      body: 'Clears the admin system prompt. Users get only per-profile context until you save a new one.',
      confirmLabel: 'Restore default',
      cancelLabel: 'Keep prompt',
      tone: 'danger'
    });
    if (!ok) {
      return;
    }
    draft = '';
    await save();
  }

  // ---- History panel ----------------------------------------------------

  function toggleHistory() {
    showHistory = !showHistory;
    if (!showHistory) diffTarget = null;
  }

  async function restoreFromHistory(entry: HistoryEntry) {
    const ok = await confirmDialog.ask({
      title: 'Load saved system-prompt snapshot?',
      body: `Replaces the draft with the ${formatTimestamp(entry.timestamp)} snapshot. Not saved until you click Save.`,
      confirmLabel: 'Load snapshot',
      cancelLabel: 'Keep current draft',
      tone: 'danger'
    });
    if (!ok) return;
    draft = entry.prompt;
    showHistory = false;
    diffTarget = null;
    toasts.show('Snapshot loaded into editor; not saved', 'info');
  }

  function openDiff(entry: HistoryEntry) {
    diffTarget = entry;
  }

  function closeDiff() {
    diffTarget = null;
  }

  function formatTimestamp(ts: number): string {
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return new Date(ts).toISOString();
    }
  }

  function previewSnippet(s: string): string {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > 100 ? flat.slice(0, 100) + '…' : flat || '(empty)';
  }

  // ---- Line diff --------------------------------------------------------

  // Simple line-by-line diff via longest-common-subsequence. The standard
  // Myers diff would be smaller, but a textbook LCS table runs comfortably
  // on a 64 KB prompt (worst case ~5000 lines → 25M cell table; in practice
  // SYSTEM.md is hundreds of lines, well under 1M cells). We trade peak
  // memory for not pulling in a dependency. Output is an array of
  // `{ type: 'same' | 'add' | 'del', text }` chunks, suitable for inline
  // rendering with green/red row classes.
  type DiffLine = { type: 'same' | 'add' | 'del'; text: string };

  function lineDiff(oldText: string, newText: string): DiffLine[] {
    const a = oldText.split('\n');
    const b = newText.split('\n');
    const m = a.length;
    const n = b.length;

    // dp[i][j] = length of LCS of a[i..] and b[j..]. Built bottom-up so we
    // can walk top-down to emit the diff. Uint16Array keeps memory tight;
    // a single SYSTEM.md line count comfortably fits in 65 K.
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

    const out: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) {
        out.push({ type: 'same', text: a[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ type: 'del', text: a[i] });
        i++;
      } else {
        out.push({ type: 'add', text: b[j] });
        j++;
      }
    }
    while (i < m) out.push({ type: 'del', text: a[i++] });
    while (j < n) out.push({ type: 'add', text: b[j++] });
    return out;
  }

  const diffLines = $derived.by(() => {
    if (!diffTarget) return [] as DiffLine[];
    return lineDiff(diffTarget.prompt, draft);
  });

  // ---- Scroll sync (side-by-side preview only) --------------------------
  //
  // Mirror scroll position as a fraction (0..1) so unequal content heights
  // still line up at the same "percentage of document". The guard flag
  // suppresses the reciprocal handler that the programmatic scroll would
  // trigger; without it the two panes would push each other indefinitely.

  function syncFromEditor() {
    if (!showPreview || !editorEl || !previewEl) return;
    if (syncScrollGuard) {
      syncScrollGuard = false;
      return;
    }
    const denom = editorEl.scrollHeight - editorEl.clientHeight;
    if (denom <= 0) return;
    const frac = editorEl.scrollTop / denom;
    syncScrollGuard = true;
    previewEl.scrollTop = frac * (previewEl.scrollHeight - previewEl.clientHeight);
  }

  function syncFromPreview() {
    if (!showPreview || !editorEl || !previewEl) return;
    if (syncScrollGuard) {
      syncScrollGuard = false;
      return;
    }
    const denom = previewEl.scrollHeight - previewEl.clientHeight;
    if (denom <= 0) return;
    const frac = previewEl.scrollTop / denom;
    syncScrollGuard = true;
    editorEl.scrollTop = frac * (editorEl.scrollHeight - editorEl.clientHeight);
  }

  // When preview toggles on, give the DOM a tick to render the right pane
  // before we (re)bind. We don't manually unbind because Svelte tears
  // down the {#if} block when preview turns off.
  $effect(() => {
    if (showPreview) {
      void tick();
    }
  });
</script>

<div class="flex flex-col flex-1 min-h-0">
  {#if isDisconnected}
    <div class="surface p-10 flex flex-col items-center justify-center text-center min-h-[280px]">
      <div class="text-sm text-text-primary mb-2">IronClaw is offline</div>
      <div class="text-xs text-text-muted">
        Configure the connection in
        <a
          href="/settings"
          class="text-accent-cyan underline decoration-dotted hover:decoration-solid">Settings</a
        >.
      </div>
    </div>
  {:else if loadState === 'loading'}
    <div class="surface p-10 flex flex-col items-center justify-center text-center min-h-[280px]">
      <div class="text-sm text-text-muted">Loading system prompt…</div>
    </div>
  {:else if loadState === 'error'}
    <div class="surface p-10 flex flex-col items-center justify-center text-center min-h-[280px]">
      <div class="text-sm text-red-400 mb-2">
        {forbidden ? 'Admin permission required' : 'Failed to load system prompt'}
      </div>
      <div class="text-xs text-text-muted font-mono mb-4 max-w-md break-words">
        {loadError ?? 'Unknown error'}
      </div>
      {#if !forbidden}
        <button
          type="button"
          onclick={() => void load()}
          class="px-4 py-2 rounded-md border border-accent-cyan text-accent-cyan text-sm font-semibold hover:bg-accent-cyan hover:text-bg-deep transition min-h-[40px]"
        >
          Retry
        </button>
      {/if}
    </div>
  {:else}
    <!-- Toolbar: preview toggle on the left, dirty/save status on the right.
         Preview switches between stacked (narrow) and side-by-side (wide)
         layouts via Tailwind responsive grid-cols below. -->
    <div class="flex items-center gap-3 mb-3">
      <label class="inline-flex items-center gap-2 cursor-pointer text-xs text-text-muted">
        <input type="checkbox" bind:checked={showPreview} class="accent-accent-cyan w-3.5 h-3.5" />
        <span>Preview</span>
      </label>
      <span class="text-[10px] text-text-muted font-mono">
        Side-by-side when wide, stacked when narrow.
      </span>
      <span class="ml-auto text-xs">
        {#if dirty}
          <span class="text-accent-gold">Unsaved changes.</span>
        {:else if saveState === 'saved'}
          <span class="text-accent-cyan">Saved.</span>
        {:else}
          <span class="text-text-muted">Up to date with the server.</span>
        {/if}
      </span>
    </div>

    <!-- Editor + (optional) preview. The grid collapses to a single column
         when preview is off; when on, narrow viewports stack rows, wide
         viewports show 50/50 columns. The min-h-0 on inner panes lets
         them shrink so the parent flex layout doesn't blow past the
         viewport. -->
    <div class="flex-1 min-h-0 grid grid-cols-1 gap-4" class:lg:grid-cols-2={showPreview}>
      <textarea
        bind:value={draft}
        bind:this={editorEl}
        onscroll={syncFromEditor}
        spellcheck="false"
        placeholder="# System Instructions&#10;&#10;Write the admin SYSTEM.md content here. Markdown supported."
        class="surface w-full h-full p-4 bg-bg-deep border border-border-subtle rounded-md text-sm font-mono text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-accent-cyan transition-colors resize-none min-h-[240px]"
      ></textarea>

      {#if showPreview}
        <div
          bind:this={previewEl}
          onscroll={syncFromPreview}
          class="surface p-4 overflow-auto text-sm min-h-[240px]"
        >
          {#if hasSecretInDraft}
            <!-- Token-mask banner. Sits above the rendered preview so the
                 reader knows the visible markdown has been sanitized;
                 the editor textarea on the left still shows raw bytes. -->
            <div
              class="mb-3 px-3 py-2 rounded-md border border-accent-gold/60 bg-accent-gold/10 text-[11px] text-accent-gold flex items-start gap-2"
            >
              <span aria-hidden="true">⚠</span>
              <span class="flex-1"> Token-like patterns masked. Edit mode shows raw. </span>
            </div>
          {/if}
          {#if draft.trim()}
            <MarkdownView markdown={redactedDraft} />
          {:else}
            <div class="text-xs text-text-muted italic">Nothing to preview</div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Footer: live counts + soft/hard warnings + save controls. -->
    <div class="mt-4 flex items-center gap-3 flex-wrap">
      <span
        class="text-xs font-mono"
        class:text-text-muted={!approaching && !overLimit}
        class:text-accent-gold={approaching}
        class:text-red-400={overLimit}
      >
        {charCount.toLocaleString()} characters / {wordCount.toLocaleString()} words
        <span class="opacity-70">·</span>
        {byteCount.toLocaleString()} / {MAX_BYTES.toLocaleString()} bytes
        {#if overLimit}
          <span class="ml-2">— exceeds the 64 KB limit ({pctUsed}% of cap)</span>
        {:else if approaching}
          <span class="ml-2">— approaching length limit ({pctUsed}% used)</span>
        {/if}
      </span>

      <button
        type="button"
        onclick={toggleHistory}
        class="text-xs text-text-muted hover:text-accent-cyan transition-colors ml-auto"
        title="View recent saved snapshots"
      >
        History ({history.length})
      </button>

      <button
        type="button"
        onclick={() => void restoreDefault()}
        class="text-xs text-text-muted hover:text-accent-gold transition-colors"
        title="Clear SYSTEM.md to fall back to the built-in default"
      >
        Restore default
      </button>

      <button
        type="button"
        onclick={discard}
        disabled={!dirty || saveState === 'saving'}
        class="px-4 py-2 rounded-md border border-border-subtle text-sm text-text-primary hover:border-accent-gold hover:text-accent-gold transition disabled:opacity-30 disabled:hover:border-border-subtle disabled:hover:text-text-primary min-h-[40px]"
      >
        Discard
      </button>
      <button
        type="button"
        onclick={() => void save()}
        disabled={!dirty || saveState === 'saving' || overLimit}
        class="px-4 py-2 rounded-md bg-accent-cyan text-bg-deep text-sm font-semibold hover:brightness-110 transition disabled:opacity-50 min-h-[40px]"
      >
        {saveState === 'saving' ? 'Saving…' : 'Save changes'}
      </button>
    </div>

    {#if overLimit}
      <!-- Hard-limit helper. Save is already disabled above; this just
           gives the operator a plain-language explanation. -->
      <div class="mt-2 text-xs text-red-400">
        Prompt is over the 64 KB cap. Trim it before saving — the gateway will reject anything
        larger with a 413.
      </div>
    {/if}

    {#if saveError && saveState === 'error'}
      <div class="mt-2 text-xs text-red-400 font-mono break-words">
        {saveError}
      </div>
    {/if}

    {#if showHistory}
      <!-- History panel. Shows the 5 most recent snapshots; each row has a
           Restore (loads into editor) and Diff (inline line-diff view)
           action. The diff view replaces the list rather than stacking
           below so the panel stays compact. -->
      <div class="mt-4 surface p-4">
        <div class="flex items-center justify-between mb-3">
          <div class="text-sm font-semibold text-text-primary">
            {diffTarget ? 'Diff vs. current draft' : 'Save history'}
          </div>
          <button
            type="button"
            onclick={diffTarget ? closeDiff : toggleHistory}
            class="text-xs text-text-muted hover:text-text-primary transition"
          >
            {diffTarget ? 'Back to list' : 'Close'}
          </button>
        </div>

        {#if history.length === 0}
          <div class="text-xs text-text-muted italic">
            No saves yet. Each Save appears here (last 5).
          </div>
        {:else if diffTarget}
          <div class="text-[11px] text-text-muted font-mono mb-2">
            <span class="text-red-400">−</span> snapshot @ {formatTimestamp(diffTarget.timestamp)}
            <span class="opacity-50 mx-2">·</span>
            <span class="text-green-400">+</span> current draft
          </div>
          <div
            class="bg-bg-deep border border-border-subtle rounded-md overflow-auto max-h-[400px] font-mono text-xs"
          >
            {#if diffLines.length === 0}
              <div class="p-4 text-text-muted italic">No differences</div>
            {:else}
              {#each diffLines as line, i (i)}
                {@const cls =
                  line.type === 'add'
                    ? 'bg-green-500/10 text-green-300 border-l-2 border-green-500/60'
                    : line.type === 'del'
                      ? 'bg-red-500/10 text-red-300 border-l-2 border-red-500/60'
                      : 'text-text-muted border-l-2 border-transparent'}
                {@const sigil = line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  '}
                <div class="px-3 py-0.5 whitespace-pre-wrap break-words {cls}">
                  <span class="select-none opacity-60">{sigil}</span>{line.text || ' '}
                </div>
              {/each}
            {/if}
          </div>
        {:else}
          <div class="flex flex-col gap-2">
            {#each history as entry, i (entry.timestamp + '-' + i)}
              <div
                class="flex items-start gap-3 p-3 bg-bg-deep border border-border-subtle rounded-md hover:border-text-muted transition"
              >
                <div class="flex-1 min-w-0">
                  <div class="text-xs text-text-primary font-mono">
                    {formatTimestamp(entry.timestamp)}
                    <span class="text-text-muted ml-2">· {entry.length.toLocaleString()} bytes</span
                    >
                  </div>
                  <div
                    class="text-xs text-text-muted mt-1 truncate"
                    title={entry.prompt.slice(0, 500)}
                  >
                    {previewSnippet(entry.prompt)}
                  </div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onclick={() => openDiff(entry)}
                    class="px-2.5 py-1 rounded text-[11px] font-semibold border border-border-subtle text-text-muted hover:text-accent-cyan hover:border-accent-cyan transition min-h-[28px]"
                  >
                    Diff
                  </button>
                  <button
                    type="button"
                    onclick={() => void restoreFromHistory(entry)}
                    class="px-2.5 py-1 rounded text-[11px] font-semibold border border-border-subtle text-text-muted hover:text-accent-gold hover:border-accent-gold transition min-h-[28px]"
                  >
                    Restore
                  </button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>
