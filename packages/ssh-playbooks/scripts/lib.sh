#!/usr/bin/env bash
# lib.sh — common helpers for Bob Deploy server-side scripts.
#
# This file is fixed code (see CLAUDE.md: "Server scripts in packages/ssh-playbooks/scripts are
# fixed code. Bob never edits them and never generates them."). It is inlined verbatim into every
# numbered bootstrap script and every helper under helpers/ at build time (see
# src/generated/scripts.ts and its generator) so that each remote script is a single
# self-contained file with no runtime `source` dependency.
#
# Conventions:
#   - Every script that sources this file must itself start with `set -euo pipefail`.
#   - On success, call `result` exactly once, as the very last thing the script does.
#   - On failure, call `die "message" ["ERROR_CODE"]`. `die` never returns.
#   - `result`/`die` print a single line prefixed `BD_RESULT ` whose remainder is JSON:
#       BD_RESULT {"ok":true,"key":"value", ...}
#       BD_RESULT {"ok":false,"error":"ERROR_CODE","message":"human readable"}
#     This must be the last line of stdout so the TypeScript side (runScript) can parse it
#     reliably even when earlier command output is noisy.

set -euo pipefail
IFS=$'\n\t'

BD_LOG_DIR="/var/log/bob-deploy"
BD_LOG_FILE="${BD_LOG_DIR}/helpers.log"

# bd_log <message>
# Appends a timestamped line to the helpers log. Never fails the caller: if the log directory
# doesn't exist yet (e.g. during early preflight, before 40-install-helpers.sh has run) this is a
# no-op rather than an error.
bd_log() {
  local msg="$1"
  if mkdir -p "$BD_LOG_DIR" 2>/dev/null; then
    printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$msg" >>"$BD_LOG_FILE" 2>/dev/null || true
  fi
}

# json_escape <string>
# Escapes a string for embedding inside a JSON double-quoted string: backslash, double-quote,
# and control characters (newline, tab, carriage return, and any other byte < 0x20).
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  # Strip any remaining control characters (0x00-0x1F) that aren't handled above.
  s=$(printf '%s' "$s" | tr -d '\000-\010\013\014\016-\037')
  printf '%s' "$s"
}

# result [key value]...
# Prints the final BD_RESULT success line and exits 0. Extra key/value pairs are added as string
# fields in the JSON object (values are JSON-escaped automatically; keys are trusted literals
# supplied by the script author, not escaped).
result() {
  local json='{"ok":true'
  while [ "$#" -ge 2 ]; do
    json="${json},\"$1\":\"$(json_escape "$2")\""
    shift 2
  done
  json="${json}}"
  bd_log "BD_RESULT ${json}"
  printf 'BD_RESULT %s\n' "$json"
  exit 0
}

# die <message> [error_code]
# Prints the final BD_RESULT failure line to stdout and exits 1. Never returns.
die() {
  local message="$1"
  local code="${2:-BD_SCRIPT_ERROR}"
  local json
  json="{\"ok\":false,\"error\":\"$(json_escape "$code")\",\"message\":\"$(json_escape "$message")\"}"
  bd_log "BD_RESULT ${json}"
  printf 'BD_RESULT %s\n' "$json"
  exit 1
}

# require_root
# Convenience guard for scripts that must run as root (most of them, since they're invoked over
# SSH with `sudo -n` or as the root bootstrap user).
require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "This script must be run as root." "BD_NOT_ROOT"
  fi
}

# apt_run <apt-get args...>
# Runs apt-get non-interactively, waiting up to 5 minutes for the dpkg lock instead of failing at
# once (fresh cloud servers run unattended-upgrades/cloud-init apt jobs for their first minutes).
# Output goes to BD_APT_LOG so a failure can say what apt actually complained about.
BD_APT_LOG="/tmp/bd-apt.log"
apt_run() {
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 -o Acquire::Retries=3 "$@" >>"$BD_APT_LOG" 2>&1
}

# apt_tail
# The last few lines apt printed, on one line, for error messages.
apt_tail() {
  tail -n 6 "$BD_APT_LOG" 2>/dev/null | tr '\n' ' ' | cut -c1-600
}

