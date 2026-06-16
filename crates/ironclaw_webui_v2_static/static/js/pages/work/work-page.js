import { Link, useSearchParams } from 'react-router';
import { Button } from '../../design-system/button.js';
import { Icon } from '../../design-system/icons.js';
import { React, html } from '../../lib/html.js';
import { toast } from '../../lib/toast.js';
import { MarkdownRenderer } from '../chat/components/markdown-renderer.js';
import {
  copyWorkProduct,
  downloadDocx,
  downloadHtml,
  downloadJson,
  downloadMarkdown,
  downloadPdf
} from '../chat/lib/work-product-export.js';
import { readSavedWorkItems, workArtifactHref } from '../chat/lib/work-product-save.js';
import {
  buildGeneratedFileBlob,
  generatedFileKindLabel,
  textPreviewForGeneratedFileArtifact
} from '../chat/lib/generated-file-artifacts.js';
import { saveBlob } from '../../lib/save-file.js';
import { workItemSearchMatch } from './lib/work-search.js';
import { buildWorkLedger } from './lib/work-ledger.js';

function safeList(value) {
  return Array.isArray(value) ? value : [];
}

function readableDate(value) {
  if (!value) return 'Saved work';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Saved work';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function fileStem(title) {
  return (
    String(title || 'ironclaw-work-product')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'ironclaw-work-product'
  );
}

function firstReadyArtifact(item) {
  return (
    safeList(item?.artifacts).find(
      (artifact) => artifact?.content || artifact?.data_base64 || artifact?.filename
    ) || null
  );
}

function findArtifact(item, artifactId) {
  // With an explicit id, require an exact match — never silently substitute a
  // different artifact for a deep link that no longer resolves. Only the no-id
  // case falls back to the first ready artifact.
  if (artifactId) {
    return safeList(item?.artifacts).find((artifact) => artifact?.id === artifactId) || null;
  }
  return firstReadyArtifact(item);
}

function EmptyWorkState({ missing }) {
  return html`
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="v2-page-entrance flex-1 p-4 sm:p-6">
        <div
          className="mx-auto flex min-h-[60vh] max-w-2xl flex-col items-center justify-center text-center"
        >
          <div
            className="grid h-12 w-12 place-items-center rounded-[14px] border border-[color-mix(in_srgb,var(--v2-gold)_34%,var(--v2-panel-border))] bg-[var(--v2-gold-soft)] text-[var(--v2-gold-text)]"
          >
            <${Icon} name="file" className="h-5 w-5" />
          </div>
          <h1 className="mt-5 text-2xl font-semibold text-[var(--v2-text-strong)]">
            ${missing ? 'Saved work not found' : 'No saved work yet'}
          </h1>
          <p className="mt-2 max-w-md text-sm leading-6 text-[var(--v2-text-muted)]">
            ${missing
              ? 'That saved artifact is no longer in this desktop profile.'
              : 'Generated documents you save from chat will appear here with copy and export controls.'}
          </p>
          <div className="mt-6">
            <${Button} as=${Link} to="/chat" variant="primary">Back to chat<//>
          </div>
        </div>
      </div>
    </div>
  `;
}

