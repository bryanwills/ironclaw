<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { confirmDialog } from '$lib/stores/confirm.svelte';

  const titleId = 'confirm-dialog-title';
  const bodyId = 'confirm-dialog-body';

  let dialogEl = $state<HTMLDivElement | null>(null);
  let cancelButton = $state<HTMLButtonElement | null>(null);
  let wasOpen = false;

  const confirmClasses = $derived(
    confirmDialog.tone === 'danger'
      ? 'border-danger/60 bg-danger-soft text-danger hover:border-danger hover:bg-danger-soft focus:ring-danger/40'
      : 'border-signal/60 bg-signal-soft text-signal-text hover:border-signal hover:bg-signal-soft focus:ring-signal/40'
  );

  $effect(() => {
    if (confirmDialog.open && !wasOpen) {
      wasOpen = true;
      void focusCancel();
    } else if (!confirmDialog.open && wasOpen) {
      wasOpen = false;
    }
  });

  async function focusCancel(): Promise<void> {
    await tick();
    cancelButton?.focus();
  }

  function focusableElements(): HTMLElement[] {
    if (!dialogEl) return [];
    return Array.from(
      dialogEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => !el.hasAttribute('disabled'));
  }

  function trapTab(e: KeyboardEvent): void {
    const focusable = focusableElements();
    if (focusable.length === 0) {
      e.preventDefault();
      dialogEl?.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (!(active instanceof HTMLElement) || !focusable.includes(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }

    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
      return;
    }

    if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  onMount(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (!confirmDialog.open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        confirmDialog.cancel();
        return;
      }
      if (e.key === 'Tab') {
        e.stopImmediatePropagation();
        trapTab(e);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  onDestroy(() => {
    if (confirmDialog.open) {
      confirmDialog.cancel();
    }
  });
</script>

{#if confirmDialog.open}
  <button
    type="button"
    aria-label="Cancel confirmation"
    class="fixed inset-0 z-[110] bg-black/65 backdrop-blur-sm cursor-default"
    onclick={() => confirmDialog.cancel()}
  ></button>

  <div class="fixed inset-0 z-[111] flex items-center justify-center p-4 pointer-events-none">
    <div
      bind:this={dialogEl}
      class="v2-modal-shell w-[min(440px,calc(100vw-2rem))] p-6 space-y-5 pointer-events-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      tabindex="-1"
    >
      <header class="space-y-2">
        <h2 id={titleId} class="text-lg font-semibold text-text-primary leading-tight">
          {confirmDialog.title}
        </h2>
        <p id={bodyId} class="text-sm text-text-muted leading-relaxed">
          {confirmDialog.body}
        </p>
      </header>

      <footer class="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-3">
        <button
          bind:this={cancelButton}
          type="button"
          onclick={() => confirmDialog.cancel()}
          class="min-h-[44px] px-4 py-2 rounded-md border border-border-subtle text-sm font-semibold text-text-primary bg-bg-surface hover:border-accent-cyan hover:text-accent-cyan transition-colors focus:outline-none focus:ring-2 focus:ring-accent-cyan/40"
        >
          {confirmDialog.cancelLabel}
        </button>
        <button
          type="button"
          onclick={() => confirmDialog.accept()}
          class={`min-h-[44px] px-4 py-2 rounded-md border text-sm font-semibold transition-colors focus:outline-none focus:ring-2 ${confirmClasses}`}
        >
          {confirmDialog.confirmLabel}
        </button>
      </footer>
    </div>
  </div>
{/if}
