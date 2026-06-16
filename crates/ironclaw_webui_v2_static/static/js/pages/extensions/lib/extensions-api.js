// Extensions surface:
// - The browser talks only to `/api/webchat/v2/extensions/*` endpoints.
// - The v2 backend owns the registry/list/install/activate/remove/setup
//   projection and maps those operations to the extension registry.
// - Lifecycle routes take the canonical bare extension id (e.g. `gmail`,
//   `google-calendar`, `slack`, `notion`) in the path. The backend catalog
//   keys extensions by that dash-cased name, so `canonicalExtensionName`
//   strips any `kind/id` catalog prefix and dash-cases the leaf before it
//   crosses the wire. Install keeps the full `package_ref` in the body.

import { apiFetch, setupExtension } from "../../../lib/api.js";
import { buildCustomMcpInstallPayload } from "./custom-mcp.js";

export function fetchExtensions() {
  return apiFetch("/api/webchat/v2/extensions");
}
export function fetchExtensionRegistry() {
  return apiFetch("/api/webchat/v2/extensions/registry");
}
export function installExtension(packageRef) {
  return apiFetch("/api/webchat/v2/extensions/install", {
    method: "POST",
    body: JSON.stringify({ package_ref: packageRef }),
  });
}
export function installCustomMcpServer(input) {
  return apiFetch("/api/webchat/v2/extensions/install", {
    method: "POST",
    body: JSON.stringify(buildCustomMcpInstallPayload(input)),
  });
}
export function activateExtension(packageRef) {
  return apiFetch(
    `/api/webchat/v2/extensions/${encodeURIComponent(canonicalExtensionName(packageRef))}/activate`,
    {
      method: "POST",
    }
  );
}
export function removeExtension(packageRef) {
  return apiFetch(
    `/api/webchat/v2/extensions/${encodeURIComponent(canonicalExtensionName(packageRef))}/remove`,
    {
      method: "POST",
    }
  );
}
export function fetchExtensionSetup(packageRef) {
  return apiFetch(
    `/api/webchat/v2/extensions/${encodeURIComponent(canonicalExtensionName(packageRef))}/setup`
  );
}
export function submitExtensionSetup(packageRef, secrets, fields) {
  return setupExtension(canonicalExtensionName(packageRef), {
    action: "configure",
    payload: { secrets, fields },
  });
}
export function startExtensionOauth(packageRef, secret) {
  const setup = secret?.setup || {};
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  return apiFetch(
    `/api/webchat/v2/extensions/${encodeURIComponent(canonicalExtensionName(packageRef))}/setup/oauth/start`,
    {
      method: "POST",
      body: JSON.stringify({
        provider: secret.provider,
        account_label: setup.account_label || `${secret.provider} credential`,
        scopes: setup.scopes || [],
        expires_at: expiresAt,
        invocation_id: setup.invocation_id,
      }),
    }
  );
}
export function fetchPairingRequests() {
  return Promise.resolve({ requests: [] });
}
export function approvePairingCode() {
  return Promise.resolve({
    success: false,
    message: "Pairing requires a v2 pairing endpoint.",
  });
}

function packageId(packageRef) {
  const id = typeof packageRef === "string" ? packageRef : packageRef?.id;
  if (!id) {
    throw new Error("Extension package_ref is required");
  }
  return id;
}

export function canonicalExtensionName(packageRef) {
  const id = packageId(packageRef).trim();
  const catalogName = id.includes("/") ? id.split("/").filter(Boolean).pop() : id;
  if (!catalogName) {
    throw new Error("Extension package_ref is required");
  }
  const normalized = catalogName.replaceAll("_", "-");
  if (normalized === "slack-tool") return "slack";
  return normalized;
}
