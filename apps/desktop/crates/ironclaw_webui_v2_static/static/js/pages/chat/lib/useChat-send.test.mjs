import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { messagesFromTimeline, buildDurableAttachmentBlock } from './history-messages.js';
import { flattenCachedThreads } from './thread-cache.js';
import {
  looksLikeChannelConnectCommand,
  resolveChannelConnectCommand,
  resolveExtensionConnectCommand
} from '../../../lib/channel-connect.js';
import {
  addPending,
  loadPending,
  pendingMessageId,
  recordAcceptedMessageRef,
  removePending,
  replacePending
} from './pending-messages.js';

function useChatSourceForTest() {
  const source = readFileSync(new URL('../hooks/useChat.js', import.meta.url), 'utf8');
  const lines = [];
  let skippingImport = false;
  for (const line of source.split('\n')) {
    if (!skippingImport && line.startsWith('import ')) {
      skippingImport = !line.trimEnd().endsWith(';');
      continue;
    }
    if (skippingImport) {
      skippingImport = !line.trimEnd().endsWith(';');
      continue;
    }
    lines.push(line.replace('export function useChat', 'function useChat'));
  }
  return `${lines.join('\n')}\nglobalThis.__testExports = { useChat };`;
}

function createReactStub({ initialByIndex = new Map(), setCalls = [] } = {}) {
  let stateIndex = 0;
  return {
    useCallback: (fn) => fn,
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useState: (initial) => {
      const index = stateIndex++;
      let value = initialByIndex.has(index)
        ? initialByIndex.get(index)
        : typeof initial === 'function'
          ? initial()
          : initial;
      return [
        value,
        (next) => {
          value = typeof next === 'function' ? next(value) : next;
          setCalls.push({ index, value });
        }
      ];
    }
  };
}

test('useChat.send: accepted ref reconciles pending message on timeline reload', async () => {
  const threadId = 'thread-1';
  let renderedMessages = [];
  let loadHistory;

  const context = {
    AbortController,
    TextEncoder,
    Date,
    Error,
    Map,
    Math,
    React: createReactStub(),
    addPending,
    loadPending,
    pendingMessageId,
    buildDurableAttachmentBlock,
    flattenCachedThreads,
    cancelRunRequest: async () => {},
    clearTimeout,
    createThreadRequest: async () => {
      throw new Error('thread should already exist');
    },
    globalThis: {},
    listConnectableChannels: async () => {
      throw new Error('ordinary prompts should not fetch connectable channels');
    },
    looksLikeChannelConnectCommand,
    queryClient: {
      fetchQuery: async () => {
        throw new Error('ordinary prompts should not fetch connectable channels');
      },
      invalidateQueries: () => {}
    },
    recordAcceptedMessageRef,
    removePending,
    replacePending,
    resolveChannelConnectCommand,
    resolveExtensionConnectCommand,
    resolveGateRequest: async () => {},
    sendMessage: async () => ({
      accepted_message_ref: 'msg:message-1',
      run_id: 'run-1',
      status: 'queued',
      thread_id: threadId
    }),
    setInterval,
    setTimeout,
    submitManualToken: async () => {},
    useChatEvents: () => () => {},
    useHistory: (_threadId, options) => {
      loadHistory = async () => {
        const pendingMessages = options.getPendingMessages();
        renderedMessages = messagesFromTimeline(
          [
            {
              message_id: 'message-1',
              kind: 'user',
              content: 'check my calendar',
              sequence: 1,
              status: 'accepted'
            }
          ],
          pendingMessages
        );
        options.setPendingMessages([]);
      };

      return {
        messages: renderedMessages,
        hasMore: false,
        nextCursor: null,
        isLoading: false,
        loadHistory,
        setMessages: (updater) => {
          renderedMessages = typeof updater === 'function' ? updater(renderedMessages) : updater;
        }
      };
    },
    useSSE: () => ({ status: 'idle' })
  };

  vm.runInNewContext(useChatSourceForTest(), context);

  const chat = context.globalThis.__testExports.useChat(threadId);
  await chat.send('check my calendar');

  assert.equal(renderedMessages.length, 1);
  // Ids are collision-proof (random suffix) so restored localStorage rows
  // from a prior session can never share an id with a new send.
  assert.match(renderedMessages[0].id, /^pending-/);
  assert.equal(renderedMessages[0].role, 'user');
  assert.equal(renderedMessages[0].content, 'check my calendar');
  assert.equal(renderedMessages[0].isOptimistic, true);
  assert.equal(renderedMessages[0].timelineMessageId, 'message-1');

  await loadHistory();

  assert.deepEqual(
    renderedMessages.map((message) => message.id),
    ['msg-message-1']
  );
});

