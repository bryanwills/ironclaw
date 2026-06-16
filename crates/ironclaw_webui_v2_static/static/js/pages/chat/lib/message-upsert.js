export const FAILURE_SOURCE_PRIORITY = {
  run_status: 3,
  generic: 1,
  fallback: 1,
  unknown: 0
};

export function failureMessageSourcePriority(source) {
  return FAILURE_SOURCE_PRIORITY[source] ?? FAILURE_SOURCE_PRIORITY.unknown;
}

export function upsertRunFailureMessage(setMessages, options = {}) {
  const { runId, content, source = 'generic', timestamp = new Date().toISOString() } = options;
  const messageId = `err-${runId || 'unknown'}`;
  const nextPriority = failureMessageSourcePriority(source);

  setMessages((messages) => {
    const existingIndex = messages.findIndex((message) => message.id === messageId);
    if (existingIndex === -1) {
      return [
        ...messages,
        {
          id: messageId,
          role: 'error',
          content: String(content || ''),
          timestamp,
          errorSource: source,
          errorPriority: nextPriority
        }
      ];
    }

    const existing = messages[existingIndex];
    const existingPriority = failureMessageSourcePriority(existing?.errorSource);
    if (
      existingPriority > nextPriority ||
      (existingPriority === nextPriority && existing.content === content)
    ) {
      return messages;
    }

    const next = [...messages];
    next[existingIndex] = {
      ...existing,
      content: String(content || ''),
      timestamp,
      errorSource: source,
      errorPriority: nextPriority
    };
    return next;
  });
}
