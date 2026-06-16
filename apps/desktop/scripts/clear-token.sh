#!/usr/bin/env bash
# Remove a staged file-fallback token. Counterpart to stage-token.sh.
#
# Usage:
#   bash scripts/clear-token.sh <profile-id>
#   bash scripts/clear-token.sh default     # nukes gateway-token:default
#   bash scripts/clear-token.sh --all       # nukes every token file
#
# Why this exists:
# The file fallback at app_data_dir/tokens/ persists across launches
# and survives `cargo clean`. Useful to wipe between dev sessions or
# when handing the machine off (the file is mode 0600 but it is still
# plaintext). Doesn't touch the macOS Keychain — use
# `security delete-generic-password -s com.openclaw.ironclaw-desktop -a 'gateway-token:<id>'`
# for that.

set -euo pipefail

DEST_DIR="${HOME}/Library/Application Support/com.openclaw.ironclaw-desktop/tokens"

if [[ $# -lt 1 ]]; then
  echo "Usage: bash scripts/clear-token.sh <profile-id|--all>" >&2
  echo "Examples:" >&2
  echo "  bash scripts/clear-token.sh default" >&2
  echo "  bash scripts/clear-token.sh --all" >&2
  exit 2
fi

if [[ "$1" == "--all" ]]; then
  if [[ -d "${DEST_DIR}" ]]; then
    count=$(find "${DEST_DIR}" -maxdepth 1 -name '*.token' | wc -l | tr -d ' ')
    if [[ "${count}" -gt 0 ]]; then
      find "${DEST_DIR}" -maxdepth 1 -name '*.token' -delete
      echo "Removed ${count} token file(s) from:"
      echo "  ${DEST_DIR}"
    else
      echo "No token files found in ${DEST_DIR}."
    fi
  else
    echo "Tokens directory does not exist: ${DEST_DIR}"
  fi
  exit 0
fi

PROFILE_ID="$1"
SAFE_ACCOUNT="gateway-token:${PROFILE_ID}"
SAFE_FILE="${SAFE_ACCOUNT//[\/\\.:]/_}.token"
TARGET="${DEST_DIR}/${SAFE_FILE}"

if [[ -f "${TARGET}" ]]; then
  rm -f "${TARGET}"
  echo "Removed: ${TARGET}"
else
  echo "Nothing to remove at: ${TARGET}"
fi
