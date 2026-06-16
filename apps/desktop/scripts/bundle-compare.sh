#!/usr/bin/env bash
#
# Run the bundle analyzer and diff the current build against
# scripts/bundle-baseline.json. Prints added / removed files and per-file +
# total size changes, with thresholds for what counts as "significant."
#
# Usage:
#   bash scripts/bundle-compare.sh
#   BUNDLE_BASELINE=path/to/other.json bash scripts/bundle-compare.sh
#   UPDATE_BASELINE=1 bash scripts/bundle-compare.sh   # overwrite baseline
#
# Exit codes:
#   0  success (no significant regression OR UPDATE_BASELINE=1)
#   1  baseline file missing
#   2  analyzer failed
#   3  significant regression (>10% gzip total or top-5 file grew >25%)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_DIR="${PROJECT_ROOT}/build/_app/immutable"
BASELINE="${BUNDLE_BASELINE:-${SCRIPT_DIR}/bundle-baseline.json}"

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  CYAN=$'\033[36m'
  RESET=$'\033[0m'
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" CYAN="" RESET=""
fi

# ---------------------------------------------------------------------------
# Run the analyzer first so we know the build is fresh and the report file is
# regenerated. The analyzer is idempotent and cheap.
# ---------------------------------------------------------------------------
echo "${DIM}Running analyzer...${RESET}"
if ! bash "${SCRIPT_DIR}/analyze-bundle.sh" > /dev/null; then
  echo "${RED}ERROR${RESET} analyze-bundle.sh failed" >&2
  exit 2
fi

if [[ ! -d "${BUILD_DIR}" ]]; then
  echo "${RED}ERROR${RESET} no build output at ${BUILD_DIR}" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
file_size() {
  if stat -f "%z" "$1" >/dev/null 2>&1; then
    stat -f "%z" "$1"
  else
    stat -c "%s" "$1"
  fi
}

gzip_size() {
  gzip -9 -c "$1" 2>/dev/null | wc -c | tr -d ' '
}

human_bytes() {
  awk -v b="$1" 'BEGIN {
    if (b < 1024)         { printf "%d B",       b;            exit }
    if (b < 1024*1024)    { printf "%.1f KB",    b/1024;       exit }
    printf "%.2f MB", b/(1024*1024)
  }'
}

# Render a +X.X% or -X.X% delta (with sign).
pct_delta() {
  awk -v new="$1" -v old="$2" 'BEGIN {
    if (old == 0) { print "n/a"; exit }
    d = 100.0 * (new - old) / old
    if (d > 0) printf "+%.1f%%", d
    else       printf "%.1f%%",  d
  }'
}

# Render a signed byte delta in human units.
signed_bytes() {
  local d="$1"
  if (( d >= 0 )); then
    printf "+%s" "$(human_bytes "${d}")"
  else
    # human_bytes takes positive input
    printf -- "-%s" "$(human_bytes "$(( -d ))")"
  fi
}

# ---------------------------------------------------------------------------
# Walk the current build into a flat "path raw gzip" file (sorted by path).
# ---------------------------------------------------------------------------
CURRENT="$(mktemp -t ironclaw-bundle-current.XXXXXX)"
trap 'rm -f "${CURRENT}" "${BASELINE_FLAT:-}"' EXIT

while IFS= read -r abs_path; do
  rel="${abs_path#${PROJECT_ROOT}/build/}"
  printf '%s %s %s\n' "${rel}" "$(file_size "${abs_path}")" "$(gzip_size "${abs_path}")" >> "${CURRENT}"
done < <(find "${BUILD_DIR}" -type f)

sort -o "${CURRENT}" "${CURRENT}"

CURRENT_TOTAL_RAW=$(awk '{ s+=$2 } END { print s+0 }' "${CURRENT}")
CURRENT_TOTAL_GZ=$( awk '{ s+=$3 } END { print s+0 }' "${CURRENT}")

# ---------------------------------------------------------------------------
# Allow updating the baseline with the current build (intentional, manual).
# ---------------------------------------------------------------------------
if [[ "${UPDATE_BASELINE:-0}" == "1" ]]; then
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  {
    printf '{\n'
    printf '  "timestamp": "%s",\n' "${TS}"
    printf '  "total_raw_bytes": %s,\n'  "${CURRENT_TOTAL_RAW}"
    printf '  "total_gzip_bytes": %s,\n' "${CURRENT_TOTAL_GZ}"
    printf '  "files": [\n'
    awk '{ printf "    { \"path\": \"%s\", \"raw\": %s, \"gzip\": %s }%s\n", $1, $2, $3, (NR==N?"":",") }' \
      N="$(wc -l < "${CURRENT}" | tr -d ' ')" "${CURRENT}"
    printf '  ]\n'
    printf '}\n'
  } > "${BASELINE}"
  echo "${GREEN}OK${RESET} baseline rewritten: ${BASELINE}"
  exit 0
fi

