import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = {
  marked: {
    parse: (content) => {
      const code = content.match(/```([a-z]*)\n([\s\S]*?)```/);
      const language = code?.[1] || '';
      const languageClass = language ? ` class="language-${escapeHtml(language)}"` : '';
      return [
        '<h1>Services Agreement Smoke Draft</h1>',
        '<p>This is a static export validation artifact.</p>',
        '<table><thead><tr><th>Item</th><th>Value</th></tr></thead>',
        '<tbody><tr><td>Scope</td><td>Dummy services agreement update</td></tr></tbody></table>',
        content.includes('Mermaid diagram source')
          ? '<p><strong>Mermaid diagram source</strong></p>'
          : '',
        `<pre><code${languageClass}>${escapeHtml(code?.[2] || '')}</code></pre>`
      ].join('');
    }
  },
  // renderMarkdown installs an afterSanitizeAttributes link-hardening hook on
  // the shared DOMPurify instance, so the stub must expose addHook (a no-op
  // here) alongside sanitize or the HTML export builder throws before it can
  // render. sanitize is identity: these tests assert export structure, not the
  // sanitizer, and the real DOMPurify already has its own coverage.
  DOMPurify: {
    addHook: () => {},
    sanitize: (html) => html
  }
};

const { DOCX_MIME, buildDocxBlob, buildHtmlBlob, buildJsonBlob, buildMarkdownBlob, buildPdfBlob } =
  await import('./work-product-export.js');

const WORK_PRODUCT_MARKDOWN = [
  '# Services Agreement Smoke Draft',
  '',
  'This is a static export validation artifact with **bold**, `inline_code`, and a table.',
  '',
  '| Item | Value |',
  '| --- | --- |',
  '| Scope | Dummy services agreement update |',
  '| Attachment | services-template.pdf |',
  '',
  '```json',
  '{"status":"ready","format":"json"}',
  '```'
].join('\n');

const MERMAID_WORK_PRODUCT_MARKDOWN = [
  '# Workflow diagram',
  '',
  'The assistant included a generated process diagram.',
  '',
  '```mermaid',
  'graph TD',
  '  A[Client instructions] --> B[Draft DOCX]',
  '  B --> C[Review and export]',
  '```'
].join('\n');

const DOCX_RICH_MARKDOWN = [
  '# Export fidelity proof',
  '',
  'Review [NEAR AI docs](https://near.ai/docs?section=agents&format=docx) before signature.',
  '',
  '- Preserve clause numbering',
  '- Keep approval notes editable',
  '',
  '1. Draft',
  '2. Review',
  '3. Export'
].join('\n');

test('static export builders create parseable MD, HTML, JSON, PDF, and DOCX artifacts', async () => {
  const markdown = await buildMarkdownBlob(WORK_PRODUCT_MARKDOWN).text();
  assert.equal(markdown, WORK_PRODUCT_MARKDOWN);
  assert.match(markdown, /Services Agreement Smoke Draft/);

  const html = await buildHtmlBlob(WORK_PRODUCT_MARKDOWN).text();
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<table>/);
  assert.match(html, /Dummy services agreement update/);
  assert.doesNotMatch(html, /\| --- \| --- \|/);

  const json = JSON.parse(
    await buildJsonBlob({
      role: 'assistant',
      content: WORK_PRODUCT_MARKDOWN,
      attachments: [{ filename: 'services-template.pdf', mime_type: 'application/pdf' }]
    }).text()
  );
  assert.equal(json.role, 'assistant');
  assert.equal(json.content, WORK_PRODUCT_MARKDOWN);
  assert.deepEqual(json.attachments, [
    { filename: 'services-template.pdf', mime_type: 'application/pdf' }
  ]);
  assert.match(json.exported_at, /^\d{4}-\d{2}-\d{2}T/);

  const pdf = await buildPdfBlob(WORK_PRODUCT_MARKDOWN).text();
  assert.match(pdf, /^%PDF-1\.4/);
  assert.match(pdf, /SERVICES AGREEMENT SMOKE DRAFT/);
  assert.match(pdf, /Dummy services agreement update/);
  assert.match(pdf, /xref\n0 6/);
  assert.match(pdf, /trailer/);
  assert.match(pdf, /%%EOF/);

  const docx = buildDocxBlob(WORK_PRODUCT_MARKDOWN);
  assert.equal(docx.type, DOCX_MIME);
  const entries = unzipStoredEntries(new Uint8Array(await docx.arrayBuffer()));
  assert.deepEqual([...entries.keys()].sort(), [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/_rels/document.xml.rels',
    'word/document.xml',
    'word/numbering.xml'
  ]);
  assert.match(entries.get('[Content_Types].xml'), /wordprocessingml\.document\.main\+xml/);
  assert.match(entries.get('[Content_Types].xml'), /wordprocessingml\.numbering\+xml/);
  assert.match(entries.get('word/document.xml'), /<w:tbl>/);
  assert.match(entries.get('word/document.xml'), /Services Agreement Smoke Draft/);
  assert.match(entries.get('word/document.xml'), /Dummy services agreement update/);
});

