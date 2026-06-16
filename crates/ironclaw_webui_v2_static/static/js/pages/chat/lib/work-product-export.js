import { renderMarkdown } from '../../../lib/markdown.js';
import { saveBlob } from '../../../lib/save-file.js';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MERMAID_EXPORT_LABEL = 'Mermaid diagram source';

export async function copyWorkProduct(content) {
  const text = String(content || '');
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

export function downloadMarkdown(content, filename = 'assistant-response.md') {
  return downloadBlob(filename, buildMarkdownBlob(content));
}

export function downloadHtml(content, filename = 'assistant-response.html') {
  return downloadBlob(filename, buildHtmlBlob(content));
}

export function downloadJson(message, filename = 'assistant-response.json') {
  return downloadBlob(filename, buildJsonBlob(message));
}

export function downloadDocx(content, filename = 'assistant-response.docx', options) {
  return downloadBlob(filename, buildDocxBlob(content, options));
}

export function downloadPdf(content, filename = 'assistant-response.pdf', options) {
  return downloadBlob(filename, buildPdfBlob(content, options));
}

// Rasterize already-rendered mermaid diagrams under `rootEl` into image buffers
// keyed by their fence source, so the exporters can embed the picture (not just
// the source). Each entry carries BOTH a PNG (lossless, what DOCX embeds) and a
// JPEG variant (what the PDF embeds via /DCTDecode, since a JPEG canvas blob is
// directly droppable as a PDF image XObject stream while a PNG IDAT is not).
// Only cards the user has rendered (with an <svg>) are collected; un-rendered
// diagrams fall back to the source-only path. Returns [] in any non-browser
// context (no canvas) so callers can pass the result straight to the builders
// without guarding.
export async function collectMermaidExportImages(rootEl) {
  if (!rootEl || typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return [];
  }
  const cards =
    typeof rootEl.querySelectorAll === 'function'
      ? Array.from(rootEl.querySelectorAll('[data-md-renderer="mermaid"]'))
      : [];
  const images = [];
  for (const card of cards) {
    const svg = card.querySelector?.('.v2-mermaid-card__output svg') || card.querySelector?.('svg');
    const source = card.querySelector?.('.v2-mermaid-card__source pre')?.textContent;
    if (!svg || !source) continue;
    try {
      const raster = await rasterizeSvgToImages(svg);
      if (raster && raster.png) {
        images.push({
          source: String(source),
          png: raster.png,
          jpeg: raster.jpeg || null,
          width: raster.width,
          height: raster.height
        });
      }
    } catch {
      // A diagram that cannot be rasterized just keeps the source-only export.
    }
  }
  return images;
}

function svgPixelSize(svg) {
  let width = 0;
  let height = 0;
  try {
    const box = typeof svg.getBBox === 'function' ? svg.getBBox() : null;
    if (box) {
      width = box.width;
      height = box.height;
    }
  } catch {
    // getBBox throws when the node is not laid out; fall through to attributes.
  }
  if (!width || !height) {
    const rect =
      typeof svg.getBoundingClientRect === 'function' ? svg.getBoundingClientRect() : null;
    if (rect && rect.width && rect.height) {
      width = rect.width;
      height = rect.height;
    }
  }
  if (!width || !height) {
    const vb = (svg.getAttribute?.('viewBox') || '')
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
      width = vb[2];
      height = vb[3];
    }
  }
  return {
    width: Math.max(1, Math.round(width || 800)),
    height: Math.max(1, Math.round(height || 450))
  };
}

