import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function messageListSourceForTest() {
  const source = readFileSync(new URL('../components/message-list.js', import.meta.url), 'utf8');
  const lines = [];
  for (const line of source.split('\n')) {
    if (line.startsWith('import ')) continue;
    lines.push(line.replace('export function MessageList', 'function MessageList'));
  }
  return `${lines.join('\n')}\nglobalThis.__testExports = { MessageList, messageListScrollClass, messageListContentClass, jumpToLatestClass };`;
}

function createMessageListContext() {
  return {
    React: {
      useCallback: (fn) => fn,
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useRef: (initial) => ({ current: initial }),
      useState: (initial) => [initial, () => {}]
    },
    globalThis: {},
    html: (strings, ...values) => ({ strings: Array.from(strings), values }),
    useT: () => (key) => key,
    ActivityRun() {},
    MessageBubble() {},
    ThreadFindBar() {},
    Icon() {},
    groupMessages: (messages) => messages.map((message) => ({ id: message.id, message })),
    useThreadFind: () => ({
      open: false,
      query: '',
      setQuery() {},
      matchCount: 0,
      currentIndex: 0,
      activeMatchId: null,
      hasMore: false,
      openFind() {},
      close() {},
      next() {},
      prev() {},
      searchEarlier() {}
    })
  };
}

test('message list reserves bottom space for composer and jump control', () => {
  const context = createMessageListContext();

  vm.runInNewContext(messageListSourceForTest(), context);
  const { messageListScrollClass, messageListContentClass, jumpToLatestClass } =
    context.globalThis.__testExports;

  assert.match(messageListScrollClass(), /\bpb-24\b/);
  assert.match(messageListScrollClass(), /\bsm:pb-28\b/);
  assert.doesNotMatch(messageListScrollClass(), /\bpy-6\b/);
  assert.match(messageListContentClass(), /\bmax-w-5xl\b/);
  assert.match(jumpToLatestClass(), /\bbottom-0\b/);
  assert.match(jumpToLatestClass(), /\btranslate-y-1\/2\b/);
  assert.doesNotMatch(jumpToLatestClass(), /\bbottom-4\b/);
});

test('message list renders stable hooks for rendered geometry smoke tests', () => {
  const context = createMessageListContext();

  vm.runInNewContext(messageListSourceForTest(), context);
  const tree = context.globalThis.__testExports.MessageList({
    messages: [{ id: 'm1', role: 'assistant', content: 'Done' }],
    isLoading: false,
    hasMore: false
  });
  const flat = flatStrings(tree);

  assert.match(flat, /data-testid="chat-message-scroll"/);
  assert.match(flat, /data-testid="chat-message-content"/);
});

function flatStrings(node) {
  const out = [];
  const visit = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object' && Array.isArray(value.strings)) {
      out.push(value.strings.join(' '));
      value.values.forEach(visit);
    }
  };
  visit(node);
  return out.join('\n');
}
