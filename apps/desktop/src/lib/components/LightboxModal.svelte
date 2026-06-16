<script lang="ts">
  // Image lightbox overlay used by the chat surface. Renders a dimmed
  // backdrop with the target image centred and constrained to 90% of the
  // viewport. The parent passes the image src (which may be a data: URL,
  // a blob: URL for still-pending attachments, or an http(s) URL the
  // markdown renderer emitted) and an `alt` for screen readers.
  //
  // Dismissal paths:
  //   - Click anywhere on the backdrop (not the image) → onClose().
  //   - Press Escape (listener bound at the window level so focus state
  //     doesn't matter — the lightbox owns the modal context while open).
  //
  // v1 intentionally skips pan / zoom. The image is rendered with
  // `object-contain` so its native aspect ratio is preserved and the
  // longest side stops at 90% of the viewport. If the source asset is
  // smaller than that, it renders at native size — we don't upscale.

  import { onMount } from 'svelte';

  interface Props {
    /** Image src — same URL the chat bubble used (data:, blob:, or http(s)). */
    src: string;
    /** Alt text for the image, falls back to a generic label. */
    alt?: string;
    /** Called when the user closes the lightbox via backdrop click or Esc. */
    onClose: () => void;
  }

  let { src, alt = 'Preview', onClose }: Props = $props();

  // Esc-to-close at the window level so it fires regardless of focus.
  // The chat surface might still own focus (textarea) when the user
  // opens the lightbox by clicking a thumbnail mid-compose.
  onMount(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Stop the click handler on the image itself from bubbling up to the
  // backdrop — otherwise tapping the picture would dismiss the overlay.
  function onImageClick(e: MouseEvent) {
    e.stopPropagation();
  }
</script>

<!-- Backdrop. Clicking anywhere outside the image dismisses. role="button"
     + keydown handler keeps the surface keyboard-accessible (Enter / Space
     on the backdrop closes too) even though the canonical close path is
     a click or Esc. -->
<div
  class="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-sm p-4"
  onclick={onClose}
  onkeydown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClose();
    }
  }}
  role="button"
  tabindex="-1"
  aria-label="Close image preview"
>
  <!-- Close button — visible in the top-right corner so users have an
       obvious exit beyond the backdrop. stopPropagation isn't needed
       because the button's onclick already calls onClose. -->
  <button
    type="button"
    onclick={(e) => {
      e.stopPropagation();
      onClose();
    }}
    class="absolute top-4 right-4 w-10 h-10 rounded-full bg-bg-deep/80 border border-border-subtle text-text-primary hover:bg-bg-surface transition-colors flex items-center justify-center"
    aria-label="Close"
    title="Close (Esc)"
  >
    <svg
      viewBox="0 0 24 24"
      class="w-5 h-5"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  </button>

  <!-- Image. max-w/h-[90vw/vh] caps the longest side; object-contain
       keeps the aspect ratio. We don't apply a border or shadow — the
       backdrop already isolates the asset visually. -->
  <!-- svelte-ignore a11y_img_redundant_alt -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <img
    {src}
    {alt}
    onclick={onImageClick}
    onkeydown={(e) => e.stopPropagation()}
    class="max-w-[90vw] max-h-[90vh] object-contain rounded-lg [box-shadow:var(--v2-shadow-elevated)]"
    draggable="false"
  />
</div>
