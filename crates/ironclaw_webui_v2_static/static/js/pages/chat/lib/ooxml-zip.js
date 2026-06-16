// ── Minimal ZIP reader (DOCX/XLSX are zip packages) ────────────────────
//
// Reads the central directory and inflates entries with the platform's
// DecompressionStream — no vendored zip library needed.

// Read a 64-bit little-endian value as a JS number (safe: ZIP fields we read
// are well under 2^53 for any real Office document).
function readUint64(view, pos) {
  const lo = view.getUint32(pos, true);
  const hi = view.getUint32(pos + 4, true);
  return hi * 0x100000000 + lo;
}

// Locate the central directory: total entry count + byte offset. Handles the
// ZIP64 case (real Excel/Sheets exports can emit it) where the classic EOCD
// stores 0xFFFF / 0xFFFFFFFF placeholders and the real values live in the
// ZIP64 EOCD record pointed to by the ZIP64 EOCD locator. Returns null when
// no valid central directory can be found (not a zip — e.g. an encrypted
// CFB/OLE workbook, or a truncated file).
function locateCentralDirectory(view, length) {
  let eocd = -1;
  const minTail = Math.max(0, length - 65557);
  for (let i = length - 22; i >= minTail; i -= 1) {
    if (view.getUint32(i, true) !== 0x06054b50) continue;
    // Reject a stray PK\x05\x06 inside an archive comment: a genuine EOCD's
    // recorded comment length lands exactly on the end of the file.
    const commentLen = view.getUint16(i + 20, true);
    if (i + 22 + commentLen === length) {
      eocd = i;
      break;
    }
    if (eocd === -1) eocd = i; // remember the first as a fallback
  }
  if (eocd === -1) return null;

  let entryCount = view.getUint16(eocd + 10, true);
  let storedOffset = view.getUint32(eocd + 16, true);
  let cdSize = view.getUint32(eocd + 12, true);
  let cdEnd = eocd; // the central directory ends where the (classic) EOCD begins

  // ZIP64 path: placeholders in the classic EOCD point at the ZIP64 records,
  // which sit between the central directory and the classic EOCD.
  if (entryCount === 0xffff || storedOffset === 0xffffffff || cdSize === 0xffffffff) {
    const locatorPos = eocd - 20;
    if (locatorPos >= 0 && view.getUint32(locatorPos, true) === 0x07064b50) {
      let z64 = readUint64(view, locatorPos + 8);
      // The stored ZIP64-EOCD offset is archive-relative; for a prefixed file
      // it is wrong, so verify the signature and otherwise scan back for it.
      if (!(z64 >= 0 && z64 + 56 <= length && view.getUint32(z64, true) === 0x06064b50)) {
        z64 = -1;
        for (let i = locatorPos - 56; i >= 0; i -= 1) {
          if (view.getUint32(i, true) === 0x06064b50) {
            z64 = i;
            break;
          }
        }
      }
      if (z64 >= 0 && z64 + 56 <= length && view.getUint32(z64, true) === 0x06064b50) {
        entryCount = readUint64(view, z64 + 32);
        storedOffset = readUint64(view, z64 + 48);
        cdSize = readUint64(view, z64 + 40);
        cdEnd = z64; // the directory ends just before the ZIP64 EOCD record
      }
    }
  }

  // Prefix-delta rebasing: SFX stubs, BOM/polyglot prefixes and mail-transfer
  // artifacts shift every absolute offset by a constant. Recover it from where
  // the central directory ACTUALLY ends (cdEnd) versus where the EOCD claims it
  // starts — then verify against the central-header signature before trusting
  // the rebase, falling back to the stored offset if the rebase misses.
  let offset = storedOffset;
  if (cdSize > 0 && cdSize <= cdEnd) {
    const actualStart = cdEnd - cdSize;
    if (
      actualStart >= 0 &&
      actualStart + 4 <= length &&
      view.getUint32(actualStart, true) === 0x02014b50
    ) {
      offset = actualStart;
    }
  }
  if (offset < 0 || offset + 4 > length || view.getUint32(offset, true) !== 0x02014b50) {
    if (
      storedOffset < 0 ||
      storedOffset + 4 > length ||
      view.getUint32(storedOffset, true) !== 0x02014b50
    ) {
      return null;
    }
    offset = storedOffset;
  }
  return { entryCount, offset, delta: offset - storedOffset };
}

