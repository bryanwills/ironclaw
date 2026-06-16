import { Marked, type Token, type Tokens } from 'marked';
import katex from 'katex';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const ZIP_TABLE = new Uint32Array(256).map((_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

export type WorkProductExportFormat = 'markdown' | 'html' | 'docx' | 'pdf' | 'json';

const CALLOUT_RE = /^\s*\[!(NOTE|WARNING|CAUTION|TIP|IMPORTANT)\]\s*(.*)$/u;
const CALLOUT_LABELS: Record<string, string> = {
  NOTE: 'Note',
  WARNING: 'Warning',
  CAUTION: 'Caution',
  TIP: 'Tip',
  IMPORTANT: 'Important'
};

const exportMarkdown = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  extensions: [
    {
      name: 'mathBlock',
      level: 'block',
      start(src: string): number | undefined {
        const index = src.match(/\$\$/u)?.index;
        return typeof index === 'number' ? index : undefined;
      },
      tokenizer(src: string): Token | undefined {
        const match = /^\$\$\s*\n?([\s\S]+?)\n?\$\$(?:\n|$)/u.exec(src);
        if (!match) return undefined;
        return { type: 'mathBlock', raw: match[0], text: match[1].trim() } as Token;
      },
      renderer(token: Token): string {
        const source = (token as { text?: string }).text ?? '';
        return `<div class="math math-display">${renderKatex(source, true)}</div>\n`;
      }
    },
    {
      name: 'mathInline',
      level: 'inline',
      start(src: string): number | undefined {
        const index = src.indexOf('$');
        return index >= 0 ? index : undefined;
      },
      tokenizer(src: string): Token | undefined {
        const match = /^\$([^$\n]+?)\$/u.exec(src);
        if (!match) return undefined;
        return { type: 'mathInline', raw: match[0], text: match[1].trim() } as Token;
      },
      renderer(token: Token): string {
        const source = (token as { text?: string }).text ?? '';
        return `<span class="math math-inline">${renderKatex(source, false)}</span>`;
      }
    }
  ],
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(text);
    },
    link(
      this: { parser: { parseInline: (tokens: Token[]) => string } },
      { href, title, tokens }: Tokens.Link
    ): string {
      const body = this.parser.parseInline(tokens);
      const safe = safeHref(href);
      if (!safe) return body;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(safe)}"${titleAttr}>${body}</a>`;
    },
    image({ href, title, text }: Tokens.Image): string {
      const safe = safeHref(href);
      const alt = escapeHtml(text);
      if (!safe) return alt;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<img src="${escapeHtml(safe)}" alt="${alt}"${titleAttr}>`;
    },
    blockquote(
      this: { parser: { parse: (tokens: Token[]) => string } },
      { tokens }: Tokens.Blockquote
    ): string {
      const callout = splitCallout(tokens);
      if (!callout) return `<blockquote>\n${this.parser.parse(tokens)}</blockquote>\n`;
      const body = this.parser.parse(callout.tokens);
      return `<div class="md-callout md-callout--${callout.kind.toLowerCase()}"><div class="md-callout__head">${escapeHtml(
        callout.label
      )}</div><div class="md-callout__body">${body}</div></div>\n`;
    }
  }
});

export function slugFilename(title: string, fallback = 'ironclaw-work-product'): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

export async function copyWorkProduct(content: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content);
    return;
  }

  if (typeof document === 'undefined') {
    throw new Error('Clipboard is unavailable in this environment.');
  }

  const textarea = document.createElement('textarea');
  textarea.value = content;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!copied) throw new Error('Clipboard copy failed.');
}

export async function exportWorkProduct(input: {
  title: string;
  content: string;
  format: WorkProductExportFormat;
}): Promise<void> {
  const base = slugFilename(input.title);
  if (input.format === 'markdown') {
    downloadBlob(`${base}.md`, new Blob([input.content], { type: 'text/markdown;charset=utf-8' }));
    return;
  }
  if (input.format === 'json') {
    downloadBlob(
      `${base}.json`,
      new Blob([input.content], { type: 'application/json;charset=utf-8' })
    );
    return;
  }
  if (input.format === 'html') {
    downloadBlob(
      `${base}.html`,
      new Blob([markdownToHtmlDocument(input.title, input.content)], {
        type: 'text/html;charset=utf-8'
      })
    );
    return;
  }
  if (input.format === 'pdf') {
    const pdf = markdownToPdf(input.title, input.content);
    const bytes = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
    downloadBlob(`${base}.pdf`, new Blob([bytes], { type: 'application/pdf' }));
    return;
  }
  const docx = markdownToDocx(input.title, input.content);
  const bytes = docx.buffer.slice(
    docx.byteOffset,
    docx.byteOffset + docx.byteLength
  ) as ArrayBuffer;
  downloadBlob(`${base}.docx`, new Blob([bytes], { type: DOCX_MIME }));
}

export function markdownToHtmlDocument(title: string, markdown: string): string {
  const body = exportMarkdown.parse(markdown, { async: false }).trim();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.55; margin: 48px; color: #111827; }
    h1, h2, h3 { line-height: 1.2; }
    li { margin: 0.35rem 0; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid #d1d5db; padding: 0.45rem 0.6rem; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; font-weight: 700; }
    blockquote { border-left: 4px solid #38bdf8; color: #374151; margin: 1rem 0; padding: 0.15rem 0 0.15rem 1rem; }
    .md-callout { border-left: 4px solid #f59e0b; background: #fffbeb; margin: 1rem 0; padding: 0.75rem 1rem; }
    .md-callout__head { font-weight: 700; margin-bottom: 0.35rem; }
    .md-callout--note, .md-callout--tip { border-left-color: #38bdf8; background: #f0f9ff; }
    .md-callout--caution, .md-callout--warning { border-left-color: #f59e0b; background: #fffbeb; }
    .md-callout--important { border-left-color: #8b5cf6; background: #f5f3ff; }
    pre { background: #111827; color: #f9fafb; padding: 1rem; border-radius: 0.5rem; overflow-x: auto; }
    code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
    :not(pre) > code { background: #f3f4f6; color: #111827; border-radius: 0.25rem; padding: 0.08rem 0.25rem; }
    .math { font-size: 1.02em; }
    .math-display { margin: 1rem 0; overflow-x: auto; }
  </style>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
</head>
<body>
${body}
</body>
</html>`;
}

