import type { SshSession } from './types.js';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface PoolEntry {
  session: SshSession;
  idleTimer: ReturnType<typeof setTimeout>;
}

/**
 * Reuses one SshSession per key (a targetId), closing it after 5 minutes of no `getSession` calls
 * for that key and dropping it immediately if it closes on its own (a dead connection is never
 * handed back out). Core uses this so a job doesn't reconnect per step; monitors get sessions
 * through it too.
 */
export class ConnectionPool {
  private readonly entries = new Map<string, PoolEntry>();

  async getSession(key: string, factory: () => Promise<SshSession>): Promise<SshSession> {
    const existing = this.entries.get(key);
    if (existing) {
      this.resetIdleTimer(key, existing);
      return existing.session;
    }

    const session = await factory();
    const entry: PoolEntry = { session, idleTimer: setTimeout(() => this.evict(key), IDLE_TIMEOUT_MS) };
    session.onClose(() => this.drop(key));
    this.entries.set(key, entry);
    return session;
  }

  private resetIdleTimer(key: string, entry: PoolEntry): void {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => this.evict(key), IDLE_TIMEOUT_MS);
  }

  private evict(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    entry.session.close();
  }

  /** Removes a session that closed on its own (e.g. dropped connection) without closing it again. */
  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    clearTimeout(entry.idleTimer);
    this.entries.delete(key);
  }

  closeAll(): void {
    for (const [key, entry] of this.entries) {
      clearTimeout(entry.idleTimer);
      entry.session.close();
      this.entries.delete(key);
    }
  }
}
