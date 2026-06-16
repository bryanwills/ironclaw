import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';

import StreamingText from './StreamingText.svelte';

describe('StreamingText component', () => {
  it('renders the provided text', () => {
    const { container } = render(StreamingText, {
      props: { text: 'Streaming response' }
    });

    expect(container.textContent).toContain('Streaming response');
  });

  it('preserves newlines with pre-wrap whitespace', () => {
    const { container } = render(StreamingText, {
      props: { text: 'First line\nSecond line' }
    });
    const rendered = container.querySelector('.streaming-text');

    expect(rendered?.classList.contains('whitespace-pre-wrap')).toBe(true);
    expect(rendered?.textContent).toContain('First line');
    expect(rendered?.textContent).toContain('Second line');
  });

  it('treats markdown as literal text', () => {
    const { container } = render(StreamingText, {
      props: { text: '**bold** and `code`' }
    });

    expect(container.textContent).toContain('**bold** and `code`');
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('code')).toBeNull();
  });

  it('updates when the text prop changes', async () => {
    const { container, rerender } = render(StreamingText, {
      props: { text: 'old text' }
    });

    await rerender({ text: 'new text' });

    expect(container.textContent).toContain('new text');
    expect(container.textContent).not.toContain('old text');
  });
});
