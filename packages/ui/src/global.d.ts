import type { IpcChannel, PushEvent } from '@bob-deploy/contracts';

declare global {
  interface Window {
    bobDeploy?: {
      invoke(channel: IpcChannel, payload: unknown): Promise<unknown>;
      on(event: PushEvent, listener: (payload: unknown) => void): () => void;
      pickFolder(): Promise<string | null>;
      pickFile(options: { title: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
      saveTextFile(options: { defaultName: string; content: string }): Promise<boolean>;
      printText(options: { title: string; content: string }): Promise<void>;
      openExternal(url: string): Promise<void>;
      openLogsFolder(): Promise<void>;
      clearViewerData(): Promise<void>;
      onViewerExternalOpened(listener: () => void): () => void;
      platform: 'win32' | 'darwin' | 'linux';
      appVersion: string;
      mock: boolean;
    };
  }
}

export {};
