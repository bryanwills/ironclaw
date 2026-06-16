#!/usr/bin/env bash
#
# Enforce gzipped-size budgets on the SvelteKit build output. The primary
# "total" gate is the largest eager route graph: entry + app shell + layout
# nodes + the selected route node + their static imports. Lazy route chunks are
# checked per route instead of being summed into the startup budget.
#
# Designed to be cheap, deterministic, and CI-friendly. No deps beyond what
# ships with bash + gzip + awk + find. Pairs with scripts/analyze-bundle.sh
# (per-file walk) and scripts/bundle-compare.sh (diff vs baseline) — those are
# diagnostic, this one is the gate.
#
# Usage:
#   bash scripts/check-bundle-size.sh
#   SKIP_BUILD=1 bash scripts/check-bundle-size.sh   # use existing build/
#   BUNDLE_BUDGET=path/to/other.json bash scripts/check-bundle-size.sh
#
# Exit codes:
#   0  under budget
#   1  over budget (any of: total, entry, largest chunk)
#   2  within 90% of budget (warning, non-blocking — caller can choose)
#   3  build failed
#   4  budget file missing or malformed
#   5  build output missing

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_DIR="${PROJECT_ROOT}/build/_app/immutable"
BUDGET_FILE="${BUNDLE_BUDGET:-${SCRIPT_DIR}/bundle-budget.json}"

# ---------------------------------------------------------------------------
# Colors (auto-disabled when stdout is not a TTY or NO_COLOR is set)
# ---------------------------------------------------------------------------
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
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
# Run the build unless the caller opted out. CI usually has just built and
# can skip to save ~30s.
# ---------------------------------------------------------------------------
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "${DIM}Running npm run build...${RESET}"
  if ! ( cd "${PROJECT_ROOT}" && npm run build > /tmp/check-bundle-size-build.log 2>&1 ); then
    echo "${RED}ERROR${RESET} npm run build failed. Tail:" >&2
    tail -20 /tmp/check-bundle-size-build.log >&2
    exit 3
  fi
fi

if [[ ! -d "${BUILD_DIR}" ]]; then
  echo "${RED}ERROR${RESET} no build output at ${BUILD_DIR} (run 'npm run build' first)" >&2
  exit 5
fi

if [[ ! -f "${BUDGET_FILE}" ]]; then
  echo "${RED}ERROR${RESET} budget file not found: ${BUDGET_FILE}" >&2
  exit 4
fi

# ---------------------------------------------------------------------------
# Parse the budget file. Pure-awk, no jq dep. Keys we care about:
#   total_gzip_kb, entry_gzip_kb, largest_chunk_gzip_kb, route_gzip_kb
# Missing keys default to 0 which means "no limit" (won't trip).
# ---------------------------------------------------------------------------
parse_budget_key() {
  local key="$1"
  awk -v key="${key}" '
    {
      # Strip line comments-as-keys (e.g. "_comment").
      pat = "\"" key "\"[[:space:]]*:[[:space:]]*([0-9]+)"
      if (match($0, pat, m)) { print m[1]; exit }
    }
  ' "${BUDGET_FILE}"
}

# gawk's match() with capture groups doesn't work on macOS awk; fall back to
# sed/grep on the canonical JSON formatting we expect.
read_budget() {
  local key="$1"
  local val
  val=$(grep -E "\"${key}\"[[:space:]]*:[[:space:]]*[0-9]+" "${BUDGET_FILE}" \
        | head -1 \
        | sed -E "s/.*\"${key}\"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/")
  if [[ -z "${val}" ]]; then
    echo 0
  else
    echo "${val}"
  fi
}

BUDGET_TOTAL_KB=$(read_budget total_gzip_kb)
BUDGET_ENTRY_KB=$(read_budget entry_gzip_kb)
BUDGET_LARGEST_KB=$(read_budget largest_chunk_gzip_kb)
BUDGET_ROUTE_KB=$(read_budget route_gzip_kb)

if (( BUDGET_TOTAL_KB == 0 && BUDGET_ENTRY_KB == 0 && BUDGET_LARGEST_KB == 0 )); then
  echo "${RED}ERROR${RESET} no budget keys found in ${BUDGET_FILE}" >&2
  echo "${DIM}Expected: total_gzip_kb, entry_gzip_kb, largest_chunk_gzip_kb${RESET}" >&2
  exit 4
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
gzip_size() {
  # Gzipped byte count for "$1". -9 to match what a real CDN would serve.
  gzip -9 -c "$1" 2>/dev/null | wc -c | tr -d ' '
}

# Bytes -> KB with one decimal. Pure awk so it matches the budget unit.
to_kb() {
  awk -v b="$1" 'BEGIN { printf "%.1f", b/1024 }'
}