export function markdownToPdf(title: string, markdown: string): Uint8Array {
  const lines = markdownToPlainLines(title, markdown).flatMap((line) => wrapPlainLine(line, 92));
  const pages: string[][] = [];
  const pageSize = 36;
  for (let index = 0; index < lines.length; index += pageSize) {
    pages.push(lines.slice(index, index + pageSize));
  }
  if (pages.length === 0) pages.push([title || 'IronClaw work product']);

  const pageObjectIds = pages.map((_, index) => 4 + index * 2);
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];

  pages.forEach((pageLines, index) => {
    const pageObj = 4 + index * 2;
    const contentObj = pageObj + 1;
    const stream = pdfTextStream(pageLines);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`,
      `<< /Length ${asciiByteLength(stream)} >>\nstream\n${stream}\nendstream`
    );
  });

  return buildPdfFromObjects(objects);
}

function markdownToPlainLines(title: string, markdown: string): string[] {
  const out: string[] = [];
  const heading = title.trim() || firstMarkdownHeading(markdown) || 'IronClaw work product';
  out.push(heading, '');

  let inFence = false;
  for (const rawLine of markdown.split(/\r?\n/u)) {
    const line = rawLine.replace(/\t/gu, '  ');
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(`    ${plainPdfText(line)}`);
      continue;
    }

    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line)) continue;

    const headingMatch = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (headingMatch) {
      out.push('', plainPdfText(stripInlineMarkdown(headingMatch[2])).toUpperCase(), '');
      continue;
    }

    const bulletMatch = /^(\s*)[-*+]\s+(.+)$/u.exec(line);
    if (bulletMatch) {
      const indent = bulletMatch[1].length > 1 ? '  ' : '';
      out.push(`${indent}- ${plainPdfText(stripInlineMarkdown(bulletMatch[2]))}`);
      continue;
    }

    const numberMatch = /^(\s*)\d+[.)]\s+(.+)$/u.exec(line);
    if (numberMatch) {
      const indent = numberMatch[1].length > 1 ? '  ' : '';
      out.push(`${indent}${plainPdfText(stripInlineMarkdown(line.trim()))}`);
      continue;
    }

    if (line.trim().startsWith('|')) {
      out.push(
        plainPdfText(
          line
            .trim()
            .replace(/^\|/u, '')
            .replace(/\|$/u, '')
            .split('|')
            .map((cell) => stripInlineMarkdown(cell.trim()))
            .join(' | ')
        )
      );
      continue;
    }

    out.push(plainPdfText(stripInlineMarkdown(line)));
  }

  return trimBlankLines(out);
}

function firstMarkdownHeading(markdown: string): string | null {
  for (const line of markdown.split(/\r?\n/u)) {
    const match = /^#\s+(.+)$/u.exec(line);
    if (match) return stripInlineMarkdown(match[1]).trim();
  }
  return null;
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/\*([^*]+)\*/gu, '$1')
    .replace(/__([^_]+)__/gu, '$1')
    .replace(/_([^_]+)_/gu, '$1')
    .replace(/^>\s?/u, '');
}

function plainPdfText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/gu, '')
    .replace(/[ \t]+$/u, '');
}

function trimBlankLines(lines: string[]): string[] {
  const copy = lines.slice();
  while (copy.length > 0 && copy[0].trim() === '') copy.shift();
  while (copy.length > 0 && copy.at(-1)?.trim() === '') copy.pop();
  return copy;
}

function wrapPlainLine(line: string, width: number): string[] {
  if (line.trim() === '') return [''];
  const indent = /^(\s*)/u.exec(line)?.[1] ?? '';
  const available = Math.max(30, width - indent.length);
  const words = line.trim().split(/\s+/u);
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (`${current} ${word}`.length <= available) {
      current = `${current} ${word}`;
    } else {
      out.push(`${indent}${current}`);
      current = word;
    }
  }
  if (current) out.push(`${indent}${current}`);
  return out;
}

function pdfTextStream(lines: string[]): string {
  return [
    'BT',
    '/F1 11 Tf',
    '54 738 Td',
    '14 TL',
    ...lines.map((line) => `(${escapePdfString(line)}) Tj T*`),
    'ET'
  ].join('\n');
}

function escapePdfString(text: string): string {
  return text.replace(/\\/gu, '\\\\').replace(/\(/gu, '\\(').replace(/\)/gu, '\\)');
}

function asciiByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function buildPdfFromObjects(objects: string[]): Uint8Array {
  const chunks: string[] = ['%PDF-1.4\n'];
  const offsets = [0];
  let cursor = asciiByteLength(chunks[0]);

  objects.forEach((body, index) => {
    offsets.push(cursor);
    const chunk = `${index + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(chunk);
    cursor += asciiByteLength(chunk);
  });

  const xrefOffset = cursor;
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.slice(1).map((offset) => `${offset.toString().padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF'
  ].join('\n');
  chunks.push(xref);
  return new TextEncoder().encode(chunks.join(''));
}

export function markdownToDocx(title: string, markdown: string): Uint8Array {
  const context = new DocxContext();
  const blocks = markdownToDocxBlocks(title, markdown, context);
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${blocks.join('\n    ')}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  return zipStored([
    {
      path: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`
    },
    {
      path: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
    },
    {
      path: 'word/_rels/document.xml.rels',
      content: context.relationshipsXml()
    },
    { path: 'word/document.xml', content: documentXml },
    { path: 'word/numbering.xml', content: numberingXml() }
  ]);
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(text: string): string {
  return escapeHtml(text);
}