test('DOCX export preserves headings, links, and editable list structure', async () => {
  const entries = unzipStoredEntries(
    new Uint8Array(await buildDocxBlob(DOCX_RICH_MARKDOWN).arrayBuffer())
  );
  const rels = entries.get('word/_rels/document.xml.rels');
  const documentXml = entries.get('word/document.xml');
  const numbering = entries.get('word/numbering.xml');

  assert.match(documentXml, /<w:pStyle w:val="Heading1"\/>/);
  assert.match(documentXml, /<w:hyperlink r:id="rIdLink1" w:history="1">/);
  assert.match(documentXml, /NEAR AI docs/);
  assert.doesNotMatch(documentXml, /\]\(https:\/\/near\.ai/);
  assert.match(documentXml, /<w:numId w:val="1"\/>/);
  assert.match(documentXml, /<w:numId w:val="2"\/>/);
  assert.match(documentXml, /Preserve clause numbering/);
  assert.match(documentXml, /Draft/);

  assert.match(
    rels,
    /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/numbering" Target="numbering\.xml"/
  );
  assert.match(
    rels,
    /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/hyperlink"/
  );
  assert.match(rels, /TargetMode="External"/);
  assert.match(rels, /Target="https:\/\/near\.ai\/docs\?section=agents&amp;format=docx"/);
  assert.match(numbering, /<w:numFmt w:val="bullet"\/>/);
  assert.match(numbering, /<w:numFmt w:val="decimal"\/>/);
});