test('useChat.send: forwards composer attachments to sendMessage and optimistic bubble', async () => {
  const threadId = 'thread-1';
  let renderedMessages = [];
  let sentArgs = null;
  const attachmentScenarios = [
    {
      filename: 'services-template.pdf',
      mime_type: 'application/pdf',
      base64: 'JVBERi0xLjQK',
      size: 9
    },
    {
      filename: 'redline-instructions.md',
      mime_type: 'text/markdown',
      base64: 'IyBSZWRsaW5lCg==',
      size: 11
    },
    {
      filename: 'invoice-payload.json',
      mime_type: 'application/json',
      base64: 'eyJpbnZvaWNlIjoiSU5WLTEifQ==',
      size: 19
    },
    {
      filename: 'scope-summary.html',
      mime_type: 'text/html',
      base64: 'PCFkb2N0eXBlIGh0bWw+',
      size: 15
    },
    {
      filename: 'board-minutes.docx',
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      base64: 'UEsDBGRvY3g=',
      size: 8
    }
  ];
  const rejectedAttachment = {
    filename: 'corrupt-template.docx',
    mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    base64: '',
    size: 12,
    extraction: 'no-text'
  };

  const context = {
    AbortController,
    TextEncoder,
    Date,
    Error,
    Map,
    Math,
    React: createReactStub(),
    addPending,
    loadPending,
    pendingMessageId,
    buildDurableAttachmentBlock,
    flattenCachedThreads,
    cancelRunRequest: async () => {},
    clearTimeout,
    createThreadRequest: async () => {
      throw new Error('thread should already exist');
    },
    globalThis: {},
    listConnectableChannels: async () => {
      throw new Error('ordinary prompts should not fetch connectable channels');
    },
    looksLikeChannelConnectCommand,
    queryClient: {
      fetchQuery: async () => {
        throw new Error('ordinary prompts should not fetch connectable channels');
      },
      invalidateQueries: () => {}
    },
    recordAcceptedMessageRef,
    removePending,
    replacePending,
    resolveChannelConnectCommand,
    resolveExtensionConnectCommand,
    resolveGateRequest: async () => {},
    sendMessage: async (args) => {
      sentArgs = args;
      return {
        accepted_message_ref: 'msg:message-1',
        run_id: 'run-1',
        status: 'queued',
        thread_id: threadId
      };
    },
    setInterval,
    setTimeout,
    submitManualToken: async () => {},
    useChatEvents: () => () => {},
    useHistory: () => ({
      messages: renderedMessages,
      hasMore: false,
      nextCursor: null,
      isLoading: false,
      loadHistory: () => {},
      setMessages: (updater) => {
        renderedMessages = typeof updater === 'function' ? updater(renderedMessages) : updater;
      }
    }),
    useSSE: () => ({ status: 'idle' })
  };

  vm.runInNewContext(useChatSourceForTest(), context);

  const chat = context.globalThis.__testExports.useChat(threadId);
  await chat.send('draft from the template', {
    attachments: [...attachmentScenarios, rejectedAttachment]
  });

  assert.equal(sentArgs.threadId, threadId);
  // The content sent to Reborn leads with the user's prompt, then carries a
  // durable attachment manifest so the timeline preserves chips across reloads.
  assert.ok(sentArgs.content.startsWith('draft from the template'));
  assert.ok(sentArgs.content.includes('<attachments ic="1">'));
  for (const attachment of attachmentScenarios) {
    assert.ok(
      sentArgs.content.includes(`filename: ${attachment.filename}`),
      `sent content should manifest ${attachment.filename}`
    );
  }
  assert.equal(sentArgs.content.includes(rejectedAttachment.filename), false);
  // The manifest must never inline base64 payloads (content validator rejects
  // them); the document text rides in `content` as decoded durable text.
  assert.equal(sentArgs.content.includes('data_base64'), false);
  for (const attachment of attachmentScenarios) {
    assert.equal(sentArgs.content.includes(attachment.base64), false);
  }
  // The wire carries chip metadata but NO bytes: the Reborn byte-landing path
  // (#4644) is incomplete and 500s on any data_base64 under the DevOnly
  // composition, and the model reads the document only through the inlined
  // durable block above. See attachmentsForWire / GATEWAY_LANDS_ATTACHMENT_BYTES.
  assert.deepEqual(
    JSON.parse(JSON.stringify(sentArgs.attachments)),
    attachmentScenarios.map((attachment) => ({
      name: attachment.filename,
      mime_type: attachment.mime_type,
      data_base64: '',
      size: attachment.size
    }))
  );
  // The optimistic bubble shows the bare prompt (no manifest) plus chips.
  assert.equal(renderedMessages[0].content, 'draft from the template');
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(renderedMessages[0].attachments.map((attachment) => attachment.filename))
    ),
    attachmentScenarios.map((attachment) => attachment.filename)
  );
  assert.equal(
    renderedMessages[0].attachments.some(
      (attachment) => attachment.filename === rejectedAttachment.filename
    ),
    false
  );
  for (const attachment of attachmentScenarios) {
    const chip = renderedMessages[0].attachments.find(
      (candidate) => candidate.filename === attachment.filename
    );
    assert.equal(chip.mime_type, attachment.mime_type);
    assert.equal(chip.size_label, `${attachment.size} bytes`);
  }
});

