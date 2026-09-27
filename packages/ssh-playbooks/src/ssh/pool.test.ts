import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConnectionPool } from './pool.js';
import type { SshSession } from './types.js';

function makeFakeSession(): SshSession & { closeCalls: number; onCloseCallbacks: Array<() => void> } {
  const onCloseCallbacks: Array<() => void> = [];
  return {
    fingerprint: 'SHA256:fake',
    username: 'root',
    closeCalls: 0,
    onCloseCallbacks,
    exec: vi.fn(),
    upload: vi.fn(),
    close() {
      this.closeCalls++;
    },
    onClose(cb: () => void) {
      onCloseCallbacks.push(cb);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ConnectionPool', () => {
  it('reuses the same session for the same key without calling the factory again', async () => {
    const pool = new ConnectionPool();
    const session = makeFakeSession();
    const factory = vi.fn().mockResolvedValue(session);

    const a = await pool.getSession('target-1', factory);
    const b = await pool.getSession('target-1', factory);

    expect(a).toBe(session);
    expect(b).toBe(session);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('creates separate sessions for different keys', async () => {
    const pool = new ConnectionPool();
    const sessionA = makeFakeSession();
    const sessionB = makeFakeSession();

    const a = await pool.getSession('target-1', () => Promise.resolve(sessionA));
    const b = await pool.getSession('target-2', () => Promise.resolve(sessionB));

    expect(a).toBe(sessionA);
    expect(b).toBe(sessionB);
  });

  it('closes an idle session after 5 minutes of no getSession calls for its key', async () => {
    vi.useFakeTimers();
    const pool = new ConnectionPool();
    const session = makeFakeSession();
    await pool.getSession('target-1', () => Promise.resolve(session));

    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(session.closeCalls).toBe(0);

    vi.advanceTimersByTime(2);
    expect(session.closeCalls).toBe(1);
  });

  it('a getSession call resets the idle timer', async () => {
    vi.useFakeTimers();
    const pool = new ConnectionPool();
    const session = makeFakeSession();
    await pool.getSession('target-1', () => Promise.resolve(session));

    vi.advanceTimersByTime(4 * 60 * 1000);
    await pool.getSession('target-1', () => Promise.resolve(session)); // resets the timer
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(session.closeCalls).toBe(0); // only 8 min total, but reset at 4 min so only 4 min elapsed since

    vi.advanceTimersByTime(60 * 1000 + 1);
    expect(session.closeCalls).toBe(1);
  });

  it('drops (without re-closing) a session that closes on its own', async () => {
    const pool = new ConnectionPool();
    const session = makeFakeSession();
    await pool.getSession('target-1', () => Promise.resolve(session));

    session.onCloseCallbacks.forEach((cb) => cb());
    expect(session.closeCalls).toBe(0); // dropped, not force-closed again

    // A subsequent getSession call creates a fresh session rather than handing back the dead one.
    const fresh = makeFakeSession();
    const result = await pool.getSession('target-1', () => Promise.resolve(fresh));
    expect(result).toBe(fresh);
  });

  it('closeAll closes every pooled session', async () => {
    const pool = new ConnectionPool();
    const sessionA = makeFakeSession();
    const sessionB = makeFakeSession();
    await pool.getSession('a', () => Promise.resolve(sessionA));
    await pool.getSession('b', () => Promise.resolve(sessionB));

    pool.closeAll();

    expect(sessionA.closeCalls).toBe(1);
    expect(sessionB.closeCalls).toBe(1);
  });
});
