<script lang="ts">
  // Inline masked-value renderer with click-to-reveal toggle.
  //
  // Usage:
  //   <MaskedValue value="Bearer sk-agent-abc123…" />
  //
  // Behaviour:
  //   - Default: renders the value through `redactSecrets`. If no
  //     pattern matched the value passes through unchanged — there's
  //     no visual difference for non-secret strings, so callers can
  //     blanket-wrap any field without worrying about false positives
  //     making the UI look broken.
  //   - Click the eyeball: reveals the raw value with a warning
  //     overlay sigil. Click again: re-mask.
  //   - Keyboard: Space / Enter on the button mirrors a click; the
  //     button is the focusable element so the wrapper stays a span.
  //
  // The component is presentational — it never copies the value to
  // the clipboard, never logs, and never persists the reveal state.
  // A page refresh / unmount resets to masked. This is intentional;
  // reveal is a deliberate, transient action.

  import { redactSecrets, containsSecret, type RedactOptions } from '$lib/utils/redact';

  interface Props {
    /** The raw value to display. Strings only; cast non-strings at the call site. */
    value: string;
    /** Forwarded to `redactSecrets`. Defaults to full mask. */
    redactOptions?: RedactOptions;
    /** Optional extra classes applied to the outer span (e.g. `font-mono break-all`). */
    classes?: string;
    /**
     * If true, the reveal toggle is hidden — callers that want
     * read-only redaction (e.g. inline labels) can disable it.
     * Defaults to false.
     */
    locked?: boolean;
  }

  let { value, redactOptions = {}, classes = '', locked = false }: Props = $props();

  // Local reveal state. Stays in this component instance — no store
  // backing on purpose, so closing/reopening the parent surface
  // re-masks automatically.
  let revealed = $state(false);

  // Cheap probe: if the string has no token-shaped span, the eyeball
  // toggle adds no value (nothing to reveal). We still render the
  // string; just skip the button. `locked` forces the same path.
  const hasSecret = $derived(containsSecret(value));
  const showToggle = $derived(!locked && hasSecret);

  const displayed = $derived(revealed ? value : redactSecrets(value, redactOptions));

  function toggle() {
    revealed = !revealed;
  }
</script>

<span class="inline-flex items-center gap-1.5 max-w-full {classes}">
  <span
    class="font-mono break-all"
    class:text-accent-gold={revealed && hasSecret}
    title={revealed && hasSecret ? 'Secret visible' : undefined}
  >
    {displayed}
  </span>

  {#if showToggle}
    <button
      type="button"
      onclick={toggle}
      aria-pressed={revealed}
      aria-label={revealed ? 'Hide secret' : 'Reveal secret'}
      title={revealed ? 'Hide secret' : 'Reveal secret (visible on screen until clicked again)'}
      class="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded text-text-muted hover:text-accent-cyan focus:outline-none focus:text-accent-cyan transition-colors"
    >
      {#if revealed}
        <!-- Eye-off icon. Slash line over an eye outline so the
             "currently revealed, click to hide" state is unambiguous. -->
        <svg
          viewBox="0 0 24 24"
          class="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path
            d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
          />
          <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
      {:else}
        <!-- Eye icon. Open-state cue. -->
        <svg
          viewBox="0 0 24 24"
          class="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      {/if}
    </button>
  {/if}
</span>
