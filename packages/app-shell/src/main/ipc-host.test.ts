import { describe, expect, it, vi } from 'vitest';
import type { Result } from '@bob-deploy/contracts';
import { ipcHostFromElectron, type IpcMainLike } from './ipc-host.js';

describe('ipcHostFromElectron', () => {
  it('registers a typed handler and forwards only its payload', async () => {
    let listener: ((event: unknown, payload: unknown) => Promise<Result<unknown>>) | undefined;
    const handleSpy = vi.fn(
      (_channel: string, next: (event: unknown, payload: unknown) => Promise<Result<unknown>>) => {
        listener = next;
      },
    );
    const ipcMain: IpcMainLike = {
      handle: handleSpy,
    };
    const handler = vi.fn(() => Promise.resolve({ ok: true as const, data: { exists: false } }));
    const host = ipcHostFromElectron(ipcMain, () => undefined);

    host.handle('account:status', handler);
    const result = await listener?.({ sender: 'not-forwarded' }, undefined);

    expect(handleSpy).toHaveBeenCalledWith('account:status', expect.any(Function));
    expect(handler).toHaveBeenCalledWith(undefined);
    expect(result).toEqual({ ok: true, data: { exists: false } });
  });

  it('emits only to a live renderer', () => {
    const send = vi.fn();
    const ipcMain: IpcMainLike = { handle: vi.fn() };
    const host = ipcHostFromElectron(ipcMain, () => ({ isDestroyed: () => false, send }));

    host.emit('account:locked', { reason: 'idle' });

    expect(send).toHaveBeenCalledWith('account:locked', { reason: 'idle' });
  });

  it('does not emit to a destroyed renderer', () => {
    const send = vi.fn();
    const host = ipcHostFromElectron({ handle: vi.fn() }, () => ({ isDestroyed: () => true, send }));
    host.emit('account:locked', { reason: 'manual' });
    expect(send).not.toHaveBeenCalled();
  });
});
