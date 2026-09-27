#!/usr/bin/env bash
# 21-sshd-restore.sh <backup_dir>
# Undoes 20-sshd-harden.sh by restoring the sshd config tree it backed up. Used when a second
# session as the admin user cannot be established after hardening, so the caller (root, via the
# still-open first session) can roll back before losing access entirely.
#
# Usage: 21-sshd-restore.sh <backup_dir>
# On success: BD_RESULT {"ok":true,"backupDir":"<backup_dir>"}
# On failure: BD_RESULT {"ok":false,"error":"<code>","message":"..."}
#
# @@LIB@@

require_root

BACKUP_DIR="${1:-}"
if [ -z "$BACKUP_DIR" ]; then
  die "Usage: 21-sshd-restore.sh <backup_dir>" "BD_BAD_ARGS"
fi

# The backup dir is always under /etc/bob-deploy/sshd-backups/ — reject anything else so this
# can't be pointed at an arbitrary path.
case "$BACKUP_DIR" in
  /etc/bob-deploy/sshd-backups/*) ;;
  *) die "backup_dir must be under /etc/bob-deploy/sshd-backups/." "BD_BAD_ARGS" ;;
esac

if [ ! -d "$BACKUP_DIR" ]; then
  die "Backup directory ${BACKUP_DIR} does not exist." "BD_BACKUP_NOT_FOUND"
fi

rm -f /etc/ssh/sshd_config.d/00-bob-deploy-hardening.conf /etc/ssh/sshd_config.d/60-bob-deploy-hardening.conf

if [ -f "${BACKUP_DIR}/sshd_config" ]; then
  cp -a "${BACKUP_DIR}/sshd_config" /etc/ssh/sshd_config
fi
if [ -d "${BACKUP_DIR}/sshd_config.d" ]; then
  rm -rf /etc/ssh/sshd_config.d
  cp -a "${BACKUP_DIR}/sshd_config.d" /etc/ssh/sshd_config.d
fi

if ! sshd -t 2>/tmp/bd-sshd-restore-err; then
  ERR="$(cat /tmp/bd-sshd-restore-err 2>/dev/null || true)"
  die "Restored sshd config failed validation (sshd -t): ${ERR}" "BD_SSHD_CONFIG_INVALID"
fi
rm -f /tmp/bd-sshd-restore-err

if ! systemctl reload sshd 2>/dev/null && ! systemctl reload ssh 2>/dev/null; then
  systemctl restart sshd 2>/dev/null || systemctl restart ssh 2>/dev/null \
    || die "Failed to reload/restart the SSH daemon after restoring." "BD_SSHD_RELOAD_FAILED"
fi

result backupDir "$BACKUP_DIR"
