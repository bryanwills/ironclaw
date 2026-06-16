<!--
  Lightweight streaming renderer for in-flight assistant text. MarkdownView
  re-parses the whole buffer per token (marked + highlight.js + KaTeX +
  Mermaid), so the live path stays plain text; MarkdownView takes over
  automatically once message_end commits the completed turn to history.
-->
<script lang="ts">
  let { text = '' }: { text?: string } = $props();
</script>

<!-- prettier-ignore -->
<div class="streaming-text whitespace-pre-wrap break-words leading-relaxed">{text}<span class="streaming-caret" aria-hidden="true"></span></div>

<style>
  .streaming-caret {
    display: inline-block;
    width: 2px;
    height: 1em;
    margin-left: 2px;
    vertical-align: -0.125em;
    background: var(--v2-accent, currentColor);
    opacity: 0.35;
    animation: streaming-caret-pulse 1.15s ease-in-out infinite;
  }

  @keyframes streaming-caret-pulse {
    0%,
    100% {
      opacity: 0.18;
    }

    50% {
      opacity: 0.5;
    }
  }
</style>
