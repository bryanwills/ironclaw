<script lang="ts">
  import { toasts, type ToastKind } from '$lib/stores/toasts.svelte';

  function bgFor(kind: ToastKind): string {
    switch (kind) {
      case 'success':
        // Green (positive) — was accent-cyan, which conflated success with
        // the primary accent. Aligned with v2 status semantics.
        return 'border-positive/60 text-positive';
      case 'error':
        return 'border-danger/60 text-danger';
      case 'info':
      default:
        return 'border-accent-gold/60 text-accent-gold';
    }
  }
</script>

<!-- Newest at top: iterate the queue in reverse so a fresh toast slots in
     above older ones still on screen. -->
<div class="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
  {#each toasts.toasts.slice().reverse() as t (t.id)}
    <div
      class="pointer-events-auto bg-bg-surface border rounded-md px-4 py-2.5 text-xs shadow-lg min-w-[220px] max-w-[360px] flex items-center gap-3 {bgFor(
        t.kind
      )}"
      role="status"
    >
      <span class="flex-1 leading-relaxed">{t.message}</span>
      <button
        type="button"
        onclick={() => toasts.dismiss(t.id)}
        class="text-text-muted hover:text-text-primary transition-colors"
        aria-label="Dismiss"
      >
        <svg
          viewBox="0 0 24 24"
          class="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  {/each}
</div>
