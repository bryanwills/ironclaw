#!/usr/bin/env bash
#
# Smoke-test the latest built macOS IronClaw.app bundle without installing it.
#
# The harness launches the embedded Tauri binary, captures stdout/stderr,
# requires the process to stay alive for a short window, then terminates it.
# By default it runs with an isolated temporary HOME containing a smoke-only
# profile and no token, so it does not use the developer's real connectors.
#
# Usage:
#   bash scripts/smoke-packaged-app.sh
#   npm run smoke:packaged
#   bash scripts/smoke-packaged-app.sh --wait 20
#   bash scripts/smoke-packaged-app.sh --bundle path/to/IronClaw.app
#   bash scripts/smoke-packaged-app.sh --use-current-profile
#   bash scripts/smoke-packaged-app.sh --webview-smoke
#
# Env:
#   SMOKE_WAIT_SECONDS   Seconds the app must remain alive. Default: 12.
#   SMOKE_LOG_PATH       Log path. Default: /tmp/ironclaw-packaged-smoke-<ts>.log
#   WEBVIEW_SMOKE_WAIT_SECONDS Seconds to wait for WebView evidence. Default: 45.
#   KEEP_SMOKE_HOME=1    Keep the isolated temp HOME for inspection.
#
# Exit codes:
#   0 - packaged app launched, stayed alive, and terminated on request
#   1 - bundle missing, binary missing, early exit, panic, or termination failure
#   2 - usage error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

WAIT_SECONDS="${SMOKE_WAIT_SECONDS:-12}"
LOG_PATH="${SMOKE_LOG_PATH:-}"
BUNDLE_PATH=""
USE_CURRENT_PROFILE=0
WEBVIEW_SMOKE=0
WEBVIEW_SMOKE_EVIDENCE=""
SMOKE_HOME=""
PID=""
SIDECAR_PORT=""
SIDECAR_PIDS=()

info() { printf '\033[34m[packaged-smoke]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[packaged-smoke]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31m[packaged-smoke]\033[0m %s\n' "$*" >&2; }

usage() {
  sed -n '2,28p' "$0"
}

cleanup_home() {
  if [[ -n "${SMOKE_HOME}" && "${KEEP_SMOKE_HOME:-0}" != "1" ]]; then
    rm -rf "${SMOKE_HOME}"
  elif [[ -n "${SMOKE_HOME}" ]]; then
    info "kept isolated HOME at ${SMOKE_HOME}"
  fi
}

cleanup_process() {
  if [[ -n "${PID}" ]] && kill -0 "${PID}" >/dev/null 2>&1; then
    kill -TERM "${PID}" >/dev/null 2>&1 || true
    sleep 1
    if kill -0 "${PID}" >/dev/null 2>&1; then
      kill -KILL "${PID}" >/dev/null 2>&1 || true
    fi
  fi
}

list_descendants() {
  local root="$1"
  local seen=" ${root} "
  local added child parent command
  local -a found=()

  while :; do
    added=0
    while read -r child parent command; do
      [[ -n "${child}" && -n "${parent}" ]] || continue
      if [[ "${seen}" == *" ${parent} "* && "${seen}" != *" ${child} "* ]]; then
        seen="${seen}${child} "
        found+=("${child}")
        added=1
      fi
    done < <(ps -axo pid=,ppid=,command= 2>/dev/null || true)
    (( added == 1 )) || break
  done

  printf '%s\n' "${found[@]}"
}

record_sidecar_pids() {
  local candidate command
  SIDECAR_PIDS=()
  [[ -n "${PID}" ]] || return 0
  while IFS= read -r candidate; do
    [[ -n "${candidate}" ]] || continue
    command="$(ps -p "${candidate}" -o command= 2>/dev/null || true)"
    if [[ "${command}" == *"ironclaw-reborn"* ]]; then
      SIDECAR_PIDS+=("${candidate}")
    fi
  done < <(list_descendants "${PID}")
}

