#!/usr/bin/env bash
#
# Smoke-test perf snapshot. NOT Lighthouse — just catches regressions.
#
# What it does:
#   1. Spawns `npm run dev` in the background (Vite on :1420).
#   2. Polls until the dev server is reachable.
#   3. For each probe route: measures TTFB + total transfer time via curl,
#      pulls the rendered HTML, counts critical resources (<script>/<link
#      rel=stylesheet>) and reports html size + gzip size.
#   4. Kills the dev server.
#   5. Writes a report to /tmp/ironclaw-perf-snapshot.txt.
#
# This is a SvelteKit SPA (adapter-static, fallback: index.html), so every
# route returns the same shell. We probe a few anyway because middleware,
# preload hints, and route metadata could vary that someday.
#
# Usage:
#   bash scripts/perf-snapshot.sh
#   PERF_PORT=1420 PERF_HOST=127.0.0.1 bash scripts/perf-snapshot.sh
#   KEEP_SERVER=1  bash scripts/perf-snapshot.sh   # leave dev server running
#
# Exit codes:
#   0  success
#   1  dev server never came up
#   2  npm/curl missing or failed

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PERF_HOST="${PERF_HOST:-127.0.0.1}"
PERF_PORT="${PERF_PORT:-1420}"
PERF_BASE="http://${PERF_HOST}:${PERF_PORT}"
REPORT_PATH="${PERF_REPORT:-/tmp/ironclaw-perf-snapshot.txt}"
DEV_LOG="$(mktemp -t ironclaw-perf-dev.XXXXXX)"
DEV_PID=""

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD="" DIM="" CYAN="" GREEN="" YELLOW="" RED="" RESET=""
fi

cleanup() {
  if [[ -n "${DEV_PID}" && "${KEEP_SERVER:-0}" != "1" ]]; then
    # Send SIGTERM to the whole process group; Vite spawns workers.
    kill -TERM "-${DEV_PID}" 2>/dev/null || kill "${DEV_PID}" 2>/dev/null || true
    # Give it a beat; force-kill if still alive.
    for _ in 1 2 3 4 5; do
      kill -0 "${DEV_PID}" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL "-${DEV_PID}" 2>/dev/null || true
  fi
  rm -f "${DEV_LOG}"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Sanity: tools we need.
# ---------------------------------------------------------------------------
for tool in npm curl awk gzip; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "${RED}ERROR${RESET} '${tool}' not on PATH" >&2
    exit 2
  fi
done

# ---------------------------------------------------------------------------
# Start the dev server in its own process group so cleanup can kill the whole
# tree. setsid is Linux-only; fall back to `set -m` + plain background on
# macOS, which gives the child its own pgid.
# ---------------------------------------------------------------------------
echo "${DIM}Starting dev server (${PERF_BASE})...${RESET}"

(
  cd "${PROJECT_ROOT}"
  if command -v setsid >/dev/null 2>&1; then
    setsid npm run dev -- --port "${PERF_PORT}" --host "${PERF_HOST}" \
      >> "${DEV_LOG}" 2>&1 &
  else
    set -m
    npm run dev -- --port "${PERF_PORT}" --host "${PERF_HOST}" \
      >> "${DEV_LOG}" 2>&1 &
  fi
  echo "$!" > "${DEV_LOG}.pid"
)

DEV_PID="$(cat "${DEV_LOG}.pid" 2>/dev/null || true)"
rm -f "${DEV_LOG}.pid"

if [[ -z "${DEV_PID}" ]]; then
  echo "${RED}ERROR${RESET} could not capture dev server PID" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Poll for readiness. Vite takes ~1-3s on a warm cache, longer cold.
# ---------------------------------------------------------------------------
READY=0
for attempt in $(seq 1 60); do
  if curl -sS -o /dev/null -m 2 "${PERF_BASE}/"; then
    READY=1
    break
  fi
  if ! kill -0 "${DEV_PID}" 2>/dev/null; then
    echo "${RED}ERROR${RESET} dev server exited before becoming ready" >&2
    echo "${DIM}--- dev log (last 40 lines) ---${RESET}" >&2
    tail -40 "${DEV_LOG}" >&2 || true
    exit 1
  fi
  sleep 0.5
done

if (( READY == 0 )); then
  echo "${RED}ERROR${RESET} dev server never responded at ${PERF_BASE}" >&2
  echo "${DIM}--- dev log (last 40 lines) ---${RESET}" >&2
  tail -40 "${DEV_LOG}" >&2 || true
  exit 1
fi

echo "${DIM}Dev server ready (pid ${DEV_PID}). Probing routes...${RESET}"
echo

# ---------------------------------------------------------------------------
# Probe routes. Static-adapter SPA returns index.html for everything; keep
# the list short.
# ---------------------------------------------------------------------------
ROUTES=( "/" "/knowledge" "/skills" "/routines" "/settings" )

human_bytes() {
  awk -v b="$1" 'BEGIN {
    if (b < 1024)         { printf "%d B",       b;            exit }
    if (b < 1024*1024)    { printf "%.1f KB",    b/1024;       exit }
    printf "%.2f MB", b/(1024*1024)
  }'
}

