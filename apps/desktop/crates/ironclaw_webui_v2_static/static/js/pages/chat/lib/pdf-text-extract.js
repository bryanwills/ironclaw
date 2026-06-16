import { isDesktopRuntime, tauriInvoke } from '../../../lib/api.js';

const MAX_EXTRACT_CHARS = 200_000;

// Root-absolute asset path (mirrors index.html's loader): the app document is
// served for every route, so relative vendor paths would 404 on deep links.
function vendorPath(file) {
  const hosted =
    typeof window !== 'undefined' &&
    (window.location.pathname === '/v2' || window.location.pathname.startsWith('/v2/'));
  return hosted ? `/v2/vendor/${file}` : `/vendor/${file}`;
}

// ── PDF (pdf.js, vendored) ─────────────────────────────────────────────

let pdfjsPromise = null;

// Exported for the attachment preview: shares the cached module promise and
// the desktop fake-worker setup instead of duplicating either.
export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(/* @vite-ignore */ vendorPath('pdf.min.mjs')).then(async (pdfjs) => {
      if (isDesktopRuntime()) {
        // WKWebView constructs Workers from custom-scheme URLs unreliably:
        // the script load can neither error nor complete, and pdf.js then
        // waits on its handshake forever (intermittent multi-minute hang in
        // the packaged smoke). Importing the worker module on the MAIN
        // thread — page-level dynamic import through the scheme handler is
        // reliable — and publishing it as `globalThis.pdfjsWorker` makes
        // pdf.js take its fake-worker path deterministically: PDFWorker
        // sees `WorkerMessageHandler` and never constructs a real Worker.
        globalThis.pdfjsWorker = await import(/* @vite-ignore */ vendorPath('pdf.worker.min.mjs'));
      }
      pdfjs.GlobalWorkerOptions.workerSrc = vendorPath('pdf.worker.min.mjs');
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

export async function extractPdfText(bytes) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const parts = [];
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => (typeof item.str === 'string' ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (pageText) parts.push(pageText);
    if (parts.join('\n').length > MAX_EXTRACT_CHARS) break;
  }
  await doc.destroy().catch(() => {});
  return parts.join('\n\n');
}

// ── OCR for scanned PDFs (tesseract.js, fully local) ───────────────────
//
// The OCR stack (worker + SIMD wasm core + eng traineddata, ~11 MB) ships in
// static/ocr and loads lazily on the first scanned document. Pages render
// through pdf.js to a canvas, capped for time: OCR costs seconds per page.

const OCR_MAX_PAGES = 8;
const OCR_TARGET_WIDTH = 1600;
// Below this mean recognition confidence the "text" is noise (photographs,
// artwork, handwriting tesseract can't read) — shipping it to the model is
// worse than the honest no-readable-text notice.
const OCR_MIN_CONFIDENCE = 45;

function ocrPath(file) {
  const hosted =
    typeof window !== 'undefined' &&
    (window.location.pathname === '/v2' || window.location.pathname.startsWith('/v2/'));
  return hosted ? `/v2/ocr/${file}` : `/ocr/${file}`;
}

let ocrWorkerPromise = null;
let ocrAssetBasePromise = null;

export function desktopOcrAssetBase(endpoint) {
  if (endpoint && typeof endpoint === 'object' && endpoint.port && endpoint.token) {
    return `http://127.0.0.1:${endpoint.port}/${encodeURIComponent(endpoint.token)}`;
  }
  if (endpoint) return `http://127.0.0.1:${endpoint}`;
  return '';
}

// Where the OCR WORKER loads its assets from. In the packaged desktop the
// worker cannot fetch tauri:// URLs (WKWebView custom-scheme handlers do not
// apply inside Web Workers), so the Rust side serves the asset pack over
// loopback HTTP. Hosted/dev builds use the plain static paths.
function ocrAssetBase() {
  if (!ocrAssetBasePromise) {
    ocrAssetBasePromise = (async () => {
      if (isDesktopRuntime()) {
        try {
          const endpoint = await tauriInvoke('ocr_assets_port');
          const base = desktopOcrAssetBase(endpoint);
          if (base) return base;
        } catch (_) {
          // Fall through to static paths (dev server).
        }
      }
      const hosted =
        typeof window !== 'undefined' &&
        (window.location.pathname === '/v2' || window.location.pathname.startsWith('/v2/'));
      return hosted ? '/v2/ocr' : '/ocr';
    })();
  }
  return ocrAssetBasePromise;
}

function loadOcrWorker() {
  if (!ocrWorkerPromise) {
    // The page-side ESM import stays on the app origin ('self' per CSP);
    // only the worker-fetched assets ride the loopback base.
    ocrWorkerPromise = Promise.all([
      import(/* @vite-ignore */ ocrPath('tesseract.esm.min.js')),
      ocrAssetBase()
    ]).then(([module, base]) =>
      // The ESM bundle exposes the API on its default export.
      (module.createWorker || module.default.createWorker)('eng', 1, {
        workerPath: `${base}/worker.min.js`,
        corePath: `${base}/tesseract-core-simd-lstm.wasm.js`,
        langPath: base,
        gzip: false
      })
    );
    // A failed boot must not poison every later attempt.
    ocrWorkerPromise.catch(() => {
      ocrWorkerPromise = null;
    });
  }
  return ocrWorkerPromise;
}

export async function ocrPdf(bytes, onProgress) {
  if (typeof document === 'undefined') return '';
  const pdfjs = await loadPdfjs();
  // pdf.js transfers the buffer to its worker — give it a copy so the
  // caller's bytes stay usable.
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const pageCount = Math.min(doc.numPages, OCR_MAX_PAGES);
  const worker = await loadOcrWorker();
  const parts = [];
  const confidences = [];
  try {
    for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) {
      if (onProgress) onProgress({ kind: 'ocr', page: pageNo, pages: pageCount });
      const page = await doc.getPage(pageNo);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(2.5, Math.max(1, OCR_TARGET_WIDTH / baseViewport.width));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      await page.render({ canvasContext: context, viewport }).promise;
      const result = await worker.recognize(canvas);
      const pageText = (result?.data?.text || '').replace(/\s+\n/g, '\n').trim();
      const pageConfidence = Number(result?.data?.confidence);
      if (Number.isFinite(pageConfidence)) confidences.push(pageConfidence);
      if (pageText) parts.push(pageText);
      canvas.width = 0;
      canvas.height = 0;
      if (parts.join('\n').length > MAX_EXTRACT_CHARS) break;
    }
  } finally {
    await doc.destroy().catch(() => {});
  }
  const meanConfidence =
    confidences.length > 0
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : 0;
  if (meanConfidence < OCR_MIN_CONFIDENCE) return '';
  let text = parts.join('\n\n');
  if (doc.numPages > pageCount && text) {
    text += `\n\n[OCR truncated: first ${pageCount} of ${doc.numPages} pages]`;
  }
  return text;
}