test('useChat.cancelRun clears local state before cancel request resolves', async () => {
  const threadId = 'thread-1';
  const stateUpdates = [];
  let cancelRequest = null;
  let resolveCancelRequest;

  const context = {
    AbortController,
    TextEncoder,
    Date,
    Error,
    Map,
    Math,
    React: createReactStub({
      // useChat state call order: cooldownUntil, now, activeRun,
      // channelConnectAction, isProcessing, pendingGate.
      initialByIndex: new Map([
        [2, { runId: 'run-1', threadId, status: 'running' }],
        [4, true],
        [5, { runId: 'run-1', gateRef: 'gate-1' }]
      ]),
      setCalls: stateUpdates
    }),
    addPending,
    loadPending,
    pendingMessageId,
    buildDurableAttachmentBlock,
    flattenCachedThreads,
    cancelRunRequest: async (request) => {
      cancelRequest = request;
      return new Promise((resolve) => {
        resolveCancelRequest = resolve;
      });
    },
    clearTimeout,
    createThreadRequest: async () => {
      throw new Error('createThread should not run');
    },
    globalThis: {},
    listConnectableChannels: async () => ({
      channels: []
    }),
    looksLikeChannelConnectCommand,
    queryClient: {
      fetchQuery: async () => ({ channels: [] }),
      invalidateQueries: () => {}
    },
    recordAcceptedMessageRef,
    removePending,
    replacePending,
    resolveChannelConnectCommand,
    resolveExtensionConnectCommand,
    resolveGateRequest: async () => {},
    sendMessage: async () => {
      throw new Error('sendMessage should not run');
    },
    setInterval,
    setTimeout,
    submitManualToken: async () => {},
    useChatEvents: () => () => {},
    useHistory: () => ({
      messages: [],
      hasMore: false,
      nextCursor: null,
      isLoading: false,
      loadHistory: () => {},
      setMessages: () => {}
    }),
    useSSE: () => ({ status: 'idle' })
  };

  vm.runInNewContext(useChatSourceForTest(), context);

  const chat = context.globalThis.__testExports.useChat(threadId);
  const cancelPromise = chat.cancelRun('user_requested');

  assert.equal(cancelRequest.threadId, threadId);
  assert.equal(cancelRequest.runId, 'run-1');
  assert.equal(cancelRequest.reason, 'user_requested');
  assert.deepEqual(stateUpdates.slice(0, 3), [
    { index: 5, value: null },
    { index: 4, value: false },
    { index: 2, value: null }
  ]);

  resolveCancelRequest({});
  await cancelPromise;
});

