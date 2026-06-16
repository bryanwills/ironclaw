// Tests for the admin PromptDiff viewer. The LCS line-diff (`computeDiff`) and
// the side-by-side pairing (`pairForSideBySide`) are exported from the module
// script, so we test that load-bearing logic directly, plus a render smoke
// check for the identical-versions notice and the changed-content path.

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import PromptDiff, { computeDiff, pairForSideBySide } from './PromptDiff.svelte';

describe('computeDiff', () => {
  it('marks two identical texts entirely as "same"', () => {
    const chunks = computeDiff('a\nb\nc', 'a\nb\nc');
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.kind === 'same')).toBe(true);
  });

  it('emits an add for an inserted line and a del for a removed line', () => {
    const inserted = computeDiff('x', 'x\ny');
    expect(inserted.some((c) => c.kind === 'add' && c.text === 'y')).toBe(true);
    expect(inserted.some((c) => c.kind === 'del')).toBe(false);

    const removed = computeDiff('x\ny', 'x');
    expect(removed.some((c) => c.kind === 'del' && c.text === 'y')).toBe(true);
    expect(removed.some((c) => c.kind === 'add')).toBe(false);
  });

  it('represents a changed line as a delete plus an add', () => {
    const chunks = computeDiff('the quick fox', 'the slow fox');
    expect(chunks.some((c) => c.kind === 'del' && c.text === 'the quick fox')).toBe(true);
    expect(chunks.some((c) => c.kind === 'add' && c.text === 'the slow fox')).toBe(true);
  });
});

describe('pairForSideBySide', () => {
  it('pairs a del/add run into one changed row carrying both sides', () => {
    const rows = pairForSideBySide(computeDiff('alpha', 'beta'));
    const changed = rows.find((r) => r.kind === 'changed');
    expect(changed?.left?.text).toBe('alpha');
    expect(changed?.right?.text).toBe('beta');
  });

  it('keeps an unchanged line aligned on both sides', () => {
    const rows = pairForSideBySide(computeDiff('same', 'same'));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('same');
    expect(rows[0].left?.text).toBe('same');
    expect(rows[0].right?.text).toBe('same');
  });

  it('leaves a lone delete row when deletes outnumber adds', () => {
    const rows = pairForSideBySide(computeDiff('one\ntwo', 'uno'));
    expect(rows.some((r) => r.kind === 'changed')).toBe(true);
    expect(rows.some((r) => r.kind === 'del' && r.right === undefined)).toBe(true);
  });
});

describe('PromptDiff render', () => {
  const baseProps = { oldLabel: 'v1', newLabel: 'v2', onclose: () => {} };

  it('shows the identical-versions notice when old and new match', () => {
    const { getByText } = render(PromptDiff, {
      props: { ...baseProps, oldText: 'hello\nworld', newText: 'hello\nworld' }
    });
    expect(getByText('The two versions are identical')).toBeTruthy();
  });

  it('renders the changed text and drops the identical notice when they differ', () => {
    const { getByText, queryByText } = render(PromptDiff, {
      props: { ...baseProps, oldText: 'the quick fox', newText: 'the slow fox' }
    });
    expect(getByText('the slow fox')).toBeTruthy();
    expect(queryByText('The two versions are identical.')).toBeNull();
  });
});
