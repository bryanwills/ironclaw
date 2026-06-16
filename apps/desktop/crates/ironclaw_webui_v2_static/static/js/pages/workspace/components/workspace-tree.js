import { useQuery } from '@tanstack/react-query';
import { html } from '../../../lib/html.js';
import { useT } from '../../../lib/i18n.js';
import { StatusPill } from '../../../design-system/primitives.js';
import { listWorkspace } from '../lib/workspace-api.js';
import { snippetFor } from '../lib/workspace-presenters.js';

function isUiHiddenWorkspacePath(path = '') {
  return String(path)
    .split('/')
    .some((segment) => segment.startsWith('.'));
}

// Calm, non-animated skeleton rows. Reuses the shared `.v2-skeleton` primitive
// so loading reads as reserved structure rather than raw "Loading…" text, and
// reveals the real rows without shifting layout.
function TreeSkeleton({ rows = 4, indent = 0 }) {
  return html`<div className="space-y-1 py-1" aria-hidden="true">
    ${Array.from({ length: rows }, (_, i) => i).map(
      (i) =>
        html`<div
          key=${i}
          className="v2-skeleton h-8 rounded-md"
          style=${{ marginLeft: `${indent}px` }}
        />`
    )}
  </div>`;
}

function TreeNode({ entry, depth, selectedPath, expandedPaths, onToggleDirectory, onSelectFile }) {
  const isExpanded = expandedPaths.has(entry.path);
  const childQuery = useQuery({
    queryKey: ['workspace-list', entry.path],
    queryFn: () => listWorkspace(entry.path),
    enabled: entry.is_dir && isExpanded
  });

  if (entry.is_dir) {
    return html`
      <div>
        <button
          type="button"
          onClick=${() => onToggleDirectory(entry.path)}
          className="flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 text-left text-sm text-[var(--v2-text-muted)] hover:bg-[var(--v2-surface-soft)] hover:text-[var(--v2-text-strong)]"
          style=${{ paddingLeft: `${8 + depth * 16}px` }}
          aria-expanded=${isExpanded}
        >
          <span className=${['w-3 text-[10px]', isExpanded ? 'rotate-90' : ''].join(' ')}>></span>
          <span className="min-w-0 truncate font-semibold">${entry.name}</span>
        </button>
        ${isExpanded &&
        html`
          <div className="space-y-1">
            ${childQuery.isLoading
              ? html`<${TreeSkeleton} rows=${3} indent=${(depth + 1) * 16 + 8} />`
              : (childQuery.data?.entries || [])
                  .filter((child) => !isUiHiddenWorkspacePath(child.path))
                  .map(
                    (child) => html`
                      <${TreeNode}
                        key=${child.path}
                        entry=${child}
                        depth=${depth + 1}
                        selectedPath=${selectedPath}
                        expandedPaths=${expandedPaths}
                        onToggleDirectory=${onToggleDirectory}
                        onSelectFile=${onSelectFile}
                      />
                    `
                  )}
          </div>
        `}
      </div>
    `;
  }

  return html`
    <button
      type="button"
      onClick=${() => onSelectFile(entry.path)}
      className=${[
        'flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 text-left text-sm',
        selectedPath === entry.path
          ? 'bg-[var(--v2-accent-soft)] text-[var(--v2-accent-text)]'
          : 'text-[var(--v2-text-muted)] hover:bg-[var(--v2-surface-soft)] hover:text-[var(--v2-text-strong)]'
      ].join(' ')}
      style=${{ paddingLeft: `${24 + depth * 16}px` }}
    >
      <span className="min-w-0 truncate">${entry.name}</span>
    </button>
  `;
}

export function WorkspaceTree({
  entries,
  selectedPath,
  expandedPaths,
  onToggleDirectory,
  onSelectFile,
  isLoading
}) {
  const t = useT();
  if (isLoading) {
    return html`<div className="p-3"><${TreeSkeleton} rows=${4} /></div>`;
  }

  const visibleEntries = entries.filter((entry) => !isUiHiddenWorkspacePath(entry.path));

  if (!visibleEntries.length) {
    return html`<div className="px-4 py-8 text-sm text-[var(--v2-text-muted)]">
      ${t('workspace.noFiles')}
    </div>`;
  }

  return html`
    <div className="space-y-1 p-2">
      ${visibleEntries.map(
        (entry) => html`
          <${TreeNode}
            key=${entry.path}
            entry=${entry}
            depth=${0}
            selectedPath=${selectedPath}
            expandedPaths=${expandedPaths}
            onToggleDirectory=${onToggleDirectory}
            onSelectFile=${onSelectFile}
          />
        `
      )}
    </div>
  `;
}

export function WorkspaceSearchResults({ results, query, onSelectFile, isSearching }) {
  const t = useT();
  if (isSearching) {
    return html`<div className="space-y-2 p-2">
      <${TreeSkeleton} rows=${3} />
    </div>`;
  }

  const visibleResults = results.filter((result) => !isUiHiddenWorkspacePath(result.path));

  if (!visibleResults.length) {
    return html`<div className="p-4 text-sm text-[var(--v2-text-muted)]">
      ${t('workspace.noResults')}
    </div>`;
  }

  return html`
    <div className="space-y-2 p-2">
      ${visibleResults.map(
        (result) => html`
          <button
            key=${result.path}
            type="button"
            onClick=${() => onSelectFile(result.path)}
            className="w-full rounded-md border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] p-3 text-left hover:border-[color-mix(in_srgb,var(--v2-accent)_35%,var(--v2-panel-border))] hover:bg-[var(--v2-surface-muted)]"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 truncate font-mono text-xs text-[var(--v2-accent-text)]">
                ${result.path}
              </div>
              <${StatusPill} tone="muted" label=${Number(result.score || 0).toFixed(2)} />
            </div>
            <div className="mt-2 line-clamp-2 text-xs leading-5 text-[var(--v2-text-muted)]">
              ${snippetFor(result.content, query)}
            </div>
          </button>
        `
      )}
    </div>
  `;
}
