<script lang="ts">
  // Inline skill-editor modal (R65 — Lane B8).
  //
  // Right-click the output of a skill tool call in chat → "Edit this
  // skill…" pops this modal pre-filled with the skill's current source.
  // Save round-trips back to the gateway via
  // `IronClawClient.updateSkillScript()` (when the gateway grows the
  // endpoint) and the change hot-reloads — no restart, no redeploy.
  // Until that endpoint lands, Save stashes the draft to localStorage
  // so the user's bytes survive a reload (see the store's `stashLocally`
  // path for the fallback contract).
  //
  // Trigger paths:
  //   - Cmd+Shift+E from anywhere outside onboarding (this lane wires
  //     the chord into `+layout.svelte`; the chord-only open carries
  //     no skill context and is the QA hook).
  //   - Right-click on a tool-call output in chat (a later patch wires
  //     this — the consumer calls `skillEditor.load(skill)` followed by
  //     `skillEditor.show()`, the modal is identical from there).
  //
  // Keyboard contract:
  //   - Esc → `skillEditor.hide()` (dirty-confirm gate in the store).
  //   - Cmd+Enter → `handleSave()` (works while focus is in the textarea).
  //   - Tab cycles inside the dialog (browser default; no focus trap —
  //     the surrounding overlay is `role=dialog` + `aria-modal=true`
  //     which is enough for the screen-readers we test against).
  //
  // The store owns the open-state + dirty tracking; this component is a
  // thin presentation layer. The textarea autofocuses on mount via an
  // `$effect` (mirroring PerThreadPromptModal's pattern).

  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { skillEditor } from '$lib/stores/skill-editor.svelte';

  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  // Title falls back to "Edit skill" when the modal was opened via the
  // Cmd+Shift+E chord with no skill context. This is the QA hook — the
  // primary entry point (right-click on tool output) always loads a
  // skill before showing.
  const titleText = $derived(
    skillEditor.skill ? `Edit skill — ${skillEditor.skill.name}` : 'Edit skill'
  );

  // The store derives `dirty` from draft vs skill.script; we mirror the
  // "*" affordance from that. The asterisk hugs the title so a glance
  // tells the user whether their Save button does anything.
  const dirtyMarker = $derived(skillEditor.dirty ? ' *' : '');

  // Autofocus + cursor-to-end when the modal opens. PerThreadPromptModal
  // uses the same pattern — the modal node is created in the same task
  // as the `open` flip, so we wait one tick before reaching for the
  // textarea ref.
  $effect(() => {
    if (!skillEditor.open) return;
    void (async () => {
      await tick();
      textareaEl?.focus();
      const len = textareaEl?.value.length ?? 0;
      textareaEl?.setSelectionRange(len, len);
    })();
  });

  // Window-level Esc handler so the modal closes even when focus moved
  // out of the textarea. Mirrors PerThreadPromptModal.
  onMount(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!skillEditor.open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        skillEditor.hide();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  async function handleSave() {
    if (skillEditor.saving) return;
    try {
      await skillEditor.save();
      // Successful save closes the modal — the user's intent ("save and
      // get back to chat") is the common case. The store rolls
      // `skill.script` forward and clears the stash; closing resets the
      // rest of the state.
      skillEditor.open = false;
      skillEditor.skill = null;
      skillEditor.draft = '';
    } catch {
      // The store has already populated `skillEditor.error` — leave the
      // modal open so the user can see the banner and retry / copy the
      // draft out.
    }
  }

  // Cmd+Enter while the textarea has focus saves. The window-level Esc
  // handler covers close; this one is local because Cmd+Enter is the
  // canonical "submit form" chord and the user expects it to work from
  // inside the editor.
  function onTextareaKeyDown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      void handleSave();
    }
  }
</script>

{#if skillEditor.open}
  <!-- Backdrop. Click anywhere outside the card to dismiss — the store
       owns the dirty-confirm gate so this stays a one-liner. -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    onclick={() => skillEditor.hide()}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        skillEditor.hide();
      }
    }}
    role="button"
    tabindex="-1"
    aria-label="Close skill editor"
  >
    <!-- Card. stopPropagation so clicks inside don't bubble to the
         backdrop. Wider than the per-thread prompt modal because skill
         source can run long — the textarea wants horizontal real estate. -->
    <div
      class="v2-modal-shell w-[min(800px,calc(100vw-2rem))] max-h-[calc(100vh-4rem)] flex flex-col p-6 space-y-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="skill-editor-title"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      tabindex="-1"
    >
      <header class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <h2 id="skill-editor-title" class="text-lg font-semibold text-text-primary truncate">
            {titleText}{dirtyMarker}
          </h2>
          {#if skillEditor.skill?.description}
            <p class="text-xs text-text-muted truncate mt-0.5">
              {skillEditor.skill.description}
            </p>
          {/if}
        </div>
        <button
          type="button"
          onclick={() => skillEditor.hide()}
          class="text-text-muted hover:text-text-primary transition-colors p-1 -m-1 min-h-[44px] min-w-[44px] flex items-center justify-center"
          aria-label="Close"
        >
          <Icon name="close" class="w-4 h-4" />
        </button>
      </header>

      <div class="flex-1 min-h-0 flex flex-col gap-2">
        <label for="skill-editor-textarea" class="sr-only"> Skill source </label>
        <textarea
          id="skill-editor-textarea"
          bind:this={textareaEl}
          bind:value={skillEditor.draft}
          onkeydown={onTextareaKeyDown}
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          placeholder="# Skill source goes here…"
          style="min-height: 400px;"
          class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:border-accent-cyan transition-colors resize-y"
        ></textarea>
      </div>

      {#if skillEditor.error}
        <!-- Error banner. Surfaces gateway failures (no endpoint, no
             token, server-side rejection) inline so the user knows why
             Save didn't take. The store clears `error` on the next
             save attempt. -->
        <div
          class="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300"
          role="alert"
        >
          {skillEditor.error}
        </div>
      {/if}

      <footer class="flex items-center justify-between gap-3 pt-1">
        <button
          type="button"
          onclick={() => skillEditor.hide()}
          class="text-sm text-text-muted hover:text-text-primary transition-colors min-h-[44px] px-3"
        >
          Cancel
        </button>
        <button
          type="button"
          onclick={() => void handleSave()}
          disabled={skillEditor.saving}
          class="px-4 py-2 rounded-md bg-accent-cyan text-bg-deep text-sm font-semibold hover:brightness-110 transition min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {#if skillEditor.saving}
            <!-- Small spinner — matches the loading affordance used
                 elsewhere in the chat composer. Pure CSS so it renders
                 even when the page is offline. -->
            <span
              class="inline-block w-3 h-3 rounded-full border-2 border-bg-deep/40 border-t-bg-deep animate-spin"
              aria-hidden="true"
            ></span>
            Saving…
          {:else}
            Save
          {/if}
        </button>
      </footer>
    </div>
  </div>
{/if}