test('useChat.cancelRun completion does not clear a newer run', async () => {
  const threadId = 'thread-1';
  const stateUpdates = [];
  let resolveCancelRequest;

  const context = {
    AbortController,
    TextEncoder,
    Date,
    Error,
    Map,
    Math,
    React: createReactStub({
      initialByIndex: new Map([
        [2, { runId: 'run-1', threadId, status: 'running' }],
        [4, true]
      ]),
      setCalls: stateUpdates
    }),
    addPending,
    loadPending,
    pendingMessageId,
    buildDurableAttachmentBlock,
    flattenCachedThreads,
    cancelRunRequest: async () =>
      new Promise((resolve) => {
        resolveCancelRequest = resolve;
      }),
    clearTimeout,
    createThreadRequest: async () => {
      throw new Error('createThread should not run');
    },
    globalThis: {},
    listConnectableChannels: async () => {
      throw new Error('ordinary prompts should not fetch connectable channels');
    },
    looksLikeChannelConnectCommand,
    queryClient: {
      fetchQuery: async () => {
        throw new Error('ordinary prompts should not fetch connectable channels');
      },
      invalidateQueries: () => {}
    },
    recordAcceptedMessageRef,
    removePending,
    replacePending,
    resolveChannelConnectCommand,
    resolveExtensionConnectCommand,
    resolveGateRequest: async () => {},
    sendMessage: async () => ({
      accepted_message_ref: 'msg:message-2',
      run_id: 'run-2',
      status: 'queued',
      thread_id: threadId
    }),
    setInterval,
    setTimeout,
    submitManualToken: async () => {},
    useChatEvents: () => () => {},
    useHistory: () => ({
      messages: [],
      hasMore: false,
      nextCursor: null,
      isLoading: false,
      loadHistory: () => {},
      setMessages: () => {}
    }),
    useSSE: () => ({ status: 'idle' })
  };

  vm.runInNewContext(useChatSourceForTest(), context);

  const chat = context.globalThis.__testExports.useChat(threadId);
  const cancelPromise = chat.cancelRun('user_requested');
  await chat.send('next request');

  const newerRunUpdate = stateUpdates.find(
    (update) => update.index === 2 && update.value?.runId === 'run-2'
  );
  assert.equal(newerRunUpdate?.value.threadId, threadId);
  assert.equal(newerRunUpdate?.value.status, 'queued');
  assert.equal(newerRunUpdate?.value.source, 'local');

  const updatesBeforeCancelResolution = stateUpdates.length;
  resolveCancelRequest({});
  await cancelPromise;

  assert.deepEqual(stateUpdates.slice(updatesBeforeCancelResolution), []);
});

