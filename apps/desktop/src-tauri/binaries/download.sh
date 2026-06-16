#!/usr/bin/env bash
# Fetch IronClaw sidecar binaries for both macOS arches.
# Run from src-tauri/binaries/.
set -euo pipefail

VERSION="${IRONCLAW_VERSION:-v0.29.0}"
BASE="https://github.com/nearai/ironclaw/releases/download/ironclaw-${VERSION}"

cd "$(dirname "$0")"

for arch in aarch64 x86_64; do
  tarball="ironclaw-${arch}-apple-darwin.tar.gz"
  echo "Downloading ${tarball}..."
  curl -sSL -o "${tarball}" "${BASE}/${tarball}"
  curl -sSL -o "${tarball}.sha256" "${BASE}/${tarball}.sha256"
  shasum -a 256 -c "${tarball}.sha256"

  rm -rf "_stage_${arch}"
  mkdir -p "_stage_${arch}"
  tar -xzf "${tarball}" -C "_stage_${arch}"

  inner="_stage_${arch}/ironclaw-${arch}-apple-darwin"
  mv "${inner}/ironclaw" "./ironclaw-${arch}-apple-darwin"
  mv "${inner}/sandbox_daemon" "./sandbox_daemon-${arch}-apple-darwin"
  chmod +x "./ironclaw-${arch}-apple-darwin" "./sandbox_daemon-${arch}-apple-darwin"
  rm -rf "_stage_${arch}"
done

echo "Done. Binaries staged in $(pwd)."