# ---------------------------------------------------------------------------
# Load the baseline into the same "path raw gzip" shape so we can join.
# JSON parsing in pure shell would be brittle; awk on the canonical formatting
# we wrote is safe. If somebody hand-edits the baseline, that's on them.
# ---------------------------------------------------------------------------
if [[ ! -f "${BASELINE}" ]]; then
  echo "${RED}ERROR${RESET} baseline not found: ${BASELINE}" >&2
  echo "${DIM}To create one: UPDATE_BASELINE=1 bash scripts/bundle-compare.sh${RESET}" >&2
  exit 1
fi

BASELINE_FLAT="$(mktemp -t ironclaw-bundle-base.XXXXXX)"
awk '
  /"files"/ { in_files = 1; next }
  in_files && /"path"/ {
    # Pull "path": "...", "raw": N, "gzip": N from each entry line.
    match($0, /"path":[[:space:]]*"[^"]*"/)
    path = substr($0, RSTART+9, RLENGTH-10); gsub(/^[[:space:]]*"|"$/, "", path)
    match($0, /"raw":[[:space:]]*[0-9]+/)
    raw = substr($0, RSTART+6, RLENGTH-6); gsub(/[^0-9]/, "", raw)
    match($0, /"gzip":[[:space:]]*[0-9]+/)
    gz  = substr($0, RSTART+7, RLENGTH-7); gsub(/[^0-9]/, "", gz)
    print path, raw, gz
  }
' "${BASELINE}" | sort > "${BASELINE_FLAT}"

BASELINE_TOTAL_RAW=$(awk '{ s+=$2 } END { print s+0 }' "${BASELINE_FLAT}")
BASELINE_TOTAL_GZ=$( awk '{ s+=$3 } END { print s+0 }' "${BASELINE_FLAT}")

# ---------------------------------------------------------------------------
# Diff. join requires sorted input on the same key (path) and emits matches
# only; we run two anti-joins for added/removed.
# ---------------------------------------------------------------------------
ADDED="$(  comm -23 <(awk '{print $1}' "${CURRENT}")      <(awk '{print $1}' "${BASELINE_FLAT}"))"
REMOVED="$(comm -13 <(awk '{print $1}' "${CURRENT}")      <(awk '{print $1}' "${BASELINE_FLAT}"))"
SHARED_PATHS="$(comm -12 <(awk '{print $1}' "${CURRENT}") <(awk '{print $1}' "${BASELINE_FLAT}"))"

