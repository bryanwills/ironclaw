<script lang="ts">
  import type { Widget as WidgetModel } from '$lib/api/types';
  import Mermaid from '$lib/components/markdown-renderers/Mermaid.svelte';
  import Widget from './Widget.svelte';

  interface Props {
    widget: WidgetModel;
    surface: 'dashboard' | 'canvas' | 'chat';
  }

  let { widget, surface }: Props = $props();

  const source = $derived(
    typeof widget.payload === 'string' ? widget.payload : JSON.stringify(widget.payload, null, 2)
  );
</script>

<Widget {widget} {surface}>
  <div class="overflow-x-auto rounded-md border border-border-subtle bg-bg-surface p-2">
    <Mermaid {source} />
  </div>
</Widget>
