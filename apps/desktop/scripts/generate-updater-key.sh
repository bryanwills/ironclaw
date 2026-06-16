#!/usr/bin/env bash
#
# Generate the Tauri updater signing keypair for IronClaw Desktop.
#
# Writes the private key to ~/.tauri/ironclaw-updater.key and the public key
# to ~/.tauri/ironclaw-updater.key.pub. Refuses to overwrite an existing key.
#
# After running, the user must:
#   1. Paste the printed pubkey into src-tauri/tauri.conf.json under
#      plugins.updater.pubkey
#   2. Set the GitHub Actions secret TAURI_SIGNING_PRIVATE_KEY to the
#      (base64-encoded) contents of ~/.tauri/ironclaw-updater.key
#   3. Optionally set TAURI_SIGNING_PRIVATE_KEY_PASSWORD if a password was used

set -euo pipefail

KEY_DIR="${HOME}/.tauri"
KEY_PATH="${KEY_DIR}/ironclaw-updater.key"
PUB_PATH="${KEY_PATH}.pub"

# Resolve repo root from this script's location so npm can find the project.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -e "${KEY_PATH}" ]]; then
  echo "ERROR: ${KEY_PATH} already exists." >&2
  echo "Refusing to overwrite an existing signing key." >&2
  echo "" >&2
  echo "If you really want to regenerate, move or delete the old key first:" >&2
  echo "  mv ${KEY_PATH} ${KEY_PATH}.bak-\$(date +%s)" >&2
  echo "  mv ${PUB_PATH} ${PUB_PATH}.bak-\$(date +%s) 2>/dev/null || true" >&2
  exit 1
fi

mkdir -p "${KEY_DIR}"
chmod 700 "${KEY_DIR}"

echo "Generating Tauri updater keypair at ${KEY_PATH}..."
echo "(empty password — re-run later if you want a password)"
echo

# Empty password (-p ""). User can re-run with a password later if they want.
( cd "${REPO_ROOT}" && npm run tauri signer generate -- -w "${KEY_PATH}" -p "" )

if [[ ! -f "${PUB_PATH}" ]]; then
  echo "ERROR: expected ${PUB_PATH} to exist after key generation, but it does not." >&2
  exit 1
fi

chmod 600 "${KEY_PATH}"
chmod 644 "${PUB_PATH}"

PUBKEY="$(cat "${PUB_PATH}")"

echo
echo "==================================================================="
echo " Updater signing keypair generated."
echo "==================================================================="
echo
echo " Public key (paste this into src-tauri/tauri.conf.json):"
echo
echo "   plugins.updater.pubkey = "
echo
printf '%s\n' "${PUBKEY}"
echo
echo "-------------------------------------------------------------------"
echo " Next steps:"
echo
echo " 1. Edit src-tauri/tauri.conf.json and set:"
echo "      \"plugins\": { \"updater\": { \"pubkey\": \"<paste pubkey above>\" } }"
echo
echo " 2. In the GitHub repo settings, add two Actions secrets:"
echo
echo "      TAURI_SIGNING_PRIVATE_KEY"
echo "        Value: contents of ${KEY_PATH}"
echo "        (the file is already base64-encoded by tauri signer generate)"
echo
echo "        Copy with:"
echo "          cat ${KEY_PATH} | pbcopy"
echo
echo "      TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
echo "        Value: empty (this key has no password)"
echo "        If you later regenerate with a password, update this secret."
echo
echo " 3. Commit the tauri.conf.json change and tag a release. The"
echo "    release workflow will sign updater artifacts (.app.tar.gz)."
echo "==================================================================="
