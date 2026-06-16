#!/usr/bin/env bash
#
# SSH tunnel helper for the IronClaw Desktop client.
#
# When IronClaw runs on a remote host, the desktop client needs the gateway
# port forwarded to a matching local port. This script opens/closes/checks
# that tunnel so you don't have to remember the ssh incantation.
#
# Subcommands:
#   open    [host] [port]   open a background SSH tunnel local:port -> remote 127.0.0.1:port
#   close   [port]          kill the SSH process listening on local:port
#   status  [port]          report tunnel state + gateway reachability
#   restart [host] [port]   close + open
#
# Defaults (overridable via env):
#   host  = ${IRONCLAW_SSH_ALIAS:-your-ssh-host}
#   port  = ${IRONCLAW_TUNNEL_PORT:-18789}
#
# Usage:
#   bash scripts/tunnel.sh status
#   bash scripts/tunnel.sh open
#   bash scripts/tunnel.sh open myhost 22821
#   bash scripts/tunnel.sh close
#   bash scripts/tunnel.sh restart

set -uo pipefail

DEFAULT_HOST="${IRONCLAW_SSH_ALIAS:-your-ssh-host}"
DEFAULT_PORT="${IRONCLAW_TUNNEL_PORT:-18789}"

# Colors (disabled when stdout is not a tty).
if [[ -t 1 ]]; then
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  DIM=$'\033[2m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
else
  RED="" GREEN="" YELLOW="" DIM="" BOLD="" RESET=""
fi

CHECK="${GREEN}\xe2\x9c\x93${RESET}"
CROSS="${RED}\xe2\x9c\x97${RESET}"
WARN="${YELLOW}\xe2\x9a\xa0${RESET}"

usage() {
  cat <<EOF
${BOLD}IronClaw SSH tunnel helper${RESET}

Subcommands:
  ${BOLD}open${RESET}    [host] [port]   open tunnel local:port -> remote 127.0.0.1:port
  ${BOLD}close${RESET}   [port]          kill SSH process listening on local:port
  ${BOLD}status${RESET}  [port]          report tunnel state + gateway reachability
  ${BOLD}restart${RESET} [host] [port]   close + open

Defaults:
  host = ${DEFAULT_HOST}   (override: IRONCLAW_SSH_ALIAS)
  port = ${DEFAULT_PORT}        (override: IRONCLAW_TUNNEL_PORT)
EOF
}

# Find any PID listening on the given local TCP port.
# Returns the first PID via stdout, empty string if none.
pid_on_port() {
  local port="$1"
  lsof -ti tcp:"${port}" -sTCP:LISTEN 2>/dev/null | head -n 1
}

# Returns 0 if the given PID looks like an ssh client process.
is_ssh_pid() {
  local pid="$1"
  [[ -z "${pid}" ]] && return 1
  local cmd
  cmd="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
  [[ "${cmd}" =~ (^|/)ssh($|[[:space:]]) ]]
}

# Probe the gateway /api/health endpoint through the local tunnel.
# Echoes a status string and returns 0 if healthy, 1 if reachable-but-not-healthy,
# 2 if unreachable.
probe_health() {
  local port="$1"
  local body http_code
  # Capture body and code in one curl; separate with the literal "\n<<HTTP>>\n".
  local out
  out="$(curl -sS --max-time 2 -o - -w $'\n<<HTTP>>\n%{http_code}' \
          "http://127.0.0.1:${port}/api/health" 2>/dev/null || true)"
  if [[ -z "${out}" ]]; then
    echo "unreachable"
    return 2
  fi
  http_code="${out##*<<HTTP>>$'\n'}"
  body="${out%$'\n'<<HTTP>>*}"
  if [[ "${http_code}" =~ ^2 ]]; then
    # Compress body to one line; strip surrounding whitespace.
    body="$(printf '%s' "${body}" | tr -d '\r\n' | head -c 200)"
    if [[ -z "${body}" ]]; then
      echo "healthy (HTTP ${http_code})"
    else
      echo "healthy (${body})"
    fi
    return 0
  fi
  echo "reachable but HTTP ${http_code}"
  return 1
}

cmd_status() {
  local port="${1:-${DEFAULT_PORT}}"
  local pid
  pid="$(pid_on_port "${port}")"

  if [[ -z "${pid}" ]]; then
    printf "%b no tunnel on :%s\n" "${CROSS}" "${port}"
    return 0
  fi

  if ! is_ssh_pid "${pid}"; then
    printf "%b :%s held by non-ssh pid %s (%s)\n" \
      "${WARN}" "${port}" "${pid}" \
      "$(ps -p "${pid}" -o command= 2>/dev/null || echo unknown)"
    return 0
  fi

  local health rc
  health="$(probe_health "${port}")"
  rc=$?

  if [[ "${rc}" -eq 0 ]]; then
    printf "%b tunnel up on :%s (pid %s) %sgateway %s%s\n" \
      "${CHECK}" "${port}" "${pid}" "${DIM}" "${health}" "${RESET}"
  elif [[ "${rc}" -eq 1 ]]; then
    printf "%b tunnel up on :%s (pid %s) %sgateway %s%s\n" \
      "${WARN}" "${port}" "${pid}" "${DIM}" "${health}" "${RESET}"
  else
    printf "%b tunnel up on :%s (pid %s) %sgateway %s%s\n" \
      "${WARN}" "${port}" "${pid}" "${DIM}" "${health}" "${RESET}"
  fi
  return 0
}

