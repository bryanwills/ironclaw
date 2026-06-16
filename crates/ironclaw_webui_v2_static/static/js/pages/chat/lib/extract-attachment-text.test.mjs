import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractAttachmentText,
  isDocxAttachment,
  isExtractableBinary,
  isPdfAttachment,
  isPptxAttachment,
  isXlsxAttachment,
  legacyOfficeUpgrade,
  textToBase64
} from './extract-attachment-text.js';

// Build a stored-method (no compression) ZIP holding the given entries —
// enough to exercise the central-directory walk and entry decoding without a
// zip library in the test.
function buildStoredZip(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };

  for (const [name, content] of entries) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // stored
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    chunks.push(local);

    const header = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(header.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 0, true); // stored
    cv.setUint32(20, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    header.set(nameBytes, 46);
    central.push(header);
    offset += local.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const header of central) centralSize += header.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);

  const total = new Uint8Array(centralStart + centralSize + 22);
  let cursor = 0;
  for (const chunk of [...chunks, ...central, eocd]) {
    total.set(chunk, cursor);
    cursor += chunk.length;
  }
  return total;
}

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

test('classifiers match by mime and by extension', () => {
  assert.ok(isPdfAttachment({ mime_type: 'application/pdf' }));
  assert.ok(isPdfAttachment({ filename: 'Report.PDF', mime_type: '' }));
  assert.ok(isDocxAttachment({ filename: 'minutes.docx', mime_type: '' }));
  assert.ok(isXlsxAttachment({ filename: 'ledger.xlsx', mime_type: '' }));
  assert.ok(!isExtractableBinary({ filename: 'notes.txt', mime_type: 'text/plain' }));
});

test('docx extraction pulls paragraph text and decodes entities', async () => {
  const xml =
    '<?xml version="1.0"?><w:document><w:body>' +
    '<w:p><w:r><w:t>Board minutes &amp; agenda</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Approve Q3 budget of &#8364;500</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  const zip = buildStoredZip([['word/document.xml', xml]]);
  const result = await extractAttachmentText({
    base64: toBase64(zip),
    filename: 'minutes.docx',
    mime_type: ''
  });
  assert.equal(result.extracted, true);
  assert.ok(result.text.includes('Board minutes & agenda'));
  assert.ok(result.text.includes('Approve Q3 budget of €500'));
});

test('xlsx extraction resolves shared strings into rows', async () => {
  const shared = '<sst><si><t>Item</t></si><si><t>Widget</t></si></sst>';
  const sheet =
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>0</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42.5</v></c></row>' +
    '</sheetData></worksheet>';
  const zip = buildStoredZip([
    ['xl/sharedStrings.xml', shared],
    ['xl/worksheets/sheet1.xml', sheet]
  ]);
  const result = await extractAttachmentText({
    base64: toBase64(zip),
    filename: 'ledger.xlsx',
    mime_type: ''
  });
  assert.equal(result.extracted, true);
  assert.ok(result.text.includes('Item'));
  assert.ok(result.text.includes('Widget\t42.5'));
});

test('garbage payloads fall back to extracted:false instead of throwing', async () => {
  const result = await extractAttachmentText({
    base64: Buffer.from('PK not actually a zip').toString('base64'),
    filename: 'broken.docx',
    mime_type: ''
  });
  assert.equal(result.extracted, false);
});

test('textToBase64 round-trips unicode', () => {
  const text = 'Résumé — 日本語 ✓';
  const decoded = Buffer.from(textToBase64(text), 'base64').toString('utf8');
  assert.equal(decoded, text);
});

// --- file-type matrix hardening (verified real-world failure shapes) ---

test('xlsx inlineStr cells (openpyxl/pandas output) keep their text', async () => {
  // openpyxl writes NO sharedStrings.xml; every string is an inline <is><t>.
  const sheet =
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Region</t></is></c><c r="B1" t="inlineStr"><is><t>Q1</t></is></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>EMEA</t></is></c><c r="B2"><v>1234.5</v></c></row>' +
    '</sheetData></worksheet>';
  const zip = buildStoredZip([['xl/worksheets/sheet1.xml', sheet]]);
  const result = await extractAttachmentText({
    bytes: zip,
    filename: 'generated.xlsx',
    mime_type: ''
  });
  assert.equal(result.extracted, true);
  assert.ok(result.text.includes('Region\tQ1'));
  assert.ok(result.text.includes('EMEA\t1234.5'));
});

test('xlsx self-closing styled-empty cells do not swallow their neighbors', async () => {
  // Real Excel output for a formatted-but-empty cell is `<c r="A1" s="1"/>`.
  const shared = '<sst><si><t>Plain</t></si><si><r><t>Rich </t></r><r><t>Bold</t></r></si></sst>';
  const sheet =
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" s="1"/><c r="B1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
    '</sheetData></worksheet>';
  const zip = buildStoredZip([
    ['xl/sharedStrings.xml', shared],
    ['xl/worksheets/sheet1.xml', sheet]
  ]);
  const result = await extractAttachmentText({
    bytes: zip,
    filename: 'styled.xlsx',
    mime_type: ''
  });
  assert.equal(result.extracted, true);
  // The broken regex swallowed B1 and leaked the shared index: "0\tRich Bold".
  assert.ok(result.text.includes('Plain\tRich Bold'));
  assert.ok(!result.text.includes('0\t'));
});

test('xlsx multi-sheet output is labeled with workbook sheet names', async () => {
  const workbook =
    '<workbook><sheets><sheet name="Revenue" sheetId="1"/><sheet name="Costs" sheetId="2"/></sheets></workbook>';
  const sheetXml = (value) =>
    `<worksheet><sheetData><row r="1"><c r="A1"><v>${value}</v></c></row></sheetData></worksheet>`;
  const zip = buildStoredZip([
    ['xl/workbook.xml', workbook],
    ['xl/worksheets/sheet1.xml', sheetXml(100)],
    ['xl/worksheets/sheet2.xml', sheetXml(200)]
  ]);
  const result = await extractAttachmentText({
    bytes: zip,
    filename: 'multi.xlsx',
    mime_type: ''
  });
  assert.ok(result.text.includes('--- Revenue ---\n100'));
  assert.ok(result.text.includes('--- Costs ---\n200'));
});

