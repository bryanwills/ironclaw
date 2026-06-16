import { describe, expect, it } from 'vitest';
import { PERSONAS, getPersona, DEFAULT_PERSONA_ID } from './personas';

// Icon names that exist in the shared Icon set; personas must use one so
// the picker never renders a blank glyph.
const VALID_ICONS = new Set(['spark', 'shield', 'list', 'bolt', 'search', 'chat']);

describe('built-in personas', () => {
  it('every persona has the required shape + a valid icon', () => {
    expect(PERSONAS.length).toBeGreaterThanOrEqual(3);
    for (const p of PERSONAS) {
      expect(p.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.blurb.length).toBeGreaterThan(0);
      expect(VALID_ICONS.has(p.icon)).toBe(true);
      // A persona with a trivially short system prompt is a bug.
      expect(p.systemPrompt.length).toBeGreaterThan(120);
    }
  });

  it('persona ids are unique', () => {
    const ids = PERSONAS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('Chief of Staff is the flagship default and is substantive', () => {
    expect(DEFAULT_PERSONA_ID).toBe('chief-of-staff');
    const cos = getPersona('chief-of-staff');
    expect(cos).toBeDefined();
    // Spot-check the operating contract is actually present.
    expect(cos!.systemPrompt.toLowerCase()).toContain('chief of staff');
    expect(cos!.systemPrompt.toLowerCase()).toContain('recommendation');
  });

  it('getPersona returns undefined for an unknown id', () => {
    expect(getPersona('nope')).toBeUndefined();
  });
});