sidecar_pid_list() {
  local pid
  for pid in ${SIDECAR_PIDS[*]-}; do
    printf '%s\n' "${pid}"
  done
}

alive_recorded_sidecars() {
  local pid
  for pid in ${SIDECAR_PIDS[*]-}; do
    if kill -0 "${pid}" >/dev/null 2>&1; then
      printf '%s\n' "${pid}"
    fi
  done
}

cleanup_recorded_sidecars() {
  local pid child
  for pid in ${SIDECAR_PIDS[*]-}; do
    if kill -0 "${pid}" >/dev/null 2>&1; then
      while IFS= read -r child; do
        [[ -n "${child}" ]] || continue
        kill -TERM "${child}" >/dev/null 2>&1 || true
      done < <(list_descendants "${pid}")
      kill -TERM "${pid}" >/dev/null 2>&1 || true
    fi
  done
  sleep 1
  for pid in ${SIDECAR_PIDS[*]-}; do
    if kill -0 "${pid}" >/dev/null 2>&1; then
      kill -KILL "${pid}" >/dev/null 2>&1 || true
    fi
  done
}

extract_sidecar_port() {
  grep -E 'Sidecar healthy on port|auto-started Reborn WebUI sidecar on port|listen[[:space:]]*: http://127\.0\.0\.1:|bound=127\.0\.0\.1:' "${LOG_PATH}" 2>/dev/null \
    | tail -1 \
    | sed -E 's/.*(port |127\.0\.0\.1:|bound=127\.0\.0\.1:)([0-9]+).*/\2/' \
    | sed -n -E '/^[0-9]+$/p'
}

probe_gateway_health() {
  local port="$1"
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${port}/api/health" 2>/dev/null || true)"
  [[ "${code}" =~ ^[234][0-9][0-9]$ ]]
}

validate_webview_smoke_report() {
  local evidence_path="$1"
  node - "${evidence_path}" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
const report = JSON.parse(fs.readFileSync(path, 'utf8'));
const required = [
  'sidecar status exposes runtime port',
  'WebView stored local gateway bearer',
  'WebView Tauri HTTP reaches Reborn health',
  'WebView reads gateway model readiness',
  'Markdown export blob includes draft body',
  'HTML export blob renders markdown body',
  'JSON export blob parses and preserves content',
  'PDF export blob has a parseable PDF envelope',
  'DOCX export blob has ZIP package entries',
  'WebView export saves a real file to disk',
];
const checks = Array.isArray(report.checks) ? report.checks : [];
const byName = new Map(checks.map((check) => [check.name, check]));
const chatRouteRequired = [
  'WebView created Reborn webchat thread',
  'WebView submitted chat message with attachment',
];
const timelineProofRequired = [
  'Timeline reload preserves user prompt',
  'Timeline echo carries embedded attachment text for the model',
];
const pendingFallbackProofRequired = [
  'WebView pending fallback preserves user prompt',
  'WebView pending fallback preserves attachment metadata',
];
const hasChatRoute = chatRouteRequired.every((name) => byName.get(name)?.status === 'PASS');
const hasTimelineProof = timelineProofRequired.every((name) => byName.get(name)?.status === 'PASS');
const hasPendingFallbackProof = pendingFallbackProofRequired.every(
  (name) => byName.get(name)?.status === 'PASS'
);
const hasChatProof = hasChatRoute && (hasTimelineProof || hasPendingFallbackProof);
const missing = [
  ...required.filter((name) => byName.get(name)?.status !== 'PASS'),
  ...(hasChatProof ? [] : ['chat route proof']),
];
if (report.status !== 'passed' || missing.length > 0) {
  console.error(JSON.stringify({
    status: report.status,
    missing,
    errors: report.errors || [],
    checks,
  }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  status: report.status,
  pass_count: report.pass_count,
  thread_id: report.thread_id,
  gateway_origin: report.gateway_origin,
  model_credentials_blocked: report.model_credentials_blocked === true,
  chat_proof: hasTimelineProof ? 'timeline' : 'pending_fallback',
  timeline_proof: hasTimelineProof,
  pending_fallback_proof: hasPendingFallbackProof,
}, null, 2));
if (!hasTimelineProof) {
  console.error(
    'WARN: chat proof came from the pending fallback (timeline never projected the turn). ' +
    'A streak of fallback-only passes means timeline projection is broken.'
  );
}
NODE
}