test('docx line breaks, hex entities, and headers/footers survive extraction', async () => {
  const doc =
    '<w:document><w:body>' +
    '<w:p><w:r><w:t>line one</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>line two &#x2014; dash</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  const header = '<w:hdr><w:p><w:r><w:t>CONFIDENTIAL-HEADER</w:t></w:r></w:p></w:hdr>';
  const zip = buildStoredZip([
    ['word/document.xml', doc],
    ['word/header1.xml', header]
  ]);
  const result = await extractAttachmentText({
    bytes: zip,
    filename: 'memo.docx',
    mime_type: ''
  });
  assert.ok(result.text.includes('line one\nline two — dash'));
  assert.ok(result.text.includes('Headers/Footers:'));
  assert.ok(result.text.includes('CONFIDENTIAL-HEADER'));
});

test('pptx slides extract with slide labels in order', async () => {
  const slide = (text) => `<p:sld><p:cSld><a:t>${text}</a:t></p:cSld></p:sld>`;
  const zip = buildStoredZip([
    ['ppt/slides/slide2.xml', slide('Roadmap Q3')],
    ['ppt/slides/slide1.xml', slide('Company Overview')]
  ]);
  const result = await extractAttachmentText({
    bytes: zip,
    filename: 'deck.pptx',
    mime_type: ''
  });
  assert.equal(result.extracted, true);
  const first = result.text.indexOf('--- Slide 1 ---\nCompany Overview');
  const second = result.text.indexOf('--- Slide 2 ---\nRoadmap Q3');
  assert.ok(first !== -1 && second !== -1 && first < second);
});

test('macro variants route to the OOXML extractors; legacy formats are flagged for upgrade', async () => {
  assert.equal(isDocxAttachment({ filename: 'report.docm', mime_type: '' }), true);
  assert.equal(isXlsxAttachment({ filename: 'model.xlsm', mime_type: '' }), true);
  assert.equal(isPptxAttachment({ filename: 'deck.pptm', mime_type: '' }), true);

  assert.equal(legacyOfficeUpgrade({ filename: 'old.xls', mime_type: '' }), '.xlsx');
  assert.equal(
    legacyOfficeUpgrade({ filename: 'old.doc', mime_type: 'application/msword' }),
    '.docx'
  );
  assert.equal(legacyOfficeUpgrade({ filename: 'old.ppt', mime_type: '' }), '.pptx');
  // Extension is authoritative: platforms mislabel CSV as vnd.ms-excel.
  assert.equal(
    legacyOfficeUpgrade({ filename: 'data.csv', mime_type: 'application/vnd.ms-excel' }),
    null
  );
  assert.equal(legacyOfficeUpgrade({ filename: 'report.xlsx', mime_type: '' }), null);
});

// --- container hardening: ZIP64, encrypted, corrupt, per-entry isolation ---

import zlib from 'node:zlib';

// Hand-build a VALID ZIP64 package (locator + zip64 EOCD record + classic
// EOCD with 0xFFFF/0xFFFFFFFF placeholders) holding one deflated entry.
function buildZip64(name, content) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const data = enc.encode(content);
  const comp = zlib.deflateRawSync(data);
  const u16 = (v) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    return b;
  };
  const u32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const u64 = (v) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v));
    return b;
  };

  const lh = Buffer.concat([
    Buffer.from('PK\x03\x04', 'latin1'),
    u16(45),
    u16(0),
    u16(8),
    u16(0),
    u16(0),
    u32(0),
    u32(comp.length),
    u32(data.length),
    u16(nameB.length),
    u16(0),
    Buffer.from(nameB)
  ]);
  const cdirOff = lh.length + comp.length;
  const ch = Buffer.concat([
    Buffer.from('PK\x01\x02', 'latin1'),
    u16(45),
    u16(45),
    u16(0),
    u16(8),
    u16(0),
    u16(0),
    u32(0),
    u32(comp.length),
    u32(data.length),
    u16(nameB.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    Buffer.from(nameB)
  ]);
  const z64Off = cdirOff + ch.length;
  const z64 = Buffer.concat([
    Buffer.from('PK\x06\x06', 'latin1'),
    u64(44),
    u16(45),
    u16(45),
    u32(0),
    u32(0),
    u64(1),
    u64(1),
    u64(ch.length),
    u64(cdirOff)
  ]);
  const loc = Buffer.concat([Buffer.from('PK\x06\x07', 'latin1'), u32(0), u64(z64Off), u32(1)]);
  const eocd = Buffer.concat([
    Buffer.from('PK\x05\x06', 'latin1'),
    u16(0),
    u16(0),
    u16(0xffff),
    u16(0xffff),
    u32(0xffffffff),
    u32(0xffffffff),
    u16(0)
  ]);
  return new Uint8Array(Buffer.concat([lh, comp, ch, z64, loc, eocd]));
}

test('ZIP64 packages (0xFFFFFFFF EOCD placeholders) are read via the zip64 record', async () => {
  const sheet =
    '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ZIP64 OK 5512</t></is></c></row></sheetData></worksheet>';
  const bytes = buildZip64('xl/worksheets/sheet1.xml', sheet);
  const result = await extractAttachmentText({ bytes, filename: 'big.xlsx', mime_type: '' });
  assert.equal(result.extracted, true);
  assert.ok(result.text.includes('ZIP64 OK 5512'));
});

test('encrypted/CFB workbook reports reason "encrypted" (no fake extraction)', async () => {
  const cfb = new Uint8Array(64);
  cfb.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  const result = await extractAttachmentText({
    bytes: cfb,
    filename: 'secret.xlsx',
    mime_type: ''
  });
  assert.equal(result.extracted, false);
  assert.equal(result.reason, 'encrypted');
});

test('truncated/corrupt zip reports reason "corrupt"', async () => {
  const full = buildStoredZip([
    [
      'xl/worksheets/sheet1.xml',
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>'
    ]
  ]);
  // Chop the tail so the central directory / EOCD is gone but the PK header stays.
  const truncated = full.slice(0, Math.max(8, full.length - 80));
  const result = await extractAttachmentText({
    bytes: truncated,
    filename: 'broken.xlsx',
    mime_type: ''
  });
  assert.equal(result.extracted, false);
  assert.equal(result.reason, 'corrupt');
});

