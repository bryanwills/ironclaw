# R96 — WCAG contrast util

**Lane**: A23 (codex). **Branch**: `codex/r96-contrast-util`.
Pure TS + Vitest. No gateway, client, Svelte, or Rust. Consumer: the
per-profile theme tint (R103) — pick a readable text color over an
arbitrary tint and warn when a pairing is too low-contrast.

## Owned files (exclusive)
- `src/lib/util/contrast.ts` — NEW.
- `src/lib/util/contrast.test.ts` — NEW.

## Forbidden
Everything else. Do NOT edit the tint/theme code — adopted later.

## API
```ts
export interface Rgb { r: number; g: number; b: number } // 0–255

/** Parse `#rgb`, `#rrggbb` (with/without leading #). Returns null on
 *  anything else. Case-insensitive. */
export function parseHex(hex: string): Rgb | null;

/** Relative luminance per WCAG 2.1 (sRGB → linear). 0 (black) … 1 (white). */
export function relativeLuminance(c: Rgb): number;

/** WCAG contrast ratio between two colors, 1 … 21. Order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number;

/** Pick '#ffffff' or '#000000' — whichever has the higher contrast ratio
 *  against `bg`. Ties → '#000000'. Accepts a hex string or Rgb; an
 *  unparseable string defaults to treating bg as white (→ '#000000'). */
export function readableTextColor(bg: string | Rgb): '#ffffff' | '#000000';

/** True when the ratio meets WCAG AA for normal text (>= 4.5). */
export function meetsAA(a: Rgb, b: Rgb): boolean;
```

## Acceptance
`npx vitest run src/lib/util/contrast.test.ts` green:
- `parseHex('#fff')` and `parseHex('ffffff')` → {255,255,255}; `parseHex('xyz')` → null.
- `contrastRatio(white, black)` ≈ 21 (within 0.1); identical colors → 1.
- `readableTextColor('#000000')` → '#ffffff'; `readableTextColor('#ffffff')` → '#000000'.
- `meetsAA(white, black)` true; `meetsAA` of two near-identical grays false.
- `relativeLuminance` higher for white than black.
- `npm run check` clean. No `any`, no `console.log`, no non-stdlib imports.
