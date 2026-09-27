import type { AccountStatus, ChangePasswordInput, CreateAccountInput, CreateAccountResult, Clock, KeyProtector, PasswordStrength, RecoverInput } from '@bob-deploy/contracts';
import { PASSWORD_POLICY } from '@bob-deploy/contracts';
import { deriveKey, open, randomBytes, seal, wipe, CURRENT_KDF_PARAMS, type KdfParams } from '../security/crypto.js';
import { scorePassword } from '../security/password-strength.js';
import type { Redactor } from '../security/redactor.js';
import type { Logger } from '../logging/logger.js';
import { generateRecoveryCode, normalizeRecoveryCode } from '../security/passphrase.js';
import { AccountError } from './errors.js';
import { accountFileExists, loadAccountFile, saveAccountFile, type AccountFileJson, type WrapJson } from './account-file.js';
import { loadVaultFile, saveVaultFile, type SecretMap } from './vault-file.js';

const AAD_PASSWORD_WRAP = 'bd-dek-pw-v1';
const AAD_RECOVERY_WRAP = 'bd-dek-rc-v1';
const DEFAULT_AUTO_LOCK_MINUTES = 15;
const BACKOFF_START_FAILURE = 5; // the 5th failure is the first one that locks out
const BACKOFF_CAP_SECONDS = 300;