test('a single corrupt entry does not zero out the rest of the package', async () => {
  // Two sheets: one valid, one whose deflate stream is garbage. The good
  // sheet must still come through (per-entry isolation).
  const enc = new TextEncoder();
  const good = enc.encode(
    '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SURVIVOR 4242</t></is></c></row></sheetData></worksheet>'
  );
  // Build a normal stored zip, then corrupt one entry's data in place is
  // hard; instead store one good + one deflate-claimed entry with bad bytes.
  const u16 = (v) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    return b;
  };
  const u32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const mkLocal = (name, data, method) => {
    const nameB = enc.encode(name);
    return Buffer.concat([
      Buffer.from('PK\x03\x04', 'latin1'),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(0),
      u32(data.length),
      u32(data.length),
      u16(nameB.length),
      u16(0),
      Buffer.from(nameB),
      Buffer.from(data)
    ]);
  };
  const badData = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]); // not valid deflate
  const l1 = mkLocal('xl/worksheets/sheet1.xml', Buffer.from(good), 0); // stored, valid
  const l2 = mkLocal('xl/worksheets/sheet2.xml', badData, 8); // deflate, garbage
  const off1 = 0;
  const off2 = l1.length;
  const mkCentral = (name, data, method, off) => {
    const nameB = enc.encode(name);
    return Buffer.concat([
      Buffer.from('PK\x01\x02', 'latin1'),
      u16(20),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(0),
      u32(data.length),
      u32(data.length),
      u16(nameB.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(off),
      Buffer.from(nameB)
    ]);
  };
  const c1 = mkCentral('xl/worksheets/sheet1.xml', Buffer.from(good), 0, off1);
  const c2 = mkCentral('xl/worksheets/sheet2.xml', badData, 8, off2);
  const cdOff = l1.length + l2.length;
  const cdSize = c1.length + c2.length;
  const eocd = Buffer.concat([
    Buffer.from('PK\x05\x06', 'latin1'),
    u16(0),
    u16(0),
    u16(2),
    u16(2),
    u32(cdSize),
    u32(cdOff),
    u16(0)
  ]);
  const bytes = new Uint8Array(Buffer.concat([l1, l2, c1, c2, eocd]));
  const result = await extractAttachmentText({ bytes, filename: 'mixed.xlsx', mime_type: '' });
  assert.equal(result.extracted, true);
  assert.ok(result.text.includes('SURVIVOR 4242'));
});

// --- adversarial-verification regressions: real Office structures (D1-D13) ---

import zlibD from 'node:zlib';

// Build a deflate-compressed OOXML zip from { name: stringOrBytes }.
function buildZip(entries) {
  const enc = new TextEncoder();
  const u16 = (v) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v >>> 0);
    return b;
  };
  const u32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0);
    return b;
  };
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameB = Buffer.from(enc.encode(name));
    const raw =
      typeof content === 'string' ? Buffer.from(enc.encode(content)) : Buffer.from(content);
    const comp = zlibD.deflateRawSync(raw);
    const crc = crc32(raw);
    const lh = Buffer.concat([
      Buffer.from('PK\x03\x04', 'latin1'),
      u16(20),
      u16(0),
      u16(8),
      u16(0),
      u16(0),
      u32(crc),
      u32(comp.length),
      u32(raw.length),
      u16(nameB.length),
      u16(0),
      nameB,
      comp
    ]);
    locals.push(lh);
    centrals.push(
      Buffer.concat([
        Buffer.from('PK\x01\x02', 'latin1'),
        u16(20),
        u16(20),
        u16(0),
        u16(8),
        u16(0),
        u16(0),
        u32(crc),
        u32(comp.length),
        u32(raw.length),
        u16(nameB.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameB
      ])
    );
    offset += lh.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    Buffer.from('PK\x05\x06', 'latin1'),
    u16(0),
    u16(0),
    u16(centrals.length),
    u16(centrals.length),
    u32(cd.length),
    u32(offset),
    u16(0)
  ]);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

const ex = (bytes, filename) => extractAttachmentText({ bytes, filename, mime_type: '' });

test('D12: sheet display names bind to worksheet files via r:id, not numeric order', async () => {
  const bytes = buildZip({
    'xl/workbook.xml':
      '<workbook xmlns:r="r"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Quarterly" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet2.xml"/><Relationship Id="rId2" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>QUARTERLY_BODY</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SUMMARY_BODY</t></is></c></row></sheetData></worksheet>'
  });
  const r = await ex(bytes, 'swap.xlsx');
  assert.equal(r.extracted, true);
  assert.ok(r.text.includes('--- Summary ---\nSUMMARY_BODY'));
  assert.ok(r.text.includes('--- Quarterly ---\nQUARTERLY_BODY'));
});

test('D6: pivot-cache-only data is surfaced when the view sheet is empty', async () => {
  const bytes = buildZip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Pivot" sheetId="1"/></sheets></workbook>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData/></worksheet>',
    'xl/pivotCache/pivotCacheDefinition1.xml':
      '<pivotCacheDefinition><cacheField><sharedItems><s v="PIVOT_NORTH"/><s v="PIVOT_SOUTH"/></sharedItems></cacheField></pivotCacheDefinition>'
  });
  const r = await ex(bytes, 'pivot.xlsx');
  assert.equal(r.extracted, true);
  assert.ok(r.text.includes('PIVOT_NORTH') && r.text.includes('PIVOT_SOUTH'));
});

test('D4/D5: DOCX footnotes, endnotes and comments are extracted', async () => {
  const bytes = buildZip({
    'word/document.xml':
      '<w:document><w:body><w:p><w:r><w:t>BODY_TEXT</w:t></w:r></w:p></w:body></w:document>',
    'word/footnotes.xml':
      '<w:footnotes><w:footnote w:id="1"><w:p><w:r><w:t>FOOTNOTE_HERE</w:t></w:r></w:p></w:footnote></w:footnotes>',
    'word/endnotes.xml':
      '<w:endnotes><w:endnote w:id="1"><w:p><w:r><w:t>ENDNOTE_HERE</w:t></w:r></w:p></w:endnote></w:endnotes>',
    'word/comments.xml':
      '<w:comments><w:comment w:id="1"><w:p><w:r><w:t>COMMENT_HERE</w:t></w:r></w:p></w:comment></w:comments>'
  });
  const r = await ex(bytes, 'notes.docx');
  assert.ok(r.text.includes('FOOTNOTE_HERE'));
  assert.ok(r.text.includes('ENDNOTE_HERE'));
  assert.ok(r.text.includes('COMMENT_HERE'));
});