// True when a valid central directory header is reachable — distinguishes a
// truncated/corrupt package from a merely empty one.
export function zipHasCentralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cd = locateCentralDirectory(view, bytes.length);
  return Boolean(
    cd && cd.offset + 4 <= bytes.length && view.getUint32(cd.offset, true) === 0x02014b50
  );
}

// Inflated-size caps. The composer only bounds the COMPRESSED upload (256 MB),
// but DEFLATE ratios reach ~1000x, so a few-KB entry can inflate to multi-GB
// and OOM-crash the WebView (zip bomb). Cap each entry and the cumulative
// total; entries past the cap are recorded in `failed`, not inflated.
const MAX_ENTRY_INFLATED_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_INFLATED_BYTES = 64 * 1024 * 1024;

// Inflate a deflate-raw stream incrementally, aborting once it exceeds `cap`
// bytes. Returns the inflated bytes, or throws past the cap so the caller skips
// the entry. Streaming (not Response.arrayBuffer) is what makes the cap real —
// it stops reading instead of materializing the whole bomb first.
async function inflateCapped(data, cap) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        await reader.cancel();
        throw new Error('inflated entry exceeds cap');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

// `failed`, when provided, collects the names of WANTED entries that were
// present in the directory but could not be inflated (truncated/garbage
// deflate, unsupported method, or over the inflated-size cap). Callers use it
// to tell "damaged" from "empty".
export async function readZipEntries(bytes, wantedNames, failed = null) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cd = locateCentralDirectory(view, bytes.length);
  if (!cd) return new Map();

  let offset = cd.offset;
  let totalInflated = 0;
  const out = new Map();
  // Walk by the central-header signature, not the EOCD entry count: a writer
  // that understates the count (0/1) would otherwise leave real entries unread.
  // The signature check terminates the walk; the cap is a runaway backstop.
  const MAX_ENTRIES = 1 << 20;
  for (let n = 0; n < MAX_ENTRIES; n += 1) {
    // Bounds-guard every read: a malformed/truncated central directory must
    // never throw a RangeError — it should stop the walk cleanly.
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    // Rebase the local-header pointer by the same prefix delta as the directory.
    const localOffset = view.getUint32(offset + 42, true) + cd.delta;
    if (offset + 46 + nameLength > bytes.length) break;
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (!wantedNames.some((want) => (want.test ? want.test(name) : want === name))) continue;

    // Per-entry isolation: one corrupt/truncated entry (bad deflate stream,
    // out-of-range local offset) must not zero the whole document — skip it
    // and keep extracting the others.
    try {
      if (localOffset + 30 > bytes.length) {
        if (failed) failed.add(name);
        continue;
      }
      // Local header: sizes of name/extra can differ from the central record.
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      if (dataStart > bytes.length) {
        if (failed) failed.add(name);
        continue;
      }
      const data = bytes.subarray(dataStart, dataStart + compressedSize);
      const remainingBudget = MAX_TOTAL_INFLATED_BYTES - totalInflated;
      if (remainingBudget <= 0) {
        // Cumulative inflated-bytes budget spent — treat the rest as
        // undecodable rather than risk OOM on a pathological package.
        if (failed) failed.add(name);
        continue;
      }
      const entryCap = Math.min(MAX_ENTRY_INFLATED_BYTES, remainingBudget);

      if (method === 0) {
        // Stored (uncompressed): a `subarray` view, but still count it toward
        // the budget and skip if a single entry blows the per-entry cap.
        if (data.length > entryCap) {
          if (failed) failed.add(name);
          continue;
        }
        out.set(name, data);
        totalInflated += data.length;
      } else if (method === 8 && typeof DecompressionStream === 'function') {
        const inflated = await inflateCapped(data, entryCap);
        out.set(name, inflated);
        totalInflated += inflated.length;
      } else if (failed) {
        failed.add(name); // unsupported compression method
      }
    } catch (_) {
      // Inflate failed (truncated/garbage deflate). Record it so the caller can
      // distinguish a damaged package from an empty one, and keep going.
      if (failed) failed.add(name);
    }
  }
  return out;
}

