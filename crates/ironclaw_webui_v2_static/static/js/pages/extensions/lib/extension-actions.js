import { isChannelExtensionKind } from "./extensions-schema.js";

export function primaryExtensionAction(ext) {
  const state = extensionLifecycleState(ext);

  if (!ext?.package_ref || state === "active" || state === "ready") {
    return null;
  }

  if (state === "auth_required" || state === "setup_required") {
    return "configure";
  }

  if (ext?.kind === "wasm_channel") {
    return null;
  }

  // Channel-surface kinds in a pairing state hand off to the pairing section;
  // no primary Activate button should appear alongside the dedicated pairing UI.
  if (
    isChannelExtensionKind(ext?.kind) &&
    (state === "pairing_required" || state === "pairing")
  ) {
    return null;
  }

  return "activate";
}

export function extensionLifecycleState(ext) {
  return (
    ext?.onboarding_state ||
    ext?.onboardingState ||
    ext?.activation_status ||
    ext?.activationStatus ||
    (ext?.active ? "active" : "installed")
  );
}

export function extensionIsActive(ext) {
  const state = extensionLifecycleState(ext);
  return state === "active" || state === "ready";
}

export function setupReadyForActivation({ extension, secrets = [], fields = [] } = {}) {
  if (extensionIsActive(extension)) {
    return false;
  }
  if (fields.length > 0 || secrets.length === 0) {
    return false;
  }
  return secrets.every((secret) => secret.provided);
}

// Connector-family classification. Used by the one-click connect flow
// (useConnectExtension) to route Google connectors to the desktop client-id
// setup path instead of a hosted OAuth start the gateway cannot serve.
const GOOGLE_CONNECTORS = new Set([
  "google",
  "gmail",
  "google-calendar",
  "google-drive",
  "google-sheets",
  "google-docs",
  "google-slides",
]);

export function connectorKey(source) {
  const ref = source?.package_ref || source?.packageRef || source;
  const raw =
    (typeof ref === "string" ? ref : ref?.id) ||
    source?.id ||
    source?.display_name ||
    source?.name ||
    "";
  const catalogName = String(raw).includes("/")
    ? String(raw).split("/").filter(Boolean).pop()
    : String(raw);
  const normalized = catalogName.trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "slack-tool") return "slack";
  return normalized;
}

export function connectorFamily(source) {
  const key = connectorKey(source);
  if (GOOGLE_CONNECTORS.has(key)) return "google";
  if (key.includes("notion")) return "notion";
  if (key.includes("slack")) return "slack";
  if (key.includes("workspace") || key.includes("filesystem") || key.includes("file-system")) {
    return "workspace";
  }
  return key;
}

export function isGoogleConnector(source) {
  return connectorFamily(source) === "google";
}