test('D11: tracked deletions are dropped and never fused to inserted text', async () => {
  const bytes = buildZip({
    'word/document.xml':
      '<w:document><w:body><w:p><w:ins><w:r><w:t>KEPT_INSERT</w:t></w:r></w:ins><w:del><w:r><w:delText>GONE_DELETE</w:delText></w:r></w:del><w:r><w:t>AFTER</w:t></w:r></w:p></w:body></w:document>'
  });
  const r = await ex(bytes, 'tracked.docx');
  assert.ok(r.text.includes('KEPT_INSERT'));
  assert.ok(!r.text.includes('GONE_DELETE'));
  assert.ok(!r.text.includes('KEPT_INSERTGONE'));
});

test('D1/D2: PPTX xml:space runs extract and runs within a paragraph stay contiguous', async () => {
  const preserve = buildZip({
    'ppt/slides/slide1.xml':
      '<p:sld><p:cSld><a:p><a:r><a:t xml:space="preserve">PRESERVE_RUN </a:t></a:r></a:p></p:cSld></p:sld>'
  });
  const split = buildZip({
    'ppt/slides/slide1.xml':
      '<p:sld><p:cSld><a:p><a:r><a:t>MARK</a:t></a:r><a:r><a:t>ER_SPLIT</a:t></a:r></a:p></p:cSld></p:sld>'
  });
  const r1 = await ex(preserve, 'p.pptx');
  const r2 = await ex(split, 's.pptx');
  assert.ok(r1.extracted && r1.text.includes('PRESERVE_RUN'));
  assert.ok(r2.extracted && r2.text.includes('MARKER_SPLIT'));
});

test('D7/D8/D9: PPTX speaker notes, SmartArt and chart text are extracted', async () => {
  const bytes = buildZip({
    'ppt/slides/slide1.xml':
      '<p:sld><p:cSld><a:p><a:r><a:t>SLIDE_BODY</a:t></a:r></a:p></p:cSld></p:sld>',
    'ppt/notesSlides/notesSlide1.xml':
      '<p:notes><p:cSld><a:p><a:r><a:t>SPEAKER_NOTES</a:t></a:r></a:p></p:cSld></p:notes>',
    'ppt/diagrams/data1.xml': '<dsp><a:p><a:r><a:t>SMARTART_NODE</a:t></a:r></a:p></dsp>',
    'ppt/charts/chart1.xml':
      '<c:chartSpace><c:title><a:p><a:r><a:t>CHART_TITLE</a:t></a:r></a:p></c:title><c:cat><c:v>CHART_CAT</c:v></c:cat></c:chartSpace>'
  });
  const r = await ex(bytes, 'deck.pptx');
  assert.ok(r.text.includes('SPEAKER_NOTES'));
  assert.ok(r.text.includes('SMARTART_NODE'));
  assert.ok(r.text.includes('CHART_TITLE') && r.text.includes('CHART_CAT'));
});

test('D13: PPTX slides are emitted in authored order (presentation rels), not filename order', async () => {
  const mk = (t) => '<p:sld><p:cSld><a:p><a:r><a:t>' + t + '</a:t></a:r></a:p></p:cSld></p:sld>';
  const bytes = buildZip({
    'ppt/presentation.xml':
      '<p:presentation xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="slides/slide3.xml"/><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': mk('POS_SECOND'),
    'ppt/slides/slide2.xml': mk('POS_THIRD'),
    'ppt/slides/slide3.xml': mk('POS_FIRST')
  });
  const r = await ex(bytes, 'order.pptx');
  const a = r.text.indexOf('POS_FIRST'),
    b = r.text.indexOf('POS_SECOND'),
    c = r.text.indexOf('POS_THIRD');
  assert.ok(a >= 0 && a < b && b < c);
});

test('D10: prefixed/polyglot zip (SFX/BOM stub) is rebased and extracted', async () => {
  const inner = buildZip({
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>PREFIXED_DATA</t></is></c></row></sheetData></worksheet>'
  });
  const prefixed = new Uint8Array(
    Buffer.concat([Buffer.from('\xEF\xBB\xBF#!/sfx stub junk\n', 'latin1'), Buffer.from(inner)])
  );
  const r = await ex(prefixed, 'sfx.xlsx');
  assert.equal(r.extracted, true);
  assert.ok(r.text.includes('PREFIXED_DATA'));
});

test('D3: UTF-16-LE encoded XML parts (BOM) are decoded, not dropped', async () => {
  const sheet = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>UTF16_DATA</t></is></c></row></sheetData></worksheet>',
      'utf16le'
    )
  ]);
  const bytes = buildZip({ 'xl/worksheets/sheet1.xml': sheet });
  const r = await ex(bytes, 'u16.xlsx');
  assert.equal(r.extracted, true);
  assert.ok(r.text.includes('UTF16_DATA'));
});

test('phonetic furigana (rPh) is dropped from Japanese shared strings', async () => {
  const bytes = buildZip({
    'xl/sharedStrings.xml':
      '<sst><si><rPh sb="0" eb="2"><t>furigana</t></rPh><t>KANJI_VALUE</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>'
  });
  const r = await ex(bytes, 'jp.xlsx');
  assert.ok(r.text.includes('KANJI_VALUE'));
  assert.ok(!r.text.includes('furigana'));
});

// --- second adversarial wave: deeper real-world Office defects ---

