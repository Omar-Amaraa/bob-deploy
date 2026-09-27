import { IPC_CHANNELS, type IpcChannel, type IpcHost, type Result } from '@bob-deploy/contracts';

export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, payload: unknown) => Promise<Result<unknown>>,
  ): void;
}

export interface WebContentsLike {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

const allowedChannels = new Set<string>(IPC_CHANNELS);

export function ipcHostFromElectron(
  ipcMain: IpcMainLike,
  getWebContents: () => WebContentsLike | undefined,
): IpcHost {
  return {
    handle(channel: IpcChannel, handler) {
      if (!allowedChannels.has(channel)) throw new Error(`IPC channel is not allowed: ${channel}`);
      ipcMain.handle(channel, (_event, payload) => handler(payload));
    },
    emit(event, payload) {
      const webContents = getWebContents();
      if (webContents && !webContents.isDestroyed()) webContents.send(event, payload);
    },
  };
}
