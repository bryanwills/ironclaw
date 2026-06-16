#!/usr/bin/env bash
#
# Walk the SvelteKit static-adapter output and report per-file size (raw +
# gzipped) and line count, sorted by raw size. Prints a summary table to
# stdout and writes a copy to /tmp/ironclaw-bundle-report.txt.
#
# Intentionally zero deps beyond what ships with macOS / coreutils on Linux:
# gzip, wc, find, stat, awk, sort. No npm or Rust deps added.
#
# Usage:
#   bash scripts/analyze-bundle.sh           # use existing build/
#   FORCE_BUILD=1 bash scripts/analyze-bundle.sh   # always rebuild first
#
# Exit codes:
#   0  success
#   1  build/ missing and no build was run
#   2  npm run build failed

set -uo pipefail

# ---------------------------------------------------------------------------
# Resolve project root from the script location so this works regardless of
# the caller's cwd.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_DIR="${PROJECT_ROOT}/build/_app/immutable"
REPORT_PATH="${BUNDLE_REPORT:-/tmp/ironclaw-bundle-report.txt}"

# ---------------------------------------------------------------------------
# Colors (auto-disabled when stdout is not a TTY)
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  CYAN=$'\033[36m'
  YELLOW=$'\033[33m'
  GREEN=$'\033[32m'
  RED=$'\033[31m'
  RESET=$'\033[0m'
else
  BOLD="" DIM="" CYAN="" YELLOW="" GREEN="" RED="" RESET=""
fi

# ---------------------------------------------------------------------------
# Optionally run the build first. Default: only build if build/ is missing.
# ---------------------------------------------------------------------------
needs_build() {
  if [[ "${FORCE_BUILD:-0}" == "1" ]]; then
    return 0
  fi
  if [[ ! -d "${BUILD_DIR}" ]]; then
    return 0
  fi
  return 1
}

if needs_build; then
  echo "${DIM}Running npm run build...${RESET}"
  if ! ( cd "${PROJECT_ROOT}" && npm run build ); then
    echo "${RED}ERROR${RESET} npm run build failed." >&2
    exit 2
  fi
fi

if [[ ! -d "${BUILD_DIR}" ]]; then
  echo "${RED}ERROR${RESET} ${BUILD_DIR} does not exist. Run 'npm run build' first." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Cross-platform helpers. BSD (macOS) and GNU (Linux) stat differ; sniff once.
# ---------------------------------------------------------------------------
file_size() {
  # Print byte size of "$1" as a bare integer.
  if stat -f "%z" "$1" >/dev/null 2>&1; then
    stat -f "%z" "$1"
  else
    stat -c "%s" "$1"
  fi
}

gzip_size() {
  # Gzipped byte count via stdout pipe; -9 for max compression to match what
  # a real CDN would serve. wc -c on stdin is portable.
  gzip -9 -c "$1" 2>/dev/null | wc -c | tr -d ' '
}

line_count() {
  wc -l < "$1" | tr -d ' '
}

human_bytes() {
  # Render a byte count as B / KB / MB with one decimal.
  awk -v b="$1" 'BEGIN {
    if (b < 1024)         { printf "%d B",       b;            exit }
    if (b < 1024*1024)    { printf "%.1f KB",    b/1024;       exit }
    printf "%.2f MB", b/(1024*1024)
  }'
}

# ---------------------------------------------------------------------------
# Walk the immutable tree. SvelteKit's static adapter splits output into:
#   immutable/chunks/     vendor + shared
#   immutable/nodes/      per-route node bundles (numbered)
#   immutable/entry/      app + start
#   immutable/assets/     CSS + fonts + images
# We treat each file as a row and tag it with its top-level node name.
# ---------------------------------------------------------------------------
TMP_ROWS="$(mktemp -t ironclaw-bundle-rows.XXXXXX)"
trap 'rm -f "${TMP_ROWS}"' EXIT

while IFS= read -r abs_path; do
  rel="${abs_path#${PROJECT_ROOT}/build/}"
  # Top-level node = first dir under immutable/, e.g. chunks / nodes / entry.
  node="$(echo "${rel}" | awk -F/ '{print $3}')"
  raw="$(file_size "${abs_path}")"
  gz="$(gzip_size "${abs_path}")"
  lines="$(line_count "${abs_path}")"
  # Pipe-delimited row: node|raw|gzip|lines|relpath
  printf '%s|%s|%s|%s|%s\n' "${node}" "${raw}" "${gz}" "${lines}" "${rel}" >> "${TMP_ROWS}"
done < <(find "${BUILD_DIR}" -type f)

