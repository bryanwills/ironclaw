<script lang="ts">
  // Workspace Presets modal. Centered overlay with backdrop blur, dark
  // surface with cyan border accent. Lists every saved preset with rows
  // for Apply / Rename / Delete; a "Save current as preset…" input at
  // the top captures the live workspace state under a user-given name.
  //
  // Mounted once at the layout level (`src/routes/+layout.svelte`) and
  // reads `presetsModal.open` to render / teardown. Mirrors the modal
  // pattern in `AboutDialog.svelte` and `CommandPalette.svelte`.
  //
  // Esc + backdrop click close. The first input is auto-focused on open
  // — if `focusTarget === 'save'` (palette "Save current as preset…"
  // entry point), focus lands on the save-name input directly; otherwise
  // it lands on the first preset row's Apply button when the list has
  // rows, or the save input when the list is empty.

  import { tick } from 'svelte';
  import { presets, presetsModal, type WorkspacePreset } from '$lib/stores/presets.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';

  // ---- save input state ---------------------------------------------------

  let saveName = $state('');
  let saveInputEl = $state<HTMLInputElement | null>(null);
  /** Row id currently being renamed; null when no inline rename is open.
   *  The rename input replaces the row's name display when set, and Esc
   *  cancels back to the row label. */
  let renamingId = $state<string | null>(null);
  let renameDraft = $state('');
  let renameInputEl = $state<HTMLInputElement | null>(null);
  /** Confirm-on-delete: once a row is clicked once, we arm it; a second
   *  click within the window commits. Reset when the modal closes so a
   *  user reopening doesn't fire a stray delete on the first click. */
  let deleteArmed = $state<string | null>(null);

  // ---- lifecycle ----------------------------------------------------------

  // Reset transient state every time the modal closes so the next open
  // is a blank slate (matches the CommandPalette behaviour).
  $effect(() => {
    if (!presetsModal.open) {
      saveName = '';
      renamingId = null;
      renameDraft = '';
      deleteArmed = null;
    }
  });

  // Auto-focus on open. Honour the `focusTarget` hint when the palette
  // pre-routes us to the save input; otherwise prefer the first Apply
  // button (so Enter activates the most-recent preset), falling back to
  // the save input when the list is empty.
  $effect(() => {
    if (!presetsModal.open) return;
    const target = presetsModal.focusTarget;
    void tick().then(() => {
      if (target === 'save' || presets.presets.length === 0) {
        saveInputEl?.focus();
      } else {
        const btn = document.querySelector('[data-preset-first-apply]') as HTMLButtonElement | null;
        btn?.focus();
      }
    });
  });

  function onBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) presetsModal.close();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (renamingId) {
        // Cancel rename instead of closing modal — Esc on the rename
        // input should drop the rename, not the whole modal.
        renamingId = null;
        renameDraft = '';
        return;
      }
      if (deleteArmed) {
        // Disarm pending delete first; user wants out of the confirm
        // state without committing.
        deleteArmed = null;
        return;
      }
      presetsModal.close();
    }
  }

  // ---- actions ------------------------------------------------------------

  function handleSave() {
    const trimmed = saveName.trim();
    if (!trimmed) {
      toasts.show('Name the preset first.', 'info');
      saveInputEl?.focus();
      return;
    }
    const preset = presets.save(trimmed);
    saveName = '';
    toasts.show(`Saved preset "${preset.name}".`, 'success');
    // Stay open so the user can immediately apply it or save another;
    // the new row appears at the top of the list.
  }

  async function handleApply(preset: WorkspacePreset) {
    presetsModal.close();
    await presets.apply(preset.id);
  }

  function startRename(preset: WorkspacePreset) {
    renamingId = preset.id;
    renameDraft = preset.name;
    deleteArmed = null;
    void tick().then(() => {
      renameInputEl?.focus();
      renameInputEl?.select();
    });
  }

  function commitRename() {
    if (!renamingId) return;
    const trimmed = renameDraft.trim();
    if (!trimmed) {
      toasts.show('Name cannot be empty.', 'info');
      renameInputEl?.focus();
      return;
    }
    presets.rename(renamingId, trimmed);
    renamingId = null;
    renameDraft = '';
  }

  function handleDelete(preset: WorkspacePreset) {
    if (deleteArmed !== preset.id) {
      // First click — arm the confirm state. The row's delete button
      // re-renders as "Confirm?" so the second click commits.
      deleteArmed = preset.id;
      return;
    }
    presets.delete(preset.id);
    deleteArmed = null;
    toasts.show(`Deleted preset "${preset.name}".`, 'info');
  }

  // ---- helpers ------------------------------------------------------------

  /**
   * Relative-time label like "5 minutes ago" / "yesterday" / "3 days ago".
   * Pure (no network), no Intl.RelativeTimeFormat dependency so the
   * output is consistent across runtimes. Kept terse so a long preset
   * list stays scannable.
   */
  function relativeTime(iso: string): string {
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

  /**
   * Build a compact summary of what the preset captured so the user can
   * scan the row at a glance: e.g. "chat · thread · 3 widths · sidebar
   * collapsed". Omits fields that weren't captured.
   */
  function presetSummary(preset: WorkspacePreset): string {
    const parts: string[] = [];
    parts.push(preset.activePath || '/');
    if (preset.currentThreadId) parts.push('thread');
    const widthCount = [
      preset.chatRailWidth,
      preset.chatInspectorWidth,
      preset.knowledgeTreeWidth,
      preset.missionsProjectsWidth
    ].filter((w) => w !== undefined).length;
    if (widthCount > 0) {
      parts.push(`${widthCount} width${widthCount === 1 ? '' : 's'}`);
    }
    if (preset.sidebarCollapsed) parts.push('sidebar collapsed');
    if (preset.statusBarVisible === false) parts.push('status bar hidden');
    if (preset.trayBadgeEnabled === false) parts.push('badge off');
    return parts.join(' · ');
  }
</script>

<svelte:window onkeydown={onKeyDown} />

{#if presetsModal.open}
  <!-- Backdrop. svelte-a11y: this is a modal dialog; the focus management
       above + global keydown listener implement the trap pattern without
       a dedicated focus-trap library. -->
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
      aria-label="Workspace presets"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
        <div>
          <div class="text-sm font-medium text-text-primary">Workspace presets</div>
          <div class="text-xs text-text-muted/70 mt-0.5">
            Snapshot the current layout — route, panel widths, thread, sidebar state — to restore
            later.
          </div>
        </div>
        <button
          type="button"
          onclick={() => presetsModal.close()}
          class="text-text-muted hover:text-text-primary p-1 -m-1 rounded transition-colors"
          aria-label="Close presets"
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

      <!-- Save row -->
      <div class="px-5 py-3 border-b border-border-subtle bg-bg-surface/30 flex items-center gap-2">
        <input
          bind:this={saveInputEl}
          bind:value={saveName}
          type="text"
          placeholder="Save workspace as preset…"
          aria-label="Preset name"
          maxlength="80"
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleSave();
            }
          }}
          class="flex-1 bg-bg-deep border border-border-subtle rounded-md px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors"
          spellcheck="false"
          autocomplete="off"
        />
        <button
          type="button"
          onclick={handleSave}
          class="shrink-0 px-3 py-1.5 rounded-md text-xs font-mono uppercase tracking-widest bg-accent-cyan/10 border border-accent-cyan/40 text-accent-cyan hover:bg-accent-cyan/20 transition-colors"
        >
          Save
        </button>
      </div>

      <!-- List -->
      <div class="flex-1 overflow-y-auto py-2">
        {#if presets.presets.length === 0}
          <div class="px-5 py-10 text-center text-sm text-text-muted">
            No presets yet. Set up your layout, then save above.
          </div>
        {:else}
          {#each presets.presets as preset, idx (preset.id)}
            {@const renaming = renamingId === preset.id}
            {@const armed = deleteArmed === preset.id}
            <div
              class="mx-2 mb-1 px-3 py-2 rounded-md border border-transparent hover:border-border-subtle hover:bg-bg-surface/40 transition-colors"
            >
              <div class="flex items-center gap-2">
                <div class="flex-1 min-w-0">
                  {#if renaming}
                    <input
                      bind:this={renameInputEl}
                      bind:value={renameDraft}
                      type="text"
                      maxlength="80"
                      aria-label="Rename preset"
                      onkeydown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitRename();
                        }
                      }}
                      onblur={commitRename}
                      class="w-full bg-bg-deep border border-accent-cyan/40 rounded px-2 py-1 text-sm text-text-primary focus:outline-none"
                      spellcheck="false"
                      autocomplete="off"
                    />
                  {:else}
                    <div class="text-sm text-text-primary truncate">
                      {preset.name}
                    </div>
                    <div class="text-xs text-text-muted/70 truncate">
                      saved {relativeTime(preset.createdAt)} ·
                      {presetSummary(preset)}
                    </div>
                  {/if}
                </div>
                <button
                  type="button"
                  data-preset-first-apply={idx === 0 ? '' : undefined}
                  onclick={() => handleApply(preset)}
                  disabled={renaming}
                  class="shrink-0 px-2.5 py-1 rounded-md text-[10px] font-mono uppercase tracking-widest bg-accent-cyan text-bg-deep hover:bg-accent-cyan/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  aria-label="Apply preset {preset.name}"
                >
                  Apply
                </button>
                <button
                  type="button"
                  onclick={() => startRename(preset)}
                  disabled={renaming}
                  class="shrink-0 p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-surface disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  aria-label="Rename preset {preset.name}"
                  title="Rename"
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
                  onclick={() => handleDelete(preset)}
                  disabled={renaming}
                  class="preset-delete-btn shrink-0 px-2 py-1 rounded-md text-[10px] font-mono uppercase tracking-widest border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  class:armed
                  aria-label={armed
                    ? `Confirm delete preset ${preset.name}`
                    : `Delete preset ${preset.name}`}
                  title={armed ? 'Click again to confirm' : 'Delete'}
                >
                  {armed ? 'Confirm' : 'Delete'}
                </button>
              </div>
            </div>
          {/each}
        {/if}
      </div>

      <!-- Footer hint -->
      <div
        class="px-5 py-2 border-t border-border-subtle flex items-center gap-4 text-[10px] text-text-muted/70 font-mono"
      >
        <span><kbd class="text-text-muted">↵</kbd> save / commit rename</span>
        <span><kbd class="text-text-muted">esc</kbd> close / cancel</span>
        <span class="ml-auto">
          {presets.presets.length}
          preset{presets.presets.length === 1 ? '' : 's'}
        </span>
      </div>
    </div>
  </div>
{/if}

<style>
  /* The delete button is plain CSS so we can express the unarmed
     translucent-red border + hover state without bumping
     tailwind.config.js's content globs. Tailwind utility classes still
     handle layout (px / py / rounded / etc.) — only the colours that
     would require slash-escaped class tokens live here. */
  .preset-delete-btn {
    color: rgb(248, 113, 113);
    border-color: rgba(239, 68, 68, 0.4);
    background-color: transparent;
  }
  .preset-delete-btn:hover:not(:disabled):not(.armed) {
    background-color: rgba(239, 68, 68, 0.1);
  }
  .preset-delete-btn.armed {
    color: #fff;
    background-color: rgb(239, 68, 68);
    border-color: rgb(239, 68, 68);
  }
</style>
