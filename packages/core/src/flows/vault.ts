/**
 * Structural interface matching AccountService's secret-access methods (getSecret/setSecret/
 * deleteSecret/listKeys — see packages/core/src/account/account-service.ts), so flow code depends
 * on this instead of the concrete class (CLAUDE.md: every external dependency behind an interface
 * with a fake). AccountService itself satisfies this interface as-is, with no adapter needed;
 * flow unit tests use InMemoryVault below instead of a real AccountService, which needs Argon2id
 * key derivation and touches real crypto/disk, making it too slow and heavy for fast unit tests.
 */
export interface VaultLike {
  getSecret(key: string): string | undefined;
  setSecret(key: string, value: string): void;
  deleteSecret(key: string): void;
  listKeys(prefix?: string): string[];
}

/** In-memory VaultLike for flow unit tests. Never used in production — AccountService is the real
 * implementation, and it satisfies VaultLike structurally without needing to import this file. */
export class InMemoryVault implements VaultLike {
  private readonly secrets = new Map<string, string>();

  getSecret(key: string): string | undefined {
    return this.secrets.get(key);
  }

  setSecret(key: string, value: string): void {
    this.secrets.set(key, value);
  }

  deleteSecret(key: string): void {
    this.secrets.delete(key);
  }

  listKeys(prefix = ''): string[] {
    return [...this.secrets.keys()].filter((k) => k.startsWith(prefix));
  }
}
