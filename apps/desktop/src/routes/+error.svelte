<script lang="ts">
  // Route-level error boundary.
  //
  // Renders when SvelteKit catches an uncaught error in a route's
  // `load` function, in a render path, or via the `error()` helper.
  // `page.error` is shaped by `App.Error` in `src/app.d.ts` and
  // produced by `handleError` in `src/hooks.client.ts`.
  //
  // The page replaces the route's normal content but leaves the
  // sidebar + chrome from `+layout.svelte` intact, so the user can
  // navigate away without reloading. That's the whole point of the
  // boundary: catastrophe is scoped to the broken route, not the app.
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { open as shellOpen } from '@tauri-apps/plugin-shell';
  import { toasts } from '$lib/stores/toasts.svelte';

  const ISSUE_URL = 'https://github.com/nearai/ironclaw-desktop-app/issues/new';

  let messageOpen = $state(true);
  let stackOpen = $state(false);

  const status = $derived(page.status);
  const message = $derived(page.error?.message ?? 'Unknown error');
  const stack = $derived(page.error?.stack);

  function reload() {
    window.location.reload();
  }

  function goHome() {
    void goto('/dashboard');
  }

  async function copyError() {
    const payload = stack ? `${message}\n\n${stack}` : message;
    try {
      await navigator.clipboard.writeText(payload);
      toasts.show('Error copied', 'success');
    } catch (e) {
      // Clipboard can fail in restricted contexts; surface but don't
      // re-throw — we're already on the error page.
      // eslint-disable-next-line no-console
      console.error('clipboard write failed:', e);
      toasts.show('Copy failed', 'error');
    }
  }

  async function reportIssue() {
    try {
      await shellOpen(ISSUE_URL);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('shell open failed:', e);
      toasts.show("Couldn't open issue tracker", 'error');
    }
  }
</script>

<div class="min-h-full w-full flex items-start justify-center px-6 py-12">
  <div class="surface w-full max-w-2xl p-8 flex flex-col gap-6">
    <header class="flex flex-col gap-2">
      <div class="flex items-center gap-3">
        <svg
          viewBox="0 0 24 24"
          class="w-6 h-6 text-red-400"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <h1 class="text-xl font-semibold text-text-primary">This page hit an error</h1>
      </div>
      <p class="text-sm text-text-muted leading-relaxed">
        The rest of IronClaw is running. Use the sidebar to move on, or report the issue if it
        repeats.
        {#if status && status !== 500}
          <span class="text-text-muted/70">(status {status})</span>
        {/if}
      </p>
    </header>

    <!-- Error message: collapsible, mono. Open by default since this is
         the primary signal the user needs. -->
    <details
      class="bg-bg-deep border border-border-subtle rounded-md"
      open={messageOpen}
      ontoggle={(e) => (messageOpen = (e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary
        class="cursor-pointer select-none px-4 py-2.5 text-xs uppercase tracking-wider text-text-muted hover:text-text-primary transition-colors"
      >
        Error message
      </summary>
      <pre
        class="px-4 pb-4 pt-1 text-xs font-mono text-red-300 whitespace-pre-wrap break-words leading-relaxed">{message}</pre>
    </details>

    <!-- Stack trace: collapsed by default to avoid wall-of-text. Only
         present when running against a dev build (see handleError). -->
    {#if stack}
      <details
        class="bg-bg-deep border border-border-subtle rounded-md"
        open={stackOpen}
        ontoggle={(e) => (stackOpen = (e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary
          class="cursor-pointer select-none px-4 py-2.5 text-xs uppercase tracking-wider text-text-muted hover:text-text-primary transition-colors"
        >
          Stack trace
        </summary>
        <pre
          class="px-4 pb-4 pt-1 text-[11px] font-mono text-text-muted whitespace-pre-wrap break-words leading-relaxed max-h-80 overflow-auto">{stack}</pre>
      </details>
    {/if}

    <div class="flex flex-wrap gap-2 pt-2">
      <button
        type="button"
        onclick={reload}
        class="px-3 py-1.5 text-xs rounded-md bg-accent-cyan/15 border border-accent-cyan/40 text-accent-cyan hover:bg-accent-cyan/25 transition-colors"
      >
        Reload
      </button>
      <button
        type="button"
        onclick={goHome}
        class="px-3 py-1.5 text-xs rounded-md bg-bg-deep border border-border-subtle text-text-primary hover:border-accent-gold/60 hover:text-accent-gold transition-colors"
      >
        Home
      </button>
      <button
        type="button"
        onclick={copyError}
        class="px-3 py-1.5 text-xs rounded-md bg-bg-deep border border-border-subtle text-text-primary hover:border-accent-gold/60 hover:text-accent-gold transition-colors"
      >
        Copy error
      </button>
      <button
        type="button"
        onclick={reportIssue}
        class="px-3 py-1.5 text-xs rounded-md bg-bg-deep border border-border-subtle text-text-primary hover:border-accent-gold/60 hover:text-accent-gold transition-colors"
      >
        Report issue
      </button>
    </div>
  </div>
</div>
