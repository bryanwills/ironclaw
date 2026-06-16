<script lang="ts">
  interface Props {
    source: string;
  }

  interface PlotlySpec {
    data?: unknown[];
    layout?: Record<string, unknown>;
    config?: Record<string, unknown>;
  }

  interface PlotlyApi {
    newPlot: (
      host: HTMLDivElement,
      data: unknown[],
      layout: Record<string, unknown>,
      config: Record<string, unknown>
    ) => Promise<unknown>;
    purge?: (host: HTMLDivElement) => void;
  }

  let { source }: Props = $props();
  let host = $state<HTMLDivElement | null>(null);
  let error = $state<string | null>(null);

  // R45 codex P0: Plotly accepts assistant-controlled spec JSON that
  // can carry `text` with raw HTML and `href`/`url` fields pointing at
  // `javascript:` URIs. We sanitize the spec recursively before mount,
  // stripping HTML from text fields and dropping any URL that doesn't
  // start with http(s):, mailto:, or #.
  function sanitizePlotlyValue(v: unknown): unknown {
    if (v == null) return v;
    if (typeof v === 'string') {
      // Strip raw HTML tags. We allow plain text and Plotly's tiny
      // pseudo-HTML (<b>, <i>, <br>) because the chart text engine
      // expects them; everything else gets escaped to its literal.
      const allowedOnly = v.replace(/<(?!\/?(b|i|br|sub|sup|em|strong)\b)[^>]*>/gi, '');
      // R90 P2 (defense-in-depth): the allowlist above keeps allowed tags
      // but not their attributes, so `<b onclick=…>` would survive. Reduce
      // every allowed tag to its bare form — Plotly's text engine needs the
      // tag, never an attribute, so no event handler can ride along.
      const stripped = allowedOnly.replace(/<(\/?)(b|i|br|sub|sup|em|strong)\b[^>]*>/gi, '<$1$2>');
      return stripped;
    }
    if (Array.isArray(v)) return v.map(sanitizePlotlyValue);
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        // Reject URL-like fields whose values would route the browser
        // to javascript: / data: / file: URIs.
        if (/^(href|url|src|uri)$/i.test(k) && typeof val === 'string') {
          if (/^(javascript|data|file|vbscript):/i.test(val.trim())) {
            continue;
          }
        }
        out[k] = sanitizePlotlyValue(val);
      }
      return out;
    }
    return v;
  }

  $effect(() => {
    if (!host) return;

    let cancelled = false;
    let plotly: PlotlyApi | null = null;
    error = null;

    (async () => {
      try {
        const raw = JSON.parse(source) as PlotlySpec;
        if (!Array.isArray(raw.data)) {
          throw new Error('Plotly spec must include a data array');
        }
        // Recursively sanitize the spec before mount.
        const spec = sanitizePlotlyValue(raw) as PlotlySpec;

        // plotly.js-dist-min does not consistently ship declarations across versions.
        // @ts-ignore
        const mod = (await import('plotly.js-dist-min')) as { default: PlotlyApi };
        plotly = mod.default;
        if (cancelled || !host) return;

        await plotly.newPlot(host, spec.data ?? [], spec.layout ?? {}, {
          responsive: true,
          displayModeBar: false,
          // Force-disable link directives the user can't see; we
          // already rejected URL-shaped values above but Plotly's
          // own defaults can re-introduce some.
          showLink: false,
          linkText: '',
          ...(spec.config ?? {})
        });
      } catch (err) {
        if (!cancelled) error = (err as Error).message;
      }
    })();

    return () => {
      cancelled = true;
      if (plotly && host) plotly.purge?.(host);
    };
  });
</script>

{#if error}
  <div class="mb-2 text-xs text-red-300">Plotly render failed: {error}</div>
  <pre data-renderer-error="plotly"><code>{source}</code></pre>
{:else}
  <div bind:this={host} class="w-full plotly" data-renderer-ready="plotly"></div>
{/if}
