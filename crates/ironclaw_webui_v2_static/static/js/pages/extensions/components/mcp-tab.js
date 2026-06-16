import { React, html } from "../../../lib/html.js";
import { Button } from "../../../design-system/button.js";
import { Card, CardLabel } from "../../../design-system/card.js";
import { FormField, Input } from "../../../design-system/input.js";
import { isDesktopRuntime } from "../../../lib/api.js";
import { appScopedPath } from "../../../lib/app-path.js";
import { useT } from "../../../lib/i18n.js";
import { ExtensionCard, RegistryCard } from "./extension-card.js";
import { validateCustomMcpInput } from "../lib/custom-mcp.js";

function packageId(item) {
  return item.package_ref?.id || "";
}

export function McpTab({
  mcpServers,
  mcpRegistry,
  loadError,
  onActivate,
  onConfigure,
  onRemove,
  onInstall,
  onAddCustom,
  isBusy,
}) {
  const t = useT();
  const isEmpty = mcpServers.length === 0 && mcpRegistry.length === 0;
  // Custom MCP install posts a Reborn `{ name, url, kind: 'mcp_server' }`
  // payload that only the desktop sidecar accepts today. Web has no install
  // route for it, so the card is hidden off the desktop runtime instead of
  // offering an action that would 400 at the gateway.
  const showCustomMcp = isDesktopRuntime();
  return html`
    <div className="space-y-5">
      ${showCustomMcp &&
      html`<${CustomMcpServerCard} onAddCustom=${onAddCustom} isBusy=${isBusy} />`}
      ${isEmpty &&
      html`
        <${Card} variant="bordered" radius="lg" padding="lg">
          <h3 className="text-lg font-semibold text-[var(--v2-text-strong)]">
            ${t("extensions.emptyMcpTitle")}
          </h3>
          <p className="mt-2 max-w-md text-sm leading-6 text-[var(--v2-text-muted)]">
            ${t("extensions.emptyMcpDesc")}
          </p>
          <${Button}
            as="a"
            href=${appScopedPath("/extensions/registry?setup=1&focus=notion")}
            variant="primary"
            size="sm"
            className="mt-4 min-h-[44px] px-3.5"
          >
            ${t("extensions.browseKnowledgeApps")}
          <//>
          ${loadError &&
          html`
            <p className="mt-3 text-sm leading-6 text-[var(--v2-warning-text)]" role="status">
              ${t("extensions.gatewayUnavailable")}
            </p>
          `}
        <//>
      `}
      ${mcpServers.length > 0 &&
      html`
        <${Card} variant="bordered" radius="lg" padding="md">
          <${CardLabel} className="mb-4 text-[var(--v2-accent-text)]"> ${t("mcp.installed")} <//>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            ${mcpServers.map(
              (ext) => html`
                <${ExtensionCard}
                  key=${packageId(ext)}
                  ext=${ext}
                  onActivate=${onActivate}
                  onConfigure=${onConfigure}
                  onRemove=${onRemove}
                  isBusy=${isBusy}
                />
              `
            )}
          </div>
        <//>
      `}
      ${mcpRegistry.length > 0 &&
      html`
        <${Card} variant="bordered" radius="lg" padding="md">
          <${CardLabel} className="mb-4 text-[var(--v2-accent-text)]"> ${t("ext.registry.availableTitle")} <//>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            ${mcpRegistry.map(
              (entry) => html`
                <${RegistryCard}
                  key=${packageId(entry)}
                  entry=${entry}
                  onInstall=${onInstall}
                  isBusy=${isBusy}
                />
              `
            )}
          </div>
        <//>
      `}
    </div>
  `;
}

function CustomMcpServerCard({ onAddCustom, isBusy }) {
  const [name, setName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [errors, setErrors] = React.useState({});
  const preview = React.useMemo(
    () => validateCustomMcpInput({ name, url: url || "https://mcp.example.com/mcp" }),
    [name, url]
  );
  const normalizedName = preview.name;
  const disabledReason = isBusy ? "busy" : !onAddCustom ? "missing-action" : "";
  const fieldsDisabled = Boolean(isBusy);

  const handleSubmit = React.useCallback(
    (event) => {
      event.preventDefault();
      const validated = validateCustomMcpInput({ name, url });
      setErrors(validated.errors);
      if (!validated.ok) return;
      if (!onAddCustom) {
        setErrors({ url: "Connection actions are unavailable in this build." });
        return;
      }
      onAddCustom({ name: validated.name, url: validated.url });
    },
    [name, onAddCustom, url]
  );

  return html`
    <${Card}
      variant="bordered"
      radius="lg"
      padding="md"
      data-testid="custom-mcp-card"
      data-disabled-reason=${disabledReason}
      aria-label="Add custom MCP server"
    >
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <${CardLabel} className="mb-2 text-[var(--v2-accent-text)]"> Custom source <//>
          <h3 className="text-lg font-semibold text-[var(--v2-text-strong)]">
            Add custom MCP server
          </h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--v2-text-muted)]">
            Use an MCP server that does not need sign-in. Sign-in protected custom servers need a
            gateway update before desktop can add them here.
          </p>
        </div>
        ${normalizedName &&
        html`
          <span
            className="inline-flex w-fit rounded-[8px] border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] px-2.5 py-1 font-mono text-[11px] text-[var(--v2-text-muted)]"
          >
            ${normalizedName}
          </span>
        `}
      </div>

      <form
        className="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)_auto]"
        onSubmit=${handleSubmit}
      >
        <${FormField}
          label="Server name"
          htmlFor="custom-mcp-name"
          error=${errors.name}
          hint="Lowercase slug, for example team-docs."
        >
          <${Input}
            id="custom-mcp-name"
            data-testid="custom-mcp-name"
            value=${name}
            placeholder="team-docs"
            disabled=${fieldsDisabled}
            onChange=${(event) => {
              setName(event.target.value);
              if (errors.name) setErrors((prev) => ({ ...prev, name: "" }));
            }}
          />
        <//>
        <${FormField}
          label="MCP URL"
          htmlFor="custom-mcp-url"
          error=${errors.url}
          hint="HTTPS, or localhost HTTP for local development."
        >
          <${Input}
            id="custom-mcp-url"
            data-testid="custom-mcp-url"
            type="url"
            value=${url}
            placeholder="https://mcp.example.com/mcp"
            disabled=${fieldsDisabled}
            onChange=${(event) => {
              setUrl(event.target.value);
              if (errors.url) setErrors((prev) => ({ ...prev, url: "" }));
            }}
          />
        <//>
        <div className="flex items-end">
          <${Button}
            type="submit"
            data-testid="custom-mcp-submit"
            disabled=${fieldsDisabled}
            size="md"
            className="min-h-[44px] w-full lg:w-auto"
          >
            Add MCP server
          <//>
        </div>
      </form>
    <//>
  `;
}
