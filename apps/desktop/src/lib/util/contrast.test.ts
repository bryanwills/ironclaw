import { describe, expect, it } from 'vitest';

import { contrastRatio, meetsAA, parseHex, readableTextColor, relativeLuminance } from './contrast';

const white = { r: 255, g: 255, b: 255 };
const black = { r: 0, g: 0, b: 0 };

describe('contrast util', () => {
  describe('parseHex', () => {
    it('parses three- and six-digit hex colors with or without #', () => {
      expect(parseHex('#fff')).toEqual(white);
      expect(parseHex('ffffff')).toEqual(white);
      expect(parseHex('#0aF')).toEqual({ r: 0, g: 170, b: 255 });
      expect(parseHex('123456')).toEqual({ r: 18, g: 52, b: 86 });
    });

    it('returns null for unsupported color strings', () => {
      expect(parseHex('xyz')).toBeNull();
      expect(parseHex('#ffff')).toBeNull();
      expect(parseHex('rgb(255, 255, 255)')).toBeNull();
    });
  });

  describe('relativeLuminance', () => {
    it('returns higher luminance for white than black', () => {
      expect(relativeLuminance(white)).toBeGreaterThan(relativeLuminance(black));
      expect(relativeLuminance(black)).toBe(0);
      expect(relativeLuminance(white)).toBeCloseTo(1);
    });
  });

  describe('contrastRatio', () => {
    it('returns about 21 for white against black', () => {
      expect(contrastRatio(white, black)).toBeCloseTo(21, 1);
      expect(contrastRatio(black, white)).toBeCloseTo(21, 1);
    });

    it('returns 1 for identical colors', () => {
      expect(contrastRatio(white, white)).toBe(1);
      expect(contrastRatio({ r: 120, g: 120, b: 120 }, { r: 120, g: 120, b: 120 })).toBe(1);
    });
  });

  describe('readableTextColor', () => {
    it('picks white for black backgrounds and black for white backgrounds', () => {
      expect(readableTextColor('#000000')).toBe('#ffffff');
      expect(readableTextColor('#ffffff')).toBe('#000000');
    });

    it('accepts Rgb values and treats unparseable strings as white', () => {
      expect(readableTextColor({ r: 1, g: 2, b: 3 })).toBe('#ffffff');
      expect(readableTextColor('not a color')).toBe('#000000');
    });
  });

  describe('meetsAA', () => {
    it('returns true for white against black', () => {
      expect(meetsAA(white, black)).toBe(true);
    });

    it('returns false for near-identical grays', () => {
      expect(meetsAA({ r: 120, g: 120, b: 120 }, { r: 124, g: 124, b: 124 })).toBe(false);
    });
  });
});