# Color picker based on usage ratio (0-100).
color_for_pct() {
  local pct_int
  pct_int=$(awk -v p="$1" 'BEGIN { printf "%d", p }')
  if   (( pct_int >= 100 )); then printf '%s' "${RED}"
  elif (( pct_int >= 90  )); then printf '%s' "${YELLOW}"
  else                            printf '%s' "${GREEN}"
  fi
}

status_label() {
  local pct_int
  pct_int=$(awk -v p="$1" 'BEGIN { printf "%d", p }')
  if   (( pct_int >= 100 )); then printf '%s' "OVER"
  elif (( pct_int >= 90  )); then printf '%s' "WARN"
  else                            printf '%s' "OK"
  fi
}

worst_state() {
  local s1="$1" s2="$2"
  # OVER > WARN > OK
  if [[ "${s1}" == "OVER" || "${s2}" == "OVER" ]]; then echo "OVER"; return; fi
  if [[ "${s1}" == "WARN" || "${s2}" == "WARN" ]]; then echo "WARN"; return; fi
  echo "OK"
}

# ---------------------------------------------------------------------------
# Sum the three JS scopes. Use find so a missing dir doesn't break the script.
# ---------------------------------------------------------------------------
TOTAL_BYTES=0
ENTRY_BYTES=0
LARGEST_BYTES=0
LARGEST_PATH=""
FILE_COUNT=0

while IFS= read -r f; do
  [[ -z "${f}" ]] && continue
  sz=$(gzip_size "${f}")
  TOTAL_BYTES=$(( TOTAL_BYTES + sz ))
  FILE_COUNT=$(( FILE_COUNT + 1 ))
  case "${f}" in
    "${BUILD_DIR}/entry/"*) ENTRY_BYTES=$(( ENTRY_BYTES + sz )) ;;
  esac
  if (( sz > LARGEST_BYTES )); then
    LARGEST_BYTES=${sz}
    LARGEST_PATH="${f#${PROJECT_ROOT}/build/}"
  fi
done < <(find "${BUILD_DIR}/entry" "${BUILD_DIR}/chunks" "${BUILD_DIR}/nodes" \
              -type f -name '*.js' 2>/dev/null | sort)

if (( FILE_COUNT == 0 )); then
  echo "${RED}ERROR${RESET} no .js files found under entry/, chunks/, or nodes/" >&2
  exit 5
fi

TOTAL_KB=$(to_kb "${TOTAL_BYTES}")
ENTRY_KB=$(to_kb "${ENTRY_BYTES}")
LARGEST_KB=$(to_kb "${LARGEST_BYTES}")

ALL_JS_BYTES=${TOTAL_BYTES}
ALL_JS_KB=${TOTAL_KB}

# ---------------------------------------------------------------------------
# SvelteKit route graph budgets. The final static build does not copy Vite's
# manifest, but it remains under .svelte-kit/output/client after `npm run
# build`. Use it when present to measure actual eager downloads per route.
# ---------------------------------------------------------------------------
ROUTE_ROWS=""
ROUTE_MAX_BYTES=0
ROUTE_MAX_PATH=""
MANIFEST_PATH="${PROJECT_ROOT}/.svelte-kit/output/client/.vite/manifest.json"
APP_JS_PATH="${PROJECT_ROOT}/.svelte-kit/generated/client-optimized/app.js"

if [[ -f "${MANIFEST_PATH}" && -f "${APP_JS_PATH}" ]]; then
  ROUTE_TMP="$(mktemp -t ironclaw-route-rows.XXXXXX)"
  PROJECT_ROOT="${PROJECT_ROOT}" node <<'NODE' > "${ROUTE_TMP}"
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const projectRoot = process.env.PROJECT_ROOT;
const clientRoot = path.join(projectRoot, '.svelte-kit/output/client');
const manifest = JSON.parse(
  fs.readFileSync(path.join(clientRoot, '.vite/manifest.json'), 'utf8')
);
const appSource = fs.readFileSync(
  path.join(projectRoot, '.svelte-kit/generated/client-optimized/app.js'),
  'utf8'
);

const dictionaryMatch = appSource.match(/export const dictionary = \{([\s\S]*?)\n\t\};/);
if (!dictionaryMatch) process.exit(0);

const routes = [];
for (const match of dictionaryMatch[1].matchAll(/"([^"]+)": \[([0-9]+)\]/g)) {
  routes.push([match[1], Number(match[2])]);
}

