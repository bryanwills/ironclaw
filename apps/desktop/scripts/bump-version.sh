#!/usr/bin/env bash
#
# Bump the IronClaw Desktop version across all three places that must agree:
#   - package.json                    (top-level "version")
#   - src-tauri/tauri.conf.json       (top-level "version")
#   - src-tauri/Cargo.toml            ([package] version)
#
# Usage:
#   bash scripts/bump-version.sh 0.1.3

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <new-version>" >&2
  echo "Example: $0 0.1.3" >&2
  exit 1
fi

NEW_VER="$1"

# Basic semver sanity check: major.minor.patch with optional pre-release/build metadata.
if [[ ! "${NEW_VER}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "ERROR: '${NEW_VER}' does not look like a semver version (e.g. 0.1.3, 1.0.0-beta.1)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PKG_JSON="${REPO_ROOT}/package.json"
TAURI_JSON="${REPO_ROOT}/src-tauri/tauri.conf.json"
CARGO_TOML="${REPO_ROOT}/src-tauri/Cargo.toml"

for f in "${PKG_JSON}" "${TAURI_JSON}" "${CARGO_TOML}"; do
  if [[ ! -f "${f}" ]]; then
    echo "ERROR: expected file not found: ${f}" >&2
    exit 1
  fi
done

# package.json + tauri.conf.json: replace only the FIRST "version": "..." (top-level).
# Using BSD sed -i with a backup suffix, then deleting the backup, for cross-platform safety.
sed -i.bak "s/\"version\":[[:space:]]*\"[^\"]*\"/\"version\": \"${NEW_VER}\"/" "${PKG_JSON}"
sed -i.bak "s/\"version\":[[:space:]]*\"[^\"]*\"/\"version\": \"${NEW_VER}\"/" "${TAURI_JSON}"

# Cargo.toml: only the [package] version line (first 'version = "..."' at start of line).
sed -i.bak "s/^version = \"[^\"]*\"/version = \"${NEW_VER}\"/" "${CARGO_TOML}"

rm -f "${PKG_JSON}.bak" "${TAURI_JSON}.bak" "${CARGO_TOML}.bak"

echo "Version bumped to ${NEW_VER}:"
echo "  - ${PKG_JSON}"
echo "  - ${TAURI_JSON}"
echo "  - ${CARGO_TOML}"
echo
echo "Next: update CHANGELOG.md, commit, then 'git tag v${NEW_VER} && git push --tags'."
