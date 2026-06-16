import { React, html } from '../../../lib/html.js';
import { useT } from '../../../lib/i18n.js';
import { Icon } from '../../../design-system/icons.js';

// In-thread find bar (Cmd/Ctrl+F). A quiet, bordered surface pinned to the top
// of the transcript: search field, "{current}/{total}" counter, prev/next, an
// optional "search earlier messages" pager, and close. Enter = next,
// Shift+Enter = prev, Esc = close. 44px controls.
export function ThreadFindBar({
  query,
  onQueryChange,
  matchCount,
  currentIndex,
  onNext,
  onPrev,
  onClose,
  hasMore,
  onSearchEarlier
}) {
  const t = useT();
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  const hasMatches = matchCount > 0;
  const onKeyDown = (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (event.shiftKey) onPrev();
    else onNext();
  };

  return html`
    <div
      role="search"
      aria-label=${t('chat.find.placeholder')}
      className="pointer-events-auto absolute left-1/2 top-3 z-30 flex w-[min(94%,30rem)] -translate-x-1/2 items-center gap-1.5 rounded-[12px] border border-[var(--v2-panel-border)] bg-[var(--v2-surface)] px-2 py-1.5 shadow-[0_12px_34px_-14px_rgba(0,0,0,0.7)]"
    >
      <span className="pl-1 text-[var(--v2-text-faint)]">
        <${Icon} name="search" className="h-4 w-4" />
      </span>
      <input
        ref=${inputRef}
        type="text"
        value=${query}
        onInput=${(event) => onQueryChange(event.currentTarget.value)}
        onKeyDown=${onKeyDown}
        placeholder=${t('chat.find.placeholder')}
        className="min-h-[44px] min-w-0 flex-1 bg-transparent px-1 text-sm text-[var(--v2-text-strong)] outline-none placeholder:text-[var(--v2-text-faint)]"
      />
      <span
        className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--v2-text-faint)]"
        aria-live="polite"
      >
        ${query.trim() ? `${currentIndex}/${matchCount}` : ''}
      </span>
      <button
        type="button"
        aria-label=${t('chat.find.previous')}
        disabled=${!hasMatches}
        onClick=${onPrev}
        className="grid h-9 min-h-[44px] w-9 min-w-[44px] place-items-center rounded-[8px] text-[var(--v2-text-muted)] hover:bg-[var(--v2-surface-muted)] hover:text-[var(--v2-text-strong)] disabled:opacity-40"
      >
        <${Icon} name="chevron" className="h-4 w-4 rotate-180" />
      </button>
      <button
        type="button"
        aria-label=${t('chat.find.next')}
        disabled=${!hasMatches}
        onClick=${onNext}
        className="grid h-9 min-h-[44px] w-9 min-w-[44px] place-items-center rounded-[8px] text-[var(--v2-text-muted)] hover:bg-[var(--v2-surface-muted)] hover:text-[var(--v2-text-strong)] disabled:opacity-40"
      >
        <${Icon} name="chevron" className="h-4 w-4" />
      </button>
      ${hasMore &&
      html`<button
        type="button"
        onClick=${onSearchEarlier}
        className="inline-flex min-h-[44px] shrink-0 items-center rounded-[8px] px-2 py-1 text-[11px] font-medium text-[var(--v2-accent-text)] hover:bg-[var(--v2-surface-muted)]"
      >
        ${t('chat.find.earlier')}
      </button>`}
      <button
        type="button"
        aria-label=${t('shortcuts.close')}
        onClick=${onClose}
        className="grid h-9 min-h-[44px] w-9 min-w-[44px] place-items-center rounded-[8px] text-[var(--v2-text-muted)] hover:bg-[var(--v2-surface-muted)] hover:text-[var(--v2-text-strong)]"
      >
        <${Icon} name="close" className="h-4 w-4" />
      </button>
    </div>
  `;
}
