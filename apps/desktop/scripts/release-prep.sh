#!/usr/bin/env bash
# Walk a clean tree through the pre-release ritual:
#
#   1. Sanity check (clean tree, on main, in sync with origin).
#   2. Verify release gates locally (Svelte legacy checks, static WebUI,
#      vitest, build, cargo).
#   3. Bump the version across package.json + tauri.conf.json + Cargo.toml
#      via `scripts/bump-version.sh`.
#   4. Print the diff so the user can sanity-check before committing.
#   5. Offer to commit + tag + push (interactive — `--yes` skips prompts).
#
# Usage:
#   bash scripts/release-prep.sh <new-version>
#   bash scripts/release-prep.sh 0.2.11
#   bash scripts/release-prep.sh 0.2.11 --yes
#
# The script never force-pushes and never amends an existing commit.
# It refuses to run if the working tree has uncommitted changes that
# aren't the bump itself.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <new-version> [--yes]" >&2
  echo "Example: $0 0.2.11" >&2
  exit 2
fi

NEW_VER="$1"
AUTO_YES=0
if [[ "${2:-}" == "--yes" ]]; then
  AUTO_YES=1
fi

if [[ ! "${NEW_VER}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "ERROR: '${NEW_VER}' is not a semver." >&2
  exit 2
fi

info() { printf '\033[34m[release-prep]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[release-prep]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31m[release-prep]\033[0m %s\n' "$*" >&2; }
ask() {
  local prompt="$1"
  if [[ "${AUTO_YES}" -eq 1 ]]; then
    echo "${prompt} (--yes auto-confirm)"
    return 0
  fi
  read -r -p "${prompt} [y/N] " response
  [[ "${response}" =~ ^[Yy]$ ]]
}

# ---- 1) Sanity check ------------------------------------------------------

if [[ -n "$(git status --porcelain)" ]]; then
  err "uncommitted changes in the working tree:"
  git status --short
  err "commit / stash before running release-prep."
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "${BRANCH}" != "main" ]]; then
  warn "not on main (currently on '${BRANCH}'). Refusing to tag from a side branch."
  exit 1
fi

git fetch origin --quiet
LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse origin/main)"
if [[ "${LOCAL_HEAD}" != "${REMOTE_HEAD}" ]]; then
  warn "main is not in sync with origin/main."
  warn "  local:  ${LOCAL_HEAD}"
  warn "  remote: ${REMOTE_HEAD}"
  exit 1
fi
info "tree clean, on main, in sync with origin"

if git rev-parse "v${NEW_VER}" >/dev/null 2>&1; then
  err "tag v${NEW_VER} already exists. Pick a higher version."
  exit 1
fi
info "tag v${NEW_VER} is free"

info "release readiness preflight..."
bash "${SCRIPT_DIR}/check-release-readiness.sh"

# ---- 2) Gates -------------------------------------------------------------

info "svelte-check..."
npm run check >/tmp/release-prep-check.log 2>&1 \
  || { err "svelte-check failed; see /tmp/release-prep-check.log"; exit 1; }
info "static frontend contract..."
npm run verify:static-frontend >/tmp/release-prep-static-contract.log 2>&1 \
  || { err "static frontend contract failed; see /tmp/release-prep-static-contract.log"; exit 1; }
info "static WebUI smoke..."
npm run smoke:webui-static >/tmp/release-prep-static-smoke.log 2>&1 \
  || { err "static WebUI smoke failed; see /tmp/release-prep-static-smoke.log"; exit 1; }
info "vitest..."
npm run test >/tmp/release-prep-test.log 2>&1 \
  || { err "vitest failed; see /tmp/release-prep-test.log"; exit 1; }
info "frontend build..."
npm run build >/tmp/release-prep-build.log 2>&1 \
  || { err "frontend build failed; see /tmp/release-prep-build.log"; exit 1; }
info "cargo build (release)..."
cargo build --release --manifest-path src-tauri/Cargo.toml \
       >/tmp/release-prep-cargo.log 2>&1 \
  || { err "cargo build failed; see /tmp/release-prep-cargo.log"; exit 1; }
info "release gates green"

# ---- 3) Bump --------------------------------------------------------------

info "bumping to v${NEW_VER}..."
bash "${SCRIPT_DIR}/bump-version.sh" "${NEW_VER}"
bash "${SCRIPT_DIR}/check-release-readiness.sh" --expected-version "${NEW_VER}"

# ---- 4) Diff --------------------------------------------------------------

echo
git --no-pager diff
echo

if ! ask "Diff looks right?"; then
  err "aborting - running 'git restore' on the bumped files."
  git restore package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
  exit 1
fi

# ---- 5) Commit + tag + push -----------------------------------------------

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "v${NEW_VER}: version bump

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

if ask "Tag v${NEW_VER} and push?"; then
  git tag "v${NEW_VER}"
  git push origin main
  git push origin "v${NEW_VER}"
  info "tagged + pushed. release workflow should start at:"
  info "  https://github.com/nearai/ironclaw-desktop-app/actions"
else
  warn "skipped tag/push. Commit is local - run:"
  warn "  git tag v${NEW_VER}"
  warn "  git push origin main"
  warn "  git push origin v${NEW_VER}"
fi