function renderKatex(source: string, displayMode: boolean): string {
  try {
    return katex.renderToString(source, {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
      trust: false
    });
  } catch {
    return escapeHtml(source);
  }
}

function zipStored(files: Array<{ path: string; content: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.path);
    const data = encoder.encode(file.content);
    const crc = crc32(data);
    const localHeader = zipHeader(30);
    writeU32(localHeader, 0, 0x04034b50);
    writeU16(localHeader, 4, 20);
    writeU16(localHeader, 6, 0);
    writeU16(localHeader, 8, 0);
    writeU16(localHeader, 10, 0);
    writeU16(localHeader, 12, 0);
    writeU32(localHeader, 14, crc);
    writeU32(localHeader, 18, data.length);
    writeU32(localHeader, 22, data.length);
    writeU16(localHeader, 26, name.length);
    writeU16(localHeader, 28, 0);
    localParts.push(localHeader, name, data);

    const centralHeader = zipHeader(46);
    writeU32(centralHeader, 0, 0x02014b50);
    writeU16(centralHeader, 4, 20);
    writeU16(centralHeader, 6, 20);
    writeU16(centralHeader, 8, 0);
    writeU16(centralHeader, 10, 0);
    writeU16(centralHeader, 12, 0);
    writeU16(centralHeader, 14, 0);
    writeU32(centralHeader, 16, crc);
    writeU32(centralHeader, 20, data.length);
    writeU32(centralHeader, 24, data.length);
    writeU16(centralHeader, 28, name.length);
    writeU16(centralHeader, 30, 0);
    writeU16(centralHeader, 32, 0);
    writeU16(centralHeader, 34, 0);
    writeU16(centralHeader, 36, 0);
    writeU32(centralHeader, 38, 0);
    writeU32(centralHeader, 42, offset);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = zipHeader(22);
  writeU32(end, 0, 0x06054b50);
  writeU16(end, 4, 0);
  writeU16(end, 6, 0);
  writeU16(end, 8, files.length);
  writeU16(end, 10, files.length);
  writeU32(end, 12, centralSize);
  writeU32(end, 16, centralOffset);
  writeU16(end, 20, 0);

  return concat([...localParts, ...centralParts, end]);
}

