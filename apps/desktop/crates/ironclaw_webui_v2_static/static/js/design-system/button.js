/**
 * Button
 *
 * Single component — all visual styling via Tailwind utilities over --v2-*
 * tokens. Primary is FLAT signal blue (--v2-accent): the brand's one accent,
 * no gradients, no glow (DESIGN.md motion/color law), correct in both themes.
 *
 * Props
 *   variant   "primary" | "outline" | "secondary" | "ghost" | "danger"
 *   size      "sm" | "md" (default) | "lg" | "icon" | "icon-sm"
 *   fullWidth boolean
 *   as        "button" | "a" (renders anchor; pass href via ...props)
 *   className string — for layout/spacing overrides (margin, width, etc.)
 *   children
 *   ...rest   forwarded to the element (type, disabled, onClick, href, …)
 */
import { html } from '../lib/html.js';
import { cn } from '../utils/cn.js';

/* ── Base ──────────────────────────────────────────────────────────── */

const BASE =
  'inline-flex items-center justify-center font-semibold select-none ' +
  'disabled:cursor-not-allowed disabled:opacity-50 ' +
  'focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-[var(--v2-accent)]/50 focus-visible:ring-offset-1 ' +
  'focus-visible:ring-offset-[var(--v2-canvas)]';

/* ── Size classes ──────────────────────────────────────────────────── */

const SIZES = {
  sm: 'h-8 rounded-[6px] px-3 text-xs',
  md: 'min-h-[40px] rounded-[8px] px-3.5 text-[13px] md:min-h-[44px] md:px-4 md:text-sm',
  lg: 'min-h-[48px] rounded-[10px] px-5 text-sm',
  icon: 'h-[40px] w-[40px] rounded-[8px] md:h-[44px] md:w-[44px]',
  'icon-sm': 'h-8 w-8 rounded-[6px]'
};

/* ── Variant classes ───────────────────────────────────────────────── */

const VARIANTS = {
  primary:
    'border border-transparent bg-[var(--v2-accent-btn)] text-white ' +
    'hover:bg-[color-mix(in_srgb,var(--v2-accent-btn)_88%,#000)] ' +
    'active:bg-[color-mix(in_srgb,var(--v2-accent-btn)_88%,#000)]',

  outline:
    'border border-[color-mix(in_srgb,var(--v2-accent)_55%,transparent)] bg-transparent ' +
    'text-[var(--v2-accent-text)] ' +
    'hover:bg-[color-mix(in_srgb,var(--v2-accent)_10%,transparent)] ' +
    'hover:border-[var(--v2-accent)] ' +
    'active:bg-[color-mix(in_srgb,var(--v2-accent)_16%,transparent)]',

  secondary:
    'border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] text-[var(--v2-text-strong)] ' +
    'hover:bg-[var(--v2-surface-muted)] ' +
    'hover:border-[color-mix(in_srgb,var(--v2-accent)_30%,var(--v2-panel-border))]',

  ghost:
    'border border-transparent bg-transparent text-[var(--v2-text-muted)] ' +
    'hover:bg-[var(--v2-surface-soft)] hover:text-[var(--v2-text-strong)]',

  danger:
    'border border-[color-mix(in_srgb,var(--v2-danger-text)_55%,transparent)] bg-transparent ' +
    'text-[var(--v2-danger-text)] ' +
    'hover:bg-[color-mix(in_srgb,var(--v2-danger-text)_8%,transparent)] ' +
    'active:bg-[color-mix(in_srgb,var(--v2-danger-text)_14%,transparent)]'
};

/* ── Component ─────────────────────────────────────────────────────── */

export function Button({
  children,
  className = '',
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  as: Tag = 'button',
  ...rest
}) {
  const sizeClass = SIZES[size] ?? SIZES.md;
  const fullClass = fullWidth ? 'w-full' : '';
  const variantClass = VARIANTS[variant] ?? VARIANTS.outline;

  return html`
    <${Tag} className=${cn(BASE, sizeClass, fullClass, variantClass, className)} ...${rest}>
      ${children}
    <//>
  `;
}
