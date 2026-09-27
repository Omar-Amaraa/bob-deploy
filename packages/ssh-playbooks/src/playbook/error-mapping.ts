import type { ErrorCode } from '@bob-deploy/contracts';

/**
 * Maps a script's own BD_* error code (from `die` in scripts/lib.sh) onto one of contracts'
 * frozen ErrorCode values. Contracts are frozen after M0 (see CLAUDE.md), so scripts are free to
 * introduce new BD_* codes for their own diagnostics, but every one of them has to land somewhere
 * in this table rather than becoming a new cross-package error code.
 */
const BD_CODE_MAP: Record<string, ErrorCode> = {
  // 00-preflight.sh
  BD_UNSUPPORTED_OS: 'UNSUPPORTED_OS',
  BD_UNSUPPORTED_ARCH: 'UNSUPPORTED_OS',
  BD_NO_SYSTEMD: 'UNSUPPORTED_OS',
  BD_NO_APT: 'UNSUPPORTED_OS',
  BD_LOW_DISK: 'INTERNAL',
  BD_APT_UPDATE_FAILED: 'INTERNAL',
  // 10-create-admin.sh
  BD_INVALID_USER: 'VALIDATION',
  BD_BAD_ARGS: 'VALIDATION',
  BD_USER_NOT_FOUND: 'VALIDATION',
  BD_USERADD_FAILED: 'HARDENING_FAILED',
  BD_USERMOD_FAILED: 'HARDENING_FAILED',
  BD_SUDOERS_INVALID: 'HARDENING_FAILED',
  // 20/21-sshd-*.sh
  BD_SSHD_CONFIG_INVALID: 'HARDENING_FAILED',
  BD_SSHD_RELOAD_FAILED: 'HARDENING_FAILED',
  BD_SSHD_HARDENING_INEFFECTIVE: 'HARDENING_FAILED',
  BD_BACKUP_NOT_FOUND: 'HARDENING_FAILED',
  // 30-firewall.sh
  BD_APT_INSTALL_FAILED: 'HARDENING_FAILED',
  BD_UFW_ENABLE_FAILED: 'HARDENING_FAILED',
  BD_FAIL2BAN_START_FAILED: 'HARDENING_FAILED',
  // 40-install-helpers.sh
  BD_HELPERS_MISSING: 'HARDENING_FAILED',
  BD_ALLOWLIST_INVALID: 'HARDENING_FAILED',
  BD_NOT_ROOT: 'HARDENING_FAILED',
  // bd-install-runtime
  BD_DOWNLOAD_FAILED: 'BUILD_FAILED',
  BD_INSTALL_FAILED: 'BUILD_FAILED',
  // bd-install-apt-packages (BD_APT_INSTALL_FAILED already mapped above)
  BD_APT_PACKAGE_NOT_ALLOWED: 'INTERNAL',
  // bd-app-setup / bd-service / bd-read-journal / bd-caddy-site: shared validation codes
  BD_INVALID_APP: 'VALIDATION',
  BD_INVALID_PORT: 'VALIDATION',
  BD_INVALID_DOMAIN: 'VALIDATION',
  BD_INVALID_START_CMD: 'UNSUPPORTED_STACK',
  BD_APP_NOT_FOUND: 'VALIDATION',
  BD_SYSTEMD_RELOAD_FAILED: 'BUILD_FAILED',
  // bd-caddy-site
  BD_CADDY_NOT_INSTALLED: 'BUILD_FAILED',
  BD_CADDY_CONFIG_INVALID: 'HEALTHCHECK_FAILED',
  // bd-service
  BD_SERVICE_ACTION_FAILED: 'BUILD_FAILED',
  BD_SERVICE_RELOAD_FAILED: 'BUILD_FAILED',
  // run-script.ts's own codes, when a script didn't produce a usable BD_RESULT line at all
  BD_NO_RESULT_LINE: 'INTERNAL',
  BD_BAD_RESULT_JSON: 'INTERNAL',
  BD_BAD_RESULT_SHAPE: 'INTERNAL',
  BD_UNKNOWN_ERROR: 'INTERNAL',
};

export function mapBdErrorCode(bdCode: string): ErrorCode {
  return BD_CODE_MAP[bdCode] ?? 'INTERNAL';
}