function WorkExportActions({ item, artifact }) {
  const [busy, setBusy] = React.useState('');
  const content = artifactTextContent(artifact);
  const title = artifact?.title || item?.title || 'IronClaw work product';
  const stem = fileStem(title);
  const originalBlob = buildGeneratedFileBlob(artifact);
  const originalFilename =
    artifact?.filename || `${stem}.${generatedFileKindLabel(artifact).toLowerCase()}`;

  const run = async (label, action) => {
    setBusy(label);
    try {
      await action();
      toast(`${label} ready`, { tone: 'success' });
    } catch {
      toast(`Could not ${label.toLowerCase()}`, { tone: 'error' });
    } finally {
      setBusy('');
    }
  };

  // Mobile-first tap-target floor (>=44px at 390px): these export controls were
  // 36px. The shared app shell, palette, and connectors already enforce a 44px
  // floor at 390px (keyboard-static.spec.ts); the saved-work controls now match.
  const actionClass =
    'inline-flex min-h-[44px] items-center gap-2 rounded-[8px] border border-[var(--v2-panel-border)] bg-[var(--v2-card-bg)] px-3 text-sm font-medium text-[var(--v2-text)] hover:border-[color-mix(in_srgb,var(--v2-accent)_36%,var(--v2-panel-border))] hover:text-[var(--v2-text-strong)] disabled:opacity-60';

  return html`
    <div className="flex flex-wrap gap-2">
      ${originalBlob &&
      html`<button
        type="button"
        className=${actionClass}
        disabled=${Boolean(busy)}
        onClick=${() => run('Save original', () => saveBlob(originalBlob, originalFilename))}
      >
        <${Icon} name="download" className="h-4 w-4" />
        ${busy === 'Save original' ? 'Saving...' : 'Save original'}
      </button>`}
      ${content &&
      html`<button
        type="button"
        className=${actionClass}
        disabled=${Boolean(busy)}
        onClick=${() => run('Copy', () => copyWorkProduct(content))}
      >
        <${Icon} name="copy" className="h-4 w-4" />
        ${busy === 'Copy' ? 'Copying...' : 'Copy'}
      </button>`}
      ${(content
        ? [
            ['Markdown', 'download', () => downloadMarkdown(content, `${stem}.md`)],
            ['DOCX', 'download', () => downloadDocx(content, `${stem}.docx`)],
            ['PDF', 'download', () => downloadPdf(content, `${stem}.pdf`)],
            ['HTML', 'download', () => downloadHtml(content, `${stem}.html`)],
            // JSON export only when there is text content; for binary artifacts
            // (content === '') it would write a hollow file, so those rely on
            // the "Save original" control above to preserve the real bytes.
            [
              'JSON',
              'download',
              () =>
                downloadJson(
                  {
                    role: 'assistant',
                    content,
                    attachments: [
                      {
                        kind: 'work_item',
                        item_id: item?.id,
                        artifact_id: artifact?.id,
                        title,
                        filename: artifact?.filename || null,
                        mime_type: artifact?.mime_type || null,
                        size: artifact?.size || null
                      }
                    ]
                  },
                  `${stem}.json`
                )
            ]
          ]
        : []
      ).map(
        ([label, icon, action]) => html`
          <button
            key=${label}
            type="button"
            className=${actionClass}
            disabled=${Boolean(busy)}
            onClick=${() => run(`Export ${label}`, action)}
          >
            <${Icon} name=${icon} className="h-4 w-4" />
            ${label}
          </button>
        `
      )}
    </div>
  `;
}

function artifactTextContent(artifact) {
  return String(artifact?.content || textPreviewForGeneratedFileArtifact(artifact) || '');
}

function SavedFileArtifactPreview({ artifact }) {
  const kind = generatedFileKindLabel(artifact);
  return html`
    <div
      className="rounded-[12px] border border-dashed border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] p-6 text-sm"
      data-testid="saved-work-file-artifact"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <span
          className="grid h-11 w-11 shrink-0 place-items-center rounded-[12px] border border-[color-mix(in_srgb,var(--v2-gold)_34%,var(--v2-panel-border))] bg-[var(--v2-gold-soft)] text-[var(--v2-gold-text)]"
        >
          <${Icon} name="file" className="h-5 w-5" />
        </span>
        <span className="min-w-[12rem] flex-1">
          <span
            className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--v2-gold-text)]"
          >
            ${kind} file artifact
          </span>
          <span className="block truncate text-base font-semibold text-[var(--v2-text-strong)]">
            ${artifact?.filename || artifact?.title || 'Generated file'}
          </span>
          <span className="block truncate text-xs text-[var(--v2-text-muted)]">
            ${artifact?.mime_type || 'application/octet-stream'}
            ${artifact?.size_label ? ` · ${artifact.size_label}` : ''}
          </span>
        </span>
      </div>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-[var(--v2-text-muted)]">
        Preview is not available for this binary file in the local reader. The original bytes are
        retained and can be saved from the controls above.
      </p>
    </div>
  `;
}

const WORK_LIST_VISIBLE_LIMIT = 30;