test('useChat.send: channel connect requests return an action without submitting a prompt', async () => {
  let createThreadCalled = false;
  let sendMessageCalled = false;

  const context = {
    AbortController,
    TextEncoder,
    Date,
    Error,
    Map,
    Math,
    React: createReactStub(),
    addPending,
    loadPending,
    pendingMessageId,
    buildDurableAttachmentBlock,
    flattenCachedThreads,
    cancelRunRequest: async () => {},
    clearTimeout,
    createThreadRequest: async () => {
      createThreadCalled = true;
      throw new Error('connect action should not create a thread');
    },
    globalThis: {},
    listConnectableChannels: async () => ({
      channels: [
        {
          channel: 'slack',
          display_name: 'Slack',
          strategy: 'inbound_proof_code',
          command_aliases: ['slack', 'slack account'],
          action: {
            title: 'Slack account connection',
            instructions: 'Message the Slack app, then enter the code here.'
          }
        }
      ]
    }),
    looksLikeChannelConnectCommand,
    queryClient: {
      fetchQuery: async ({ queryFn }) => queryFn(),
      invalidateQueries: () => {}
    },
    recordAcceptedMessageRef,
    removePending,
    replacePending,
    resolveChannelConnectCommand,
    resolveExtensionConnectCommand,
    resolveGateRequest: async () => {},
    sendMessage: async () => {
      sendMessageCalled = true;
      throw new Error('connect action should not submit a model prompt');
    },
    setInterval,
    setTimeout,
    submitManualToken: async () => {},
    useChatEvents: () => () => {},
    useHistory: () => ({
      messages: [],
      hasMore: false,
      nextCursor: null,
      isLoading: false,
      loadHistory: () => {},
      setMessages: () => {}
    }),
    useSSE: () => ({ status: 'idle' })
  };

  vm.runInNewContext(useChatSourceForTest(), context);

  const chat = context.globalThis.__testExports.useChat(null);
  const response = await chat.send('connect my Slack account');

  assert.equal(createThreadCalled, false);
  assert.equal(sendMessageCalled, false);
  assert.equal(response.channel_connect_action.channel, 'slack');
  assert.equal(response.channel_connect_action.strategy, 'inbound_proof_code');
});

test('useChat.send: extension connect requests show setup action without submitting a prompt', async () => {
  let createThreadCalled = false;
  let sendMessageCalled = false;

  const context = {
    AbortController,
    TextEncoder,
    Date,
    Error,
    Map,
    Math,
    React: createReactStub(),
    addPending,
    loadPending,
    pendingMessageId,
    buildDurableAttachmentBlock,
    flattenCachedThreads,
    cancelRunRequest: async () => {},
    clearTimeout,
    createThreadRequest: async () => {
      createThreadCalled = true;
      throw new Error('connect action should not create a thread');
    },
    globalThis: {},
    listConnectableChannels: async () => ({ channels: [] }),
    looksLikeChannelConnectCommand,
    queryClient: {
      fetchQuery: async ({ queryFn }) => queryFn(),
      invalidateQueries: () => {}
    },
    recordAcceptedMessageRef,
    removePending,
    replacePending,
    resolveChannelConnectCommand,
    resolveExtensionConnectCommand,
    resolveGateRequest: async () => {},
    sendMessage: async () => {
      sendMessageCalled = true;
      throw new Error('connect action should not submit a model prompt');
    },
    setInterval,
    setTimeout,
    submitManualToken: async () => {},
    useChatEvents: () => () => {},
    useHistory: () => ({
      messages: [],
      hasMore: false,
      nextCursor: null,
      isLoading: false,
      loadHistory: () => {},
      setMessages: () => {}
    }),
    useSSE: () => ({ status: 'idle' })
  };

  vm.runInNewContext(useChatSourceForTest(), context);

  const chat = context.globalThis.__testExports.useChat(null);
  const response = await chat.send('connect notion for my team docs');

  assert.equal(createThreadCalled, false);
  assert.equal(sendMessageCalled, false);
  assert.equal(response.channel_connect_action.channel, 'notion');
  assert.equal(response.channel_connect_action.strategy, 'extension_setup_link');
  assert.equal(response.channel_connect_action.package_ref.id, 'mcp-servers/notion');
  assert.equal(
    response.channel_connect_action.action.href,
    '/extensions/registry?setup=1&focus=notion'
  );
});