wait_for_webview_smoke_report() {
  local evidence_path="$1"
  local max_wait="${WEBVIEW_SMOKE_WAIT_SECONDS:-540}"
  local second

  info "waiting up to ${max_wait}s for WebView smoke evidence: ${evidence_path}"
  for (( second = 1; second <= max_wait; second++ )); do
    if [[ -s "${evidence_path}" ]]; then
      if validate_webview_smoke_report "${evidence_path}"; then
        # Native-save proof: verify the bytes save_bytes_dialog reported
        # actually reached disk (smoke seam writes without a dialog).
        saved_file=$(node -e "const r=require(process.argv[1]);process.stdout.write(r.saved_file_path||'')" "${evidence_path}" 2>/dev/null || true)
        if [[ -n "${saved_file}" && ! -s "${saved_file}" ]]; then
          err "saved-file proof missing on disk: ${saved_file}"
          return 1
        fi
        info "WebView smoke evidence validated"
        return 0
      fi
      err "WebView smoke evidence exists but failed validation"
      err "evidence: ${evidence_path}"
      return 1
    fi
    if [[ -n "${PID}" ]] && ! kill -0 "${PID}" >/dev/null 2>&1; then
      err "app exited before writing WebView smoke evidence"
      tail -120 "${LOG_PATH}" >&2 || true
      return 1
    fi
    sleep 1
  done

  err "timed out waiting for WebView smoke evidence"
  err "last 120 log lines:"
  tail -120 "${LOG_PATH}" >&2 || true
  return 1
}

native_window_count_for_pid() {
  local app_pid="$1"
  local count=""

  if command -v swift >/dev/null 2>&1; then
    count="$(swift - "${app_pid}" <<'SWIFT' 2>/dev/null || true
import CoreGraphics
import Foundation

let targetPid = Int32(CommandLine.arguments.dropFirst().first ?? "") ?? -1
let windows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
var count = 0

for window in windows {
  let ownerPid = window[kCGWindowOwnerPID as String] as? Int32 ?? -1
  let layer = window[kCGWindowLayer as String] as? Int ?? Int.max
  let alpha = (window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0
  let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let width = (bounds["Width"] as? NSNumber)?.doubleValue ?? 0
  let height = (bounds["Height"] as? NSNumber)?.doubleValue ?? 0

  if ownerPid == targetPid && layer == 0 && alpha > 0 && width > 0 && height > 0 {
    count += 1
  }
}

print(count)
SWIFT
)"
    if [[ "${count}" =~ ^[0-9]+$ ]]; then
      printf '%s\n' "${count}"
      return 0
    fi
  fi

  osascript <<APPLESCRIPT 2>/dev/null | tr -d '[:space:]' || true
tell application "System Events"
  repeat with candidate in processes
    try
      if unix id of candidate is ${app_pid} then
        return count of windows of candidate
      end if
    end try
  end repeat
  return -1
end tell
APPLESCRIPT
}

