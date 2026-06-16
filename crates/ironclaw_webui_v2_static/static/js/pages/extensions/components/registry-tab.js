import { React, html } from "../../../lib/html.js";
import { useT } from "../../../lib/i18n.js";
import { ExtensionCard, RegistryCard } from "./extension-card.js";

function packageId(item) {
  return item?.package_ref?.id || "";
}

function catalogItem(entry) {
  return entry.entry || entry.extension || {};
}

export function RegistryTab({
  catalogEntries,
  onInstall,
  onActivate,
  onConfigure,
  onRemove,
  isBusy,
}) {
  const t = useT();
  const [filter, setFilter] = React.useState("");
  const query = filter.trim().toLowerCase();

  const filtered = query
    ? catalogEntries.filter((entry) => {
        const item = catalogItem(entry);
        return (
          (item.display_name || packageId(item)).toLowerCase().includes(query) ||
          (item.description || "").toLowerCase().includes(query) ||
          (item.keywords || []).some((kw) =>
            kw.toLowerCase().includes(query)
          )
        );
      })
    : catalogEntries;

  const installedEntries = filtered.filter((entry) => entry.installed && entry.extension);
  const registryOnlyInstalledEntries = filtered.filter(
    (entry) => entry.installed && !entry.extension && entry.entry
  );
  const installedCount = installedEntries.length + registryOnlyInstalledEntries.length;
  const availableEntries = filtered.filter((entry) => !entry.installed && entry.entry);

  if (catalogEntries.length === 0) {
    return html`
      <div className="rounded-[18px] border border-[var(--v2-panel-border)] bg-[var(--v2-card-bg)] p-6 shadow-[var(--v2-shadow-sm)] sm:p-8">
        <h3 className="text-lg font-semibold text-[var(--v2-text-strong)]">
          ${t("ext.registry.emptyTitle")}
        </h3>
        <p className="mt-2 max-w-md text-sm leading-6 text-[var(--v2-text-muted)]">
          ${t("ext.registry.emptyDesc")}
        </p>
      </div>
    `;
  }

  return html`
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input
          type="text"
          value=${filter}
          onChange=${(e) => setFilter(e.target.value)}
          placeholder=${t("ext.registry.searchPlaceholder")}
          className="h-9 flex-1 rounded-md border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] px-3 text-sm text-[var(--v2-text)] outline-none placeholder:text-[var(--v2-text-faint)] focus:border-[var(--v2-accent)]"
        />
        <span className="font-mono text-[11px] text-[var(--v2-text-faint)]">
          ${filtered.length} / ${catalogEntries.length}
        </span>
      </div>

      <div className="rounded-[18px] border border-[var(--v2-panel-border)] bg-[var(--v2-card-bg)] p-5 shadow-[var(--v2-shadow-sm)] sm:p-6">
        ${filtered.length === 0
          ? html`<p className="py-4 text-sm text-[var(--v2-text-muted)]">
              ${t("ext.registry.noMatch")}
            </p>`
          : html`
              ${installedCount > 0 &&
              html`
                <h3
                  className="mb-4 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--v2-accent-text)]"
                >
                  ${t("extensions.installed")}
                </h3>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                  ${installedEntries.map(
                    (entry) => html`
                      <${ExtensionCard}
                        key=${entry.id}
                        ext=${entry.extension || entry.entry}
                        onActivate=${onActivate}
                        onConfigure=${onConfigure}
                        onRemove=${onRemove}
                        isBusy=${isBusy}
                      />
                    `
                  )}
                  ${registryOnlyInstalledEntries.map(
                    (entry) => html`
                      <${RegistryCard}
                        key=${entry.id}
                        entry=${entry.entry}
                        statusLabel=${t("extensions.installed")}
                        isBusy=${isBusy}
                      />
                    `
                  )}
                </div>
              `}

              ${availableEntries.length > 0 &&
              html`
                <h3
                  className=${[
                    "mb-4 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--v2-accent-text)]",
                    installedCount > 0 ? "mt-6" : "",
                  ].join(" ")}
                >
                  ${t("ext.registry.availableTitle")}
                </h3>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                  ${availableEntries.map(
                    (entry) => html`
                      <${RegistryCard}
                        key=${entry.id}
                        entry=${entry.entry}
                        onInstall=${onInstall}
                        isBusy=${isBusy}
                      />
                    `
                  )}
                </div>
              `}
            `}
      </div>
    </div>
  `;
}
