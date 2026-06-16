export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** Parse `#rgb`, `#rrggbb` (with/without leading #). Returns null on anything else. */
export function parseHex(hex: string): Rgb | null {
  const normalized = hex.replace(/^#/, '');

  if (/^[0-9a-f]{3}$/i.test(normalized)) {
    const [r, g, b] = normalized.split('').map((channel) => parseInt(`${channel}${channel}`, 16));

    return { r, g, b };
  }

  if (/^[0-9a-f]{6}$/i.test(normalized)) {
    return {
      r: parseInt(normalized.slice(0, 2), 16),
      g: parseInt(normalized.slice(2, 4), 16),
      b: parseInt(normalized.slice(4, 6), 16)
    };
  }

  return null;
}

function linearChannel(channel: number): number {
  const srgb = channel / 255;

  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance per WCAG 2.1 (sRGB to linear). 0 (black) through 1 (white). */
export function relativeLuminance(c: Rgb): number {
  return 0.2126 * linearChannel(c.r) + 0.7152 * linearChannel(c.g) + 0.0722 * linearChannel(c.b);
}

/** WCAG contrast ratio between two colors, 1 through 21. Order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const aLuminance = relativeLuminance(a);
  const bLuminance = relativeLuminance(b);
  const lighter = Math.max(aLuminance, bLuminance);
  const darker = Math.min(aLuminance, bLuminance);

  return (lighter + 0.05) / (darker + 0.05);
}

/** Pick white or black, whichever has the higher contrast ratio against `bg`. */
export function readableTextColor(bg: string | Rgb): '#ffffff' | '#000000' {
  const background = typeof bg === 'string' ? (parseHex(bg) ?? WHITE) : bg;
  const whiteRatio = contrastRatio(background, WHITE);
  const blackRatio = contrastRatio(background, BLACK);

  return whiteRatio > blackRatio ? '#ffffff' : '#000000';
}

/** True when the ratio meets WCAG AA for normal text. */
export function meetsAA(a: Rgb, b: Rgb): boolean {
  return contrastRatio(a, b) >= 4.5;
}
