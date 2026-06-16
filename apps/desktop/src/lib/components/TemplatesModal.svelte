<script lang="ts">
  // Prompt Templates modal. Centered overlay with backdrop blur, dark
  // surface with cyan border accent. Lists every saved template with
  // rows for Insert / Edit / Delete; a "New template…" button at the
  // top opens an inline editor for name + body.
  //
  // Mounted once at the layout level (`src/routes/+layout.svelte`) and
  // reads `templatesModal.open` to render / teardown. Mirrors the
  // modal pattern in `PresetsModal.svelte` and `CommandPalette.svelte`
  // (same backdrop, header, footer, focus-management shape).
  //
  // Templates with `{variable}` placeholders defer insertion: clicking
  // Insert switches the row into a variable-input view, the user fills
  // each `{var}`, and "Fill in" substitutes via `templates.render()`
  // before pushing the rendered text to the composer bus.
  //
  // Composer pipeline: `composerInsert.push(text, templateId)` lands
  // the payload in a one-shot rune bus that the chat page consumes
  // either on its next mount (cross-route navigation) or via an
  // immediate `$effect` (same-route). The chat page also calls
  // `templates.recordUse()` so the use count / last-used reflect
  // real activations.

  import { goto } from '$app/navigation';
  import { onMount, tick } from 'svelte';
  import {
    composerInsert,
    templates,
    templatesModal,
    type PromptTemplate
  } from '$lib/stores/templates.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';

  // ---- view-mode state -----------------------------------------------------

  /** Top-level view mode the modal is currently rendering. */
  type ViewMode =
    | { kind: 'list' }
    | { kind: 'editor'; templateId: string | null }
    | { kind: 'variables'; templateId: string };

  let view = $state<ViewMode>({ kind: 'list' });

  // ---- filter / search -----------------------------------------------------

  /** Debounced filter input — matches against name + body. We avoid a
   *  fancy fuzzy matcher; a simple case-insensitive `includes` is
   *  enough for the modest list sizes (cap is 50). */
  let filterRaw = $state('');
  let filter = $state('');
  let filterTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const next = filterRaw;
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      filter = next;
      filterTimer = null;
    }, 200);
  });

  // ---- editor state -------------------------------------------------------

  let editorName = $state('');
  let editorBody = $state('');
  let editorNameEl = $state<HTMLInputElement | null>(null);
  let editorBodyEl = $state<HTMLTextAreaElement | null>(null);

  // ---- variable-input state ------------------------------------------------

  /** Per-variable user-supplied values, indexed by variable name. */
  let varValues = $state<Record<string, string>>({});
  /** First variable-input textarea — focused on entering the
   *  variable view so the user can start typing immediately. Typed
   *  as `HTMLTextAreaElement` so Svelte's `bind:this` strict-mode
   *  type check accepts the assignment from the {#if idx === 0}
   *  branch in the markup without a cast. */
  let firstVarInputEl = $state<HTMLTextAreaElement | null>(null);

  // ---- delete confirm ------------------------------------------------------

  /** Row currently armed for delete (first click arms, second commits).
   *  Reset on modal close + on view-mode change so the next interaction
   *  is a clean slate. */
  let deleteArmed = $state<string | null>(null);

  // ---- filter input element (for focus) -----------------------------------

  let filterInputEl = $state<HTMLInputElement | null>(null);

  // ---- derived list --------------------------------------------------------

  const filteredTemplates = $derived<PromptTemplate[]>(
    (() => {
      const q = filter.trim().toLowerCase();
      if (!q) return templates.templates;
      return templates.templates.filter(
        (t) => t.name.toLowerCase().includes(q) || t.body.toLowerCase().includes(q)
      );
    })()
  );

  // ---- lifecycle -----------------------------------------------------------

  // Reset transient state every time the modal closes so the next open
  // is a blank slate (matches PresetsModal). Also resets the view mode
  // back to the list so the user lands somewhere expected next time.
  $effect(() => {
    if (!templatesModal.open) {
      filterRaw = '';
      filter = '';
      view = { kind: 'list' };
      editorName = '';
      editorBody = '';
      varValues = {};
      deleteArmed = null;
    }
  });

  // Auto-focus on open. If `templatesModal.openForTemplate` was set
  // (palette per-template action), pre-route to the insert flow:
  // templates with variables open the variable-input view; templates
  // without insert immediately and close. Otherwise focus the filter
  // input so the user can start narrowing the list.
  $effect(() => {
    if (!templatesModal.open) return;
    const target = templatesModal.openForTemplate;
    void tick().then(() => {
      if (target) {
        const tpl = templates.templates.find((t) => t.id === target);
        if (tpl) {
          if (tpl.variables.length > 0) {
            startVariableInput(tpl);
          } else {
            insertImmediate(tpl);
          }
          return;
        }
      }
      filterInputEl?.focus();
    });
  });

  // When entering the editor, focus the name input. When entering the
  // variables view, focus the first variable input.
  $effect(() => {
    if (view.kind === 'editor') {
      void tick().then(() => editorNameEl?.focus());
    } else if (view.kind === 'variables') {
      void tick().then(() => firstVarInputEl?.focus());
    }
  });

  // ---- handlers ------------------------------------------------------------

  function onBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) templatesModal.close();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      // Esc inside the editor / variable view backs out to the list
      // rather than closing the modal — matches the rename-cancel
      // behavior in PresetsModal.
      if (view.kind === 'editor' || view.kind === 'variables') {
        view = { kind: 'list' };
        return;
      }
      if (deleteArmed) {
        deleteArmed = null;
        return;
      }
      templatesModal.close();
    }
  }

  // ---- list actions --------------------------------------------------------

  function startNewTemplate() {
    editorName = '';
    editorBody = '';
    view = { kind: 'editor', templateId: null };
  }

  function startEdit(tpl: PromptTemplate) {
    editorName = tpl.name;
    editorBody = tpl.body;
    view = { kind: 'editor', templateId: tpl.id };
  }

  /**
   * Insert a template that has no variables. Pushes the body verbatim
   * onto the composer bus, records the use, navigates to the chat
   * route if we're not already there, closes the modal, and surfaces
   * a toast for confirmation. The chat page picks up the bus payload
   * on mount (cross-route) or via `$effect` (same-route).
   */
  function insertImmediate(tpl: PromptTemplate) {
    composerInsert.push(tpl.body, tpl.id);
    templates.recordUse(tpl.id);
    templatesModal.close();
    toasts.show(`Inserted "${tpl.name}".`, 'success');
    if (typeof window !== 'undefined' && window.location.pathname !== '/') {
      void goto('/chat');
    }
  }

  /**
   * Enter the variable-input view for a templated body. Seeds the
   * value map with empty strings so every variable has a defined
   * controlled-input target.
   */
  function startVariableInput(tpl: PromptTemplate) {
    const seed: Record<string, string> = {};
    for (const v of tpl.variables) seed[v] = '';
    varValues = seed;
    view = { kind: 'variables', templateId: tpl.id };
  }

  function handleInsert(tpl: PromptTemplate) {
    if (tpl.variables.length > 0) {
      startVariableInput(tpl);
    } else {
      insertImmediate(tpl);
    }
  }

  function handleDelete(tpl: PromptTemplate) {
    if (deleteArmed !== tpl.id) {
      deleteArmed = tpl.id;
      return;
    }
    templates.delete(tpl.id);
    deleteArmed = null;
    toasts.show(`Deleted template "${tpl.name}".`, 'info');
  }

  // ---- editor actions ------------------------------------------------------

  function commitEditor() {
    const trimmedName = editorName.trim();
    if (!trimmedName) {
      toasts.show('Name the template first.', 'info');
      editorNameEl?.focus();
      return;
    }
    if (!editorBody.trim()) {
      toasts.show('Template body cannot be empty.', 'info');
      editorBodyEl?.focus();
      return;
    }
    if (view.kind !== 'editor') return;
    if (view.templateId === null) {
      const tpl = templates.add(trimmedName, editorBody);
      toasts.show(`Saved template "${tpl.name}".`, 'success');
    } else {
      templates.update(view.templateId, {
        name: trimmedName,
        body: editorBody
      });
      toasts.show(`Updated template "${trimmedName}".`, 'success');
    }
    view = { kind: 'list' };
  }

  // ---- variable-input actions ---------------------------------------------

  function commitVariables() {
    const current = view;
    if (current.kind !== 'variables') return;
    const tpl = templates.templates.find((t) => t.id === current.templateId);
    if (!tpl) {
      toasts.show('Template no longer exists.', 'error');
      view = { kind: 'list' };
      return;
    }
    const rendered = templates.render(tpl, varValues);
    composerInsert.push(rendered, tpl.id);
    templates.recordUse(tpl.id);
    templatesModal.close();
    toasts.show(`Inserted "${tpl.name}".`, 'success');
    if (typeof window !== 'undefined' && window.location.pathname !== '/') {
      void goto('/chat');
    }
  }

  // ---- helpers -------------------------------------------------------------

  /**
   * Compact preview of the body. The list renders the first 80 chars
   * so the user can scan rows without expanding each. Newlines are
   * collapsed to spaces so the preview fits on one row.
   */
  function bodyPreview(body: string, max = 80): string {
    const flat = body.replace(/\s+/g, ' ').trim();
    if (flat.length <= max) return flat;
    return `${flat.slice(0, max - 1)}…`;
  }

  /**
   * Relative-time label like "5 minutes ago" / "yesterday" / "3 days
   * ago". Pure, no Intl.RelativeTimeFormat dependency so the output
   * is consistent across runtimes. Returns "never" for unset
   * lastUsedAt (the spec calls this out explicitly).
   */
  function relativeTime(iso: string | undefined): string {
    if (!iso) return 'never';
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return 'unknown';
    const deltaMs = Date.now() - ts;
    if (deltaMs < 0) return 'in the future';
    const seconds = Math.floor(deltaMs / 1000);
    if (seconds < 45) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 2) return '1 minute ago';
    if (minutes < 60) return `${minutes} minutes ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 2) return '1 hour ago';
    if (hours < 24) return `${hours} hours ago`;
    const days = Math.floor(hours / 24);
    if (days < 2) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    const months = Math.floor(days / 30);
    if (months < 2) return '1 month ago';
    if (months < 12) return `${months} months ago`;
    const years = Math.floor(days / 365);
    if (years < 2) return '1 year ago';
    return `${years} years ago`;
  }

  /** Resolve the active template id (in editor/variables view) to the
   *  full template record. Returns null when in list mode or when the
   *  template was deleted out from under the view. Pulled out
   *  through a local so the discriminated union narrows correctly
   *  inside the find callback. */
  const activeTemplate = $derived<PromptTemplate | null>(
    (() => {
      const v = view;
      if (v.kind === 'list') return null;
      const id = v.templateId;
      if (!id) return null;
      return templates.templates.find((t) => t.id === id) ?? null;
    })()
  );

  onMount(() => {
    // Nothing to do — `templates.init()` runs from the layout so this
    // component just renders against the already-hydrated state.
  });
</script>

<svelte:window onkeydown={onKeyDown} />

{#if templatesModal.open}
  <!-- Backdrop. svelte-a11y: this is a modal dialog; focus management
       above + global keydown listener implement the trap pattern
       without a dedicated focus-trap library. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-[60] flex items-start justify-center pt-[10vh] bg-black/60 backdrop-blur-sm"
    onclick={onBackdropClick}
    role="presentation"
  >
    <div
      class="w-[640px] max-w-[92vw] max-h-[80vh] flex flex-col bg-bg-deep border border-accent-cyan/40 rounded-xl shadow-2xl overflow-hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Prompt templates"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
        <div>
          <div class="text-sm font-medium text-text-primary">
            {#if view.kind === 'editor'}
              {view.templateId ? 'Edit template' : 'New template'}
            {:else if view.kind === 'variables'}
              Fill in variables
            {:else}
              Prompt templates
            {/if}
          </div>
          <div class="text-xs text-text-muted/70 mt-0.5">
            {#if view.kind === 'editor'}
              Use <code class="text-accent-gold">{`{variable}`}</code> placeholders for fields to fill
              at insert time.
            {:else if view.kind === 'variables'}
              {activeTemplate?.name ?? ''}
            {:else}
              Save reusable prompts. Insert from here or via
              <code class="text-accent-gold">/name</code> in the chat composer.
            {/if}
          </div>
        </div>
        <button
          type="button"
          onclick={() => templatesModal.close()}
          class="text-text-muted hover:text-text-primary p-1 -m-1 rounded transition-colors"
          aria-label="Close templates"
        >
          <svg
            viewBox="0 0 24 24"
            class="w-4 h-4"
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
      </div>

      {#if view.kind === 'list'}
        <!-- Filter + new-template row -->
        <div
          class="px-5 py-3 border-b border-border-subtle bg-bg-surface/30 flex items-center gap-2"
        >
          <input
            bind:this={filterInputEl}
            bind:value={filterRaw}
            type="text"
            placeholder="Filter templates…"
            aria-label="Filter templates"
            class="flex-1 bg-bg-deep border border-border-subtle rounded-md px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors"
            spellcheck="false"
            autocomplete="off"
          />
          <button
            type="button"
            onclick={startNewTemplate}
            class="shrink-0 px-3 py-1.5 rounded-md text-xs font-mono uppercase tracking-widest bg-accent-cyan/10 border border-accent-cyan/40 text-accent-cyan hover:bg-accent-cyan/20 transition-colors"
          >
            New template…
          </button>
        </div>

        <!-- List -->
        <div class="flex-1 overflow-y-auto py-2">
          {#if filteredTemplates.length === 0}
            <div class="px-5 py-10 text-center text-sm text-text-muted">
              {#if templates.templates.length === 0}
                No templates yet. Create one above.
              {:else}
                No templates match
                <span class="text-text-primary">{filter}</span>.
              {/if}
            </div>
          {:else}
            {#each filteredTemplates as tpl (tpl.id)}
              {@const armed = deleteArmed === tpl.id}
              <div
                class="mx-2 mb-1 px-3 py-2 rounded-md border border-transparent hover:border-border-subtle hover:bg-bg-surface/40 transition-colors"
              >
                <div class="flex items-center gap-2">
                  <div class="flex-1 min-w-0">
                    <div class="text-sm text-text-primary truncate flex items-center gap-2">
                      <span class="truncate">{tpl.name}</span>
                      {#if tpl.variables.length > 0}
                        <span
                          class="shrink-0 text-[9px] uppercase tracking-wider px-1 py-px rounded border border-accent-gold/40 text-accent-gold"
                          title="Has {tpl.variables.length} variable{tpl.variables.length === 1
                            ? ''
                            : 's'}"
                          aria-label="Has variables"
                        >
                          {tpl.variables.length} var{tpl.variables.length === 1 ? '' : 's'}
                        </span>
                      {/if}
                    </div>
                    <div class="text-xs text-text-muted/70 truncate">
                      {bodyPreview(tpl.body)}
                    </div>
                    <div class="text-[10px] text-text-muted/60 font-mono mt-0.5">
                      used {relativeTime(tpl.lastUsedAt)} ·
                      {tpl.useCount}
                      use{tpl.useCount === 1 ? '' : 's'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onclick={() => handleInsert(tpl)}
                    class="shrink-0 px-2.5 py-1 rounded-md text-[10px] font-mono uppercase tracking-widest bg-accent-cyan text-bg-deep hover:bg-accent-cyan/80 transition-colors"
                    aria-label={tpl.variables.length > 0
                      ? `Fill in variables for ${tpl.name}`
                      : `Insert template ${tpl.name}`}
                  >
                    Insert
                  </button>
                  <button
                    type="button"
                    onclick={() => startEdit(tpl)}
                    class="shrink-0 p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-surface transition-colors"
                    aria-label={`Edit template ${tpl.name}`}
                    title="Edit"
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
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onclick={() => handleDelete(tpl)}
                    class="template-delete-btn shrink-0 px-2 py-1 rounded-md text-[10px] font-mono uppercase tracking-widest border transition-colors"
                    class:armed
                    aria-label={armed
                      ? `Confirm delete template ${tpl.name}`
                      : `Delete template ${tpl.name}`}
                    title={armed ? 'Click again to confirm' : 'Delete'}
                  >
                    {armed ? 'Confirm' : 'Delete'}
                  </button>
                </div>
              </div>
            {/each}
          {/if}
        </div>
      {:else if view.kind === 'editor'}
        <!-- Editor view -->
        <div class="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          <div>
            <label
              for="template-name"
              class="block text-[10px] font-mono uppercase tracking-widest text-text-muted mb-1"
            >
              Name
            </label>
            <input
              id="template-name"
              bind:this={editorNameEl}
              bind:value={editorName}
              type="text"
              maxlength="80"
              placeholder="e.g. Code review"
              class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors"
              spellcheck="false"
              autocomplete="off"
            />
          </div>
          <div>
            <label
              for="template-body"
              class="block text-[10px] font-mono uppercase tracking-widest text-text-muted mb-1"
            >
              Body
            </label>
            <textarea
              id="template-body"
              bind:this={editorBodyEl}
              bind:value={editorBody}
              rows="8"
              placeholder={'Review this code for bugs:\n\n```{language}\n{code}\n```'}
              class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors resize-y"
              spellcheck="false"
            ></textarea>
          </div>
        </div>
        <div class="px-5 py-3 border-t border-border-subtle flex items-center justify-end gap-2">
          <button
            type="button"
            onclick={() => (view = { kind: 'list' })}
            class="px-3 py-1.5 rounded-md text-xs font-mono uppercase tracking-widest text-text-muted hover:text-text-primary hover:bg-bg-surface transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onclick={commitEditor}
            class="px-3 py-1.5 rounded-md text-xs font-mono uppercase tracking-widest bg-accent-cyan text-bg-deep hover:bg-accent-cyan/80 transition-colors"
          >
            Save
          </button>
        </div>
      {:else if view.kind === 'variables' && activeTemplate}
        <!-- Variables-input view -->
        <div class="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {#each activeTemplate.variables as varName, idx (varName)}
            <div>
              <label
                for={`template-var-${varName}`}
                class="block text-[10px] font-mono uppercase tracking-widest text-text-muted mb-1"
              >
                {`{${varName}}`}
              </label>
              {#if idx === 0}
                <textarea
                  id={`template-var-${varName}`}
                  bind:this={firstVarInputEl}
                  bind:value={varValues[varName]}
                  rows="3"
                  placeholder={`Value for ${varName}…`}
                  class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors resize-y"
                  spellcheck="false"
                ></textarea>
              {:else}
                <textarea
                  id={`template-var-${varName}`}
                  bind:value={varValues[varName]}
                  rows="3"
                  placeholder={`Value for ${varName}…`}
                  class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors resize-y"
                  spellcheck="false"
                ></textarea>
              {/if}
            </div>
          {/each}
          <!-- Preview block — shows the rendered text so the user
               sees what will land in the composer before committing. -->
          <div>
            <div class="block text-[10px] font-mono uppercase tracking-widest text-text-muted mb-1">
              Preview
            </div>
            <pre
              class="bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-xs font-mono text-text-muted whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{templates.render(
                activeTemplate,
                varValues
              )}</pre>
          </div>
        </div>
        <div class="px-5 py-3 border-t border-border-subtle flex items-center justify-end gap-2">
          <button
            type="button"
            onclick={() => (view = { kind: 'list' })}
            class="px-3 py-1.5 rounded-md text-xs font-mono uppercase tracking-widest text-text-muted hover:text-text-primary hover:bg-bg-surface transition-colors"
          >
            Back
          </button>
          <button
            type="button"
            onclick={commitVariables}
            class="px-3 py-1.5 rounded-md text-xs font-mono uppercase tracking-widest bg-accent-cyan text-bg-deep hover:bg-accent-cyan/80 transition-colors"
          >
            Fill in
          </button>
        </div>
      {/if}

      <!-- Footer hint (list view only) -->
      {#if view.kind === 'list'}
        <div
          class="px-5 py-2 border-t border-border-subtle flex items-center gap-4 text-[10px] text-text-muted/70 font-mono"
        >
          <span><kbd class="text-text-muted">esc</kbd> close</span>
          <span class="ml-auto">
            {templates.templates.length}
            template{templates.templates.length === 1 ? '' : 's'}
          </span>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Delete button — same shape as PresetsModal's preset-delete-btn:
     translucent red border at rest, solid red when armed for
     confirm. Plain CSS so we can express the slash-escaped tokens
     without bumping tailwind.config.js's content globs. */
  .template-delete-btn {
    color: rgb(248, 113, 113);
    border-color: rgba(239, 68, 68, 0.4);
    background-color: transparent;
  }
  .template-delete-btn:hover:not(:disabled):not(.armed) {
    background-color: rgba(239, 68, 68, 0.1);
  }
  .template-delete-btn.armed {
    color: #fff;
    background-color: rgb(239, 68, 68);
    border-color: rgb(239, 68, 68);
  }
</style>
