<script lang="ts">
  import type { Widget as WidgetModel } from '$lib/api/types';
  import Plotly from '$lib/components/markdown-renderers/Plotly.svelte';
  import Widget from './Widget.svelte';

  interface Props {
    widget: WidgetModel;
    surface: 'dashboard' | 'canvas' | 'chat';
  }

  let { widget, surface }: Props = $props();

  const source = $derived(
    typeof widget.payload === 'string' ? widget.payload : JSON.stringify(widget.payload)
  );
</script>

<Widget {widget} {surface}>
  <div class="min-h-[180px]">
    <Plotly {source} />
  </div>
</Widget>
