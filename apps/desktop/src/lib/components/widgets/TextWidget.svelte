<script lang="ts">
  import type { Widget as WidgetModel } from '$lib/api/types';
  import MarkdownView from '$lib/components/MarkdownView.svelte';
  import Widget from './Widget.svelte';

  interface Props {
    widget: WidgetModel;
    surface: 'dashboard' | 'canvas' | 'chat';
  }

  let { widget, surface }: Props = $props();

  const markdown = $derived(
    typeof widget.payload === 'string' ? widget.payload : JSON.stringify(widget.payload, null, 2)
  );
</script>

<Widget {widget} {surface}>
  <div class="max-h-[420px] overflow-y-auto text-sm text-text-primary">
    <MarkdownView {markdown} />
  </div>
</Widget>
