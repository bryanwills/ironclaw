<script lang="ts">
  // Drag-to-resize handle for multi-pane layouts. Thin vertical strip with a
  // cyan glow on hover; cursor flips to col-resize. Mousedown captures the
  // pointer, mousemove computes a clamped width delta and pushes it back to
  // the parent via `onresize`, mouseup persists the final width to
  // localStorage. Double-click resets to `defaultWidth`.
  //
  // The handle stays purely behavioral — it never owns the pane width.
  // The parent component controls its grid/flex column via the value it
  // receives from `onresize`, which keeps the same width source-of-truth
  // for both the live drag and the persisted hydration on mount.
  //
  // Only `orientation: 'vertical'` is currently used (handle is a vertical
  // strip, drag motion is horizontal). The prop is kept for future
  // horizontal-strip handles without breaking the existing call sites.

  import { onMount } from 'svelte';

  type Props = {
    orientation?: 'vertical';
    min: number;
    max: number;
    defaultWidth: number;
    storageKey: string;
    onresize: (width: number) => void;
    /**
     * Optional initial width passed in by the parent. When omitted, the
     * handle reports the persisted value (or `defaultWidth` as a fallback)
     * via `onresize` from its mount effect so the parent can hydrate
     * without duplicating the localStorage read. Parents that already
     * own the read can pass it in to suppress the redundant call.
     */
    initialWidth?: number;
  };

  const {
    orientation = 'vertical',
    min,
    max,
    defaultWidth,
    storageKey,
    onresize,
    initialWidth
  }: Props = $props();

  let dragging = $state(false);
  /** Snapshot of the pane width at mousedown — the delta math is relative to
   *  this anchor so the cursor doesn't drift away from the strip during a
   *  long drag. */
  let startWidth = 0;
  /** Snapshot of clientX at mousedown. Paired with `startWidth` to compute
   *  the live width as `start + (clientX - startX)`. */
  let startX = 0;

  /**
   * Persist a width to localStorage. Failures (private mode, quota) degrade
   * silently — the next drag picks up the most recent successful write,
   * and a missing entry falls back to the parent's default.
   */
  function persist(width: number): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(storageKey, String(Math.round(width)));
      }
    } catch {
      // ignore
    }
  }

  /** Clamp a width to [min, max] before reporting it upstream. */
  function clamp(width: number): number {
    if (width < min) return min;
    if (width > max) return max;
    return width;
  }

  function onMouseMove(ev: MouseEvent): void {
    if (!dragging) return;
    const delta = ev.clientX - startX;
    const next = clamp(startWidth + delta);
    reportResize(next);
  }

  function onMouseUp(ev: MouseEvent): void {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    // Restore default cursor + user-select on body.
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Persist the final committed width (clamped against the latest delta).
    const delta = ev.clientX - startX;
    persist(clamp(startWidth + delta));
  }

  function onMouseDown(ev: MouseEvent): void {
    // Only respond to a primary-button press; ignore middle/right-click so
    // the user can still right-click the strip without entering drag mode.
    if (ev.button !== 0) return;
    ev.preventDefault();
    dragging = true;
    startX = ev.clientX;
    // Read the current width from the parent's perspective: prefer the
    // most recent value we pushed up (`lastReportedWidth`), then the
    // initialWidth prop, then defaultWidth. The parent's value is the
    // source of truth — we mirror it locally only as a drag anchor.
    startWidth = lastReportedWidth ?? initialWidth ?? defaultWidth;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    // Lock the cursor + suppress text selection across the page during the
    // drag so the user sees a consistent col-resize cursor regardless of
    // which element the pointer is over.
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function onDoubleClick(ev: MouseEvent): void {
    ev.preventDefault();
    reportResize(defaultWidth);
    persist(defaultWidth);
  }

  /** Latest width pushed upstream — used as the drag anchor so successive
   *  drags don't snap back to the persisted/default value when mousedown
   *  fires before the parent reads from localStorage. */
  let lastReportedWidth: number | null = $state(null);
  $effect(() => {
    if (initialWidth !== undefined) lastReportedWidth = initialWidth;
  });

  // Wrapper that records the latest width locally and forwards to the
  // parent. The drag listeners + the double-click reset + onMount all go
  // through this so `lastReportedWidth` stays in sync with what the
  // parent saw last, and a subsequent mousedown anchors against the
  // right value without forcing the parent to pass the width back in.
  function reportResize(width: number): void {
    lastReportedWidth = width;
    onresize(width);
  }

  /**
   * Read the persisted width from localStorage. Returns null when the key
   * is missing, malformed, or storage is unavailable. The parent decides
   * how to fall back (typically: defaultWidth).
   */
  function readPersisted(): number | null {
    try {
      if (typeof localStorage === 'undefined') return null;
      const raw = localStorage.getItem(storageKey);
      if (raw === null) return null;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return null;
      return clamp(parsed);
    } catch {
      return null;
    }
  }

  onMount(() => {
    // Hydrate on mount — parents that don't read localStorage themselves
    // get the persisted value pushed up here. Parents that already own
    // the read pass `initialWidth` explicitly; we still report once so
    // the handle's local drag anchor matches whatever the parent settled
    // on.
    const persisted = readPersisted();
    if (initialWidth === undefined) {
      reportResize(persisted ?? defaultWidth);
    } else {
      lastReportedWidth = initialWidth;
    }
  });
</script>

<!-- 4px-wide vertical strip. Sits between two panes; the parent renders it
     as a sibling of the panes inside a flex/grid row so it occupies its own
     track and never overlaps content. Hover lights up the cyan glow; active
     drag keeps the glow lit via the `dragging` state.
     The `role="separator"` is the WAI-ARIA pattern for a draggable splitter
     between two regions, so the a11y noninteractive-element check is
     suppressed below — the splitter pattern is the conventional one for
     resize handles even though it's technically a div with mouse listeners.
     A11y fix (Round 19b automated sweep): a focusable separator MUST carry
     `aria-valuenow`/`min`/`max` per WAI-ARIA 1.2 — axe flagged the missing
     attrs as `aria-required-attr` critical. We pair `lastReportedWidth`
     into `aria-valuenow` so screen readers can announce the pane width
     during a keyboard-driven resize once that lands. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  role="separator"
  aria-orientation="vertical"
  aria-label="Resize pane"
  aria-valuenow={lastReportedWidth ?? initialWidth ?? defaultWidth}
  aria-valuemin={min}
  aria-valuemax={max}
  tabindex="-1"
  class="resize-handle"
  class:dragging
  onmousedown={onMouseDown}
  ondblclick={onDoubleClick}
></div>

<style>
  .resize-handle {
    width: 4px;
    flex-shrink: 0;
    cursor: col-resize;
    background-color: transparent;
    position: relative;
    transition: background-color 120ms ease-out;
    user-select: none;
    /* Pull the hover surface a hair wider than the visible strip so the
       4px target isn't fiddly to grab. The pseudo-element below extends
       the hit zone +2px on each side without growing the layout column. */
  }

  .resize-handle::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: -2px;
    right: -2px;
  }

  .resize-handle:hover,
  .resize-handle.dragging {
    background-color: rgba(76, 167, 230, 0.6); /* accent-cyan @ 60% */
    box-shadow: 0 0 8px rgba(76, 167, 230, 0.4);
  }
</style>
