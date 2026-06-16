<!--
  Sparkline.svelte — inline-SVG sparkline primitive for compact trend cards.

  Three variants:
    - line:  thin polyline through the data points
    - bars:  vertical bars for count buckets (one bar per datum)
    - area:  line + filled region below for trends

  Auto-normalizes y to fit `height`, handles negative values, and renders
  a faint horizontal dash when `data` is empty. No chart-lib dependency —
  uses raw `<line>`, `<polyline>`, `<rect>` primitives.

  Defaults align with the IronClaw dark theme:
    - `color` falls back to the signal-blue accent (`var(--ironclaw-signal,
      #4ca7e6)` so it picks up CSS-level overrides where present, otherwise
      the Tailwind `accent.cyan` value).
    - `fillColor` for area variant falls back to a translucent tint of the
      same hue. Pass an explicit color to override (e.g. accent-gold).

  See `src/routes/admin/UsageDashboard.svelte`,
      `src/routes/routines/+page.svelte`,
      `src/routes/missions/EngineThreadDetail.svelte`
  for in-tree usage.
-->
<script lang="ts">
  type Props = {
    /** Series values, oldest → newest. Length 0 renders the empty dash. */
    data: number[];
    /** SVG width in px. Default 120. */
    width?: number;
    /** SVG height in px. Default 32. */
    height?: number;
    /** Render style. */
    variant?: 'line' | 'bars' | 'area';
    /** Stroke / bar fill. Default signal blue. */
    color?: string;
    /** Area-fill color. Defaults to `color` at low opacity. */
    fillColor?: string;
    /** Render the last value as inline text after the spark. */
    showValue?: boolean;
    /** Optional horizontal reference line, drawn at this y-data value. */
    threshold?: number;
  };

  let {
    data,
    width = 120,
    height = 32,
    variant = 'line',
    color = '#4ca7e6',
    fillColor,
    showValue = false,
    threshold
  }: Props = $props();

  // The empty-dash sentinel sits visually centered. Half-stroke padding so
  // a 1px stroke is fully visible at the SVG's vertical midpoint.
  const STROKE = 1.25;
  const PAD = STROKE; // 1.25px inset top/bottom so strokes don't clip

  // Bars get an explicit gap so they read as bars, not a filled rect.
  const BAR_GAP = 1;

  // Threshold style: dashed, low-opacity so it sits behind the series.
  const THRESHOLD_DASH = '2 2';

  /** Derive the area fillColor lazily from `color` so callers normally
   *  don't need to set both. We can't dynamically reduce opacity on a
   *  named/hex color without parsing it; the heuristic is good enough
   *  for the in-tree palette (hex + rgb()) and falls back to a generic
   *  translucent variant otherwise. */
  function resolveFill(c: string): string {
    if (fillColor) return fillColor;
    // 6-digit hex → append 33 (~20% alpha).
    if (/^#[0-9a-fA-F]{6}$/.test(c)) return `${c}33`;
    // 3-digit hex → expand then alpha.
    if (/^#[0-9a-fA-F]{3}$/.test(c)) {
      const r = c[1];
      const g = c[2];
      const b = c[3];
      return `#${r}${r}${g}${g}${b}${b}33`;
    }
    // rgb(r, g, b) → rgba with 0.2.
    const m = c.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
    if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, 0.2)`;
    // Fallback: use currentColor at low opacity via CSS — won't pick up
    // the actual `color` prop, but it produces a visible fill.
    return 'rgba(76, 167, 230, 0.2)';
  }

  // ─── Normalization ────────────────────────────────────────────────────
  //
  // Compute the y-domain from `data` (+ threshold so the reference line
  // never clips). When all values are equal, fall back to a tiny range
  // so a flat series renders as a centered line rather than collapsing
  // to a divide-by-zero. The mapping below produces a y-coordinate in
  // SVG space (top = 0).

  const stats = $derived.by(() => {
    if (data.length === 0) {
      return { min: 0, max: 1, range: 1, last: 0 };
    }
    let min = data[0];
    let max = data[0];
    for (const v of data) {
      if (Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (threshold !== undefined && Number.isFinite(threshold)) {
      if (threshold < min) min = threshold;
      if (threshold > max) max = threshold;
    }
    let range = max - min;
    if (range <= 0) range = 1; // flat series → render mid-line.
    return { min, max, range, last: data[data.length - 1] ?? 0 };
  });

  function yOf(v: number): number {
    // Top edge = max, bottom edge = min. PAD reserved at top/bottom so
    // strokes don't clip against the SVG boundary.
    const drawHeight = height - PAD * 2;
    if (drawHeight <= 0) return height / 2;
    const t = (v - stats.min) / stats.range;
    // Invert because SVG y grows downward.
    return PAD + (1 - t) * drawHeight;
  }

  // X coordinate for the i-th datum. Single-point series sits at the
  // visual center so a 1-element line still renders something visible.
  function xOf(i: number, n: number): number {
    if (n <= 1) return width / 2;
    const denom = n - 1;
    return (i / denom) * width;
  }

  // ─── Variant geometry ─────────────────────────────────────────────────

  /** Polyline points string for line/area variants. */
  const linePoints = $derived.by<string>(() => {
    if (data.length === 0) return '';
    const n = data.length;
    const parts: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const v = data[i];
      if (!Number.isFinite(v)) continue;
      parts.push(`${xOf(i, n).toFixed(2)},${yOf(v).toFixed(2)}`);
    }
    return parts.join(' ');
  });

  /** Closed polygon points for the area fill. Walks the data forwards,
   *  then drops to the bottom-right and back across the bottom. */
  const areaPoints = $derived.by<string>(() => {
    if (data.length === 0) return '';
    const n = data.length;
    const baseline = height - PAD;
    const parts: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const v = data[i];
      if (!Number.isFinite(v)) continue;
      parts.push(`${xOf(i, n).toFixed(2)},${yOf(v).toFixed(2)}`);
    }
    if (parts.length === 0) return '';
    // Close along the baseline.
    parts.push(`${xOf(n - 1, n).toFixed(2)},${baseline.toFixed(2)}`);
    parts.push(`${xOf(0, n).toFixed(2)},${baseline.toFixed(2)}`);
    return parts.join(' ');
  });

  /** Per-bar geometry for the bars variant. Width is the available slot
   *  minus the inter-bar gap; height starts at the value and reaches the
   *  baseline (or, for series with negative values, an interior zero). */
  type Bar = { x: number; y: number; w: number; h: number };
  const bars = $derived.by<Bar[]>(() => {
    if (data.length === 0) return [];
    const n = data.length;
    const slot = width / n;
    const w = Math.max(1, slot - BAR_GAP);
    // The bars baseline is the y-coordinate of the smaller of `0` or
    // `stats.min` — so a series of negative-only numbers still grows
    // downward from a sensible zero.
    const baselineValue = stats.min >= 0 ? stats.min : 0;
    const baselineY = yOf(baselineValue);
    const out: Bar[] = [];
    for (let i = 0; i < n; i += 1) {
      const v = data[i];
      if (!Number.isFinite(v)) continue;
      const valueY = yOf(v);
      const top = Math.min(valueY, baselineY);
      const h = Math.max(0.5, Math.abs(valueY - baselineY));
      out.push({
        x: i * slot + BAR_GAP / 2,
        y: top,
        w,
        h
      });
    }
    return out;
  });

  const thresholdY = $derived(
    threshold !== undefined && Number.isFinite(threshold) ? yOf(threshold) : null
  );

  // Inline-text formatter for `showValue`. Compact: `1.2k` / `3.4M`.
  function fmtValue(v: number): string {
    if (!Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(2);
  }

  const fill = $derived(resolveFill(color));
  const isEmpty = $derived(data.length === 0);
</script>

<span class="inline-flex items-center gap-1.5 align-middle">
  <svg
    {width}
    {height}
    viewBox="0 0 {width} {height}"
    role="img"
    aria-label="sparkline"
    class="block"
  >
    {#if isEmpty}
      <!-- Empty state: a faint horizontal dash so the slot still reads
           as "this is where the trend goes" rather than collapsing to
           empty space. -->
      <line
        x1={width * 0.25}
        x2={width * 0.75}
        y1={height / 2}
        y2={height / 2}
        stroke="currentColor"
        stroke-width={STROKE}
        stroke-linecap="round"
        opacity="0.25"
      />
    {:else}
      {#if thresholdY !== null}
        <line
          x1="0"
          x2={width}
          y1={thresholdY}
          y2={thresholdY}
          stroke={color}
          stroke-width={STROKE}
          stroke-dasharray={THRESHOLD_DASH}
          opacity="0.45"
        />
      {/if}

      {#if variant === 'bars'}
        {#each bars as bar, i (i)}
          <rect
            x={bar.x.toFixed(2)}
            y={bar.y.toFixed(2)}
            width={bar.w.toFixed(2)}
            height={bar.h.toFixed(2)}
            fill={color}
            rx="0.5"
          />
        {/each}
      {:else if variant === 'area'}
        <polygon points={areaPoints} {fill} stroke="none" />
        <polyline
          points={linePoints}
          fill="none"
          stroke={color}
          stroke-width={STROKE}
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      {:else}
        <!-- line (default) -->
        <polyline
          points={linePoints}
          fill="none"
          stroke={color}
          stroke-width={STROKE}
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      {/if}
    {/if}
  </svg>
  {#if showValue}
    <span class="text-[10px] font-mono text-text-muted leading-none">
      {isEmpty ? '—' : fmtValue(stats.last)}
    </span>
  {/if}
</span>
