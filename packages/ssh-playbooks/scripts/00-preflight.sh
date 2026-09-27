#!/usr/bin/env bash
# 00-preflight.sh
# Verifies the target server is one Bob Deploy can safely bootstrap, before any admin user is
# created or anything is changed. Read-only except for the one-time apt package list refresh.
#
# Usage: 00-preflight.sh
# On success: BD_RESULT {"ok":true,"os":"<id> <version>","arch":"<arch>","alreadyBootstrapped":"true|false"}
# On failure: BD_RESULT {"ok":false,"error":"<code>","message":"..."}
#
# @@LIB@@

require_root

# --- OS check: Ubuntu 22.04 or 24.04 only ---
if [ ! -r /etc/os-release ]; then
  die "Could not read /etc/os-release; this does not look like a supported Linux distribution." "BD_UNSUPPORTED_OS"
fi
# shellcheck disable=SC1091
. /etc/os-release
OS_ID="${ID:-unknown}"
OS_VERSION="${VERSION_ID:-unknown}"
if [ "$OS_ID" != "ubuntu" ]; then
  die "Unsupported OS: ${OS_ID} ${OS_VERSION}. Bob Deploy supports Ubuntu 22.04 and 24.04." "BD_UNSUPPORTED_OS"
fi
case "$OS_VERSION" in
  22.04 | 24.04) ;;
  *)
    die "Unsupported Ubuntu version: ${OS_VERSION}. Bob Deploy supports 22.04 and 24.04." "BD_UNSUPPORTED_OS"
    ;;
esac

# --- Architecture check ---
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64 | aarch64) ;;
  *)
    die "Unsupported architecture: ${ARCH}. Bob Deploy supports x86_64 and aarch64." "BD_UNSUPPORTED_ARCH"
    ;;
esac

# --- systemd check (helpers rely on systemd units) ---
if ! command -v systemctl >/dev/null 2>&1; then
  die "systemd (systemctl) was not found; Bob Deploy requires a systemd-based server." "BD_NO_SYSTEMD"
fi

# --- Disk space check: require at least 2 GiB free on / ---
AVAIL_KB="$(df -Pk / | awk 'NR==2 {print $4}')"
if [ -z "$AVAIL_KB" ] || [ "$AVAIL_KB" -lt $((2 * 1024 * 1024)) ]; then
  die "Less than 2 GiB free on /. Free up disk space and try again." "BD_LOW_DISK"
fi

# --- apt availability / package list refresh ---
if ! command -v apt-get >/dev/null 2>&1; then
  die "apt-get was not found; Bob Deploy requires a Debian/Ubuntu-family server." "BD_NO_APT"
fi
export DEBIAN_FRONTEND=noninteractive
if ! apt_run update -q; then
  die "apt-get update failed. Check the server's network connectivity and package sources. $(apt_tail)" "BD_APT_UPDATE_FAILED"
fi

# --- Detect a previous Bob Deploy install ---
ALREADY_BOOTSTRAPPED="false"
if [ -f /etc/bob-deploy/bootstrapped ]; then
  ALREADY_BOOTSTRAPPED="true"
fi

result os "${OS_ID} ${OS_VERSION}" arch "$ARCH" alreadyBootstrapped "$ALREADY_BOOTSTRAPPED"
