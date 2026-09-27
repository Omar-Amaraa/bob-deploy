export const PASSWORD_POLICY = { minLength: 12, maxLength: 256, minScore: 3 } as const;

export interface AccountStatus {
  exists: boolean;
  unlocked: boolean;
  onboardingComplete: boolean;
  displayName?: string;
  email?: string;
  autoLockMinutes: number;
  retryAfterSeconds?: number; // set when TOO_MANY_ATTEMPTS
}
export interface CreateAccountInput {
  displayName: string;
  email: string;
  masterPassword: string;
}
export interface CreateAccountResult {
  recoveryCode: string;
} // shown once, never retrievable again
export interface PasswordStrength {
  ok: boolean; // length >= minLength && score >= minScore
  score: 0 | 1 | 2 | 3 | 4;
  warning?: string;
  suggestions: string[];
}
export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}
export interface RecoverInput {
  recoveryCode: string;
  newPassword: string;
}

export interface KeyProtector {
  // mirrors Electron safeStorage; app-shell passes the real one
  isAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}