function rasterizeSvgToImages(svg) {
  const { width, height } = svgPixelSize(svg);
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!clone.getAttribute('width')) clone.setAttribute('width', String(width));
  if (!clone.getAttribute('height')) clone.setAttribute('height', String(height));
  const serialized = new XMLSerializer().serializeToString(clone);
  // Encode as UTF-8 base64 so multi-byte glyphs in the diagram survive the
  // data URL; btoa() alone mangles characters above U+00FF.
  const encoded =
    typeof TextEncoder !== 'undefined'
      ? bytesToBase64(new TextEncoder().encode(serialized))
      : btoa(unescape(encodeURIComponent(serialized)));
  const dataUrl = `data:image/svg+xml;base64,${encoded}`;
  // Render at 2x for a crisp embed, but clamp pixels so a huge graph cannot
  // allocate an unbounded canvas.
  const scale = 2;
  const canvasWidth = Math.min(4000, Math.round(width * scale));
  const canvasHeight = Math.min(4000, Math.round(height * scale));

  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        // Opaque background: Word and PDF readers render PNG alpha as black,
        // which would hide a dark-themed diagram, and JPEG has no alpha at all.
        // Paint the diagram surface first so both variants stay legible.
        ctx.fillStyle = '#0b1220';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        ctx.drawImage(image, 0, 0, canvasWidth, canvasHeight);
        const png = dataUrlToBytes(canvas.toDataURL('image/png'));
        // JPEG variant for the PDF: a /DCTDecode image XObject embeds these
        // bytes verbatim. Quality 0.92 keeps diagram text crisp.
        let jpeg = null;
        try {
          jpeg = dataUrlToBytes(canvas.toDataURL('image/jpeg', 0.92));
        } catch {
          jpeg = null;
        }
        resolve(png ? { png, jpeg, width: canvasWidth, height: canvasHeight } : null);
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function dataUrlToBytes(dataUrl) {
  const comma = String(dataUrl || '').indexOf(',');
  if (comma < 0) return null;
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function buildMarkdownBlob(content) {
  return new Blob([String(content || '')], { type: 'text/markdown;charset=utf-8' });
}

export function buildHtmlBlob(content) {
  const body = renderMarkdown(annotateMermaidFences(String(content || '')));
  return new Blob(
    [
      `<!doctype html><html><head><meta charset="utf-8"><title>IronClaw export</title></head><body>${body}</body></html>`
    ],
    { type: 'text/html;charset=utf-8' }
  );
}

export function buildJsonBlob(message) {
  return new Blob(
    [
      JSON.stringify(
        {
          exported_at: new Date().toISOString(),
          role: message?.role || 'assistant',
          content: message?.content || '',
          attachments: message?.attachments || []
        },
        null,
        2
      )
    ],
    { type: 'application/json;charset=utf-8' }
  );
}

// `options.images` is an optional list of pre-rasterized mermaid diagrams keyed
// by their fence source: { source, png: Uint8Array, width, height }. When a
// mermaid fence in the content matches a provided image, the DOCX embeds the
// PNG as a real `word/media/imageN.png` part with an inline w:drawing, then
// keeps the labeled source code block below it. Rasterization needs a browser
// canvas, so it happens at the UI layer (collectMermaidExportImages); when no
// images are supplied the bytes are identical to the source-only export, which
// is why the canvas-less node test path stays unchanged.
export function buildDocxBlob(content, options = {}) {
  const { documentXml, relationships, mediaParts } = documentPartsFromMarkdown(
    String(content || ''),
    normalizeExportImages(options.images)
  );
  const relsXml = relationshipsXml([
    {
      id: 'rIdNumbering',
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
      target: 'numbering.xml'
    },
    ...relationships
  ]);
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  // The PNG Default content-type override is only added when at least one image
  // part exists, so an image-free export keeps the exact prior [Content_Types].
  const pngDefault = mediaParts.length ? '<Default Extension="png" ContentType="image/png"/>' : '';
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${pngDefault}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`;
  const bytes = zipStore([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'word/_rels/document.xml.rels', data: relsXml },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/numbering.xml', data: numberingXml() },
    ...mediaParts.map((part) => ({ name: `word/media/${part.filename}`, data: part.png }))
  ]);
  return new Blob([bytes], { type: DOCX_MIME });
}

// EMU is the OOXML drawing unit: 914400 per inch. Cap the embedded diagram at
// 6 inches wide (page text width on a 1" margin US Letter) and scale height by
// the source aspect ratio so wide mermaid graphs stay inside the margins.
const DOCX_EMU_PER_PX = 9525;
const DOCX_MAX_IMAGE_WIDTH_EMU = 6 * 914400;

function normalizeExportImages(images) {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (const image of images) {
    const png = image?.png;
    const source = String(image?.source || '');
    const isBytes = png instanceof Uint8Array && png.length > 0;
    if (!source || !isBytes) continue;
    const width = Number.isFinite(image.width) && image.width > 0 ? Math.round(image.width) : 0;
    const height = Number.isFinite(image.height) && image.height > 0 ? Math.round(image.height) : 0;
    out.push({ source, png, width, height });
  }
  return out;
}

function imageDrawingXml(part) {
  const naturalWidthEmu = (part.width || 800) * DOCX_EMU_PER_PX;
  const naturalHeightEmu = (part.height || 450) * DOCX_EMU_PER_PX;
  const scale =
    naturalWidthEmu > DOCX_MAX_IMAGE_WIDTH_EMU ? DOCX_MAX_IMAGE_WIDTH_EMU / naturalWidthEmu : 1;
  const widthEmu = Math.max(1, Math.round(naturalWidthEmu * scale));
  const heightEmu = Math.max(1, Math.round(naturalHeightEmu * scale));
  const docPrId = part.imageNumber;
  const name = `Diagram ${part.imageNumber}`;
  return (
    `<w:p><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<wp:extent cx="${widthEmu}" cy="${heightEmu}"/>` +
    `<wp:docPr id="${docPrId}" name="${escapeXmlAttr(name)}" descr="${escapeXmlAttr(MERMAID_EXPORT_LABEL)}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${escapeXmlAttr(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${part.relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  );
}

// PDF text layout: 14pt Helvetica on US Letter (612x792). Start the baseline at
// Y=760 (72pt from the top) and step 20pt per line; once the next baseline would
// drop below ~72pt of bottom margin, start a new page. Object layout is built
// dynamically (an allocator hands out the next free object number) so embedded
// diagram image XObjects can sit after the page/content objects without breaking
// the byte-measured xref. Base objects are still 1 Catalog, 2 Pages, 3 Font.
const PDF_TOP_Y = 760;
const PDF_LINE_HEIGHT = 20;
const PDF_BOTTOM_Y = 72;
// Page text column is 612 - 2*72 = 468pt wide on the 1" margins; cap an embedded
// diagram to that width and scale height by the source aspect ratio. The drawn
// height is converted to whole line-height steps so pagination stays line-based.
const PDF_CONTENT_LEFT = 72;
const PDF_MAX_IMAGE_WIDTH_PT = 612 - 2 * 72;
const PDF_IMAGE_GAP_LINES = 1;

function pdfImageDrawSize(image) {
  const naturalWidth = image.width > 0 ? image.width : 800;
  const naturalHeight = image.height > 0 ? image.height : 450;
  const scale = naturalWidth > PDF_MAX_IMAGE_WIDTH_PT ? PDF_MAX_IMAGE_WIDTH_PT / naturalWidth : 1;
  const drawWidth = Math.max(1, Math.round(naturalWidth * scale));
  const drawHeight = Math.max(1, Math.round(naturalHeight * scale));
  // How many text-line steps this image consumes, so the line-based paginator
  // can reserve room for it and the text cursor resumes below the picture.
  const lineSpan = Math.max(1, Math.ceil(drawHeight / PDF_LINE_HEIGHT)) + PDF_IMAGE_GAP_LINES;
  return { drawWidth, drawHeight, lineSpan };
}

// A page token is either a plain text line (string) or a drawn diagram image
// ({ image }). Image tokens reserve `lineSpan` vertical line-steps so a tall
// diagram pushes following text down and onto the next page when needed.
function tokenLineSpan(token) {
  if (token && typeof token === 'object' && token.image) {
    return pdfImageDrawSize(token.image).lineSpan;
  }
  return 1;
}

function paginatePdfTokens(tokens) {
  const pages = [];
  let current = [];
  let used = 0;
  const capacity = Math.floor((PDF_TOP_Y - PDF_BOTTOM_Y) / PDF_LINE_HEIGHT) + 1;
  for (const token of tokens) {
    const span = tokenLineSpan(token);
    if (current.length && used + span > capacity) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(token);
    used += span;
  }
  if (current.length) pages.push(current);
  return pages.length ? pages : [['IronClaw export']];
}

// Emit one page content stream. The text path is kept byte-identical to the
// prior text-only builder (BT / Td / Tj) when a page has no image, so the
// existing PDF regex assertions still hold. When a page carries an image the
// stream advances an absolute Y cursor: text runs in its own BT/ET block and
// each image is drawn with a saved graphics state (q .. cm /ImN Do Q).
function pdfContentStream(pageTokens, pageImageNames) {
  const hasImage = pageTokens.some((token) => token && typeof token === 'object' && token.image);
  if (!hasImage) {
    return [
      'BT',
      '/F1 14 Tf',
      `${PDF_CONTENT_LEFT} ${PDF_TOP_Y} Td`,
      ...pageTokens.map((line, index) =>
        index === 0
          ? `(${escapePdfText(line)}) Tj`
          : `0 -${PDF_LINE_HEIGHT} Td (${escapePdfText(line)}) Tj`
      ),
      'ET'
    ].join('\n');
  }
  const ops = [];
  let y = PDF_TOP_Y;
  let imageIndex = 0;
  for (const token of pageTokens) {
    if (token && typeof token === 'object' && token.image) {
      const { drawWidth, drawHeight } = pdfImageDrawSize(token.image);
      const name = pageImageNames[imageIndex];
      imageIndex += 1;
      // PDF image space is bottom-left origin: place the image so its TOP edge
      // sits at the current baseline cursor, then drop the cursor past it.
      const bottom = y - drawHeight;
      ops.push('q');
      ops.push(`${drawWidth} 0 0 ${drawHeight} ${PDF_CONTENT_LEFT} ${bottom} cm`);
      ops.push(`/${name} Do`);
      ops.push('Q');
      y -= tokenLineSpan(token) * PDF_LINE_HEIGHT;
      continue;
    }
    ops.push('BT');
    ops.push('/F1 14 Tf');
    ops.push(`${PDF_CONTENT_LEFT} ${y} Td`);
    ops.push(`(${escapePdfText(token)}) Tj`);
    ops.push('ET');
    y -= PDF_LINE_HEIGHT;
  }
  return ops.join('\n');
}

// A diagram image becomes a /DCTDecode (JPEG) image XObject. JPEG canvas bytes
// drop straight into the stream — a PNG IDAT cannot, since it is PNG-row-filtered
// under its zlib, so we carry a JPEG variant specifically for the PDF. /Length is
// the JPEG byte count (measured, like every other stream) so xref stays exact.
function pdfImageXObject(image, objectNumber) {
  const jpeg = image.jpeg;
  const header = encodeWinAnsi(
    `<< /Type /XObject /Subtype /Image /Width ${image.width || 1} /Height ${
      image.height || 1
    } /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
  );
  return {
    objectNumber,
    bytes: concatBytes([header, jpeg, encodeWinAnsi('\nendstream')])
  };
}

export function buildPdfBlob(content, options = {}) {
  const images = normalizePdfImages(options.images);
  const tokens = tokensForPdf(String(content || ''), images);
  const pages = paginatePdfTokens(tokens);
  // The content stream is emitted as WinAnsi single-byte so the base-14
  // Helvetica renders it AND one character is exactly one byte. The PDF
  // structure (xref offsets, startxref, /Length) is measured in BYTES, never
  // in JS string .length — a UTF-16 code-unit count would diverge from the
  // UTF-8 bytes a Blob writes and corrupt every offset for non-ASCII text.
  const objects = [];
  let nextObjectNumber = 1;
  const allocate = () => nextObjectNumber++;
  const catalogNumber = allocate();
  const pagesNumber = allocate();
  const fontNumber = allocate();
  // Reserve the page object numbers up front so /Kids can name them; the page
  // and content streams are filled in below, with image XObjects appended after.
  const pageNumbers = pages.map(() => allocate());
  const setObject = (number, bytes) => {
    objects[number - 1] = bytes;
  };
  setObject(catalogNumber, encodeWinAnsi(`<< /Type /Catalog /Pages ${pagesNumber} 0 R >>`));
  setObject(
    fontNumber,
    encodeWinAnsi(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
    )
  );
  const kids = pageNumbers.map((number) => `${number} 0 R`).join(' ');
  setObject(
    pagesNumber,
    encodeWinAnsi(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`)
  );
  pages.forEach((pageTokens, index) => {
    const pageImages = pageTokens
      .filter((token) => token && typeof token === 'object' && token.image)
      .map((token) => token.image);
    // Each image on this page gets its own XObject object + a page-local /ImN
    // resource name, wired into the page /Resources /XObject dictionary.
    const pageImageNames = pageImages.map((_, imageIndex) => `Im${imageIndex + 1}`);
    const xobjectEntries = pageImages.map((image, imageIndex) => {
      const objectNumber = allocate();
      objects[objectNumber - 1] = pdfImageXObject(image, objectNumber).bytes;
      return `/${pageImageNames[imageIndex]} ${objectNumber} 0 R`;
    });
    const contentNumber = allocate();
    const xobjectResource = xobjectEntries.length
      ? ` /XObject << ${xobjectEntries.join(' ')} >>`
      : '';
    setObject(
      pageNumbers[index],
      encodeWinAnsi(
        `<< /Type /Page /Parent ${pagesNumber} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNumber} 0 R >>${xobjectResource} >> /Contents ${contentNumber} 0 R >>`
      )
    );
    const streamBytes = encodeWinAnsi(pdfContentStream(pageTokens, pageImageNames));
    setObject(
      contentNumber,
      concatBytes([
        encodeWinAnsi(`<< /Length ${streamBytes.length} >>\nstream\n`),
        streamBytes,
        encodeWinAnsi('\nendstream')
      ])
    );
  });
  const chunks = [];
  let length = 0;
  const push = (bytes) => {
    chunks.push(bytes);
    length += bytes.length;
  };
  push(encodeWinAnsi('%PDF-1.4\n'));
  const offsets = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(length);
    push(encodeWinAnsi(`${index + 1} 0 obj\n`));
    push(objects[index]);
    push(encodeWinAnsi('\nendobj\n'));
  }
  const xref = length;
  const pdfXrefEol = new Uint8Array([32, 10]);
  push(encodeWinAnsi(`xref\n0 ${objects.length + 1}\n0000000000 65535 f`));
  push(pdfXrefEol);
  for (const offset of offsets) {
    push(encodeWinAnsi(`${String(offset).padStart(10, '0')} 00000 n`));
    push(pdfXrefEol);
  }
  push(
    encodeWinAnsi(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    )
  );
  return new Blob([concatBytes(chunks)], { type: 'application/pdf' });
}