// Build a zip where one entry has a deliberately INVALID deflate stream, to
// exercise per-entry inflate-failure handling.
function buildZipWithCorruptEntry(entries) {
  const enc = new TextEncoder();
  const u16 = (v) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v >>> 0);
    return b;
  };
  const u32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0);
    return b;
  };
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals = [],
    centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameB = Buffer.from(enc.encode(e.name));
    const raw = Buffer.from(enc.encode(e.content));
    const comp = e.corrupt
      ? Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x99, 0x01])
      : zlibD.deflateRawSync(raw);
    const crc = crc32(raw);
    const lh = Buffer.concat([
      Buffer.from('PK\x03\x04', 'latin1'),
      u16(20),
      u16(0),
      u16(8),
      u16(0),
      u16(0),
      u32(crc),
      u32(comp.length),
      u32(raw.length),
      u16(nameB.length),
      u16(0),
      nameB,
      comp
    ]);
    locals.push(lh);
    centrals.push(
      Buffer.concat([
        Buffer.from('PK\x01\x02', 'latin1'),
        u16(20),
        u16(20),
        u16(0),
        u16(8),
        u16(0),
        u16(0),
        u32(crc),
        u32(comp.length),
        u32(raw.length),
        u16(nameB.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameB
      ])
    );
    offset += lh.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    Buffer.from('PK\x05\x06', 'latin1'),
    u16(0),
    u16(0),
    u16(centrals.length),
    u16(centrals.length),
    u32(cd.length),
    u32(offset),
    u16(0)
  ]);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

test('W: attributed <si> (xml:space) keeps the shared-string index map aligned', async () => {
  const bytes = buildZip({
    'xl/sharedStrings.xml':
      '<sst><si xml:space="preserve"><t>RICH_RRR</t></si><si><t>SECOND_SSS</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>'
  });
  const r = await ex(bytes, 'siattr.xlsx');
  assert.ok(r.text.includes('RICH_RRR') && r.text.includes('SECOND_SSS'));
});

test('W: CDATA cell text is decoded literally, no ]]> artifact', async () => {
  const bytes = buildZip({
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t><![CDATA[CDATA_TTT < & > x]]></t></is></c></row></sheetData></worksheet>'
  });
  const r = await ex(bytes, 'cdata.xlsx');
  assert.ok(r.text.includes('CDATA_TTT < & > x'));
  assert.ok(!r.text.includes(']]>'));
});

test('W: openpyxl comment subfolder path (xl/comments/comment1.xml) is read', async () => {
  const bytes = buildZip({
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>CELLVAL</t></is></c></row></sheetData></worksheet>',
    'xl/comments/comment1.xml':
      '<comments><commentList><comment ref="A1"><text><r><t>LEGACYCOMMENT_EEE</t></r></text></comment></commentList></comments>'
  });
  const r = await ex(bytes, 'opcomment.xlsx');
  assert.ok(r.text.includes('LEGACYCOMMENT_EEE'));
});

test('W: DOCX field instruction codes (incl. hyperlink URLs) never leak into text', async () => {
  const bytes = buildZip({
    'word/document.xml':
      '<w:document><w:body><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK "https://evil.example/track?id=SECRET_LEAK" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>HL_DISPLAY</w:t></w:r></w:p></w:body></w:document>'
  });
  const r = await ex(bytes, 'instr.docx');
  assert.ok(r.text.includes('HL_DISPLAY'));
  assert.ok(!r.text.includes('evil.example'));
  assert.ok(!r.text.includes('HYPERLINK'));
});

test('W: mc:AlternateContent ships Choice only, never the fused Fallback duplicate', async () => {
  const bytes = buildZip({
    'word/document.xml':
      '<w:document><w:body><w:p><mc:AlternateContent><mc:Choice><w:r><w:t>AC_CHOICE</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>AC_FALLBACK</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p></w:body></w:document>'
  });
  const r = await ex(bytes, 'mc.docx');
  assert.ok(r.text.includes('AC_CHOICE'));
  assert.ok(!r.text.includes('AC_FALLBACK'));
});

test('W: DOCX SmartArt diagram node text is extracted', async () => {
  const bytes = buildZip({
    'word/document.xml':
      '<w:document><w:body><w:p><w:r><w:t>DOC_BODY</w:t></w:r></w:p></w:body></w:document>',
    'word/diagrams/data1.xml': '<dsp><a:p><a:r><a:t>DOCX_SMARTART_NODE</a:t></a:r></a:p></dsp>'
  });
  const r = await ex(bytes, 'smart.docx');
  assert.ok(r.text.includes('DOCX_SMARTART_NODE'));
});

test('W: broken shared-strings deflate yields corrupt, never raw integer indices', async () => {
  const bytes = buildZipWithCorruptEntry([
    {
      name: 'xl/sharedStrings.xml',
      content: '<sst><si><t>REALLABEL</t></si></sst>',
      corrupt: true
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content:
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>'
    }
  ]);
  const r = await ex(bytes, 'brokensst.xlsx');
  assert.equal(r.extracted, false);
  assert.equal(r.reason, 'corrupt');
  assert.ok(!String(r.text || '').includes('0\t1'));
});

test('W: zero-width-only content is treated as empty, not readable', async () => {
  const bytes = buildZip({
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>​​⁠</t></is></c></row></sheetData></worksheet>'
  });
  const r = await ex(bytes, 'zw.xlsx');
  assert.equal(r.extracted, false);
  assert.equal(r.reason, 'empty');
});

test('W: a fake PK0506 signature inside the archive comment does not break parsing', async () => {
  // A valid zip whose EOCD comment literally contains the EOCD signature bytes.
  const base = buildZip({
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>REAL_AFTER_FAKE</t></is></c></row></sheetData></worksheet>'
  });
  // Append a comment to the EOCD: rewrite comment length + bytes containing PK\x05\x06.
  const buf = Buffer.from(base);
  const comment = Buffer.from('xxPK\x05\x06yyyy', 'latin1');
  buf.writeUInt16LE(comment.length, buf.length - 2);
  const bytes = new Uint8Array(Buffer.concat([buf, comment]));
  const r = await ex(bytes, 'fakeeocd.xlsx');
  assert.equal(r.extracted, true);
  assert.ok(r.text.includes('REAL_AFTER_FAKE'));
});

// --- third adversarial wave: raw-angle truncation, namespace prefixes, etc. ---

test('W3: a raw unescaped < in cell text does not truncate the value', async () => {
  const bytes = buildZip({
    'xl/sharedStrings.xml': '<sst><si><t>KEEPHEAD a < b KEEPTAIL</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>'
  });
  const r = await ex(bytes, 'rawangle.xlsx');
  assert.ok(r.text.includes('KEEPHEAD a < b KEEPTAIL'));
});

test('W3: namespace-prefixed SpreadsheetML (<x:row>/<x:c>/<x:is>) is read', async () => {
  const bytes = buildZip({
    'xl/workbook.xml':
      '<workbook xmlns:r="r"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':
      '<x:worksheet xmlns:x="x"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>NSPREFIX_MARKER</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>'
  });
  const r = await ex(bytes, 'nsprefix.xlsx');
  assert.equal(r.extracted, true);
  assert.ok(r.text.includes('NSPREFIX_MARKER'));
});

