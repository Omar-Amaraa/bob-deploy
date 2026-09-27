#!/usr/bin/env bash
# 20-sshd-harden.sh <admin_user>
# Locks sshd down to key-only auth for the given admin user only, disabling root login and
# password authentication entirely. Backs up the previous config first so 21-sshd-restore.sh can
# undo this if the caller cannot re-establish a session afterward (verified by the TypeScript side
# opening a *second* SSH session as the admin user before treating this step as done).
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

# sshd keeps the FIRST value it reads for each keyword, and reads sshd_config.d/*.conf in lexical
# order. Cloud images ship e.g. 50-cloud-init.conf with "PasswordAuthentication yes", which beat the
# old 60- name and silently left password and root login enabled. 00- sorts first; the effective
# config is verified with `sshd -T` below either way.
DROPIN="/etc/ssh/sshd_config.d/00-bob-deploy-hardening.conf"
mkdir -p /etc/ssh/sshd_config.d
rm -f /etc/ssh/sshd_config.d/60-bob-deploy-hardening.conf
cat >"$DROPIN" <<EOF
# Managed by Bob Deploy. Restores from ${BACKUP_DIR} via 21-sshd-restore.sh.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
AllowUsers ${ADMIN_USER}
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

# Prove the settings actually win (another drop-in, a Match block or an Include placed after the
# main options could still override them). Never report "hardened" when it isn't.
EFFECTIVE="$(sshd -T 2>/dev/null || true)"
for expected in 'permitrootlogin no' 'passwordauthentication no' 'kbdinteractiveauthentication no'; do
  if ! printf '%s\n' "$EFFECTIVE" | grep -qx "$expected"; then
    rm -f "$DROPIN"
    die "SSH hardening would not take effect (expected '${expected}' in sshd -T); another sshd setting overrides it." "BD_SSHD_HARDENING_INEFFECTIVE"
  fi
done

if ! systemctl reload sshd 2>/dev/null && ! systemctl reload ssh 2>/dev/null; then
  # Fall back to a restart if reload isn't supported by this unit.
  systemctl restart sshd 2>/dev/null || systemctl restart ssh 2>/dev/null \
    || die "Failed to reload/restart the SSH daemon after hardening." "BD_SSHD_RELOAD_FAILED"
fi

result backupDir "$BACKUP_DIR"
