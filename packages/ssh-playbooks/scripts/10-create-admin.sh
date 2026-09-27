#!/usr/bin/env bash
# 10-create-admin.sh <admin_user> <pubkey_b64>
# Creates the Bob Deploy admin user (idempotent), grants it passwordless sudo, and installs the
# given SSH public key as its only authorized key. Never sets or changes a password for this user;
# it is a key-only account from the start.
#
# Usage: 10-create-admin.sh <admin_user> <pubkey_b64>
#   admin_user  - must satisfy validate_user (see lib.sh)
#   pubkey_b64  - base64 of a single "ssh-<type> <key> [comment]" line
#
# On success: BD_RESULT {"ok":true,"user":"<admin_user>","created":"true|false"}
# On failure: BD_RESULT {"ok":false,"error":"<code>","message":"..."}
#
# @@LIB@@

require_root

ADMIN_USER="${1:-}"
PUBKEY_B64="${2:-}"

if [ -z "$ADMIN_USER" ] || [ -z "$PUBKEY_B64" ]; then
  die "Usage: 10-create-admin.sh <admin_user> <pubkey_b64>" "BD_BAD_ARGS"
fi

if ! validate_user "$ADMIN_USER"; then
  die "Invalid admin user name: ${ADMIN_USER}" "BD_INVALID_USER"
fi

PUBKEY="$(printf '%s' "$PUBKEY_B64" | base64 -d 2>/dev/null || true)"
if [ -z "$PUBKEY" ]; then
  die "pubkey_b64 did not decode to a non-empty value." "BD_BAD_ARGS"
fi
if ! printf '%s' "$PUBKEY" | grep -qE '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9-]+) [A-Za-z0-9+/=]+'; then
  die "Decoded public key does not look like a valid OpenSSH public key line." "BD_BAD_ARGS"
fi

CREATED="false"
if id "$ADMIN_USER" >/dev/null 2>&1; then
  CREATED="false"
else
  useradd --create-home --shell /bin/bash --comment "Bob Deploy admin" "$ADMIN_USER" \
    || die "Failed to create user ${ADMIN_USER}." "BD_USERADD_FAILED"
  CREATED="true"
fi

usermod -aG sudo "$ADMIN_USER" || die "Failed to add ${ADMIN_USER} to the sudo group." "BD_USERMOD_FAILED"

# Passwordless sudo for the admin user (they authenticate to the box only via SSH key; this lets
# Bob Deploy run `sudo -n` over the SSH session established as this user).
SUDOERS_FILE="/etc/sudoers.d/90-bob-deploy-${ADMIN_USER}"
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$ADMIN_USER" >"$SUDOERS_FILE"
chmod 0440 "$SUDOERS_FILE"
if ! visudo -cf "$SUDOERS_FILE" >/dev/null 2>&1; then
  rm -f "$SUDOERS_FILE"
  die "Generated sudoers file failed validation; aborting before it could take effect." "BD_SUDOERS_INVALID"
fi

HOME_DIR="$(getent passwd "$ADMIN_USER" | cut -d: -f6)"
SSH_DIR="${HOME_DIR}/.ssh"
mkdir -p "$SSH_DIR"
printf '%s\n' "$PUBKEY" >"${SSH_DIR}/authorized_keys"
chmod 700 "$SSH_DIR"
chmod 600 "${SSH_DIR}/authorized_keys"
chown -R "${ADMIN_USER}:${ADMIN_USER}" "$SSH_DIR"

# Lock the password entirely — this account is never authenticated by password, only by key.
passwd -l "$ADMIN_USER" >/dev/null 2>&1 || true

result user "$ADMIN_USER" created "$CREATED"
