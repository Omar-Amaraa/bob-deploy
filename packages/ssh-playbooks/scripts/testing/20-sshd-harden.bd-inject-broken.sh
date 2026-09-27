#!/usr/bin/env bash
# BD_INJECT_BROKEN_SSHD — fault-injection variant of ../20-sshd-harden.sh, for
# src/**/*.fail.test.ts only. See scripts/testing/README.md: this file is never read by
# scripts-gen/build-scripts.mjs and can never reach src/generated/scripts.ts or a real server.
#
# 20-sshd-harden.sh <admin_user>
# Locks sshd down to key-only auth, but deliberately for the WRONG user (see the AllowUsers line
# below), so the admin user named on the command line is locked out even though the script itself
# reports success. Used to exercise lockDownStep's restore-on-failure path in a controlled way.
#
# Usage: 20-sshd-harden.sh <admin_user>
# On success: BD_RESULT {"ok":true,"backupDir":"/etc/bob-deploy/sshd-backups/<timestamp>"}
# On failure: BD_RESULT {"ok":false,"error":"<code>","message":"..."}
#
# @@LIB@@

require_root

ADMIN_USER="${1:-}"
if [ -z "$ADMIN_USER" ]; then
  die "Usage: 20-sshd-harden.sh <admin_user>" "BD_BAD_ARGS"
fi
if ! validate_user "$ADMIN_USER"; then
  die "Invalid admin user name: ${ADMIN_USER}" "BD_INVALID_USER"
fi
if ! id "$ADMIN_USER" >/dev/null 2>&1; then
  die "User ${ADMIN_USER} does not exist; run 10-create-admin.sh first." "BD_USER_NOT_FOUND"
fi

TIMESTAMP="$(date -u +'%Y%m%dT%H%M%SZ')"
BACKUP_DIR="/etc/bob-deploy/sshd-backups/${TIMESTAMP}"
mkdir -p "$BACKUP_DIR"

# Back up the full sshd config tree (main file + any drop-ins) so restore is exact.
cp -a /etc/ssh/sshd_config "${BACKUP_DIR}/sshd_config" 2>/dev/null || true
if [ -d /etc/ssh/sshd_config.d ]; then
  cp -a /etc/ssh/sshd_config.d "${BACKUP_DIR}/sshd_config.d" 2>/dev/null || true
fi

DROPIN="/etc/ssh/sshd_config.d/00-bob-deploy-hardening.conf"
mkdir -p /etc/ssh/sshd_config.d
cat >"$DROPIN" <<EOF
# Managed by Bob Deploy. Restores from ${BACKUP_DIR} via 21-sshd-restore.sh.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
AllowUsers bd-inject-nonexistent-user
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
PermitTunnel no
ClientAliveInterval 300
ClientAliveCountMax 2
EOF
chmod 0644 "$DROPIN"

if ! sshd -t 2>/tmp/bd-sshd-test-err; then
  ERR="$(cat /tmp/bd-sshd-test-err 2>/dev/null || true)"
  rm -f "$DROPIN"
  die "New sshd config failed validation (sshd -t): ${ERR}" "BD_SSHD_CONFIG_INVALID"
fi
rm -f /tmp/bd-sshd-test-err

if ! systemctl reload sshd 2>/dev/null && ! systemctl reload ssh 2>/dev/null; then
  # Fall back to a restart if reload isn't supported by this unit.
  systemctl restart sshd 2>/dev/null || systemctl restart ssh 2>/dev/null \
    || die "Failed to reload/restart the SSH daemon after hardening." "BD_SSHD_RELOAD_FAILED"
fi

result backupDir "$BACKUP_DIR"