const gzipMemo = new Map();
function gzipSize(file) {
  if (!gzipMemo.has(file)) {
    const body = fs.readFileSync(path.join(clientRoot, file));
    gzipMemo.set(file, zlib.gzipSync(body, { level: 9 }).length);
  }
  return gzipMemo.get(file);
}

function walk(keys) {
  const seen = new Set();
  const stack = [...keys];
  let bytes = 0;
  while (stack.length > 0) {
    const key = stack.pop();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry = manifest[key];
    if (!entry) continue;
    bytes += gzipSize(entry.file);
    for (const imported of entry.imports ?? []) stack.push(imported);
  }
  return bytes;
}

const startKey = '../../node_modules/@sveltejs/kit/src/runtime/client/entry.js';
const appKey = '.svelte-kit/generated/client-optimized/app.js';
const layoutKeys = [
  '.svelte-kit/generated/client-optimized/nodes/0.js',
  '.svelte-kit/generated/client-optimized/nodes/1.js'
];

for (const [route, node] of routes) {
  const nodeKey = `.svelte-kit/generated/client-optimized/nodes/${node}.js`;
  const bytes = walk([startKey, appKey, ...layoutKeys, nodeKey]);
  console.log(`${route}|${bytes}`);
}
NODE
  ROUTE_ROWS="$(cat "${ROUTE_TMP}")"
  rm -f "${ROUTE_TMP}"

  while IFS='|' read -r route bytes; do
    [[ -z "${route}" || -z "${bytes}" ]] && continue
    if (( bytes > ROUTE_MAX_BYTES )); then
      ROUTE_MAX_BYTES=${bytes}
      ROUTE_MAX_PATH=${route}
    fi
  done <<< "${ROUTE_ROWS}"

  if (( ROUTE_MAX_BYTES > 0 )); then
    TOTAL_BYTES=${ROUTE_MAX_BYTES}
    TOTAL_KB=$(to_kb "${TOTAL_BYTES}")
  fi
fi

# ---------------------------------------------------------------------------
# Compute usage percentages. If a budget is 0 we treat it as disabled (0%).
# ---------------------------------------------------------------------------
pct_of_budget() {
  local actual_kb="$1" budget_kb="$2"
  if (( budget_kb == 0 )); then
    echo "0.0"
  else
    awk -v a="${actual_kb}" -v b="${budget_kb}" 'BEGIN { printf "%.1f", 100*a/b }'
  fi
}

TOTAL_PCT=$(pct_of_budget "${TOTAL_KB}" "${BUDGET_TOTAL_KB}")
ENTRY_PCT=$(pct_of_budget "${ENTRY_KB}" "${BUDGET_ENTRY_KB}")
LARGEST_PCT=$(pct_of_budget "${LARGEST_KB}" "${BUDGET_LARGEST_KB}")
ROUTE_STATUS=OK
if [[ -n "${ROUTE_ROWS}" && "${BUDGET_ROUTE_KB}" != "0" ]]; then
  while IFS='|' read -r route bytes; do
    [[ -z "${route}" || -z "${bytes}" ]] && continue
    route_kb=$(to_kb "${bytes}")
    route_pct=$(pct_of_budget "${route_kb}" "${BUDGET_ROUTE_KB}")
    route_status=$(status_label "${route_pct}")
    ROUTE_STATUS=$(worst_state "${ROUTE_STATUS}" "${route_status}")
  done <<< "${ROUTE_ROWS}"
fi

# ---------------------------------------------------------------------------
# Render the report. Column-aligned, color per row, single-line summary at
# the end so CI logs are scannable.
# ---------------------------------------------------------------------------
echo
echo "${BOLD}Bundle size check${RESET}  ${DIM}(gzipped eager route JS; lazy chunks checked per route)${RESET}"
echo "${DIM}budget: ${BUDGET_FILE##*/}   build: ${FILE_COUNT} files under ${BUILD_DIR##*/Users/}${RESET}"
echo "${DIM}all emitted JS: ${ALL_JS_KB} KB gzip across entry/chunks/nodes${RESET}"
echo
printf '  %-18s %10s %10s %8s   %s\n' 'METRIC' 'ACTUAL' 'BUDGET' 'USAGE' 'STATUS'
printf '  %-18s %10s %10s %8s   %s\n' '------' '------' '------' '-----' '------'

emit_row() {
  local label="$1" actual_kb="$2" budget_kb="$3" pct="$4" extra="${5:-}"
  local color status
  color=$(color_for_pct "${pct}")
  status=$(status_label "${pct}")
  printf '  %-18s %9s %10s %7s   %s%s%s%s\n' \
    "${label}" \
    "${actual_kb} KB" \
    "${budget_kb} KB" \
    "${pct}%" \
    "${color}" "${status}" "${RESET}" \
    "${extra:+  ${DIM}${extra}${RESET}}"
}