function markdownToDocxBlocks(title: string, markdown: string, context: DocxContext): string[] {
  const out: string[] = [];
  if (title.trim()) out.push(paragraphFromRuns(textRun(title.trim(), { bold: true, size: 36 })));
  out.push(...renderDocxBlocks(exportMarkdown.lexer(markdown), context));
  return out.length > 0 ? out : [paragraphFromRuns(textRun(''))];
}

class DocxContext {
  private links: Array<{ id: string; href: string }> = [];

  addHyperlink(href: string): string | null {
    const safe = safeHref(href);
    if (!safe) return null;
    const id = `rId${this.links.length + 1}`;
    this.links.push({ id, href: safe });
    return id;
  }

  relationshipsXml(): string {
    const links = this.links
      .map(
        (link) =>
          `<Relationship Id="${link.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(
            link.href
          )}" TargetMode="External"/>`
      )
      .join('\n  ');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${links}
</Relationships>`;
  }
}

type RunStyle = {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  underline?: boolean;
  color?: string;
  size?: number;
};

type ParagraphOptions = {
  quote?: boolean;
  list?: { ordered: boolean; level: number };
};

function renderDocxBlocks(
  tokens: Token[],
  context: DocxContext,
  options: ParagraphOptions = {}
): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    if (token.type === 'space' || token.type === 'def') continue;
    if (isHeadingToken(token)) {
      const size = token.depth <= 2 ? 28 : 24;
      out.push(
        paragraphFromRuns(renderInlineTokens(token.tokens, context, { bold: true, size }), options)
      );
    } else if (isParagraphToken(token)) {
      out.push(paragraphFromRuns(renderInlineTokens(token.tokens, context), options));
    } else if (isTextToken(token)) {
      out.push(paragraphFromRuns(renderInlineTokens(inlineTokensForText(token), context), options));
    } else if (isListToken(token)) {
      out.push(...renderDocxList(token, context, options.list?.level ?? 0, options.quote));
    } else if (isCodeToken(token)) {
      out.push(codeBlock(token.text));
    } else if (isTableToken(token)) {
      out.push(docxTable(token, context));
    } else if (isBlockquoteToken(token)) {
      out.push(...renderDocxBlockquote(token, context));
    } else if (isMathBlockToken(token)) {
      out.push(paragraphFromRuns(textRun(token.text, { code: true }), options));
    } else if (token.type === 'hr') {
      out.push(paragraphFromRuns(textRun(''), options));
    } else if (isHtmlToken(token)) {
      out.push(paragraphFromRuns(textRun(token.text), options));
    }
  }
  return out;
}

function renderDocxBlockquote(token: Tokens.Blockquote, context: DocxContext): string[] {
  const callout = splitCallout(token.tokens);
  if (!callout) return renderDocxBlocks(token.tokens, context, { quote: true });
  return [
    paragraphFromRuns(textRun(callout.label, { bold: true }), { quote: true }),
    ...renderDocxBlocks(callout.tokens, context, { quote: true })
  ];
}

function renderDocxList(
  list: Tokens.List,
  context: DocxContext,
  level: number,
  quote = false
): string[] {
  const out: string[] = [];
  for (const item of list.items) {
    const { inline, children } = splitListItem(item);
    out.push(
      paragraphFromRuns(renderInlineTokens(inline, context), {
        quote,
        list: { ordered: list.ordered, level }
      })
    );
    for (const child of children) {
      if (isListToken(child)) out.push(...renderDocxList(child, context, level + 1, quote));
      else out.push(...renderDocxBlocks([child], context, { quote }));
    }
  }
  return out;
}

function splitListItem(item: Tokens.ListItem): { inline: Token[]; children: Token[] } {
  const inline: Token[] = [];
  const children: Token[] = [];
  let consumedLead = false;

  for (const token of item.tokens) {
    if (!consumedLead && isTextToken(token)) {
      inline.push(...inlineTokensForText(token));
      consumedLead = true;
    } else if (!consumedLead && isParagraphToken(token)) {
      inline.push(...token.tokens);
      consumedLead = true;
    } else {
      children.push(token);
    }
  }

  if (inline.length === 0 && item.text.trim()) {
    inline.push({ type: 'text', raw: item.text, text: item.text, escaped: false } as Tokens.Text);
  }
  return { inline, children };
}

function inlineTokensForText(token: Tokens.Text): Token[] {
  return token.tokens?.length ? token.tokens : [token];
}

function renderInlineTokens(
  tokens: Token[] | undefined,
  context: DocxContext,
  style: RunStyle = {}
): string {
  if (!tokens?.length) return '';
  return tokens.map((token) => renderInlineToken(token, context, style)).join('');
}

function renderInlineToken(token: Token, context: DocxContext, style: RunStyle): string {
  if (token.type === 'text') {
    return token.tokens?.length
      ? renderInlineTokens(token.tokens, context, style)
      : textRun(token.text, style);
  }
  if (token.type === 'escape') return textRun(token.text, style);
  if (token.type === 'strong') {
    return renderInlineTokens(token.tokens, context, { ...style, bold: true });
  }
  if (token.type === 'em') {
    return renderInlineTokens(token.tokens, context, { ...style, italic: true });
  }
  if (token.type === 'codespan') {
    return textRun(token.text, { ...style, code: true });
  }
  if (token.type === 'br') return '<w:r><w:br/></w:r>';
  if (token.type === 'link') {
    const body = renderInlineTokens(token.tokens, context, {
      ...style,
      color: '0563C1',
      underline: true
    });
    const id = context.addHyperlink(token.href);
    return id ? `<w:hyperlink r:id="${id}" w:history="1">${body}</w:hyperlink>` : body;
  }
  if (token.type === 'image') {
    return textRun(token.text ? `[Image: ${token.text}]` : '[Image]', style);
  }
  if (isMathInlineToken(token)) return textRun(token.text, { ...style, code: true });
  if (token.type === 'del') return renderInlineTokens(token.tokens, context, style);
  if (token.type === 'html') return textRun(token.text, style);
  return 'tokens' in token && Array.isArray(token.tokens)
    ? renderInlineTokens(token.tokens, context, style)
    : textRun('text' in token && typeof token.text === 'string' ? token.text : '', style);
}

function textRun(text: string, style: RunStyle = {}): string {
  if (!text) return '';
  const props: string[] = [];
  if (style.bold) props.push('<w:b/>');
  if (style.italic) props.push('<w:i/>');
  if (style.underline) props.push('<w:u w:val="single"/>');
  if (style.color) props.push(`<w:color w:val="${style.color}"/>`);
  if (style.size) props.push(`<w:sz w:val="${style.size}"/>`);
  if (style.code) {
    props.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>');
    props.push('<w:shd w:fill="F3F4F6"/>');
  }
  const runProps = props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  return `<w:r>${runProps}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function paragraphFromRuns(runs: string, options: ParagraphOptions = {}): string {
  const pProps: string[] = [];
  if (options.quote) {
    pProps.push('<w:pBdr><w:left w:val="single" w:sz="12" w:space="6" w:color="38BDF8"/></w:pBdr>');
    pProps.push('<w:ind w:left="360"/>');
  }
  if (options.list) {
    const level = Math.min(Math.max(options.list.level, 0), 8);
    const numId = options.list.ordered ? 1 : 2;
    pProps.push(`<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`);
  }
  const pPr = pProps.length > 0 ? `<w:pPr>${pProps.join('')}</w:pPr>` : '';
  return `<w:p>${pPr}${runs || textRun('')}</w:p>`;
}

function docxTable(token: Tokens.Table, context: DocxContext): string {
  const columnCount = Math.max(token.header.length, ...token.rows.map((row) => row.length), 1);
  const width = Math.floor(9360 / columnCount);
  const grid = Array.from({ length: columnCount }, () => `<w:gridCol w:w="${width}"/>`).join('');
  const headerRow = docxTableRow(padTableCells(token.header, columnCount), true, width, context);
  const bodyRows = token.rows
    .map((row) => docxTableRow(padTableCells(row, columnCount), false, width, context))
    .join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/></w:tblBorders><w:tblCellMar><w:top w:w="120" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${headerRow}${bodyRows}</w:tbl>`;
}

function padTableCells(cells: Tokens.TableCell[], length: number): Tokens.TableCell[] {
  return Array.from(
    { length },
    (_, index) =>
      cells[index] ?? {
        text: '',
        tokens: [],
        header: false,
        align: null
      }
  );
}

function docxTableRow(
  cells: Tokens.TableCell[],
  header: boolean,
  width: number,
  context: DocxContext
): string {
  return `<w:tr>${cells.map((cell) => docxTableCell(cell, header, width, context)).join('')}</w:tr>`;
}

function docxTableCell(
  cell: Tokens.TableCell,
  header: boolean,
  width: number,
  context: DocxContext
): string {
  const shading = header ? '<w:shd w:fill="F3F4F6"/>' : '';
  const runs = renderInlineTokens(cell.tokens, context, header ? { bold: true } : {});
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shading}</w:tcPr>${paragraphFromRuns(
    runs
  )}</w:tc>`;
}

function numberingXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="1">
    ${numberingLevels('decimal')}
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="2">
    ${numberingLevels('bullet')}
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>
</w:numbering>`;
}

function numberingLevels(kind: 'decimal' | 'bullet'): string {
  return Array.from({ length: 9 }, (_, level) => {
    const left = 720 + level * 360;
    const hanging = 360;
    const text = kind === 'decimal' ? `%${level + 1}.` : '•';
    const font =
      kind === 'bullet' ? '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr>' : '';
    return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${kind}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${left}" w:hanging="${hanging}"/></w:pPr>${font}</w:lvl>`;
  }).join('');
}