test('useChat.send: unmatched channel connect requests submit the prompt', async () => {
  let createThreadCalled = false;
  let sentContent = null;

  const context = {
    AbortController,
    TextEncoder,
    Date,
    Error,
    Map,
    Math,
    React: createReactStub(),
    addPending,
    loadPending,
    pendingMessageId,
    buildDurableAttachmentBlock,
    flattenCachedThreads,
    cancelRunRequest: async () => {},
    clearTimeout,
    createThreadRequest: async () => {
      createThreadCalled = true;
      return { thread: { thread_id: 'thread-created' } };
    },
    globalThis: {},
    listConnectableChannels: async () => ({
      channels: [
        {
          channel: 'slack',
          display_name: 'Slack',
          strategy: 'inbound_proof_code',
          command_aliases: ['slack', 'slack account'],
          action: {
            title: 'Slack account connection',
            instructions: 'Message the Slack app, then enter the code here.'
          }
        }
      ]
    }),
    looksLikeChannelConnectCommand,
    queryClient: {
      fetchQuery: async ({ queryFn }) => queryFn(),
      invalidateQueries: () => {}
    },
    recordAcceptedMessageRef,
    removePending,
    replacePending,
    resolveChannelConnectCommand,
    resolveExtensionConnectCommand,
    resolveGateRequest: async () => {},
    sendMessage: async ({ content, threadId }) => {
      sentContent = content;
      return {
        accepted_message_ref: 'msg:message-2',
        run_id: 'run-2',
        status: 'queued',
        thread_id: threadId
      };
    },
    setInterval,
    setTimeout,
    submitManualToken: async () => {},
    useChatEvents: () => () => {},
    useHistory: () => ({
      messages: [],
      hasMore: false,
      nextCursor: null,
      isLoading: false,
      loadHistory: () => {},
      setMessages: () => {}
    }),
    useSSE: () => ({ status: 'idle' })
  };

  vm.runInNewContext(useChatSourceForTest(), context);

  const chat = context.globalThis.__testExports.useChat(null);
  const response = await chat.send('connect telegram account');

  assert.equal(createThreadCalled, true);
  assert.equal(sentContent, 'connect telegram account');
  assert.equal(response.channel_connect_action, undefined);
  assert.equal(response.thread_id, 'thread-created');
});

test('useChat.send: connectable channel fetch failures fall back to extension setup', async () => {
  let createThreadCalled = false;
  let sentContent = null;
  const loggedErrors = [];

  const context = {
    AbortController,
    TextEncoder,
    Date,
    Error,
    Map,
    Math,
    React: createReactStub(),
    addPending,
    loadPending,
    pendingMessageId,
    buildDurableAttachmentBlock,
    flattenCachedThreads,
    cancelRunRequest: async () => {},
    clearTimeout,
    console: {
      error: (...args) => loggedErrors.push(args)
    },
    createThreadRequest: async () => {
      createThreadCalled = true;
      return { thread: { thread_id: 'thread-created' } };
    },
    globalThis: {},
    listConnectableChannels: async () => {
      throw new Error('connectable channel service unavailable');
    },
    looksLikeChannelConnectCommand,
    queryClient: {
      fetchQuery: async ({ queryFn }) => queryFn(),
      invalidateQueries: () => {}
    },
    recordAcceptedMessageRef,
    removePending,
    replacePending,
    resolveChannelConnectCommand,
    resolveExtensionConnectCommand,
    resolveGateRequest: async () => {},
    sendMessage: async ({ content, threadId }) => {
      sentContent = content;
      return {
        accepted_message_ref: 'msg:message-3',
        run_id: 'run-3',
        status: 'queued',
        thread_id: threadId
      };
    },
    setInterval,
    setTimeout,
    submitManualToken: async () => {},
    useChatEvents: () => () => {},
    useHistory: () => ({
      messages: [],
      hasMore: false,
      nextCursor: null,
      isLoading: false,
      loadHistory: () => {},
      setMessages: () => {}
    }),
    useSSE: () => ({ status: 'idle' })
  };

  vm.runInNewContext(useChatSourceForTest(), context);

  const chat = context.globalThis.__testExports.useChat(null);
  const response = await chat.send('connect my Slack account');

  assert.equal(createThreadCalled, false);
  assert.equal(sentContent, null);
  assert.equal(response.channel_connect_action.channel, 'slack');
  assert.equal(response.channel_connect_action.strategy, 'extension_setup_link');
  assert.equal(
    response.channel_connect_action.action.href,
    '/extensions/registry?setup=1&focus=slack'
  );
  assert.equal(loggedErrors[0][0], 'Failed to resolve connectable channels:');
});