test('W3: XML comments (with > inside) are removed and never leak', async () => {
  const bytes = buildZip({
    'word/document.xml':
      '<w:document><w:body><w:p><w:r><w:t>BEFORE_C</w:t></w:r><!-- a > b LEAKMARKER --><w:r><w:t>AFTER_C</w:t></w:r></w:p></w:body></w:document>'
  });
  const r = await ex(bytes, 'cmt.docx');
  assert.ok(r.text.includes('BEFORE_C') && r.text.includes('AFTER_C'));
  assert.ok(!r.text.includes('LEAKMARKER'));
  assert.ok(!r.text.includes('-->'));
});

test('W3: mc:Fallback-only text (image-only Choice) is kept', async () => {
  const bytes = buildZip({
    'word/document.xml':
      '<w:document><w:body><w:p><mc:AlternateContent><mc:Choice><w:drawing><pic/></w:drawing></mc:Choice><mc:Fallback><w:r><w:t>FALLBACK_ONLY_TEXT</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p></w:body></w:document>'
  });
  const r = await ex(bytes, 'fb.docx');
  assert.ok(r.text.includes('FALLBACK_ONLY_TEXT'));
});

test('W3: w:altChunk embedded sub-document text is resolved and extracted', async () => {
  const bytes = buildZip({
    'word/document.xml':
      '<w:document><w:body><w:p><w:r><w:t>HOST_BODY</w:t></w:r></w:p><w:altChunk r:id="rIdC"/></w:body></w:document>',
    'word/_rels/document.xml.rels':
      '<Relationships><Relationship Id="rIdC" Target="afchunk.html" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk"/></Relationships>',
    'word/afchunk.html': '<html><body><p>EMBEDDED_CHUNK_TEXT</p></body></html>'
  });
  const r = await ex(bytes, 'alt.docx');
  assert.ok(r.text.includes('HOST_BODY') && r.text.includes('EMBEDDED_CHUNK_TEXT'));
});

// --- fourth adversarial wave: self-closing del body-eater + chart/no-body/VML ---

test('W4 CRITICAL: a self-closing <w:del/> paragraph-mark deletion never eats the body', async () => {
  let body = '<w:document><w:body>';
  body +=
    '<w:p><w:pPr><w:rPr><w:del w:id="1"/></w:rPr></w:pPr><w:r><w:t>PARA1_KEEP</w:t></w:r></w:p>';
  for (let i = 0; i < 8; i += 1) body += `<w:p><w:r><w:t>CLAUSE_${i}</w:t></w:r></w:p>`;
  body +=
    '<w:p><w:del><w:r><w:delText>REALLY_DELETED</w:delText></w:r></w:del><w:r><w:t>AFTER_LAST</w:t></w:r></w:p>';
  body += '</w:body></w:document>';
  const bytes = buildZip({ 'word/document.xml': body });
  const r = await ex(bytes, 'pmark.docx');
  assert.ok(r.text.includes('PARA1_KEEP') && r.text.includes('AFTER_LAST'));
  for (let i = 0; i < 8; i += 1) assert.ok(r.text.includes(`CLAUSE_${i}`));
  assert.ok(!r.text.includes('REALLY_DELETED'));
});

test('W4: XLSX embedded chart text (title + cached series values) is read', async () => {
  const bytes = buildZip({
    'xl/workbook.xml':
      '<workbook xmlns:r="r"><sheets><sheet name="Chart" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData/></worksheet>',
    'xl/charts/chart1.xml':
      '<c:chartSpace><c:title><a:p><a:r><a:t>CHART_TITLE_ZZ</a:t></a:r></a:p></c:title><c:cat><c:v>NorthRegion</c:v></c:cat></c:chartSpace>'
  });
  const r = await ex(bytes, 'chart.xlsx');
  assert.equal(r.extracted, true);
  assert.ok(r.text.includes('CHART_TITLE_ZZ') && r.text.includes('NorthRegion'));
});

test('W4: a package missing document.xml surfaces sibling text, never silent empty', async () => {
  const bytes = buildZip({
    'word/footnotes.xml':
      '<w:footnotes><w:footnote w:id="1"><w:p><w:r><w:t>NOBODY_FOOTNOTE</w:t></w:r></w:p></w:footnote></w:footnotes>',
    'word/styles.xml': '<styles/>'
  });
  const r = await ex(bytes, 'nodoc.docx');
  assert.ok((r.extracted && r.text.includes('NOBODY_FOOTNOTE')) || r.reason === 'corrupt');
  assert.ok(!(r.extracted === false && r.reason === 'empty'));
});

test('W4: PPTX VML WordArt (v:textpath string=) is extracted', async () => {
  const bytes = buildZip({
    'ppt/slides/slide1.xml':
      '<p:sld><p:cSld><p:spTree><v:shape><v:textpath string="WORDART_VML"/></v:shape></p:cSld></p:cSld></p:sld>'
  });
  const r = await ex(bytes, 'vml.pptx');
  assert.ok(r.text.includes('WORDART_VML'));
});

test('W4: an understated EOCD entry count does not drop real entries', async () => {
  const valid = buildZip({
    'xl/sharedStrings.xml': '<sst><si><t>SS_LABEL</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>'
  });
  // Force the EOCD total-entries fields (offsets +8 and +10) to 1 (understated).
  const buf = Buffer.from(valid);
  // EOCD is the last 22 bytes with no comment.
  buf.writeUInt16LE(1, buf.length - 14); // entries on this disk
  buf.writeUInt16LE(1, buf.length - 12); // total entries
  const r = await ex(new Uint8Array(buf), 'undercount.xlsx');
  assert.equal(r.extracted, true);
  assert.ok(r.text.includes('SS_LABEL'));
});

// --- fifth adversarial wave: raw < before a letter, partial-loss signal ---

test('W5: raw < followed by a LETTER in cell text does not truncate (xlsx)', async () => {
  const bytes = buildZip({
    'xl/sharedStrings.xml': '<sst><si><t>MARK a<b and c<d then end</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>'
  });
  const r = await ex(bytes, 'rawlt.xlsx');
  assert.ok(r.text.includes('MARK a<b and c<d then end'));
});