function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^(#|\/|\.\/|\.\.\/)/.test(trimmed)) return trimmed;
  return null;
}

function splitCallout(tokens: Token[]): { kind: string; label: string; tokens: Token[] } | null {
  const first = tokens[0];
  if (!first || !isParagraphToken(first)) return null;
  const firstInline = first.tokens[0];
  if (!firstInline || !isTextToken(firstInline)) return null;
  const match = firstInline.text.match(CALLOUT_RE);
  if (!match) return null;

  const kind = match[1].toUpperCase();
  const remainder = match[2] ?? '';
  const inline = [...first.tokens];
  if (remainder.trim()) {
    inline[0] = { ...firstInline, raw: remainder, text: remainder };
  } else {
    inline.shift();
    if (inline[0]?.type === 'br') inline.shift();
  }

  const bodyTokens =
    inline.length > 0
      ? [
          { ...first, tokens: inline, text: inline.map(inlineTokenText).join('') },
          ...tokens.slice(1)
        ]
      : tokens.slice(1);

  return { kind, label: CALLOUT_LABELS[kind] ?? kind, tokens: bodyTokens };
}

function inlineTokenText(token: Token): string {
  return 'text' in token && typeof token.text === 'string' ? token.text : token.raw;
}

function isHeadingToken(token: Token): token is Tokens.Heading {
  return token.type === 'heading' && 'depth' in token && Array.isArray(token.tokens);
}

