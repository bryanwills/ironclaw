export type AttachmentRiskInput = {
  name?: string;
  mime?: string;
  mime_type?: string;
  size?: number;
  dataBase64?: string;
  data_base64?: string;
};

const TEXT_LIKE_MIME = new Set([
  'application/json',
  'application/x-yaml',
  'application/xml',
  'text/markdown',
  'text/x-markdown',
  'text/yaml'
]);

function mimeOf(attachment: AttachmentRiskInput): string {
  return (attachment.mime ?? attachment.mime_type ?? '').toLowerCase();
}

function base64Of(attachment: AttachmentRiskInput): string {
  return attachment.dataBase64 ?? attachment.data_base64 ?? '';
}

export function isTextLikeAttachment(attachment: AttachmentRiskInput): boolean {
  const mime = mimeOf(attachment);
  return mime.startsWith('text/') || TEXT_LIKE_MIME.has(mime);
}

export function decodeBase64Utf8(dataBase64: string): string {
  if (!dataBase64) return '';
  const atobFn = (globalThis as { atob?: (input: string) => string }).atob;
  if (typeof atobFn !== 'function') return '';
  try {
    const binary = atobFn(dataBase64);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

export function attachmentRiskSource(
  attachments: AttachmentRiskInput[],
  maxTextPerAttachment = 2000
): string {
  return attachments
    .map((attachment) => {
      const name = attachment.name?.trim() || 'attachment';
      const mime = mimeOf(attachment) || 'application/octet-stream';
      const header = `attachment:${name} type:${mime}`;
      if (!isTextLikeAttachment(attachment)) return header;
      const decoded = decodeBase64Utf8(base64Of(attachment)).trim();
      if (!decoded) return header;
      return `${header}\n${decoded.slice(0, maxTextPerAttachment)}`;
    })
    .join('\n\n');
}