function defaultClock(): Clock {
  return {
    now: () => new Date(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  };
}

function backoffSeconds(failedAttempts: number): number {
  if (failedAttempts < BACKOFF_START_FAILURE) return 0;
  const exponent = failedAttempts - BACKOFF_START_FAILURE; // 5th failure -> 2^0 = 1s, 6th -> 2s, ...
  return Math.min(2 ** exponent, BACKOFF_CAP_SECONDS);
}

async function wrapDek(dek: Buffer, secret: string, aad: string): Promise<WrapJson> {
  const salt = randomBytes(16);
  const kdf: KdfParams = CURRENT_KDF_PARAMS;
  const key = await deriveKey(secret, salt, kdf);
  try {
    const sealed = seal(key, dek, aad);
    return {
      salt: salt.toString('base64'),
      iv: sealed.iv.toString('base64'),
      ct: sealed.ct.toString('base64'),
      tag: sealed.tag.toString('base64'),
      kdf,
    };
  } finally {
    wipe(key);
  }
}

async function unwrapDek(wrap: WrapJson, secret: string, aad: string): Promise<Buffer> {
  const salt = Buffer.from(wrap.salt, 'base64');
  const key = await deriveKey(secret, salt, wrap.kdf);
  try {
    return open(key, { iv: Buffer.from(wrap.iv, 'base64'), ct: Buffer.from(wrap.ct, 'base64'), tag: Buffer.from(wrap.tag, 'base64') }, aad);
  } finally {
    wipe(key);
  }
}

export interface AccountServiceOptions {
  dataDir: string;
  redactor: Redactor;
  logger?: Logger;
  clock?: Clock;
  keyProtector?: KeyProtector;
  /** Called after a successful unlock/create/recover while unlocked, before the idle timer fires. */
  onLocked?: (reason: 'manual' | 'idle') => void;
  /** Returns true while a job is running; idle-lock is deferred until it returns false. */
  busy?: () => boolean;
}

/**
 * Owns account.json + vault.bin: the master password, the DEK, auto-lock, and the decrypted
 * in-memory secret map. See docs/briefs/CLAUDE_CODE_BRIEF.md S1/S2/S6/S10/S12/S13.
 */
export class AccountService {
  private readonly dataDir: string;
  private readonly redactor: Redactor;
  private readonly logger?: Logger;
  private readonly clock: Clock;
  private readonly keyProtector?: KeyProtector;
  private readonly onLockedCb?: (reason: 'manual' | 'idle') => void;
  private readonly busy: () => boolean;

  private account: AccountFileJson | undefined;
  private dek: Buffer | undefined;
  private secrets: SecretMap = {};
  private idleTimer: unknown;
  private pendingIdleLock = false;

  constructor(opts: AccountServiceOptions) {
    this.dataDir = opts.dataDir;
    this.redactor = opts.redactor;
    this.logger = opts.logger;
    this.clock = opts.clock ?? defaultClock();
    this.keyProtector = opts.keyProtector;
    this.onLockedCb = opts.onLocked;
    this.busy = opts.busy ?? (() => false);
    this.account = loadAccountFile(this.dataDir);
  }

  // ---- status / strength -------------------------------------------------

  status(): AccountStatus {
    const a = this.account;
    if (!a) {
      return { exists: false, unlocked: false, onboardingComplete: false, autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES };
    }
    const retryAfterSeconds = this.retryAfterSecondsNow(a);
    return {
      exists: true,
      unlocked: this.dek !== undefined,
      onboardingComplete: a.onboardingComplete,
      displayName: a.displayName,
      email: a.email,
      autoLockMinutes: a.autoLockMinutes,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }

  private retryAfterSecondsNow(a: AccountFileJson): number | undefined {
    if (!a.lockedUntil) return undefined;
    const remainingMs = new Date(a.lockedUntil).getTime() - this.clock.now().getTime();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : undefined;
  }

  checkPassword(password: string, userInputs: string[] = []): PasswordStrength {
    const allInputs = [...userInputs];
    if (this.account?.displayName) allInputs.push(this.account.displayName);
    if (this.account?.email) allInputs.push(this.account.email.split('@')[0]!);
    allInputs.push('bob', 'deploy', 'bobdeploy');

    const result = scorePassword(password, allInputs);
    const ok = password.length >= PASSWORD_POLICY.minLength && result.score >= PASSWORD_POLICY.minScore;
    return { ok, score: result.score, warning: result.warning, suggestions: result.suggestions };
  }

  private checkPasswordForNewInputs(password: string, displayName: string, email: string): PasswordStrength {
    const allInputs = [displayName, email.split('@')[0]!, 'bob', 'deploy', 'bobdeploy'];
    const result = scorePassword(password, allInputs);
    const ok = password.length >= PASSWORD_POLICY.minLength && result.score >= PASSWORD_POLICY.minScore;
    return { ok, score: result.score, warning: result.warning, suggestions: result.suggestions };
  }

  // ---- lifecycle -----------------------------------------------------------

  async create(input: CreateAccountInput): Promise<CreateAccountResult> {
    if (this.account || accountFileExists(this.dataDir)) {
      throw new AccountError('ACCOUNT_EXISTS', 'An account already exists in this data directory.');
    }
    const strength = this.checkPasswordForNewInputs(input.masterPassword, input.displayName, input.email);
    if (!strength.ok) {
      throw new AccountError('WEAK_PASSWORD', strength.warning ?? 'Password is too weak.', { suggestions: strength.suggestions });
    }

    const dek = randomBytes(32);
    const recoveryCode = generateRecoveryCode();
    try {
      const passwordWrap = await wrapDek(dek, input.masterPassword, AAD_PASSWORD_WRAP);
      const recoveryWrap = await wrapDek(dek, normalizeRecoveryCode(recoveryCode), AAD_RECOVERY_WRAP);

      const account: AccountFileJson = {
        version: 1,
        displayName: input.displayName,
        email: input.email,
        createdAt: this.clock.now().toISOString(),
        autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
        kdf: CURRENT_KDF_PARAMS,
        passwordWrap,
        recoveryWrap,
        failedAttempts: 0,
        onboardingComplete: false,
      };
      saveAccountFile(this.dataDir, account);
      this.account = account;

      this.dek = dek;
      this.secrets = {};
      saveVaultFile(this.dataDir, this.dek, this.secrets, this.keyProtector);
      this.registerAllSecretsWithRedactor();
      this.startIdleTimer();

      return { recoveryCode };
    } catch (err) {
      wipe(dek);
      throw err;
    }
  }

  async unlock(password: string): Promise<AccountStatus> {
    const account = this.requireAccount();
    const retryAfterSeconds = this.retryAfterSecondsNow(account);
    if (retryAfterSeconds !== undefined) {
      throw new AccountError('TOO_MANY_ATTEMPTS', 'Too many failed attempts. Try again later.', { retryAfterSeconds });
    }

    let dek: Buffer;
    try {
      dek = await unwrapDek(account.passwordWrap, password, AAD_PASSWORD_WRAP);
    } catch {
      this.recordFailedAttempt(account);
      const retry = this.retryAfterSecondsNow(account);
      if (retry !== undefined) {
        throw new AccountError('TOO_MANY_ATTEMPTS', 'Too many failed attempts. Try again later.', { retryAfterSeconds: retry });
      }
      throw new AccountError('BAD_PASSWORD', 'Incorrect master password.');
    }

    account.failedAttempts = 0;
    account.lockedUntil = undefined;
    saveAccountFile(this.dataDir, account);

    this.finishUnlock(dek);
    return this.status();
  }

  private recordFailedAttempt(account: AccountFileJson): void {
    account.failedAttempts += 1;
    const seconds = backoffSeconds(account.failedAttempts);
    if (seconds > 0) {
      account.lockedUntil = new Date(this.clock.now().getTime() + seconds * 1000).toISOString();
    }
    saveAccountFile(this.dataDir, account);
  }

  private finishUnlock(dek: Buffer): void {
    this.dek = dek;
    const { secrets, usedBackup } = loadVaultFile(this.dataDir, dek, this.keyProtector);
    if (usedBackup) {
      this.logger?.warn('vault.bin was corrupt or unreadable; recovered from vault.bin.bak');
    }
    this.secrets = secrets;
    this.registerAllSecretsWithRedactor();
    this.startIdleTimer();
  }

  private registerAllSecretsWithRedactor(): void {
    for (const value of Object.values(this.secrets)) this.redactor.add(value);
  }

  lock(reason: 'manual' | 'idle' = 'manual'): AccountStatus {
    this.stopIdleTimer();
    if (this.dek) wipe(this.dek);
    this.dek = undefined;
    for (const key of Object.keys(this.secrets)) {
      // Best-effort: overwrite the string references we can (the underlying V8 string is immutable,
      // but dropping every reference lets it be collected; buffers, where used, are wiped above).
      this.secrets[key] = '';
    }
    this.secrets = {};
    this.pendingIdleLock = false;
    this.onLockedCb?.(reason);
    return this.status();
  }

  touch(): void {
    if (!this.dek) return;
    this.startIdleTimer();
  }

  private startIdleTimer(): void {
    this.stopIdleTimer();
    const minutes = this.account?.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES;
    this.idleTimer = this.clock.setTimeout(() => this.onIdleTimerFired(), minutes * 60 * 1000);
  }

  private stopIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      this.clock.clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private onIdleTimerFired(): void {
    if (this.busy()) {
      this.pendingIdleLock = true;
      return;
    }
    this.lock('idle');
  }

  /** Called by the job engine (or anything else tracked by `busy()`) when a job finishes, so a
   * deferred idle-lock can take effect. */
  onJobFinished(): void {
    if (this.pendingIdleLock && !this.busy()) {
      this.lock('idle');
    }
  }

  async changePassword(input: ChangePasswordInput): Promise<void> {
    const account = this.requireAccount();
    const dek = this.requireUnlocked();
    try {
      await unwrapDek(account.passwordWrap, input.currentPassword, AAD_PASSWORD_WRAP);
    } catch {
      throw new AccountError('BAD_PASSWORD', 'Incorrect current password.');
    }
    const strength = this.checkPassword(input.newPassword);
    if (!strength.ok) {
      throw new AccountError('WEAK_PASSWORD', strength.warning ?? 'Password is too weak.', { suggestions: strength.suggestions });
    }
    account.passwordWrap = await wrapDek(dek, input.newPassword, AAD_PASSWORD_WRAP);
    saveAccountFile(this.dataDir, account);
  }

  async recover(input: RecoverInput): Promise<CreateAccountResult> {
    const account = this.requireAccount();
    const retryAfterSeconds = this.retryAfterSecondsNow(account);
    if (retryAfterSeconds !== undefined) {
      throw new AccountError('TOO_MANY_ATTEMPTS', 'Too many failed attempts. Try again later.', { retryAfterSeconds });
    }

    let dek: Buffer;
    try {
      dek = await unwrapDek(account.recoveryWrap, normalizeRecoveryCode(input.recoveryCode), AAD_RECOVERY_WRAP);
    } catch {
      this.recordFailedAttempt(account);
      const retry = this.retryAfterSecondsNow(account);
      if (retry !== undefined) {
        throw new AccountError('TOO_MANY_ATTEMPTS', 'Too many failed attempts. Try again later.', { retryAfterSeconds: retry });
      }
      throw new AccountError('BAD_RECOVERY_CODE', 'Incorrect recovery code.');
    }

    const strength = this.checkPassword(input.newPassword);
    if (!strength.ok) {
      wipe(dek);
      throw new AccountError('WEAK_PASSWORD', strength.warning ?? 'Password is too weak.', { suggestions: strength.suggestions });
    }

    account.passwordWrap = await wrapDek(dek, input.newPassword, AAD_PASSWORD_WRAP);
    const newRecoveryCode = generateRecoveryCode();
    account.recoveryWrap = await wrapDek(dek, normalizeRecoveryCode(newRecoveryCode), AAD_RECOVERY_WRAP);
    account.failedAttempts = 0;
    account.lockedUntil = undefined;
    saveAccountFile(this.dataDir, account);

    this.finishUnlock(dek);
    return { recoveryCode: newRecoveryCode };
  }

  async regenerateRecoveryCode(password: string): Promise<CreateAccountResult> {
    const account = this.requireAccount();
    const dek = this.requireUnlocked();
    try {
      await unwrapDek(account.passwordWrap, password, AAD_PASSWORD_WRAP);
    } catch {
      throw new AccountError('BAD_PASSWORD', 'Incorrect master password.');
    }
    const newRecoveryCode = generateRecoveryCode();
    account.recoveryWrap = await wrapDek(dek, normalizeRecoveryCode(newRecoveryCode), AAD_RECOVERY_WRAP);
    saveAccountFile(this.dataDir, account);
    return { recoveryCode: newRecoveryCode };
  }

  /** Keeps the idle-lock timer in sync with AppSettings.autoLockMinutes (SettingsRepo owns the
   * authoritative AppSettings row; this is account.json's own copy, which is what actually drives
   * the idle timer — see startIdleTimer()). Restarts the timer immediately if unlocked. */
  setAutoLockMinutes(minutes: number): void {
    const account = this.requireAccount();
    account.autoLockMinutes = minutes;
    saveAccountFile(this.dataDir, account);
    if (this.dek) this.startIdleTimer();
  }

  completeOnboarding(): AccountStatus {
    const account = this.requireAccount();
    account.onboardingComplete = true;
    saveAccountFile(this.dataDir, account);
    return this.status();
  }

  // ---- vault -----------------------------------------------------------

  getSecret(key: string): string | undefined {
    this.requireUnlocked();
    return this.secrets[key];
  }

  setSecret(key: string, value: string): void {
    this.requireUnlocked();
    this.secrets[key] = value;
    this.redactor.add(value);
    this.persistVault();
  }

  deleteSecret(key: string): void {
    this.requireUnlocked();
    delete this.secrets[key];
    this.persistVault();
  }

  listKeys(prefix = ''): string[] {
    this.requireUnlocked();
    return Object.keys(this.secrets).filter((k) => k.startsWith(prefix));
  }

  private persistVault(): void {
    const dek = this.requireUnlocked();
    saveVaultFile(this.dataDir, dek, this.secrets, this.keyProtector);
  }

  // ---- test hooks --------------------------------------------------------

  /** True once locked (or before any unlock): exposed for tests that assert the DEK is wiped. */
  isDekZeroed(): boolean {
    if (!this.dek) return true;
    return this.dek.every((b) => b === 0);
  }

  // ---- helpers -----------------------------------------------------------

  private requireAccount(): AccountFileJson {
    if (!this.account) throw new AccountError('NO_ACCOUNT', 'No account exists yet.');
    return this.account;
  }

  private requireUnlocked(): Buffer {
    if (!this.dek) throw new AccountError('LOCKED', 'The account is locked.');
    return this.dek;
  }
}
