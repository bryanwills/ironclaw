#!/usr/bin/env bash
# One-command bring-up for a working IronClaw Desktop dev session.
#
# Does the chain of moves that previously required ~6 manual commands
# and a clear head:
#   1. Open the SSH tunnel to the remote gateway (idempotent, skips
#      if already open).
#   2. Verify the gateway responds at 200.
#   3. Stage the file-fallback token (so the macOS keychain ACL hang
#      can't wedge the launch — see v0.2.8).
#   4. Prepare the static WebUI, build the Rust binary, copy + ad-hoc-sign the
#      .app, launch it with RUST_LOG=info captured to /tmp/log.txt.
#   5. Tail the log for the first ~10s and surface the diag_log
#      events so you can see token-load + first-fetch happen.
#
# Flags:
#   --skip-build         Skip cargo + frontend build; just (re)launch
#                        the existing bundle. Useful after a manual
#                        rebuild via `npm run tauri build`.
#   --no-tunnel          Don't open / verify the SSH tunnel. Use when
#                        you're pointing at a different gateway URL
#                        (set IRONCLAW_GATEWAY_URL).
#   --profile <id>       Profile id to stage. Defaults to "default".
#
# Env:
#   IRONCLAW_TUNNEL_HOST   ssh alias to forward through. Default:
#                          "your-ssh-host".
#   IRONCLAW_TUNNEL_PORT   Local port. Default: 18789.
#   IRONCLAW_GATEWAY_URL   Override the URL we curl-probe. Default:
#                          "http://127.0.0.1:${IRONCLAW_TUNNEL_PORT}".
#
# Exit codes:
#   0 - launched successfully
#   1 - bring-up failure (tunnel down, gateway 5xx, build fail, etc.)
#   2 - usage error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

TUNNEL_HOST="${IRONCLAW_TUNNEL_HOST:-your-ssh-host}"
TUNNEL_PORT="${IRONCLAW_TUNNEL_PORT:-18789}"
GATEWAY_URL="${IRONCLAW_GATEWAY_URL:-http://127.0.0.1:${TUNNEL_PORT}}"
PROFILE_ID="default"

SKIP_BUILD=0
NO_TUNNEL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --no-tunnel) NO_TUNNEL=1; shift ;;
    --profile) PROFILE_ID="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

info() { printf '\033[34m[dev-up]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[dev-up]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31m[dev-up]\033[0m %s\n' "$*" >&2; }

# ---- 1) Tunnel -------------------------------------------------------------

if [[ "${NO_TUNNEL}" -eq 1 ]]; then
  info "skipping tunnel check (--no-tunnel)"
else
  if pgrep -f "ssh -L ${TUNNEL_PORT}.*${TUNNEL_HOST}" >/dev/null 2>&1 \
     || pgrep -f "ssh -L ${TUNNEL_PORT}:" >/dev/null 2>&1; then
    info "tunnel already up on :${TUNNEL_PORT}"
  else
    info "opening tunnel: ssh -L ${TUNNEL_PORT}:127.0.0.1:${TUNNEL_PORT} ${TUNNEL_HOST}"
    ssh -L "${TUNNEL_PORT}:127.0.0.1:${TUNNEL_PORT}" "${TUNNEL_HOST}" \
        -fN -o ExitOnForwardFailure=yes
  fi
fi

# ---- 2) Gateway health -----------------------------------------------------

if curl -sf -m 3 -o /dev/null -w '' "${GATEWAY_URL}/api/health"; then
  info "gateway healthy at ${GATEWAY_URL}/api/health"
else
  err "gateway unreachable at ${GATEWAY_URL}/api/health"
  err "  hint: re-run after the tunnel settles, or set IRONCLAW_GATEWAY_URL"
  exit 1
fi

# ---- 3) Stage token --------------------------------------------------------

TOKEN="$(security find-generic-password \
           -s com.openclaw.ironclaw-desktop \
           -a "gateway-token:${PROFILE_ID}" \
           -w 2>/dev/null || true)"

if [[ -n "${TOKEN}" ]]; then
  bash "${SCRIPT_DIR}/stage-token.sh" "${PROFILE_ID}" "${TOKEN}" >/dev/null
  info "staged ${#TOKEN}-char token for profile=${PROFILE_ID}"
else
  warn "no keychain token for gateway-token:${PROFILE_ID} — app will boot to Signed-out"
fi

unset TOKEN

# ---- 4) Build + sign + launch ----------------------------------------------

BUNDLE="src-tauri/target/release/bundle/macos/IronClaw.app"
BIN="${BUNDLE}/Contents/MacOS/ironclaw-desktop"

if [[ "${SKIP_BUILD}" -eq 1 ]]; then
  if [[ ! -x "${BIN}" ]]; then
    err "no bundle to launch at ${BUNDLE} — drop --skip-build for a full build"
    exit 1
  fi
  info "skipping build (--skip-build); using existing ${BUNDLE}"
else
  info "static WebUI contract…"
  npm run verify:static-frontend >/dev/null
  info "static WebUI prepare…"
  npm run prepare:webui-static >/dev/null
  info "cargo --release…"
  touch src-tauri/build.rs
  cargo build --release --manifest-path src-tauri/Cargo.toml >/dev/null 2>&1 \
    || { err "cargo build failed; re-run without redirect for details"; exit 1; }
  cp src-tauri/target/release/ironclaw-desktop "${BIN}"
  info "ad-hoc codesign…"
  codesign --force --deep --sign - "${BUNDLE}" 2>/dev/null
fi

pkill -f "IronClaw.app/Contents/MacOS/ironclaw-desktop" 2>/dev/null || true
sleep 1
rm -f /tmp/ironclaw_dev.log
info "launching IronClaw with RUST_LOG=info → /tmp/ironclaw_dev.log"
RUST_LOG=info "${BIN}" >/tmp/ironclaw_dev.log 2>&1 &

# ---- 5) Tail key signals ---------------------------------------------------

sleep 10
echo
info "key signals from first 10s:"
grep -E "ironclaw_keychain|ironclaw_diag|http|18789|status=|TIMEOUT|fallback" \
     /tmp/ironclaw_dev.log \
     | head -25 \
     | sed 's/^/  /' || true
echo
info "done. full log at /tmp/ironclaw_dev.log"
info "  tail -f /tmp/ironclaw_dev.log    # live tail"
info "  pkill -f IronClaw                # stop"
