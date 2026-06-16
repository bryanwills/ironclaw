import { React, html } from "../../../lib/html.js";
import { useT } from "../../../lib/i18n.js";
import { ActivityRun } from "./activity-run.js";
import { MessageBubble } from "./message-bubble.js";
import { ThreadFindBar } from "./thread-find-bar.js";
import { Icon } from "../../../design-system/icons.js";
import { groupMessages } from "../lib/message-groups.js";
import { useThreadFind } from "../hooks/useThreadFind.js";

// Scroll container reserves bottom space so the last row never sits under the
// fixed composer; the jump-to-latest control is anchored to the scroll edge and
// straddles it (translate-y-1/2) rather than floating above (bottom-4). Pinned
// as standalone helpers so the rendered-geometry tests can assert the classes
// without rendering the whole list.
function messageListScrollClass() {
  return "flex flex-1 overflow-y-auto px-4 pb-24 pt-6 sm:px-5 sm:pb-28 lg:px-8";
}

function messageListContentClass() {
  return "mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-5";
}

function jumpToLatestClass() {
  return "absolute bottom-0 left-1/2 z-20 inline-flex -translate-x-1/2 translate-y-1/2 items-center gap-1.5 rounded-full border border-[var(--v2-panel-border)] bg-[var(--v2-surface)] px-3 py-1.5 text-xs font-medium text-[var(--v2-text-strong)] shadow-[0_10px_30px_-12px_rgba(0,0,0,0.7)] hover:border-[color-mix(in_srgb,var(--v2-accent)_40%,var(--v2-panel-border))]";
}

export function MessageList({
  messages,
  isLoading,
  hasMore,
  onLoadMore,
  onRetryMessage,
  threadId,
  pending = false,
  children,
}) {
  const t = useT();
  const containerRef = React.useRef(null);
  const shouldScrollRef = React.useRef(true);
  const [atBottom, setAtBottom] = React.useState(true);

  // Keep the latest content in view. Re-runs on new messages and when the
  // run state flips — the typing indicator / streamed reply are rendered as
  // children (not in `messages`), so they wouldn't trigger this otherwise.
  // The rAF defers the scroll until after layout so `scrollHeight` reflects
  // the just-rendered row (avatar header, markdown, code blocks).
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || !shouldScrollRef.current) return;
    const raf = window.requestAnimationFrame(() => {
      const node = containerRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
    return () => window.cancelAnimationFrame(raf);
  }, [messages, pending]);

  const onScroll = React.useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const threshold = 100;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldScrollRef.current = distance < threshold;
    setAtBottom(distance < threshold);

    if (hasMore && el.scrollTop < threshold && onLoadMore && !isLoading) {
      onLoadMore();
    }
  }, [hasMore, onLoadMore, isLoading]);

  const jumpToBottom = React.useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    shouldScrollRef.current = true;
    setAtBottom(true);
  }, []);

  const grouped = React.useMemo(() => groupMessages(messages), [messages]);
  const find = useThreadFind({ messages, containerRef, hasMore, onLoadMore });

  return html`
    <div className="relative flex min-h-0 min-w-0 flex-1">
      ${find.open &&
      html`<${ThreadFindBar}
        query=${find.query}
        onQueryChange=${find.setQuery}
        matchCount=${find.matchCount}
        currentIndex=${find.currentIndex}
        onNext=${find.next}
        onPrev=${find.prev}
        onClose=${find.close}
        hasMore=${find.hasMore}
        onSearchEarlier=${find.searchEarlier}
      />`}
      <div
        ref=${containerRef}
        onScroll=${onScroll}
        className=${messageListScrollClass()}
        data-testid="chat-message-scroll"
      >
        <div className=${messageListContentClass()} data-testid="chat-message-content">
          ${hasMore &&
          html`
            <div className="text-center">
              <button
                onClick=${onLoadMore}
                disabled=${isLoading}
                className="v2-button rounded-md border border-white/10 px-3 py-1.5 text-xs text-iron-300 hover:border-signal/35 hover:text-white disabled:opacity-50"
              >
                ${isLoading
                  ? t("chat.history.loading")
                  : t("chat.history.loadOlder")}
              </button>
            </div>
          `}
          ${grouped.map((item) =>
            item.type === "activity-run"
              ? html`<${ActivityRun} key=${item.id} activity=${item.activity} />`
              : html`<div
                  key=${item.id}
                  data-message-id=${item.id}
                  aria-current=${find.activeMatchId === item.id ? "true" : undefined}
                  className=${find.activeMatchId === item.id
                    ? "scroll-mt-20 rounded-[14px] ring-2 ring-[var(--v2-accent)] ring-offset-2 ring-offset-[var(--v2-canvas)]"
                    : "scroll-mt-20"}
                >
                  <${MessageBubble}
                    message=${item.message}
                    messages=${messages}
                    onRetry=${onRetryMessage}
                    threadId=${threadId}
                  />
                </div>`
          )}
          ${children}
        </div>
      </div>
      ${!atBottom &&
      html`
        <button
          type="button"
          onClick=${jumpToBottom}
          aria-label=${t("chat.jumpToLatest")}
          className=${jumpToLatestClass()}
          data-testid="chat-jump-to-latest"
        >
          <${Icon} name="arrowDown" className="h-3.5 w-3.5" />
          ${t("chat.jumpToLatest")}
        </button>
      `}
    </div>
  `;
}
