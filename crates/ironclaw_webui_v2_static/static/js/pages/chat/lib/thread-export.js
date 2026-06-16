function normalizeRole(role) {
  if (!role) return 'unknown';
  return String(role).trim().toLowerCase();
}

function titleCase(value) {
  if (!value) return 'Unknown';
  const text = String(value).toLowerCase().replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function safeValue(value) {
  if (value == null) return '';
  return String(value);
}

function normalizeAttachments(message) {
  const raw = Array.isArray(message?.attachments) ? message.attachments : [];
  return raw
    .map((attachment) =>
      attachment
        ? {
            filename: attachment.filename || null,
            mime_type: attachment.mime_type || attachment.content_type || null,
            size_label: attachment.size_label || attachment.size || null
          }
        : null
    )
    .filter(Boolean);
}

function normalizeToolFields(message) {
  return {
    toolName: message.toolName || message.capabilityId || message.capability_id || null,
    toolStatus: message.toolStatus || message.status || null,
    toolDetail: message.toolDetail || message.subtitle || null,
    toolParameters: message.toolParameters || message.input_summary || null,
    toolResultPreview: message.toolResultPreview || message.output_preview || null,
    toolError: message.toolError || message.error || null,
    toolDurationMs: message.toolDurationMs || message.duration_ms || null,
    resultRef: message.resultRef || message.result_ref || null,
    turnRunId: message.turnRunId || null
  };
}

function normalizeMessageForExport(message = {}) {
  const role = normalizeRole(message.role);
  const attachments = normalizeAttachments(message);
  const images = Array.isArray(message.generatedImages) ? message.generatedImages : [];
  const base = {
    role,
    id: message.id || null,
    timestamp: message.timestamp || null
  };

  if (role === 'image') {
    return {
      ...base,
      content: safeValue(message.content || ''),
      generatedImages: images,
      attachments: attachments.length ? attachments : []
    };
  }

  if (role === 'tool_activity') {
    return {
      ...base,
      content: safeValue(message.content || ''),
      ...normalizeToolFields(message)
    };
  }

  const content = message.content == null ? '' : String(message.content);
  if (role === 'thinking') {
    return {
      ...base,
      content
    };
  }

  return {
    ...base,
    content,
    images: Array.isArray(message.images) ? message.images : [],
    attachments: attachments.length ? attachments : []
  };
}

function normalizeThreadTitle(options) {
  const fallbackTitle =
    typeof document === 'undefined' ? 'IronClaw chat' : document.title || 'IronClaw chat';
  return safeValue(options?.title || fallbackTitle);
}

export function buildThreadExportPayload(messages = [], options = {}) {
  const exportedAt = options.exportedAt || new Date().toISOString();
  const visibleMessages = Array.isArray(messages) ? messages : [];
  return {
    thread: {
      title: normalizeThreadTitle(options),
      exported_at: exportedAt,
      message_count: visibleMessages.length
    },
    messages: visibleMessages.map(normalizeMessageForExport)
  };
}

export function buildThreadJsonExport(messages = [], options = {}) {
  return JSON.stringify(buildThreadExportPayload(messages, options), null, 2);
}

function appendIfPresent(lines, label, value) {
  const text = safeValue(value).trim();
  if (text) lines.push(`- ${label}: ${text}`);
}

function renderToolActivityBlock(message) {
  const lines = [];
  appendIfPresent(lines, 'Tool', message.toolName);
  appendIfPresent(lines, 'Status', message.toolStatus);
  appendIfPresent(lines, 'Tool Details', message.toolDetail);
  appendIfPresent(lines, 'Tool Parameters', message.toolParameters);
  appendIfPresent(lines, 'Tool Result', message.toolResultPreview);
  appendIfPresent(lines, 'Error', message.toolError);
  appendIfPresent(lines, 'Duration (ms)', message.toolDurationMs);
  appendIfPresent(lines, 'Result Ref', message.resultRef);
  return lines;
}

function renderMessageBlock(message) {
  const content = safeValue(message.content).trim() || '(empty)';
  const lines = [];
  lines.push(`## ${titleCase(message.role || 'assistant')}`);
  if (message.timestamp) {
    lines.push(`_timestamp: ${message.timestamp}_`);
  }

  if (message.role === 'tool_activity') {
    const toolLines = renderToolActivityBlock(message);
    if (toolLines.length > 0) {
      lines.push(...toolLines);
    } else {
      lines.push(content);
    }
    return lines.join('\n');
  }

  if (message.role === 'image') {
    const images = Array.isArray(message.generatedImages) ? message.generatedImages : [];
    lines.push('Generated Images');
    if (images.length === 0) {
      lines.push('(no images available)');
    } else {
      for (const image of images) {
        lines.push(`- ${safeValue(image.data_url || image.path || image.url || image.filename)}`);
      }
    }
    return lines.join('\n');
  }

  if (message.attachments?.length) {
    lines.push('');
    lines.push('### Attachments');
    for (const attachment of message.attachments) {
      const filename = safeValue(attachment.filename || 'attachment');
      const mimeType = safeValue(attachment.mime_type);
      const size = safeValue(attachment.size_label);
      lines.push(`- ${filename}${mimeType ? ` (${mimeType})` : ''}${size ? ` — ${size}` : ''}`);
    }
  }

  if (message.images?.length) {
    lines.push('');
    lines.push('### Images');
    for (const image of message.images) {
      lines.push(`- ${safeValue(image)}`);
    }
  }

  lines.push('');
  lines.push(content);
  return lines.join('\n');
}

export function buildThreadMarkdownExport(messages = [], options = {}) {
  const payload = buildThreadExportPayload(messages, options);
  const title = payload.thread.title;
  const lines = [`# ${title}`, '', `Exported at: ${payload.thread.exported_at}`, ''];
  const contentLines = payload.messages.map(renderMessageBlock).filter(Boolean);
  lines.push(...contentLines);
  return lines.join('\n\n');
}
