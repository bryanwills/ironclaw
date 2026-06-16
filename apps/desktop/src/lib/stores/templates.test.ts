// Tests for the Prompt Templates store (R29c — saved composer prompts).
//
// The store is a runtime singleton with `$state`; each test resets the
// in-memory list directly (we avoid init() so the first-run sample seed
// doesn't fire). Coverage focuses on the pure, load-bearing logic that the
// modal / palette / slash-autocomplete all depend on:
//   - parseVariables: ordered de-duped {var} extraction
//   - add: name trim/fallback, variable parse, newest-first, MAX cap rollover
//   - update: re-derives variables on body change, no-op guards
//   - delete / recordUse
//   - render: single-pass substitution, unknown vars left intact
//   - templatesModal + composerInsert one-shot bus

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_TEMPLATES,
  composerInsert,
  parseVariables,
  templates,
  templatesModal,
  type PromptTemplate
} from './templates.svelte';

function makeTemplate(over: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: 'id-' + Math.random().toString(16).slice(2),
    name: 'T',
    body: '',
    variables: [],
    createdAt: new Date().toISOString(),
    useCount: 0,
    ...over
  };
}

function reset(): void {
  templates.templates = [];
  templatesModal.open = false;
  templatesModal.openForTemplate = null;
  // Drain any pending composer payload.
  composerInsert.consume();
}

describe('parseVariables', () => {
  it('extracts variables in first-occurrence order', () => {
    expect(parseVariables('Hello {name}, meet {friend}')).toEqual(['name', 'friend']);
  });

  it('de-duplicates repeated variables', () => {
    expect(parseVariables('{x} then {x} then {y}')).toEqual(['x', 'y']);
  });

  it('returns an empty list when there are no placeholders', () => {
    expect(parseVariables('no variables here')).toEqual([]);
  });

  it('ignores braces that are not \\w+ names', () => {
    // `-` is not a word char, so `{a-b}` is not a valid placeholder.
    expect(parseVariables('{a-b} {good}')).toEqual(['good']);
  });
});

describe('templates store', () => {
  beforeEach(reset);
  afterEach(reset);

  it('add: parses variables, defaults useCount, prepends newest-first', () => {
    templates.add('First', 'body one');
    const t = templates.add('Second', 'reach {target} by {date}');
    expect(t.variables).toEqual(['target', 'date']);
    expect(t.useCount).toBe(0);
    expect(t.id).toBeTruthy();
    // Newest-first: the second add is at the front.
    expect(templates.templates[0].name).toBe('Second');
    expect(templates.templates[1].name).toBe('First');
  });

  it('add: trims name to 80 chars and falls back to "Untitled template"', () => {
    const long = templates.add('x'.repeat(200), '');
    expect(long.name).toHaveLength(80);
    const blank = templates.add('   ', 'body');
    expect(blank.name).toBe('Untitled template');
  });

  it('add: rolls off the oldest entry once MAX_TEMPLATES is reached', () => {
    // Fill to the cap with synthetic rows, oldest identifiable at the tail.
    const filled: PromptTemplate[] = [];
    for (let i = 0; i < MAX_TEMPLATES; i++) {
      filled.push(makeTemplate({ name: i === MAX_TEMPLATES - 1 ? 'oldest' : `t${i}` }));
    }
    templates.templates = filled;
    templates.add('newest', '');
    expect(templates.templates).toHaveLength(MAX_TEMPLATES);
    expect(templates.templates[0].name).toBe('newest');
    expect(templates.templates.some((t) => t.name === 'oldest')).toBe(false);
  });

  it('update: re-derives variables when the body changes', () => {
    const t = templates.add('Tmpl', 'old {a}');
    templates.update(t.id, { body: 'new {b} and {c}' });
    const after = templates.templates.find((x) => x.id === t.id);
    expect(after?.body).toBe('new {b} and {c}');
    expect(after?.variables).toEqual(['b', 'c']);
  });

  it('update: is a no-op for an unknown id and when nothing changes', () => {
    const t = templates.add('Tmpl', 'body');
    templates.update('does-not-exist', { name: 'X' });
    expect(templates.templates).toHaveLength(1);
    // No-op when the patch matches current values → array reference preserved.
    const before = templates.templates;
    templates.update(t.id, { name: 'Tmpl', body: 'body' });
    expect(templates.templates).toBe(before);
  });

  it('delete: removes by id and no-ops on unknown id', () => {
    const a = templates.add('A', '');
    templates.add('B', '');
    templates.delete(a.id);
    expect(templates.templates.map((t) => t.name)).toEqual(['B']);
    templates.delete('nope');
    expect(templates.templates).toHaveLength(1);
  });

  it('recordUse: bumps useCount and stamps lastUsedAt', () => {
    const t = templates.add('A', '');
    templates.recordUse(t.id);
    const after = templates.templates.find((x) => x.id === t.id);
    expect(after?.useCount).toBe(1);
    expect(after?.lastUsedAt).toBeTruthy();
  });

  it('render: substitutes known vars, leaves unknown intact, single pass', () => {
    const t = makeTemplate({ body: 'Hi {name}, see {missing}' });
    expect(templates.render(t, { name: 'Sam' })).toBe('Hi Sam, see {missing}');
    // A substituted value containing a placeholder is NOT re-substituted.
    const t2 = makeTemplate({ body: '{a}' });
    expect(templates.render(t2, { a: '{b}', b: 'X' })).toBe('{b}');
  });
});

describe('templatesModal', () => {
  beforeEach(reset);
  afterEach(reset);

  it('show carries the template-id hint; close clears it', () => {
    templatesModal.show('tpl-1');
    expect(templatesModal.open).toBe(true);
    expect(templatesModal.openForTemplate).toBe('tpl-1');
    templatesModal.close();
    expect(templatesModal.open).toBe(false);
    expect(templatesModal.openForTemplate).toBeNull();
  });

  it('toggle flips open state', () => {
    templatesModal.toggle();
    expect(templatesModal.open).toBe(true);
    templatesModal.toggle();
    expect(templatesModal.open).toBe(false);
  });
});

describe('composerInsert bus', () => {
  beforeEach(reset);
  afterEach(reset);

  it('push then consume returns the payload once, then null', () => {
    composerInsert.push('rendered text', 'tpl-7');
    expect(composerInsert.consume()).toEqual({ text: 'rendered text', templateId: 'tpl-7' });
    expect(composerInsert.consume()).toBeNull();
  });

  it('consume on an empty bus returns null', () => {
    expect(composerInsert.consume()).toBeNull();
  });
});
