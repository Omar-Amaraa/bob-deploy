#!/usr/bin/env bash
# 30-firewall.sh
# Installs and enables ufw (allowing only SSH, HTTP, and HTTPS) and fail2ban (guarding sshd).
# Idempotent: safe to re-run.
#
# Usage: 30-firewall.sh
# On success: BD_RESULT {"ok":true,"ufw":"active","fail2ban":"active"}
# On failure: BD_RESULT {"ok":false,"error":"<code>","message":"..."}
#
# @@LIB@@

require_root
export DEBIAN_FRONTEND=noninteractive

if ! command -v ufw >/dev/null 2>&1 || ! command -v fail2ban-client >/dev/null 2>&1; then
  apt_install ufw fail2ban \
    || die "Failed to install ufw and fail2ban: $(apt_tail)" "BD_APT_INSTALL_FAILED"
fi

ufw default deny incoming >/dev/null 2>&1
ufw default allow outgoing >/dev/null 2>&1
ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1
ufw allow 80/tcp >/dev/null 2>&1
ufw allow 443/tcp >/dev/null 2>&1
ufw allow 443/udp >/dev/null 2>&1 # HTTP/3 (QUIC), which Caddy enables by default
ufw --force enable >/dev/null 2>&1 || die "Failed to enable ufw." "BD_UFW_ENABLE_FAILED"

JAIL_FILE="/etc/fail2ban/jail.d/60-bob-deploy.conf"
cat >"$JAIL_FILE" <<'EOF'
# Managed by Bob Deploy.
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
EOF
chmod 0644 "$JAIL_FILE"

systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban >/dev/null 2>&1 || die "Failed to start fail2ban." "BD_FAIL2BAN_START_FAILED"

UFW_STATUS="$(ufw status | head -n1 | awk '{print tolower($2)}')"
F2B_STATUS="inactive"
if systemctl is-active --quiet fail2ban; then
  F2B_STATUS="active"
fi

result ufw "$UFW_STATUS" fail2ban "$F2B_STATUS"