test('static exports preserve Mermaid diagram source in every work-product format', async () => {
  const markdown = await buildMarkdownBlob(MERMAID_WORK_PRODUCT_MARKDOWN).text();
  assert.equal(markdown, MERMAID_WORK_PRODUCT_MARKDOWN);
  assert.match(markdown, /```mermaid/);
  assert.match(markdown, /Draft DOCX/);

  const html = await buildHtmlBlob(MERMAID_WORK_PRODUCT_MARKDOWN).text();
  assert.match(html, /Mermaid diagram source/);
  assert.match(html, /class="language-mermaid"/);
  assert.match(html, /graph TD/);
  assert.match(html, /Draft DOCX/);

  const json = JSON.parse(
    await buildJsonBlob({
      role: 'assistant',
      content: MERMAID_WORK_PRODUCT_MARKDOWN
    }).text()
  );
  assert.equal(json.content, MERMAID_WORK_PRODUCT_MARKDOWN);

  const pdfText = new TextDecoder('latin1').decode(
    new Uint8Array(await buildPdfBlob(MERMAID_WORK_PRODUCT_MARKDOWN).arrayBuffer())
  );
  assert.match(pdfText, /Mermaid diagram source/);
  assert.match(pdfText, /graph TD/);
  assert.match(pdfText, /Draft DOCX/);
  assert.doesNotMatch(pdfText, /```/);

  const docx = buildDocxBlob(MERMAID_WORK_PRODUCT_MARKDOWN);
  const entries = unzipStoredEntries(new Uint8Array(await docx.arrayBuffer()));
  const documentXml = entries.get('word/document.xml');
  assert.match(documentXml, /Mermaid diagram source/);
  assert.match(documentXml, /graph TD/);
  assert.match(documentXml, /Draft DOCX/);
  assert.doesNotMatch(documentXml, /```/);
});

// VIZ-3: when a rendered mermaid PNG is supplied, the DOCX embeds it as a real
// image part (word/media + content-type + relationship + inline drawing) AND
// keeps the labeled source below it. Rasterization needs a browser canvas, so
// this canvas-less node test passes a fixed PNG buffer straight to the builder.
const PNG_FIXTURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
]);

test('DOCX embeds a rendered mermaid PNG as a real image part and keeps the source', async () => {
  const mermaidSource = [
    'graph TD',
    '  A[Client instructions] --> B[Draft DOCX]',
    '  B --> C[Review and export]'
  ].join('\n');
  const docx = buildDocxBlob(MERMAID_WORK_PRODUCT_MARKDOWN, {
    images: [{ source: mermaidSource, png: PNG_FIXTURE, width: 640, height: 360 }]
  });
  assert.equal(docx.type, DOCX_MIME);
  const { entries, binary } = unzipStoredEntriesWithBinary(
    new Uint8Array(await docx.arrayBuffer())
  );

  // A media PNG part exists and its bytes are byte-identical to the source PNG.
  const mediaNames = [...entries.keys()].filter((name) => name.startsWith('word/media/'));
  assert.equal(mediaNames.length, 1, 'exactly one media image part');
  assert.match(mediaNames[0], /^word\/media\/image1\.png$/);
  assert.deepEqual([...binary.get(mediaNames[0])], [...PNG_FIXTURE], 'PNG bytes survive the zip');

  // Content-types declares the PNG default; rels wires the image relationship.
  assert.match(
    entries.get('[Content_Types].xml'),
    /<Default Extension="png" ContentType="image\/png"\/>/
  );
  const rels = entries.get('word/_rels/document.xml.rels');
  assert.match(
    rels,
    /Id="rIdImage1" Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/image" Target="media\/image1\.png"/
  );

  // The document has an inline drawing that embeds the relationship, and STILL
  // carries the label + source code so nothing is lost.
  const documentXml = entries.get('word/document.xml');
  assert.match(documentXml, /<w:drawing>/);
  assert.match(documentXml, /<a:blip r:embed="rIdImage1"\/>/);
  assert.match(documentXml, /<wp:extent cx="\d+" cy="\d+"\/>/);
  assert.match(documentXml, /Mermaid diagram source/);
  assert.match(documentXml, /graph TD/);
  assert.match(documentXml, /Draft DOCX/);
});

test('DOCX without supplied images is byte-identical to the source-only export', async () => {
  const withoutOption = new Uint8Array(
    await buildDocxBlob(MERMAID_WORK_PRODUCT_MARKDOWN).arrayBuffer()
  );
  const withEmptyImages = new Uint8Array(
    await buildDocxBlob(MERMAID_WORK_PRODUCT_MARKDOWN, { images: [] }).arrayBuffer()
  );
  assert.deepEqual(
    [...withEmptyImages],
    [...withoutOption],
    'no images => no media part, no drawing'
  );
  const { entries } = unzipStoredEntriesWithBinary(withoutOption);
  assert.ok(![...entries.keys()].some((name) => name.startsWith('word/media/')), 'no media part');
  assert.doesNotMatch(entries.get('[Content_Types].xml'), /Extension="png"/);
  assert.doesNotMatch(entries.get('word/document.xml'), /<w:drawing>/);
});

// VIZ-3 (PDF): the rendered diagram is embedded as a /DCTDecode image XObject
// above the preserved source. A PDF needs the JPEG variant (a raw PNG IDAT is
// not droppable), so the PDF path keys off image.jpeg. This canvas-less node
// test hands the builder a tiny but real JPEG buffer (SOI..EOI) so the XObject,
// resource wiring, and byte-accurate xref can all be asserted without a canvas.
const JPEG_FIXTURE = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
  0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0xff, 0xd9
]);

test('PDF embeds a rendered mermaid diagram as a DCTDecode image XObject above the source', async () => {
  const mermaidSource = [
    'graph TD',
    '  A[Client instructions] --> B[Draft DOCX]',
    '  B --> C[Review and export]'
  ].join('\n');
  const bytes = new Uint8Array(
    await buildPdfBlob(MERMAID_WORK_PRODUCT_MARKDOWN, {
      images: [{ source: mermaidSource, jpeg: JPEG_FIXTURE, width: 640, height: 360 }]
    }).arrayBuffer()
  );
  const latin1 = new TextDecoder('latin1').decode(bytes);

  // Structural sanity: still a parseable PDF with the original source preserved.
  assert.match(latin1, /^%PDF-1\.4/);
  assert.match(latin1, /startxref/);
  assert.match(latin1, /%%EOF/);
  assert.match(latin1, /Mermaid diagram source/);
  assert.match(latin1, /graph TD/);
  assert.match(latin1, /Draft DOCX/);

  // An image XObject exists, is a DCTDecode image, and carries the JPEG bytes.
  assert.match(latin1, /\/Subtype \/Image/);
  assert.match(latin1, /\/Filter \/DCTDecode/);
  assert.match(latin1, /\/Width 640 \/Height 360/);
  assert.match(latin1, /\/ColorSpace \/DeviceRGB \/BitsPerComponent 8/);
  const jpegMarker = String.fromCharCode(0xff, 0xd8, 0xff, 0xe0);
  assert.ok(latin1.includes(jpegMarker), 'embedded stream carries the JPEG SOI marker');

  // The image XObject /Length equals the real JPEG byte length.
  const lengthMatch = latin1.match(/\/Filter \/DCTDecode \/Length (\d+) >>\nstream\n/);
  assert.ok(lengthMatch, 'image XObject declares /Length');
  assert.equal(Number(lengthMatch[1]), JPEG_FIXTURE.length, 'image /Length is the JPEG byte count');

  // The page /Resources references the XObject by name and the content stream
  // draws it with a cm + Do above the source.
  assert.match(latin1, /\/XObject << \/Im1 \d+ 0 R >>/);
  assert.match(latin1, /\/Im1 Do/);
  assert.match(latin1, /\d+ 0 0 \d+ 72 -?\d+ cm/);
});

test('PDF embedded image keeps byte-accurate xref/startxref/Length for every object', async () => {
  const mermaidSource = ['graph TD', '  A --> B'].join('\n');
  const markdown = ['# Diagram', '', '```mermaid', 'graph TD', '  A --> B', '```'].join('\n');
  const bytes = new Uint8Array(
    await buildPdfBlob(markdown, {
      images: [{ source: mermaidSource, jpeg: JPEG_FIXTURE, width: 200, height: 120 }]
    }).arrayBuffer()
  );
  const latin1 = new TextDecoder('latin1').decode(bytes);

  const trailer = latin1.match(/startxref\n(\d+)\n%%EOF/);
  assert.ok(trailer, 'has startxref/%%EOF trailer');
  const startxref = Number(trailer[1]);
  assert.equal(latin1.slice(startxref, startxref + 4), 'xref', 'startxref lands on xref keyword');

  // Every in-use xref entry offset (including the image XObject) must land on
  // its own "<n> 0 obj" header — proves the dynamic numbering kept offsets exact.
  const entryRe = /^(\d{10}) 00000 n /gm;
  let entry;
  let index = 0;
  while ((entry = entryRe.exec(latin1.slice(startxref)))) {
    index += 1;
    const off = Number(entry[1]);
    const header = `${index} 0 obj`;
    assert.equal(
      latin1.slice(off, off + header.length),
      header,
      `xref entry ${index} points at its object header`
    );
  }
  // catalog, pages, font, page, image XObject, content = 6 objects on one page.
  assert.equal(index, 6, `expected 6 objects (incl. image XObject), saw ${index}`);

  // /Count and /Kids still agree with the single page object.
  const countMatch = latin1.match(/\/Type \/Pages \/Kids \[([^\]]*)\] \/Count (\d+)/);
  assert.ok(countMatch, 'has a /Pages node');
  assert.equal(Number(countMatch[2]), 1, 'single page /Count');
  const pageCount = (latin1.match(/\/Type \/Page\b(?!s)/g) || []).length;
  assert.equal(pageCount, 1, 'exactly one Page object');
});

test('PDF without supplied images is byte-identical to the source-only export', async () => {
  const withoutOption = new Uint8Array(
    await buildPdfBlob(MERMAID_WORK_PRODUCT_MARKDOWN).arrayBuffer()
  );
  const withEmptyImages = new Uint8Array(
    await buildPdfBlob(MERMAID_WORK_PRODUCT_MARKDOWN, { images: [] }).arrayBuffer()
  );
  assert.deepEqual(
    [...withEmptyImages],
    [...withoutOption],
    'no images => no XObject, no drawing, identical bytes'
  );
  const latin1 = new TextDecoder('latin1').decode(withoutOption);
  assert.doesNotMatch(latin1, /\/Subtype \/Image/);
  assert.doesNotMatch(latin1, /\/XObject/);
});

test('PDF skips the image when the supplied source does not match a fence', async () => {
  const bytes = new Uint8Array(
    await buildPdfBlob(MERMAID_WORK_PRODUCT_MARKDOWN, {
      images: [{ source: 'graph LR\n  X --> Y', jpeg: JPEG_FIXTURE, width: 320, height: 180 }]
    }).arrayBuffer()
  );
  const latin1 = new TextDecoder('latin1').decode(bytes);
  assert.doesNotMatch(latin1, /\/Subtype \/Image/);
  assert.match(latin1, /graph TD/, 'source still preserved');
});

test('PDF ignores a PNG-only image payload (no JPEG variant) and stays source-only', async () => {
  const mermaidSource = [
    'graph TD',
    '  A[Client instructions] --> B[Draft DOCX]',
    '  B --> C[Review and export]'
  ].join('\n');
  const withPngOnly = new Uint8Array(
    await buildPdfBlob(MERMAID_WORK_PRODUCT_MARKDOWN, {
      images: [{ source: mermaidSource, png: PNG_FIXTURE, width: 640, height: 360 }]
    }).arrayBuffer()
  );
  const sourceOnly = new Uint8Array(
    await buildPdfBlob(MERMAID_WORK_PRODUCT_MARKDOWN).arrayBuffer()
  );
  assert.deepEqual([...withPngOnly], [...sourceOnly], 'PNG-only payload cannot feed the PDF embed');
});

test('DOCX skips the drawing when the supplied image source does not match a fence', async () => {
  const docx = buildDocxBlob(MERMAID_WORK_PRODUCT_MARKDOWN, {
    images: [{ source: 'graph LR\n  X --> Y', png: PNG_FIXTURE, width: 320, height: 180 }]
  });
  const { entries } = unzipStoredEntriesWithBinary(new Uint8Array(await docx.arrayBuffer()));
  assert.ok(
    ![...entries.keys()].some((name) => name.startsWith('word/media/')),
    'no media for unmatched source'
  );
  assert.doesNotMatch(entries.get('word/document.xml'), /<w:drawing>/);
  assert.match(entries.get('word/document.xml'), /graph TD/, 'source still preserved');
});

// workproduct-2: the PDF must not truncate long content at 32 lines and must
// word-wrap lines that exceed the page width, paginating into multiple pages.
test('PDF export paginates long content instead of truncating at 32 lines', async () => {
  const content = Array.from({ length: 120 }, (_, index) => `Line ${index + 1} of the export`).join(
    '\n'
  );
  const latin1 = new TextDecoder('latin1').decode(
    new Uint8Array(await buildPdfBlob(content).arrayBuffer())
  );

  // Nothing is dropped: the first and the last source line both survive.
  assert.match(latin1, /\(Line 1 of the export\) Tj/);
  assert.match(latin1, /\(Line 120 of the export\) Tj/);

  // More than one page object exists and /Count + /Kids agree on the page total.
  const pageCount = (latin1.match(/\/Type \/Page\b(?!s)/g) || []).length;
  assert.ok(pageCount > 1, `expected multiple page objects, saw ${pageCount}`);
  const countMatch = latin1.match(/\/Type \/Pages \/Kids \[([^\]]*)\] \/Count (\d+)/);
  assert.ok(countMatch, 'has a /Pages node with /Kids and /Count');
  const kidsRefs = countMatch[1]
    .trim()
    .split(/\s+(?=\d+ 0 R)/)
    .filter(Boolean).length;
  assert.equal(Number(countMatch[2]), pageCount, '/Count matches the number of Page objects');
  assert.equal(kidsRefs, pageCount, '/Kids lists one ref per Page object');
});

test('PDF export word-wraps a long line on word boundaries within ~95 chars', async () => {
  const longWordRun = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ');
  const latin1 = new TextDecoder('latin1').decode(
    new Uint8Array(await buildPdfBlob(longWordRun).arrayBuffer())
  );

  // Each emitted text fragment ((...) Tj) must fit within the wrap width, and
  // wrapping happens at spaces so no word is split when it fits.
  const fragments = [...latin1.matchAll(/\(([^)]*)\) Tj/g)].map((match) => match[1]);
  assert.ok(fragments.length > 1, 'long line wrapped into multiple fragments');
  for (const fragment of fragments) {
    assert.ok(fragment.length <= 95, `wrapped fragment "${fragment}" exceeds 95 chars`);
  }
  // First and last whole words are preserved across the wrap.
  assert.ok(fragments.some((fragment) => fragment.startsWith('word0 ')));
  assert.ok(fragments.some((fragment) => fragment.endsWith('word39')));
});

// Byte-accuracy must survive pagination: the prior regression (offsets measured
// in UTF-16 units) would now corrupt every page's xref entry, so re-assert it
// against multi-page, non-ASCII content.
test('multi-page PDF keeps byte-accurate xref entries for every object', async () => {
  const content = Array.from(
    { length: 90 },
    (_, index) => `Café Résumé line ${index + 1} — Москва`
  ).join('\n');
  const latin1 = new TextDecoder('latin1').decode(
    new Uint8Array(await buildPdfBlob(content).arrayBuffer())
  );

  const trailer = latin1.match(/startxref\n(\d+)\n%%EOF/);
  assert.ok(trailer, 'has startxref/%%EOF trailer');
  const startxref = Number(trailer[1]);
  assert.equal(latin1.slice(startxref, startxref + 4), 'xref', 'startxref lands on xref keyword');

  const entryRe = /^(\d{10}) 00000 n /gm;
  let entry;
  let index = 0;
  while ((entry = entryRe.exec(latin1.slice(startxref)))) {
    index += 1;
    const off = Number(entry[1]);
    const header = `${index} 0 obj`;
    assert.equal(
      latin1.slice(off, off + header.length),
      header,
      `xref entry ${index} points at its object header`
    );
  }
  // 3 base objects + 2 per page; with 90 lines there is more than one page.
  assert.ok(index >= 7, `expected >=7 objects across multiple pages, saw ${index}`);
});

// workproduct-3: a binary artifact has no text `content`, so a JSON export of it
// produces a hollow payload (empty content, metadata-only attachment). This is
// why work-page gates the JSON button behind `content` and routes binaries to
// "Save original" — assert the hollow-payload shape that motivates the gate.
test('JSON export of a binary artifact (no text content) is hollow, not a real file', async () => {
  const json = JSON.parse(
    await buildJsonBlob({
      role: 'assistant',
      content: '',
      attachments: [
        {
          kind: 'work_item',
          filename: 'report.pdf',
          mime_type: 'application/pdf',
          size: 20480
        }
      ]
    }).text()
  );
  assert.equal(json.content, '', 'binary JSON export carries no document bytes');
  assert.equal(json.attachments[0].filename, 'report.pdf');
  assert.equal(json.attachments[0].mime_type, 'application/pdf');
  // The actual bytes are NOT embedded — confirming JSON is the wrong export for
  // binaries and "Save original" must be used instead.
  assert.equal(json.attachments[0].data_base64, undefined);
});

function unzipStoredEntries(bytes) {
  const entries = new Map();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 30 <= bytes.length && readU32(bytes, offset) === 0x04034b50) {
    const compressedSize = readU32(bytes, offset + 18);
    const fileNameLength = readU16(bytes, offset + 26);
    const extraLength = readU16(bytes, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + fileNameLength));
    const data = decoder.decode(bytes.slice(dataStart, dataStart + compressedSize));
    entries.set(name, data);
    offset = dataStart + compressedSize;
  }
  return entries;
}

// Like unzipStoredEntries but also keeps the raw bytes per entry, so binary
// parts (PNG media) can be asserted byte-for-byte without text-decode mangling.
function unzipStoredEntriesWithBinary(bytes) {
  const entries = new Map();
  const binary = new Map();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 30 <= bytes.length && readU32(bytes, offset) === 0x04034b50) {
    const compressedSize = readU32(bytes, offset + 18);
    const fileNameLength = readU16(bytes, offset + 26);
    const extraLength = readU16(bytes, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + fileNameLength));
    const raw = bytes.slice(dataStart, dataStart + compressedSize);
    entries.set(name, decoder.decode(raw));
    binary.set(name, raw);
    offset = dataStart + compressedSize;
  }
  return { entries, binary };
}

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Regression: the PDF must be assembled in BYTES. A prior version measured
// /Length, xref offsets and startxref with JS string .length (UTF-16 code
// units) while Blob serialized UTF-8, so any non-ASCII content shifted every
// offset and strict readers rejected the file. Build with non-ASCII text and
// assert byte-accurate structure.
test('PDF export computes byte-accurate xref/startxref/Length for non-ASCII content', async () => {
  const content = [
    '# Café Résumé — Москва', // accents, em-dash, Cyrillic
    'Curly "quotes", an emoji 😀, and an ellipsis…'
  ].join('\n');
  const bytes = new Uint8Array(await buildPdfBlob(content).arrayBuffer());
  // latin1 decode keeps char index === byte index, so substring offsets are byte offsets.
  const latin1 = new TextDecoder('latin1').decode(bytes);

  const trailer = latin1.match(/startxref\n(\d+)\n%%EOF/);
  assert.ok(trailer, 'has startxref/%%EOF trailer');
  const startxref = Number(trailer[1]);
  assert.equal(
    latin1.slice(startxref, startxref + 4),
    'xref',
    'startxref byte offset lands exactly on the xref keyword'
  );

  // Every in-use xref entry offset must land on its "<n> 0 obj" header.
  const entryRe = /^(\d{10}) 00000 n /gm;
  let entry;
  let index = 0;
  while ((entry = entryRe.exec(latin1.slice(startxref)))) {
    index += 1;
    const off = Number(entry[1]);
    const header = `${index} 0 obj`;
    assert.equal(
      latin1.slice(off, off + header.length),
      header,
      `xref entry ${index} points at its object header`
    );
  }
  assert.ok(index >= 5, 'all five objects have xref entries');

  // /Length must equal the real content-stream byte length.
  const lengthMatch = latin1.match(/<< \/Length (\d+) >>\nstream\n/);
  assert.ok(lengthMatch, 'content stream declares /Length');
  const declaredLength = Number(lengthMatch[1]);
  const streamStart = latin1.indexOf('stream\n', latin1.indexOf('/Length')) + 'stream\n'.length;
  const streamEnd = latin1.indexOf('\nendstream', streamStart);
  assert.equal(
    streamEnd - streamStart,
    declaredLength,
    '/Length equals the actual content-stream byte length'
  );
});
