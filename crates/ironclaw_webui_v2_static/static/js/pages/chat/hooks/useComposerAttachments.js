import { React } from '../../../lib/html.js';
import {
  extractAttachmentText,
  isExtractableBinary,
  legacyOfficeUpgrade,
  textToBase64
} from '../lib/extract-attachment-text.js';
import { isAttachmentTextEmbeddable } from '../lib/history-messages.js';

// Raw (non-extractable) payloads ship base64 to the backend, so they stay
// small. Extractable documents (PDF/DOCX/XLSX) are read as bytes and only
// their EXTRACTED TEXT ships — the original can be hundreds of MB.
const MAX_RAW_FILE_SIZE = 5 * 1024 * 1024;
const MAX_RAW_TOTAL_SIZE = 10 * 1024 * 1024;
const MAX_DOCUMENT_FILE_SIZE = 256 * 1024 * 1024;

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(',')[1];
      resolve({ dataUrl, base64, mime_type: file.type, filename: file.name, size: file.size });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

let attachmentSeq = 0;

export function useComposerAttachments() {
  const [images, setImages] = React.useState([]);
  const [attachments, setAttachments] = React.useState([]);
  const [rejections, setRejections] = React.useState([]);

  const patchAttachment = React.useCallback((id, patch) => {
    setAttachments((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const dropAttachment = React.useCallback((id) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const addFiles = React.useCallback(
    async (files) => {
      const notices = [];
      let rawTotal = [...attachments, ...images].reduce(
        (sum, item) => sum + (item.payloadSize || item.size || 0),
        0
      );

      for (const file of files) {
        const meta = { mime_type: file.type, filename: file.name };

        // Legacy binary Office (.xls/.doc/.ppt): no extractor exists, and
        // shipping raw bytes is dishonest — the model never sees attachment
        // bytes. Reject with specific convert guidance instead.
        const upgrade = legacyOfficeUpgrade(meta);
        if (upgrade) {
          notices.push(
            `${file.name}: legacy Office format — save it as ${upgrade} and attach that instead.`
          );
          continue;
        }

        if (file.type.startsWith('image/')) {
          if (file.size > MAX_RAW_FILE_SIZE || rawTotal + file.size > MAX_RAW_TOTAL_SIZE) {
            notices.push(`${file.name} skipped — images are limited to 5 MB.`);
            continue;
          }
          rawTotal += file.size;
          const info = await readDataUrl(file);
          setImages((prev) => [...prev, info]);
          continue;
        }

        if (isExtractableBinary(meta)) {
          if (file.size > MAX_DOCUMENT_FILE_SIZE) {
            notices.push(`${file.name} skipped — documents are limited to 256 MB.`);
            continue;
          }
          // Show the chip immediately; extraction of a large document takes
          // visible time and must never look like a silent drop.
          const id = `att-${(attachmentSeq += 1)}`;
          const pending = {
            id,
            filename: file.name,
            mime_type: file.type || 'application/octet-stream',
            size: file.size,
            base64: '',
            payloadSize: 0,
            extraction: 'extracting',
            // File handle retained for the preview (zero-copy); never
            // serialized to the wire or persisted.
            sourceFile: file
          };
          setAttachments((prev) => [...prev, pending]);
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const result = await extractAttachmentText(
              { ...meta, bytes },
              {
                // Scanned PDFs go through local OCR — seconds per page. The
                // chip narrates so a long extraction never looks stuck.
                onProgress: (progress) => {
                  if (progress?.kind === 'ocr') {
                    patchAttachment(id, {
                      progressLabel: `OCR ${progress.page}/${progress.pages}`
                    });
                  }
                }
              }
            );
            if (result.extracted) {
              const base64 = textToBase64(result.text);
              patchAttachment(id, {
                base64,
                mime_type: 'text/plain',
                payloadSize: result.text.length,
                extraction: 'extracted',
                extractionMethod: result.method || 'text',
                progressLabel: '',
                extractedChars: result.text.length,
                extractedText: result.text,
                partial: Boolean(result.partial)
              });
              if (result.partial) {
                // Some of the document extracted, but a part was damaged — say
                // so rather than letting a partial read look complete.
                notices.push(
                  `${file.name}: part of this file could not be read — the rest was sent.`
                );
              }
            } else if (result.reason === 'encrypted' || result.reason === 'corrupt') {
              // A diagnosable container failure: don't ship an unreadable
              // blob — tell the user exactly how to fix it.
              dropAttachment(id);
              notices.push(
                result.reason === 'encrypted'
                  ? `${file.name} is password-protected — remove the protection and attach it again.`
                  : `${file.name} could not be opened — the file looks corrupted or incomplete.`
              );
            } else if (file.size <= MAX_RAW_FILE_SIZE) {
              // No readable text (scanned/image-only) but small enough to
              // ship raw. The model cannot read raw binary — the chip says
              // so via modelReadable instead of pretending success.
              rawTotal += file.size;
              const info = await readDataUrl(file);
              patchAttachment(id, {
                base64: info.base64,
                payloadSize: file.size,
                extraction: 'raw',
                modelReadable: isAttachmentTextEmbeddable({
                  name: file.name,
                  mime_type: file.type
                })
              });
            } else {
              dropAttachment(id);
              notices.push(
                `${file.name}: no readable text found (scanned or image-only) — it will not be sent.`
              );
            }
          } catch (_) {
            dropAttachment(id);
            notices.push(`${file.name}: could not be read — it will not be sent.`);
          }
          continue;
        }

        // Plain (text-ish or unknown) files ship raw.
        if (file.size > MAX_RAW_FILE_SIZE) {
          notices.push(`${file.name} skipped — files of this type are limited to 5 MB.`);
          continue;
        }
        if (rawTotal + file.size > MAX_RAW_TOTAL_SIZE) {
          notices.push(`${file.name} skipped — total attachment size is limited to 10 MB.`);
          continue;
        }
        rawTotal += file.size;
        const info = await readDataUrl(file);
        setAttachments((prev) => [
          ...prev,
          {
            id: `att-${(attachmentSeq += 1)}`,
            ...info,
            payloadSize: file.size,
            extraction: 'raw',
            sourceFile: file,
            modelReadable: isAttachmentTextEmbeddable({
              name: file.name,
              mime_type: file.type
            })
          }
        ]);
      }

      if (notices.length > 0) {
        setRejections((prev) => [...prev, ...notices].slice(-4));
      }
    },
    [attachments, dropAttachment, images, patchAttachment]
  );

  return {
    images,
    attachments,
    rejections,
    addFiles,
    removeImage: (index) => setImages((prev) => prev.filter((_, idx) => idx !== index)),
    removeAttachment: (index) => setAttachments((prev) => prev.filter((_, idx) => idx !== index)),
    dismissRejections: () => setRejections([]),
    clearAttachments: () => {
      setImages([]);
      setAttachments([]);
      setRejections([]);
    }
  };
}