export function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

// Decode an XML package part, honouring its encoding. OOXML parts are usually
// UTF-8, but some tools emit UTF-16 (with or without a BOM); decoding those as
// UTF-8 either yields zero regex matches (BOM-less, NUL-interleaved) or leaks
// U+FFFD replacement chars. Sniff the BOM, then fall back to a NUL-interleave
// heuristic, then UTF-8.
export function decodeXmlPart(bytes) {
  if (!bytes || bytes.length === 0) return '';
  let label = 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    label = 'utf-16le';
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    label = 'utf-16be';
  } else {
    const sample = Math.min(bytes.length, 128);
    let odd = 0;
    let even = 0;
    for (let i = 0; i < sample; i += 1) {
      if (bytes[i] === 0) {
        if (i % 2) odd += 1;
        else even += 1;
      }
    }
    if (odd > sample / 4 && even === 0) label = 'utf-16le';
    else if (even > sample / 4 && odd === 0) label = 'utf-16be';
  }
  let text;
  try {
    text = new TextDecoder(label).decode(bytes);
  } catch (_) {
    text = new TextDecoder('utf-8').decode(bytes);
  }
  text = text.replace(/^﻿/, '');
  // Order matters: drop comments (their inner `>` would otherwise truncate the
  // generic tag-strip), then convert CDATA to escaped entities, then escape any
  // remaining RAW `<` that does not start a well-formed tag. The last step is
  // the load-bearing one: a stray `<` in cell/run text (bad exporters emit it
  // unescaped) makes `/<[^>]+>/` eat everything through the next real `>`,
  // silently truncating the value. After escaping, the tag-strip is a no-op on
  // it and `decodeXmlEntities` restores the literal `<`.
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = neutralizeCdata(text);
  // Escape any `<` that does not begin a well-formed tag. A real tag opener is
  // a name-start char (letter, `/`, `!`, `?`) FOLLOWED by a clean `[^<>]*>`.
  // This catches every raw-`<` form a bad exporter emits in text: `< 5`
  // (space after `<`), `x<y` (no reachable `>`), and `5 < 10 > 3` (a `>` is
  // reachable but `<` is followed by a space, so it is not a tag) — while
  // real start/end tags, comments and PIs pass through untouched.
  text = text.replace(/<(?![a-zA-Z!?/][^<>]*>)/g, '&lt;');
  return text;
}

// Convert CDATA payloads to escaped entities so the downstream tag-strip and
// entity-decode treat their `<`, `>`, `&` as literal text instead of markup.
// Google Sheets and several exporters wrap values containing those characters
// in `<![CDATA[…]]>`; without this the generic `<[^>]+>` strip eats the whole
// section and ships a `]]>` artifact.
function neutralizeCdata(xml) {
  if (xml.indexOf('<![CDATA[') === -1) return xml;
  return xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) =>
    inner.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  );
}

// mc:AlternateContent wraps a modern mc:Choice and a legacy mc:Fallback. A
// compliant reader takes exactly ONE: Choice when it carries text (the common
// case — keeping both would duplicate and fuse every run), but Fallback when
// Choice is image-only and the readable text lives only in the fallback.
export function resolveAlternateContent(xml) {
  if (xml.indexOf('<mc:AlternateContent') === -1) return xml;
  const hasText = (s) => /<(?:w|a):t[\s>]/.test(s);
  return xml.replace(
    /<mc:AlternateContent\b[^>]*>([\s\S]*?)<\/mc:AlternateContent>/g,
    (_, inner) => {
      const choice = inner.match(/<mc:Choice\b[^>]*>([\s\S]*?)<\/mc:Choice>/);
      const fallback = inner.match(/<mc:Fallback\b[^>]*>([\s\S]*?)<\/mc:Fallback>/);
      const choiceText = choice ? choice[1] : '';
      const fallbackText = fallback ? fallback[1] : '';
      if (choice && hasText(choiceText)) return choiceText;
      if (fallback && hasText(fallbackText)) return fallbackText;
      return choiceText || fallbackText || '';
    }
  );
}
