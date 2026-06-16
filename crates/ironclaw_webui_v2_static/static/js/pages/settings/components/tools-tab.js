import { Icon } from "../../../design-system/icons.js";
import { Badge } from "../../../design-system/badge.js";
import { Card } from "../../../design-system/card.js";
import { html } from "../../../lib/html.js";
import { useT } from "../../../lib/i18n.js";
import { useTools } from "../hooks/useTools.js";
import { matchesSearch } from "../lib/settings-search.js";

function ToolRow({ tool, onPermissionChange, isSaved, canEdit }) {
  const t = useT();
  const permissionStates = [
    { value: "always_allow", label: t("tools.alwaysAllow"), tone: "positive" },
    { value: "ask", label: t("tools.askEachTime"), tone: "warning" },
    { value: "disabled", label: t("tools.disabled"), tone: "danger" },
  ];

  // A locked tool, or any tool when the gateway has no v2 tools-write endpoint
  // (canEdit:false), shows its permission as a read-only badge. Rendering an
  // editable select whose change silently fails to persist is fake readiness.
  const isLocked = tool.locked || !canEdit;
  const current =
    permissionStates.find((p) => p.value === tool.state) || permissionStates[1];
  const isDefault = tool.state === tool.default_state;

  return html`
    <div
      className="flex items-center justify-between gap-4 border-t border-[var(--v2-panel-border)] py-3.5 first:border-0 first:pt-0"
    >
      <div className="flex min-w-0 items-center gap-3">
        ${isLocked &&
        html`<${Icon}
          name="lock"
          className="h-3.5 w-3.5 shrink-0 text-[var(--v2-text-faint)]"
        />`}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-sm text-[var(--v2-text)]"
              >${tool.name}</span
            >
            ${isDefault &&
            html`
              <span
                className="rounded border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--v2-text-faint)]"
              >
                ${t("tools.default")}
              </span>
            `}
          </div>
          ${tool.description &&
          html`
            <div className="mt-0.5 truncate text-xs text-[var(--v2-text-muted)]">
              ${tool.description}
            </div>
          `}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        ${isLocked
          ? html`<${Badge} tone=${current.tone} label=${current.label} size="sm" />`
          : html`
              <select
                value=${tool.state}
                onChange=${(e) => onPermissionChange(tool.name, e.target.value)}
                aria-label=${t("tools.permissionFor", { name: tool.name })}
                className="v2-select h-8 rounded-md border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] px-2.5 font-mono text-xs text-[var(--v2-text-strong)] outline-none focus:border-[color-mix(in_srgb,var(--v2-accent)_45%,var(--v2-panel-border))]"
              >
                ${permissionStates.map(
                  (p) =>
                    html`<option key=${p.value} value=${p.value}>
                      ${p.label}
                    </option>`
                )}
              </select>
            `}
        ${isSaved &&
        html`
          <span className="font-mono text-[11px] text-[var(--v2-accent-text)]"
            >${t("tools.saved")}</span
          >
        `}
      </div>
    </div>
  `;
}

export function ToolsTab({ searchQuery = "" }) {
  const t = useT();
  const { tools, query, status, setPermission, savedTools } = useTools();

  // No v2 tools-write endpoint exists yet (useTools status:'todo'): permission
  // changes resolve against a stub that never persists. Gate the editable
  // controls behind a real backend so the rows present as read-only instead of
  // implying a capability the gateway cannot prove ("No fake readiness").
  const canEdit = status !== 'todo';

  if (query.isLoading) {
    return html`
      <${Card} padding="md">
        <div className="v2-skeleton mb-4 h-3 w-28 rounded" />
        ${[1, 2, 3, 4, 5].map(
          (i) => html`
            <div
              key=${i}
              className="flex items-center justify-between border-t border-[var(--v2-panel-border)] py-3.5 first:border-0"
            >
              <div className="v2-skeleton h-4 w-36 rounded" />
              <div className="v2-skeleton h-8 w-28 rounded" />
            </div>
          `
        )}
      <//>
    `;
  }

  if (query.error) {
    return html`
      <${Card} padding="md">
        <p className="text-sm text-[var(--v2-danger-text)]">
          ${t("tools.failedLoad", { message: query.error.message })}
        </p>
      <//>
    `;
  }

  const filtered = tools.filter((tool) =>
    matchesSearch(searchQuery, [
      tool.name,
      tool.description,
      tool.state,
      tool.default_state,
      tool.locked ? t("tools.disabled") : "",
    ])
  );

  return html`
    <div className="space-y-4">
      ${searchQuery &&
      html`
        <div className="flex justify-end">
          <span className="font-mono text-[11px] text-[var(--v2-text-faint)]">
            ${filtered.length} / ${tools.length}
          </span>
        </div>
      `}

      <${Card} padding="md">
        <h3
          className="mb-4 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--v2-accent-text)]"
        >
          ${t("tools.permissions")}
        </h3>
        ${filtered.length === 0
          ? html`<p className="py-4 text-sm text-[var(--v2-text-muted)]">
              ${t("tools.noMatch")}
            </p>`
          : filtered.map(
              (tool) =>
                html`
                  <${ToolRow}
                    key=${tool.name}
                    tool=${tool}
                    canEdit=${canEdit}
                    onPermissionChange=${setPermission}
                    isSaved=${savedTools[tool.name]}
                  />
                `
            )}
      <//>
    </div>
  `;
}
