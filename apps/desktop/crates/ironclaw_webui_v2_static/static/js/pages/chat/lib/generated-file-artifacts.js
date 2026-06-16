const MIME_EXTENSIONS = new Map([
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['application/msword', 'doc'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.ms-powerpoint', 'ppt'],
  ['application/json', 'json'],
  ['text/markdown', 'md'],
  ['text/html', 'html'],
  ['text/csv', 'csv'],
  ['text/plain', 'txt']
]);

const TEXT_LIKE_EXTENSIONS = new Set([
  'csv',
  'html',
  'htm',
  'json',
  'jsonl',
  'md',
  'markdown',
  'txt',
  'tsv',
  'xml',
  'yaml',
  'yml'
]);

const TEXT_LIKE_MIMES = new Set([
  'application/csv',
  'application/json',
  'application/ld+json',
  'application/x-ndjson',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'text/csv',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/tab-separated-values',
  'text/xml'
]);

export function generatedFileArtifactsForMessage(message = {}) {
  if (!message || message.role === 'user') return [];

  const candidates = [
    ...arrayValue(message.generatedFiles),
    ...arrayValue(message.generated_files),
    ...arrayValue(message.outputFiles),
    ...arrayValue(message.output_files),
    ...arrayValue(message.files),
    ...arrayValue(message.artifacts),
    ...(message.role === 'assistant' ? arrayValue(message.attachments) : [])
  ];

  const seen = new Set();
  const artifacts = [];
  for (const candidate of candidates) {
    const artifact = normalizeGeneratedFileArtifact(candidate);
    if (!artifact) continue;
    const key = `${artifact.filename}:${artifact.mime_type}:${artifact.data_base64 || artifact.url || artifact.content || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    artifacts.push(artifact);
  }
  return artifacts;
}

export function normalizeGeneratedFileArtifact(candidate = {}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const nested =
    objectValue(candidate.file) ||
    objectValue(candidate.artifact) ||
    objectValue(candidate.output) ||
    candidate;
  const mimeFromDataUrl = dataUrlMime(nested.data_url || nested.dataUrl || nested.url || '');
  const mime = cleanMime(
    nested.mime_type ||
      nested.content_type ||
      nested.mime ||
      nested.media_type ||
      mimeFromDataUrl ||
      ''
  );
  const rawFilename = safeFilename(
    nested.filename ||
      nested.file_name ||
      nested.name ||
      basenameFromPath(nested.path || nested.url || '')
  );
  const base64 = base64Payload(
    nested.data_base64 ||
      nested.base64 ||
      nested.content_base64 ||
      nested.contents_base64 ||
      nested.bytes_base64 ||
      nested.data_url ||
      nested.dataUrl ||
      ''
  );
  const content =
    typeof nested.content === 'string' && !base64 ? nested.content : stringValue(nested.text || '');
  const url = urlValue(nested.download_url || nested.file_url || nested.url || nested.href || '');
  const typedFileSignal = /file|artifact|spreadsheet|presentation|pdf|docx|xlsx|pptx/i.test(
    String(nested.type || nested.kind || nested.output_kind || '')
  );
  const fileSignal =
    rawFilename || mime || base64 || url || typedFileSignal || nested.sourceFile instanceof Blob;
  const payloadSignal = base64 || content || url || nested.sourceFile instanceof Blob;
  if (!fileSignal || !payloadSignal) return null;

  const resolvedMime = mime || mimeFromFilename(rawFilename) || 'application/octet-stream';
  const filename = rawFilename || defaultFilename(resolvedMime);
  const size =
    numberValue(nested.size || nested.bytes || nested.output_bytes) || base64ByteLength(base64);
  return {
    id: String(nested.id || nested.artifact_id || nested.file_id || filename),
    title: String(nested.title || filename || 'Generated file').trim(),
    filename: filename || defaultFilename(resolvedMime),
    mime_type: resolvedMime,
    data_base64: base64,
    content,
    url,
    size,
    size_label: nested.size_label || (size ? formatBytes(size) : ''),
    provenance: arrayValue(nested.provenance),
    content_format: base64 ? 'base64' : nested.content_format || 'text',
    sourceFile: nested.sourceFile instanceof Blob ? nested.sourceFile : null
  };
}

export function buildGeneratedFileBlob(artifact = {}) {
  const normalized = normalizeGeneratedFileArtifact(artifact);
  if (!normalized) return null;
  if (normalized.sourceFile instanceof Blob) return normalized.sourceFile;
  if (normalized.data_base64) {
    return new Blob([base64ToBytes(normalized.data_base64)], {
      type: normalized.mime_type || 'application/octet-stream'
    });
  }
  if (normalized.content) {
    return new Blob([normalized.content], { type: normalized.mime_type || 'text/plain' });
  }
  return null;
}

export function generatedFilePreviewAttachment(artifact = {}) {
  const normalized = normalizeGeneratedFileArtifact(artifact);
  if (!normalized) return null;
  const blob = buildGeneratedFileBlob(normalized);
  const previewText = textPreviewForGeneratedFileArtifact(normalized);
  return {
    filename: normalized.filename,
    mime_type: normalized.mime_type,
    size_label: normalized.size_label,
    sourceFile: blob,
    embedded_text: previewText,
    extractedText: previewText,
    extraction_status: previewText ? 'extracted_text' : ''
  };
}

export function textPreviewForGeneratedFileArtifact(artifact = {}) {
  const normalized = normalizeGeneratedFileArtifact(artifact);
  if (!normalized) return '';
  if (normalized.content) return normalized.content;
  if (!normalized.data_base64 || !isTextLikeGeneratedFile(normalized)) return '';
  try {
    return new TextDecoder().decode(base64ToBytes(normalized.data_base64));
  } catch {
    return '';
  }
}

export function isTextLikeGeneratedFile(artifact = {}) {
  const mime = cleanMime(artifact.mime_type || artifact.content_type || '');
  if (mime.startsWith('text/') || TEXT_LIKE_MIMES.has(mime)) return true;
  const ext = extensionFromFilename(artifact.filename || artifact.name || '');
  return TEXT_LIKE_EXTENSIONS.has(ext);
}

export function generatedFileKindLabel(artifact = {}) {
  const ext = extensionFromFilename(artifact.filename || '');
  if (ext) return ext.toUpperCase();
  const mime = cleanMime(artifact.mime_type || '');
  if (!mime) return 'FILE';
  return (MIME_EXTENSIONS.get(mime) || mime.split('/').pop() || 'file').toUpperCase();
}

export function formatBytes(size) {
  const value = Number(size);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024) return `${value} bytes`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function base64ToBytes(base64) {
  const clean = base64Payload(base64);
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function base64Payload(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/is);
  return (match ? match[2] : raw).replace(/\s+/g, '');
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function urlValue(value) {
  const text = String(value || '').trim();
  return /^https?:\/\//i.test(text) || /^blob:/i.test(text) ? text : '';
}

function cleanMime(value) {
  return String(value || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

function dataUrlMime(value) {
  return cleanMime(String(value || '').match(/^data:([^;,]+)?/i)?.[1] || '');
}

function basenameFromPath(path) {
  const value = String(path || '')
    .split(/[?#]/)[0]
    .trim();
  if (!value) return '';
  return value.split('/').filter(Boolean).pop() || '';
}

function safeFilename(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const cleaned = raw
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 120);
}

function defaultFilename(mime) {
  const ext = MIME_EXTENSIONS.get(cleanMime(mime)) || 'bin';
  return `generated-output.${ext}`;
}

function mimeFromFilename(filename) {
  const ext = extensionFromFilename(filename);
  for (const [mime, mappedExt] of MIME_EXTENSIONS.entries()) {
    if (mappedExt === ext) return mime;
  }
  if (ext === 'csv') return 'text/csv';
  if (ext === 'html' || ext === 'htm') return 'text/html';
  if (ext === 'md' || ext === 'markdown') return 'text/markdown';
  if (ext === 'json') return 'application/json';
  if (ext === 'txt') return 'text/plain';
  return '';
}

function extensionFromFilename(filename) {
  const name = String(filename || '').toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1);
}

function base64ByteLength(base64) {
  const clean = base64Payload(base64);
  if (!clean) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}
