import { describe, expect, test } from 'vitest';
import {
  markdownToDocx,
  markdownToHtmlDocument,
  markdownToPdf,
  slugFilename
} from './work-product-export';

const TABLE_MARKDOWN = `# Risk review

| Risk | Severity | Owner |
| --- | --- | --- |
| Data use rights | High | Legal |
| Pricing drift | Medium | Sales |
`;

const CODE_MARKDOWN = `# Implementation note

\`\`\`python
def score(items):
    return [item["risk"] for item in items]
\`\`\`
`;

const RICH_MARKDOWN = `# Export fidelity

Intro with **bold**, *italic*, \`inline_code()\`, and [docs](https://example.com/docs?a=1&b=2).

1. First ordered item
   1. Nested ordered item with *emphasis*
   2. Nested second item
2. Second ordered item

- Bullet item
  - Nested bullet with **strength**

> Plain quoted note with [a source](https://example.com/source).

> [!WARNING]
> Keep the Friday deploy frozen.

| H1 | H2 | H3 |
| --- | --- | --- |
| a \\| b | c | d |
`;

const MATH_MARKDOWN = `# Math note

Inline formula $E = mc^2$ and a display formula:

$$
\\text{VaR}_{\\alpha} = -\\inf\\{ x : F(x) > 1-\\alpha \\}
$$
`;

function docxXml(markdown: string): string {
  return Buffer.from(markdownToDocx('Assistant response', markdown)).toString('utf8');
}

describe('work product export', () => {
  test('slugFilename produces stable user-safe names', () => {
    expect(slugFilename('Northwind MSA follow-up!')).toBe('northwind-msa-follow-up');
    expect(slugFilename('')).toBe('ironclaw-work-product');
  });

  test('HTML export preserves GFM tables as real table elements', () => {
    const html = markdownToHtmlDocument('Risk review', TABLE_MARKDOWN);

    expect(html).toContain('<table>');
    expect(html).toMatch(/<thead>\s*<tr>\s*<th>Risk<\/th>\s*<th>Severity<\/th>\s*<th>Owner<\/th>/);
    expect(html).toContain('<td>Data use rights</td>');
    expect(html).not.toContain('| Risk | Severity | Owner |');
  });

  test('DOCX export preserves GFM tables as Word table XML', () => {
    const xml = docxXml(TABLE_MARKDOWN);

    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('<w:tblGrid>');
    expect(xml.match(/<w:tc>/g)).toHaveLength(9);
    expect(xml).toContain('<w:t xml:space="preserve">Risk</w:t>');
    expect(xml).toContain('<w:t xml:space="preserve">Data use rights</w:t>');
    expect(xml).not.toContain('| Risk | Severity | Owner |');
  });

  test('PDF export creates a real PDF with readable plain-text content', () => {
    const pdf = Buffer.from(markdownToPdf('Risk review', TABLE_MARKDOWN)).toString('latin1');

    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('/Type /Catalog');
    expect(pdf).toContain('(Risk review) Tj');
    expect(pdf).toContain('(Data use rights | High | Legal) Tj');
    expect(pdf).not.toContain('| --- | --- | --- |');
  });

  test('HTML export preserves fenced code as preformatted code', () => {
    const html = markdownToHtmlDocument('Implementation note', CODE_MARKDOWN);

    expect(html).toContain('<pre><code class="language-python">');
    expect(html).toContain('def score(items):');
    expect(html).toContain('    return [item[&quot;risk&quot;] for item in items]');
    expect(html).not.toContain('<p>```python</p>');
  });

  test('DOCX export preserves fenced code as monospace shaded blocks', () => {
    const xml = docxXml(CODE_MARKDOWN);

    expect(xml).toContain('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>');
    expect(xml).toContain('<w:shd w:fill="111827"/>');
    expect(xml).toContain('<w:t xml:space="preserve">def score(items):</w:t>');
    expect(xml).toContain(
      '<w:t xml:space="preserve">    return [item[&quot;risk&quot;] for item in items]</w:t>'
    );
    expect(xml).not.toContain('```python');
  });

  test('HTML export preserves inline markup, links, nested lists, blockquotes, callouts, and escaped table pipes', () => {
    const html = markdownToHtmlDocument('Export fidelity', RICH_MARKDOWN);

    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>inline_code()</code>');
    expect(html).toContain('<a href="https://example.com/docs?a=1&amp;b=2">docs</a>');
    expect(html.match(/<ol>/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('<li>Nested ordered item with <em>emphasis</em></li>');
    expect(html.match(/<ul>/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('<blockquote>');
    expect(html).toContain('md-callout md-callout--warning');
    expect(html).toMatch(/<td>a \| b<\/td>\s*<td>c<\/td>\s*<td>d<\/td>/);
    expect(html).not.toContain('a \\</td><td>b</td><td>c</td>');
  });

  test('DOCX export preserves links, inline formatting, real list numbering, callouts, and escaped table pipes', () => {
    const xml = docxXml(RICH_MARKDOWN);

    expect(xml).toContain('<w:b/>');
    expect(xml).toContain('<w:i/>');
    expect(xml).toContain('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>');
    expect(xml).toContain('<w:hyperlink r:id="rId1" w:history="1">');
    expect(xml).toContain('Target="https://example.com/docs?a=1&amp;b=2" TargetMode="External"');
    expect(xml).toContain('word/numbering.xml');
    expect(xml).toContain('<w:numId w:val="1"/>');
    expect(xml).toContain('<w:numId w:val="2"/>');
    expect(xml).toContain('<w:ilvl w:val="1"/>');
    expect(xml).toContain('<w:pBdr><w:left');
    expect(xml).toContain('<w:t xml:space="preserve">Warning</w:t>');
    expect(xml).toContain('<w:t xml:space="preserve">a | b</w:t>');
    expect(xml).toContain('<w:t xml:space="preserve">d</w:t>');
    expect(xml).not.toContain('<w:t xml:space="preserve">a \\</w:t>');
  });

  test('HTML and DOCX export render math without leaking raw dollar delimiters', () => {
    const html = markdownToHtmlDocument('Math note', MATH_MARKDOWN);
    expect(html).toContain('class="katex"');
    expect(html).toContain('math-display');
    expect(html).not.toContain('$$');
    expect(html).not.toContain('$E = mc^2$');

    const xml = docxXml(MATH_MARKDOWN);
    expect(xml).toContain('<w:t xml:space="preserve">E = mc^2</w:t>');
    expect(xml).toContain('VaR');
    expect(xml).not.toContain('$$');
    expect(xml).not.toContain('$E = mc^2$');
  });
});
