/**
 * AttachmentPreviewModal — click a chip, see the document.
 *
 * Three data situations, in order of fidelity:
 *   1. Composer / just-sent (sourceFile present): PDFs render as real pages
 *      via the shared pdf.js loader; everything else shows extracted text.
 *   2. Reload (embedded_text captured from the durable manifest): text view —
 *      exactly what the model received, including the truncation banner.
 *   3. Nothing retained (raw binary, pre-embed sends): an honest empty state.
 *
 * Dependency-free; hosted by the design-system Modal.
 */
import { React, html } from '../../../lib/html.js';
import { Modal, ModalBody } from '../../../design-system/modal.js';
import { Icon } from '../../../design-system/icons.js';
import { useT } from '../../../lib/i18n.js';
import { loadPdfjs, isPdfAttachment } from '../lib/extract-attachment-text.js';
import { saveBlob } from '../../../lib/save-file.js';
import { toast } from '../../../lib/toast.js';

const PDF_PREVIEW_MAX_PAGES = 8;
const PDF_PREVIEW_WIDTH = 720;

// Tab-separated extractions (spreadsheets, CSV-ish) read better in a mono
// grid; prose documents read better in the product face.
function looksTabular(filename, text) {
  const name = String(filename || '').toLowerCase();
  if (/\.(xlsx?|xlsm|csv|tsv)$/.test(name)) return true;
  const sample = String(text || '').slice(0, 2000);
  return sample.split('\n').filter((line) => line.includes('\t')).length > 3;
}

function statusBanner(att, t) {
  const status = String(att.extraction_status || '');
  if (status === 'extracted_text_truncated') {
    return { tone: 'warning', label: t('chat.previewTruncated') };
  }
  if (status === 'content_omitted_message_budget') {
    return { tone: 'warning', label: t('chat.previewOmitted') };
  }
  return null;
}

function PdfPagesPreview({ sourceFile }) {
  const t = useT();
  const containerRef = React.useRef(null);
  const [state, setState] = React.useState({ status: 'rendering', pages: 0, total: 0 });

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const bytes = new Uint8Array(await sourceFile.arrayBuffer());
        const pdfjs = await loadPdfjs();
        // pdf.js transfers (detaches) the buffer it is given — always hand
        // it a copy so re-opening the preview still has the original.
        const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
        const total = Math.min(doc.numPages, PDF_PREVIEW_MAX_PAGES);
        setState({ status: 'rendering', pages: 0, total, numPages: doc.numPages });
        for (let pageNo = 1; pageNo <= total; pageNo += 1) {
          if (cancelled || !containerRef.current) return;
          const page = await doc.getPage(pageNo);
          const viewport = page.getViewport({ scale: 1 });
          const scale = PDF_PREVIEW_WIDTH / viewport.width;
          const scaled = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(scaled.width);
          canvas.height = Math.ceil(scaled.height);
          canvas.className = 'mb-3 w-full rounded-[12px] border border-[var(--v2-panel-border)]';
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaled }).promise;
          if (cancelled || !containerRef.current) return;
          containerRef.current.appendChild(canvas);
          setState((prev) => ({ ...prev, pages: pageNo }));
        }
        if (!cancelled) setState((prev) => ({ ...prev, status: 'done' }));
      } catch (_) {
        if (!cancelled) setState((prev) => ({ ...prev, status: 'error' }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceFile]);

  return html`
    <div>
      ${state.status === 'rendering' &&
      html`<p className="mb-3 text-xs text-[var(--v2-text-muted)]">
        ${t('chat.previewRenderingPages', {
          done: String(state.pages),
          total: String(state.total || '…')
        })}
      </p>`}
      ${state.status === 'error' &&
      html`<p className="mb-3 text-xs text-[var(--v2-danger-text)]">
        ${t('chat.previewRenderFailed')}
      </p>`}
      <div ref=${containerRef}></div>
      ${state.status === 'done' &&
      state.numPages > state.total &&
      html`<p className="text-xs text-[var(--v2-text-muted)]">
        ${t('chat.previewMorePages', {
          shown: String(state.total),
          total: String(state.numPages)
        })}
      </p>`}
    </div>
  `;
}

/**
 * @param {{ open: boolean, onClose: () => void, attachment: any }} props
 *   attachment: { filename, mime_type, size_label?, extraction_status?,
 *                 embedded_text?, sourceFile?, extractedText? }
 */
export function AttachmentPreviewModal({ open, onClose, attachment }) {
  const t = useT();
  if (!open || !attachment) return null;

  const text = attachment.extractedText || attachment.embedded_text || '';
  const canRenderPdfPages =
    attachment.sourceFile && isPdfAttachment({ ...attachment, filename: attachment.filename });
  const banner = statusBanner(attachment, t);

  return html`
    <${Modal}
      open=${open}
      onClose=${onClose}
      size="xl"
      title=${attachment.filename || t('chat.previewTitle')}
    >
      <${ModalBody} className="bg-[var(--v2-surface)]">
        <div className="mb-3 flex items-center gap-2 text-xs text-[var(--v2-text-muted)]">
          <${Icon} name="file" className="h-3.5 w-3.5 text-[var(--v2-accent-text)]" />
          <span>${attachment.mime_type || ''}</span>
          ${attachment.size_label && html`<span>· ${attachment.size_label}</span>`}
          ${text && html`<span className="ml-auto">${t('chat.previewModelNote')}</span>`}
          ${(attachment.sourceFile || text) &&
          html`<button
            type="button"
            onClick=${async () => {
              // Prefer the ORIGINAL file when we still hold it; otherwise
              // save the extracted text the model received.
              const name = attachment.filename || 'attachment';
              const blob = attachment.sourceFile
                ? attachment.sourceFile
                : new Blob([text], { type: 'text/plain' });
              const suggested = attachment.sourceFile ? name : `${name}.txt`;
              const saved = await saveBlob(blob, suggested);
              if (saved) toast(`Saved ${String(saved).split('/').pop()}`, { tone: 'success' });
            }}
            className=${`${text ? '' : 'ml-auto '}shrink-0 rounded-[6px] border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] px-2 py-1 text-[var(--v2-text)] hover:bg-[var(--v2-surface-muted)]`}
          >
            ${t('chat.previewSave')}
          </button>`}
        </div>
        ${banner &&
        html`<p
          className="mb-3 rounded-[6px] border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] px-3 py-2 text-xs text-[var(--v2-warning-text)]"
        >
          ${banner.label}
        </p>`}
        ${canRenderPdfPages
          ? html`<${PdfPagesPreview} sourceFile=${attachment.sourceFile} />`
          : text
            ? html`<pre
                className=${`max-w-full whitespace-pre-wrap break-words rounded-[12px] border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] p-4 text-[13px] leading-relaxed text-[var(--v2-text)] ${
                  looksTabular(attachment.filename, text) ? 'font-mono text-xs' : ''
                }`}
                data-testid="attachment-preview-text"
              >
${text}</pre
              >`
            : html`<div
                className="rounded-[12px] border border-dashed border-[var(--v2-panel-border)] p-8 text-center text-sm text-[var(--v2-text-muted)]"
              >
                ${t('chat.previewUnavailable')}
              </div>`}
      <//>
    <//>
  `;
}
