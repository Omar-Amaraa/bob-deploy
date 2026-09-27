import { IPC_CHANNELS, PUSH_EVENTS, type IpcChannel, type PushEvent } from '@bob-deploy/contracts';
import { isAllowedExternalUrl } from '../main/security.js';
import type { BobDeployBridge } from '../shared/bridge.js';
import { SHELL_CHANNELS } from '../shared/bridge.js';

export interface IpcRendererLike {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

const ipcChannels = new Set<string>(IPC_CHANNELS);
const pushEvents = new Set<string>(PUSH_EVENTS);

export function createBridge(
  ipcRenderer: IpcRendererLike,
  metadata: Pick<BobDeployBridge, 'platform' | 'appVersion' | 'mock'>,
): BobDeployBridge {
  return {
    invoke(channel, payload) {
      if (!ipcChannels.has(channel)) return Promise.reject(new Error('IPC channel is not allowed.'));
      return ipcRenderer.invoke(channel, payload);
    },
    on(event, listener) {
      if (!pushEvents.has(event)) throw new Error('Push event is not allowed.');
      const wrapped = (_event: unknown, payload: unknown) => listener(payload);
      ipcRenderer.on(event, wrapped);
      return () => ipcRenderer.removeListener(event, wrapped);
    },
    pickFolder: () => ipcRenderer.invoke(SHELL_CHANNELS.pickFolder) as Promise<string | null>,
    pickFile: (options) =>
      ipcRenderer.invoke(SHELL_CHANNELS.pickFile, options) as Promise<string | null>,
    saveTextFile: (options) =>
      ipcRenderer.invoke(SHELL_CHANNELS.saveTextFile, options) as Promise<boolean>,
    printText: async (options) => {
      await ipcRenderer.invoke(SHELL_CHANNELS.printText, options);
    },
    openExternal: async (url) => {
      if (!isAllowedExternalUrl(url)) throw new Error('Only HTTPS links are allowed.');
      await ipcRenderer.invoke(SHELL_CHANNELS.openExternal, url);
    },
    openLogsFolder: async () => {
      await ipcRenderer.invoke(SHELL_CHANNELS.openLogsFolder);
    },
    clearViewerData: async () => {
      await ipcRenderer.invoke(SHELL_CHANNELS.clearViewerData);
    },
    onViewerExternalOpened: (listener) => {
      const wrapped = () => listener();
      ipcRenderer.on(SHELL_CHANNELS.viewerExternalOpened, wrapped);
      return () => ipcRenderer.removeListener(SHELL_CHANNELS.viewerExternalOpened, wrapped);
    },
    ...metadata,
  };
}

export function assertIpcChannel(channel: string): asserts channel is IpcChannel {
  if (!ipcChannels.has(channel)) throw new Error('IPC channel is not allowed.');
}

export function assertPushEvent(event: string): asserts event is PushEvent {
  if (!pushEvents.has(event)) throw new Error('Push event is not allowed.');
}
