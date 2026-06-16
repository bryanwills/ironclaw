import { describe, expect, it } from 'vitest';

import { unwrapDocumentAssignment } from './work-product-normalize';

describe('unwrapDocumentAssignment', () => {
  it('extracts a Markdown agreement trapped in a Python assignment block', () => {
    const wrapped = [
      '```python',
      '# Generate the new services agreement',
      '',
      'agreement = """# Services Agreement',
      '',
      '## Parties',
      '',
      'Atlas Harbor Analytics will engage Northstar Forge Labs for services. '.repeat(12),
      '"""',
      '```'
    ].join('\n');

    const unwrapped = unwrapDocumentAssignment(wrapped);
    expect(unwrapped).toMatch(/^# Services Agreement/u);
    expect(unwrapped).not.toContain('```python');
    expect(unwrapped).not.toContain('agreement =');
  });

  it('leaves real code blocks untouched', () => {
    const code = ['```python', 'example = """short string"""', 'print(example)', '```'].join('\n');

    expect(unwrapDocumentAssignment(code)).toBe(code);
  });
});
