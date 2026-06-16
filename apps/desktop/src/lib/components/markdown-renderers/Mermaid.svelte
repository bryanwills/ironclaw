<script lang="ts">
  // R45 codex P0: Mermaid SVG output is rendered via {@html} which
  // would otherwise allow assistant-controlled `<script>` /
  // `<foreignObject>` payloads to escape into the webview. We pipe
  // the SVG through DOMPurify with the SVG profile before injection.
  import DOMPurify from 'dompurify';

  interface Props {
    source: string;
  }

  let { source }: Props = $props();
  let svg = $state<string | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    let cancelled = false;
    svg = null;
    error = null;

    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
        const id = `mmd-${Math.random().toString(36).slice(2, 10)}`;
        const { svg: out } = await mermaid.render(id, source);
        if (cancelled) return;
        // SVG profile keeps geometry + styling, kills <script>,
        // <foreignObject>, on* handlers, and javascript: URIs.
        const clean = DOMPurify.sanitize(out, {
          USE_PROFILES: { svg: true, svgFilters: true },
          // Belt-and-braces: explicitly forbid the elements / attrs
          // mermaid sometimes emits via `click X callback` syntax.
          FORBID_TAGS: ['foreignObject', 'script'],
          FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover']
        });
        svg = clean;
      } catch (err) {
        if (!cancelled) error = (err as Error).message;
      }
    })();

    return () => {
      cancelled = true;
    };
  });
</script>

{#if error}
  <div class="mb-2 text-xs text-red-300">Mermaid render failed: {error}</div>
  <pre data-renderer-error="mermaid"><code>{source}</code></pre>
{:else if svg}
  <div class="md-mermaid" data-renderer-ready="mermaid">
    {@html svg}
  </div>
{:else}
  <div class="text-xs text-text-muted italic">Rendering diagram...</div>
{/if}