// Trust Ledger: a cross-matter, reverse-chron stream of saved-work events and the
// agent receipts behind them. Honest by construction — device-local, saved-work
// scope, stated plainly. Each row links to its matter.
function WorkActivityLedger({ items }) {
  const ledger = buildWorkLedger(items);
  return html`
    <div className="space-y-3" data-testid="work-activity-ledger">
      <p
        className="rounded-[10px] border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] px-3 py-2 text-xs leading-5 text-[var(--v2-text-muted)]"
      >
        A device-local record of work you have saved and the actions behind it. A full server-side
        audit log is not available on this gateway yet.
      </p>
      ${ledger.length === 0
        ? html`<p className="px-1 py-2 text-sm text-[var(--v2-text-muted)]">
            No activity recorded yet.
          </p>`
        : html`<ol className="grid gap-1.5">
            ${ledger.map(
              (entry) => html`
                <li key=${entry.id}>
                  <${Link}
                    to=${workArtifactHref(entry.matterId, entry.artifactId)}
                    className="grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-[8px] border border-transparent px-2 py-2 hover:border-[var(--v2-panel-border)] hover:bg-[var(--v2-surface-soft)]"
                  >
                    <span
                      className=${`grid h-7 w-7 shrink-0 place-items-center rounded-[7px] ${
                        entry.kind === 'saved'
                          ? 'border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] text-[var(--v2-text-faint)]'
                          : 'border border-[color-mix(in_srgb,var(--v2-gold)_30%,var(--v2-panel-border))] bg-[var(--v2-gold-soft)] text-[var(--v2-gold-text)]'
                      }`}
                    >
                      <${Icon}
                        name=${entry.kind === 'saved' ? 'file' : 'bolt'}
                        className="h-3.5 w-3.5"
                      />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-[var(--v2-text-strong)]">
                        ${entry.kind === 'saved' ? `Saved ${entry.label}` : entry.label}
                      </span>
                      <span className="block truncate text-xs text-[var(--v2-text-faint)]">
                        ${entry.kind === 'saved'
                          ? 'Work product'
                          : `in ${entry.matter}`}${entry.status ? ` · ${entry.status}` : ''}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-[var(--v2-text-faint)]">
                      ${entry.kind === 'saved' ? readableDate(entry.timestamp) : ''}
                    </span>
                  <//>
                </li>
              `
            )}
          </ol>`}
    </div>
  `;
}

