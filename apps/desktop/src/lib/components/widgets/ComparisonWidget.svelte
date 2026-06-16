<script lang="ts">
  import type { Widget as WidgetModel } from '$lib/api/types';
  import { cellText, normalizeTablePayload } from '$lib/util/table-payload';
  import Widget from './Widget.svelte';

  interface Props {
    widget: WidgetModel;
    surface: 'dashboard' | 'canvas' | 'chat';
  }

  let { widget, surface }: Props = $props();

  const comparison = $derived(normalizeTablePayload(widget.payload));
</script>

<Widget {widget} {surface}>
  {#if comparison.headers.length >= 3}
    <div class="overflow-x-auto">
      <table class="w-full border-collapse text-left text-xs">
        <thead class="text-text-primary">
          <tr>
            <th class="w-1/4 border-b border-border-subtle px-2 py-1.5 font-semibold">
              {comparison.headers[0]}
            </th>
            <th class="border-b border-border-subtle bg-accent-cyan/5 px-2 py-1.5 font-semibold">
              {comparison.headers[1]}
            </th>
            <th class="border-b border-border-subtle bg-accent-gold/5 px-2 py-1.5 font-semibold">
              {comparison.headers[2]}
            </th>
          </tr>
        </thead>
        <tbody class="text-text-muted">
          {#each comparison.rows as row, i (i)}
            <tr class="hover:bg-white/[0.025]">
              <th class="border-b border-border-subtle px-2 py-1.5 text-text-primary font-medium">
                {row[0] ?? ''}
              </th>
              <td class="border-b border-border-subtle px-2 py-1.5 align-top">{row[1] ?? ''}</td>
              <td class="border-b border-border-subtle px-2 py-1.5 align-top">{row[2] ?? ''}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <pre class="overflow-x-auto rounded-md bg-bg-surface p-2 text-xs text-text-muted">{cellText(
        widget.payload
      )}</pre>
  {/if}
</Widget>
