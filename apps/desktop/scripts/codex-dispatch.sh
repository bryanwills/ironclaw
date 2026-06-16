#!/usr/bin/env bash
# Dispatch one or more Codex agents in isolated worktrees.
#
# Usage:
#   bash scripts/codex-dispatch.sh 49
#   bash scripts/codex-dispatch.sh 49 50 53 54    # parallel fan-out
#   bash scripts/codex-dispatch.sh all             # every brief
#
# Constraints:
#   - Max 6 concurrent worktrees (cargo OOMs at 7+ on M1/M2 16GB).
#   - Each worktree on `codex/r<NN>-<slug>` branch from current main.
#   - Codex output streamed to /tmp/codex-r<NN>.log.
#
# When a brief completes:
#   - The worktree contains a branch with the proposed changes.
#   - `gh pr create` is NOT called automatically — review locally first.
#   - To merge:    git -C <worktree> push origin HEAD &&
#                  gh pr create --base main --head codex/r<NN>-<slug>
#   - To discard:  git worktree remove --force <worktree> &&
#                  git branch -D codex/r<NN>-<slug>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

BRIEFS_DIR="docs/codex-tasks"
WORKTREE_ROOT=".codex-worktrees"
MAX_CONCURRENT=6

if ! command -v codex >/dev/null; then
  echo "ERROR: codex CLI not on PATH. Install from openai-codex." >&2
  exit 1
fi

mkdir -p "${WORKTREE_ROOT}"

# Resolve "all" or explicit list of brief numbers.
TARGETS=()
if [[ "${1:-}" == "all" ]]; then
  while IFS= read -r f; do
    n=$(basename "$f" | sed 's/-.*//')
    TARGETS+=("$n")
  done < <(find "${BRIEFS_DIR}" -maxdepth 1 -name '[0-9][0-9]-*.md' | sort)
else
  TARGETS=("$@")
fi

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "usage: $0 <brief-num> [<brief-num> ...]" >&2
  echo "       $0 all" >&2
  exit 2
fi

# Verify main is clean before fanning out.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: working tree dirty. Commit or stash before dispatching." >&2
  exit 1
fi
git fetch origin --quiet || true

# Throttle helper.
running=()
wait_one() {
  while (( ${#running[@]} >= MAX_CONCURRENT )); do
    local i
    for i in "${!running[@]}"; do
      if ! kill -0 "${running[$i]}" 2>/dev/null; then
        unset "running[$i]"
        running=("${running[@]}")
        return
      fi
    done
    sleep 5
  done
}

# Dispatch each target.
for n in "${TARGETS[@]}"; do
  brief=$(find "${BRIEFS_DIR}" -maxdepth 1 -name "${n}-*.md" | head -1)
  if [[ -z "$brief" ]]; then
    echo "skip: no brief at ${BRIEFS_DIR}/${n}-*.md" >&2
    continue
  fi
  slug=$(basename "$brief" .md)
  branch="codex/r${n}-${slug#*-}"
  worktree="${WORKTREE_ROOT}/r${n}"

  if [[ -d "$worktree" ]]; then
    echo "skip: worktree ${worktree} already exists. Remove first." >&2
    continue
  fi

  echo "→ dispatching brief ${n} (${slug}) into ${worktree} on ${branch}"
  git worktree add "$worktree" -b "$branch" main >/dev/null

  wait_one

  (
    cat "$brief" | codex exec --cd "$worktree" \
      --full-auto \
      --config model_reasoning_effort=high - \
      > "/tmp/codex-r${n}.log" 2>&1
    code=$?
    if [[ $code -eq 0 ]]; then
      echo "✓ R${n} done; review with: git -C ${worktree} log --oneline"
    else
      echo "✗ R${n} failed (exit ${code}); see /tmp/codex-r${n}.log"
    fi
  ) &
  running+=($!)
done

wait
echo "all dispatched. Review each worktree:"
for n in "${TARGETS[@]}"; do
  echo "  git -C ${WORKTREE_ROOT}/r${n} log --oneline -10"
done
