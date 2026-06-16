<script lang="ts">
  // R45 codex P0: KaTeX renderToString output is rendered via {@html}.
  // KaTeX has had several CVEs around macro expansion injecting raw
  // HTML; pipe the output through DOMPurify before injection. The
  // strict: 'ignore' flag is also set so KaTeX silently drops the
  // macros that would otherwise blow up.
  import DOMPurify from 'dompurify';

  interface Props {
    source: string;
    display?: boolean;
  }

  let { source, display = false }: Props = $props();
  let html = $state<string | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    let cancelled = false;
    html = null;
    error = null;

    (async () => {
      try {
        const katex = (await import('katex')).default;
        await import('katex/dist/katex.min.css');
        const out = katex.renderToString(source, {
          displayMode: display,
          throwOnError: true,
          output: 'html',
          // Reject inputs that use \href or other surface that could
          // produce a javascript: link. The default already rejects
          // many of these, but explicit is safer.
          trust: false,
          strict: 'ignore'
        });
        if (cancelled) return;
        const clean = DOMPurify.sanitize(out, {
          USE_PROFILES: { html: true, svg: true },
          FORBID_TAGS: ['script'],
          FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover']
        });
        html = clean;
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
  <code class="text-xs text-red-300" title={`Math render failed: ${error}`}>{source}</code>
{:else if html}
  <span class={display ? 'block my-2' : 'inline'} data-renderer-ready="math">{@html html}</span>
{:else}
  <code class="text-xs text-text-muted">{source}</code>
{/if}
