<!--
  CronPreview.svelte — inline human-readable cron description.

  Renders a small, muted-gold preview of what a cron expression will
  do, or a red warning for unparseable input. Pure presentational; the
  parsing lives in `$lib/utils/cron.ts`.

  Usage:
    <CronPreview expr="0 9 * * 1-5" />          → "📅 Every weekday at 9:00 AM"
    <CronPreview expr="bogus" />                → "⚠ Invalid cron expression"

  The icon is an inline SVG (calendar / alert-triangle) rather than the
  shared `<Icon>` component because the design system set doesn't yet
  ship a calendar glyph and we want to keep this preview self-contained
  for future re-use outside the Routines surface.
-->
<script lang="ts">
  import { describeCron } from '$lib/utils/cron';

  interface Props {
    /** Cron expression to describe. Empty / undefined renders nothing. */
    expr: string | undefined | null;
    /** Optional extra classes appended to the outer span (e.g. `font-mono`). */
    classes?: string;
  }

  let { expr, classes = '' }: Props = $props();

  // Derive the parsed description from the raw input. `describeCron`
  // tolerates undefined / empty by returning the invalid sentinel,
  // but rendering nothing at all is friendlier than flashing the red
  // "Invalid" tag when the routine genuinely has no schedule.
  const description = $derived(describeCron(expr ?? ''));
  const empty = $derived(!expr || expr.trim().length === 0);
</script>

{#if empty}
  <!-- Nothing to preview. Render an empty span so consumers can still
       reserve layout slots without conditional blocks at the call site. -->
  <span class="inline-block {classes}"></span>
{:else if description.valid}
  <span
    class="inline-flex items-center gap-1 text-[11px] text-accent-gold/80 {classes}"
    title={description.text}
  >
    <!-- Inline calendar icon. 12px to match the surrounding text-[11px]
         line-height; aria-hidden because the text label is the actual
         a11y signal. -->
    <svg
      viewBox="0 0 24 24"
      class="w-3 h-3 shrink-0"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
    <span>{description.text}</span>
  </span>
{:else}
  <span
    class="inline-flex items-center gap-1 text-[11px] text-red-400 {classes}"
    role="alert"
    aria-label="Invalid cron expression"
  >
    <!-- Inline alert-triangle. Same aria pattern: text carries the
         meaning, icon is decorative. -->
    <svg
      viewBox="0 0 24 24"
      class="w-3 h-3 shrink-0"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path
        d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
      />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
    <span>{description.text}</span>
  </span>
{/if}
