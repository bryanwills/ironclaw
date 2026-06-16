import { describe, expect, test } from 'vitest';
import {
  messagesFromTimeline,
  pendingMessagesAfterTimeline
} from '../crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/history-messages.js';

describe('messagesFromTimeline', () => {
  test('maps Reborn user and assistant records into visible chat bubbles', () => {
    const messages = messagesFromTimeline([
      {
        message_id: 'user-1',
        kind: 'user',
        content: 'Please draft the agreement.',
        sequence: 1,
        turn_run_id: 'run-1'
      },
      {
        message_id: 'assistant-1',
        kind: 'assistant',
        content: 'Draft ready.',
        sequence: 2,
        turn_run_id: 'run-1'
      }
    ]);

    expect(messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'Please draft the agreement.' }),
      expect.objectContaining({ role: 'assistant', content: 'Draft ready.' })
    ]);
  });

  test('dedupes an optimistic user bubble once the timeline has the same content', () => {
    const messages = messagesFromTimeline(
      [
        {
          message_id: 'server-user-1',
          kind: 'user',
          content: 'Keep this turn once.',
          sequence: 1
        }
      ],
      [
        {
          id: 'pending-1',
          role: 'user',
          content: 'Keep this turn once.'
        }
      ]
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({ id: 'msg-server-user-1' }));
  });

  test('keeps the optimistic user bubble when a lagging timeline only has the assistant', () => {
    const messages = messagesFromTimeline(
      [
        {
          message_id: 'assistant-1',
          kind: 'assistant',
          content: 'Reply arrived first.',
          sequence: 2
        }
      ],
      [
        {
          id: 'pending-1',
          role: 'user',
          content: 'Original ask still visible.'
        }
      ]
    );

    expect(messages.map((message) => message.content)).toEqual([
      'Reply arrived first.',
      'Original ask still visible.'
    ]);
  });

  test('strips durable attachment blocks into attachment chips', () => {
    const messages = messagesFromTimeline([
      {
        message_id: 'server-user-attachment',
        kind: 'user',
        content: `Review this PDF.

<attachments>
Attachment 1:
filename: services.pdf
mime_type: application/pdf
data_base64: JVBERi0xLjQKJQ==
</attachments>`,
        sequence: 1
      }
    ]);

    expect(messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'Review this PDF.',
        attachments: [
          expect.objectContaining({
            filename: 'services.pdf',
            mime_type: 'application/pdf',
            size_label: '10 bytes'
          })
        ]
      })
    ]);
  });

  test('dedupes pending attachment bubble against durable server block', () => {
    const messages = messagesFromTimeline(
      [
        {
          message_id: 'server-user-attachment',
          kind: 'user',
          content: `Review this PDF.

<attachments>
Attachment 1:
filename: services.pdf
mime_type: application/pdf
data_base64: JVBERi0xLjQKJQ==
</attachments>`,
          sequence: 1
        }
      ],
      [
        {
          id: 'pending-attachment',
          role: 'user',
          content: 'Review this PDF.',
          attachments: [{ filename: 'services.pdf', mime_type: 'application/pdf' }]
        }
      ]
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        id: 'msg-server-user-attachment',
        content: 'Review this PDF.',
        attachments: [expect.objectContaining({ filename: 'services.pdf' })]
      })
    );
  });

  test('only prunes pending user bubbles that are present in the timeline', () => {
    const remaining = pendingMessagesAfterTimeline(
      [
        {
          message_id: 'server-user-1',
          kind: 'user',
          content: 'Server has this one.',
          sequence: 1
        },
        {
          message_id: 'assistant-1',
          kind: 'assistant',
          content: 'Assistant is ready.',
          sequence: 2
        }
      ],
      [
        {
          id: 'pending-1',
          role: 'user',
          content: 'Server has this one.'
        },
        {
          id: 'pending-2',
          role: 'user',
          content: 'Timeline has not caught this one yet.'
        }
      ]
    );

    expect(remaining).toEqual([
      expect.objectContaining({
        id: 'pending-2',
        content: 'Timeline has not caught this one yet.'
      })
    ]);
  });

  test('renders capability display previews as tool activity cards', () => {
    const messages = messagesFromTimeline([
      {
        message_id: 'tool-preview',
        kind: 'capability_display_preview',
        content: JSON.stringify({
          invocation_id: 'invoke-1',
          status: 'completed',
          title: 'Read attachment',
          output_preview: 'Parsed services template.'
        }),
        sequence: 3
      }
    ]);

    expect(messages).toEqual([
      expect.objectContaining({
        id: 'tool-invoke-1',
        role: 'tool_activity',
        toolName: 'Read attachment',
        toolResultPreview: 'Parsed services template.'
      })
    ]);
  });

  test('does not render tool result references as duplicate chat text', () => {
    const messages = messagesFromTimeline([
      {
        message_id: 'result-ref',
        kind: 'tool_result_reference',
        content: 'Internal result ref',
        sequence: 4
      },
      {
        message_id: 'assistant-1',
        kind: 'assistant',
        content: 'Visible answer.',
        sequence: 5
      }
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({ content: 'Visible answer.' }));
  });
});