test('W5: raw < followed by a LETTER in run text does not truncate (docx)', async () => {
  const bytes = buildZip({
    'word/document.xml':
      '<w:document><w:body><w:p><w:r><w:t>DOCX if a<b and c<d then end</w:t></w:r></w:p></w:body></w:document>'
  });
  const r = await ex(bytes, 'rawlt.docx');
  assert.ok(r.text.includes('if a<b and c<d then end'));
});

test('W5: partial loss (one corrupt sheet, one good) is signaled, not silent', async () => {
  const bytes = buildZipWithCorruptEntry([
    {
      name: 'xl/workbook.xml',
      content:
        '<workbook xmlns:r="r"><sheets><sheet name="Good" sheetId="1" r:id="rId1"/><sheet name="Bad" sheetId="2" r:id="rId2"/></sheets></workbook>'
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content:
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content:
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>GOODSHEET</t></is></c></row></sheetData></worksheet>'
    },
    {
      name: 'xl/worksheets/sheet2.xml',
      content:
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>LOSTSHEET</t></is></c></row></sheetData></worksheet>',
      corrupt: true
    }
  ]);
  const r = await ex(bytes, 'partial.xlsx');
  assert.equal(r.extracted, true);
  assert.ok(r.text.includes('GOODSHEET'));
  assert.equal(r.partial, true);
});

// --- sixth adversarial wave: raw <..> span, del attr /> leak, pivot gating ---

test('W6: a raw < .. > span (5 < 10 > 3) in text is not eaten as a tag', async () => {
  const bytes = buildZip({
    'word/document.xml':
      '<w:document><w:body><w:p><w:r><w:t>start 5 < 10 > 3 and done</w:t></w:r></w:p></w:body></w:document>'
  });
  const r = await ex(bytes, 'span.docx');
  assert.ok(r.text.includes('5 < 10 > 3 and done'));
});

test('W6: a tracked deletion whose attribute contains /> still drops the deleted text', async () => {
  const bytes = buildZip({
    'word/document.xml':
      '<w:document><w:body><w:p><w:r><w:t>BEFORE_KEEP</w:t></w:r><w:del w:author="x/>y"><w:r><w:delText>LEAKED_DELETED</w:delText></w:r></w:del><w:r><w:t>AFTER_KEEP</w:t></w:r></w:p></w:body></w:document>'
  });
  const r = await ex(bytes, 'delattr.docx');
  assert.ok(r.text.includes('BEFORE_KEEP') && r.text.includes('AFTER_KEEP'));
  assert.ok(!r.text.includes('LEAKED_DELETED'));
  assert.ok(!r.text.includes('">'));
});

test('W6: pivot-cache data surfaces even when other sheets/labels carry text', async () => {
  const bytes = buildZip({
    'xl/workbook.xml':
      '<workbook xmlns:r="r"><sheets><sheet name="Notes" sheetId="1" r:id="rId1"/><sheet name="Pivot" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>cover note</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Grand Total</t></is></c></row></sheetData></worksheet>',
    'xl/pivotCache/pivotCacheDefinition1.xml':
      '<pivotCacheDefinition><cacheField><sharedItems><s v="PIVOT_EMEA"/><s v="PIVOT_APAC"/></sharedItems></cacheField></pivotCacheDefinition>'
  });
  const r = await ex(bytes, 'pivotlabel.xlsx');
  assert.ok(r.text.includes('cover note') && r.text.includes('Grand Total'));
  assert.ok(r.text.includes('PIVOT_EMEA') && r.text.includes('PIVOT_APAC'));
});

// --- seventh adversarial wave: realistic paragraph-merge + symmetric move/ins/field markers ---

test('W7 CRITICAL: realistic merged-paragraph contract (w:author/w:date del marker) keeps every clause', async () => {
  // Mirrors /tmp/docxtests4/U_merge_paragraphs_realistic.docx: a deleted
  // paragraph mark (the "merge two paragraphs" tracked change) emitted as a
  // self-closing <w:del .../> inside <w:pPr><w:rPr>, eight body clauses, then a
  // normal run-level deletion far below. The self-closing marker must not open
  // a span that swallows all eight clauses through to that later </w:del>.
  let body = '<w:document><w:body>';
  body +=
    '<w:p><w:pPr><w:rPr><w:del w:id="100" w:author="Editor" w:date="2026-01-01T00:00:00Z"/></w:rPr></w:pPr>';
  body += '<w:r><w:t>MARKERPARA1 first paragraph whose mark was deleted to merge</w:t></w:r></w:p>';
  for (let i = 0; i < 8; i += 1)
    body += `<w:p><w:r><w:t>MARKERIMPORTANT clause ${i} of the contract</w:t></w:r></w:p>`;
  body +=
    '<w:p><w:r><w:t>before </w:t></w:r><w:del w:id="200" w:author="Editor"><w:r><w:delText>removed phrase</w:delText></w:r></w:del><w:r><w:t> after MARKERLAST</w:t></w:r></w:p>';
  body += '</w:body></w:document>';
  const r = await ex(buildZip({ 'word/document.xml': body }), 'merge.docx');
  assert.ok(r.text.includes('MARKERPARA1') && r.text.includes('MARKERLAST'));
  for (let i = 0; i < 8; i += 1)
    assert.ok(r.text.includes(`MARKERIMPORTANT clause ${i}`), `lost clause ${i}`);
  assert.ok(!r.text.includes('removed phrase'));
});