// cp1252 high range (0x80-0x9F) for the typographic codepoints routine in LLM
// output — em/en dash, curly quotes, ellipsis, bullet — so they survive into
// the PDF instead of degrading. Latin-1 (0xA0-0xFF) maps to itself.
const WINANSI_HIGH = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f
};

function encodeWinAnsi(text) {
  const str = String(text || '');
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f || (code >= 0xa0 && code <= 0xff)) {
      out[i] = code;
    } else if (WINANSI_HIGH[code] !== undefined) {
      out[i] = WINANSI_HIGH[code];
    } else {
      out[i] = 0x3f; // unmappable (CJK, emoji) -> '?'
    }
  }
  return out;
}

function downloadBlob(filename, blob) {
  // Desktop: native save dialog via Rust (blob-anchor downloads are a silent
  // no-op in WKWebView). Hosted: classic anchor. Returns saved path | null.
  return saveBlob(blob, filename);
}

function documentPartsFromMarkdown(content, images = []) {
  const state = {
    relationships: [],
    linkIds: new Map(),
    images,
    mediaParts: []
  };
  const body = markdownBlocks(content, state).join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`;
  return { documentXml, relationships: state.relationships, mediaParts: state.mediaParts };
}

// Register a rendered PNG for a matched mermaid fence: one media part, one
// drawing relationship, and the inline w:drawing paragraph that references it.
function docxMermaidImageXml(source, state) {
  const images = Array.isArray(state?.images) ? state.images : [];
  if (!images.length) return '';
  const trimmed = String(source || '').trim();
  const match = images.find((image) => image.source.trim() === trimmed);
  if (!match) return '';
  const imageNumber = state.mediaParts.length + 1;
  const filename = `image${imageNumber}.png`;
  const relationshipId = `rIdImage${imageNumber}`;
  state.mediaParts.push({
    filename,
    png: match.png,
    width: match.width,
    height: match.height,
    imageNumber,
    relationshipId
  });
  state.relationships.push({
    id: relationshipId,
    type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
    target: `media/${filename}`
  });
  return imageDrawingXml(state.mediaParts[state.mediaParts.length - 1]);
}

function markdownBlocks(content, state) {
  const lines = String(content || '').split(/\r?\n/);
  const blocks = [];
  let inCode = false;
  let codeLanguage = '';
  let mermaidSource = [];
  let mermaidLabelIndex = -1;
  let tableRows = [];
  let tableSourceRows = [];

  const flushTable = () => {
    if (tableRows.length === 0) return;
    blocks.push(tableXml(tableRows, state));
    for (const sourceRow of tableSourceRows) {
      blocks.push(paragraphXml(sourceRow, { hidden: true }, state));
    }
    tableRows = [];
    tableSourceRows = [];
  };

  for (const line of lines) {
    const fence = parseFence(line);
    if (fence) {
      flushTable();
      if (inCode) {
        // On closing a mermaid fence, splice the rendered diagram drawing in
        // front of the label paragraph (so the image reads above its source).
        if (isMermaidLanguage(codeLanguage) && mermaidLabelIndex >= 0) {
          const drawing = docxMermaidImageXml(mermaidSource.join('\n'), state);
          if (drawing) blocks.splice(mermaidLabelIndex, 0, drawing);
        }
        inCode = false;
        codeLanguage = '';
        mermaidSource = [];
        mermaidLabelIndex = -1;
      } else {
        inCode = true;
        codeLanguage = fence.language;
        if (isMermaidLanguage(codeLanguage)) {
          mermaidSource = [];
          mermaidLabelIndex = blocks.length;
          blocks.push(paragraphXml(MERMAID_EXPORT_LABEL, {}, state));
        }
      }
      continue;
    }
    if (inCode) {
      if (isMermaidLanguage(codeLanguage)) mermaidSource.push(line);
      blocks.push(paragraphXml(line, { code: true }, state));
      continue;
    }
    if (isMarkdownTableRow(line)) {
      if (!/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) {
        tableSourceRows.push(line.trim());
        tableRows.push(
          line
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split(/(?<!\\)\|/)
            .map((cell) => cell.replace(/\\\|/g, '|').trim())
        );
      }
      continue;
    }
    flushTable();
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push(
        paragraphXml(
          heading[2],
          {
            paragraphProps: `<w:pPr><w:pStyle w:val="Heading${Math.min(3, heading[1].length)}"/></w:pPr>`
          },
          state
        )
      );
      continue;
    }
    const unordered = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (unordered) {
      blocks.push(
        listParagraphXml(unordered[2], { ordered: false, level: listLevel(unordered[1]) }, state)
      );
      continue;
    }
    const ordered = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
    if (ordered) {
      blocks.push(
        listParagraphXml(ordered[2], { ordered: true, level: listLevel(ordered[1]) }, state)
      );
      continue;
    }
    blocks.push(paragraphXml(line || ' ', {}, state));
  }
  flushTable();
  return blocks;
}

function listParagraphXml(text, { ordered = false, level = 0 } = {}, state) {
  const numId = ordered ? 2 : 1;
  return paragraphXml(
    text,
    {
      paragraphProps: `<w:pPr><w:numPr><w:ilvl w:val="${Math.max(0, Math.min(8, level))}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>`
    },
    state
  );
}