cmd_open() {
  local host="${1:-${DEFAULT_HOST}}"
  local port="${2:-${DEFAULT_PORT}}"

  local existing
  existing="$(pid_on_port "${port}")"
  if [[ -n "${existing}" ]]; then
    if is_ssh_pid "${existing}"; then
      printf "%b tunnel already up on :%s (pid %s) %s- refusing to open another%s\n" \
        "${WARN}" "${port}" "${existing}" "${DIM}" "${RESET}"
    else
      printf "%b :%s already held by non-ssh pid %s %s- refusing to open%s\n" \
        "${WARN}" "${port}" "${existing}" "${DIM}" "${RESET}"
    fi
    return 0
  fi

  printf "%sOpening tunnel %s:%s -> %s 127.0.0.1:%s ...%s\n" \
    "${DIM}" "127.0.0.1" "${port}" "${host}" "${port}" "${RESET}"

  if ! ssh -fN \
        -o ExitOnForwardFailure=yes \
        -o ServerAliveInterval=30 \
        -o ServerAliveCountMax=3 \
        -L "${port}:127.0.0.1:${port}" \
        "${host}"; then
    printf "%b ssh failed - check 'ssh %s' works and remote port %s is bound to 127.0.0.1\n" \
      "${CROSS}" "${host}" "${port}" >&2
    return 2
  fi

  # ssh -fN backgrounds itself; give the kernel a moment to register the LISTEN.
  local attempts=0 pid=""
  while [[ "${attempts}" -lt 10 ]]; do
    pid="$(pid_on_port "${port}")"
    if [[ -n "${pid}" ]] && is_ssh_pid "${pid}"; then
      break
    fi
    sleep 0.2
    attempts=$((attempts + 1))
  done

  if [[ -z "${pid}" ]]; then
    printf "%b tunnel opened but no listener on :%s yet - check 'lsof -i tcp:%s'\n" \
      "${WARN}" "${port}" "${port}"
    return 0
  fi

  local health rc
  health="$(probe_health "${port}")"
  rc=$?
  if [[ "${rc}" -eq 0 ]]; then
    printf "%b tunnel up on :%s (pid %s) %s- gateway reachable%s\n" \
      "${CHECK}" "${port}" "${pid}" "${DIM}" "${RESET}"
  else
    printf "%b tunnel up on :%s (pid %s) %s- gateway %s%s\n" \
      "${WARN}" "${port}" "${pid}" "${DIM}" "${health}" "${RESET}"
  fi
  return 0
}

cmd_close() {
  local port="${1:-${DEFAULT_PORT}}"
  local pid
  pid="$(pid_on_port "${port}")"

  if [[ -z "${pid}" ]]; then
    printf "%b no tunnel on :%s %s- nothing to close%s\n" \
      "${CHECK}" "${port}" "${DIM}" "${RESET}"
    return 0
  fi

  if ! is_ssh_pid "${pid}"; then
    printf "%b :%s held by non-ssh pid %s %s- refusing to kill%s\n" \
      "${WARN}" "${port}" "${pid}" "${DIM}" "${RESET}"
    return 0
  fi

  kill "${pid}" 2>/dev/null || true

  # Wait up to ~2s for graceful exit; then SIGKILL if still alive.
  local attempts=0
  while [[ "${attempts}" -lt 10 ]]; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      printf "%b killed pid %s\n" "${CHECK}" "${pid}"
      return 0
    fi
    sleep 0.2
    attempts=$((attempts + 1))
  done

  kill -9 "${pid}" 2>/dev/null || true
  sleep 0.2
  if kill -0 "${pid}" 2>/dev/null; then
    printf "%b pid %s still alive after SIGKILL\n" "${CROSS}" "${pid}" >&2
    return 2
  fi
  printf "%b killed pid %s %s(SIGKILL)%s\n" "${CHECK}" "${pid}" "${DIM}" "${RESET}"
  return 0
}

cmd_restart() {
  local host="${1:-${DEFAULT_HOST}}"
  local port="${2:-${DEFAULT_PORT}}"
  cmd_close "${port}"
  cmd_open "${host}" "${port}"
}

main() {
  local sub="${1:-}"
  if [[ -z "${sub}" ]]; then
    usage >&2
    exit 0
  fi
  shift || true

  case "${sub}" in
    open)    cmd_open    "$@" ;;
    close)   cmd_close   "$@" ;;
    status)  cmd_status  "$@" ;;
    restart) cmd_restart "$@" ;;
    -h|--help|help) usage ;;
    *)
      printf "%b unknown subcommand: %s\n" "${CROSS}" "${sub}" >&2
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