# apt_install <package>...
# Installs packages; if that fails (stale lists, mirror mid-sync, dropped download), refreshes the
# package lists and tries once more. Returns non-zero only if both attempts fail; the caller then
# dies with a message that includes "$(apt_tail)".
apt_install() {
  : >"$BD_APT_LOG"
  if apt_run install -y -q "$@"; then
    return 0
  fi
  apt_run update -q || true
  apt_run install -y -q "$@"
}

# validate_app <value>
# Mirrors packages/contracts/src/validation.ts's appSlugSchema:
#   /^[a-z][a-z0-9-]{1,30}$/
# Returns 0 (true) if valid, 1 (false) otherwise. Does not call die itself, so callers can choose
# their own error message/code.
validate_app() {
  local v="$1"
  [[ "$v" =~ ^[a-z][a-z0-9-]{1,30}$ ]]
}

# validate_user <value>
# Mirrors packages/contracts/src/validation.ts's adminUserSchema:
#   /^[a-z][a-z0-9-]{2,31}$/, not in RESERVED_USERS, and not starting with "bd-".
validate_user() {
  local v="$1"
  [[ "$v" =~ ^[a-z][a-z0-9-]{2,31}$ ]] || return 1
  case "$v" in
    bd-*) return 1 ;;
  esac
  case "$v" in
    root|daemon|bin|sys|sync|games|man|lp|mail|news|uucp|proxy|www-data|backup|list|irc|nobody|syslog|sshd|caddy|ubuntu|admin|debian|messagebus|systemd-network|systemd-resolve|systemd-timesync|_apt|uuidd|tcpdump|landscape|pollinate|fwupd-refresh|usbmux|lxd)
      return 1
      ;;
  esac
  return 0
}

# validate_port <value>
# Mirrors packages/contracts/src/validation.ts's portSchema: an integer in [1, 65535], with no
# extra characters (leading zeros are tolerated the same way `Number()` tolerates them in JS).
validate_port() {
  local v="$1"
  [[ "$v" =~ ^[0-9]+$ ]] || return 1
  # Strip leading zeros before the numeric comparison to avoid octal interpretation by `((...))`.
  local n="${v#"${v%%[!0]*}"}"
  [ -z "$n" ] && n=0
  [ "$n" -ge 1 ] && [ "$n" -le 65535 ]
}

# validate_domain <value>
# Mirrors packages/contracts/src/validation.ts's domainSchema: lowercase, at most 253 characters,
# at least one dot, every label matches ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$, and the final label
# (the TLD) matches ^[a-z]{2,}$.
validate_domain() {
  local v="$1"
  [ "${#v}" -le 253 ] || return 1
  [ "$v" = "${v,,}" ] || return 1
  case "$v" in
    *.*) ;;
    *) return 1 ;;
  esac
  local IFS_OLD="$IFS"
  IFS='.'
  read -r -a labels <<<"$v"
  IFS="$IFS_OLD"
  local n="${#labels[@]}"
  [ "$n" -ge 2 ] || return 1
  local i label
  for ((i = 0; i < n; i++)); do
    label="${labels[$i]}"
    if [ "$i" -eq $((n - 1)) ]; then
      [[ "$label" =~ ^[a-z]{2,}$ ]] || return 1
    else
      [[ "$label" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || return 1
    fi
  done
  return 0
}

# validate_start_cmd <value>
# Mirrors packages/contracts/src/validation.ts's START_CMD_PATTERN: one of a small fixed set of
# recognized start commands (npm/node/gunicorn/uvicorn), never an arbitrary shell command.
validate_start_cmd() {
  local v="$1"
  [[ "$v" =~ ^(npm\ run\ start|npm\ start|node\ [A-Za-z0-9_./-]+|\.venv/bin/gunicorn\ [A-Za-z0-9_.:\$\ =-]+|\.venv/bin/uvicorn\ [A-Za-z0-9_.:\$\ =-]+)$ ]]
}