native_window_snapshot_for_pid() {
  local app_pid="$1"
  local snapshot=""

  if command -v swift >/dev/null 2>&1; then
    snapshot="$(swift - "${app_pid}" <<'SWIFT' 2>/dev/null || true
import CoreGraphics
import Foundation

let targetPid = Int32(CommandLine.arguments.dropFirst().first ?? "") ?? -1
let windows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
var rows: [String] = []

for window in windows {
  let ownerPid = window[kCGWindowOwnerPID as String] as? Int32 ?? -1
  guard ownerPid == targetPid else { continue }

  let owner = window[kCGWindowOwnerName as String] as? String ?? "unknown"
  let name = window[kCGWindowName as String] as? String ?? ""
  let layer = window[kCGWindowLayer as String] ?? "?"
  let alpha = window[kCGWindowAlpha as String] ?? "?"
  let onscreen = window[kCGWindowIsOnscreen as String] ?? "?"
  let bounds = window[kCGWindowBounds as String] ?? [:]

  rows.append("owner=\(owner) pid=\(ownerPid) name=\(name) layer=\(layer) alpha=\(alpha) onscreen=\(onscreen) bounds=\(bounds)")
}

if rows.isEmpty {
  print("no CGWindow entries for pid=\(targetPid)")
} else {
  print(rows.joined(separator: " | "))
}
SWIFT
)"
    if [[ -n "${snapshot}" ]]; then
      printf '%s\n' "${snapshot}"
      return 0
    fi
  fi

  osascript <<APPLESCRIPT 2>/dev/null || true
tell application "System Events"
  repeat with candidate in processes
    try
      if unix id of candidate is ${app_pid} then
        return (name of candidate) & " pid=" & (${app_pid} as text) & " windows=" & (count of windows of candidate as text) & " visible=" & (visible of candidate as text)
      end if
    end try
  end repeat
  return "no System Events process for pid=${app_pid}"
end tell
APPLESCRIPT
}

