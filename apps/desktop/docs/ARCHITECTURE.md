# IronClaw Desktop Architecture Notes

## Secret Storage Boundary

IronClaw Desktop stores long-lived user secrets in the macOS Keychain under the
`com.openclaw.ironclaw-desktop` service. The plaintext file fallback under
`app_data_dir/tokens/` exists only for bearer tokens that keep the local desktop
runtime reachable when a macOS Keychain ACL prompt is hidden or hangs.

Allowed file-fallback accounts:

- `gateway-token:<profile-id>`: remote gateway bearer, retained for the known
  keychain prompt wedge.
- `local-gateway-token`: local sidecar bearer. New tokens are written to the
  Keychain first and use the file fallback only when the Keychain write fails or
  times out.

Denied file-fallback accounts:

- `llm-<provider-id>:<profile-id>` provider credentials, including NEAR AI
  session/API-key slots and any advanced provider API keys.
- legacy provider-key names such as `openrouter-key:<profile-id>`.

Threat model:

- A local process that can read the user's app data directory may read files in
  `tokens/`, so provider credentials must never be mirrored there.
- The gateway/local bearer fallback is accepted because losing it can wedge the
  desktop app offline when the Keychain prompt is hidden behind the app or never
  appears in release/dev rebuilds.
- The fallback files are best-effort `0600` and account names are sanitized
  before they become filenames. This is defense-in-depth, not a substitute for
  Keychain storage.
- Secrets must not be written to settings JSON, exported threads, logs, review
  docs, screenshots, or static app state.

Regression guards:

- `cargo test --manifest-path src-tauri/Cargo.toml --lib keychain --locked`
  proves provider credential slots are denied file fallback and that token-file
  names remain sanitized.
- Static tests and copy/security lint must continue to avoid leaking provider
  secrets or bearer values into rendered UI.