echo
echo "${BOLD}Bundle diff vs ${BASELINE##*/}${RESET}"
echo "${DIM}baseline: $(grep -o '"timestamp":[[:space:]]*"[^"]*"' "${BASELINE}" | head -1)${RESET}"
echo

# Totals row
RAW_DELTA=$(( CURRENT_TOTAL_RAW - BASELINE_TOTAL_RAW ))
GZ_DELTA=$(( CURRENT_TOTAL_GZ  - BASELINE_TOTAL_GZ  ))
RAW_PCT="$(pct_delta "${CURRENT_TOTAL_RAW}" "${BASELINE_TOTAL_RAW}")"
GZ_PCT="$( pct_delta "${CURRENT_TOTAL_GZ}"  "${BASELINE_TOTAL_GZ}" )"

color_for_delta() {
  local d="$1"
  if   (( d >  0 )); then printf '%s' "${YELLOW}"
  elif (( d == 0 )); then printf '%s' "${DIM}"
  else                    printf '%s' "${GREEN}"
  fi
}

echo "${BOLD}Totals${RESET}"
printf '  raw   %12s -> %12s  %s%-10s%s  (%s)\n' \
  "$(human_bytes "${BASELINE_TOTAL_RAW}")" \
  "$(human_bytes "${CURRENT_TOTAL_RAW}")" \
  "$(color_for_delta "${RAW_DELTA}")" "$(signed_bytes "${RAW_DELTA}")" "${RESET}" \
  "${RAW_PCT}"
printf '  gzip  %12s -> %12s  %s%-10s%s  (%s)\n' \
  "$(human_bytes "${BASELINE_TOTAL_GZ}")" \
  "$(human_bytes "${CURRENT_TOTAL_GZ}")" \
  "$(color_for_delta "${GZ_DELTA}")" "$(signed_bytes "${GZ_DELTA}")" "${RESET}" \
  "${GZ_PCT}"
echo

# Added files
if [[ -n "${ADDED}" ]]; then
  echo "${BOLD}${YELLOW}Added (${RESET}${BOLD}$(echo "${ADDED}" | grep -c .)${YELLOW})${RESET}"
  while IFS= read -r p; do
    [[ -z "${p}" ]] && continue
    row="$(grep -F " ${p%% *}" "${CURRENT}" 2>/dev/null | head -1)"
    row="$(awk -v target="${p}" '$1==target {print; exit}' "${CURRENT}")"
    raw=$(echo "${row}" | awk '{print $2}')
    gz=$( echo "${row}" | awk '{print $3}')
    printf '  %s+ %-50s%s  raw %10s  gzip %10s\n' \
      "${YELLOW}" "${p}" "${RESET}" \
      "$(human_bytes "${raw}")" "$(human_bytes "${gz}")"
  done <<< "${ADDED}"
  echo
fi

# Removed files
if [[ -n "${REMOVED}" ]]; then
  echo "${BOLD}${GREEN}Removed (${RESET}${BOLD}$(echo "${REMOVED}" | grep -c .)${GREEN})${RESET}"
  while IFS= read -r p; do
    [[ -z "${p}" ]] && continue
    row="$(awk -v target="${p}" '$1==target {print; exit}' "${BASELINE_FLAT}")"
    raw=$(echo "${row}" | awk '{print $2}')
    gz=$( echo "${row}" | awk '{print $3}')
    printf '  %s- %-50s%s  raw %10s  gzip %10s\n' \
      "${GREEN}" "${p}" "${RESET}" \
      "$(human_bytes "${raw}")" "$(human_bytes "${gz}")"
  done <<< "${REMOVED}"
  echo
fi

# Changed files (size delta on shared paths). Hash-name churn means most
# "changes" actually surface as added+removed pairs; only paths that survive
# rebuild without rename show up here (e.g. stable entry chunks).
CHANGED_ROWS="$(mktemp -t ironclaw-bundle-changed.XXXXXX)"
trap 'rm -f "${CURRENT}" "${BASELINE_FLAT:-}" "${CHANGED_ROWS}"' EXIT

while IFS= read -r p; do
  [[ -z "${p}" ]] && continue
  cur="$( awk -v target="${p}" '$1==target {print; exit}' "${CURRENT}")"
  base="$(awk -v target="${p}" '$1==target {print; exit}' "${BASELINE_FLAT}")"
  craw=$(echo "${cur}"  | awk '{print $2}')
  cgz=$( echo "${cur}"  | awk '{print $3}')
  braw=$(echo "${base}" | awk '{print $2}')
  bgz=$( echo "${base}" | awk '{print $3}')
  if [[ "${craw}" != "${braw}" || "${cgz}" != "${bgz}" ]]; then
    d_raw=$(( craw - braw ))
    d_gz=$(( cgz - bgz ))
    printf '%s|%s|%s|%s|%s|%s|%s\n' "${p}" "${braw}" "${craw}" "${d_raw}" "${bgz}" "${cgz}" "${d_gz}" >> "${CHANGED_ROWS}"
  fi
done <<< "${SHARED_PATHS}"

if [[ -s "${CHANGED_ROWS}" ]]; then
  echo "${BOLD}Changed (size delta on stable paths)${RESET}"
  printf '  %-50s %12s %12s %12s\n' 'PATH' 'BASELINE' 'CURRENT' 'DELTA'
  # Sort by abs(delta_raw) desc.
  awk -F'|' '{ d=$4; if (d<0) d=-d; print d "|" $0 }' "${CHANGED_ROWS}" \
    | sort -t'|' -k1,1 -rn \
    | cut -d'|' -f2- \
    | while IFS='|' read -r p braw craw d_raw bgz cgz d_gz; do
        c="$(color_for_delta "${d_raw}")"
        printf '  %-50s %12s %12s  %s%-12s%s\n' \
          "${p}" \
          "$(human_bytes "${braw}")" \
          "$(human_bytes "${craw}")" \
          "${c}" "$(signed_bytes "${d_raw}")" "${RESET}"
      done
  echo
fi

# ---------------------------------------------------------------------------
# Regression gate. Trigger on either total-gzip growth >10% or any single
# stable-path file growing >25% (top-5 emphasis is implicit: only the big
# stable chunks would breach 25% in absolute terms worth caring about).
# ---------------------------------------------------------------------------
REGRESS=0

if (( BASELINE_TOTAL_GZ > 0 )); then
  gz_growth_pct=$(awk -v new="${CURRENT_TOTAL_GZ}" -v old="${BASELINE_TOTAL_GZ}" \
    'BEGIN { printf "%.1f", 100*(new-old)/old }')
  if awk -v p="${gz_growth_pct}" 'BEGIN { exit (p > 10.0) ? 0 : 1 }'; then
    echo "${RED}REGRESSION${RESET} total gzip grew ${gz_growth_pct}% (threshold 10%)"
    REGRESS=1
  fi
fi

if [[ -s "${CHANGED_ROWS}" ]]; then
  while IFS='|' read -r p braw craw d_raw bgz cgz d_gz; do
    if (( braw > 0 )); then
      pct=$(awk -v n="${craw}" -v o="${braw}" 'BEGIN { printf "%.1f", 100*(n-o)/o }')
      if awk -v p="${pct}" 'BEGIN { exit (p > 25.0) ? 0 : 1 }'; then
        echo "${RED}REGRESSION${RESET} ${p} grew ${pct}% (threshold 25%)"
        REGRESS=1
      fi
    fi
  done < "${CHANGED_ROWS}"
fi

if (( REGRESS == 0 )); then
  echo "${GREEN}OK${RESET} no significant regression."
  exit 0
else
  echo
  echo "${DIM}To accept the new sizes as the new baseline:${RESET}"
  echo "${DIM}  UPDATE_BASELINE=1 bash scripts/bundle-compare.sh${RESET}"
  exit 3
fi
