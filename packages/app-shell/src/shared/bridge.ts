import type { IpcChannel, PushEvent } from '@bob-deploy/contracts';

export interface BobDeployBridge {
  invoke(channel: IpcChannel, payload: unknown): Promise<unknown>;
  on(event: PushEvent, listener: (payload: unknown) => void): () => void;
  pickFolder(): Promise<string | null>;
  pickFile(options: {
    title: string;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<string | null>;
  saveTextFile(options: { defaultName: string; content: string }): Promise<boolean>;
  printText(options: { title: string; content: string }): Promise<void>;
  openExternal(url: string): Promise<void>;
  openLogsFolder(): Promise<void>;
  clearViewerData(): Promise<void>;
  onViewerExternalOpened(listener: () => void): () => void;
  platform: 'win32' | 'darwin' | 'linux';
  appVersion: string;
  mock: boolean;
}

export const SHELL_CHANNELS = {
  pickFolder: 'shell:pickFolder',
  pickFile: 'shell:pickFile',
  saveTextFile: 'shell:saveTextFile',
  printText: 'shell:printText',
  openExternal: 'shell:openExternal',
  openLogsFolder: 'shell:openLogsFolder',
  clearViewerData: 'shell:clearViewerData',
  viewerExternalOpened: 'shell:viewerExternalOpened',
} as const;
