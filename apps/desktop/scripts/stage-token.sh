#!/usr/bin/env bash
# Stage a gateway bearer into the file-fallback slot the Rust keychain
# module reads when the macOS keychain ACL prompt hangs (see v0.2.8
# / R35).
#
# Usage:
#   bash scripts/stage-token.sh <profile-id> <token>
#   bash scripts/stage-token.sh default $(security find-generic-password \
#     -s com.openclaw.ironclaw-desktop -a 'gateway-token:default' -w)
#
# Writes to:
#   ~/Library/Application Support/com.openclaw.ironclaw-desktop/tokens/
#     gateway-token_<profile-id>.token  (mode 0600)
#
# Why this exists:
# Every `cargo build --release` produces a binary with a fresh ad-hoc
# signature. macOS keychain ACL grants are signature-bound — the new
# binary triggers a fresh "Always Allow" prompt, which may be hidden
# behind the app window or never surface in headless test loops. The
# synchronous `keyring::Entry::get_password()` call blocks indefinitely
# in that case, wedging the entire Tauri IPC dispatcher.
#
# The Rust side falls back to this file when the keychain read times
# out (2s) so the app can still authenticate against the gateway.
# Once you ship a real Developer-ID-signed build, the keychain ACL
# becomes stable and this fallback stops being needed for normal use.

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: bash scripts/stage-token.sh <profile-id> <token>" >&2
  echo "Example: bash scripts/stage-token.sh default <64-char-bearer>" >&2
  exit 2
fi

PROFILE_ID="$1"
TOKEN="$2"

# Mirror src-tauri/src/keychain.rs:token_file_path's sanitiser exactly.
# Replace /, \, ., : with _ so the slot can't escape the tokens dir.
SAFE_ACCOUNT="gateway-token:${PROFILE_ID}"
SAFE_FILE="${SAFE_ACCOUNT//[\/\\.:]/_}.token"

DEST_DIR="${HOME}/Library/Application Support/com.openclaw.ironclaw-desktop/tokens"
DEST="${DEST_DIR}/${SAFE_FILE}"

mkdir -p "${DEST_DIR}"
printf '%s' "${TOKEN}" > "${DEST}"
chmod 600 "${DEST}"

echo "Staged ${#TOKEN}-char token at:"
echo "  ${DEST}"
echo
echo "Next steps:"
echo "  1. (Re)launch the .app"
echo "  2. Watch for 'file fallback read OK' in stderr (RUST_LOG=info)"
echo "  3. Status bar should flip to green Connected within ~2s"