function paragraphXml(text, { code = false, hidden = false, paragraphProps = '' } = {}, state) {
  return `<w:p>${paragraphProps}${inlineRunsXml(text, { code, hidden }, state)}</w:p>`;
}

function inlineRunsXml(text, { code = false, hidden = false } = {}, state) {
  const value = String(text || '');
  const linkPattern = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  const parts = [];
  let cursor = 0;
  let match;
  while ((match = linkPattern.exec(value))) {
    if (match.index > cursor) {
      parts.push(runXml(stripMarkdown(value.slice(cursor, match.index)), { code, hidden }));
    }
    const label = stripMarkdown(match[1]);
    const href = safeDocxHref(match[2]);
    if (href && state) {
      const relationshipId = docxLinkRelationshipId(href, state);
      parts.push(
        `<w:hyperlink r:id="${relationshipId}" w:history="1">${runXml(label, {
          code,
          hidden,
          link: true
        })}</w:hyperlink>`
      );
    } else {
      parts.push(runXml(label || match[0], { code, hidden }));
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length || parts.length === 0) {
    parts.push(runXml(stripMarkdown(value.slice(cursor)), { code, hidden }));
  }
  return parts.join('');
}

function runXml(text, { code = false, hidden = false, link = false } = {}) {
  const runProps = [
    code ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>' : '',
    hidden ? '<w:vanish/>' : '',
    link ? '<w:color w:val="0563C1"/><w:u w:val="single"/>' : ''
  ]
    .filter(Boolean)
    .join('');
  const props = runProps ? `<w:rPr>${runProps}</w:rPr>` : '';
  return `<w:r>${props}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function tableXml(rows, state) {
  return `<w:tbl>${rows
    .map(
      (row) =>
        `<w:tr>${row.map((cell) => `<w:tc>${paragraphXml(cell, {}, state)}</w:tc>`).join('')}</w:tr>`
    )
    .join('')}</w:tbl>`;
}

function listLevel(indent) {
  return Math.floor(String(indent || '').replace(/\t/g, '  ').length / 2);
}

function docxLinkRelationshipId(href, state) {
  const existing = state.linkIds.get(href);
  if (existing) return existing;
  const id = `rIdLink${state.relationships.length + 1}`;
  state.linkIds.set(href, id);
  state.relationships.push({
    id,
    type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
    target: href,
    targetMode: 'External'
  });
  return id;
}

function safeDocxHref(value) {
  const href = String(value || '').trim();
  return /^(https?:|mailto:)/i.test(href) ? href : '';
}

function relationshipsXml(relationships) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships
    .map(
      (relationship) =>
        `<Relationship Id="${escapeXmlAttr(relationship.id)}" Type="${escapeXmlAttr(
          relationship.type
        )}" Target="${escapeXmlAttr(relationship.target)}"${relationship.targetMode ? ` TargetMode="${escapeXmlAttr(relationship.targetMode)}"` : ''}/>`
    )
    .join('')}</Relationships>`;
}

function numberingXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
  <w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>
</w:numbering>`;
}

function isMarkdownTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}

// Validate and trim the PDF image inputs. A PDF embed needs the JPEG variant
// (DCTDecode); entries without one fall back to source-only, so DOCX-style
// PNG-only payloads do not break the PDF path.
function normalizePdfImages(images) {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (const image of images) {
    const jpeg = image?.jpeg;
    const source = String(image?.source || '');
    const isBytes = jpeg instanceof Uint8Array && jpeg.length > 0;
    if (!source || !isBytes) continue;
    const width = Number.isFinite(image.width) && image.width > 0 ? Math.round(image.width) : 0;
    const height = Number.isFinite(image.height) && image.height > 0 ? Math.round(image.height) : 0;
    out.push({ source, jpeg, width, height });
  }
  return out;
}

// Turn markdown into the ordered PDF token stream: text lines (strings) plus a
// drawn diagram image token ({ image }) inserted directly above its mermaid
// source whenever a rendered JPEG matches the fence. The source text is still
// emitted below the image, so an unrendered or unmatched diagram keeps the exact
// prior source-only output.
function tokensForPdf(content, images = []) {
  const tokens = [];
  let inCode = false;
  let codeLanguage = '';
  let mermaidSource = [];
  let mermaidLabelIndex = -1;

  for (const line of String(content || '').split(/\r?\n/)) {
    const fence = parseFence(line);
    if (fence) {
      if (inCode) {
        if (isMermaidLanguage(codeLanguage) && mermaidLabelIndex >= 0 && images.length) {
          const trimmed = mermaidSource.join('\n').trim();
          const match = images.find((image) => image.source.trim() === trimmed);
          if (match) tokens.splice(mermaidLabelIndex + 1, 0, { image: match });
        }
        inCode = false;
        codeLanguage = '';
        mermaidSource = [];
        mermaidLabelIndex = -1;
      } else {
        inCode = true;
        codeLanguage = fence.language;
        if (isMermaidLanguage(codeLanguage)) {
          mermaidSource = [];
          mermaidLabelIndex = tokens.length;
          tokens.push(MERMAID_EXPORT_LABEL);
        }
      }
      continue;
    }
    if (inCode && isMermaidLanguage(codeLanguage)) {
      mermaidSource.push(line);
    }
    const text = stripMarkdown(line).trim();
    if (text) {
      for (const wrapped of wrapPdfLine(text)) {
        tokens.push(wrapped);
      }
    }
  }
  return tokens.length ? tokens : ['IronClaw export'];
}

