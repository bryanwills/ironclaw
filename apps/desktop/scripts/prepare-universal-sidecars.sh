#!/usr/bin/env bash
#
# Combine per-architecture Tauri externalBin sidecars into the virtual
# universal-apple-darwin target files that Tauri resolves during a universal
# macOS build.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BIN_DIR="${IRONCLAW_SIDECAR_BIN_DIR:-${REPO_ROOT}/src-tauri/binaries}"
BASES="${IRONCLAW_UNIVERSAL_SIDECAR_BASES:-ironclaw ironclaw-reborn sandbox_daemon}"
CHECK_ONLY=0

usage() {
  cat <<'EOF'
Usage: bash scripts/prepare-universal-sidecars.sh [options]

Creates *-universal-apple-darwin sidecar binaries for Tauri universal builds.

Options:
  --bin-dir <dir>    Directory containing per-arch sidecars (default: src-tauri/binaries)
  --bases <list>     Space-separated sidecar basenames (default: ironclaw ironclaw-reborn sandbox_daemon)
  --check-only       Verify required per-arch inputs exist; do not run lipo
  --help             Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bin-dir)
      BIN_DIR="${2:?--bin-dir requires a directory}"
      shift 2
      ;;
    --bases)
      BASES="${2:?--bases requires a space-separated list}"
      shift 2
      ;;
    --check-only)
      CHECK_ONLY=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "[ironclaw] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "${BIN_DIR}" ]]; then
  echo "[ironclaw] sidecar binary directory not found: ${BIN_DIR}" >&2
  exit 1
fi

require_executable() {
  local path="$1"
  if [[ ! -f "${path}" ]]; then
    echo "[ironclaw] missing sidecar slice: ${path}" >&2
    exit 1
  fi
  if [[ ! -x "${path}" ]]; then
    echo "[ironclaw] sidecar slice is not executable: ${path}" >&2
    exit 1
  fi
}

require_archs() {
  local path="$1"
  local archs="$2"
  if [[ "${archs}" != *"x86_64"* || "${archs}" != *"arm64"* ]]; then
    echo "[ironclaw] ${path} is not universal arm64+x86_64; lipo reports: ${archs}" >&2
    exit 1
  fi
}

for base in ${BASES}; do
  arm_bin="${BIN_DIR}/${base}-aarch64-apple-darwin"
  x86_bin="${BIN_DIR}/${base}-x86_64-apple-darwin"
  universal_bin="${BIN_DIR}/${base}-universal-apple-darwin"

  require_executable "${arm_bin}"
  require_executable "${x86_bin}"

  if [[ "${CHECK_ONLY}" == "1" ]]; then
    echo "[ironclaw] found per-arch sidecars for ${base}"
    continue
  fi

  echo "[ironclaw] creating ${universal_bin}"
  rm -f "${universal_bin}"
  lipo -create -output "${universal_bin}" "${arm_bin}" "${x86_bin}"
  chmod +x "${universal_bin}"
  archs="$(lipo -archs "${universal_bin}")"
  require_archs "${universal_bin}" "${archs}"
  echo "[ironclaw] ${base}: ${archs}"
done
