<script lang="ts" module>
  export const meta = {
    title: 'MarkdownView',
    description: 'Marked → DOMPurify renderer with hljs, GFM tables, callouts'
  };
</script>

<script lang="ts">
  import MarkdownView from '$lib/components/MarkdownView.svelte';

  // Default exercises every renderer override: heading anchor, callout,
  // fenced code with hljs lang, GFM table, inline code, blockquote.
  let markdown = $state(
    `# Heading 1
## Heading 2 (hover for anchor)

A paragraph with **bold**, _italic_, and \`inline code\`.

> [!NOTE]
> This is a NOTE callout.

> [!WARNING]
> This is a WARNING callout.

\`\`\`typescript
function greet(name: string): string {
  return \`hello, \${name}\`;
}
\`\`\`

| col a | col b | col c |
| ----- | ----- | ----- |
| 1     | 2     | 3     |
| 4     | 5     | 6     |

- bullet one
- bullet two
- bullet three

[link to anthropic.com](https://anthropic.com)
`
  );
</script>

<div class="grid grid-cols-[1fr_280px] gap-6 h-full">
  <div class="space-y-6 overflow-y-auto pr-2">
    <header>
      <h1 class="text-xl font-semibold text-text-primary">{meta.title}</h1>
      <p class="text-sm text-text-muted mt-1">{meta.description}</p>
    </header>

    <section class="surface p-6 min-h-[180px]">
      <div class="text-[10px] uppercase tracking-widest text-text-muted/80 font-semibold mb-3">
        Rendered output
      </div>
      <MarkdownView {markdown} />
    </section>

    <section>
      <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 mb-2 font-semibold">
        Example
      </h2>
      <pre
        class="bg-bg-deep border border-border-subtle rounded-md p-3 text-xs font-mono text-text-primary overflow-x-auto"><code
          >{`<MarkdownView markdown={mdString} />`}</code
        ></pre>
    </section>
  </div>

  <aside class="border-l border-border-subtle pl-4 space-y-4 text-xs overflow-y-auto">
    <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 font-semibold">Controls</h2>

    <label class="block">
      <span class="block text-text-muted mb-1">Markdown source</span>
      <textarea
        bind:value={markdown}
        rows="22"
        class="w-full bg-bg-deep border border-border-subtle rounded-md px-2 py-1.5 text-text-primary font-mono text-[11px] leading-snug"
      ></textarea>
    </label>

    <p class="text-[10px] text-text-muted/70 leading-snug">
      Sanitized via DOMPurify (html profile). Highlight.js loads bash, ts, js, rust, py, json, md,
      yaml, sql, ini, xml, css.
    </p>
  </aside>
</div>