// Word-wrap a single logical line at ~95 chars on word boundaries so PDF text
// stays inside the MediaBox instead of running off the right edge. A single word
// longer than the limit is hard-split so it can still paginate.
const PDF_WRAP_WIDTH = 95;

function wrapPdfLine(text) {
  const value = String(text || '');
  if (value.length <= PDF_WRAP_WIDTH) return [value];
  const out = [];
  let current = '';
  for (const word of value.split(/\s+/)) {
    if (!word) continue;
    if (word.length > PDF_WRAP_WIDTH) {
      if (current) {
        out.push(current);
        current = '';
      }
      let rest = word;
      while (rest.length > PDF_WRAP_WIDTH) {
        out.push(rest.slice(0, PDF_WRAP_WIDTH));
        rest = rest.slice(PDF_WRAP_WIDTH);
      }
      current = rest;
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > PDF_WRAP_WIDTH) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out.length ? out : [''];
}

function annotateMermaidFences(content) {
  const lines = String(content || '').split(/\r?\n/);
  const output = [];
  let inCode = false;

  for (const line of lines) {
    const fence = parseFence(line);
    if (fence) {
      if (inCode) {
        inCode = false;
      } else {
        inCode = true;
        if (
          isMermaidLanguage(fence.language) &&
          !lastNonEmptyLineIs(output, `**${MERMAID_EXPORT_LABEL}**`)
        ) {
          if (output.length && output.at(-1) !== '') output.push('');
          output.push(`**${MERMAID_EXPORT_LABEL}**`, '');
        }
      }
    }
    output.push(line);
  }

  return output.join('\n');
}

function lastNonEmptyLineIs(lines, expected) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index] === '') continue;
    return lines[index] === expected;
  }
  return false;
}

function parseFence(line) {
  const match = String(line || '')
    .trim()
    .match(/^```+\s*([^\s`]*)/);
  if (!match) return null;
  return { language: String(match[1] || '').toLowerCase() };
}

function isMermaidLanguage(language) {
  return String(language || '').toLowerCase() === 'mermaid';
}

function stripMarkdown(value) {
  return String(value || '')
    .replace(/^#{1,6}\s+(.+)$/gm, (_, heading) => heading.toUpperCase())
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

function escapeXml(value) {
  return (
    String(value || '')
      // XML 1.0 forbids C0 control chars except tab/newline/carriage-return;
      // a stray control byte in content otherwise yields an unopenable .docx.
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  );
}

function escapeXmlAttr(value) {
  return escapeXml(value).replace(/'/g, '&apos;');
}

function escapePdfText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function zipStore(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    const crc = crc32(data);
    const local = concatBytes([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      data
    ]);
    localParts.push(local);
    centralParts.push(
      concatBytes([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name
      ])
    );
    offset += local.length;
  }

  const central = concatBytes(centralParts);
  const end = concatBytes([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(offset),
    u16(0)
  ]);
  return concatBytes([...localParts, central, end]);
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u16(value) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
