#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

ALLOWLIST='(^|/)(tailwind\.config\.(js|cjs|mjs|ts)|src/app\.css)(:|$)'

if [ "$#" -gt 0 ]; then
  SEARCH_PATHS=("$@")
else
  SEARCH_PATHS=(src src-tauri/src tailwind.config.js src/app.css)
fi

if ! command -v grep >/dev/null 2>&1; then
  echo "style-guard requires grep on PATH." >&2
  exit 2
fi

HEX_HITS=$(
  grep -RInE -i '#(0091fd|0077e0|83dcff)\b' "${SEARCH_PATHS[@]}" 2>/dev/null \
    | grep -vE "$ALLOWLIST" || true
)

RGB_HITS=$(
  grep -RInE -i 'rgba?\([[:space:]]*0([[:space:]]*,[[:space:]]*|[[:space:]]+)145([[:space:]]*,[[:space:]]*|[[:space:]]+)253([[:space:]]*[,/)]|[[:space:]]*/)' "${SEARCH_PATHS[@]}" 2>/dev/null \
    | grep -vE "$ALLOWLIST" || true
)

if [ -n "$HEX_HITS$RGB_HITS" ]; then
  echo "Hardcoded NEAR accent literals found outside approved token files:"
  if [ -n "$HEX_HITS" ]; then
    echo ""
    echo "Hex literals:"
    echo "$HEX_HITS"
  fi
  if [ -n "$RGB_HITS" ]; then
    echo ""
    echo "RGB/RGBA literals:"
    echo "$RGB_HITS"
  fi
  echo ""
  echo "Use Tailwind's accent-cyan/accent-signal classes or the --v2-accent CSS variables."
  echo "Allowed token files: tailwind.config.* and src/app.css."
  exit 1
fi

echo "No hardcoded NEAR accent literals detected outside approved token files."
