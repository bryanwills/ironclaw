import { describe, expect, it } from 'vitest';
import { escapeHtml, exportThreadHtml, type TranscriptMessage } from './html-export';

describe('html-export', () => {
  it('escapes the five HTML-significant characters', () => {
    const escaped = escapeHtml('<script>&"\'');

    expect(escaped).toBe('&lt;script&gt;&amp;&quot;&#39;');
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
    expect(escaped).not.toContain('"');
    expect(escaped).not.toContain("'");
  });

  it('renders a complete standalone HTML document', () => {
    const html = exportThreadHtml({
      generatedAt: '2026-05-28T10:30:00.000Z',
      messages: [],
      title: 'Export <Title> & "Test"'
    });

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('</html>');
    expect(html).toContain('<title>Export &lt;Title&gt; &amp; &quot;Test&quot;</title>');
    expect(html).toContain('<h1>Export &lt;Title&gt; &amp; &quot;Test&quot;</h1>');
    expect(html).toContain('Generated at 2026-05-28T10:30:00.000Z');
  });

  it('escapes hostile message content and timestamps', () => {
    const html = exportThreadHtml({
      generatedAt: '2026-05-28T10:30:00.000Z',
      messages: [
        {
          content: '<script>alert(1)</script><img src=x onerror="alert(2)">',
          created_at: '2026-05-28T10:00:00.000Z" onclick="alert(3)',
          role: 'user'
        }
      ],
      title: 'Security check'
    });

    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('onerror="alert(2)"');
    expect(html).not.toContain('onclick="alert(3)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('onerror=&quot;alert(2)&quot;');
    expect(html).toContain('2026-05-28T10:00:00.000Z&quot; onclick=&quot;alert(3)');
  });

  it('renders each message content in order', () => {
    const messages: TranscriptMessage[] = [
      { content: 'First line\nSecond line', created_at: '2026-05-28T10:00:00.000Z', role: 'user' },
      { content: 'Assistant says <ok>', created_at: '2026-05-28T10:01:00.000Z', role: 'assistant' },
      { content: 'Tool output & logs', role: 'tool' }
    ];

    const html = exportThreadHtml({
      generatedAt: '2026-05-28T10:30:00.000Z',
      messages,
      title: 'Ordered transcript'
    });

    const firstIndex = html.indexOf('First line\nSecond line');
    const secondIndex = html.indexOf('Assistant says &lt;ok&gt;');
    const thirdIndex = html.indexOf('Tool output &amp; logs');

    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(thirdIndex).toBeGreaterThan(secondIndex);
    expect(html).toContain('white-space: pre-wrap;');
    expect(html).toContain('2026-05-28T10:30:00.000Z');
  });
});