# Run curl twice per route: once with -w for timings (we throw the body away),
# once to capture the body for resource counting.
probe_route() {
  local route="$1"
  local url="${PERF_BASE}${route}"
  local body_file="$(mktemp -t ironclaw-perf-body.XXXXXX)"
  local timing_fmt='ttfb=%{time_starttransfer} total=%{time_total} size=%{size_download} http=%{http_code}'

  local timings
  timings="$(curl -sS -o "${body_file}" -m 15 -w "${timing_fmt}" "${url}" 2>/dev/null || echo "")"

  local ttfb total size http
  ttfb=$( echo "${timings}" | awk -F'[= ]' '{ for(i=1;i<=NF;i++) if($i=="ttfb")  print $(i+1) }')
  total=$(echo "${timings}" | awk -F'[= ]' '{ for(i=1;i<=NF;i++) if($i=="total") print $(i+1) }')
  size=$( echo "${timings}" | awk -F'[= ]' '{ for(i=1;i<=NF;i++) if($i=="size")  print $(i+1) }')
  http=$( echo "${timings}" | awk -F'[= ]' '{ for(i=1;i<=NF;i++) if($i=="http")  print $(i+1) }')

  # Count critical resources from the raw HTML. SvelteKit's dev shell injects
  # <script type="module" src="...">, <link rel="stylesheet">, and module
  # preload links. grep -o emits each match on its own line so wc -l counts
  # actual occurrences, not matching lines (grep -c would miss multi-tag lines
  # which happen when SvelteKit emits everything on one minified line in prod).
  local script_count link_css modulepreload
  script_count=$(grep -o '<script\b'                    "${body_file}" 2>/dev/null | wc -l | tr -d ' ')
  link_css=$(    grep -o '<link[^>]*rel="stylesheet"'   "${body_file}" 2>/dev/null | wc -l | tr -d ' ')
  modulepreload=$(grep -o 'rel="modulepreload"'         "${body_file}" 2>/dev/null | wc -l | tr -d ' ')

  local gz_size
  gz_size=$(gzip -9 -c "${body_file}" | wc -c | tr -d ' ')

  rm -f "${body_file}"

  # Emit pipe-delimited so caller can parse.
  printf '%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
    "${route}" "${http:-?}" "${ttfb:-?}" "${total:-?}" \
    "${size:-?}" "${gz_size:-?}" \
    "${script_count:-0}" "${link_css:-0}" "${modulepreload:-0}"
}

emit() {
  printf '%b\n' "$1"
  printf '%b\n' "$1" | sed -E 's/\x1B\[[0-9;]*[mK]//g' >> "${REPORT_PATH}"
}

: > "${REPORT_PATH}"

emit "${BOLD}IronClaw desktop perf snapshot${RESET}"
emit "${DIM}generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)${RESET}"
emit "${DIM}target:    ${PERF_BASE}${RESET}"
emit "${DIM}note:      dev-mode probe; production sizes come from analyze-bundle.sh${RESET}"
emit ""
emit "${BOLD}Per-route${RESET}"
emit "$(printf '  %-14s %5s %9s %9s %12s %12s %8s %6s %8s' \
  'ROUTE' 'HTTP' 'TTFB' 'TOTAL' 'HTML' 'GZIP' 'SCRIPTS' 'CSS' 'PRELOAD')"

TOTAL_TTFB=0
TOTAL_TOTAL=0
PROBED=0
for r in "${ROUTES[@]}"; do
  row="$(probe_route "${r}")"
  IFS='|' read -r route http ttfb total size gz scripts css preload <<< "${row}"

  # Color the HTTP code.
  if [[ "${http}" == "200" ]]; then http_c="${GREEN}"; else http_c="${YELLOW}"; fi

  emit "$(printf '  %-14s %s%5s%s %8ss %8ss %12s %12s %8s %6s %8s' \
    "${route}" \
    "${http_c}" "${http}" "${RESET}" \
    "${ttfb}" "${total}" \
    "$(human_bytes "${size}")" \
    "$(human_bytes "${gz}")" \
    "${scripts}" "${css}" "${preload}")"

  # awk-based accumulation handles floating-point times safely.
  TOTAL_TTFB=$( awk -v a="${TOTAL_TTFB}"  -v b="${ttfb}"  'BEGIN { printf "%.6f", a+b }')
  TOTAL_TOTAL=$(awk -v a="${TOTAL_TOTAL}" -v b="${total}" 'BEGIN { printf "%.6f", a+b }')
  PROBED=$(( PROBED + 1 ))
done

emit ""

if (( PROBED > 0 )); then
  AVG_TTFB=$( awk -v s="${TOTAL_TTFB}"  -v n="${PROBED}" 'BEGIN { printf "%.3f", s/n }')
  AVG_TOTAL=$(awk -v s="${TOTAL_TOTAL}" -v n="${PROBED}" 'BEGIN { printf "%.3f", s/n }')
  emit "${BOLD}Summary${RESET}"
  emit "  routes probed:  ${PROBED}"
  emit "  avg TTFB:       ${AVG_TTFB}s"
  emit "  avg total:      ${AVG_TOTAL}s (approximation of page-load floor; real browsers"
  emit "                  do JS exec + module fetches on top of this)"
fi

emit ""
emit "${DIM}Report written to: ${REPORT_PATH}${RESET}"
emit "${DIM}Dev log: ${DEV_LOG} (deleted on exit unless this script was killed)${RESET}"

# Soft regression hint. Anything over 500ms TTFB in dev mode probably means
# the Vite dep optimizer is rechurning — not a real prod regression, but
# worth a glance.
if awk -v a="${AVG_TTFB}" 'BEGIN { exit (a > 0.5) ? 0 : 1 }'; then
  emit "${YELLOW}NOTE${RESET} avg TTFB > 500ms in dev mode; likely Vite dep-optimizer churn."
fi

exit 0