emit_row "total"          "${TOTAL_KB}"   "${BUDGET_TOTAL_KB}"   "${TOTAL_PCT}" "${ROUTE_MAX_PATH:+max route ${ROUTE_MAX_PATH}}"
emit_row "entry"          "${ENTRY_KB}"   "${BUDGET_ENTRY_KB}"   "${ENTRY_PCT}"
emit_row "largest chunk"  "${LARGEST_KB}" "${BUDGET_LARGEST_KB}" "${LARGEST_PCT}" "${LARGEST_PATH##*/}"
echo

if [[ -n "${ROUTE_ROWS}" ]]; then
  echo "${BOLD}Per-route eager load${RESET}"
  printf '  %-22s %10s %10s %8s   %s\n' 'ROUTE' 'ACTUAL' 'BUDGET' 'USAGE' 'STATUS'
  printf '  %-22s %10s %10s %8s   %s\n' '-----' '------' '------' '-----' '------'
  while IFS='|' read -r route bytes; do
    [[ -z "${route}" || -z "${bytes}" ]] && continue
    route_kb=$(to_kb "${bytes}")
    route_pct=$(pct_of_budget "${route_kb}" "${BUDGET_ROUTE_KB}")
    emit_row "${route}" "${route_kb}" "${BUDGET_ROUTE_KB}" "${route_pct}"
  done <<< "${ROUTE_ROWS}"
  echo
fi

# ---------------------------------------------------------------------------
# Decide exit code. OVER wins over WARN, WARN wins over OK.
# A metric with budget=0 is disabled and never trips.
# ---------------------------------------------------------------------------
TOTAL_STATUS=$(status_label "${TOTAL_PCT}")
ENTRY_STATUS=$(status_label "${ENTRY_PCT}")
LARGEST_STATUS=$(status_label "${LARGEST_PCT}")

# Budget=0 means metric is disabled — don't let it dominate the verdict.
[[ "${BUDGET_TOTAL_KB}"   == "0" ]] && TOTAL_STATUS=OK
[[ "${BUDGET_ENTRY_KB}"   == "0" ]] && ENTRY_STATUS=OK
[[ "${BUDGET_LARGEST_KB}" == "0" ]] && LARGEST_STATUS=OK
[[ "${BUDGET_ROUTE_KB}"   == "0" ]] && ROUTE_STATUS=OK

WORST=$(worst_state "${TOTAL_STATUS}" "$(worst_state "${ENTRY_STATUS}" "$(worst_state "${LARGEST_STATUS}" "${ROUTE_STATUS}")")")

case "${WORST}" in
  OVER)
    echo "${RED}${BOLD}FAIL${RESET}  bundle is over budget."
    echo
    [[ "${TOTAL_STATUS}"   == "OVER" ]] && echo "  ${RED}> total${RESET}         ${TOTAL_KB} KB / ${BUDGET_TOTAL_KB} KB   (over by $(awk -v a=${TOTAL_KB} -v b=${BUDGET_TOTAL_KB} 'BEGIN{printf "%.1f", a-b}') KB)"
    [[ "${ENTRY_STATUS}"   == "OVER" ]] && echo "  ${RED}> entry${RESET}         ${ENTRY_KB} KB / ${BUDGET_ENTRY_KB} KB   (over by $(awk -v a=${ENTRY_KB} -v b=${BUDGET_ENTRY_KB} 'BEGIN{printf "%.1f", a-b}') KB)"
    [[ "${LARGEST_STATUS}" == "OVER" ]] && echo "  ${RED}> largest chunk${RESET} ${LARGEST_KB} KB / ${BUDGET_LARGEST_KB} KB   ${DIM}${LARGEST_PATH}${RESET}"
    [[ "${ROUTE_STATUS}"   == "OVER" ]] && echo "  ${RED}> route eager load${RESET} exceeded ${BUDGET_ROUTE_KB} KB"
    echo
    echo "  ${DIM}Inspect what grew:   bash scripts/analyze-bundle.sh${RESET}"
    echo "  ${DIM}Diff vs baseline:    bash scripts/bundle-compare.sh${RESET}"
    echo "  ${DIM}Accept the new size: edit ${BUDGET_FILE##*/Users/} (see README 'Bundle analysis')${RESET}"
    exit 1
    ;;
  WARN)
    echo "${YELLOW}${BOLD}WARN${RESET}  bundle within 10% of budget. Plan ahead before the next dep lands."
    exit 2
    ;;
  *)
    echo "${GREEN}${BOLD}OK${RESET}    bundle under budget."
    exit 0
    ;;
esac
