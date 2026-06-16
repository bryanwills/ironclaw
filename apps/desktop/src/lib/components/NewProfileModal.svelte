<script lang="ts">
  // Small "+ New profile" modal. Used by the Sidebar profile dropdown to
  // spin up a fresh ProfileConfig and switch to it. The new profile is
  // empty (defaults — remote/127.0.0.1) so the user lands in /settings and
  // fills in URL + token from there.
  //
  // Owned state: name input + saving flag. The parent owns `open`.
  //
  // Behaviour:
  //   - Esc closes (handled by window-level keydown).
  //   - Click on backdrop closes.
  //   - Submit calls `addProfile` → `switchProfile` → goto /settings.
  //   - Disabled while saving so the user can't double-submit.

  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { addProfile } from '$lib/stores/settings.svelte';
  import { connection } from '$lib/stores/connection.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open = $bindable(), onClose }: Props = $props();

  let name = $state('');
  let saving = $state(false);
  let inputRef: HTMLInputElement | undefined = $state();

  // Validation: non-empty, < 64 chars (matches the cap inside `addProfile`).
  const trimmed = $derived(name.trim());
  const tooLong = $derived(trimmed.length >= 64);
  const canSubmit = $derived(trimmed.length > 0 && !tooLong && !saving);

  // Auto-focus the input when the modal opens; clear stale state on close.
  $effect(() => {
    if (open) {
      // Defer focus a frame so the input is mounted.
      queueMicrotask(() => inputRef?.focus());
    } else {
      name = '';
      saving = false;
    }
  });

  // Esc-to-close at the window level so it fires even if focus moved out
  // of the input (e.g. the user tabbed to the Cancel button).
  onMount(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  async function submit() {
    if (!canSubmit) return;
    saving = true;
    try {
      const profile = await addProfile(trimmed);
      await connection.switchProfile(profile.id);
      toasts.show(`Created profile "${profile.name}"`, 'success');
      onClose();
      // Navigate to settings so the user can fill in the URL + token.
      await goto('/settings#profiles');
    } catch (err) {
      toasts.show(`Could not create profile: ${(err as Error).message}`, 'error');
      saving = false;
    }
  }

  function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    void submit();
  }
</script>

{#if open}
  <!-- Backdrop. Click anywhere outside the card to dismiss. -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    onclick={onClose}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClose();
      }
    }}
    role="button"
    tabindex="-1"
    aria-label="Close new profile dialog"
  >
    <!-- Card. stopPropagation so backdrop clicks inside the card don't dismiss. -->
    <div
      class="v2-modal-shell w-[min(420px,calc(100vw-2rem))] p-6 space-y-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-profile-title"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      tabindex="-1"
    >
      <header class="space-y-1">
        <h2 id="new-profile-title" class="text-lg font-semibold text-text-primary">New profile</h2>
        <p class="text-xs text-text-muted">
          Profiles let you keep separate URLs, tokens, and modes for each gateway you connect to
          (e.g. abby-remote, local-sidecar).
        </p>
      </header>

      <form onsubmit={onSubmit} class="space-y-4">
        <div>
          <label for="new-profile-name" class="block text-xs text-text-muted mb-1">
            Profile name
          </label>
          <input
            id="new-profile-name"
            type="text"
            bind:value={name}
            bind:this={inputRef}
            maxlength="63"
            placeholder="baremetal3-remote"
            autocomplete="off"
            class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary focus:outline-none focus:border-accent-cyan transition-colors min-h-[44px]"
            class:border-red-500={tooLong}
          />
          {#if tooLong}
            <p class="text-xs text-red-400 mt-1">Name must be under 64 characters.</p>
          {/if}
        </div>

        <div class="flex items-center justify-end gap-3">
          <button
            type="button"
            onclick={onClose}
            disabled={saving}
            class="text-sm text-text-muted hover:text-text-primary transition-colors disabled:opacity-50 min-h-[44px] px-3"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            class="px-4 py-2 rounded-md bg-accent-cyan text-bg-deep text-sm font-semibold hover:brightness-110 transition disabled:opacity-50 min-h-[44px]"
          >
            {saving ? 'Creating…' : 'Create profile'}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}