if [[ ! -s "${TMP_ROWS}" ]]; then
  echo "${RED}ERROR${RESET} no files found under ${BUILD_DIR}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Render report. Same content goes to stdout (color) and report file (plain).
# We build the plain version first, then optionally print colored to TTY.
# ---------------------------------------------------------------------------
TOTAL_RAW=0
TOTAL_GZ=0
TOTAL_FILES=0

# Per-node totals (parallel arrays keyed by index)
declare -a NODE_NAMES NODE_RAW NODE_GZ NODE_COUNT

bump_node() {
  local node="$1" raw="$2" gz="$3"
  local i
  for i in "${!NODE_NAMES[@]}"; do
    if [[ "${NODE_NAMES[$i]}" == "${node}" ]]; then
      NODE_RAW[$i]=$(( NODE_RAW[i] + raw ))
      NODE_GZ[$i]=$(( NODE_GZ[i]  + gz  ))
      NODE_COUNT[$i]=$(( NODE_COUNT[i] + 1 ))
      return
    fi
  done
  NODE_NAMES+=("${node}")
  NODE_RAW+=("${raw}")
  NODE_GZ+=("${gz}")
  NODE_COUNT+=(1)
}

while IFS='|' read -r node raw gz lines rel; do
  TOTAL_RAW=$(( TOTAL_RAW + raw ))
  TOTAL_GZ=$(( TOTAL_GZ + gz ))
  TOTAL_FILES=$(( TOTAL_FILES + 1 ))
  bump_node "${node}" "${raw}" "${gz}"
done < "${TMP_ROWS}"

# Render: write plain to report file, also echo to stdout with color.
emit() {
  # Print to both stdout (colored) and report file (stripped).
  printf '%b\n' "$1"
  printf '%b\n' "$1" | sed -E 's/\x1B\[[0-9;]*[mK]//g' >> "${REPORT_PATH}"
}

: > "${REPORT_PATH}"

emit "${BOLD}IronClaw desktop bundle report${RESET}"
emit "${DIM}generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)${RESET}"
emit "${DIM}root:      ${BUILD_DIR}${RESET}"
emit ""

# Per-node summary
emit "${BOLD}Per-node totals${RESET}"
emit "$(printf '  %-10s %8s %12s %12s' 'NODE' 'FILES' 'RAW' 'GZIP')"
for i in "${!NODE_NAMES[@]}"; do
  emit "$(printf '  %-10s %8s %12s %12s' \
    "${NODE_NAMES[$i]}" \
    "${NODE_COUNT[$i]}" \
    "$(human_bytes "${NODE_RAW[$i]}")" \
    "$(human_bytes "${NODE_GZ[$i]}")")"
done
emit ""

# Top 5 largest files (by raw bytes)
emit "${BOLD}Top 5 largest files (by raw)${RESET}"
emit "$(printf '  %-12s %12s %12s  %s' 'NODE' 'RAW' 'GZIP' 'PATH')"
while IFS='|' read -r node raw gz lines rel; do
  emit "$(printf '  %-12s %12s %12s  %s' \
    "${node}" \
    "$(human_bytes "${raw}")" \
    "$(human_bytes "${gz}")" \
    "${rel}")"
done < <(sort -t'|' -k2,2 -rn "${TMP_ROWS}" | head -5)
emit ""

# Full table, sorted by raw size desc
emit "${BOLD}All files (sorted by raw size desc)${RESET}"
emit "$(printf '  %-10s %10s %10s %8s  %s' 'NODE' 'RAW' 'GZIP' 'LINES' 'PATH')"
while IFS='|' read -r node raw gz lines rel; do
  emit "$(printf '  %-10s %10s %10s %8s  %s' \
    "${node}" \
    "$(human_bytes "${raw}")" \
    "$(human_bytes "${gz}")" \
    "${lines}" \
    "${rel}")"
done < <(sort -t'|' -k2,2 -rn "${TMP_ROWS}")
emit ""

# Grand total
emit "${BOLD}Totals${RESET}"
emit "  files:        ${TOTAL_FILES}"
emit "  raw bytes:    ${TOTAL_RAW} ($(human_bytes "${TOTAL_RAW}"))"
emit "  gzip bytes:   ${TOTAL_GZ} ($(human_bytes "${TOTAL_GZ}"))"
ratio="$(awk -v g="${TOTAL_GZ}" -v r="${TOTAL_RAW}" \
  'BEGIN { if (r==0) print "n/a"; else printf "%.1f%%", 100*g/r }')"
emit "  gzip ratio:   ${ratio}"
emit ""
emit "${DIM}Report written to: ${REPORT_PATH}${RESET}"

exit 0