function isParagraphToken(token: Token): token is Tokens.Paragraph {
  return token.type === 'paragraph' && Array.isArray(token.tokens);
}

function isTextToken(token: Token): token is Tokens.Text {
  return token.type === 'text' && 'text' in token;
}

function isListToken(token: Token): token is Tokens.List {
  return token.type === 'list' && Array.isArray((token as Tokens.List).items);
}

function isCodeToken(token: Token): token is Tokens.Code {
  return token.type === 'code' && 'text' in token;
}

function isTableToken(token: Token): token is Tokens.Table {
  return token.type === 'table' && Array.isArray((token as Tokens.Table).header);
}

function isBlockquoteToken(token: Token): token is Tokens.Blockquote {
  return token.type === 'blockquote' && Array.isArray(token.tokens);
}

function isHtmlToken(token: Token): token is Tokens.HTML | Tokens.Tag {
  return token.type === 'html' && 'text' in token;
}

function isMathBlockToken(token: Token): token is Token & { type: 'mathBlock'; text: string } {
  return token.type === 'mathBlock' && typeof (token as { text?: unknown }).text === 'string';
}

function isMathInlineToken(token: Token): token is Token & { type: 'mathInline'; text: string } {
  return token.type === 'mathInline' && typeof (token as { text?: unknown }).text === 'string';
}

function codeBlock(code: string): string {
  const lines = code.length > 0 ? code.split('\n') : [''];
  return lines
    .map(
      (line) =>
        `<w:p><w:pPr><w:shd w:fill="111827"/><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:color w:val="F9FAFB"/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`
    )
    .join('');
}

function zipHeader(size: number): Uint8Array {
  return new Uint8Array(size);
}

function writeU16(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(buffer: Uint8Array, offset: number, value: number): void {
  writeU16(buffer, offset, value & 0xffff);
  writeU16(buffer, offset + 2, value >>> 16);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = ZIP_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