trap 'cleanup_process; cleanup_recorded_sidecars; cleanup_home' EXIT
trap 'err "interrupted"; exit 1' INT TERM

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle)
      [[ $# -ge 2 ]] || { err "--bundle requires a path"; exit 2; }
      BUNDLE_PATH="$2"
      shift 2
      ;;
    --wait)
      [[ $# -ge 2 ]] || { err "--wait requires seconds"; exit 2; }
      WAIT_SECONDS="$2"
      shift 2
      ;;
    --log)
      [[ $# -ge 2 ]] || { err "--log requires a path"; exit 2; }
      LOG_PATH="$2"
      shift 2
      ;;
    --use-current-profile)
      USE_CURRENT_PROFILE=1
      shift
      ;;
    --webview-smoke)
      WEBVIEW_SMOKE=1
      shift
      ;;
    --webview-smoke-evidence)
      [[ $# -ge 2 ]] || { err "--webview-smoke-evidence requires a path"; exit 2; }
      WEBVIEW_SMOKE_EVIDENCE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "unknown flag: $1"
      usage >&2
      exit 2
      ;;
  esac
done

case "${WAIT_SECONDS}" in
  ''|*[!0-9]*)
    err "wait seconds must be a positive integer"
    exit 2
    ;;
esac

if (( WAIT_SECONDS < 1 )); then
  err "wait seconds must be at least 1"
  exit 2
fi

latest_bundle() {
  local latest=""
  local latest_mtime=0
  local candidate
  local mtime

  while IFS= read -r -d '' candidate; do
    mtime="$(stat -f '%m' "${candidate}" 2>/dev/null || stat -c '%Y' "${candidate}" 2>/dev/null || echo 0)"
    if [[ "${mtime}" =~ ^[0-9]+$ ]] && (( mtime > latest_mtime )); then
      latest="${candidate}"
      latest_mtime="${mtime}"
    fi
  done < <(find "${REPO_ROOT}/src-tauri/target" -path '*/bundle/macos/IronClaw.app' -type d -prune -print0 2>/dev/null)

  printf '%s\n' "${latest}"
}

if [[ -z "${BUNDLE_PATH}" ]]; then
  BUNDLE_PATH="$(latest_bundle)"
fi

if [[ -z "${BUNDLE_PATH}" || ! -d "${BUNDLE_PATH}" ]]; then
  err "no built IronClaw.app bundle found under ${REPO_ROOT}/src-tauri/target"
  err "run 'npm run tauri build' first; signing may fail locally, but the .app should still be produced"
  exit 1
fi

BIN="${BUNDLE_PATH}/Contents/MacOS/ironclaw-desktop"
if [[ ! -x "${BIN}" ]]; then
  err "bundle exists but executable is missing or not executable: ${BIN}"
  exit 1
fi

if [[ -z "${LOG_PATH}" ]]; then
  LOG_PATH="/tmp/ironclaw-packaged-smoke-$(date +%Y%m%d-%H%M%S).log"
fi

if (( WEBVIEW_SMOKE == 1 )) && [[ -z "${WEBVIEW_SMOKE_EVIDENCE}" ]]; then
  WEBVIEW_SMOKE_EVIDENCE="/tmp/ironclaw-packaged-webview-smoke-$(date +%Y%m%d-%H%M%S).json"
fi

mkdir -p "$(dirname "${LOG_PATH}")"
rm -f "${LOG_PATH}"
if (( WEBVIEW_SMOKE == 1 )); then
  mkdir -p "$(dirname "${WEBVIEW_SMOKE_EVIDENCE}")"
  rm -f "${WEBVIEW_SMOKE_EVIDENCE}"
fi

if (( USE_CURRENT_PROFILE == 0 )); then
  SMOKE_HOME="$(mktemp -d "${TMPDIR:-/tmp}/ironclaw-smoke-home.XXXXXX")"
  SETTINGS_DIR="${SMOKE_HOME}/Library/Application Support/com.openclaw.ironclaw-desktop"
  mkdir -p "${SETTINGS_DIR}"
  cat > "${SETTINGS_DIR}/settings.json" <<'JSON'
{
  "activeProfileId": "packaged-smoke",
  "profiles": [
    {
      "id": "packaged-smoke",
      "name": "Packaged Smoke",
      "mode": "remote",
      "remoteBaseUrl": "http://127.0.0.1:9",
      "localBaseUrl": "http://127.0.0.1:9",
      "apiVersion": "v2",
      "llmBackend": "nearai",
      "llmProviderId": "nearai"
    }
  ],
  "onboardingComplete": false,
  "adminMode": false,
  "trayEnabled": false,
  "useResponsesApi": true,
  "engineV2Enabled": false
}
JSON
  info "using isolated HOME=${SMOKE_HOME}"
else
  warn "using current profile data; this may read existing app settings/tokens"
fi

info "bundle: ${BUNDLE_PATH}"
info "binary: ${BIN}"
info "log: ${LOG_PATH}"
if (( WEBVIEW_SMOKE == 1 )); then
  info "WebView smoke evidence: ${WEBVIEW_SMOKE_EVIDENCE}"
fi
info "launching for ${WAIT_SECONDS}s liveness window"

SMOKE_RUST_LOG_DEFAULT='ironclaw_desktop_lib=info,ironclaw_diag=info,ironclaw_packaged_smoke=info,ironclaw_gateway=info,ironclaw_sidecar=info,warn'
LAUNCH_ENV=(RUST_LOG="${RUST_LOG:-${SMOKE_RUST_LOG_DEFAULT}}" IRONCLAW_PACKAGED_SMOKE=1)
if (( WEBVIEW_SMOKE == 1 )); then
  LAUNCH_ENV+=(
    IRONCLAW_PACKAGED_WEBVIEW_SMOKE=1
    IRONCLAW_PACKAGED_WEBVIEW_SMOKE_EVIDENCE="${WEBVIEW_SMOKE_EVIDENCE}"
  )
fi

if (( USE_CURRENT_PROFILE == 0 )); then
  env HOME="${SMOKE_HOME}" "${LAUNCH_ENV[@]}" "${BIN}" >"${LOG_PATH}" 2>&1 &
else
  env "${LAUNCH_ENV[@]}" "${BIN}" >"${LOG_PATH}" 2>&1 &
fi
PID="$!"

for (( second = 1; second <= WAIT_SECONDS; second++ )); do
  sleep 1
  if ! kill -0 "${PID}" >/dev/null 2>&1; then
    set +e
    wait "${PID}"
    status="$?"
    set -e
    err "app exited early after ${second}s with status ${status}"
    err "last 80 log lines:"
    tail -80 "${LOG_PATH}" >&2 || true
    exit 1
  fi
done

if grep -Eiq 'panicked at|thread .* panicked|fatal runtime error' "${LOG_PATH}"; then
  err "panic signature found in packaged app log"
  err "last 80 log lines:"
  tail -80 "${LOG_PATH}" >&2 || true
  exit 1
fi

if grep -Eq 'auto-start failed|auto-start token load failed|sidecar exited' "${LOG_PATH}"; then
  err "Reborn sidecar auto-start failure found in packaged app log"
  err "last 120 log lines:"
  tail -120 "${LOG_PATH}" >&2 || true
  exit 1
fi

if ! grep -Eq 'auto-started Reborn WebUI sidecar on port|Sidecar healthy on port|WebChat v2 listener bound' "${LOG_PATH}"; then
  err "packaged app stayed alive but did not prove Reborn sidecar startup"
  err "last 120 log lines:"
  tail -120 "${LOG_PATH}" >&2 || true
  exit 1
fi

SIDECAR_PORT="$(extract_sidecar_port)"
if [[ -z "${SIDECAR_PORT}" ]]; then
  err "packaged app log did not include the Reborn sidecar port"
  err "last 120 log lines:"
  tail -120 "${LOG_PATH}" >&2 || true
  exit 1
fi

if ! probe_gateway_health "${SIDECAR_PORT}"; then
  err "Reborn gateway did not answer /api/health on port ${SIDECAR_PORT}"
  err "last 120 log lines:"
  tail -120 "${LOG_PATH}" >&2 || true
  exit 1
fi

WINDOW_COUNT="$(native_window_count_for_pid "${PID}")"
if [[ ! "${WINDOW_COUNT}" =~ ^-?[0-9]+$ ]] || (( WINDOW_COUNT < 1 )); then
  err "packaged app process and sidecar are alive, but no native app window is visible"
  err "native window snapshot: $(native_window_snapshot_for_pid "${PID}")"
  err "last 120 log lines:"
  tail -120 "${LOG_PATH}" >&2 || true
  exit 1
fi

record_sidecar_pids
if [[ "${#SIDECAR_PIDS[@]}" -eq 0 ]]; then
  err "Reborn gateway is healthy on port ${SIDECAR_PORT}, but no ironclaw-reborn child was found under app pid ${PID}"
  err "descendants under app pid ${PID}:"
  list_descendants "${PID}" >&2 || true
  exit 1
fi

if (( WEBVIEW_SMOKE == 1 )); then
  wait_for_webview_smoke_report "${WEBVIEW_SMOKE_EVIDENCE}"
fi

info "process stayed alive for ${WAIT_SECONDS}s (pid ${PID})"
info "native app window count: ${WINDOW_COUNT}"
info "Reborn gateway healthy on port ${SIDECAR_PORT}"
if (( WEBVIEW_SMOKE == 1 )); then
  info "WebView smoke evidence: ${WEBVIEW_SMOKE_EVIDENCE}"
fi
info "Reborn sidecar pid(s) before termination: $(sidecar_pid_list | tr '\n' ' ')"
info "requesting clean termination"
kill -TERM "${PID}" >/dev/null 2>&1 || true

for _ in 1 2 3 4 5; do
  if ! kill -0 "${PID}" >/dev/null 2>&1; then
    set +e
    wait "${PID}" >/dev/null 2>&1
    set -e
    PID=""
    if orphans="$(alive_recorded_sidecars)" && [[ -n "${orphans}" ]]; then
      err "app exited, but Reborn sidecar pid(s) remained alive: ${orphans//$'\n'/ }"
      err "last 120 log lines:"
      tail -120 "${LOG_PATH}" >&2 || true
      exit 1
    fi
    info "terminated cleanly"
    info "Reborn sidecar pid(s) after termination: none"
    info "PASS - packaged app smoke succeeded"
    info "full log: ${LOG_PATH}"
    exit 0
  fi
  sleep 1
done

err "app did not exit after SIGTERM within 5s"
err "last 80 log lines:"
tail -80 "${LOG_PATH}" >&2 || true
exit 1