test('W7: a self-closing <w:moveFrom/> paragraph-mark marker never eats the body; source dropped, destination kept', async () => {
  // Symmetric to the w:del bug for tracked MOVES. The self-closing move-from
  // paragraph-mark marker must be dropped before the paired <w:moveFrom> span
  // rule runs, or it would swallow the eight clauses below it.
  let body = '<w:document><w:body>';
  body +=
    '<w:p><w:pPr><w:rPr><w:moveFrom w:id="10" w:author="E" w:date="2026-01-01T00:00:00Z"/></w:rPr></w:pPr><w:r><w:t>MOVE_PMARK_KEEP</w:t></w:r></w:p>';
  for (let i = 0; i < 8; i += 1) body += `<w:p><w:r><w:t>MCLAUSE_${i}</w:t></w:r></w:p>`;
  body += '<w:p><w:moveFrom w:id="11"><w:r><w:t>MOVED_AWAY_DUP</w:t></w:r></w:moveFrom>';
  body += '<w:moveTo w:id="12"><w:r><w:t>MOVED_HERE_KEEP</w:t></w:r></w:moveTo>';
  body += '<w:r><w:t>AFTER_MOVE_KEEP</w:t></w:r></w:p>';
  body += '</w:body></w:document>';
  const r = await ex(buildZip({ 'word/document.xml': body }), 'move.docx');
  assert.ok(r.text.includes('MOVE_PMARK_KEEP'));
  for (let i = 0; i < 8; i += 1) assert.ok(r.text.includes(`MCLAUSE_${i}`), `lost clause ${i}`);
  assert.ok(r.text.includes('MOVED_HERE_KEEP'), 'move destination must be kept');
  assert.ok(r.text.includes('AFTER_MOVE_KEEP'));
  assert.ok(
    !r.text.includes('MOVED_AWAY_DUP'),
    'move source must be dropped (it duplicates the destination)'
  );
});

test('W7: a self-closing <w:ins/> paragraph-mark marker leaves body and inserted text intact, no attribute artifact', async () => {
  // Audit lock: w:ins is intentionally KEPT (insertions are part of the accepted
  // document) so it has no span rule — a self-closing <w:ins .../> marker can
  // only be removed by the generic tag-strip and must leave no w:id / "/>" debris.
  let body = '<w:document><w:body>';
  body +=
    '<w:p><w:pPr><w:rPr><w:ins w:id="5" w:author="E"/></w:rPr></w:pPr><w:r><w:t>INS_PMARK_KEEP</w:t></w:r></w:p>';
  body +=
    '<w:p><w:ins w:id="6"><w:r><w:t>INSERTED_KEEP</w:t></w:r></w:ins><w:r><w:t>TAIL_KEEP</w:t></w:r></w:p>';
  body += '</w:body></w:document>';
  const r = await ex(buildZip({ 'word/document.xml': body }), 'ins.docx');
  assert.ok(
    r.text.includes('INS_PMARK_KEEP') &&
      r.text.includes('INSERTED_KEEP') &&
      r.text.includes('TAIL_KEEP')
  );
  assert.ok(!r.text.includes('w:id') && !r.text.includes('/>'));
});

test('W7: a self-closing <w:instrText/> does not swallow the visible field result', async () => {
  // Same self-closing-feeds-span class for field instruction codes: an empty
  // <w:instrText/> must not open a span that eats the cached visible field
  // result before the next real </w:instrText>.
  const body =
    '<w:document><w:body><w:p>' +
    '<w:r><w:instrText/></w:r>' +
    '<w:r><w:t>VISIBLE_FIELD_RESULT</w:t></w:r>' +
    '<w:r><w:instrText> PAGE \\* MERGEFORMAT </w:instrText></w:r>' +
    '<w:r><w:t>TAIL_VISIBLE</w:t></w:r>' +
    '</w:p></w:body></w:document>';
  const r = await ex(buildZip({ 'word/document.xml': body }), 'instr.docx');
  assert.ok(r.text.includes('VISIBLE_FIELD_RESULT') && r.text.includes('TAIL_VISIBLE'));
  assert.ok(!r.text.includes('MERGEFORMAT'));
});

// Regression: OOXML zip entries are inflated incrementally with a hard
// per-entry byte cap so a zip bomb (a few KB inflating to GB) aborts instead
// of OOM-crashing the WebView. A valid small docx built the same way must
// still extract — proving the bomb's rejection is the cap, not a broken zip.
function leU16(value) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}
function leU32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}
function joinBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}
function crc32Bytes(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
// Single-entry DEFLATE zip (method 8) — enough to drive readZipEntries inflation.
async function buildDeflateZip(entryName, rawBytes) {
  const name = new TextEncoder().encode(entryName);
  const comp = await deflateRaw(rawBytes);
  const crc = crc32Bytes(rawBytes);
  const local = joinBytes([
    leU32(0x04034b50),
    leU16(20),
    leU16(0),
    leU16(8),
    leU16(0),
    leU16(0),
    leU32(crc),
    leU32(comp.length),
    leU32(rawBytes.length),
    leU16(name.length),
    leU16(0),
    name,
    comp
  ]);
  const central = joinBytes([
    leU32(0x02014b50),
    leU16(20),
    leU16(20),
    leU16(0),
    leU16(8),
    leU16(0),
    leU16(0),
    leU32(crc),
    leU32(comp.length),
    leU32(rawBytes.length),
    leU16(name.length),
    leU16(0),
    leU16(0),
    leU16(0),
    leU16(0),
    leU32(0),
    leU32(0),
    name
  ]);
  const eocd = joinBytes([
    leU32(0x06054b50),
    leU16(0),
    leU16(0),
    leU16(1),
    leU16(1),
    leU32(central.length),
    leU32(local.length),
    leU16(0)
  ]);
  return joinBytes([local, central, eocd]);
}

test('OOXML zip-bomb: an oversize inflated entry aborts instead of exhausting memory', async () => {
  // 40 MB of one byte deflates to a few KB but exceeds the 32 MB per-entry cap.
  const bomb = new Uint8Array(40 * 1024 * 1024).fill(0x41);
  const bytes = await buildDeflateZip('word/document.xml', bomb);
  const started = process.hrtime.bigint();
  const result = await extractAttachmentText({ filename: 'bomb.docx', bytes });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result.extracted, false, 'bomb is not surfaced as extracted text');
  assert.equal(result.reason, 'corrupt', 'the over-cap part is reported as damaged');
  assert.ok(elapsedMs < 15000, `aborts promptly (took ${elapsedMs.toFixed(0)}ms)`);
});

test('a valid small docx built the same way still extracts (proves the cap, not a broken zip)', async () => {
  const docXml = new TextEncoder().encode(
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>hello bomb-free world</w:t></w:r></w:p></w:body></w:document>'
  );
  const bytes = await buildDeflateZip('word/document.xml', docXml);
  const result = await extractAttachmentText({ filename: 'ok.docx', bytes });
  assert.equal(result.extracted, true, 'small valid docx extracts');
  assert.match(result.text, /hello bomb-free world/);
});