export function WorkPage() {
  const [params] = useSearchParams();
  const [items, setItems] = React.useState(() => readSavedWorkItems());
  // The saved-work store holds up to 500 items; without a filter + expander the
  // sidebar list hard-capped at 30 and everything older was unreachable.
  const [workFilter, setWorkFilter] = React.useState('');
  const [showAllWork, setShowAllWork] = React.useState(false);
  // 'saved' = per-matter reader; 'activity' = the cross-matter Trust Ledger.
  const [view, setView] = React.useState('saved');

  React.useEffect(() => {
    setItems(readSavedWorkItems());
  }, []);

  const requestedItemId = params.get('item') || '';
  const requestedArtifactId = params.get('artifact') || '';
  const selectedItem =
    items.find((item) => item?.id === requestedItemId) || (!requestedItemId ? items[0] : null);
  const selectedArtifact = findArtifact(selectedItem, requestedArtifactId);
  // "missing" = a deep link pointed at something that no longer resolves: an
  // item id with no matching item, or an artifact id with no matching artifact.
  // Either way we show the "not found" state instead of substituting a doc.
  const missing = Boolean(
    (requestedItemId && !selectedItem) || (requestedArtifactId && !selectedArtifact)
  );

  if (!items.length || missing || !selectedItem || !selectedArtifact) {
    return html`<${EmptyWorkState} missing=${missing} />`;
  }

  const content = artifactTextContent(selectedArtifact);
  const linkedThread = safeList(selectedItem.links).find((link) => link?.kind === 'thread');
  const provenance = safeList(selectedArtifact.provenance).join(', ') || 'chat';
  // Dossier provenance captured at save time (work-product-save.dossierFromMessages):
  // the original ask + the receipts of what the agent actually did.
  const askEntry = safeList(selectedItem.dossier).find((entry) => entry?.kind === 'ask');
  const receipts = safeList(selectedItem.receipts);

  // Filter by title, then page: show the first N and let the user expand the
  // rest so saved work past the 30th item is always reachable (search finds it
  // even unexpanded).
  const filterQuery = workFilter.trim();
  // Title + body search: match the query against each item's title and artifact
  // text, keeping a one-line snippet for body-only hits so saved work is findable
  // by content, not just name.
  const searchResults = filterQuery
    ? items
        .map((item) => ({ item, ...workItemSearchMatch(item, filterQuery) }))
        .filter((r) => r.match)
    : null;
  const filteredItems = searchResults ? searchResults.map((r) => r.item) : items;
  const snippetById = new Map(
    (searchResults || []).filter((r) => r.snippet).map((r) => [r.item.id, r.snippet])
  );
  const visibleItems = showAllWork
    ? filteredItems
    : filteredItems.slice(0, WORK_LIST_VISIBLE_LIMIT);
  const hiddenItemCount = filteredItems.length - visibleItems.length;

  return html`
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="v2-page-entrance flex-1 p-4 sm:p-6">
        <div
          className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[320px_minmax(0,1fr)]"
        >
          <aside
            className="h-fit rounded-[14px] border border-[var(--v2-panel-border)] bg-[var(--v2-card-bg)] p-3 shadow-[var(--v2-card-shadow)]"
            aria-label="Saved work"
          >
            <div className="px-2 py-2">
              <div
                className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--v2-text-faint)]"
              >
                Saved work
              </div>
              <p className="mt-1 text-sm leading-5 text-[var(--v2-text-muted)]">
                Local artifacts saved from chat.
              </p>
            </div>
            ${items.length > 8 &&
            html`<div className="relative mb-1 px-2">
              <span
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--v2-text-faint)]"
              >
                <${Icon} name="search" className="h-3.5 w-3.5" />
              </span>
              <input
                type="text"
                aria-label="Search saved work"
                value=${workFilter}
                onInput=${(event) => {
                  setWorkFilter(event.currentTarget.value);
                  setShowAllWork(false);
                }}
                placeholder="Search saved work…"
                className="h-9 min-h-[44px] w-full rounded-[8px] border border-[var(--v2-panel-border)] bg-[var(--v2-input-bg)] pl-8 pr-2 text-[13px] text-[var(--v2-text-strong)] outline-none placeholder:text-[var(--v2-text-faint)] focus:border-[var(--v2-accent)]"
              />
            </div>`}
            <div className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-1">
              ${visibleItems.map((item) => {
                const artifact = firstReadyArtifact(item);
                const href = artifact ? workArtifactHref(item.id, artifact.id) : '/work';
                const active = item.id === selectedItem.id;
                const snippet = snippetById.get(item.id);
                return html`
                  <${Link}
                    key=${item.id}
                    to=${href}
                    className=${[
                      'rounded-[10px] border px-3 py-3 text-left text-sm transition',
                      active
                        ? 'border-[color-mix(in_srgb,var(--v2-accent)_45%,var(--v2-panel-border))] bg-[var(--v2-accent-soft)] text-[var(--v2-text-strong)]'
                        : 'border-transparent text-[var(--v2-text-muted)] hover:border-[var(--v2-panel-border)] hover:bg-[var(--v2-surface-soft)] hover:text-[var(--v2-text)]'
                    ].join(' ')}
                  >
                    <span className="block truncate font-semibold">
                      ${item.title || 'Untitled work'}
                    </span>
                    <span className="mt-1 block text-xs text-[var(--v2-text-faint)]">
                      ${readableDate(item.updated_at || item.created_at)}
                    </span>
                    ${snippet &&
                    html`<span
                      className="mt-1 block text-xs leading-5 text-[var(--v2-text-muted)] line-clamp-2"
                      >${snippet}</span
                    >`}
                  <//>
                `;
              })}
            </div>
            ${filteredItems.length === 0 &&
            html`<p className="px-3 py-3 text-xs text-[var(--v2-text-faint)]">
              No saved work matches “${workFilter.trim()}”.
            </p>`}
            ${hiddenItemCount > 0 &&
            html`<button
              type="button"
              onClick=${() => setShowAllWork(true)}
              className="mt-1 inline-flex min-h-[44px] w-full items-center justify-center rounded-[8px] border border-[var(--v2-panel-border)] px-3 text-xs font-medium text-[var(--v2-accent-text)] hover:bg-[var(--v2-surface-soft)]"
            >
              Show all ${filteredItems.length}
            </button>`}
          </aside>

          <article
            className="min-w-0 rounded-[14px] border border-[var(--v2-panel-border)] bg-[var(--v2-card-bg)] shadow-[var(--v2-card-shadow)]"
          >
            <div
              className="border-b border-[var(--v2-panel-border)] px-5 py-4 sm:flex sm:items-start sm:justify-between sm:gap-4"
            >
              <div className="min-w-0">
                <div
                  className="flex flex-wrap items-center gap-2 text-xs text-[var(--v2-text-muted)]"
                >
                  ${
                    /* Gold = the agent's hand (DESIGN.md color meaning). A saved
                    work product is generated agent work, so the header badge is
                    gold to match the "Generated document" chip in chat and the
                    file-artifact preview below — not success-green, which is a
                    status this surface cannot prove and read inconsistently
                    against the gold body chip. */ ''
                  }
                  <span
                    className="rounded-full border border-[color-mix(in_srgb,var(--v2-gold)_34%,var(--v2-panel-border))] bg-[var(--v2-gold-soft)] px-2 py-1 text-[var(--v2-gold-text)]"
                  >
                    ${selectedArtifact.type === 'file' || selectedArtifact.data_base64
                      ? `${generatedFileKindLabel(selectedArtifact)} artifact`
                      : 'Generated artifact'}
                  </span>
                  <span>${readableDate(selectedItem.updated_at || selectedItem.created_at)}</span>
                  <span>Source: ${provenance}</span>
                </div>
                <h1 className="mt-3 truncate text-xl font-semibold text-[var(--v2-text-strong)]">
                  ${selectedArtifact.title || selectedItem.title || 'Saved work product'}
                </h1>
                <p className="mt-1 text-sm leading-6 text-[var(--v2-text-muted)]">
                  ${selectedItem.objective || 'Saved work product from chat.'}
                </p>
              </div>
              <div className="mt-4 flex shrink-0 gap-2 sm:mt-0">
                ${linkedThread?.ref
                  ? html`
                      <${Button}
                        as=${Link}
                        to=${`/chat/${encodeURIComponent(linkedThread.ref)}`}
                        variant="secondary"
                        className="min-h-[44px]"
                      >
                        Open thread
                      <//>
                    `
                  : html`<${Button}
                      as=${Link}
                      to="/chat"
                      variant="secondary"
                      className="min-h-[44px]"
                    >
                      Back to chat
                    <//>`}
              </div>
            </div>

            <div className="space-y-5 px-5 py-5">
              <div
                role="group"
                aria-label="Work view"
                className="inline-flex rounded-[10px] border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] p-0.5"
              >
                ${['saved', 'activity'].map(
                  (mode) =>
                    html`<button
                      key=${mode}
                      type="button"
                      aria-pressed=${view === mode}
                      onClick=${() => setView(mode)}
                      className=${[
                        'min-h-[44px] rounded-[8px] px-3 text-sm font-medium',
                        view === mode
                          ? 'bg-[var(--v2-accent-soft)] text-[var(--v2-accent-text)]'
                          : 'text-[var(--v2-text-muted)] hover:text-[var(--v2-text-strong)]'
                      ].join(' ')}
                    >
                      ${mode === 'saved' ? 'Saved' : 'Activity'}
                    </button>`
                )}
              </div>
              ${view === 'activity'
                ? html`<${WorkActivityLedger} items=${items} />`
                : html`
                    <${WorkExportActions} item=${selectedItem} artifact=${selectedArtifact} />
                    ${askEntry?.text &&
                    html`<section
                      className="rounded-[12px] border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] px-4 py-3"
                      data-testid="dossier-ask"
                    >
                      <div
                        className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--v2-text-faint)]"
                      >
                        The ask
                      </div>
                      <p
                        className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-[var(--v2-text)]"
                      >
                        ${askEntry.text}
                      </p>
                    </section>`}
                    ${receipts.length > 0 &&
                    html`<section
                      className="rounded-[12px] border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] px-4 py-3"
                      data-testid="dossier-receipts"
                    >
                      <div
                        className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--v2-text-faint)]"
                      >
                        What IronClaw did
                      </div>
                      <ul className="mt-2 grid gap-1.5">
                        ${receipts.map(
                          (receipt, index) => html`
                            <li
                              key=${index}
                              className="grid grid-cols-[auto_1fr] items-baseline gap-2 text-sm"
                            >
                              <span
                                className="grid h-6 w-6 place-items-center rounded-[6px] border border-[color-mix(in_srgb,var(--v2-gold)_30%,var(--v2-panel-border))] bg-[var(--v2-gold-soft)] text-[var(--v2-gold-text)]"
                              >
                                <${Icon} name="bolt" className="h-3.5 w-3.5" />
                              </span>
                              <span className="min-w-0">
                                <span className="font-medium text-[var(--v2-text-strong)]"
                                  >${receipt.label}</span
                                >${receipt.status
                                  ? html`<span className="ml-2 text-xs text-[var(--v2-text-faint)]"
                                      >${receipt.status}</span
                                    >`
                                  : ''}
                                ${receipt.detail
                                  ? html`<span
                                      className="mt-0.5 block truncate text-xs text-[var(--v2-text-muted)]"
                                      title=${receipt.detail}
                                      >${receipt.detail}</span
                                    >`
                                  : ''}
                              </span>
                            </li>
                          `
                        )}
                      </ul>
                    </section>`}
                    <div
                      className="rounded-[12px] border border-[var(--v2-panel-border)] bg-[var(--v2-canvas)] p-4 sm:p-6"
                      data-testid="saved-work-artifact"
                    >
                      ${content
                        ? html`<${MarkdownRenderer}
                            content=${content}
                            className="max-w-none text-[14px] leading-7 text-[var(--v2-text)]"
                          />`
                        : html`<${SavedFileArtifactPreview} artifact=${selectedArtifact} />`}
                    </div>
                  `}
            </div>
          </article>
        </div>
      </div>
    </div>
  `;
}
