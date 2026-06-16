#!/usr/bin/env bash
#
# Manage IronClaw scheduled routines (automations) on the server.
#
# IronClaw v0.29 has NO gateway endpoint to CREATE routines (the desktop
# app's Routines screen is read/list only — POST /api/routines → 405). The
# only create path is the server CLI: `ironclaw routines create`. This
# wrapper runs that CLI over SSH so you don't have to remember the binary
# path + sudo dance.
#
# Routines are scoped PER USER. One created under the server's default CLI
# account will fire on schedule but won't appear in the desktop app if the
# app connects as a different account. List/manage from here either way.
#
# Usage:
#   scripts/ironclaw-routine.sh list
#   scripts/ironclaw-routine.sh create --name daily-digest \
#       --schedule '0 0 9 * * *' --prompt 'Summarize today'
#   scripts/ironclaw-routine.sh disable <id|name>
#   scripts/ironclaw-routine.sh enable  <id|name>
#   scripts/ironclaw-routine.sh delete  <id|name>
#
# Schedule is a 6-field cron: <sec> <min> <hour> <dom> <mon> <dow>.
#   '0 0 9 * * *'   = every day at 09:00:00
#   '0 */30 * * * *'= every 30 minutes
#
# `delete` prompts for confirmation; pass `-y` to skip it
# (e.g. `delete <name> -y`) since this wrapper has no interactive TTY.
#
# Env:
#   IRONCLAW_SSH_ALIAS   SSH host alias (default: your-ssh-host)
#   IRONCLAW_BIN         path to the ironclaw binary on the server
#                        (default: "ironclaw", i.e. resolved from $PATH)
#   IRONCLAW_RUN_USER    server account that owns the routines store
#                        (default: the SSH login user; set this if the CLI
#                        runs under a different service account)

set -euo pipefail

SSH_ALIAS="${IRONCLAW_SSH_ALIAS:-your-ssh-host}"

if [[ $# -lt 1 ]]; then
  sed -n '2,40p' "$0"
  exit 2
fi

# Resolve the binary. Defaults to whatever `ironclaw` is on the server's PATH;
# override IRONCLAW_BIN to point at a specific install path.
REMOTE_BIN="${IRONCLAW_BIN:-ironclaw}"
resolve_bin='BIN="'"${REMOTE_BIN}"'"; command -v "$BIN" >/dev/null 2>&1 || [ -x "$BIN" ] || { echo "could not resolve ironclaw binary: $BIN" >&2; exit 3; }'

# Optionally run the CLI under a dedicated service account.
RUN_USER="${IRONCLAW_RUN_USER:-}"

# Forward all args to `ironclaw routines <args>`.
# Args are passed through SSH as a single quoted string; callers must quote
# their own --prompt / --schedule values (as in the examples above).
printf -v ARGS '%q ' "$@"

if [[ -n "${RUN_USER}" ]]; then
  RUN_CMD="sudo -u $(printf '%q' "${RUN_USER}") \"\$BIN\" routines ${ARGS}"
else
  RUN_CMD="\"\$BIN\" routines ${ARGS}"
fi

# shellcheck disable=SC2029
ssh -o ConnectTimeout=15 "${SSH_ALIAS}" "${resolve_bin}; ${RUN_CMD}"
