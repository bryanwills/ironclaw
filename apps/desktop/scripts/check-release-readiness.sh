#!/usr/bin/env bash
# Release preflight for public IronClaw Desktop builds.
#
# This intentionally checks the cheap "do not ship broken releases" facts before
# expensive build/notarization work starts:
#   - updater signing key is present (unless explicitly allowed for a local dry-run)
#   - Apple Developer ID certificate + notarization credentials are present when required
#   - package.json, tauri.conf.json, and Cargo.toml all use the same version
#   - optional expected version matches all three files

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${IRONCLAW_RELEASE_REPO_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"

ALLOW_MISSING_SIGNING_KEY=0
REQUIRE_APPLE_SIGNING=0
EXPECTED_VERSION=""

usage() {
  cat >&2 <<'EOF'
Usage: bash scripts/check-release-readiness.sh [options]

Options:
  --expected-version <semver>       Require all version files to equal this version
  --allow-missing-signing-key       Permit a local dry-run without TAURI_SIGNING_PRIVATE_KEY
  --require-apple-signing           Require Developer ID certificate + notarization env
  --help                           Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expected-version)
      [[ $# -ge 2 ]] || { echo "ERROR: --expected-version requires a value" >&2; exit 2; }
      EXPECTED_VERSION="$2"
      shift 2
      ;;
    --allow-missing-signing-key)
      ALLOW_MISSING_SIGNING_KEY=1
      shift
      ;;
    --require-apple-signing)
      REQUIRE_APPLE_SIGNING=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

info() { printf '\033[34m[release-readiness]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[release-readiness]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31m[release-readiness]\033[0m %s\n' "$*" >&2; }

semver_re='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'

read_json_version() {
  local file="$1"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed.version) process.exit(3);
    process.stdout.write(parsed.version);
  ' "$file"
}

read_cargo_version() {
  local file="$1"
  awk '
    /^\[package\]/ { in_package = 1; next }
    /^\[/ && in_package { in_package = 0 }
    in_package && /^version[[:space:]]*=/ {
      gsub(/"/, "", $3);
      print $3;
      exit
    }
  ' "$file"
}

require_file() {
  local file="$1"
  [[ -f "$file" ]] || { err "required file missing: $file"; exit 1; }
}

PKG_JSON="${REPO_ROOT}/package.json"
TAURI_JSON="${REPO_ROOT}/src-tauri/tauri.conf.json"
CARGO_TOML="${REPO_ROOT}/src-tauri/Cargo.toml"

require_file "$PKG_JSON"
require_file "$TAURI_JSON"
require_file "$CARGO_TOML"

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  if [[ "$ALLOW_MISSING_SIGNING_KEY" -eq 1 ]]; then
    warn "TAURI_SIGNING_PRIVATE_KEY is absent; allowed only for a local dry-run"
  else
    err "TAURI_SIGNING_PRIVATE_KEY is required for public updater artifacts"
    err "Set the GitHub Actions secret or export it locally before cutting a release."
    exit 1
  fi
fi

if [[ "$REQUIRE_APPLE_SIGNING" -eq 1 ]]; then
  missing=0
  for env_name in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_API_KEY APPLE_API_ISSUER; do
    if [[ -z "${!env_name:-}" ]]; then
      err "$env_name is required for Developer ID signing/notarization"
      missing=1
    fi
  done
  if [[ -z "${APPLE_API_KEY_PATH:-}" && -z "${APPLE_API_KEY_P8:-}" ]]; then
    err "APPLE_API_KEY_PATH or APPLE_API_KEY_P8 is required for notarization"
    missing=1
  fi
  if [[ "$missing" -ne 0 ]]; then
    err "Provision the GitHub Actions Apple signing secrets before cutting a public release."
    exit 1
  fi
fi

package_version="$(read_json_version "$PKG_JSON")"
tauri_version="$(read_json_version "$TAURI_JSON")"
cargo_version="$(read_cargo_version "$CARGO_TOML")"

for entry in \
  "package.json:${package_version}" \
  "src-tauri/tauri.conf.json:${tauri_version}" \
  "src-tauri/Cargo.toml:${cargo_version}"
do
  file="${entry%%:*}"
  version="${entry#*:}"
  if [[ ! "$version" =~ $semver_re ]]; then
    err "$file has invalid semver: ${version:-<missing>}"
    exit 1
  fi
done

if [[ "$package_version" != "$tauri_version" || "$package_version" != "$cargo_version" ]]; then
  err "version skew detected:"
  err "  package.json:              $package_version"
  err "  src-tauri/tauri.conf.json: $tauri_version"
  err "  src-tauri/Cargo.toml:      $cargo_version"
  exit 1
fi

if [[ -n "$EXPECTED_VERSION" && "$package_version" != "$EXPECTED_VERSION" ]]; then
  err "expected version $EXPECTED_VERSION, found $package_version"
  exit 1
fi

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  info "OK: versions aligned at ${package_version}; updater signing key absent for local dry-run"
else
  message="OK: versions aligned at ${package_version}; updater signing key present"
  if [[ "$REQUIRE_APPLE_SIGNING" -eq 1 ]]; then
    message="${message}; Apple signing/notarization env present"
  fi
  info "$message"
fi
